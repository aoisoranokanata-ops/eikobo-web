/* ------------------------------------------------------------
   テロップのモーション（登場・強調・退場）。exe の core/motion.py の移植（同じ JSON・同じ計算）。

   クリップには clip.motion = {in: {id, dur}, emph: {...}, out: {...}} で持つ。
   行列は canvas の並び [a, b, c, d, e, f]（x' = a x + c y + e、y' = b x + d y + f）。
   ------------------------------------------------------------ */
const Motion = (() => {
  const KINDS = { in: '登場', emph: '強調', out: '退場' };
  const UNITS = { whole: '全体', line: '1 行ずつ', char: '1 文字ずつ' };
  const UNIT_RANK = { whole: 0, line: 1, char: 2 };
  const DIRS = { left: '左', right: '右', top: '上', bottom: '下' };
  const IDENTITY = { opacity: 1, x: 0, y: 0, sx: 0, sy: 0, scale: 1, scale_x: 1, scale_y: 1, rotation: 0, blur: 0, wipe: 1, tint: 0, rx: 0, ry: 0, rr: 0 };
  const EASE_OUT_FADE = 0.15;
  let catalog = null;

  function ease(u, kind) {
    u = Math.min(1, Math.max(0, u));
    const c1 = 1.70158;
    switch (kind) {
      case 'linear': return u;
      case 'in_quad': return u * u;
      case 'out_quad': return 1 - (1 - u) ** 2;
      case 'inout_quad': return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      case 'in_cubic': return u ** 3;
      case 'out_cubic': return 1 - (1 - u) ** 3;
      case 'inout_cubic': return u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
      case 'in_expo': return u <= 0 ? 0 : 2 ** (10 * u - 10);
      case 'out_expo': return u >= 1 ? 1 : 1 - 2 ** (-10 * u);
      case 'in_back': return (c1 + 1) * u ** 3 - c1 * u * u;
      case 'out_back': return 1 + (c1 + 1) * (u - 1) ** 3 + c1 * (u - 1) ** 2;
      case 'inout_back': {
        const c2 = c1 * 1.525;
        return u < 0.5 ? ((2 * u) ** 2 * ((c2 + 1) * 2 * u - c2)) / 2 : ((2 * u - 2) ** 2 * ((c2 + 1) * (u * 2 - 2) + c2) + 2) / 2;
      }
      case 'out_elastic':
        if (u <= 0 || u >= 1) return u;
        return 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
      case 'out_bounce': {
        const n1 = 7.5625, d1 = 2.75;
        if (u < 1 / d1) return n1 * u * u;
        if (u < 2 / d1) { u -= 1.5 / d1; return n1 * u * u + 0.75; }
        if (u < 2.5 / d1) { u -= 2.25 / d1; return n1 * u * u + 0.9375; }
        u -= 2.625 / d1; return n1 * u * u + 0.984375;
      }
      case 'instant': return u > 0 ? 1 : 0;
      case 'hold': return u >= 1 ? 1 : 0;
      default: return u;
    }
  }

  // ---- カタログ -------------------------------------------------------------------
  function dirMap(d, key, wipeDir) {
    const k = { ...key };
    for (const [a, b] of [['x', 'y'], ['sx', 'sy'], ['rx', 'ry']]) {
      if (key[a] === undefined && key[b] === undefined) continue;
      const va = key[a] || 0, vb = key[b] || 0;
      let na = va, nb = vb;
      if (d === 'right') { na = -va; nb = vb; } else if (d === 'top') { na = vb; nb = va; } else if (d === 'bottom') { na = vb; nb = -va; }
      k[a] = na + 0; k[b] = nb + 0;
    }
    if (d === 'right' || d === 'top') for (const p of ['rotation', 'rr']) if (p in k) k[p] = -k[p];
    const wmap = {
      left: { ltr: 'ltr', rtl: 'rtl', ttb: 'ttb', btt: 'btt' }, right: { ltr: 'rtl', rtl: 'ltr', ttb: 'ttb', btt: 'btt' },
      top: { ltr: 'ttb', rtl: 'btt', ttb: 'ltr', btt: 'rtl' }, bottom: { ltr: 'btt', rtl: 'ttb', ttb: 'ltr', btt: 'rtl' },
    };
    return [k, wmap[d][wipeDir] || wipeDir];
  }

  function expand(m) {
    if (!m.dirs) return [m];
    return m.dirs.filter((d) => DIRS[d]).map((d) => {
      const mm = JSON.parse(JSON.stringify(m));
      delete mm.dirs;
      mm.id = `${m.id}.${d}`;
      mm.name = String(m.name || m.id).replace('{dir}', DIRS[d]);
      const wd = m.wipe_dir || 'ltr';
      mm.keys = (m.keys || []).map((k) => dirMap(d, k, wd)[0]);
      mm.wipe_dir = dirMap(d, {}, wd)[1];
      return mm;
    });
  }

  function normalize(m) {
    return {
      id: m.id, name: String(m.name || m.id), kind: m.kind, unit: m.unit || 'whole', duration: m.duration ?? 0.5, stagger: m.stagger || 0,
      order: m.order || 'forward', easing: m.easing || 'out_cubic', mode: m.mode || 'once', delay: m.delay || 0,
      wipe_dir: m.wipe_dir || 'ltr', tint_color: m.tint_color || '#ffffff', keys: m.keys, tags: m.tags || [], description: m.description || '',
    };
  }

  async function load() {
    if (catalog) return catalog;
    const data = await fetch('assets/telop_motions/motions.json').then((r) => r.json());
    const byId = new Map();
    for (const raw of data.motions || []) for (const m of expand(raw)) {
      if (!KINDS[m.kind] || !Array.isArray(m.keys) || m.keys.length < 2) continue;
      byId.set(m.id, normalize(m));
    }
    catalog = { motions: [...byId.values()] };
    return catalog;
  }

  const get = (id) => (catalog ? catalog.motions.find((m) => m.id === id) || null : null);
  const ofKind = (kind) => (catalog ? catalog.motions.filter((m) => m.kind === kind) : []);

  // ---- 評価 ---------------------------------------------------------------------
  function trackValue(keys, prop, u, defEase) {
    const pts = keys.filter((k) => prop in k);
    if (!pts.length) return IDENTITY[prop];
    if (u <= pts[0].t) return pts[0][prop];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (u <= b.t) {
        const span = b.t - a.t;
        const f = span <= 0 ? 1 : ease((u - a.t) / span, a.ease || defEase);
        return a[prop] + (b[prop] - a[prop]) * f;
      }
    }
    return pts[pts.length - 1][prop];
  }

  function evalKeys(m, u) {
    const out = {};
    for (const k of m.keys) for (const p of Object.keys(k)) if (p in IDENTITY && !(p in out)) out[p] = trackValue(m.keys, p, u, m.easing);
    return out;
  }

  // zlib.crc32 と同じ（単位ごとの決まった乱数を exe とそろえる）
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(s) {
    const b = new TextEncoder().encode(s);
    let c = 0xffffffff;
    for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const unitRandom = (id, idx, salt) => crc32(`${id}:${idx}:${salt}`) / 0xffffffff * 2 - 1;

  function orderRanks(order, n, id) {
    if (n <= 0) return [];
    const r = [...Array(n).keys()];
    if (order === 'reverse') return r.map((i) => n - 1 - i);
    if (order === 'center') {
      const mid = (n - 1) / 2;
      return r.map((i) => (n % 2 ? Math.ceil(Math.abs(i - mid) - 1e-9) : Math.trunc(Math.abs(i - mid))));
    }
    if (order === 'random') {
      const idx = r.slice().sort((a, b) => unitRandom(id, a, 99) - unitRandom(id, b, 99));
      const ranks = new Array(n).fill(0);
      idx.forEach((i, k) => { ranks[i] = k; });
      return ranks;
    }
    return r;
  }

  class Slot {
    constructor(kind, m, dur, stagger, n, ranks) { Object.assign(this, { kind, m, dur, stagger, n, ranks, start: 0, end: 0 }); }
    get total() { return this.dur + this.stagger * Math.max(0, ...this.ranks, 0); }
    state(t, idx) {
      const m = this.m;
      const r = this.ranks[idx] || 0;
      if (this.kind === 'emph') {
        if (m.mode === 'span') return evalKeys(m, (t - this.start) / Math.max(1e-6, this.end - this.start));
        if (t < this.start || t >= this.end) return {};
        let u;
        if (m.mode === 'loop') {
          const local = t - this.start - r * this.stagger;
          if (local < 0) return {};
          u = (local % this.dur) / this.dur;
        } else {
          u = (t - this.start - m.delay - r * this.stagger) / this.dur;
          if (u <= 0 || u >= 1) return {};
        }
        const st = evalKeys(m, u);
        const fade = Math.min(1, Math.max(0, (this.end - t) / EASE_OUT_FADE));
        if (fade < 1) for (const p of Object.keys(st)) st[p] = IDENTITY[p] + (st[p] - IDENTITY[p]) * fade;
        return st;
      }
      return evalKeys(m, (t - this.start - r * this.stagger) / this.dur);
    }
  }

  function finestUnit(cm) {
    if (!cm) return 'whole';
    let best = 'whole';
    for (const kind of Object.keys(KINDS)) {
      const ent = cm[kind];
      const m = ent && get(ent.id);
      if (m && UNIT_RANK[m.unit] > UNIT_RANK[best]) best = m.unit;
    }
    return best;
  }

  /** 時間割り。counts = {whole: 1, line: 行数, char: 文字数}。登場＋退場がクリップより長い時は同じ割合で縮める */
  function makePlan(cm, clipDur, counts) {
    if (!cm) return null;
    const slots = {};
    for (const kind of Object.keys(KINDS)) {
      const ent = cm[kind];
      if (!ent) continue;
      const m = get(ent.id || '');
      if (!m || m.kind !== kind) continue;
      const dur = Number(ent.dur) || m.duration;
      const stagger = m.stagger * dur / m.duration;
      const n = Math.max(1, counts[m.unit] || 1);
      slots[kind] = new Slot(kind, m, Math.max(0.02, dur), stagger, n, orderRanks(m.order, n, m.id));
    }
    if (!Object.keys(slots).length) return null;
    let tin = slots.in ? slots.in.total : 0, tout = slots.out ? slots.out.total : 0;
    if (tin + tout > clipDur && clipDur > 0) {
      const f = clipDur / (tin + tout);
      for (const k of ['in', 'out']) if (slots[k]) { slots[k].dur *= f; slots[k].stagger *= f; }
      tin *= f; tout *= f;
    }
    if (slots.in) { slots.in.start = 0; slots.in.end = tin; }
    if (slots.out) { slots.out.start = clipDur - tout; slots.out.end = clipDur; }
    if (slots.emph) { slots.emph.start = tin; slots.emph.end = Math.max(tin, clipDur - tout); }
    const list = Object.keys(KINDS).filter((k) => slots[k]).map((k) => slots[k]);
    const unit = list.reduce((u, s) => (UNIT_RANK[s.m.unit] > UNIT_RANK[u] ? s.m.unit : u), 'whole');
    return { slots: list, unit, clipDur };
  }

  function describe(cm) {
    if (!cm) return '';
    return Object.entries(KINDS).filter(([k]) => cm[k]).map(([k, label]) => {
      const m = get(cm[k].id);
      return `${label}: ${m ? m.name : cm[k].id + '（見つかりません）'}${cm[k].dur ? ' ' + cm[k].dur + ' 秒' : ''}`;
    }).join('／');
  }

  // ---- 行列 ---------------------------------------------------------------------
  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];

  /** モーションの値 → 単位の絵を動かす行列（pivot を中心に拡大・回転してから移動） */
  function affine(st, pivot, sizePx, W, H, id, idx) {
    const sx = (st.scale ?? 1) * (st.scale_x ?? 1);
    const sy = (st.scale ?? 1) * (st.scale_y ?? 1);
    const rot = (st.rotation || 0) + (st.rr || 0) * unitRandom(id, idx, 2);
    const dx = ((st.x || 0) + (st.rx || 0) * unitRandom(id, idx, 0)) * sizePx + (st.sx || 0) * W;
    const dy = ((st.y || 0) + (st.ry || 0) * unitRandom(id, idx, 1)) * sizePx + (st.sy || 0) * H;
    const a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const m00 = c * sx, m01 = -s * sy, m10 = s * sx, m11 = c * sy;
    const [px, py] = pivot;
    return [m00, m10, m01, m11, px + dx - (m00 * px + m01 * py), py + dy - (m10 * px + m11 * py)];
  }

  /** 単位の t 秒での見た目。geo = {whole: [pivot, rect], lines: [[pivot, rect]], sizePx, W, H} */
  function unitState(plan, t, geo, { line = 0, char = 0, pivot = null, rect = null, box = false } = {}) {
    const us = { M: [1, 0, 0, 1, 0, 0], opacity: 1, blur: 0, tint: 0, tintColor: null, wipes: [] };
    for (const s of plan.slots) {
      const unit = s.m.unit;
      if (box && unit !== 'whole') {
        let mx = 0;
        for (let i = 0; i < s.n; i++) { const st = s.state(t, i); mx = Math.max(mx, st.opacity ?? 1); }
        us.opacity *= mx;
        continue;
      }
      let idx, pv, rc;
      if (unit === 'whole') { idx = 0; [pv, rc] = geo.whole; }
      else if (unit === 'line') { idx = line; [pv, rc] = geo.lines[line]; }
      else { idx = char || 0; pv = pivot; rc = rect; }
      const st = s.state(t, idx);
      if (!Object.keys(st).length) continue;
      us.M = mul(affine(st, pv, geo.sizePx, geo.W, geo.H, s.m.id, idx), us.M);
      us.opacity *= st.opacity ?? 1;
      us.blur += st.blur || 0;
      if ((st.tint || 0) > us.tint) { us.tint = st.tint; us.tintColor = s.m.tint_color; }
      if ((st.wipe ?? 1) < 1) us.wipes.push([rc, st.wipe, s.m.wipe_dir]);
    }
    return us;
  }

  return { KINDS, UNITS, IDENTITY, ease, load, get, ofKind, finestUnit, makePlan, describe, unitState, affine, mul, unitRandom, orderRanks, evalKeys, get catalog() { return catalog; } };
})();

if (typeof module !== 'undefined') module.exports = Motion;
