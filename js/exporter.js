/* ------------------------------------------------------------
   書き出し（MP4）

   1. 音声: OfflineAudioContext で再生と同じ混ぜ方を一気に計算 → AAC（AudioEncoder）。
      AAC が使えない端末では MOV ＋ 16bit PCM にする（写真アプリでも開ける形）。
   2. 映像: 1 コマずつ、素材のコマ（decode.js）を Engine.drawFrame で重ね → VideoEncoder（H.264）。
   3. 中身は OPFS に流し、最後に moov を前に付けて 1 つのファイルにする（mux.js）。
   AI 高画質化（aienhance.js）を選ぶと、対象の動画のコマを AI で 4 倍にしてから重ねる（ぼけ・ノイズも取れる）。
   出来たら「共有（写真に保存）」か「ダウンロード」。共有は押した操作の中でしか呼べないので、ボタンを出す。
   ------------------------------------------------------------ */
const Exporter = (() => {
  const SR = 48000;
  const QUALITY = { high: ['高画質', 16e6], std: ['標準', 10e6], light: ['軽い', 5e6] };   // 1080p・30fps の目安
  const TMP = 'out.bin';
  let lastUrl = null;

  const even = (x) => Math.max(2, Math.round(x / 2) * 2);

  /** size = 'full' か短い辺の画素（'1080' など。作品より大きいと拡大） */
  function outSize(P, size) {
    if (size === 'full') return [even(P.width), even(P.height)];
    const k = Number(size) / Math.min(P.width, P.height);
    return [even(P.width * k), even(P.height * k)];
  }

  // ---- AI 高画質化の対象 ---------------------------------------------------------------
  /** 範囲 [a, b) で AI を掛ける動画クリップ → {ids: Set, frames, pixels（コマ × 画素）} */
  function aiTargets(P, a, b, outW, all) {
    const k = outW / P.width;
    const ids = new Set();
    let frames = 0, pixels = 0;
    for (const c of Object.values(P.clips)) {
      const m = c.media && P.media[c.media];
      if (!m || m.kind !== 'video' || !c.enabled) continue;
      const tr = Proj.track(P, c.track);
      if (!tr || tr.kind !== 'video' || tr.muted) continue;
      const n = Math.min(b, Proj.end(c)) - Math.max(a, c.start);
      if (n <= 0 || !m.width || !AiEnhance.fits(m.width, m.height)) continue;
      if (!all) {
        // 出力で元より大きく映るものだけ（拡大されるもの）
        const side = m.rotation === 90 || m.rotation === 270;
        const pl = Engine.placement(c, side ? m.height : m.width, side ? m.width : m.height);
        if (pl.w * k <= (side ? m.height : m.width) * 1.05) continue;
      }
      ids.add(c.id);
      frames += n;
      pixels += n * m.width * m.height;
    }
    return { ids, frames, pixels };
  }

  // ---- 前回の設定・かかる時間の見積もり --------------------------------------------------------
  // 書き出しの設定（大きさ・画質・AI・字幕）は前回のものを使う。大きさは出力の短い辺で覚える（作品ごとに選べる値が違うため）。
  const PREF_KEY = 'eikobo-web:export';
  // AI 以外（描く・I420・H.264・音声）にかかる秒を、出力 1 画素 1 コマあたりで覚える（書き出しのたびに直す）
  const SPEED_KEY = 'eikobo-web:export-speed';
  const BASE_GUESS = 9e-9;          // 測る前の目安: PC の Chrome で 1080p が実時間の約 2 倍
  const loadLs = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
  const saveLs = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 覚えられなくても使える */ } };
  function learnBase(sec, px) {
    if (!(sec > 0) || px < 1920 * 1080 * 15) return;      // 短すぎると準備の時間ばかりになる
    const sp = loadLs(SPEED_KEY);
    const v = sec / px;
    saveLs(SPEED_KEY, { perPx: sp.perPx > 0 ? sp.perPx * 0.5 + v * 0.5 : v });
  }
  /** 書き出しにかかる秒の見積もり。{total, ai, measured} */
  function estimateTime(P, a, b, w, hh, ai) {
    const sp = loadLs(SPEED_KEY);
    const base = (b - a) * w * hh * (sp.perPx > 0 ? sp.perPx : BASE_GUESS);
    let aiSec = 0;
    if (ai) {
      const t = aiTargets(P, a, b, w, ai.all);
      if (t.frames) aiSec = AiEnhance.estimate(t.pixels, ai.kind);
    }
    return { total: base + aiSec, ai: aiSec, measured: sp.perPx > 0 && (!aiSec || AiEnhance.measured()) };
  }
  /** 秒 → 「約 40 秒」「約 3 分 20 秒」「約 1 時間 5 分」 */
  function fmtSpan(sec) {
    let s = Math.max(1, Math.round(sec));
    if (s > 90) s = Math.round(s / 10) * 10;          // 長い時は 10 秒単位
    if (s < 60) return `約 ${s} 秒`;
    if (s < 3600) return `約 ${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : ''}`;
    return `約 ${Math.floor(s / 3600)} 時間 ${Math.round((s % 3600) / 60)} 分`;
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
    const short = Math.min(P.width, P.height);
    const sizes = [['full', `作品の大きさ（${P.width} × ${P.height}）`]];
    for (const l of [2160, 1080, 720]) {
      if (l === short) continue;
      const [w, hh] = outSize(P, l);
      sizes.push([String(l), `${w} × ${hh}（${l}p${l > short ? '・拡大' : ''}）`]);
    }
    const pref = loadLs(PREF_KEY);
    const shortOf = (v) => Math.min(...outSize(P, v));
    const prefSize = (sizes.find(([v]) => pref.short && shortOf(v) === pref.short) || sizes[0])[0];
    const size = h('select', null, ...sizes.map(([v, t]) => h('option', { value: v, selected: v === prefSize }, t)));
    // AI 高画質化
    const aiKind = h('select', null, h('option', { value: '' }, 'しない'), ...Object.entries(AiEnhance.MODELS).map(([k2, [, t]]) => h('option', { value: k2, selected: k2 === pref.ai }, t)));
    const aiAll = h('input', { type: 'checkbox', checked: !!pref.aiAll });
    const aiNote = h('p', { class: 'hint' });
    const aiTry = h('button', { type: 'button', class: 'block', disabled: true }, '今のコマで試す（AI あり・なしを比べる）');
    const aiBox = h('div', { class: 'ai-box' },
      h('label', null, 'AI 高画質化', aiKind),
      h('label', { class: 'inline' }, aiAll, '拡大しない動画にも掛ける（ノイズ除去として）'),
      aiTry, aiNote);
    let gpu = null;
    AiEnhance.support().then((g) => { gpu = g; update(); });
    const qPref = QUALITY[pref.quality] ? pref.quality : 'std';
    const quality = h('select', null, ...Object.entries(QUALITY).map(([k, [t]]) => h('option', { value: k, selected: k === qPref }, t)));
    const hasSubs = Proj.subtitleClips(P).length > 0;
    const subs = h('input', { type: 'checkbox', checked: pref.subs !== false });
    const est = h('p', { class: 'hint' });
    const timeEst = h('p', { class: 'export-time' });
    const update = () => {
      const [w, hh] = outSize(P, size.value);
      const r = range.value === 'sel' ? selRange : [0, total];
      const sec = (r[1] - r[0]) / fps;
      const bytes = (bitrateFor(quality.value, w, hh, fps) + 192000) / 8 * sec;
      est.textContent = `${w} × ${hh}・${Math.round(fps * 1000) / 1000} fps・H.264　だいたい ${fmtBytes(bytes)}`;
      // かかる時間（AI が使えない端末では AI 抜きで）
      const aiOn = aiKind.value && !(gpu && !gpu.webgpu) ? { kind: aiKind.value, all: aiAll.checked } : null;
      const te = estimateTime(P, r[0], r[1], w, hh, aiOn);
      timeEst.textContent = `書き出しにかかる時間: ${fmtSpan(te.total)}${te.ai ? `（うち AI ${fmtSpan(te.ai)}）` : ''}`;
      timeEst.append(h('span', { class: 'hint' }, te.measured ? '　この端末で測った速さから' : '　目安です（一度書き出すと、この端末の速さで出します）'));
      // AI の説明
      if (gpu && !gpu.webgpu) {
        aiKind.disabled = true; aiAll.disabled = true; aiTry.disabled = true;
        aiNote.textContent = 'このブラウザは WebGPU に対応していないので使えません（iPadOS 26 以降の Safari、PC の Chrome で使えます）。';
        return;
      }
      const t = aiTargets(P, r[0], r[1], w, aiAll.checked);
      aiTry.disabled = !aiKind.value || !gpu;
      if (!aiKind.value) {
        aiNote.textContent = '1280×720 以下の動画（アナログ・DVD・古いスマホの映像など）を AI で 4 倍に描き直し、ぼけとノイズを取ってから書き出します。';
      } else if (!t.frames) {
        aiNote.textContent = aiAll.checked ? 'この範囲に 1280×720 以下の動画がありません（それより大きい動画には掛けられません）。'
          : 'この範囲に、この大きさで拡大される動画がありません。大きさを上げるか「拡大しない動画にも掛ける」を選んでください。';
      } else {
        aiNote.textContent = `動画 ${t.ids.size} 本・${fmtTC(t.frames, fps)} に掛けます。`
          + (AiEnhance.measured() ? '' : 'AI の速さは端末で大きく変わります。「今のコマで試す」で測ると、上の時間がこの端末に合います。');
      }
    };
    [range, size, quality, aiKind, aiAll].forEach((s) => s.addEventListener('change', update));
    aiTry.addEventListener('click', async () => {
      const r = range.value === 'sel' ? selRange : [0, total];
      const [w, hh] = outSize(P, size.value);
      await tryAi(P, clamp(Math.round(Engine.position()), r[0], r[1] - 1), w, hh, aiKind.value, aiAll.checked, hasSubs ? subs.checked : true);
      update();
    });
    update();
    const body = h('div', { class: 'form' },
      h('label', null, '範囲', range),
      h('label', null, '大きさ', size),
      h('label', null, '画質', quality),
      hasSubs ? h('label', { class: 'inline' }, subs, '字幕を動画に入れる（焼き込み）') : null,
      est,
      aiBox,
      timeEst,
      h('p', { class: 'hint' }, '書き出し中は画面を開いたままにしてください（他のアプリに切り替えると止まります）。'));
    const ok = await showDialog({ title: '書き出し（MP4）', body, buttons: [{ label: 'やめる', value: false }, { label: '書き出す', value: true, primary: true }] });
    if (!ok) return;
    const r = range.value === 'sel' ? selRange : [0, total];
    const [w, hh] = outSize(P, size.value);
    // 次の書き出しのために覚える（AI は使えない端末でも選んだ種類を覚えておく）
    saveLs(PREF_KEY, { short: Math.min(w, hh), quality: quality.value, ai: aiKind.value, aiAll: aiAll.checked, subs: hasSubs ? subs.checked : pref.subs !== false });
    const ai = aiKind.value && !aiKind.disabled ? { kind: aiKind.value, all: aiAll.checked } : null;
    await run(P, { a: r[0], b: r[1], width: w, height: hh, bitrate: bitrateFor(quality.value, w, hh, fps), subtitles: !hasSubs || subs.checked, ai });
  }

  // ---- 1 コマの描画（書き出しと「今のコマで試す」で共通） ---------------------------------------
  /**
   * 書き出し用の描き手。frame(fr, g) で fr の絵を g に描く。ai = {kind, all} か null
   */
  function framePainter(P, o) {
    const readers = new Map();
    const images = new Map();
    const aiCanvas = new Map();      // クリップ ID → {key, canvas}（同じ素材のコマは描き直さない）
    const aiIds = o.ai ? aiTargets(P, o.a, o.b, o.width, o.ai.all).ids : new Set();
    const k = o.width / P.width;
    const pt = {
      aiIds,
      aiSec: 0,                      // AI にかかった秒（書き出しの速さを覚える時に引く）
      async prepare() {
        for (const c of Object.values(P.clips)) {
          const m = c.media && P.media[c.media];
          if (m && m.kind === 'image' && !images.has(c.media)) images.set(c.media, await Media.image(c.media));
        }
        await Stabilize.prepare(P);
      },
      async frame(fr, g, useAi = true) {
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
          if (!r) continue;
          const t = Proj.srcAt(P, c, fr);
          let f = await r.frameAt(t);
          if (f && useAi && aiIds.has(c.id)) {
            // 同じ素材のコマ（スロー・静止）は前の結果を使う
            const key = Math.round(t * (m.fps || 30));
            let e = aiCanvas.get(c.id);
            if (!e) { e = { key: null, canvas: document.createElement('canvas') }; aiCanvas.set(c.id, e); }
            if (e.key !== key) {
              const t0 = performance.now();
              await AiEnhance.enhance(f.img, f.w, f.h, o.ai.kind, e.canvas);
              pt.aiSec += (performance.now() - t0) / 1000;
              e.key = key;
            }
            f = { img: e.canvas, w: f.w, h: f.h, rot: f.rot, iw: e.canvas.width, ih: e.canvas.height };
          }
          frames.set(c.id, f);
        }
        for (const [id, r] of readers) if (!visIds.has(id)) { if (r) r.close(); readers.delete(id); aiCanvas.delete(id); }
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        Engine.drawFrame(g, k, fr, (c) => {
          const m = P.media[c.media];
          if (!m) return null;
          if (m.kind === 'image') { const b = images.get(c.media); return b ? { img: b, w: b.width, h: b.height, rot: 0 } : null; }
          return frames.get(c.id) || null;
        }, { subtitles: o.subtitles !== false });
      },
      close() {
        for (const r of readers.values()) if (r) r.close();
        readers.clear();
        aiCanvas.clear();
      },
    };
    return pt;
  }

  /** 「今のコマで試す」: 出力の大きさで AI あり・なしを描いて、真ん中を等倍で比べる */
  async function tryAi(P, fr, w, hh, kind, all, subtitles) {
    const o = { a: fr, b: fr + 1, width: w, height: hh, subtitles, ai: { kind, all } };
    const painter = framePainter(P, o);
    if (!painter.aiIds.size) { toast('このコマには AI を掛ける動画がありません'); return; }
    const pb = progressBox('AI を準備しています', null, '初めての時は AI の部品（約 30MB）を読み込みます。');
    const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
    const A = mk(), B = mk();
    let sec = 0;
    try {
      await AiEnhance.session(kind);
      await painter.prepare();
      pb.set('AI なしで描いています', 0.2);
      await painter.frame(fr, A.getContext('2d', { alpha: false }), false);
      pb.set('AI で描き直しています', 0.4);
      // 1 回目は GPU の準備が入るので、2 回目を測る
      await painter.frame(fr, B.getContext('2d', { alpha: false }), true);
      painter.close();
      const t0 = performance.now();
      await painter.frame(fr, B.getContext('2d', { alpha: false }), true);
      sec = (performance.now() - t0) / 1000;
    } catch (err) {
      pb.close();
      painter.close();
      console.error(err);
      showDialog({ title: 'AI を使えませんでした', body: String((err && err.message) || err) });
      return;
    }
    painter.close();
    pb.close();
    // 真ん中を等倍で（画面に入る大きさ）
    const cw = Math.min(w, 960), ch = Math.min(hh, 540);
    const x = Math.round((w - cw) / 2), y = Math.round((hh - ch) / 2);
    const crop = (src) => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; c.getContext('2d').drawImage(src, x, y, cw, ch, 0, 0, cw, ch); return c; };
    const before = crop(A), after = crop(B);
    after.className = 'ai-after';
    const slider = h('input', { type: 'range', min: 0, max: 100, value: 50, class: 'ai-slider' });
    const wrap = h('div', { class: 'ai-compare' }, before, after, h('span', { class: 'ai-tag left' }, 'AI なし'), h('span', { class: 'ai-tag right' }, 'AI あり'));
    const set = () => { after.style.clipPath = `inset(0 0 0 ${slider.value}%)`; };
    slider.addEventListener('input', set);
    set();
    const body = h('div', null, wrap, slider,
      h('p', { class: 'hint' }, `出力 ${w} × ${hh} の真ん中を等倍で表示しています。つまみで左右を動かして比べられます。1 コマの AI にかかった時間: ${sec.toFixed(2)} 秒。`));
    await showDialog({ title: `AI 高画質化（${AiEnhance.MODELS[kind][1]}）`, body, wide: true });
  }

  // 音声は Engine.renderMix（再生と同じ混ぜ方: 音量のキー・フェード・クロスフェード）

  /**
   * AAC にする。返り値 {chunks: [{data, frames, t}], asc, from}
   * description は Safari では大きな ArrayBuffer の一部の view や esds の形で来ることがある → Mux.aacConfig で
   * 本当の AudioSpecificConfig を取り出す（.buffer をそのまま使うと設定が壊れ、写真アプリで無音になった）。
   */
  async function encodeAac(buf, cancelled) {
    const chunks = [];
    let desc = null;
    let err = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !desc) desc = Mux.bytesOf(meta.decoderConfig.description);
        const raw = new Uint8Array(chunk.byteLength);
        chunk.copyTo(raw);
        const data = Mux.stripAdts(raw);
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
    const cfg = Mux.aacConfig(desc, SR, 2);       // 読めない時は AAC-LC・48kHz・2ch の既定
    return { chunks, asc: cfg.asc, from: cfg.from };
  }

  /** 書き出した音の大きさ（全体のピークと RMS、dB） */
  function mixLevel(buf) {
    let peak = 0, sum = 0;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; }
    }
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, buf.length * 2))) };
  }

  /**
   * 作った AAC を、この端末の AudioDecoder で実際に戻して鳴るか確かめる（いちばん大きい所の約 3 秒）。
   * 返り値: 'ok' | 'bad'（壊れている・無音）| null（確かめられない・元が無音）
   */
  async function verifyAac(r, mix) {
    if (!window.AudioDecoder || !r.chunks.length) return null;
    const cfg = { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, description: r.asc };
    try { if (!(await AudioDecoder.isConfigSupported(cfg)).supported) return null; } catch { return null; }
    // 0.5 秒ごとの大きさで、いちばん大きい所を探す
    const L = mix.getChannelData(0), R = mix.getChannelData(1);
    const STEP = SR / 2;
    let best = 0, bestE = -1;
    for (let p = 0; p < mix.length; p += STEP) {
      let e = 0;
      const end = Math.min(mix.length, p + STEP);
      for (let i = p; i < end; i += 4) e += L[i] * L[i] + R[i] * R[i];
      if (e > bestE) { bestE = e; best = p; }
    }
    const t0 = Math.max(0, best / SR - 0.5), t1 = t0 + 3;
    let ref = 0, refN = 0;
    for (let i = Math.round(t0 * SR); i < Math.min(mix.length, Math.round(t1 * SR)); i++) { ref += L[i] * L[i] + R[i] * R[i]; refN += 2; }
    const refRms = Math.sqrt(ref / Math.max(1, refN));
    if (refRms < 1e-4) return null;                 // 元が無音なら確かめようがない
    // 確かめる所の少し前から入れる（AAC は前のフレームが要る）
    const list = r.chunks.filter((c) => c.t >= t0 - 0.2 && c.t < t1);
    let sum = 0, n = 0, err = null;
    const dec = new AudioDecoder({
      output: (ad) => {
        try {
          const ch = ad.numberOfChannels;
          const planar = /planar/.test(ad.format);
          for (let k = 0; k < (planar ? ch : 1); k++) {
            const f = new Float32Array(ad.numberOfFrames * (planar ? 1 : ch));
            ad.copyTo(f, { planeIndex: k, format: planar ? 'f32-planar' : 'f32' });
            for (let i = 0; i < f.length; i++) { sum += f[i] * f[i]; n++; }
          }
        } catch (e) { err = e; }
        ad.close();
      },
      error: (e) => { err = e; },
    });
    try {
      dec.configure(cfg);
      for (const c of list) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(c.t * 1e6), data: c.data }));
      await dec.flush();
    } catch (e) { err = err || e; }
    try { dec.close(); } catch { /* 済み */ }
    if (err) { console.warn('AAC を確かめられませんでした', err); return 'bad'; }
    const rms = Math.sqrt(sum / Math.max(1, n));
    console.info(`AAC の確かめ: 元 ${refRms.toFixed(4)} / 戻した音 ${rms.toFixed(4)}`);
    return rms > refRms * 0.25 ? 'ok' : 'bad';
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
    const painter = framePainter(P, o);
    let sink = null;
    let encoder = null;
    const t0 = performance.now();
    try {
      if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
      await Store.removeExport();
      await Promise.all([Telop.load(), Motion.load()]);
      const vcfg = await videoConfig(o.width, o.height, fps, o.bitrate);
      if (!vcfg) throw new Error(`この端末では ${o.width}×${o.height} の H.264 に書き出せません。大きさを下げてみてください。`);
      if (o.ai && painter.aiIds.size) {
        pb.set('AI を準備しています（初めての時は部品を読み込みます）', 0);
        await AiEnhance.session(o.ai.kind);
      }
      const tWork = performance.now();     // ここから（AI の部品の読み込みを除いて）の時間で速さを覚える

      // 音声
      pb.set('音声を混ぜています', 0);
      const mix = await Engine.renderMix(P, o.a, o.b, SR);
      if (cancelled) throw new Error('cancel');
      let audio = null;
      let aChunks = [];
      const aInfo = { mix: !!mix, level: mix ? mixLevel(mix) : null, aac: false, check: null, fellBack: false };
      if (mix) {
        if (await aacSupported()) {
          pb.set('音声を AAC にしています', 0.02);
          let r = null;
          try { r = await encodeAac(mix, isCancelled); } catch (e) { if (cancelled) throw e; console.warn('AAC にできませんでした', e); }
          if (cancelled) throw new Error('cancel');
          if (r && r.chunks.length) {
            pb.set('音声を確かめています', 0.03);
            aInfo.check = await verifyAac(r, mix);
            aInfo.from = r.from;
          }
          if (r && r.chunks.length && aInfo.check !== 'bad') {
            aChunks = r.chunks;
            audio = { codec: 'aac', sampleRate: SR, channels: 2, asc: r.asc, bitrate: 192000 };
            aInfo.aac = true;
          } else aInfo.fellBack = true;               // AAC が鳴らない → 確実に鳴る無圧縮の PCM（MOV）にする
        }
        if (!audio) {
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
      await painter.prepare();
      const keyInt = Math.max(1, Math.round(fps * 2));
      for (let i = 0; i < n; i++) {
        if (cancelled) throw new Error('cancel');
        if (encErr) throw encErr;
        await painter.frame(o.a + i, g);
        toI420(g.getImageData(0, 0, o.width, o.height).data, o.width, o.height, yuv);
        const vf = new VideoFrame(yuv, { format: 'I420', codedWidth: o.width, codedHeight: o.height, timestamp: Math.round(i * frameUs), duration: Math.round(frameUs), colorSpace: BT709 });
        encoder.encode(vf, { keyFrame: i % keyInt === 0 });
        vf.close();
        await drain();
        while (encoder.encodeQueueSize > 3) { await new Promise((r) => setTimeout(r, 4)); await drain(); }
        if (i % 5 === 0 || painter.aiIds.size) {
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
      learnBase((performance.now() - tWork) / 1000 - painter.aiSec, n * o.width * o.height);
      deliver(file, sec, mov, n / fps, aInfo);
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
      painter.close();
      if (o.ai) AiEnhance.release();
      if (wake) { try { await wake.release(); } catch { /* 済み */ } }
      Engine.refresh();
    }
  }

  function safeName(s) {
    return (s || '映工房').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '映工房';
  }

  /** 書き出した音声の説明（1 行） */
  function audioNote(mov, a) {
    if (!a || !a.mix) return '音声: なし（タイムラインに音の出るクリップがありません）';
    const lv = a.level && isFinite(a.level.peakDb) ? `ピーク ${a.level.peakDb.toFixed(1)} dB` : '';
    if (a.level && !(a.level.peakDb > -70)) return '音声: 無音です（クリップの音量・ミュート・ミキサーを確かめてください）';
    if (a.aac) return `音声: AAC 192kbps・${lv}${a.check === 'ok' ? '・この端末で鳴ることを確認済み' : ''}`;
    if (a.fellBack) return `音声: 無圧縮（MOV）・${lv}。この端末の AAC では音が出なかったため切り替えました。`;
    return `音声: 無圧縮（MOV）・${lv}。この端末は AAC に書き出せないため。`;
  }

  function deliver(file, sec, mov, dur, aInfo) {
    lastUrl = URL.createObjectURL(file);
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    const body = h('div', null,
      h('p', { class: 'modal-text' }, `${file.name}\n${fmtBytes(file.size)}・長さ ${fmtDur(dur)}・かかった時間 ${fmtDur(sec)}`),
      h('p', { class: 'hint' }, audioNote(mov, aInfo)),
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
    let drive = null;
    if (GDrive.configured()) buttons.push({ label: '☁️ Google Drive に保存', value: () => { drive = GDrive.go({ kind: 'upload', blob: file, name: file.name }); return 'keep'; } });
    buttons.push({ label: '閉じる', value: 'close' });
    const loop = async () => {
      // 共有・ダウンロード・Google Drive の後も、閉じるまで出しておく
      const v = await showDialog({ title: '書き出しました', body, buttons, wide: true });
      if (drive) { await drive; drive = null; }      // 送り終わってから出し直す
      if (v === 'keep') loop();
    };
    loop();
  }

  return { open, run, videoConfig, aacSupported, outSize, aiTargets, framePainter, tryAi, verifyAac };
})();
