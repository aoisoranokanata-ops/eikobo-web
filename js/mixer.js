/* ------------------------------------------------------------
   ミキサー（プレビューの上に重ねる、閉じられる板）
   トラックごとの音量・パン・ミュート・ソロ・メーター、マスターの音量・リミッター、BGM の自動ダッキング、全体のラウドネス。
   音量・パンは動かしている間も再生を止めずに反映し（Engine.liveMix）、離した時に履歴に積む。
   ------------------------------------------------------------ */
const Mixer = (() => {
  let root = null, p = null, hooks = {}, raf = 0;
  const meterEls = new Map();

  function init(el, h0) { root = el; hooks = h0; }
  function setProject(proj) { p = proj; if (!root.hidden) render(); }
  const isOpen = () => root && !root.hidden;

  function toggle(force) {
    const open = force !== undefined ? force : root.hidden;
    root.hidden = !open;
    if (open) { render(); loop(); } else { cancelAnimationFrame(raf); raf = 0; }
  }

  function refresh() { if (isOpen()) render(); }

  /** スライダー（動かしている間は liveMix、離したら履歴） */
  function fader(label, { min, max, step, get, set, fmt }) {
    const range = h('input', { type: 'range', min, max, step, value: get() });
    const val = h('span', { class: 'mx-val' }, fmt(get()));
    let live = false;
    range.addEventListener('input', () => {
      if (!live) { live = true; hooks.begin(); }
      set(parseFloat(range.value));
      val.textContent = fmt(get());
      Engine.liveMix();
    });
    range.addEventListener('change', () => { live = false; hooks.end(label); });
    range.addEventListener('dblclick', () => { hooks.edit(label, () => set(0)); });
    return [range, val];
  }

  function meter(id) {
    const c = h('canvas', { class: 'mx-meter', width: 120, height: 10 });
    meterEls.set(id, c);
    return c;
  }

  function render() {
    if (!p) return;
    root.textContent = '';
    meterEls.clear();
    const auds = p.tracks.filter((t) => t.kind === 'audio');
    const rows = auds.map((t) => {
      const [vol, volV] = fader('トラックの音量', { min: -40, max: 12, step: 0.5, get: () => t.volume_db || 0, set: (v) => { Proj.track(p, t.id).volume_db = v; }, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' });
      const [pan, panV] = fader('パン', { min: -100, max: 100, step: 1, get: () => Math.round((t.pan || 0) * 100), set: (v) => { Proj.track(p, t.id).pan = v / 100; }, fmt: (v) => (v === 0 ? '中央' : v < 0 ? '左 ' + (-v) : '右 ' + v) });
      const btn = (key, label, on, cls) => h('button', { class: 'mx-btn ' + cls + (on ? ' on' : ''), onclick: () => hooks.edit(label, () => { const x = Proj.track(p, t.id); x[key] = !x[key]; }) }, label);
      return h('div', { class: 'mx-row' },
        h('span', { class: 'mx-name' }, t.name),
        btn('muted', 'M', t.muted, 'mute'), btn('solo', 'S', t.solo, 'solo'),
        h('label', { class: 'mx-ctl' }, h('small', null, '音量'), vol, volV),
        h('label', { class: 'mx-ctl pan' }, h('small', null, 'パン'), pan, panV),
        meter(t.id));
    });
    const lim = p.limiter || { on: true, ceiling: -1 };
    const [mvol, mvolV] = fader('マスター音量', { min: -24, max: 12, step: 0.5, get: () => p.master_db || 0, set: (v) => { p.master_db = v; }, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' });
    const limOn = h('input', { type: 'checkbox', checked: lim.on !== false, onchange: (e) => hooks.edit('リミッター', () => { p.limiter = { ...lim, on: e.target.checked }; }) });
    const ceil = h('input', { type: 'number', min: -12, max: 0, step: 0.1, value: lim.ceiling ?? -1, class: 'mx-num' });
    ceil.addEventListener('change', () => hooks.edit('リミッターの天井', () => { p.limiter = { ...lim, ceiling: clamp(Number(ceil.value) || -1, -12, 0) }; }));
    const master = h('div', { class: 'mx-row master' },
      h('span', { class: 'mx-name' }, 'マスター'),
      h('label', { class: 'mx-ctl' }, h('small', null, '音量'), mvol, mvolV),
      h('label', { class: 'mx-ctl lim' }, limOn, h('small', null, 'リミッター'), ceil, h('small', null, 'dB')),
      meter('master'));
    root.append(
      h('div', { class: 'mx-head' }, h('b', null, 'ミキサー'), h('span', { class: 'hint' }, 'ダブルタップで 0 に戻す'), h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => hooks.duck() }, 'BGM の自動ダッキング' + (p.ducking && p.ducking.on ? '（ON）' : '')),
        h('button', { class: 'small', onclick: measure }, '全体のラウドネス'),
        h('button', { class: 'small', 'aria-label': '閉じる', onclick: () => toggle(false) }, '✕')),
      ...rows, master);
  }

  async function measure() {
    const pb = progressBox('全体のラウドネスを測っています');
    let r = null;
    try { r = await Engine.measureMix(p); } catch (err) { console.error(err); } finally { pb.close(); }
    if (!r || !isFinite(r.lufs)) { toast('音がありません'); return; }
    const sel = h('select', null, ...AudioFx.LOUDNESS_TARGETS.map(([t, v]) => h('option', { value: v }, t)));
    const v = await showDialog({
      title: '全体のラウドネス',
      body: h('div', { class: 'form' },
        h('p', { class: 'modal-text' }, `統合ラウドネス ${r.lufs.toFixed(1)} LUFS　ピーク ${r.peak.toFixed(1)} dBFS（書き出しと同じ混ぜ方・リミッター込み）`),
        h('label', null, '目標', sel),
        h('p', { class: 'hint' }, '「合わせる」はマスター音量を動かします（リミッターがあるので、上げすぎた分は抑えられます）。')),
      buttons: [{ label: '閉じる', value: null }, { label: '合わせる', value: 'fit', primary: true }],
    });
    if (v === 'fit') {
      const target = Number(sel.value);
      hooks.edit('ラウドネスを合わせる', () => { p.master_db = clamp(Math.round(((p.master_db || 0) + target - r.lufs) * 10) / 10, -24, 24); });
      render();
      toast(`マスター音量を ${(p.master_db > 0 ? '+' : '') + p.master_db} dB にしました`);
    }
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const m = Engine.meters();
    for (const [id, c] of meterEls) {
      const g = c.getContext('2d');
      const peak = m[id] || 0;
      const db = peak > 0 ? 20 * Math.log10(peak) : -90;
      const x = clamp((db + 60) / 60, 0, 1) * c.width;
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = '#2a2e36';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = db > -1 ? '#e05a4f' : db > -9 ? '#e0b030' : '#3fbf74';
      g.fillRect(0, 0, x, c.height);
    }
  }

  return { init, setProject, toggle, refresh, isOpen };
})();
