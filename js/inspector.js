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

  /**
   * スライダー＋数字の行。get() → 表示の値、set(v) → クリップへ（表示の単位で受け取る）
   */
  function slider(label, { min, max, step, get, set, unit = '', fmt = (v) => v, label2 }) {
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
    return h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label2 || label), range, h('span', { class: 'insp-num' }, num, unit ? h('small', null, unit) : null));
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
      slider('位置 X', { min: -p.width, max: p.width, step: 1, get: () => Math.round(c.pos_x), set: (v) => { c.pos_x = v; }, unit: 'px' }),
      slider('位置 Y', { min: -p.height, max: p.height, step: 1, get: () => Math.round(c.pos_y), set: (v) => { c.pos_y = v; }, unit: 'px' }),
      slider('拡大', { min: 10, max: 400, step: 1, get: () => Math.round(c.scale * 100), set: (v) => { c.scale = v / 100; }, unit: '%' }),
      slider('回転', { min: -180, max: 180, step: 0.5, get: () => c.rotation, set: (v) => { c.rotation = v; }, unit: '°' }),
      slider('不透明度', { min: 0, max: 100, step: 1, get: () => Math.round(c.opacity * 100), set: (v) => { c.opacity = v / 100; }, unit: '%' }),
    ));
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

  function renderClip(c) {
    const m = c.media ? p.media[c.media] : null;
    const tr = Proj.track(p, c.track);
    if (tr.kind === 'subtitle') { renderSubtitle(c); return; }
    if (c.text && !c.media) { renderText(c); return; }
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
        slider('位置 X', { min: -p.width, max: p.width, step: 1, get: () => Math.round(c.pos_x), set: (v) => { c.pos_x = v; }, unit: 'px' }),
        slider('位置 Y', { min: -p.height, max: p.height, step: 1, get: () => Math.round(c.pos_y), set: (v) => { c.pos_y = v; }, unit: 'px' }),
        slider('拡大', { min: 5, max: 400, step: 1, get: () => Math.round(c.scale * 100), set: (v) => { c.scale = v / 100; }, unit: '%' }),
        slider('回転', { min: -180, max: 180, step: 0.5, get: () => c.rotation, set: (v) => { c.rotation = v; }, unit: '°' }),
        slider('不透明度', { min: 0, max: 100, step: 1, get: () => Math.round(c.opacity * 100), set: (v) => { c.opacity = v / 100; }, unit: '%' }),
        h('button', { class: 'block', onclick: () => hooks.edit('見た目を戻す', () => Object.assign(c, { pos_x: 0, pos_y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'fit' })) }, '見た目を元に戻す'),
      ));
    } else {
      root.append(section('音',
        slider('音量', { min: -40, max: 12, step: 0.5, get: () => c.volume_db, set: (v) => { c.volume_db = v; }, unit: 'dB' }),
      ));
    }
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

  return { init, setProject, show, refresh };
})();
