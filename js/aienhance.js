/* ------------------------------------------------------------
   AI 高画質化（超解像）・AI ノイズ除去（書き出しで使う）

   - モデル: Real-ESRGAN の小さい版（SRVGGNetCompact、BSD-3-Clause、xinntao/Real-ESRGAN の公式の重み）を
     tools/esrgan_to_onnx.py で ONNX にしたもの（models/）。4 倍に拡大しながら、ぼけ・ノイズ・圧縮の荒れを取る。
       general = realesr-general-x4v3（ノイズ除去 強め）/ light = general と wdn を半分ずつ（細部を残す）/
       anime = realesr-animevideov3（アニメ・イラスト）
   - 実行: onnxruntime-web 1.30.0（MIT、vendor/ort/）の WebGPU。GPU が半精度（shader-f16）に対応していれば *_fp16.onnx。
   - 1 コマを 640 画素四方の区切り（重ねしろ 12 画素）で回し、4 倍の絵を組み立てて返す。
     iPad の canvas は約 1600 万画素までなので、素材は 1280×720 以下に限る。
   ------------------------------------------------------------ */
const AiEnhance = (() => {
  const MODELS = {
    general: ['general_x4', '実写（ノイズ除去 強め）'],
    light: ['general_light_x4', '実写（細部を残す）'],
    anime: ['anime_x4', 'アニメ・イラスト'],
  };
  const MAX_PIXELS = 1280 * 720;
  const TILE = 640, PAD = 12, SCALE = 4;     // 640×480 は 1 回で（区切るより少し速い）
  let ortP = null, gpuInfo = null, sess = null, sessKey = '';

  function loadOrt() {
    if (ortP) return ortP;
    ortP = new Promise((resolve, reject) => {
      if (window.ort) { resolve(window.ort); return; }
      const s = document.createElement('script');
      s.src = 'vendor/ort/ort.webgpu.min.js';
      s.onload = () => {
        ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
        ort.env.wasm.numThreads = 1;            // GitHub Pages は SharedArrayBuffer が使えない
        resolve(ort);
      };
      s.onerror = () => { ortP = null; reject(new Error('AI の部品を読み込めませんでした（通信を確かめてください）')); };
      document.head.append(s);
    });
    return ortP;
  }

  /** {webgpu, f16, name}。WebGPU が無ければ webgpu: false（AI 高画質化は使えない） */
  async function support() {
    if (gpuInfo) return gpuInfo;
    gpuInfo = { webgpu: false, f16: false, name: '' };
    try {
      if (navigator.gpu) {
        const ad = await navigator.gpu.requestAdapter();
        if (ad) {
          gpuInfo.webgpu = true;
          gpuInfo.f16 = ad.features.has('shader-f16');
          gpuInfo.name = ad.info ? (ad.info.description || ad.info.vendor || '') : '';
        }
      }
    } catch { /* 使えない */ }
    return gpuInfo;
  }

  const fits = (w, h) => w * h <= MAX_PIXELS;

  async function session(kind) {
    const key = kind;
    if (sess && sessKey === key) return sess;
    await release();
    const o = await loadOrt();
    const g = await support();
    if (!g.webgpu) throw new Error('この端末のブラウザは WebGPU に対応していないので、AI 高画質化は使えません');
    const file = `models/${MODELS[kind][0]}${g.f16 ? '_fp16' : ''}.onnx`;
    sess = await o.InferenceSession.create(file, { executionProviders: ['webgpu'] });
    sessKey = key;
    return sess;
  }

  async function release() {
    if (sess) { try { await sess.release(); } catch { /* 済み */ } }
    sess = null; sessKey = '';
  }

  let srcCanvas = null, outCanvas = null, tileCanvas = null;
  const canvasOf = (c, w, h) => { if (!c) c = document.createElement('canvas'); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c; };

  /**
   * 絵 src（w×h、回転前）を 4 倍にして返す。kind = general / light / anime。
   * dest（canvas）を渡すとそこへ描く。省略すると共有の canvas（すぐ描くこと）
   */
  async function enhance(src, w, h, kind, dest) {
    const o = await loadOrt();
    const s = await session(kind);
    w = Math.round(w); h = Math.round(h);
    srcCanvas = canvasOf(srcCanvas, w, h);
    const sg = srcCanvas.getContext('2d', { willReadFrequently: true });
    sg.clearRect(0, 0, w, h);
    sg.drawImage(src, 0, 0, w, h);
    const px = sg.getImageData(0, 0, w, h).data;
    const oc = dest ? canvasOf(dest, w * SCALE, h * SCALE) : (outCanvas = canvasOf(outCanvas, w * SCALE, h * SCALE));
    const og = oc.getContext('2d');
    const t0 = performance.now();
    for (let y0 = 0; y0 < h; y0 += TILE) {
      for (let x0 = 0; x0 < w; x0 += TILE) {
        const x1 = Math.min(w, x0 + TILE), y1 = Math.min(h, y0 + TILE);
        const ax = Math.max(0, x0 - PAD), ay = Math.max(0, y0 - PAD);
        const bx = Math.min(w, x1 + PAD), by = Math.min(h, y1 + PAD);
        const tw = bx - ax, th = by - ay;
        const input = new Float32Array(3 * tw * th);
        const plane = tw * th;
        for (let y = 0; y < th; y++) {
          let p = ((ay + y) * w + ax) * 4, q = y * tw;
          for (let x = 0; x < tw; x++, p += 4, q++) {
            input[q] = px[p] / 255; input[plane + q] = px[p + 1] / 255; input[2 * plane + q] = px[p + 2] / 255;
          }
        }
        const r = await s.run({ input: new o.Tensor('float32', input, [1, 3, th, tw]) });
        const out = await r.output.getData();
        if (r.output.dispose) r.output.dispose();
        // 重ねしろを除いた所だけ絵にする
        const cw = (x1 - x0) * SCALE, chh = (y1 - y0) * SCALE;
        const ox = (x0 - ax) * SCALE, oy = (y0 - ay) * SCALE;
        const TW = tw * SCALE, OP = TW * th * SCALE;
        const img = new ImageData(cw, chh);
        const d = img.data;
        for (let y = 0; y < chh; y++) {
          let q = (oy + y) * TW + ox, p = y * cw * 4;
          for (let x = 0; x < cw; x++, q++, p += 4) {
            d[p] = out[q] * 255; d[p + 1] = out[OP + q] * 255; d[p + 2] = out[2 * OP + q] * 255; d[p + 3] = 255;   // Uint8Clamped が丸める
          }
        }
        og.putImageData(img, x0 * SCALE, y0 * SCALE);
      }
    }
    learn(w * h, (performance.now() - t0) / 1000);
    return oc;
  }

  /** 書き出しの見積もり: 素材の画素数 × 1 画素あたりの秒（最初に測った値。無ければ目安） */
  let secPerPixel = null;
  const estimate = (pixels, kind) => pixels * (secPerPixel || (kind === 'anime' ? 1.0e-6 : 1.8e-6));
  const learn = (pixels, sec) => { const v = sec / Math.max(1, pixels); secPerPixel = secPerPixel ? secPerPixel * 0.8 + v * 0.2 : v; };

  return { MODELS, MAX_PIXELS, SCALE, support, fits, session, release, enhance, estimate, learn, loadOrt };
})();
