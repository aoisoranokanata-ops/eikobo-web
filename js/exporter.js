/* ------------------------------------------------------------
   書き出し（MP4）

   1. 音声: OfflineAudioContext で再生と同じ混ぜ方を一気に計算 → AAC（AudioEncoder）。
      AAC が使えない端末では MOV ＋ 16bit PCM にする（写真アプリでも開ける形）。
   2. 映像: 1 コマずつ、素材のコマ（decode.js）を Engine.drawFrame で重ね → VideoEncoder（H.264）。
   3. 中身は OPFS に流し、最後に moov を前に付けて 1 つのファイルにする（mux.js）。
   出来たら「共有（写真に保存）」か「ダウンロード」。共有は押した操作の中でしか呼べないので、ボタンを出す。
   ------------------------------------------------------------ */
const Exporter = (() => {
  const SR = 48000;
  const QUALITY = { high: ['高画質', 16e6], std: ['標準', 10e6], light: ['軽い', 5e6] };   // 1080p・30fps の目安
  const TMP = 'out.bin';
  let lastUrl = null;

  const even = (x) => Math.max(2, Math.round(x / 2) * 2);

  function outSize(P, size) {
    const long = Math.max(P.width, P.height);
    const lim = size === 'full' ? long : Number(size);
    const k = Math.min(1, lim / long);
    return [even(P.width * k), even(P.height * k)];
  }

  function bitrateFor(q, w, h, fps) {
    const base = QUALITY[q][1];
    return Math.round(clamp(base * (w * h * fps) / (1920 * 1080 * 30), 1.5e6, 80e6));
  }

  // ---- 対応の確認 -----------------------------------------------------------------
  const LEVELS = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];

  async function videoConfig(w, h, fps, bitrate) {
    if (!window.VideoEncoder) return null;
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    const lv = LEVELS.find(([, fs, rate]) => mbs <= fs && mbs * fps <= rate) || LEVELS[LEVELS.length - 1];
    for (const prof of ['640', '4d0', '420']) {
      const codec = 'avc1.' + prof + '0' + lv[0].toString(16).padStart(2, '0');
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' };
      try {
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (s.supported) return cfg;
      } catch { /* 次を試す */ }
    }
    return null;
  }

  async function aacSupported() {
    if (!window.AudioEncoder) return false;
    try {
      const s = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });
      return !!s.supported;
    } catch { return false; }
  }

  // ---- 設定の画面 ---------------------------------------------------------------
  async function open(P, selectedIds) {
    if (!Object.keys(P.clips).length) { toast('タイムラインが空です'); return; }
    if (!window.VideoEncoder || !window.VideoFrame) {
      showDialog({ title: '書き出し', body: 'このブラウザは動画の書き出し（WebCodecs）に対応していません。iPad の Safari（iPadOS 16.4 以降）か Chrome で開いてください。' });
      return;
    }
    const fps = Proj.fps(P);
    const total = Proj.duration(P);
    const sel = (selectedIds || []).map((id) => P.clips[id]).filter(Boolean);
    const selRange = sel.length ? [Math.min(...sel.map((c) => c.start)), Math.max(...sel.map(Proj.end))] : null;
    const range = h('select', null,
      h('option', { value: 'all' }, `全体（${fmtTC(total, fps)}）`),
      selRange ? h('option', { value: 'sel' }, `選んだクリップの範囲（${fmtTC(selRange[1] - selRange[0], fps)}）`) : null);
    const long = Math.max(P.width, P.height);
    const sizes = [['full', `作品の大きさ（${P.width} × ${P.height}）`]];
    for (const l of [3840, 1920, 1280]) if (l < long) { const [w, hh] = outSize(P, l); sizes.push([String(l), `${w} × ${hh}`]); }
    const size = h('select', null, ...sizes.map(([v, t]) => h('option', { value: v }, t)));
    const quality = h('select', null, ...Object.entries(QUALITY).map(([k, [t]]) => h('option', { value: k, selected: k === 'std' }, t)));
    const est = h('p', { class: 'hint' });
    const update = () => {
      const [w, hh] = outSize(P, size.value);
      const r = range.value === 'sel' ? selRange : [0, total];
      const sec = (r[1] - r[0]) / fps;
      const bytes = (bitrateFor(quality.value, w, hh, fps) + 192000) / 8 * sec;
      est.textContent = `${w} × ${hh}・${Math.round(fps * 1000) / 1000} fps・H.264　だいたい ${fmtBytes(bytes)}`;
    };
    [range, size, quality].forEach((s) => s.addEventListener('change', update));
    update();
    const body = h('div', { class: 'form' },
      h('label', null, '範囲', range),
      h('label', null, '大きさ', size),
      h('label', null, '画質', quality),
      est,
      h('p', { class: 'hint' }, '書き出し中は画面を開いたままにしてください（他のアプリに切り替えると止まります）。'));
    const ok = await showDialog({ title: '書き出し（MP4）', body, buttons: [{ label: 'やめる', value: false }, { label: '書き出す', value: true, primary: true }] });
    if (!ok) return;
    const r = range.value === 'sel' ? selRange : [0, total];
    const [w, hh] = outSize(P, size.value);
    await run(P, { a: r[0], b: r[1], width: w, height: hh, bitrate: bitrateFor(quality.value, w, hh, fps) });
  }

  // ---- 音声を混ぜる ---------------------------------------------------------------
  async function renderAudio(P, a, b) {
    const fps = Proj.fps(P);
    const solo = P.tracks.some((t) => t.kind === 'audio' && t.solo);
    const tracks = P.tracks.filter((t) => t.kind === 'audio' && !t.muted && (!solo || t.solo));
    const items = [];
    for (const t of tracks) {
      for (const c of Object.values(P.clips)) {
        if (c.track !== t.id || !c.enabled || !c.media || Proj.end(c) <= a || c.start >= b) continue;
        const au = await Media.audio(c.media);
        if (au) items.push({ c, t, au });
      }
    }
    if (!items.length) return null;
    const len = Math.max(1, Math.round((b - a) / fps * SR));
    const oc = new OfflineAudioContext(2, len, SR);
    const master = oc.createGain();
    master.gain.value = dbToGain(P.master_db || 0);
    master.connect(oc.destination);
    const T = (fr) => (fr - a) / fps;
    for (const { c, t, au } of items) {
      const from = Math.max(c.start, a);
      const e = Math.min(Proj.end(c), b);
      let when = T(from);
      let off = Proj.srcAt(P, c, from) - au.offset;
      let dur = (e - from) / fps * c.speed;
      if (off < 0) { when += -off / c.speed; dur += off; off = 0; }
      if (dur <= 0 || off >= au.buffer.duration) continue;
      const src = oc.createBufferSource();
      src.buffer = au.buffer;
      src.playbackRate.value = c.speed;
      const gain = oc.createGain();
      const base = dbToGain((c.volume_db || 0) + (t.volume_db || 0));
      const at = (fr) => base * Engine.fadeFactor(c, fr);
      const gp = gain.gain;
      gp.setValueAtTime(at(from), when);
      if (c.fade_in > 0 && from < c.start + c.fade_in) gp.linearRampToValueAtTime(base, T(c.start + c.fade_in));
      if (c.fade_out > 0) {
        const fs = Math.max(from, Proj.end(c) - c.fade_out);
        if (fs > from) gp.setValueAtTime(at(fs), T(fs));
        gp.linearRampToValueAtTime(0, T(Proj.end(c)));
      }
      src.connect(gain);
      let node = gain;
      if (t.pan) { const pn = oc.createStereoPanner(); pn.pan.value = clamp(t.pan, -1, 1); gain.connect(pn); node = pn; }
      node.connect(master);
      src.start(when, off, dur);
    }
    return oc.startRendering();
  }

  /** AAC にする。返り値 {chunks: [{data, frames, t}], asc} */
  async function encodeAac(buf, cancelled) {
    const chunks = [];
    let asc = null;
    let err = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) asc = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description).slice();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, frames: Math.max(1, Math.round((chunk.duration || 21333) * SR / 1e6)), t: chunk.timestamp / 1e6 });
      },
      error: (e) => { err = e; },
    });
    enc.configure({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const BLOCK = 4096;
    for (let p = 0; p < buf.length; p += BLOCK) {
      if (cancelled()) break;
      const n = Math.min(BLOCK, buf.length - p);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(p, p + n), 0);
      data.set(R.subarray(p, p + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(p / SR * 1e6), data });
      enc.encode(ad);
      ad.close();
      if (enc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
      if (err) throw err;
    }
    await enc.flush();
    enc.close();
    if (err) throw err;
    // AAC-LC・48kHz・2ch の既定（説明が来なかった時）
    return { chunks, asc: asc || new Uint8Array([0x11, 0x90]) };
  }

  /** 16bit PCM（0.1 秒ごとのかたまり） */
  function encodePcm(buf) {
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const BLOCK = SR / 10;
    const chunks = [];
    for (let p = 0; p < buf.length; p += BLOCK) {
      const n = Math.min(BLOCK, buf.length - p);
      const out = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        out[i * 2] = clamp(Math.round(L[p + i] * 32767), -32768, 32767);
        out[i * 2 + 1] = clamp(Math.round(R[p + i] * 32767), -32768, 32767);
      }
      chunks.push({ data: new Uint8Array(out.buffer), frames: n, t: p / SR });
    }
    return chunks;
  }

  /**
   * canvas の RGB → I420（BT.709・リミテッドレンジ）。
   * RGB の VideoFrame をそのまま渡すと、ブラウザがどの式で YUV にするか決まらない（Windows の Chrome は BT.601 だった）。
   * ファイルには BT.709 の印を付けるので、換算も自分で BT.709 で行う。
   */
  function toI420(rgba, w, h, out) {
    const Y = out, U = w * h, V = U + (w >> 1) * (h >> 1);
    const cw = w >> 1;
    for (let y = 0; y < h; y += 2) {
      const r0 = y * w * 4, r1 = r0 + w * 4;
      const y0 = y * w, y1 = y0 + w;
      const c = (y >> 1) * cw;
      for (let x = 0; x < w; x += 2) {
        const p00 = r0 + x * 4, p01 = p00 + 4, p10 = r1 + x * 4, p11 = p10 + 4;
        let R = rgba[p00], G = rgba[p00 + 1], B = rgba[p00 + 2];
        Y[y0 + x] = ((187 * R + 629 * G + 63 * B) >> 10) + 16;
        let sr = R, sg = G, sb = B;
        R = rgba[p01]; G = rgba[p01 + 1]; B = rgba[p01 + 2];
        Y[y0 + x + 1] = ((187 * R + 629 * G + 63 * B) >> 10) + 16;
        sr += R; sg += G; sb += B;
        R = rgba[p10]; G = rgba[p10 + 1]; B = rgba[p10 + 2];
        Y[y1 + x] = ((187 * R + 629 * G + 63 * B) >> 10) + 16;
        sr += R; sg += G; sb += B;
        R = rgba[p11]; G = rgba[p11 + 1]; B = rgba[p11 + 2];
        Y[y1 + x + 1] = ((187 * R + 629 * G + 63 * B) >> 10) + 16;
        sr += R; sg += G; sb += B;
        const ci = c + (x >> 1);
        Y[U + ci] = ((-103 * sr - 347 * sg + 450 * sb) >> 12) + 128;
        Y[V + ci] = ((450 * sr - 408 * sg - 42 * sb) >> 12) + 128;
      }
    }
  }
  const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

  // ---- 本体 ---------------------------------------------------------------------
  async function run(P, o) {
    const fps = Proj.fps(P);
    const n = o.b - o.a;
    if (n <= 0) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const pb = progressBox('書き出しています', () => { cancelled = true; }, '画面を開いたままにしてください。');
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* 無くてもよい */ }
    Engine.pause();
    const readers = new Map();
    let sink = null;
    let encoder = null;
    const t0 = performance.now();
    try {
      if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
      await Store.removeExport();
      const vcfg = await videoConfig(o.width, o.height, fps, o.bitrate);
      if (!vcfg) throw new Error(`この端末では ${o.width}×${o.height} の H.264 に書き出せません。大きさを下げてみてください。`);

      // 音声
      pb.set('音声を混ぜています', 0);
      const mix = await renderAudio(P, o.a, o.b);
      if (cancelled) throw new Error('cancel');
      let audio = null;
      let aChunks = [];
      if (mix) {
        if (await aacSupported()) {
          pb.set('音声を AAC にしています', 0.02);
          const r = await encodeAac(mix, isCancelled);
          aChunks = r.chunks;
          audio = { codec: 'aac', sampleRate: SR, channels: 2, asc: r.asc, bitrate: 192000 };
        } else {
          aChunks = encodePcm(mix);
          audio = { codec: 'pcm', sampleRate: SR, channels: 2 };
        }
      }
      if (cancelled) throw new Error('cancel');
      const mov = !!audio && audio.codec === 'pcm';

      // 映像
      const [num, den] = [P.fps_num, P.fps_den || 1];
      const timescale = den === 1 ? num * 1000 : num;
      const frameDur = den === 1 ? 1000 : den;
      sink = await Store.openStream(TMP);
      let mux = null;
      let avcC = null;
      const outQ = [];
      let encErr = null;
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta && meta.decoderConfig && meta.decoderConfig.description && !avcC) {
            const d = meta.decoderConfig.description;
            avcC = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d).slice();
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          outQ.push({ data, ts: chunk.timestamp, key: chunk.type === 'key' });
        },
        error: (e) => { encErr = e; },
      });
      encoder.configure(vcfg);
      const frameUs = 1e6 / fps;
      let ai = 0;
      const drain = async () => {
        while (outQ.length) {
          const q = outQ.shift();
          if (!mux) {
            if (!avcC) throw new Error('H.264 の設定（avcC）を受け取れませんでした');
            mux = new Mux.Muxer({ mov, video: { width: o.width, height: o.height, timescale, avcC }, audio }, sink);
          }
          const idx = Math.round(q.ts / frameUs);
          await mux.addVideo(q.data, idx * frameDur, q.key);
          // 音声は映像の時刻に追いつく分だけ混ぜて書く（交互に並べる）
          const tv = (idx + 1) / fps;
          while (ai < aChunks.length && aChunks[ai].t <= tv + 0.5) { await mux.addAudio(aChunks[ai].data, aChunks[ai].frames); ai++; }
        }
      };

      const canvas = document.createElement('canvas');
      canvas.width = o.width; canvas.height = o.height;
      const g = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      const yuv = new Uint8Array(o.width * o.height * 3 / 2);
      const k = o.width / P.width;
      const images = new Map();
      for (const c of Object.values(P.clips)) {
        const m = c.media && P.media[c.media];
        if (m && m.kind === 'image' && !images.has(c.media)) images.set(c.media, await Media.image(c.media));
      }
      const keyInt = Math.max(1, Math.round(fps * 2));
      for (let i = 0; i < n; i++) {
        if (cancelled) throw new Error('cancel');
        if (encErr) throw encErr;
        const fr = o.a + i;
        const vis = Engine.visibleClips(fr);
        const frames = new Map();
        const visIds = new Set();
        for (const c of vis) {
          const m = c.media && P.media[c.media];
          if (!m || m.kind !== 'video') continue;
          visIds.add(c.id);
          let r = readers.get(c.id);
          if (r === undefined) {
            r = await Decode.reader(c.media, Media.rec(c.media) || m);
            readers.set(c.id, r);
          }
          if (r) frames.set(c.id, await r.frameAt(Proj.srcAt(P, c, fr)));
        }
        for (const [id, r] of readers) if (!visIds.has(id)) { if (r) r.close(); readers.delete(id); }
        Engine.drawFrame(g, k, fr, (c) => {
          const m = P.media[c.media];
          if (!m) return null;
          if (m.kind === 'image') { const b = images.get(c.media); return b ? { img: b, w: b.width, h: b.height, rot: 0 } : null; }
          return frames.get(c.id) || null;
        });
        toI420(g.getImageData(0, 0, o.width, o.height).data, o.width, o.height, yuv);
        const vf = new VideoFrame(yuv, { format: 'I420', codedWidth: o.width, codedHeight: o.height, timestamp: Math.round(i * frameUs), duration: Math.round(frameUs), colorSpace: BT709 });
        encoder.encode(vf, { keyFrame: i % keyInt === 0 });
        vf.close();
        await drain();
        while (encoder.encodeQueueSize > 3) { await new Promise((r) => setTimeout(r, 4)); await drain(); }
        if (i % 5 === 0) {
          const el = (performance.now() - t0) / 1000;
          const rest = i > 10 ? el / (i + 1) * (n - i - 1) : null;
          pb.set(`映像 ${fmtTC(i, fps)} / ${fmtTC(n, fps)}${rest !== null ? `　残り約 ${fmtDur(rest)}` : ''}`, 0.05 + 0.93 * (i + 1) / n);
        }
      }
      await encoder.flush();
      await drain();
      encoder.close();
      encoder = null;
      while (ai < aChunks.length) { await mux.addAudio(aChunks[ai].data, aChunks[ai].frames); ai++; }
      pb.set('仕上げています', 0.99);
      const head = mux.finish(frameDur);
      const body = await sink.close();
      sink = null;
      const type = mov ? 'video/quicktime' : 'video/mp4';
      const name = safeName(P.name) + (mov ? '.mov' : '.mp4');
      const file = new File([head, body], name, { type });
      pb.close();
      const sec = (performance.now() - t0) / 1000;
      deliver(file, sec, mov, n / fps);
      return file;
    } catch (err) {
      pb.close();
      if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch { /* 済み */ } }
      if (sink) await sink.abort();
      if (err && err.message === 'cancel') { toast('書き出しをやめました'); return null; }
      console.error(err);
      showDialog({ title: '書き出せませんでした', body: String((err && err.message) || err) });
      return null;
    } finally {
      for (const r of readers.values()) if (r) r.close();
      if (wake) { try { await wake.release(); } catch { /* 済み */ } }
      Engine.refresh();
    }
  }

  function safeName(s) {
    return (s || '映工房').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '映工房';
  }

  function deliver(file, sec, mov, dur) {
    lastUrl = URL.createObjectURL(file);
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    const body = h('div', null,
      h('p', { class: 'modal-text' }, `${file.name}\n${fmtBytes(file.size)}・長さ ${fmtDur(dur)}・かかった時間 ${fmtDur(sec)}`),
      mov ? h('p', { class: 'hint' }, 'この端末は AAC に書き出せないため、音声は無圧縮（MOV）にしました。') : null,
      h('video', { src: lastUrl, controls: true, playsinline: true, class: 'export-preview' }));
    const buttons = [];
    if (canShare) {
      buttons.push({
        label: '共有・写真に保存', primary: true, value: () => {
          navigator.share({ files: [file], title: file.name }).catch((e) => { if (e && e.name !== 'AbortError') toast('共有できませんでした: ' + e.message); });
          return 'keep';
        },
      });
    }
    buttons.push({ label: 'ダウンロード', primary: !canShare, value: () => { const a = h('a', { href: lastUrl, download: file.name }); document.body.append(a); a.click(); a.remove(); return 'keep'; } });
    buttons.push({ label: '閉じる', value: 'close' });
    const loop = async () => {
      // 共有・ダウンロードの後も、閉じるまで出しておく
      const v = await showDialog({ title: '書き出しました', body, buttons, wide: true });
      if (v === 'keep') loop();
    };
    loop();
  }

  return { open, run, renderAudio, videoConfig, aacSupported };
})();
