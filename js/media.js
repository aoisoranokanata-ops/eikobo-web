/* ------------------------------------------------------------
   素材（動画・音声・画像）
   - 読み込み: ファイルを OPFS へ写す → 長さ・大きさを調べる → 縮小画像（タイムライン用）→ 音声を数値にして波形
   - 再生用: 動画は <video> に渡す URL、音声は AudioBuffer、画像は ImageBitmap（どれも作品を開いている間だけ覚える）
   ------------------------------------------------------------ */
const Media = (() => {
  const PEAKS_RATE = 100;                 // 波形: 1 秒あたりの値の数
  const records = new Map();              // ID → 保存してある情報（縮小画像・波形を含む）
  const urls = new Map();                 // ID → blob URL
  const audioCache = new Map();           // ID → Promise<{buffer, offset} | null>
  const imageCache = new Map();           // ID → Promise<ImageBitmap | HTMLCanvasElement>
  const thumbImgs = new Map();            // dataURL → HTMLImageElement
  let actx = null;

  function audioContext() {
    if (!actx) {
      const C = window.AudioContext || window.webkitAudioContext;
      actx = new C({ latencyHint: 'interactive' });
    }
    return actx;
  }

  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|avi)$/i;
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aif|aiff|caf|ogg|oga|opus|flac)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;
  const MP4_EXT = /\.(mp4|m4v|mov|m4a|3gp)$/i;

  function kindOf(file) {
    const t = file.type || '';
    if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
    if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
    if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
    return null;
  }

  /** 作品に書いておく素材の情報（exe の MediaItem と同じ名前） */
  function projectInfo(r) {
    return {
      id: r.id, name: r.name, kind: r.kind, duration: r.duration, fps: r.fps, width: r.width, height: r.height,
      has_video: r.has_video, has_audio: r.has_audio, rotation: r.rotation || 0, audio_rate: r.audio_rate || 0,
      audio_channels: r.audio_channels || 0, path: r.name, rel_path: '',
    };
  }

  function loadVideo(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      const t = setTimeout(() => { cleanup(); reject(new Error('動画を開けませんでした（時間切れ）')); }, 20000);
      const cleanup = () => { clearTimeout(t); v.onloadedmetadata = null; v.onerror = null; };
      v.onloadedmetadata = () => { cleanup(); resolve(v); };
      v.onerror = () => { cleanup(); reject(new Error('このブラウザでは再生できない動画です')); };
      v.src = url;
      v.load();
    });
  }

  function seekTo(v, t) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', onSeeked);
        // 表示される絵が更新されるのを待つ（Safari は seeked の直後だと前の絵のことがある）
        if (v.requestVideoFrameCallback) {
          let ok = false;
          v.requestVideoFrameCallback(() => { ok = true; resolve(); });
          setTimeout(() => { if (!ok) resolve(); }, 250);
        } else setTimeout(resolve, 30);
      };
      const onSeeked = () => fin();
      v.addEventListener('seeked', onSeeked);
      setTimeout(fin, 3000);
      v.currentTime = t;
    });
  }

  async function makeThumbs(v, duration, onProgress) {
    const n = clamp(Math.ceil(duration / 4), 4, 30);
    const H = 72;
    const W = Math.max(16, Math.round(H * (v.videoWidth / Math.max(1, v.videoHeight))));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const out = [];
    // iPad では一度再生しないと絵を読み込まないことがある
    try { await v.play(); v.pause(); } catch { /* 無音の動画は再生できる */ }
    for (let i = 0; i < n; i++) {
      const t = Math.min(duration - 0.05, (i + 0.5) / n * duration);
      await seekTo(v, Math.max(0, t));
      try { g.drawImage(v, 0, 0, W, H); } catch { /* 描けない時は黒のまま */ }
      out.push(c.toDataURL('image/jpeg', 0.7));
      if (onProgress) onProgress((i + 1) / n);
    }
    return out;
  }

  function makePeaks(buf) {
    const n = Math.max(1, Math.ceil(buf.duration * PEAKS_RATE));
    const out = new Uint8Array(n);
    const chans = [];
    for (let k = 0; k < buf.numberOfChannels; k++) chans.push(buf.getChannelData(k));
    const per = buf.sampleRate / PEAKS_RATE;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per), b = Math.min(buf.length, Math.floor((i + 1) * per));
      let m = 0;
      for (const ch of chans) for (let j = a; j < b; j += 2) { const x = ch[j] < 0 ? -ch[j] : ch[j]; if (x > m) m = x; }
      out[i] = Math.min(255, Math.round(Math.sqrt(m) * 255));   // 小さい音も見えるよう平方根
    }
    return out;
  }

  /** 音声を数値に（mp4 / mov は中の音声だけを読む）。返り値 {buffer, offset} */
  async function decodeAudio(file, info, onProgress) {
    const ctx = audioContext();
    if (info && info.audio) {
      try { return await Mp4.decodeAudio(file, info, ctx, onProgress); } catch (err) {
        // 中の音声だけで読めなければ、小さいファイルに限りファイルごと渡してみる
        if (file.size > 400 * 1024 * 1024) throw err;
        console.warn('音声だけの読み取りに失敗、ファイルごと試す', err);
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        return { buffer, offset: 0 };
      }
    }
    if (file.size > 400 * 1024 * 1024) throw new Error('ファイルが大きすぎて音声を読めません');
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return { buffer, offset: 0 };
  }

  async function makeImage(file) {
    const MAX = 4096;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        bmp = img;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    const w = bmp.width, h = bmp.height;
    if (Math.max(w, h) <= MAX) return bmp;
    const k = MAX / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  /**
   * ファイルを読み込んで素材にする。返り値は保存した情報。
   * step(文字, 割合) で進み具合を知らせる。
   */
  async function importFile(file, step = () => {}) {
    const kind = kindOf(file);
    if (!kind) throw new Error('読み込めない種類のファイルです');
    const id = uid('m');
    const rec = {
      id, name: file.name, kind, size: file.size, mime: file.type, created: Date.now(),
      duration: 0, fps: 0, width: 0, height: 0, has_video: kind === 'video', has_audio: false, rotation: 0,
      audio_offset: 0, audio_rate: 0, audio_channels: 0, thumbs: [], peaks: null, peaks_rate: PEAKS_RATE,
    };
    step('端末に保存しています', 0);
    await Store.writeFile(id, file, (r) => step(null, r * 0.5));
    try {
      const stored = (await Store.readFile(id)) || file;
      const info = MP4_EXT.test(file.name) || /mp4|quicktime/.test(file.type) ? await Mp4.parse(stored) : null;
      if (kind === 'video') {
        step('動画を調べています', 0.5);
        const url = URL.createObjectURL(stored);
        let v;
        try { v = await loadVideo(url); } catch (err) { URL.revokeObjectURL(url); throw err; }
        rec.duration = isFinite(v.duration) && v.duration > 0 ? v.duration : (info && info.video ? info.video.duration : 0);
        rec.width = v.videoWidth || (info && info.video ? info.video.width : 0);
        rec.height = v.videoHeight || (info && info.video ? info.video.height : 0);
        rec.fps = info && info.video && info.video.fps ? Math.round(info.video.fps * 1000) / 1000 : 30;
        rec.rotation = info && info.video ? info.video.rotation : 0;
        if (!rec.duration) throw new Error('動画の長さが分かりません');
        step('縮小画像を作っています', 0.55);
        rec.thumbs = await makeThumbs(v, rec.duration, (r) => step(null, 0.55 + r * 0.25));
        v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(url);
        rec.has_audio = info ? !!info.audio : true;
      } else if (kind === 'image') {
        step('画像を調べています', 0.6);
        const img = await makeImage(stored);
        rec.width = img.width; rec.height = img.height;
        imageCache.set(id, Promise.resolve(img));
        const c = document.createElement('canvas');
        c.height = 72; c.width = Math.max(16, Math.round(72 * img.width / Math.max(1, img.height)));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        rec.thumbs = [c.toDataURL('image/jpeg', 0.75)];
      } else {
        rec.has_audio = true;
      }
      if (rec.has_audio) {
        step('音声を読んでいます', 0.8);
        try {
          const a = await decodeAudio(stored, info, (r) => step(null, 0.8 + r * 0.15));
          rec.audio_offset = a.offset;
          rec.audio_rate = a.buffer.sampleRate;
          rec.audio_channels = a.buffer.numberOfChannels;
          rec.peaks = makePeaks(a.buffer);
          if (kind === 'audio') rec.duration = a.buffer.duration;
          audioCache.set(id, Promise.resolve(a));
        } catch (err) {
          if (kind === 'audio') throw err;
          rec.has_audio = false;
          rec.audio_error = String(err.message || err);
        }
      }
      step('保存しています', 0.97);
      await Store.put('media', rec);
      records.set(id, rec);
      return rec;
    } catch (err) {
      await Store.removeFile(id);
      throw err;
    }
  }

  /** 作品で使う素材の情報を読み込んでおく（縮小画像・波形のため） */
  async function load(ids) {
    for (const id of ids) {
      if (records.has(id)) continue;
      const r = await Store.get('media', id);
      if (r) records.set(id, r);
    }
  }

  const rec = (id) => records.get(id) || null;

  async function url(id) {
    if (urls.has(id)) return urls.get(id);
    const f = await Store.readFile(id);
    if (!f) return null;
    const u = URL.createObjectURL(f);
    urls.set(id, u);
    return u;
  }

  /** 音声（無ければ null）。一度読んだら覚えておく */
  function audio(id) {
    if (audioCache.has(id)) return audioCache.get(id);
    const p = (async () => {
      const r = records.get(id) || await Store.get('media', id);
      if (!r || !r.has_audio) return null;
      const f = await Store.readFile(id);
      if (!f) return null;
      const info = MP4_EXT.test(r.name) || /mp4|quicktime/.test(r.mime || '') ? await Mp4.parse(f) : null;
      try { return await decodeAudio(f, info); } catch (err) { console.warn('音声を読めません', r.name, err); return null; }
    })();
    audioCache.set(id, p);
    return p;
  }

  function image(id) {
    if (imageCache.has(id)) return imageCache.get(id);
    const p = (async () => {
      const f = await Store.readFile(id);
      return f ? makeImage(f) : null;
    })();
    imageCache.set(id, p);
    return p;
  }

  /** 縮小画像（読み込み済みなら HTMLImageElement、まだなら null を返して読み込みを始める） */
  function thumbImage(dataUrl, onload) {
    let img = thumbImgs.get(dataUrl);
    if (!img) {
      img = new Image();
      img.onload = onload;
      img.src = dataUrl;
      thumbImgs.set(dataUrl, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** 作品を閉じる時: 覚えているものを手放す */
  function release() {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    audioCache.clear();
    for (const p of imageCache.values()) p.then((b) => { if (b && b.close) b.close(); }).catch(() => {});
    imageCache.clear();
    thumbImgs.clear();
    records.clear();
  }

  async function remove(id) {
    if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
    audioCache.delete(id);
    imageCache.delete(id);
    records.delete(id);
    await Store.del('media', id);
    await Store.removeFile(id);
  }

  return { PEAKS_RATE, kindOf, importFile, projectInfo, load, rec, url, audio, image, thumbImage, release, remove, audioContext };
})();
