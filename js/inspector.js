/* ------------------------------------------------------------
   調整パネル（選んだクリップの値）
   スライダーは動かしている間はそのまま反映し、離した時に 1 回だけ履歴に積む。
   ------------------------------------------------------------ */
const Inspector = (() => {
  let root = null;
  let p = null;
  let clipId = null;
  let hooks = {};          // live(fn) / begin() / end(label) / edit(label, fn) / settings() / changed()
  let building = false;

  function init(el, h) { root = el; hooks = h; }
  function setProject(proj) { p = proj; clipId = null; render(); }
  function show(id) { clipId = id; render(); }
  function refresh() {
    // 入力中の欄は作り直さない（iPad で数字を打っている途中に消える）
    const ae = document.activeElement;
    if (root.contains(ae) && ((ae.tagName === 'INPUT' && ae.type !== 'range') || ae.tagName === 'TEXTAREA')) return;
    render();
  }

  const F = () => Proj.fps(p);

  function section(title, ...kids) {
    return h('div', { class: 'insp-section' }, h('div', { class: 'insp-title' }, title), ...kids);
  }

  /** 再生位置のクリップ先頭からのフレーム（クリップの中に収める） */
  const offsetOf = (c) => clamp(Math.round(hooks.playhead() - c.start), 0, c.duration);

  /**
   * スライダー＋数字の行。get() → 表示の値、set(v) → クリップへ（表示の単位で受け取る）
   * kf = {c, prop, toV, fromV} を渡すとキーフレームの ◆ ボタンが付く。キーがある属性は、動かすと再生位置のキーを作る・直す。
   */
  function slider(label, { min, max, step, get, set, unit = '', fmt = (v) => v, label2, kf }) {
    let diamond = null;
    if (kf) {
      const { c, prop, toV = (v) => v, fromV = (v) => v } = kf;
      const g0 = get, s0 = set;
      get = () => (Keys.has(c, prop) ? fromV(Keys.valueAt(c, prop, c.start + offsetOf(c))) : g0());
      set = (v) => { if (Keys.has(c, prop)) Keys.setKey(c, prop, offsetOf(c), toV(v)); else s0(v); };
      const on = !!Keys.at(c, prop, offsetOf(c));
      diamond = h('button', {
        class: 'kf' + (on ? ' on' : Keys.has(c, prop) ? ' has' : ''), title: on ? 'このキーを消す' : 'ここにキーを打つ', 'aria-label': 'キーフレーム',
        onclick: (e) => {
          e.preventDefault();
          const off = offsetOf(c);
          hooks.edit(on ? 'キーを消す' : 'キーを打つ', () => {
            if (Keys.at(c, prop, off)) Keys.removeKey(c, prop, off);
            else Keys.setKey(c, prop, off, toV(get()));
          });
        },
      }, '◆');
    }
    const range = h('input', { type: 'range', min, max, step, value: get() });
    const num = h('input', { type: 'number', min, max, step, value: fmt(get()), inputmode: 'decimal' });
    let live = false;
    range.addEventListener('pointerdown', () => { if (!live) { live = true; hooks.begin(); } });
    range.addEventListener('input', () => {
      if (!live) { live = true; hooks.begin(); }
      hooks.live(() => set(parseFloat(range.value)));
      num.value = fmt(get());
    });
    range.addEventListener('change', () => { live = false; hooks.end(label); });
    num.addEventListener('change', () => {
      const v = parseFloat(num.value);
      if (!isFinite(v)) { num.value = fmt(get()); return; }
      hooks.edit(label, () => set(clamp(v, Number(min), Number(max))));
    });
    return h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, diamond, label2 || label), range, h('span', { class: 'insp-num' }, num, unit ? h('small', null, unit) : null));
  }

  function selectRow(label, options, value, onChange) {
    const s = h('select', { onchange: () => onChange(s.value) }, ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
    return h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label), s);
  }

  function info(label, text) {
    return h('div', { class: 'insp-row info' }, h('span', { class: 'insp-label' }, label), h('span', { class: 'insp-text' }, text));
  }

  function render() {
    if (!root || building) return;
    building = true;
    root.textContent = '';
    try {
      if (!p) return;
      const c = clipId ? p.clips[clipId] : null;
      if (!c) { renderProject(); return; }
      renderClip(c);
    } finally { building = false; }
  }

  function renderProject() {
    const dur = Proj.duration(p);
    root.append(
      h('div', { class: 'panel-head' }, h('span', null, '作品')),
      section('作品',
        info('大きさ', `${p.width} × ${p.height}`),
        info('フレーム', `${Math.round(F() * 1000) / 1000} fps`),
        info('長さ', fmtTC(dur, F())),
        info('クリップ', `${Object.keys(p.clips).length} 個`),
        h('button', { class: 'block', onclick: () => hooks.settings() }, '作品の設定…'),
      ),
      h('p', { class: 'insp-hint' }, 'タイムラインのクリップを選ぶと、位置・大きさ・音量などを調整できます。'),
    );
  }

  // ---- テロップ・字幕 ---------------------------------------------------------------
  function textArea(c, label) {
    const ta = h('textarea', { class: 'insp-textarea', rows: 3 }, c.text || '');
    let live = false;
    ta.addEventListener('input', () => {
      if (!live) { live = true; hooks.begin(); }
      hooks.live(() => { c.text = ta.value; });
    });
    ta.addEventListener('change', () => { live = false; if (!ta.value.trim()) { ta.value = c.text; } hooks.end(label); });
    return ta;
  }

  /** 色の欄（#rrggbbaa の透明度は残す） */
  function colorRow(label, get, set) {
    const v = get() || '#ffffff';
    const inp = h('input', { type: 'color', value: v.slice(0, 7) });
    inp.addEventListener('change', () => hooks.edit(label, () => set(inp.value + (v.length === 9 ? v.slice(7) : ''))));
    return h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label), inp);
  }

  function checkRow(label, get, set) {
    return h('label', { class: 'insp-row check' }, h('input', { type: 'checkbox', checked: !!get(), onchange: (e) => hooks.edit(label, () => set(e.target.checked)) }), h('span', null, label));
  }

  function renderText(c) {
    const st = () => c.style || (c.style = Telop.defaultTextStyle());
    const setSt = (k, v) => { c.style = { ...st(), [k]: v }; };
    const cur = c.style || {};
    const named = cur.telop_style && Telop.catalog ? Telop.get(cur.telop_style) : null;
    const strokes = Array.isArray(cur.strokes) ? cur.strokes : null;
    const edgeW = () => (strokes ? (strokes[0] ? strokes[0].width : 0) : (st().outline || 0));
    const setEdgeW = (v) => { if (strokes) { const s = JSON.parse(JSON.stringify(st().strokes || [])); if (s[0]) s[0].width = v; else s.push({ width: v, color: '#000000' }); setSt('strokes', s); } else setSt('outline', v); };
    const edgeC = () => (strokes ? (strokes[0] ? strokes[0].color : '#000000') : (st().outline_color || '#000000'));
    const setEdgeC = (v) => { if (strokes) { const s = JSON.parse(JSON.stringify(st().strokes || [])); if (s[0]) s[0].color = v; else s.push({ width: 6, color: v }); setSt('strokes', s); } else setSt('outline_color', v); };
    const fonts = Telop.FONT_CHOICES.slice();
    if (cur.font && !fonts.some(([f]) => f === cur.font)) fonts.unshift([cur.font, cur.font]);
    root.append(h('div', { class: 'panel-head' }, h('span', null, 'テキスト（テロップ）')));
    root.append(section('文字', textArea(c, '文字')));
    root.append(section('スタイル',
      h('div', { class: 'insp-stylename' }, named ? named.name : cur.telop_style ? cur.telop_style : '基本（白・黒縁）'),
      h('button', { class: 'block primary', onclick: async () => {
        const s = await StylePicker.pick(c.text, cur.telop_style);
        if (s) hooks.edit('スタイル', () => { c.style = Telop.applyToStyle(c.style, s); });
      } }, 'カタログから選ぶ…'),
      selectRow('書体', fonts, cur.font || 'BIZ UDGothic', (v) => hooks.edit('書体', () => setSt('font', v))),
      slider('大きさ', { min: 16, max: 320, step: 1, get: () => Math.round(st().size || 96), set: (v) => setSt('size', v), unit: 'px' }),
      colorRow('文字の色', () => st().color, (v) => { setSt('color', v); if (st().gradient) setSt('gradient', null); }),
      slider('縁の太さ', { min: 0, max: 40, step: 1, get: () => edgeW(), set: setEdgeW, unit: 'px' }),
      colorRow('縁の色', edgeC, setEdgeC),
      checkRow('帯（文字の後ろの四角）', () => st().box, (v) => setSt('box', v)),
      colorRow('帯の色', () => st().box_color || '#000000a0', (v) => setSt('box_color', v)),
    ));
    const anchors = [['center', '中央（位置で動かす）']].concat(Telop.ANCHORS.filter((a) => a !== 'center').map((a) => [a, Telop.ANCHOR_NAMES[a]]));
    root.append(section('置き場所',
      selectRow('基準', anchors, cur.anchor || 'center', (v) => hooks.edit('置き場所', () => { setSt('anchor', v === 'center' ? undefined : v); c.pos_x = 0; c.pos_y = 0; })),
      cur.anchor && cur.anchor !== 'center' ? slider('端から 横', { min: 0, max: 600, step: 2, get: () => Math.round(st().margin_x ?? 80), set: (v) => setSt('margin_x', v), unit: 'px' }) : null,
      cur.anchor && cur.anchor !== 'center' ? slider('端から 縦', { min: 0, max: 600, step: 2, get: () => Math.round(st().margin_y ?? 60), set: (v) => setSt('margin_y', v), unit: 'px' }) : null,
      ...transformSliders(c, 10),
    ));
    root.append(renderKeys(c));
    root.append(renderMotion(c));
    root.append(renderFades(c));
  }

  function renderMotion(c) {
    const rows = [];
    if (!Motion.catalog) { Motion.load().then(() => render()); return section('モーション', h('p', { class: 'insp-hint' }, '読み込んでいます…')); }
    for (const [kind, label] of Object.entries(Motion.KINDS)) {
      const ent = (c.motion || {})[kind];
      const list = Motion.ofKind(kind);
      const sel = h('select', null, h('option', { value: '' }, 'なし'),
        ...Object.entries(Motion.UNITS).map(([u, un]) => {
          const items = list.filter((m) => m.unit === u);
          return items.length ? h('optgroup', { label: un }, ...items.map((m) => h('option', { value: m.id, selected: ent && ent.id === m.id }, m.name))) : null;
        }));
      const m = ent && Motion.get(ent.id);
      const dur = h('input', { type: 'number', min: 0.05, max: 20, step: 0.05, value: ent && ent.dur ? ent.dur : '', placeholder: m ? String(m.duration) : '', inputmode: 'decimal', disabled: !ent });
      const setMotion = (fn) => hooks.edit('モーション', () => {
        const mo = JSON.parse(JSON.stringify(c.motion || {}));
        fn(mo);
        c.motion = Object.keys(mo).length ? mo : null;
      });
      sel.addEventListener('change', () => setMotion((mo) => { if (sel.value) mo[kind] = { id: sel.value }; else delete mo[kind]; }));
      dur.addEventListener('change', () => setMotion((mo) => { if (!mo[kind]) return; const v = parseFloat(dur.value); if (isFinite(v) && v > 0) mo[kind].dur = v; else delete mo[kind].dur; }));
      rows.push(h('label', { class: 'insp-row motion' }, h('span', { class: 'insp-label' }, label), sel, h('span', { class: 'insp-num' }, dur, h('small', null, '秒'))));
    }
    return section('モーション', ...rows,
      h('button', { class: 'block', onclick: () => hooks.preview(c) }, '▶ 動きを見る'));
  }

  function renderFades(c) {
    const maxFade = Math.max(0, c.duration / F());
    return section('フェード',
      slider('フェードイン', { min: 0, max: Math.min(10, maxFade).toFixed(2), step: 0.05, get: () => Math.round(c.fade_in / F() * 100) / 100, set: (v) => { c.fade_in = Math.min(c.duration, Math.round(v * F())); }, unit: '秒' }),
      slider('フェードアウト', { min: 0, max: Math.min(10, maxFade).toFixed(2), step: 0.05, get: () => Math.round(c.fade_out / F() * 100) / 100, set: (v) => { c.fade_out = Math.min(c.duration, Math.round(v * F())); }, unit: '秒' }));
  }

  function renderSubtitle(c) {
    const speaker = h('input', { type: 'text', value: (c.style || {}).speaker || '', placeholder: '空なら普通の字幕', class: 'wide-input' });
    speaker.addEventListener('change', () => hooks.edit('話者', () => {
      const name = speaker.value.trim();
      const s = { ...(c.style || {}) };
      if (name) {
        s.speaker = name;
        const all = p.subtitle_style || (p.subtitle_style = Telop.defaultSubtitleStyle());
        const sp = { ...(all.speakers || {}) };
        if (!sp[name]) sp[name] = Telop.speakerPreset(Object.keys(sp).length);
        p.subtitle_style = { ...all, speakers: sp };
      } else delete s.speaker;
      c.style = Object.keys(s).length ? s : null;
    }));
    root.append(h('div', { class: 'panel-head' }, h('span', null, '字幕')));
    root.append(section('字幕',
      textArea(c, '字幕の文字'),
      info('位置', `${fmtTC(c.start, F())} 〜 ${fmtTC(Proj.end(c), F())}`),
      h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, '話者（吹き出し）'), speaker),
      h('button', { class: 'block', onclick: () => hooks.subtitleStyle() }, '字幕全体の見た目…'),
    ));
    root.append(section('ずらす',
      slider('位置 X', { min: -p.width, max: p.width, step: 1, get: () => Math.round(c.pos_x), set: (v) => { c.pos_x = v; }, unit: 'px' }),
      slider('位置 Y', { min: -p.height, max: p.height, step: 1, get: () => Math.round(c.pos_y), set: (v) => { c.pos_y = v; }, unit: 'px' }),
      slider('不透明度', { min: 0, max: 100, step: 1, get: () => Math.round(c.opacity * 100), set: (v) => { c.opacity = v / 100; }, unit: '%' }),
    ));
    root.append(renderFades(c));
  }

  /** 位置・拡大・回転・不透明度（キーフレームの ◆ 付き） */
  function transformSliders(c, scaleMin = 5) {
    return [
      slider('位置 X', { min: -p.width, max: p.width, step: 1, get: () => Math.round(c.pos_x), set: (v) => { c.pos_x = v; }, unit: 'px', kf: { c, prop: 'pos_x', fromV: Math.round } }),
      slider('位置 Y', { min: -p.height, max: p.height, step: 1, get: () => Math.round(c.pos_y), set: (v) => { c.pos_y = v; }, unit: 'px', kf: { c, prop: 'pos_y', fromV: Math.round } }),
      slider('拡大', { min: scaleMin, max: 400, step: 1, get: () => Math.round(c.scale * 100), set: (v) => { c.scale = v / 100; }, unit: '%', kf: { c, prop: 'scale', toV: (v) => v / 100, fromV: (v) => Math.round(v * 100) } }),
      slider('回転', { min: -180, max: 180, step: 0.5, get: () => c.rotation, set: (v) => { c.rotation = v; }, unit: '°', kf: { c, prop: 'rotation', fromV: (v) => Math.round(v * 10) / 10 } }),
      slider('不透明度', { min: 0, max: 100, step: 1, get: () => Math.round(c.opacity * 100), set: (v) => { c.opacity = v / 100; }, unit: '%', kf: { c, prop: 'opacity', toV: (v) => v / 100, fromV: (v) => Math.round(v * 100) } }),
    ];
  }

  /** キーフレームのまとめ（前後のキーへ移動・補間・全部消す） */
  function renderKeys(c) {
    const offs = Keys.offsets(c);
    if (!offs.length) return section('キーフレーム', h('p', { class: 'insp-hint' }, '◆ を押すと、再生位置にキーを打ちます。キーを 2 つ以上打つと、その間で値がなめらかに変わります。'));
    const off = offsetOf(c);
    const prev = offs.filter((o) => o < off).pop();
    const next = offs.find((o) => o > off);
    const here = Keys.ANIMATABLE.filter((pp) => Keys.at(c, pp, off));
    const easing = here.length ? Keys.at(c, here[0], off)[2] || 'linear' : null;
    return section('キーフレーム',
      info('キー', `${offs.length} か所${here.length ? '（再生位置にあり）' : ''}`),
      h('div', { class: 'insp-buttons' },
        h('button', { disabled: prev === undefined, onclick: () => hooks.seek(c.start + prev) }, '◀ 前のキー'),
        h('button', { disabled: next === undefined, onclick: () => hooks.seek(c.start + next) }, '次のキー ▶')),
      here.length ? selectRow('次への動き', Keys.EASINGS, easing, (v) => hooks.edit('補間', () => { for (const pp of here) Keys.setKey(c, pp, off, Keys.at(c, pp, off)[1], v); })) : null,
      h('button', { class: 'block', onclick: () => hooks.edit('キーを全部消す', () => Keys.clearKeys(c, null, c.start + off)) }, 'キーを全部消す（今の値で止める）'));
  }

  /** 色調補正 */
  function renderGrade(c) {
    const g = c.grade || {};
    const setG = (k, v) => { const n = { ...(c.grade || {}) }; if (v === undefined || v === null) delete n[k]; else n[k] = v; c.grade = Object.keys(n).length ? n : null; };
    const looks = [['', 'ルックを選ぶ…']].concat(Object.keys(Grade.LOOKS).map((k) => [k, k]));
    const rows = [selectRow('ルック', looks, '', (v) => { if (v) hooks.edit('ルック', () => { c.grade = { ...Grade.LOOKS[v] }; }); })];
    for (const [k, [d, lo, hi, label, step]] of Object.entries(Grade.PARAMS)) {
      if (k === 'lut_mix') continue;
      rows.push(slider(label.replace(/（.*）/, ''), { min: lo, max: hi, step, get: () => Number(g[k] ?? d), set: (v) => setG(k, Math.abs(v - d) < 1e-9 ? undefined : v), label2: label }));
    }
    const lutSel = h('select', null, h('option', { value: '' }, 'なし'));
    for (const [ref, name] of Object.entries(Grade.BUILTIN)) lutSel.append(h('option', { value: ref, selected: g.lut === ref }, name));
    lutSel.append(h('option', { value: '+import' }, '＋ .cube を読み込む…'));
    if (g.lut && !Grade.BUILTIN[g.lut]) lutSel.append(h('option', { value: g.lut, selected: true }, Grade.lutName(g.lut)));
    Grade.userLuts().then((list) => {
      for (const u of list) {
        if (u.ref === g.lut) { const o = lutSel.querySelector(`option[value="${u.ref}"]`); if (o) o.textContent = u.name; continue; }
        lutSel.insertBefore(h('option', { value: u.ref }, u.name), lutSel.querySelector('option[value="+import"]'));
      }
    });
    lutSel.addEventListener('change', async () => {
      if (lutSel.value === '+import') { lutSel.value = g.lut || ''; const ref = await hooks.importLut(); if (ref) hooks.edit('LUT', () => setG('lut', ref)); return; }
      hooks.edit('LUT', () => setG('lut', lutSel.value || undefined));
    });
    rows.push(h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, 'LUT'), lutSel));
    const err = g.lut ? Grade.error(g.lut) : '';
    if (err) rows.push(h('p', { class: 'insp-hint warn' }, err));
    if (g.lut) rows.push(slider('LUT の強さ', { min: 0, max: 100, step: 1, get: () => Math.round(Number(g.lut_mix ?? 1) * 100), set: (v) => setG('lut_mix', v / 100), unit: '%' }));
    rows.push(h('button', { class: 'block', disabled: !c.grade, onclick: () => hooks.edit('色を戻す', () => { c.grade = null; }) }, '色を元に戻す'));
    return section('色', ...rows);
  }

  function renderCrop(c) {
    const names = ['左', '上', '右', '下'];
    return section('切り抜き', ...names.map((n, i) => slider(n, {
      min: 0, max: 49, step: 0.5, get: () => Math.round(((c.crop || [0, 0, 0, 0])[i] || 0) * 1000) / 10, unit: '%',
      set: (v) => { const cr = (c.crop || [0, 0, 0, 0]).slice(); cr[i] = v / 100; c.crop = cr.some((x) => x > 0) ? cr : null; },
    })));
  }

  /** 手ぶれ補正（動きの解析 → なめらかな道筋に寄せる） */
  function renderStab(c, m) {
    const st = c.stab;
    const res = Stabilize.get(c.media);
    const ok = Stabilize.covers(res, c, F());
    const setS = (k, v) => { c.stab = { on: true, strength: 1, zoom: null, ...(c.stab || {}), [k]: v }; };
    const rows = [];
    rows.push(h('label', { class: 'insp-row check' },
      h('input', { type: 'checkbox', checked: !!(st && st.on), onchange: (e) => { const on = e.target.checked; hooks.edit(on ? '手ぶれ補正' : '手ぶれ補正を外す', () => setS('on', on)); if (on && !ok) analyzeStab(c, m); } }),
      h('span', null, '手ぶれを補正する')));
    if (st && st.on) {
      if (!ok) rows.push(h('p', { class: 'insp-hint warn' }, res ? 'クリップの範囲が解析した範囲を超えています。解析し直してください。' : 'まだ解析していません。'));
      rows.push(slider('なめらかさ', { min: 0.2, max: 5, step: 0.1, get: () => Number(st.strength || 1), set: (v) => setS('strength', v), unit: '秒' }));
      const auto = ok ? Stabilize.at(c, c.src_in) : null;
      rows.push(slider('拡大', { min: 100, max: 150, step: 1, get: () => Math.round((st.zoom || (auto ? auto.auto : 1)) * 100), set: (v) => setS('zoom', v / 100), unit: '%' }));
      rows.push(h('button', { class: 'block', disabled: !st.zoom, onclick: () => hooks.edit('拡大を自動に', () => setS('zoom', null)) }, st.zoom ? '拡大を自動に戻す' : `拡大は自動（${auto ? Math.round(auto.auto * 100) + '%' : '解析の後'}）`));
    }
    rows.push(h('button', { class: 'block', onclick: () => analyzeStab(c, m) }, res ? '動きを解析し直す' : '動きを解析する'));
    rows.push(h('p', { class: 'insp-hint' }, '映像の動きを解析して、カメラの揺れだけをなめらかにします（AI のモデルではなく、手ぶれ補正の定番の方法）。なめらかさを大きくするほど、ゆっくりしたパンも止まって見えます。'));
    return section('手ぶれ補正', ...rows);
  }

  async function analyzeStab(c, m) {
    hooks.pause && hooks.pause();
    const fps = F();
    const old = Stabilize.get(c.media);
    // クリップの範囲（前後に 1 秒の余裕）。前の解析の範囲も含める（同じ素材の別のクリップのため）
    let a = Math.max(0, c.src_in - 1), b = Math.min(m.duration || 1e9, c.src_in + c.duration / fps * c.speed + 1);
    if (old) { a = Math.min(a, old.start / old.fps); b = Math.max(b, (old.start + old.n) / old.fps); }
    let cancelled = false;
    const pb = progressBox('手ぶれを解析しています', () => { cancelled = true; });
    try {
      await Stabilize.analyze(c.media, Media.rec(c.media) || m, a, b, (r) => pb.set(`${Math.round(r * 100)}%`, r), () => cancelled);
      pb.close();
      if (!c.stab || !c.stab.on) hooks.edit('手ぶれ補正', () => { c.stab = { on: true, strength: 1, zoom: null, ...(c.stab || {}), on: true }; });
      else { render(); hooks.changed && hooks.changed(); }
      toast('手ぶれを解析しました');
    } catch (err) {
      pb.close();
      if (err && err.message === 'cancel') { toast('解析をやめました'); return; }
      console.error(err);
      showDialog({ title: '解析できませんでした', body: String((err && err.message) || err) });
    }
  }

  const TRANSITIONS = [['dissolve', 'クロスディゾルブ'], ['dip_black', '黒を挟む'], ['dip_white', '白を挟む'], ['wipe_left', 'ワイプ（左へ）'], ['wipe_right', 'ワイプ（右へ）'], ['wipe_up', 'ワイプ（上へ）'], ['wipe_down', 'ワイプ（下へ）'], ['slide_left', 'スライド（左へ）'], ['zoom', 'ズーム']];

  function renderTransition(c) {
    const isAudio = Proj.track(p, c.track).kind === 'audio';
    const prev = Object.values(p.clips).find((q) => q.track === c.track && Proj.end(q) === c.start && q.enabled);
    const cur = c.trans_in;
    const type = h('select', null, h('option', { value: '' }, 'なし'), ...(isAudio ? [['dissolve', 'クロスフェード']] : TRANSITIONS).map(([v, t]) => h('option', { value: v, selected: cur && cur.type === v }, t)));
    const secs = h('input', { type: 'number', min: 0.1, max: 5, step: 0.1, value: cur ? Math.round(cur.frames / F() * 100) / 100 : 0.5, inputmode: 'decimal' });
    const apply = () => hooks.edit(type.value ? 'トランジション' : 'トランジションを外す', () => {
      const n = Math.max(2, Math.round((parseFloat(secs.value) || 0.5) * F()));
      Proj.setTransition(p, c, type.value || null, n);
    });
    type.addEventListener('change', apply);
    secs.addEventListener('change', () => { if (type.value) apply(); });
    return section('前のクリップとのつなぎ',
      h('label', { class: 'insp-row motion' }, h('span', { class: 'insp-label' }, '種類'), type, h('span', { class: 'insp-num' }, secs, h('small', null, '秒'))),
      prev ? null : h('p', { class: 'insp-hint' }, 'すぐ前に接しているクリップがありません。選ぶとフェードインになります。'),
      h('p', { class: 'insp-hint' }, isAudio ? 'リンクした映像にも付きます。' : 'リンクした音声にはクロスフェードが付きます。'));
  }

  function renderFill(c) {
    root.append(h('div', { class: 'panel-head' }, h('span', null, 'カラー（単色）')));
    root.append(section('色',
      colorRow('色', () => c.fill, (v) => { c.fill = v; }),
      slider('濃さ', { min: 0, max: 100, step: 1, get: () => Math.round(parseInt((c.fill || '#000000ff').slice(7, 9) || 'ff', 16) / 2.55), unit: '%', set: (v) => { c.fill = (c.fill || '#000000').slice(0, 7) + Math.round(v * 2.55).toString(16).padStart(2, '0'); } })));
    root.append(section('見た目', ...transformSliders(c)));
    root.append(renderKeys(c));
    root.append(renderTransition(c));
    root.append(renderFades(c));
  }

  function renderClip(c) {
    const m = c.media ? p.media[c.media] : null;
    const tr = Proj.track(p, c.track);
    if (tr.kind === 'subtitle') { renderSubtitle(c); return; }
    if (c.text && !c.media) { renderText(c); return; }
    if (c.fill && !c.media) { renderFill(c); return; }
    const isAudio = tr.kind === 'audio';
    const nameInput = h('input', { type: 'text', value: c.name || '', class: 'wide-input' });
    nameInput.addEventListener('change', () => hooks.edit('名前', () => { c.name = nameInput.value.trim(); }));
    const maxFade = Math.max(0, c.duration / F());
    root.append(h('div', { class: 'panel-head' }, h('span', null, isAudio ? '音声クリップ' : m && m.kind === 'image' ? '画像クリップ' : '映像クリップ')));
    root.append(section('クリップ',
      h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, '名前'), nameInput),
      info('位置', `${fmtTC(c.start, F())} 〜 ${fmtTC(Proj.end(c), F())}`),
      info('長さ', `${fmtTC(c.duration, F())}（${(c.duration / F()).toFixed(2)} 秒）`),
      m ? info('素材', `${m.name}${m.kind !== 'image' ? '　' + (c.src_in).toFixed(2) + ' 秒から' : ''}`) : null,
      h('label', { class: 'insp-row check' },
        h('input', { type: 'checkbox', checked: c.enabled, onchange: (e) => hooks.edit(e.target.checked ? '有効にする' : '無効にする', () => { c.enabled = e.target.checked; }) }),
        h('span', null, '有効（外すと見えない・聞こえない）')),
    ));
    if (!isAudio) {
      root.append(section('見た目',
        selectRow('はめ方', [['fit', '画面に収める'], ['fill', '画面を埋める'], ['none', '原寸']], c.fit, (v) => hooks.edit('はめ方', () => { c.fit = v; })),
        ...transformSliders(c),
        h('button', { class: 'block', onclick: () => hooks.edit('見た目を戻す', () => { Object.assign(c, { pos_x: 0, pos_y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'fit' }); for (const pp of ['pos_x', 'pos_y', 'scale', 'rotation', 'opacity']) Keys.clearKeys(c, pp); }) }, '見た目を元に戻す'),
      ));
      root.append(renderKeys(c));
      root.append(renderGrade(c));
      root.append(renderCrop(c));
      if (m && m.kind === 'video') root.append(renderStab(c, m));
    } else {
      root.append(section('音',
        slider('音量', { min: -40, max: 12, step: 0.5, get: () => c.volume_db, set: (v) => { c.volume_db = v; }, unit: 'dB', kf: { c, prop: 'volume_db', fromV: (v) => Math.round(v * 2) / 2 } }),
      ));
      root.append(renderKeys(c));
      root.append(...renderAudioFx(c));
    }
    root.append(renderTransition(c));
    root.append(section('フェード・速さ',
      slider('フェードイン', { min: 0, max: Math.min(10, maxFade).toFixed(2), step: 0.05, get: () => Math.round(c.fade_in / F() * 100) / 100, set: (v) => { c.fade_in = Math.min(c.duration, Math.round(v * F())); }, unit: '秒' }),
      slider('フェードアウト', { min: 0, max: Math.min(10, maxFade).toFixed(2), step: 0.05, get: () => Math.round(c.fade_out / F() * 100) / 100, set: (v) => { c.fade_out = Math.min(c.duration, Math.round(v * F())); }, unit: '秒' }),
      m && m.kind !== 'image'
        ? selectRow('速さ', [['0.25', '0.25 倍'], ['0.5', '0.5 倍'], ['0.75', '0.75 倍'], ['1', '1 倍（そのまま）'], ['1.25', '1.25 倍'], ['1.5', '1.5 倍'], ['2', '2 倍'], ['3', '3 倍'], ['4', '4 倍']]
          .concat([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(c.speed) ? [] : [[String(c.speed), c.speed + ' 倍']]),
        String(c.speed), (v) => hooks.edit('速さ', () => { for (const x of Proj.linked(p, c)) Proj.setSpeed(p, x, parseFloat(v)); }))
        : null,
    ));
    if (c.link) root.append(h('button', { class: 'block', onclick: () => hooks.edit('リンク解除', () => Proj.unlink(p, [c.id])) }, '映像と音声のリンクを外す'));
  }

  /** 音声クリップのエフェクト（EQ・コンプ・ノイズ除去）と音量をそろえる */
  function renderAudioFx(c) {
    const afx = c.afx || {};
    const setFx = (k, v) => {
      const n = { ...(c.afx || {}) };
      if (v === null || v === undefined || v === 0) delete n[k]; else n[k] = v;
      c.afx = Object.keys(n).length ? n : null;
    };
    const presetSel = (label, presets, cur, apply) => {
      const match = Object.entries(presets).find(([, v]) => cur && JSON.stringify(v) === JSON.stringify(cur));
      const opts = [['', cur ? (match ? match[0] : '自分で決めた値') : 'なし']].concat(Object.keys(presets).map((k) => [k, k]));
      if (cur) opts.push(['-', '外す']);
      return selectRow(label, opts, match ? match[0] : '', (v) => { if (v) hooks.edit(label, () => apply(v === '-' ? null : { ...presets[v] })); });
    };
    const eq = afx.eq;
    const eqRows = [presetSel('かんたん', AudioFx.EQ_PRESETS, eq, (v) => setFx('eq', v))];
    if (eq) {
      const setEq = (k, v) => setFx('eq', { ...(c.afx.eq || {}), [k]: v });
      eqRows.push(
        slider('低音を切る', { min: 0, max: 400, step: 10, get: () => Number(eq.low_cut || 0), set: (v) => setEq('low_cut', v), unit: 'Hz' }),
        slider('低音', { min: -12, max: 12, step: 0.5, get: () => Number(eq.low_gain || 0), set: (v) => setEq('low_gain', v), unit: 'dB' }),
        slider('中音（声）', { min: -12, max: 12, step: 0.5, get: () => Number(eq.mid_gain || 0), set: (v) => setEq('mid_gain', v), unit: 'dB' }),
        slider('高音', { min: -18, max: 12, step: 0.5, get: () => Number(eq.high_gain || 0), set: (v) => setEq('high_gain', v), unit: 'dB' }));
    }
    const comp = afx.comp;
    const compRows = [presetSel('かんたん', AudioFx.COMP_PRESETS, comp, (v) => setFx('comp', v))];
    if (comp) {
      const setC = (k, v) => setFx('comp', { ...(c.afx.comp || {}), [k]: v });
      compRows.push(
        slider('しきい値', { min: -60, max: 0, step: 1, get: () => Number(comp.threshold ?? -24), set: (v) => setC('threshold', v), unit: 'dB' }),
        slider('比率', { min: 1, max: 10, step: 0.5, get: () => Number(comp.ratio ?? 3), set: (v) => setC('ratio', v), unit: ': 1' }),
        slider('持ち上げ', { min: 0, max: 18, step: 0.5, get: () => Number(comp.makeup ?? 0), set: (v) => setC('makeup', v), unit: 'dB' }));
    }
    const dn = Number(afx.denoise || 0);
    const dnSel = selectRow('強さ', [['0', 'なし'], ['0.5', '弱い'], ['0.8', 'ふつう'], ['0.95', '強い']].concat([0, 0.5, 0.8, 0.95].includes(dn) ? [] : [[String(dn), String(dn)]]), String(dn),
      (v) => { hooks.edit('ノイズ除去', () => setFx('denoise', Number(v) || null)); if (Number(v)) hooks.prepareFx(c); });
    const target = h('select', null, ...AudioFx.LOUDNESS_TARGETS.map(([t, v]) => h('option', { value: v, selected: v === -16 }, t)));
    return [
      section('声・音の調整（EQ）', ...eqRows),
      section('コンプレッサー（音量の差を縮める）', ...compRows),
      section('ノイズ除去（エアコン・ファンなどの一定の雑音）', dnSel, dn ? h('p', { class: 'insp-hint' }, '処理は最初の再生・書き出しの前に一度だけ行います（長い素材は少し時間がかかります）。') : null),
      section('音量をそろえる（ラウドネス）',
        h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, '目標'), target),
        h('button', { class: 'block', onclick: () => hooks.normalize(Number(target.value)) }, '選んだ音声クリップを目標に合わせる'),
        h('p', { class: 'insp-hint' }, '同じ素材のクリップはまとめて測り、同じだけ動かします（細切れにした声の音量がそろったまま）。')),
    ];
  }

  /** 再生位置が動いた時（キーフレームのある値を出し直す） */
  function onSeek() {
    const c = clipId && p ? p.clips[clipId] : null;
    if (c && c.keys) refresh();
  }

  return { init, setProject, show, refresh, onSeek };
})();
