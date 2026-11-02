/* ------------------------------------------------------------
   再生と画面の合成

   - 時計は AudioContext。音声は AudioBuffer を時刻どおりに予約するので、音はずれない。
   - 映像はクリップごとの <video>（消音）を時計に合わせて動かし、毎フレーム canvas に重ねて描く。
     ずれが小さい時は再生速度を少しだけ変えて寄せ、大きい時だけ飛ぶ（飛ぶと一瞬止まるため）。
   - 置き方（はめ方・位置・拡大・回転・不透明度・フェード）は exe の render.py と同じ式。
   ------------------------------------------------------------ */
const Engine = (() => {
  let p = null;
  let canvas = null, g = null;
  let frame = 0;                 // 今の位置（再生中は小数）
  let playing = false;
  let startCtx = 0, startFrame = 0;
  let token = 0;                 // 再生をやり直すたびに増える（古い予約を捨てる）
  let raf = 0;
  let drawQueued = false;
  let master = null;
  const pool = new Map();        // クリップ ID → {v, media, pending}
  let nodes = [];
  const listeners = { tick: [], state: [] };
  let overlayFn = null;          // 選んだクリップの枠などを上に描く (g, k)

  const on = (ev, fn) => listeners[ev].push(fn);
  const emit = (ev, ...a) => listeners[ev].forEach((fn) => fn(...a));
  const F = () => Proj.fps(p);

  function attach(cv) { canvas = cv; g = cv.getContext('2d'); }
  function setOverlay(fn) { overlayFn = fn; }

  function setProject(proj) {
    stop();
    clearPool();
    p = proj;
    frame = proj ? proj.playhead || 0 : 0;
    if (p) syncPaused();
    requestDraw();
  }

  function clearPool() {
    for (const e of pool.values()) dropElement(e);
    pool.clear();
  }

  function dropElement(e) {
    try { e.v.pause(); e.v.removeAttribute('src'); e.v.load(); } catch { /* 無視 */ }
  }

  const position = () => frame;
  const isPlaying = () => playing;

  function ctx() { return Media.audioContext(); }

  function masterNode() {
    const c = ctx();
    if (!master || master.context !== c) {
      master = c.createGain();
      master.connect(c.destination);
    }
    master.gain.value = dbToGain(p ? p.master_db || 0 : 0);
    return master;
  }

  // 出力の遅れを引いた「今聞こえている」位置
  function clockFrame() {
    const c = ctx();
    const lat = (c.outputLatency || 0) + (c.baseLatency || 0);
    return startFrame + Math.max(0, c.currentTime - lat - startCtx) * F();
  }
  const timeOf = (fr) => startCtx + (fr - startFrame) / F();

  // ---- 見えるクリップ ----------------------------------------------------------
  function visualTracks() {
    return p.tracks.filter((t) => t.kind === 'video' && !t.muted);
  }

  /**
   * 段ごとの状態（下の段から）: {kind: 'single', c} / {kind: 'trans', a（出る）, b（入る）, t（0〜1）, type}。
   * exe の Compositor._state と同じ（トランジションは切れ目を中心に、前後のクリップをはみ出させて重ねる）。
   */
  function trackStates(fr) {
    fr = Math.floor(fr);
    const out = [];
    for (const t of visualTracks()) {
      const clips = Proj.clipsOn(p, t.id).filter((c) => c.media || c.fill || c.text);
      let i = -1;
      for (let k = 0; k < clips.length; k++) if (clips[k].start <= fr) i = k; else break;
      const cur = i >= 0 && fr < Proj.end(clips[i]) && clips[i].enabled ? clips[i] : null;
      const nxt = clips[i + 1];
      if (cur && nxt && nxt.trans_in && nxt.start === Proj.end(cur) && nxt.enabled) {
        const [a, b] = Proj.transitionZone(nxt);
        if (a <= fr && fr < b) { out.push({ kind: 'trans', a: cur, b: nxt, t: (fr - a + 0.5) / (b - a), type: nxt.trans_in.type || 'dissolve' }); continue; }
      }
      if (cur && cur.trans_in && i > 0) {
        const prev = clips[i - 1];
        if (Proj.end(prev) === cur.start && prev.enabled) {
          const [a, b] = Proj.transitionZone(cur);
          if (a <= fr && fr < b) { out.push({ kind: 'trans', a: prev, b: cur, t: (fr - a + 0.5) / (b - a), type: cur.trans_in.type || 'dissolve' }); continue; }
        }
      }
      if (cur) out.push({ kind: 'single', c: cur });
    }
    return out;
  }

  /** frame で見えるクリップ（下の段から順に。トランジション中は両方） */
  function visibleClips(fr) {
    return trackStates(fr).flatMap((s) => (s.kind === 'single' ? [s.c] : [s.a, s.b]));
  }

  function upcomingClips(fr, sec) {
    const lim = fr + sec * F();
    const out = [];
    for (const t of visualTracks()) {
      for (const c of Object.values(p.clips)) {
        if (c.track === t.id && c.enabled && c.start > fr && c.start <= lim && c.media && p.media[c.media] && p.media[c.media].kind === 'video') out.push(c);
      }
    }
    return out;
  }

  function entry(c) {
    let e = pool.get(c.id);
    if (e && e.media === c.media) return e;
    if (e) dropElement(e);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    e = { v, media: c.media, pending: null, primed: false };
    v.addEventListener('seeked', () => {
      if (e.pending !== null) { const t = e.pending; e.pending = null; v.currentTime = t; return; }
      requestDraw();
    });
    v.addEventListener('loadeddata', requestDraw);
    pool.set(c.id, e);
    Media.url(c.media).then((u) => { if (u && pool.get(c.id) === e) { v.src = u; v.load(); } });
    return e;
  }

  function seekElement(e, t) {
    const v = e.v;
    if (v.readyState < 1) { e.pending = null; v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true }); return; }
    if (v.seeking) { e.pending = t; return; }
    if (Math.abs(v.currentTime - t) < 0.5 / F() && v.readyState >= 2) return;
    v.currentTime = t;
  }

  /** 止まっている時: 見えるクリップの動画を位置へ */
  function syncPaused() {
    const keep = new Set();
    for (const c of visibleClips(frame)) {
      const m = p.media[c.media];
      if (!m || m.kind !== 'video') continue;
      keep.add(c.id);
      const e = entry(c);
      if (!e.v.paused) e.v.pause();
      seekElement(e, Math.max(0, Proj.srcAt(p, c, frame) + 0.001));
    }
    trimPool(keep);
  }

  /** 再生中: 時計に合わせる */
  function syncPlaying(fr) {
    const keep = new Set();
    for (const c of visibleClips(fr)) {
      const m = p.media[c.media];
      if (!m || m.kind !== 'video') continue;
      keep.add(c.id);
      const e = entry(c);
      const v = e.v;
      if (v.readyState < 1) continue;
      const target = Math.max(0, Proj.srcAt(p, c, fr));
      if (v.paused) {
        if (Math.abs(v.currentTime - target) > 0.08) v.currentTime = target;
        v.playbackRate = c.speed;
        v.play().catch(() => {});
        continue;
      }
      if (v.seeking) continue;
      const diff = target - v.currentTime;
      if (Math.abs(diff) > 0.4) { v.currentTime = target + 0.05; continue; }
      const want = c.speed * (1 + clamp(diff * 0.8, -0.12, 0.12));
      if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want;
    }
    // これから始まるクリップは頭で待たせておく
    for (const c of upcomingClips(fr, 1.5)) {
      keep.add(c.id);
      const e = entry(c);
      if (!e.v.paused) e.v.pause();
      if (!e.primed && e.v.readyState >= 1) { e.primed = true; e.v.currentTime = Math.max(0, c.src_in + 0.001); }
    }
    trimPool(keep);
  }

  function trimPool(keep) {
    // 使っていない要素は止める。多すぎる分は捨てる（iPad は同時に作れる動画の数に限りがある）
    const idle = [];
    for (const [id, e] of pool) {
      if (keep.has(id)) continue;
      if (!e.v.paused) e.v.pause();
      e.primed = false;
      idle.push(id);
    }
    while (pool.size > 10 && idle.length) {
      const id = idle.shift();
      dropElement(pool.get(id));
      pool.delete(id);
    }
  }

  // ---- 音声 ---------------------------------------------------------------------
  function stopAudio() {
    for (const n of nodes) { try { if (n.stop) n.stop(); n.disconnect(); } catch { /* 済み */ } }
    nodes = [];
  }

  /**
   * 鳴らす音声クリップの一覧（exe の audio.py の _entries と同じ）。トランジションのある切れ目は前後をはみ出させて
   * 等パワーのクロスフェード: xIn = [前へはみ出すフレーム, 全長]、xOut = [後ろへはみ出すフレーム, 全長]。
   */
  function audioEntries(pp) {
    const solo = pp.tracks.some((t) => t.kind === 'audio' && t.solo);
    const out = [];
    for (const t of pp.tracks.filter((x) => x.kind === 'audio' && !x.muted && (!solo || x.solo))) {
      const clips = Proj.clipsOn(pp, t.id).filter((c) => c.enabled && c.media);
      clips.forEach((c, i) => {
        const prev = clips[i - 1], nxt = clips[i + 1];
        let xIn = null, xOut = null;
        if (c.trans_in && prev && Proj.end(prev) === c.start) { const n = Math.max(2, Math.trunc(c.trans_in.frames || 15)); xIn = [Math.floor(n / 2), n]; }
        if (nxt && nxt.trans_in && nxt.start === Proj.end(c)) { const n = Math.max(2, Math.trunc(nxt.trans_in.frames || 15)); xOut = [n - Math.floor(n / 2), n]; }
        out.push({ c, t, xIn, xOut });
      });
    }
    return out;
  }

  /** クリップ先頭から rel フレームでの音量の倍率（音量のキー・フェード・クロスフェード・トラックの音量） */
  function audioGain(e, rel) {
    const c = e.c;
    let g = dbToGain(Keys.volumeDbAt(c, rel) + (e.t.volume_db || 0));
    if (c.fade_in > 0 && !e.xIn) g *= clamp(rel / c.fade_in, 0, 1);
    if (c.fade_out > 0 && !e.xOut) g *= clamp((c.duration - rel) / c.fade_out, 0, 1);
    if (e.xIn) { const [before, total] = e.xIn; g *= Math.sin(clamp((rel + before) / total, 0, 1) * Math.PI / 2); }
    if (e.xOut) { const [after, total] = e.xOut; g *= Math.cos(clamp((rel - (c.duration + after - total)) / total, 0, 1) * Math.PI / 2); }
    return g;
  }

  /**
   * 1 つのクリップを鳴らす予約。from〜to はタイムラインのフレーム（はみ出し込みの範囲に収める）、T(フレーム) → 時計の秒。
   * 音量は 20ms ごとの値のカーブにして setValueCurveAtTime（キー・フェード・クロスフェードを全部まとめて）。
   */
  function scheduleEntry(cx, dest, pp, e, au, from, to, T, keep) {
    const c = e.c, f = Proj.fps(pp);
    const cs = c.start - (e.xIn ? e.xIn[0] : 0), ce = Proj.end(c) + (e.xOut ? e.xOut[0] : 0);
    from = Math.max(from, cs);
    to = Math.min(to, ce);
    if (from >= to) return;
    let when = T(from);
    let off = Proj.srcAt(pp, c, from) - au.offset;
    let dur = (to - from) / f * c.speed;
    if (off < 0) { when += -off / c.speed; dur += off; off = 0; }
    if (dur <= 0 || off >= au.buffer.duration) return;
    const src = cx.createBufferSource();
    src.buffer = au.buffer;
    src.playbackRate.value = c.speed;
    const gain = cx.createGain();
    const span = T(to) - T(from);
    const n = Math.max(2, Math.min(30000, Math.ceil(span * 50) + 1));
    const curve = new Float32Array(n);
    let constant = true;
    for (let i = 0; i < n; i++) {
      curve[i] = audioGain(e, from + (to - from) * i / (n - 1) - c.start);
      if (i && Math.abs(curve[i] - curve[0]) > 1e-6) constant = false;
    }
    if (constant) gain.gain.value = curve[0];
    else { gain.gain.value = curve[0]; gain.gain.setValueCurveAtTime(curve, T(from), Math.max(0.001, span)); }
    let node = gain;
    if (e.t.pan && cx.createStereoPanner) {
      const pan = cx.createStereoPanner();
      pan.pan.value = clamp(e.t.pan, -1, 1);
      gain.connect(pan);
      node = pan;
      if (keep) keep.push(pan);
    }
    src.connect(gain);
    node.connect(dest);
    src.start(when, off, dur);
    if (keep) keep.push(src, gain);
  }

  function scheduleAudio() {
    const my = token;
    const out = masterNode();
    for (const e of audioEntries(p)) {
      if (Proj.end(e.c) + (e.xOut ? e.xOut[0] : 0) <= startFrame) continue;
      Media.audio(e.c.media).then((au) => {
        if (!au || my !== token || !playing) return;
        const cx = ctx();
        // 読み込みが遅れて開始時刻を過ぎていたら、今の位置から
        const nowFrame = startFrame + (cx.currentTime + 0.03 - startCtx) * F();
        scheduleEntry(cx, out, p, e, au, Math.max(startFrame, nowFrame), Infinity, timeOf, nodes);
      });
    }
  }

  /** 書き出し用: a〜b フレームの音声を OfflineAudioContext で混ぜる（無ければ null） */
  async function renderMix(pp, a, b, sr = 48000) {
    const entries = [];
    for (const e of audioEntries(pp)) {
      const cs = e.c.start - (e.xIn ? e.xIn[0] : 0), ce = Proj.end(e.c) + (e.xOut ? e.xOut[0] : 0);
      if (ce <= a || cs >= b) continue;
      const au = await Media.audio(e.c.media);
      if (au) entries.push([e, au]);
    }
    if (!entries.length) return null;
    const f = Proj.fps(pp);
    const oc = new OfflineAudioContext(2, Math.max(1, Math.round((b - a) / f * sr)), sr);
    const m = oc.createGain();
    m.gain.value = dbToGain(pp.master_db || 0);
    m.connect(oc.destination);
    for (const [e, au] of entries) scheduleEntry(oc, m, pp, e, au, a, b, (fr) => (fr - a) / f, null);
    return oc.startRendering();
  }

  function fadeFactor(c, fr) {
    let f = 1;
    if (c.fade_in > 0) f = Math.min(f, (fr - c.start + 1) / (c.fade_in + 1));
    if (c.fade_out > 0) f = Math.min(f, (Proj.end(c) - fr) / (c.fade_out + 1));
    return clamp(f, 0, 1);
  }

  /** 音声を先に読んでおく（再生ボタンを押してから待たせないため） */
  function preloadAudio() {
    if (!p) return;
    const ids = new Set(Object.values(p.clips).filter((c) => c.media && p.media[c.media] && p.media[c.media].has_audio).map((c) => c.media));
    for (const id of ids) Media.audio(id);
  }

  // ---- 再生の操作 ----------------------------------------------------------------
  function play() {
    if (playing || !p) return;
    const cx = ctx();
    if (cx.state !== 'running') cx.resume();          // 押した操作の中で呼ぶ（iPad の決まり）
    const endF = Proj.duration(p);
    if (endF <= 0) return;
    if (frame >= endF - 1) frame = 0;
    playing = true;
    token++;
    startFrame = frame;
    startCtx = cx.currentTime + 0.08;
    scheduleAudio();
    emit('state', true);
    loop();
  }

  function pause() {
    if (!playing) return;
    frame = clockFrame();
    stop();
    frame = Math.round(frame);
    if (p) p.playhead = frame;
    syncPaused();
    requestDraw();
    emit('tick', frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const was = playing;
    playing = false;
    token++;
    stopAudio();
    for (const e of pool.values()) if (!e.v.paused) e.v.pause();
    if (was) emit('state', false);
  }

  function toggle() { if (playing) pause(); else play(); }

  function seek(fr) {
    if (!p) return;
    fr = Math.max(0, fr);
    if (playing) {
      frame = fr;
      restart();
    } else {
      frame = Math.round(fr);
      p.playhead = frame;
      syncPaused();
      requestDraw();
    }
    emit('tick', frame);
  }

  /** 編集した時: 再生中なら今の位置から予約し直す、止まっていれば描き直す */
  function refresh() {
    if (!p) return;
    if (playing) { frame = clockFrame(); restart(); } else { syncPaused(); requestDraw(); }
  }

  function restart() {
    stopAudio();
    token++;
    const cx = ctx();
    startFrame = frame;
    startCtx = cx.currentTime + 0.05;
    for (const e of pool.values()) e.primed = false;
    scheduleAudio();
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const fr = clockFrame();
    const endF = Proj.duration(p);
    if (fr >= endF) {
      frame = endF;
      pause();
      seek(endF);
      return;
    }
    frame = fr;
    syncPlaying(fr);
    draw();
    emit('tick', fr);
  }

  // ---- 描画 ---------------------------------------------------------------------
  function requestDraw() {
    if (drawQueued || playing) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  /** 画面の大きさに合わせて canvas を作り直す（画素は作品の大きさまで） */
  function resize() {
    if (!canvas || !p) return;
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const ar = p.width / p.height;
    let w = box.width, hgt = box.width / ar;
    if (hgt > box.height) { hgt = box.height; w = hgt * ar; }
    w = Math.max(1, Math.floor(w)); hgt = Math.max(1, Math.floor(hgt));
    canvas.style.width = w + 'px';
    canvas.style.height = hgt + 'px';
    const pw = Math.min(p.width, Math.round(w * dpr));
    const ph = Math.round(pw / ar);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    requestDraw();
  }

  /** 素材の w×h を置く中心と大きさ（作品の画素）。tr = キーフレームを反映した値（省略でクリップの値） */
  function placement(c, mw, mh, tr = c) {
    const cw = p.width, ch = p.height;
    let s;
    if (c.fit === 'fill') s = Math.max(cw / mw, ch / mh);
    else if (c.fit === 'none') s = 1;
    else s = Math.min(cw / mw, ch / mh);
    s *= Math.max(0, tr.scale);
    return { cx: cw / 2 + tr.pos_x, cy: ch / 2 + tr.pos_y, w: mw * s, h: mh * s, rot: tr.rotation || 0 };
  }

  /** 切り抜き [左, 上, 右, 下]（見えている向きでの割合）→ 回転前の素材での割合 */
  function cropFor(crop, rot) {
    const [l, t, r, b] = crop.map((v) => clamp(Number(v) || 0, 0, 0.49));
    if (rot === 90) return [t, r, b, l];
    if (rot === 180) return [r, b, l, t];
    if (rot === 270) return [b, l, t, r];
    return [l, t, r, b];
  }

  function sourceOf(c) {
    const m = p.media[c.media];
    if (!m) return null;
    if (m.kind === 'image') {
      const pr = Media.image(c.media);
      if (!pr._value) pr.then((b) => { pr._value = b; requestDraw(); });
      const b = pr._value;
      return b ? { img: b, w: b.width, h: b.height } : null;
    }
    const e = pool.get(c.id);
    if (!e || e.v.readyState < 2 || !e.v.videoWidth) return null;
    return { img: e.v, w: e.v.videoWidth, h: e.v.videoHeight, rot: 0 };
  }

  /**
   * frame fr の絵を target に描く。k = 出力の画素 / 作品の画素。
   * getSource(c) → {img, w, h, rot}（w・h は回転前、rot は素材の回転・時計回りの度）。書き出しは別の読み手を渡す。
   */
  function drawFrame(target, k, fr, getSource = sourceOf, opts = {}) {
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.fillStyle = '#000';
    target.fillRect(0, 0, target.canvas.width, target.canvas.height);
    for (const st of trackStates(fr)) {
      if (st.kind === 'single') drawClip(target, k, st.c, fr, getSource);
      else drawTransition(target, k, st, fr, getSource);
    }
    target.globalAlpha = 1;
    target.setTransform(1, 0, 0, 1, 0, 0);
    if (opts.subtitles !== false) TelopDraw.drawSubtitles(target, p, fr, k, fadeFactor);
  }

  /** 1 つのクリップを描く（キーフレーム・フェード・切り抜き・色調補正） */
  function drawClip(target, k, c, fr, getSource) {
    const tr = Keys.transform(c, fr);
    const alpha = clamp(tr.opacity, 0, 1) * fadeFactor(c, Math.floor(fr));
    if (alpha <= 0 || tr.scale <= 0) return;
    target.save();
    try {
      if (c.text && !c.media) { TelopDraw.drawText(target, p, c, Math.floor(fr), k, alpha, tr); return; }
      if (c.fill && !c.media) {
        // カラーマット: 画面の大きさ × 拡大、位置・回転（exe の _draw_fill）
        target.setTransform(k, 0, 0, k, 0, 0);
        target.translate(p.width / 2 + tr.pos_x, p.height / 2 + tr.pos_y);
        if (tr.rotation) target.rotate(tr.rotation * Math.PI / 180);
        target.globalAlpha = alpha;
        target.fillStyle = c.fill;
        const w = p.width * tr.scale, h = p.height * tr.scale;
        target.fillRect(-w / 2, -h / 2, w, h);
        return;
      }
      const s = getSource(c);
      if (!s) return;
      const side = s.rot === 90 || s.rot === 270;
      const pl = placement(c, side ? s.h : s.w, side ? s.w : s.h, tr);
      const dw = side ? pl.h : pl.w, dh = side ? pl.w : pl.h;      // 回転前の向きの大きさ
      let img = s.img, iw = s.w, ih = s.h;
      if (c.grade && !Grade.isIdentity(c.grade)) {
        const graded = Grade.apply(s.img, s.w, s.h, c.grade, dw * k, dh * k);
        if (graded) { img = graded; iw = graded.width; ih = graded.height; }
      }
      target.setTransform(k, 0, 0, k, 0, 0);
      target.translate(pl.cx, pl.cy);
      if (pl.rot) target.rotate(pl.rot * Math.PI / 180);
      if (s.rot) target.rotate(s.rot * Math.PI / 180);
      target.globalAlpha = alpha;
      if (c.crop && c.crop.some((v) => v > 0)) {
        // 切り抜き: 残った所は元の位置のまま
        const [l, t, r, b] = cropFor(c.crop, s.rot || 0);
        const sw = iw * (1 - l - r), sh = ih * (1 - t - b);
        if (sw >= 1 && sh >= 1) target.drawImage(img, iw * l, ih * t, sw, sh, -dw / 2 + dw * l, -dh / 2 + dh * t, dw * (1 - l - r), dh * (1 - t - b));
      } else {
        target.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      }
    } catch { /* 絵がまだ無い */ } finally { target.restore(); }
  }

  // トランジション用の作業 canvas（出力と同じ大きさ、2 枚）
  const scratch = [null, null];
  function scratchFor(i, w, h) {
    let c = scratch[i];
    if (!c) { c = scratch[i] = document.createElement('canvas'); }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c.getContext('2d');
  }

  /** トランジション（exe の blend_transition と同じ: 下の段まで描いた絵に出る側・入る側を描いた 2 枚を混ぜる） */
  function drawTransition(target, k, st, fr, getSource) {
    const W = target.canvas.width, H = target.canvas.height;
    const t = clamp(st.t, 0, 1);
    const A = scratchFor(0, W, H), B = scratchFor(1, W, H);
    for (const [g, c] of [[A, st.a], [B, st.b]]) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'copy';
      g.drawImage(target.canvas, 0, 0);
      g.globalCompositeOperation = 'source-over';
      drawClip(g, k, c, fr, getSource);
    }
    const a = A.canvas, b = B.canvas;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    const type = st.type;
    if (type === 'dip_black' || type === 'dip_white') {
      const mid = type === 'dip_black' ? '#000' : '#fff';
      if (t < 0.5) { target.drawImage(a, 0, 0); target.globalAlpha = t * 2; target.fillStyle = mid; target.fillRect(0, 0, W, H); }
      else { target.fillStyle = mid; target.fillRect(0, 0, W, H); target.globalAlpha = (t - 0.5) * 2; target.drawImage(b, 0, 0); }
    } else if (type.startsWith('wipe_')) {
      target.drawImage(a, 0, 0);
      let x = 0, y = 0, w = W, h = H;
      if (type === 'wipe_left') { x = Math.round(W * (1 - t)); w = W - x; }
      else if (type === 'wipe_right') w = Math.round(W * t);
      else if (type === 'wipe_up') { y = Math.round(H * (1 - t)); h = H - y; }
      else h = Math.round(H * t);
      if (w > 0 && h > 0) target.drawImage(b, x, y, w, h, x, y, w, h);
    } else if (type === 'slide_left') {
      const x = Math.round(W * t);
      target.drawImage(a, -x, 0);
      target.drawImage(b, W - x, 0);
    } else if (type === 'zoom') {
      const e = t * t * (3 - 2 * t);
      const za = 1 + 0.25 * e, zb = 1.25 - 0.25 * e;
      target.drawImage(a, W / 2 - W * za / 2, H / 2 - H * za / 2, W * za, H * za);
      target.globalAlpha = e;
      target.drawImage(b, W / 2 - W * zb / 2, H / 2 - H * zb / 2, W * zb, H * zb);
    } else {
      target.drawImage(a, 0, 0);
      target.globalAlpha = t;
      target.drawImage(b, 0, 0);
    }
    target.restore();
  }

  function draw() {
    if (!g || !p) return;
    const k = canvas.width / p.width;
    drawFrame(g, k, frame);
    if (overlayFn) { g.save(); overlayFn(g, k); g.restore(); }
  }

  /** 画面上の点（作品の画素）にある一番上のクリップ */
  function clipAtPoint(x, y) {
    const list = visibleClips(frame).reverse();
    for (const c of list) {
      const b = clipBox(c);
      if (!b) continue;
      const a = -(b.rot || 0) * Math.PI / 180;
      const dx = x - b.cx, dy = y - b.cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return c;
    }
    return null;
  }

  /** クリップの置き場所（作品の画素）。大きさが分からなければ素材の情報から */
  function clipBox(c) {
    const tr = Keys.transform(c, frame);
    if (c.text && !c.media) return TelopDraw.bounds(p, c, tr);
    if (c.fill && !c.media) return { cx: p.width / 2 + tr.pos_x, cy: p.height / 2 + tr.pos_y, w: p.width * tr.scale, h: p.height * tr.scale, rot: tr.rotation || 0 };
    const m = p.media[c.media];
    if (!m || !m.width) return null;
    return placement(c, m.width, m.height, tr);
  }

  /** 確かめ用: 動画の要素ごとの「あるべき位置」と実際の位置 */
  function debugVideos() {
    return [...pool].map(([id, e]) => {
      const c = p && p.clips[id];
      return { clip: id, want: c ? +Proj.srcAt(p, c, frame).toFixed(3) : null, at: +e.v.currentTime.toFixed(3), paused: e.v.paused, ready: e.v.readyState, rate: +e.v.playbackRate.toFixed(3) };
    });
  }

  return {
    attach, setProject, setOverlay, on, play, pause, stop, toggle, seek, refresh, resize, requestDraw, position, isPlaying,
    preloadAudio, clipAtPoint, clipBox, visibleClips, trackStates, fadeFactor, placement, drawFrame, debugVideos, renderMix, audioEntries,
  };
})();
