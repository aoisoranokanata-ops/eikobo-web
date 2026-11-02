/* ------------------------------------------------------------
   色調補正（exe の core/color.py と同じ項目・同じ式）。WebGL2 で毎フレーム計算する。

   順番: トーン（露光量・コントラスト・ガンマ・シャドウ・ハイライト。256 段の表）→ 彩度（HSV の S）
         → ホワイトバランス（色温度・色かぶり）→ 3D LUT（.cube、強さで混ぜる）
   clip.grade = {exposure, contrast, gamma, shadows, highlights, saturation, temperature, tint, lut, lut_mix}
   lut: "builtin:teal_orange"（組み込み）/ "user:<ID>"（読み込んだ .cube、IndexedDB の luts）。
   apply(source, w, h, grade) は補正した絵の canvas を返す（共有の 1 枚。すぐ drawImage すること）。
   ------------------------------------------------------------ */
const Grade = (() => {
  const PARAMS = {
    exposure: [0, -3, 3, '露光量（段）', 0.05],
    contrast: [0, -100, 100, 'コントラスト', 1],
    gamma: [1, 0.2, 5, 'ガンマ', 0.01],
    shadows: [0, -100, 100, 'シャドウ', 1],
    highlights: [0, -100, 100, 'ハイライト', 1],
    saturation: [1, 0, 3, '彩度（倍）', 0.01],
    temperature: [0, -100, 100, '色温度', 1],
    tint: [0, -100, 100, '色かぶり（緑↔マゼンタ）', 1],
    lut_mix: [1, 0, 1, 'LUT の強さ', 0.01],
  };
  const LOOKS = {
    '白黒': { saturation: 0, contrast: 10 },
    'セピア': { saturation: 0, temperature: 70, contrast: 5 },
    '暖かい': { temperature: 35 },
    '冷たい': { temperature: -35 },
    'ビビッド': { saturation: 1.35, contrast: 15 },
    'フィルム調': { contrast: -10, saturation: 0.85, shadows: 15, temperature: 8 },
    '明るく': { exposure: 0.5, shadows: 20 },
    'シネマ（ティール＆オレンジ）': { contrast: 12, saturation: 0.9, lut: 'builtin:teal_orange' },
  };
  const BUILTIN = { 'builtin:teal_orange': 'ティール＆オレンジ（組み込み）' };

  function isIdentity(g) {
    if (!g) return true;
    for (const [k, [d]] of Object.entries(PARAMS)) {
      if (k === 'lut_mix') continue;
      if (Math.abs(Number(g[k] ?? d) - d) > 1e-6) return false;
    }
    return !g.lut;
  }

  /** トーンの 256 段の表（exe の _tone_table と同じ式） */
  function toneTable(g) {
    const out = new Uint8Array(256);
    const ex = 2 ** Number(g.exposure || 0);
    const c = Number(g.contrast || 0) / 100;
    const k = c > 0 ? 1 + c : 1 + c * 0.7;
    const gm = Number(g.gamma ?? 1);
    const sh = Number(g.shadows || 0) / 100;
    const hl = Number(g.highlights || 0) / 100;
    for (let i = 0; i < 256; i++) {
      let v = i / 255 * ex;
      if (c) v = (v - 0.5) * k + 0.5;
      v = Math.min(1, Math.max(0, v));
      if (Math.abs(gm - 1) > 1e-6) v = v ** (1 / gm);
      if (sh) v = v + sh * 0.35 * (1 - v) ** 2 * v ** 0.5 * 2;
      if (hl) v = v + hl * 0.35 * v ** 2 * (1 - v) ** 0.5 * 2;
      out[i] = Math.min(255, Math.max(0, Math.floor(v * 255 + 0.5)));
    }
    return out;
  }

  function wbFactors(g) {
    const t = Number(g.temperature || 0) / 100, ti = Number(g.tint || 0) / 100;
    return [(1 + 0.18 * t) * (1 + 0.04 * ti), 1 - 0.12 * ti, (1 - 0.18 * t) * (1 + 0.04 * ti)];
  }

  // ---- 3D LUT -----------------------------------------------------------------------
  /** .cube → {size, data: Float32Array（R が一番速く変わる並び、0〜1 に直した値）} */
  function parseCube(text) {
    let size = 0;
    let dmin = [0, 0, 0], dmax = [1, 1, 1];
    const rows = [];
    for (let line of String(text).split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      const head = parts[0].toUpperCase();
      if (head === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
      else if (head === 'LUT_1D_SIZE') throw new Error('1D の LUT には対応していません（3D の .cube を使ってください）');
      else if (head === 'DOMAIN_MIN') dmin = parts.slice(1, 4).map(Number);
      else if (head === 'DOMAIN_MAX') dmax = parts.slice(1, 4).map(Number);
      else if (head === 'TITLE' || head === 'LUT_IN_VIDEO_RANGE' || head === 'LUT_OUT_VIDEO_RANGE') continue;
      else {
        const v = parts.slice(0, 3).map(Number);
        if (v.length === 3 && v.every((x) => isFinite(x))) rows.push(v);
      }
    }
    if (!size) throw new Error('LUT_3D_SIZE がありません');
    if (rows.length !== size ** 3) throw new Error(`データの数が合いません（${rows.length} / ${size ** 3}）`);
    const data = new Float32Array(size ** 3 * 3);
    rows.forEach((v, i) => { for (let k = 0; k < 3; k++) data[i * 3 + k] = (v[k] - dmin[k]) / Math.max(1e-9, dmax[k] - dmin[k]); });
    return { size, data };
  }

  /** 組み込み（exe の _builtin と同じ計算、17³） */
  function builtin(name) {
    if (name !== 'teal_orange') throw new Error('組み込み LUT がありません: ' + name);
    const n = 17;
    const data = new Float32Array(n ** 3 * 3);
    let i = 0;
    for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
      const r = ri / (n - 1), g = gi / (n - 1), b = bi / (n - 1);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const w = Math.min(1, Math.max(0, (luma - 0.15) / 0.7));
      const r2 = r + (1 - w) * (0 - 0.03) + w * 0.12 * 0.8;
      const g2 = g + (1 - w) * 0.10 * 0.6 + w * 0.04 * 0.8;
      const b2 = b + (1 - w) * 0.14 * 0.8 + w * -0.10 * 0.8;
      data[i++] = Math.min(1, Math.max(0, r2)); data[i++] = Math.min(1, Math.max(0, g2)); data[i++] = Math.min(1, Math.max(0, b2));
    }
    return { size: n, data };
  }

  const cubes = new Map();       // 参照 → {size, data} | {error}
  const loading = new Map();
  let onLoaded = null;

  /** LUT を読む（読み終わったら onLoaded を呼ぶ）。今すぐ使えれば返す */
  function cube(ref) {
    if (!ref) return null;
    if (cubes.has(ref)) return cubes.get(ref);
    if (!loading.has(ref)) {
      loading.set(ref, (async () => {
        try {
          if (ref.startsWith('builtin:')) cubes.set(ref, builtin(ref.slice(8)));
          else if (ref.startsWith('user:')) {
            const rec = await Store.get('luts', ref.slice(5));
            cubes.set(ref, rec ? parseCube(rec.text) : { error: 'LUT が見つかりません' });
          } else cubes.set(ref, { error: 'この LUT はこの端末にありません（' + ref + '）' });
        } catch (err) { cubes.set(ref, { error: String(err.message || err) }); }
        if (onLoaded) onLoaded(ref);
      })());
    }
    return null;
  }

  async function importCube(file) {
    const text = await file.text();
    parseCube(text);                      // 読めるか確かめる
    const id = uid('lut');
    const name = file.name.replace(/\.cube$/i, '');
    await Store.put('luts', { id, name, file: file.name, text, created: Date.now() });
    return { ref: 'user:' + id, name };
  }

  async function userLuts() {
    try { return (await Store.all('luts')).sort((a, b) => a.created - b.created).map((r) => ({ ref: 'user:' + r.id, name: r.name })); } catch { return []; }
  }

  // ---- WebGL2 -------------------------------------------------------------------------
  let gl = null, glCanvas = null, prog = null, loc = null, texSrc = null, texTone = null;
  const texLuts = new Map();
  let failed = false;
  let copyCanvas = null;

  const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler2D tone; uniform sampler3D lut;
uniform float sat; uniform vec3 wb; uniform float lutMix; uniform float lutSize; uniform bool useLut; uniform bool useTone;
vec3 rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  float h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
  }
  return vec3(h / 6.0, mx > 1e-6 ? d / mx : 0.0, mx);
}
vec3 hsv2rgb(vec3 c) {
  vec3 k = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return c.z * mix(vec3(1.0), k, c.y);
}
void main() {
  vec4 c = texture(src, uv);
  vec3 v = c.rgb;
  if (useTone) {
    vec3 q = floor(v * 255.0 + 0.5);
    v = vec3(texture(tone, vec2((q.r + 0.5) / 256.0, 0.5)).r, texture(tone, vec2((q.g + 0.5) / 256.0, 0.5)).r, texture(tone, vec2((q.b + 0.5) / 256.0, 0.5)).r);
  }
  if (abs(sat - 1.0) > 1e-6) { vec3 h = rgb2hsv(v); h.y = clamp(h.y * sat, 0.0, 1.0); v = hsv2rgb(h); }
  v = clamp(v * wb, 0.0, 1.0);
  if (useLut) { vec3 l = texture(lut, v * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize).rgb; v = mix(v, l, lutMix); }
  o = vec4(v, c.a);
}`;

  function init() {
    if (gl || failed) return !!gl;
    try {
      glCanvas = document.createElement('canvas');
      gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      if (!gl) throw new Error('WebGL2 が使えません');
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const pl = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(pl);
      gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
      loc = {};
      for (const n of ['src', 'tone', 'lut', 'sat', 'wb', 'lutMix', 'lutSize', 'useLut', 'useTone']) loc[n] = gl.getUniformLocation(prog, n);
      const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
      texSrc = tex();
      texTone = tex();
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(loc.src, 0); gl.uniform1i(loc.tone, 1); gl.uniform1i(loc.lut, 2);
      return true;
    } catch (err) {
      console.warn('色調補正の準備に失敗', err);
      failed = true; gl = null;
      return false;
    }
  }

  function lutTexture(ref, cb) {
    let t = texLuts.get(ref);
    if (t) return t;
    t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, cb.size, cb.size, cb.size, 0, gl.RGB, gl.FLOAT, cb.data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    texLuts.set(ref, t);
    return t;
  }

  function upload(source, w, h) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texSrc);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      // 直接渡せない絵（Safari の VideoFrame など）は 2D の canvas を通す
      if (!copyCanvas) copyCanvas = document.createElement('canvas');
      copyCanvas.width = w; copyCanvas.height = h;
      const cg = copyCanvas.getContext('2d');
      cg.clearRect(0, 0, w, h);
      cg.drawImage(source, 0, 0, w, h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, copyCanvas);
    }
  }

  let lastTone = '';

  /**
   * 補正した絵を返す（共有の canvas。大きさは outW×outH）。使えなければ null（補正なしで描く）。
   * source の大きさは sw×sh（回転前）。
   */
  function apply(source, sw, sh, g, outW, outH) {
    if (isIdentity(g) || !init()) return null;
    let useLut = false, cb = null;
    if (g.lut && Number(g.lut_mix ?? 1) > 0) {
      cb = cube(g.lut);
      useLut = !!(cb && !cb.error);
    }
    const w = Math.max(1, Math.round(Math.min(outW, sw))), h = Math.max(1, Math.round(Math.min(outH, sh)));
    if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
    gl.viewport(0, 0, w, h);
    upload(source, sw, sh);
    const tone = toneTable(g);
    let identityTone = true;
    for (let i = 0; i < 256; i++) if (tone[i] !== i) { identityTone = false; break; }
    if (!identityTone) {
      const key = tone.join(',');
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texTone);
      if (key !== lastTone) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, tone);
        lastTone = key;
      }
    }
    gl.uniform1i(loc.useTone, identityTone ? 0 : 1);
    gl.uniform1f(loc.sat, Number(g.saturation ?? 1));
    gl.uniform3fv(loc.wb, wbFactors(g));
    gl.uniform1i(loc.useLut, useLut ? 1 : 0);
    if (useLut) {
      lutTexture(g.lut, cb);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, texLuts.get(g.lut));
      gl.uniform1f(loc.lutSize, cb.size);
      gl.uniform1f(loc.lutMix, Math.min(1, Math.max(0, Number(g.lut_mix ?? 1))));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return glCanvas;
  }

  function lutName(ref, list) {
    if (!ref) return 'なし';
    if (BUILTIN[ref]) return BUILTIN[ref];
    const u = (list || []).find((x) => x.ref === ref);
    return u ? u.name : ref.replace(/^.*[\\/]/, '');
  }

  return {
    PARAMS, LOOKS, BUILTIN, isIdentity, toneTable, wbFactors, parseCube, builtin, cube, importCube, userLuts, apply, lutName,
    set onLoaded(fn) { onLoaded = fn; }, error: (ref) => { const c = cubes.get(ref); return c && c.error ? c.error : ''; },
  };
})();
