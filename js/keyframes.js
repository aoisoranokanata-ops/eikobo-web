/* ------------------------------------------------------------
   キーフレーム（exe の core/keyframes.py の移植）
   clip.keys = {属性: [[クリップ先頭からのフレーム, 値, 補間], ...]}（フレーム順）
   補間（次のキーへの動き方）: linear / ease / ease_in / ease_out / hold
   最初のキーより前は最初の値、最後より後は最後の値。キーが無い属性はクリップの値（clip.opacity など）。
   音量（volume_db）は音声側で dB のまま直線で結ぶ（exe の audio.py と同じ、補間の種類は見ない）。
   ------------------------------------------------------------ */
const Keys = (() => {
  const ANIMATABLE = ['opacity', 'pos_x', 'pos_y', 'scale', 'rotation', 'volume_db'];
  const EASINGS = [['linear', '一定'], ['ease', 'ゆっくり始まりゆっくり止まる'], ['ease_in', 'ゆっくり始まる'], ['ease_out', 'ゆっくり止まる'], ['hold', '次のキーまで止める']];

  function ease(t, kind) {
    if (kind === 'hold') return 0;
    if (kind === 'ease') return t * t * (3 - 2 * t);
    if (kind === 'ease_in') return t * t;
    if (kind === 'ease_out') return 1 - (1 - t) * (1 - t);
    return t;
  }

  const has = (c, prop) => !!(c.keys && c.keys[prop] && c.keys[prop].length);

  /** タイムラインの frame での値 */
  function valueAt(c, prop, frame) {
    const keys = c.keys && c.keys[prop];
    if (!keys || !keys.length) return c[prop];
    const off = frame - c.start;
    if (off <= keys[0][0]) return Number(keys[0][1]);
    if (off >= keys[keys.length - 1][0]) return Number(keys[keys.length - 1][1]);
    for (let i = 0; i + 1 < keys.length; i++) {
      const [f0, v0, e0] = keys[i], [f1, v1] = keys[i + 1];
      if (f0 <= off && off < f1) return Number(v0) + (Number(v1) - Number(v0)) * ease((off - f0) / Math.max(1e-9, f1 - f0), e0);
    }
    return Number(keys[keys.length - 1][1]);
  }

  /** 見た目の値（キーフレームを反映） */
  function transform(c, frame) {
    return { opacity: valueAt(c, 'opacity', frame), pos_x: valueAt(c, 'pos_x', frame), pos_y: valueAt(c, 'pos_y', frame), scale: valueAt(c, 'scale', frame), rotation: valueAt(c, 'rotation', frame) };
  }

  function setKey(c, prop, offset, value, easing) {
    const keys = { ...(c.keys || {}) };
    const lst = (keys[prop] || []).map((k) => k.slice());
    const hit = lst.find((k) => k[0] === offset);
    if (hit) { hit[1] = Number(value); if (easing) hit[2] = easing; }
    else lst.push([Math.round(offset), Number(value), easing || 'linear']);
    lst.sort((a, b) => a[0] - b[0]);
    keys[prop] = lst;
    c.keys = keys;
  }

  /** キーを 1 つ消す。最後の 1 つを消したら、その値をクリップの値として残す */
  function removeKey(c, prop, offset) {
    if (!has(c, prop)) return false;
    const lst = c.keys[prop].filter((k) => k[0] !== offset).map((k) => k.slice());
    if (lst.length === c.keys[prop].length) return false;
    const keys = { ...c.keys };
    if (lst.length) keys[prop] = lst;
    else { c[prop] = Number(c.keys[prop][0][1]); delete keys[prop]; }
    c.keys = Object.keys(keys).length ? keys : null;
    return true;
  }

  /** キーを全部消す（prop 省略で全部）。frame を渡すとその時点の値をクリップの値として残す */
  function clearKeys(c, prop, frame) {
    if (!c.keys) return;
    const props = prop ? [prop] : Object.keys(c.keys);
    const keys = { ...c.keys };
    for (const p of props) {
      if (!(p in keys)) continue;
      if (frame !== undefined && frame !== null) c[p] = valueAt(c, p, frame);
      delete keys[p];
    }
    c.keys = Object.keys(keys).length ? keys : null;
  }

  /** クリップの中身が delta フレーム前へずれた（先頭を削った）時。範囲外のキーは一番近い 1 つずつ残す */
  function shift(c, delta) {
    if (!c.keys || !delta) return;
    const keys = {};
    for (const [p, lst] of Object.entries(c.keys)) {
      const moved = lst.map((k) => [k[0] - delta].concat(k.slice(1)));
      const before = moved.filter((k) => k[0] < 0);
      const after = moved.filter((k) => k[0] > c.duration);
      const inside = moved.filter((k) => k[0] >= 0 && k[0] <= c.duration);
      const keep = (before.length ? [before[before.length - 1]] : []).concat(inside, after.length ? [after[0]] : []);
      if (keep.length) keys[p] = keep;
    }
    c.keys = Object.keys(keys).length ? keys : null;
  }

  function offsets(c) {
    if (!c.keys) return [];
    return [...new Set(Object.values(c.keys).flatMap((l) => l.map((k) => Math.round(k[0]))))].sort((a, b) => a - b);
  }

  const at = (c, prop, offset) => (has(c, prop) ? c.keys[prop].find((k) => k[0] === offset) || null : null);

  /** 音量のキー → dB の直線補間（exe の np.interp と同じ。補間の種類は見ない） */
  function volumeDbAt(c, offset) {
    const keys = c.keys && c.keys.volume_db;
    if (!keys || !keys.length) return c.volume_db || 0;
    if (offset <= keys[0][0]) return Number(keys[0][1]);
    for (let i = 0; i + 1 < keys.length; i++) {
      const [f0, v0] = keys[i], [f1, v1] = keys[i + 1];
      if (offset <= f1) return Number(v0) + (Number(v1) - Number(v0)) * (offset - f0) / Math.max(1e-9, f1 - f0);
    }
    return Number(keys[keys.length - 1][1]);
  }

  return { ANIMATABLE, EASINGS, ease, has, valueAt, transform, setKey, removeKey, clearKeys, shift, offsets, at, volumeDbAt };
})();

if (typeof module !== 'undefined') module.exports = Keys;
