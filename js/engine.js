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

  /** frame で見えるクリップ（下の段から順に） */
  function visibleClips(fr) {
    const out = [];
    for (const t of visualTracks()) {
      for (const c of Object.values(p.clips)) {
        if (c.track === t.id && c.enabled && c.start <= fr && fr < Proj.end(c) && (c.media || c.fill)) out.push(c);
      }
    }
    return out;
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
      const target = Proj.srcAt(p, c, fr);
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

  function audioTracks() {
    const solo = p.tracks.some((t) => t.kind === 'audio' && t.solo);
    return p.tracks.filter((t) => t.kind === 'audio' && !t.muted && (!solo || t.solo));
  }

  function scheduleAudio() {
    const my = token;
    const out = masterNode();
    for (const t of audioTracks()) {
      for (const c of Object.values(p.clips)) {
        if (c.track !== t.id || !c.enabled || !c.media || Proj.end(c) <= startFrame) continue;
        Media.audio(c.media).then((a) => { if (a && my === token && playing) scheduleClip(c, t, a, out); });
      }
    }
  }

  function scheduleClip(c, t, a, out) {
    const cx = ctx();
    const f = F();
    let from = Math.max(c.start, startFrame);
    // 読み込みが遅れて開始時刻を過ぎていたら、今の位置から
    const nowFrame = startFrame + (cx.currentTime + 0.03 - startCtx) * f;
    if (nowFrame > from) from = nowFrame;
    const e = Proj.end(c);
    if (from >= e) return;
    let when = timeOf(from);
    let off = Proj.srcAt(p, c, from) - a.offset;
    let dur = (e - from) / f * c.speed;
    if (off < 0) { when += -off / c.speed; dur += off; off = 0; }
    if (dur <= 0 || off >= a.buffer.duration) return;
    const src = cx.createBufferSource();
    src.buffer = a.buffer;
    src.playbackRate.value = c.speed;
    const gain = cx.createGain();
    const base = dbToGain((c.volume_db || 0) + (t.volume_db || 0));
    const fadeAt = (fr) => base * fadeFactor(c, fr);
    const gp = gain.gain;
    gp.setValueAtTime(fadeAt(from), when);
    if (c.fade_in > 0 && from < c.start + c.fade_in) gp.linearRampToValueAtTime(base, timeOf(c.start + c.fade_in));
    if (c.fade_out > 0) {
      const fs = Math.max(from, e - c.fade_out);
      if (fs > from) gp.setValueAtTime(fadeAt(fs), timeOf(fs));
      gp.linearRampToValueAtTime(0, timeOf(e));
    }
    let node = gain;
    if (t.pan && cx.createStereoPanner) {
      const pan = cx.createStereoPanner();
      pan.pan.value = clamp(t.pan, -1, 1);
      gain.connect(pan);
      node = pan;
      nodes.push(pan);
    }
    src.connect(gain);
    node.connect(out);
    src.start(when, off, dur);
    nodes.push(src, gain);
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

  /** 素材の w×h を置く中心と大きさ（作品の画素） */
  function placement(c, mw, mh) {
    const cw = p.width, ch = p.height;
    let s;
    if (c.fit === 'fill') s = Math.max(cw / mw, ch / mh);
    else if (c.fit === 'none') s = 1;
    else s = Math.min(cw / mw, ch / mh);
    s *= c.scale;
    return { cx: cw / 2 + c.pos_x, cy: ch / 2 + c.pos_y, w: mw * s, h: mh * s, rot: c.rotation || 0 };
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
    return { img: e.v, w: e.v.videoWidth, h: e.v.videoHeight };
  }

  function drawFrame(target, k, fr) {
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.fillStyle = '#000';
    target.fillRect(0, 0, target.canvas.width, target.canvas.height);
    for (const c of visibleClips(fr)) {
      const alpha = clamp(c.opacity, 0, 1) * fadeFactor(c, Math.floor(fr));
      if (alpha <= 0) continue;
      if (c.fill && !c.media) {
        target.setTransform(k, 0, 0, k, 0, 0);
        target.globalAlpha = alpha;
        target.fillStyle = c.fill;
        target.fillRect(0, 0, p.width, p.height);
        continue;
      }
      const s = sourceOf(c);
      if (!s) continue;
      const pl = placement(c, s.w, s.h);
      target.setTransform(k, 0, 0, k, 0, 0);
      target.translate(pl.cx, pl.cy);
      if (pl.rot) target.rotate(pl.rot * Math.PI / 180);
      target.globalAlpha = alpha;
      try { target.drawImage(s.img, -pl.w / 2, -pl.h / 2, pl.w, pl.h); } catch { /* 絵がまだ無い */ }
    }
    target.globalAlpha = 1;
    target.setTransform(1, 0, 0, 1, 0, 0);
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
    if (c.fill && !c.media) return { cx: p.width / 2, cy: p.height / 2, w: p.width, h: p.height, rot: 0 };
    const m = p.media[c.media];
    if (!m || !m.width) return null;
    return placement(c, m.width, m.height);
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
    preloadAudio, clipAtPoint, clipBox, visibleClips, fadeFactor, placement, drawFrame, debugVideos,
  };
})();
