/* ------------------------------------------------------------
   音声処理（exe の core/audiofx.py・audio.py と同じ式）
   - ラウドネス（ITU-R BS.1770-4、K 特性・ゲート）とサンプルピーク
   - クリップのエフェクト（clip.afx = {eq, comp, denoise}）: 素材の音を一度だけ処理して覚える（再生と書き出しで同じ音）。
     順番は exe と同じ: ノイズ除去（スペクトルゲート）→ EQ（RBJ の双二次）→ コンプレッサー
   - マスターのリミッター（先読み 2ms・戻り 80ms）。書き出しで使う（再生中は DynamicsCompressor で近い働き）
   - サイドチェインのダッキング（p.ducking）: 声のトラックの 10ms ごとの大きさ → 音楽のトラックを下げる量（dB）
   ------------------------------------------------------------ */
const AudioFx = (() => {
  const EQ_PRESETS = {
    '声をくっきり': { low_cut: 80, low_gain: -2, mid_gain: 3, high_gain: 2 },
    'こもりを取る': { low_cut: 100, low_gain: -4, mid_gain: 1, high_gain: 3 },
    '低音を足す': { low_cut: 0, low_gain: 4, mid_gain: 0, high_gain: 0 },
    '電話の声': { low_cut: 300, low_gain: 0, mid_gain: 4, high_gain: -18 },
    'ラジオ風': { low_cut: 200, low_gain: -3, mid_gain: 5, high_gain: -6 },
  };
  const COMP_PRESETS = {
    '声をそろえる（軽め）': { threshold: -24, ratio: 2.5, makeup: 3 },
    '声をそろえる（強め）': { threshold: -30, ratio: 4, makeup: 6 },
    'ナレーション': { threshold: -20, ratio: 3, makeup: 4 },
  };
  const LOUDNESS_TARGETS = [['YouTube（-14 LUFS）', -14], ['ポッドキャスト（-16 LUFS）', -16], ['放送（-23 LUFS）', -23], ['Apple Music（-16 LUFS）', -16]];
  const DUCK_DEFAULT = { on: false, voice: [], music: [], amount: 12, threshold: -40, ratio: 4, attack: 0.08, release: 0.4 };

  // ---- 双二次フィルター ---------------------------------------------------------------
  /** [b0, b1, b2, a1, a2]（a0 で割った値）。exe の _biquad と同じ RBJ の式 */
  function biquad(kind, f0, gainDb, q, fs) {
    const A = 10 ** ((gainDb || 0) / 40);
    const w0 = 2 * Math.PI * f0 / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * (q || 0.707));
    let b, a;
    if (kind === 'highpass') { b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]; }
    else if (kind === 'lowpass') { b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]; }
    else if (kind === 'peak') { b = [1 + alpha * A, -2 * cw, 1 - alpha * A]; a = [1 + alpha / A, -2 * cw, 1 - alpha / A]; }
    else if (kind === 'lowshelf') {
      const sa = 2 * Math.sqrt(A) * alpha;
      b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)];
      a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa];
    } else {
      const sa = 2 * Math.sqrt(A) * alpha;
      b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)];
      a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa];
    }
    return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
  }

  /** EQ の設定 → 双二次の並び（exe の eq_sos と同じ規則） */
  function eqSections(eq, fs) {
    const s = [];
    const lc = Number(eq.low_cut || 0);
    if (lc > 0) { s.push(biquad('highpass', lc, 0, 0.707, fs)); s.push(biquad('highpass', lc, 0, 0.707, fs)); }
    const hc = Number(eq.high_cut || 0);
    if (hc > 0) s.push(biquad('lowpass', hc, 0, 0.707, fs));
    if (Math.abs(Number(eq.low_gain || 0)) > 0.01) s.push(biquad('lowshelf', Number(eq.low_freq || 120), Number(eq.low_gain), 0.707, fs));
    if (Math.abs(Number(eq.mid_gain || 0)) > 0.01) s.push(biquad('peak', Number(eq.mid_freq || 2800), Number(eq.mid_gain), 1.0, fs));
    if (Math.abs(Number(eq.high_gain || 0)) > 0.01) s.push(biquad('highshelf', Number(eq.high_freq || 8000), Number(eq.high_gain), 0.707, fs));
    if (lc >= 250 && Number(eq.high_gain || 0) <= -12) s.push(biquad('lowpass', 3400, 0, 0.707, fs));
    return s;
  }

  /** 双二次を順に掛ける（転置直接形 II、状態 0 から。x を書き換える） */
  function sosfilt(sections, x) {
    for (const [b0, b1, b2, a1, a2] of sections) {
      let z1 = 0, z2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        const y = b0 * v + z1;
        z1 = b1 * v - a1 * y + z2;
        z2 = b2 * v - a2 * y;
        x[i] = y;
      }
    }
    return x;
  }

  /** 先の w 個を含む最大（scipy の maximum_filter1d(size=2w+1, origin=-w) と同じ: 窓は [i, i+2w]） */
  function maxAhead(x, w) {
    const n = x.length, out = new Float64Array(n);
    const span = 2 * w;
    const dq = new Int32Array(n + 1);
    let h = 0, t = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const lim = Math.min(n - 1, i + span);
      while (j <= lim) { while (t > h && x[dq[t - 1]] <= x[j]) t--; dq[t++] = j; j++; }
      while (dq[h] < i) h++;
      out[i] = x[dq[h]];
    }
    return out;
  }

  /** 一次の低域通過（lfilter([1-a], [1, -a])、状態 0 から） */
  function onePole(x, a) {
    const out = new Float64Array(x.length);
    let y = 0;
    for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; out[i] = y; }
    return out;
  }

  /** コンプレッサー（exe の compress と同じ。ステレオ連動、chans を書き換える） */
  function compress(chans, fs, threshold = -24, ratio = 3, makeup = 0, attack = 0.005, release = 0.12) {
    const n = chans[0].length;
    if (!n) return;
    const level = new Float64Array(n);
    for (const ch of chans) for (let i = 0; i < n; i++) { const v = Math.abs(ch[i]); if (v > level[i]) level[i] = v; }
    const held = maxAhead(level, Math.max(1, Math.trunc(attack * fs)));
    const env = onePole(held, Math.exp(-1 / (release * fs)));
    const k = 1 - 1 / Math.max(1, ratio);
    for (let i = 0; i < n; i++) {
      const e = Math.max(env[i], held[i] * 0.5);
      const db = 20 * Math.log10(e + 1e-9);
      const g = 10 ** ((-Math.max(0, db - threshold) * k + makeup) / 20);
      for (const ch of chans) ch[i] *= g;
    }
  }

  /** マスターのリミッター（exe の Limiter と同じ。chans を書き換える） */
  function limit(chans, fs, ceilingDb = -1) {
    const n = chans[0].length;
    if (!n) return;
    const ceil = 10 ** (ceilingDb / 20);
    const red = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let lv = 0;
      for (const ch of chans) lv = Math.max(lv, Math.abs(ch[i]));
      red[i] = Math.max(0, 1 - ceil / Math.max(lv, 1e-9));
    }
    const held = maxAhead(red, Math.trunc(0.002 * fs));
    const sm = onePole(held, Math.exp(-1 / (0.08 * fs)));
    for (let i = 0; i < n; i++) {
      const g = 1 - Math.max(held[i], sm[i]);
      for (const ch of chans) ch[i] = Math.min(ceil, Math.max(-ceil, ch[i] * g));
    }
  }

  // ---- ノイズ除去（スペクトルゲート、exe の denoise_block と同じ考え） ------------------
  const N_FFT = 2048, HOP = 512;
  const fft = (() => {
    const n = N_FFT, rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    return (re, im, inverse) => {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = inverse ? -sin[k * step] : sin[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    };
  })();
  const HANN = (() => { const w = new Float64Array(N_FFT); for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1)); return w; })();
  const BINS = N_FFT / 2 + 1;

  /** 1 フレームの振幅スペクトル（dB）。re・im は作業用 */
  function frameSpec(x, s, re, im) {
    for (let i = 0; i < N_FFT; i++) { re[i] = (x[s + i] || 0) * HANN[i]; im[i] = 0; }
    fft(re, im, false);
  }

  /** 雑音のスペクトル: 静かなフレーム（音量の下位 10%）の dB の平均と標準偏差 */
  function noiseProfile(mid) {
    const total = mid.length;
    const step = Math.max(HOP, Math.trunc(total / HOP / 6000) * HOP);
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    const mags = [], energy = [];
    for (let s = 0; s + N_FFT <= total; s += step) {
      frameSpec(mid, s, re, im);
      const m = new Float32Array(BINS);
      let e = 0;
      for (let k = 0; k < BINS; k++) { m[k] = Math.hypot(re[k], im[k]); e += m[k]; }
      mags.push(m); energy.push(e);
    }
    const mean = new Float32Array(BINS), std = new Float32Array(BINS);
    if (!mags.length) { mean.fill(-120); std.fill(1); return [mean, std]; }
    const sorted = energy.slice().sort((a, b) => a - b);
    const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)];
    const quiet = mags.filter((_, i) => energy[i] <= p10);
    for (let k = 0; k < BINS; k++) {
      let s1 = 0, s2 = 0;
      for (const m of quiet) { const d = 20 * Math.log10(m[k] + 1e-9); s1 += d; s2 += d * d; }
      const mu = s1 / quiet.length;
      mean[k] = mu; std[k] = Math.sqrt(Math.max(0, s2 / quiet.length - mu * mu));
    }
    return [mean, std];
  }

  /** chans（Float32Array の配列）を書き換える。onProgress(0〜1) */
  async function denoise(chans, amount, onProgress) {
    const n = chans[0].length;
    const mid = new Float32Array(n);
    for (const ch of chans) for (let i = 0; i < n; i++) mid[i] += ch[i] / chans.length;
    const [mean, std] = noiseProfile(mid);
    const thr = mean.map((m, k) => m + 1.5 * std[k]);
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    const frames = n >= N_FFT ? 1 + Math.floor((n - N_FFT) / HOP) : 0;
    if (!frames) return;
    // 雑音の判定（左右を混ぜた音）→ 時間 5・周波数 9 でならした覆い → 利得
    const mask = new Float32Array(frames * BINS);
    for (let f = 0; f < frames; f++) {
      frameSpec(mid, f * HOP, re, im);
      for (let k = 0; k < BINS; k++) mask[f * BINS + k] = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-9) > thr[k] ? 1 : 0;
      if (f % 2000 === 0) { if (onProgress) onProgress(0.3 * f / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
    const tmp = new Float32Array(frames * BINS);
    for (let f = 0; f < frames; f++) for (let k = 0; k < BINS; k++) {          // 周波数方向 9（端は端の値で埋める）
      let s = 0;
      for (let d = -4; d <= 4; d++) s += mask[f * BINS + Math.min(BINS - 1, Math.max(0, k + d))];
      tmp[f * BINS + k] = s / 9;
    }
    const gain = new Float32Array(frames * BINS);
    for (let f = 0; f < frames; f++) for (let k = 0; k < BINS; k++) {          // 時間方向 5
      let s = 0;
      for (let d = -2; d <= 2; d++) s += tmp[Math.min(frames - 1, Math.max(0, f + d)) * BINS + k];
      const m = s / 5;
      gain[f * BINS + k] = m + (1 - m) * (1 - amount);
    }
    for (let c = 0; c < chans.length; c++) {
      const x = chans[c];
      const out = new Float32Array(n), norm = new Float32Array(n);
      for (let f = 0; f < frames; f++) {
        const s = f * HOP;
        frameSpec(x, s, re, im);
        for (let k = 0; k < BINS; k++) { const g = gain[f * BINS + k]; re[k] *= g; im[k] *= g; if (k > 0 && k < N_FFT / 2) { re[N_FFT - k] = re[k]; im[N_FFT - k] = -im[k]; } }
        fft(re, im, true);
        for (let i = 0; i < N_FFT; i++) { out[s + i] += re[i] * HANN[i]; norm[s + i] += HANN[i] * HANN[i]; }
        if (f % 2000 === 0) { if (onProgress) onProgress(0.3 + 0.7 * (c + f / frames) / chans.length); await new Promise((r) => setTimeout(r, 0)); }
      }
      for (let i = 0; i < n; i++) x[i] = norm[i] > 1e-6 ? out[i] / norm[i] : x[i];
    }
  }

  // ---- クリップのエフェクトを掛けた音 -------------------------------------------------
  const processedCache = new Map();
  const hasFx = (afx) => !!(afx && (afx.eq || afx.comp || afx.denoise));
  const fxKey = (id, afx) => id + '|' + JSON.stringify({ eq: afx.eq || null, comp: afx.comp || null, denoise: afx.denoise || 0 });

  /** 素材の音（エフェクト込み）。{buffer, offset} の Promise。エフェクトが無ければ素の音 */
  function processed(mediaId, afx, onProgress) {
    if (!hasFx(afx)) return Media.audio(mediaId);
    const key = fxKey(mediaId, afx);
    if (processedCache.has(key)) return processedCache.get(key);
    const pr = (async () => {
      const raw = await Media.audio(mediaId);
      if (!raw) return null;
      const b = raw.buffer, fs = b.sampleRate;
      const chans = [];
      for (let k = 0; k < Math.max(2, b.numberOfChannels); k++) chans.push(Float32Array.from(b.getChannelData(Math.min(k, b.numberOfChannels - 1))));
      if (afx.denoise) await denoise(chans, clamp(Number(afx.denoise), 0, 1), onProgress);
      if (afx.eq) { const s = eqSections(afx.eq, fs); if (s.length) for (const ch of chans) sosfilt(s, ch); }
      if (afx.comp) compress(chans, fs, Number(afx.comp.threshold ?? -24), Number(afx.comp.ratio ?? 3), Number(afx.comp.makeup ?? 0));
      const out = Media.audioContext().createBuffer(chans.length, b.length, fs);
      chans.forEach((ch, k) => out.copyToChannel(ch, k));
      return { buffer: out, offset: raw.offset };
    })();
    processedCache.set(key, pr);
    while (processedCache.size > 12) processedCache.delete(processedCache.keys().next().value);
    pr.catch(() => processedCache.delete(key));
    return pr;
  }

  // ---- ラウドネス ---------------------------------------------------------------------
  /** K 特性（BS.1770 の 2 段。どのサンプリング周波数でも作る。48k で規格の係数になる） */
  function kWeight(fs) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
    let a0 = 1 + K / Q + K * K;
    const pre = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs);
    const rlb = [1, -2, 1, 2 * (K * K - 1) / (1 + K / Q + K * K), (1 - K / Q + K * K) / (1 + K / Q + K * K)];
    return [pre, rlb];
  }

  class LoudnessMeter {
    constructor(fs) {
      this.fs = fs; this.sos = kWeight(fs);
      this.z = [[0, 0, 0, 0], [0, 0, 0, 0]];      // チャンネルごと・段ごとの状態
      this.block = Math.round(0.4 * fs); this.step = Math.round(0.1 * fs);
      this.blocks = []; this.peak = 0; this.acc = 0;
      this.ring = new Float64Array(this.block); this.filled = 0;
    }
    /** L・R（Float32Array）を流し込む */
    feed(L, R) {
      const [[b0, b1, b2, a1, a2], [c0, c1, c2, d1, d2]] = this.sos;
      const z = this.z;
      for (let i = 0; i < L.length; i++) {
        let ms = 0;
        for (let ch = 0; ch < 2; ch++) {
          const x = ch ? R[i] : L[i];
          const ax = Math.abs(x); if (ax > this.peak) this.peak = ax;
          const zz = z[ch];
          let y = b0 * x + zz[0]; zz[0] = b1 * x - a1 * y + zz[1]; zz[1] = b2 * x - a2 * y;
          const y2 = c0 * y + zz[2]; zz[2] = c1 * y - d1 * y2 + zz[3]; zz[3] = c2 * y - d2 * y2;
          ms += y2 * y2;
        }
        // 400ms のブロックを 100ms ずつずらして平均二乗（ブロックの始まりは 0, 100ms, 200ms …）
        const pos = this.filled % this.block;
        this.acc += ms - this.ring[pos];
        this.ring[pos] = ms;
        this.filled++;
        if (this.filled >= this.block && (this.filled - this.block) % this.step === 0) {
          if (this.blocks.length % 64 === 0) { let s = 0; for (const v of this.ring) s += v; this.acc = s; }   // 足し引きの誤差をためない
          this.blocks.push(Math.max(0, this.acc) / this.block);
        }
      }
    }
    integrated() {
      const z = this.blocks;
      if (!z.length) return -Infinity;
      const lk = (v) => -0.691 + 10 * Math.log10(v + 1e-20);
      const z1 = z.filter((v) => lk(v) > -70);
      if (!z1.length) return -Infinity;
      const rel = -0.691 + 10 * Math.log10(z1.reduce((s, v) => s + v, 0) / z1.length) - 10;
      const z2 = z1.filter((v) => lk(v) > rel);
      if (!z2.length) return -Infinity;
      return -0.691 + 10 * Math.log10(z2.reduce((s, v) => s + v, 0) / z2.length);
    }
    peakDb() { return this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity; }
  }

  /** AudioBuffer（の一部）のラウドネス。モノラルは左右に同じ音として測る（再生の聞こえ方と同じ） */
  function measureBuffer(buf, t0 = 0, t1 = Infinity, meter = null) {
    const fs = buf.sampleRate;
    const m = meter || new LoudnessMeter(fs);
    const a = Math.max(0, Math.floor(t0 * fs)), b = Math.min(buf.length, Math.ceil(Math.min(t1, buf.duration) * fs));
    if (b > a) {
      const L = buf.getChannelData(0).subarray(a, b);
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).subarray(a, b) : L;
      m.feed(L, R);
    }
    return m;
  }

  /**
   * クリップのラウドネス（素材の範囲・エフェクト込み、音量は除く）。perMedia なら同じ素材をまとめて測る（exe の measure_clips）。
   * 返り値 [{clips, lufs}]
   */
  async function measureClips(p, clips, perMedia = true) {
    const groups = new Map();
    for (const c of clips) {
      const k = perMedia ? c.media + '|' + JSON.stringify(c.afx || null) : c.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const out = [];
    for (const cl of groups.values()) {
      let meter = null;
      for (const c of cl.slice().sort((x, y) => x.start - y.start)) {
        const au = await processed(c.media, c.afx);
        if (!au) continue;
        const s = c.src_in - au.offset;
        meter = measureBuffer(au.buffer, s, s + c.duration / Proj.fps(p) * c.speed, meter);
      }
      const lu = meter ? meter.integrated() : -Infinity;
      out.push({ clips: cl, lufs: isFinite(lu) ? lu : null });
    }
    return out;
  }

  // ---- サイドチェインのダッキング ------------------------------------------------------
  /** 有効な設定（既定で埋める。声・音楽の指定が無ければ 最初の音声トラック・最後の音声トラック） */
  function duckSettings(p) {
    const d = p.ducking;
    if (!d || !d.on) return null;
    const s = { ...DUCK_DEFAULT, ...d };
    const auds = p.tracks.filter((t) => t.kind === 'audio').map((t) => t.id);
    const voice = (s.voice && s.voice.length ? s.voice : auds.slice(0, 1)).filter((t) => auds.includes(t));
    const music = (s.music && s.music.length ? s.music : auds.slice(-1)).filter((t) => auds.includes(t) && !voice.includes(t));
    if (!voice.length || !music.length) return null;
    return { ...s, voice, music };
  }

  const duckCache = new Map();

  /**
   * 音楽のトラックを下げる量（dB）を 10ms の窓ごとに。{rate: 100, db: Float32Array}（窓 k の値は (k + 0.5) / 100 秒の所）。
   * exe の _duck_gain と同じ: 窓ごとの声の大きさ → 下げ幅 r = min(強さ, (大きさ − しきい値) × (1 − 1/比率)) →
   * 窓 i = max_j r_j × 重み（前の窓は exp(−距離/R)、先の窓は 1 − 距離/(A+1)）。
   */
  function duckEnvelope(p, mixVoice) {
    const d = duckSettings(p);
    if (!d) return Promise.resolve(null);
    const voiceClips = Object.values(p.clips).filter((c) => d.voice.includes(c.track));
    const key = JSON.stringify([d, voiceClips, p.tracks.filter((t) => d.voice.includes(t.id)), p.fps_num, p.fps_den]);
    if (duckCache.has(key)) return duckCache.get(key);
    const pr = (async () => {
      const buf = await mixVoice(d.voice);              // 声のトラックだけを混ぜた 48k モノラル
      const WIN = 480;
      const n = buf ? Math.ceil(buf.length / WIN) : 0;
      const x = buf ? buf.getChannelData(0) : new Float32Array(0);
      const lv = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        let s = 0;
        const a = k * WIN, b = Math.min(x.length, a + WIN);
        for (let i = a; i < b; i++) s += x[i] * x[i];
        lv[k] = 10 * Math.log10(s / WIN + 1e-12);
      }
      const A = Math.max(1, Math.round(d.attack / 0.01));
      const R = Math.max(1, d.release / 0.01);
      const back = Math.trunc(R * 5);
      const k2 = 1 - 1 / Math.max(1, d.ratio);
      const r = lv.map((v) => Math.min(d.amount, Math.max(0, v - d.threshold) * k2));
      const w = [];
      for (let dist = -A; dist <= back; dist++) w.push([dist, dist >= 0 ? Math.exp(-dist / R) : 1 - (-dist) / (A + 1)]);
      const db = new Float32Array(n + 1);
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (const [dist, wt] of w) { const j = i - dist; if (j >= 0 && j < n) { const v = r[j] * wt; if (v > m) m = v; } }
        db[i] = m;
      }
      return { rate: 100, db };
    })();
    duckCache.set(key, pr);
    while (duckCache.size > 6) duckCache.delete(duckCache.keys().next().value);
    pr.catch(() => duckCache.delete(key));
    return pr;
  }

  /** 秒 t での下げ幅（dB）。窓の中心どうしを直線で結ぶ（exe の np.interp と同じ） */
  function duckDbAt(env, t) {
    const x = t * env.rate - 0.5;
    if (x <= 0) return env.db[0] || 0;
    const i = Math.floor(x);
    if (i >= env.db.length - 1) return env.db[env.db.length - 1] || 0;
    return env.db[i] + (env.db[i + 1] - env.db[i]) * (x - i);
  }

  return {
    EQ_PRESETS, COMP_PRESETS, LOUDNESS_TARGETS, DUCK_DEFAULT, biquad, eqSections, sosfilt, compress, limit, denoise, hasFx, processed,
    kWeight, LoudnessMeter, measureBuffer, measureClips, duckSettings, duckEnvelope, duckDbAt, maxAhead,
  };
})();

if (typeof module !== 'undefined') module.exports = AudioFx;
