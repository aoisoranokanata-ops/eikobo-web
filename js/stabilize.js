/* ------------------------------------------------------------
   手ぶれ補正（動きの解析。AI のモデルは使わない。Premiere のワープスタビライザーと同じ考え方）

   1. 素材を 320 画素幅の白黒にして 1 コマずつ読み、角になる点（Shi-Tomasi）を区画ごとに選び、
      次のコマでの位置をピラミッド式の Lucas-Kanade で追う。
   2. 点の動きから画面全体の動き（ずれ・回転・拡大の相似変換）を RANSAC で求める（動いている物に引っ張られない）。
   3. 動きを積み上げた道筋をガウスでなめらかにし、「なめらかな道筋 − 実際の道筋」だけ各コマを動かす。
      端が見えないよう少し拡大する（自動は補正量から求め、最大 1.5 倍）。
   解析の結果は IndexedDB の stab（素材ごと、素材のコマ番号で）。クリップは clip.stab = {on, strength（秒）, zoom（null で自動）}。
   ------------------------------------------------------------ */
const Stabilize = (() => {
  const AW = 320;
  const data = new Map();          // 素材 ID → 解析の結果（読み込み済み）
  const loading = new Map();
  const corrCache = new Map();
  let onLoaded = null;

  // ---- 画像の小物 ------------------------------------------------------------------
  function gray(g, w, h) {
    const d = g.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    return out;
  }

  function down(img, w, h) {
    const W = w >> 1, H = h >> 1, out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * W + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
    }
    return { img: out, w: W, h: H };
  }

  function pyramid(img, w, h, levels = 3) {
    const out = [{ img, w, h }];
    for (let l = 1; l < levels; l++) { const p = out[l - 1]; out.push(down(p.img, p.w, p.h)); }
    return out;
  }

  function sample(img, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
    if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
  }

  /** 角になる点（区画ごとに一番強いもの） */
  function corners(img, w, h, gx = 10, gy = 7) {
    const R = 3, B = 10;
    const pts = [];
    const cw = (w - 2 * B) / gx, ch = (h - 2 * B) / gy;
    let best = 0;
    const cand = [];
    for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
      let top = null;
      for (let y = Math.floor(B + cy * ch); y < B + (cy + 1) * ch; y += 2) for (let x = Math.floor(B + cx * cw); x < B + (cx + 1) * cw; x += 2) {
        let a = 0, b = 0, c = 0;
        for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
          const i = (y + v) * w + x + u;
          const ix = (img[i + 1] - img[i - 1]) / 2, iy = (img[i + w] - img[i - w]) / 2;
          a += ix * ix; b += ix * iy; c += iy * iy;
        }
        const e = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
        if (!top || e > top[2]) top = [x, y, e];
      }
      if (top) { cand.push(top); best = Math.max(best, top[2]); }
    }
    for (const t of cand) if (t[2] > best * 0.02 && t[2] > 50) pts.push([t[0], t[1]]);
    return pts;
  }

  /** ピラミッド式 Lucas-Kanade: prev の点 → cur での位置（見失ったら null） */
  function track(P, C, pt) {
    const R = 6;
    let gx = 0, gy = 0;
    for (let L = P.length - 1; L >= 0; L--) {
      const { img: A, w, h } = P[L];
      const B = C[L].img;
      const s = 2 ** L;
      const px = pt[0] / s, py = pt[1] / s;
      // 窓の中の prev の値と勾配
      const n = (2 * R + 1) ** 2;
      const va = new Float32Array(n), vx = new Float32Array(n), vy = new Float32Array(n);
      let a = 0, b = 0, c = 0, k = 0;
      for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++, k++) {
        const x = px + u, y = py + v;
        va[k] = sample(A, w, h, x, y);
        vx[k] = (sample(A, w, h, x + 1, y) - sample(A, w, h, x - 1, y)) / 2;
        vy[k] = (sample(A, w, h, x, y + 1) - sample(A, w, h, x, y - 1)) / 2;
        a += vx[k] * vx[k]; b += vx[k] * vy[k]; c += vy[k] * vy[k];
      }
      const det = a * c - b * b;
      if (det < 1e-3) return null;
      let dx = 0, dy = 0;
      for (let it = 0; it < 12; it++) {
        let ex = 0, ey = 0;
        k = 0;
        for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++, k++) {
          const diff = va[k] - sample(B, w, h, px + gx + dx + u, py + gy + dy + v);
          ex += diff * vx[k]; ey += diff * vy[k];
        }
        const sx = (c * ex - b * ey) / det, sy = (a * ey - b * ex) / det;
        dx += sx; dy += sy;
        if (sx * sx + sy * sy < 0.0004) break;
      }
      gx = (gx + dx) * (L ? 2 : 1); gy = (gy + dy) * (L ? 2 : 1);
    }
    const x = pt[0] + gx, y = pt[1] + gy;
    const { w, h } = P[0];
    if (x < 2 || y < 2 || x > w - 3 || y > h - 3) return null;
    return [x, y];
  }

  /** 相似変換（中心を原点にした座標）: x' = a x − b y + tx, y' = b x + a y + ty を最小二乗で */
  function fitSim(pairs) {
    let n = 0, sx = 0, sy = 0, sX = 0, sY = 0;
    for (const [p, q] of pairs) { n++; sx += p[0]; sy += p[1]; sX += q[0]; sY += q[1]; }
    const mx = sx / n, my = sy / n, mX = sX / n, mY = sY / n;
    let num1 = 0, num2 = 0, den = 0;
    for (const [p, q] of pairs) {
      const x = p[0] - mx, y = p[1] - my, X = q[0] - mX, Y = q[1] - mY;
      num1 += x * X + y * Y; num2 += x * Y - y * X; den += x * x + y * y;
    }
    if (den < 1e-9) return { a: 1, b: 0, tx: mX - mx, ty: mY - my };
    const a = num1 / den, b = num2 / den;
    return { a, b, tx: mX - (a * mx - b * my), ty: mY - (b * mx + a * my) };
  }

  function ransac(pairs, thr = 1.5) {
    if (pairs.length < 4) return null;
    let best = null, bestIn = [];
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let it = 0; it < 120; it++) {
      const i = rnd(pairs.length), j = rnd(pairs.length);
      if (i === j) continue;
      const m = fitSim([pairs[i], pairs[j]]);
      const inl = pairs.filter(([p, q]) => Math.hypot(m.a * p[0] - m.b * p[1] + m.tx - q[0], m.b * p[0] + m.a * p[1] + m.ty - q[1]) < thr);
      if (inl.length > bestIn.length) { bestIn = inl; best = m; }
    }
    if (bestIn.length < Math.max(4, pairs.length * 0.3)) return null;
    return fitSim(bestIn);
  }

  // ---- 解析 --------------------------------------------------------------------------
  /**
   * 素材の start〜end 秒を解析して保存する。onProgress(0〜1)、cancelled() で止める。返り値は解析の結果
   */
  async function analyze(mediaId, rec, startSec, endSec, onProgress, cancelled) {
    const r = await Decode.reader(mediaId, rec);
    if (!r) throw new Error('素材を読めません');
    const fps = rec.fps || 30;
    const i0 = Math.max(0, Math.floor(startSec * fps)), i1 = Math.max(i0 + 2, Math.ceil(endSec * fps));
    const n = i1 - i0;
    const dx = new Float32Array(n), dy = new Float32Array(n), da = new Float32Array(n), ds = new Float32Array(n);
    let c = null, g = null, aw = 0, ah = 0, sw = 0, sh = 0, prev = null;
    try {
      for (let i = 0; i < n; i++) {
        if (cancelled && cancelled()) throw new Error('cancel');
        const f = await r.frameAt((i0 + i) / fps + 0.5 / fps);
        if (!f) break;
        const side = f.rot === 90 || f.rot === 270;
        if (!c) {
          // 見えている向きで解析する（プレビューの video と書き出しの読み手で回転の扱いが違うため）
          sw = side ? f.h : f.w; sh = side ? f.w : f.h; aw = AW; ah = Math.max(16, Math.round(AW * sh / sw));
          c = document.createElement('canvas'); c.width = aw; c.height = ah;
          g = c.getContext('2d', { willReadFrequently: true });
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        if (f.rot) {
          g.translate(aw / 2, ah / 2); g.rotate(f.rot * Math.PI / 180);
          const [rw, rh] = side ? [ah, aw] : [aw, ah];
          g.drawImage(f.img, -rw / 2, -rh / 2, rw, rh);
        } else g.drawImage(f.img, 0, 0, aw, ah);
        const cur = pyramid(gray(g, aw, ah), aw, ah);
        if (prev) {
          const pts = corners(prev[0].img, aw, ah);
          const pairs = [];
          for (const p of pts) {
            const q = track(prev, cur, p);
            if (q) pairs.push([[p[0] - aw / 2, p[1] - ah / 2], [q[0] - aw / 2, q[1] - ah / 2]]);
          }
          const m = ransac(pairs);
          if (m) {
            const k = sw / aw;
            dx[i] = m.tx * k; dy[i] = m.ty * k; da[i] = Math.atan2(m.b, m.a); ds[i] = Math.log(Math.hypot(m.a, m.b));
          }
        }
        prev = cur;
        if (onProgress && i % 5 === 0) onProgress(i / n);
      }
    } finally { r.close(); }
    const res = { id: mediaId, fps, w: sw, h: sh, start: i0, n, dx, dy, da, ds, created: Date.now() };
    await Store.put('stab', res);
    data.set(mediaId, res);
    for (const k of [...corrCache.keys()]) if (k.startsWith(mediaId + '|')) corrCache.delete(k);
    return res;
  }

  /** 読み込み済みの解析の結果（無ければ読み始めて null） */
  function get(mediaId) {
    if (data.has(mediaId)) return data.get(mediaId);
    if (!loading.has(mediaId)) {
      loading.set(mediaId, Store.get('stab', mediaId).then((r) => {
        if (r) { data.set(mediaId, r); if (onLoaded) onLoaded(mediaId); }
        return r || null;
      }).catch(() => null));
    }
    return null;
  }

  async function load(mediaId) { get(mediaId); return loading.get(mediaId) || data.get(mediaId); }

  /** 解析がクリップの範囲を覆っているか */
  function covers(res, c, fps) {
    if (!res) return false;
    const a = Math.floor(c.src_in * res.fps), b = Math.ceil((c.src_in + c.duration / fps * c.speed) * res.fps);
    return a >= res.start && b <= res.start + res.n + 1;
  }

  /** なめらかさ strength（秒）での補正量（コマごと）と自動の拡大 */
  function corrections(res, strength) {
    const key = res.id + '|' + strength + '|' + res.start + '|' + res.n + '|' + res.created;
    if (corrCache.has(key)) return corrCache.get(key);
    const n = res.n;
    const cum = (arr) => { const o = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { s += arr[i]; o[i] = s; } return o; };
    const X = cum(res.dx), Y = cum(res.dy), A = cum(res.da), S = cum(res.ds);
    const sigma = Math.max(1, strength * res.fps / 2);
    const rad = Math.ceil(sigma * 3);
    const wts = []; for (let k = -rad; k <= rad; k++) wts.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    const smooth = (arr) => {
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0, ws = 0;
        for (let k = -rad; k <= rad; k++) {
          let j = i + k;
          if (j < 0) j = -j; if (j >= n) j = 2 * (n - 1) - j;     // 端は折り返す
          j = Math.min(n - 1, Math.max(0, j));
          s += arr[j] * wts[k + rad]; ws += wts[k + rad];
        }
        o[i] = s / ws;
      }
      return o;
    };
    const sX = smooth(X), sY = smooth(Y), sA = smooth(A), sS = smooth(S);
    const cx = new Float32Array(n), cy = new Float32Array(n), ca = new Float32Array(n), cs = new Float32Array(n);
    const need = [];
    for (let i = 0; i < n; i++) {
      cx[i] = sX[i] - X[i]; cy[i] = sY[i] - Y[i]; ca[i] = sA[i] - A[i]; cs[i] = sS[i] - S[i];
      // この補正で端が見えないための拡大（回転した四角が画面を覆う大きさ＋ずれ、縮める分も）
      const co = Math.abs(Math.cos(ca[i])), si = Math.abs(Math.sin(ca[i]));
      const zx = co + si * res.h / res.w + 2 * Math.abs(cx[i]) / res.w;
      const zy = co + si * res.w / res.h + 2 * Math.abs(cy[i]) / res.h;
      need.push(Math.max(zx, zy) / Math.exp(Math.min(0, cs[i])));
    }
    const auto = Math.min(1.5, need.reduce((a, b) => Math.max(a, b), 1));
    const out = { cx, cy, ca, cs, auto };
    corrCache.set(key, out);
    return out;
  }

  /**
   * クリップの素材の時刻 t（秒）での補正。{x, y（素材の画素）, a（ラジアン）, s（倍率）, zoom, w, h}。無ければ null
   */
  function at(c, t) {
    if (!c.stab || !c.stab.on || !c.media) return null;
    const res = get(c.media);
    if (!res) return null;
    const co = corrections(res, Number(c.stab.strength) || 1);
    const i = Math.min(res.n - 1, Math.max(0, Math.round(t * res.fps) - res.start));
    const zoom = c.stab.zoom ? Number(c.stab.zoom) : co.auto;
    return { x: co.cx[i], y: co.cy[i], a: co.ca[i], s: Math.exp(co.cs[i]), zoom, w: res.w, h: res.h, auto: co.auto };
  }

  /** 作品の手ぶれ補正のある素材の解析を全部読んでおく（書き出しの前） */
  async function prepare(p) {
    const ids = new Set(Object.values(p.clips).filter((c) => c.stab && c.stab.on && c.media).map((c) => c.media));
    for (const id of ids) await load(id);
  }

  return { analyze, get, load, covers, corrections, at, prepare, set onLoaded(fn) { onLoaded = fn; }, _internal: { corners, track, ransac, fitSim, pyramid } };
})();
