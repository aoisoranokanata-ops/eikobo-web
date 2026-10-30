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
    if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'range') return;
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

  function renderClip(c) {
    const m = c.media ? p.media[c.media] : null;
    const tr = Proj.track(p, c.track);
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
