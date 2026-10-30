/* ------------------------------------------------------------
   タイムライン（canvas に描く）

   指: 選んだクリップをドラッグ = 移動、選んでいないクリップや空き = 画面を動かす、2 本指 = 拡大縮小と移動。
   Pencil・マウス: どのクリップでもそのまま移動できる。端（選んだクリップは太い取っ手）= トリム。
   ドラッグ中は作品を書き換えず、離した時に 1 回だけ編集する（移動先は上書きなので、途中で書き換えると下のクリップが削れていく）。
   ------------------------------------------------------------ */
const Timeline = (() => {
  const HEAD_W = 84, RULER_H = 30, VROW = 60, AROW = 48, GAP = 2;
  let p = null;
  let cv = null, g = null, box = null;
  let W = 0, H = 0, dpr = 1;
  let ppf = 2;              // 1 フレームあたりの画素
  let scrollX = 0;          // 左端のフレーム
  let scrollY = 0;
  let sel = new Set();      // 選んだクリップ（リンク相手を含む）
  let primary = null;
  let multi = false;
  let snapOn = true;
  let drawQueued = false;
  let act = null;           // 今の操作
  const pointers = new Map();
  let pinch = null;
  let autoScroll = 0;
  const hooks = { select: () => {}, edit: () => {}, seek: () => {}, trackMenu: () => {} };

  function init(canvas, h) {
    cv = canvas;
    g = cv.getContext('2d');
    box = cv.parentElement;
    Object.assign(hooks, h);
    new ResizeObserver(resize).observe(box);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    resize();
  }

  function setProject(proj) {
    p = proj;
    sel = new Set();
    primary = null;
    scrollX = 0; scrollY = 0;
    fitAll();
  }

  function resize() {
    const r = box.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, Math.floor(r.width));
    H = Math.max(1, Math.floor(r.height));
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    draw();
  }

  const F = () => Proj.fps(p);
  const xOf = (f) => HEAD_W + (f - scrollX) * ppf;
  const frameAt = (x) => scrollX + (x - HEAD_W) / ppf;

  /** 段の並び: 映像は上の段ほど番号が大きい（V2 が V1 の上）、その下に音声 A1, A2 … */
  function rows() {
    const vids = p.tracks.filter((t) => t.kind === 'video').reverse();
    const auds = p.tracks.filter((t) => t.kind === 'audio');
    const out = [];
    let y = RULER_H - scrollY;
    for (const t of vids.concat(auds)) {
      const h = t.kind === 'video' ? VROW : AROW;
      out.push({ t, y, h });
      y += h + GAP;
    }
    return out;
  }
  const contentHeight = () => rows().reduce((s, r) => s + r.h + GAP, 0) + RULER_H + 20;
  const rowOf = (tid) => rows().find((r) => r.t.id === tid) || null;

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  // ---- 拡大縮小・スクロール ----------------------------------------------------
  function clampScroll() {
    const total = Math.max(Proj.duration(p), 10 * F());
    scrollX = clamp(scrollX, 0, Math.max(0, total + (W - HEAD_W) / ppf * 0.5));
    scrollY = clamp(scrollY, 0, Math.max(0, contentHeight() - H));
  }

  function zoomAt(k, x) {
    const f = frameAt(x);
    ppf = clamp(ppf * k, 0.02, 60);
    scrollX = f - (x - HEAD_W) / ppf;
    clampScroll();
    requestDraw();
  }

  function zoom(k) { zoomAt(k, clamp(xOf(Engine.position()), HEAD_W, W)); }

  function fitAll() {
    if (!p) return;
    const total = Math.max(Proj.duration(p), 10 * F());
    ppf = clamp((W - HEAD_W - 30) / total, 0.02, 60);
    scrollX = 0;
    clampScroll();
    requestDraw();
  }

  /** 再生中、再生ヘッドが右端を越えたら 1 画面送る */
  function follow(fr) {
    const x = xOf(fr);
    if (x > W - 20 || x < HEAD_W) { scrollX = fr - 10 / ppf; clampScroll(); }
    requestDraw();
  }

  // ---- 選択 --------------------------------------------------------------------
  function select(ids, prim, add = false) {
    if (!add) sel = new Set();
    for (const c of Proj.withLinks(p, ids)) sel.add(c.id);
    primary = prim !== undefined ? prim : (ids[0] || null);
    if (primary && !p.clips[primary]) primary = null;
    hooks.select(primary);
    requestDraw();
  }

  function toggleSelect(id) {
    const group = Proj.withLinks(p, [id]).map((c) => c.id);
    if (sel.has(id)) { group.forEach((x) => sel.delete(x)); if (group.includes(primary)) primary = [...sel][0] || null; }
    else { group.forEach((x) => sel.add(x)); primary = id; }
    hooks.select(primary);
    requestDraw();
  }

  function clearSelection() { sel = new Set(); primary = null; hooks.select(null); requestDraw(); }
  /** 消えたクリップを選択から外す（編集の後） */
  function prune() {
    for (const id of [...sel]) if (!p.clips[id]) sel.delete(id);
    if (primary && !p.clips[primary]) primary = [...sel][0] || null;
  }
  const selected = () => [...sel].filter((id) => p.clips[id]);
  const primaryClip = () => (primary && p.clips[primary]) || null;

  // ---- 当たり判定 ----------------------------------------------------------------
  function hit(x, y) {
    if (y < RULER_H) return { kind: 'ruler' };
    const r = rows().find((r) => y >= r.y && y < r.y + r.h);
    if (x < HEAD_W) return r ? { kind: 'head', row: r, x, y } : { kind: 'none' };
    if (!r) return { kind: 'empty' };
    const f = frameAt(x);
    // 指の下のクリップ。ただし選んだクリップの端がすぐ近くにあれば、そちら（隣と接している時のトリム用）
    let inside = null, nearSel = null;
    for (const c of Proj.clipsOn(p, r.t.id)) {
      const x0 = xOf(c.start), x1 = xOf(Proj.end(c));
      if (f >= c.start && f < Proj.end(c)) inside = c;
      else if (sel.has(c.id) && (Math.abs(x - x0) <= 14 || Math.abs(x - x1) <= 14)) nearSel = c;
    }
    const best = nearSel && (!inside || !sel.has(inside.id)) ? nearSel : inside;
    if (!best) return { kind: 'empty', row: r };
    return { kind: 'clip', clip: best, row: r };
  }

  function edgeOf(c, x, touch) {
    const x0 = xOf(c.start), x1 = xOf(Proj.end(c));
    const w = x1 - x0;
    const zone = sel.has(c.id) ? (touch ? 22 : 12) : (touch ? 0 : 7);
    if (!zone) return null;
    const z = Math.min(zone, w / 3);
    if (Math.abs(x - x0) <= z || (x < x0 && x0 - x <= 14)) return 'start';
    if (Math.abs(x - x1) <= z || (x > x1 && x - x1 <= 14)) return 'end';
    return null;
  }

  // ---- スナップ --------------------------------------------------------------------
  function snapPoints(exclude) {
    const pts = [0, Math.round(Engine.position())];
    for (const c of Object.values(p.clips)) {
      if (exclude.has(c.id)) continue;
      pts.push(c.start, Proj.end(c));
    }
    for (const m of p.markers) pts.push(m.frame);
    return pts;
  }

  function snapDelta(edges, pts) {
    if (!snapOn) return { d: 0, at: null };
    const thr = 10 / ppf;
    let best = null;
    for (const e of edges) for (const s of pts) {
      const d = s - e;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: s };
    }
    return best || { d: 0, at: null };
  }

  // ---- ポインタ ------------------------------------------------------------------
  function local(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    if (!p) return;
    try { cv.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても続ける */ }
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    if (pointers.size === 2) {
      // 2 本目の指: 動かし始めていない操作はやめて、拡大縮小へ
      if (act && (act.type === 'move' || act.type === 'trim') && act.started) return;
      act = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2) return;
    const touch = e.pointerType === 'touch';
    const h = hit(pt.x, pt.y);
    act = { type: 'none', x0: pt.x, y0: pt.y, touch, shift: e.shiftKey || e.metaKey || e.ctrlKey, id: e.pointerId };
    if (h.kind === 'ruler') {
      act.type = 'scrub';
      hooks.seek(Math.max(0, Math.round(frameAt(pt.x))));
    } else if (h.kind === 'head') {
      act.type = 'head';
      act.row = h.row;
    } else if (h.kind === 'clip') {
      const c = h.clip;
      const locked = Proj.track(p, c.track).locked;
      const edge = locked ? null : edgeOf(c, pt.x, touch);
      act.clip = c;
      if (edge) { act.type = 'pending-trim'; act.edge = edge; }
      else if (!locked && (sel.has(c.id) || !touch)) act.type = 'pending-move';
      else act.type = 'pending-pan';
    } else {
      act.type = 'pending-pan';
    }
    act.sx = scrollX; act.sy = scrollY;
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch.d > 10) zoomAt(d / pinch.d, mx);
      scrollX -= (mx - pinch.mx) / ppf;
      scrollY -= my - pinch.my;
      clampScroll();
      pinch.d = d; pinch.mx = mx; pinch.my = my;
      requestDraw();
      return;
    }
    if (!act || act.id !== e.pointerId) return;
    const dx = pt.x - act.x0, dy = pt.y - act.y0;
    act.x = pt.x; act.y = pt.y;
    const far = Math.hypot(dx, dy) > (act.touch ? 8 : 4);
    if (act.type === 'scrub') { hooks.seek(Math.max(0, Math.round(frameAt(pt.x)))); return; }
    if (act.type === 'pending-pan' && far) act.type = 'pan';
    if (act.type === 'pending-move' && far) startMove();
    if (act.type === 'pending-trim' && far) startTrim();
    if (act.type === 'pan') {
      scrollX = act.sx - dx / ppf;
      scrollY = act.sy - dy;
      clampScroll();
      requestDraw();
    } else if (act.type === 'move') {
      updateMove();
      edgeScroll(pt.x);
    } else if (act.type === 'trim') {
      updateTrim();
      edgeScroll(pt.x);
    }
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; if (!act) return; }
    if (!act || act.id !== e.pointerId) return;
    const a = act;
    act = null;
    autoScroll = 0;
    if (a.type === 'pending-move' || a.type === 'pending-pan' || a.type === 'pending-trim') {
      // 軽く触れただけ = 選ぶ
      if (a.clip) {
        if (multi || a.shift) toggleSelect(a.clip.id);
        else select([a.clip.id], a.clip.id);
      } else if (!multi) clearSelection();
    } else if (a.type === 'head') {
      headTap(a.row, a.x0, a.y0);
    } else if (a.type === 'move' && a.moved) {
      finishMove(a);
    } else if (a.type === 'trim' && a.frame !== undefined) {
      finishTrim(a);
    }
    requestDraw();
  }

  function onWheel(e) {
    if (!p) return;
    e.preventDefault();
    const pt = local(e);
    if (e.ctrlKey || e.metaKey) { zoomAt(Math.exp(-e.deltaY * 0.01), pt.x); return; }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollX += (e.deltaX || e.deltaY) / ppf;
    else scrollY += e.deltaY;
    clampScroll();
    requestDraw();
  }

  // ドラッグ中に端へ寄せたら自動で送る
  function edgeScroll(x) {
    const v = x > W - 36 ? (x - (W - 36)) : x < HEAD_W + 20 ? -(HEAD_W + 20 - x) : 0;
    const was = autoScroll;
    autoScroll = v;
    if (v && !was) {
      const step = () => {
        if (!autoScroll || !act) { autoScroll = 0; return; }
        scrollX += autoScroll * 0.4 / ppf;
        clampScroll();
        if (act.type === 'move') updateMove(); else if (act.type === 'trim') updateTrim();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  // ---- 移動 --------------------------------------------------------------------------
  function startMove() {
    const c = act.clip;
    if (!sel.has(c.id)) select([c.id], c.id);
    act.type = 'move';
    act.sx = scrollX;
    act.ids = selected().filter((id) => !Proj.track(p, p.clips[id].track).locked);
    act.set = new Set(act.ids);
    act.pts = snapPoints(act.set);
    act.started = true;
    updateMove();
  }

  function updateMove() {
    const c = act.clip;
    const df = (act.x - act.x0) / ppf + (scrollX - act.sx);
    let d = Math.round(df);
    const clips = act.ids.map((id) => p.clips[id]);
    const minStart = Math.min(...clips.map((x) => x.start));
    if (minStart + d < 0) d = -minStart;
    const edges = [];
    for (const x of clips) edges.push(x.start + d, Proj.end(x) + d);
    const sn = snapDelta(edges, act.pts);
    act.snapAt = null;
    if (sn.at !== null && minStart + d + sn.d >= 0) { d += sn.d; act.snapAt = sn.at; }
    act.delta = d;
    // 段の移動（同じ種類のトラックの中で）
    const same = rows().filter((r) => r.t.kind === Proj.track(p, c.track).kind);
    const from = same.findIndex((r) => r.t.id === c.track);
    let to = from;
    const yy = act.y;
    for (let i = 0; i < same.length; i++) if (yy >= same[i].y && yy < same[i].y + same[i].h + GAP) to = i;
    if (yy < (same[0] ? same[0].y : 0)) to = 0;
    if (same.length && yy > same[same.length - 1].y + same[same.length - 1].h) to = same.length - 1;
    act.shift = to - from;
    act.moved = act.delta !== 0 || act.shift !== 0;
    requestDraw();
  }

  function moveTargets(a) {
    const map = {};
    const kind = Proj.track(p, a.clip.track).kind;
    const same = rows().filter((r) => r.t.kind === kind);
    for (const id of a.ids) {
      const c = p.clips[id];
      if (Proj.track(p, c.track).kind !== kind) continue;
      const i = same.findIndex((r) => r.t.id === c.track);
      const j = clamp(i + a.shift, 0, same.length - 1);
      if (!same[j].t.locked) map[id] = same[j].t.id;
    }
    return map;
  }

  function finishMove(a) {
    const map = a.shift ? moveTargets(a) : {};
    hooks.edit('移動', () => Proj.moveClips(p, a.ids, a.delta, map, false));
  }

  // ---- トリム --------------------------------------------------------------------------
  function startTrim() {
    const c = act.clip;
    if (!sel.has(c.id)) select([c.id], c.id);
    act.type = 'trim';
    act.sx = scrollX;
    act.limits = Proj.trimLimits(p, c, act.edge);
    act.pts = snapPoints(new Set(Proj.linked(p, c).map((x) => x.id)));
    act.started = true;
    updateTrim();
  }

  function updateTrim() {
    const c = act.clip;
    const base = act.edge === 'start' ? c.start : Proj.end(c);
    let f = Math.round(base + (act.x - act.x0) / ppf + (scrollX - act.sx));
    const sn = snapDelta([f], act.pts);
    f += sn.d;
    act.snapAt = sn.at;
    act.frame = clamp(f, act.limits[0], act.limits[1]);
    requestDraw();
  }

  function finishTrim(a) {
    if (a.frame === (a.edge === 'start' ? a.clip.start : Proj.end(a.clip))) return;
    hooks.edit('トリム', () => Proj.trim(p, a.clip, a.edge, a.frame));
  }

  // ---- トラックの見出し ----------------------------------------------------------
  function headButtons(r) {
    const t = r.t;
    const y = r.y + r.h - 24;
    const btn = (key, label, x, on) => ({ key, label, x, y, w: 22, h: 20, on });
    if (t.kind === 'video') return [btn('mute', '目', 6, !t.muted), btn('lock', '鍵', 30, t.locked)];
    return [btn('mute', 'M', 6, t.muted), btn('solo', 'S', 30, t.solo), btn('lock', '鍵', 54, t.locked)];
  }

  function headTap(r, x, y) {
    for (const b of headButtons(r)) {
      if (x >= b.x - 3 && x <= b.x + b.w + 3 && y >= b.y - 6 && y <= b.y + b.h + 4) {
        hooks.edit(b.key === 'mute' ? (r.t.kind === 'video' ? '表示の切り替え' : 'ミュート') : b.key === 'solo' ? 'ソロ' : 'ロック', () => {
          const t = Proj.track(p, r.t.id);
          if (b.key === 'mute') t.muted = !t.muted;
          else if (b.key === 'solo') t.solo = !t.solo;
          else t.locked = !t.locked;
        });
        return;
      }
    }
    hooks.trackMenu(r.t);
  }

  // ---- 描画 ----------------------------------------------------------------------
  function rulerStep() {
    const f = F();
    const cands = [1, 2, 5, 10, 15].map((x) => x).concat([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => s * f));
    for (const c of cands) if (c * ppf >= 70) return c;
    return 3600 * f;
  }

  function labelOf(fr) {
    const f = F();
    const s = fr / f;
    if (Math.abs(s - Math.round(s)) > 1e-6) return (Math.round(fr - Math.floor(s) * f)) + 'f';
    const S = Math.round(s);
    return S >= 3600 ? `${Math.floor(S / 3600)}:${String(Math.floor(S / 60) % 60).padStart(2, '0')}:${String(S % 60).padStart(2, '0')}` : `${Math.floor(S / 60)}:${String(S % 60).padStart(2, '0')}`;
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  const COLORS = {
    video: ['#2f5f9e', '#3d74bd'], image: ['#6a4f9c', '#7f62b8'], audio: ['#2d7a55', '#379067'], fill: ['#7a6a3a', '#93804a'],
  };

  function clipKind(c) {
    if (!c.media) return c.fill ? 'fill' : 'video';
    const m = p.media[c.media];
    if (!m) return 'video';
    if (Proj.track(p, c.track).kind === 'audio') return 'audio';
    return m.kind === 'image' ? 'image' : 'video';
  }

  function drawThumbs(c, x0, x1, y, h, cx0, cx1) {
    const r = Media.rec(c.media);
    if (!r || !r.thumbs || !r.thumbs.length) return;
    const m = p.media[c.media];
    const th = h - 18;
    const tw = Math.max(12, th * (m.width && m.height ? m.width / m.height : 16 / 9));
    const n = r.thumbs.length;
    const first = Math.max(0, Math.floor((cx0 - x0) / tw));
    for (let i = first; x0 + i * tw < cx1; i++) {
      const tx = x0 + i * tw;
      let idx = 0;
      if (m.kind !== 'image' && m.duration > 0) {
        const fr = frameAt(tx + tw / 2);
        const s = Proj.srcAt(p, c, Math.min(fr, Proj.end(c) - 1));
        idx = clamp(Math.floor(s / m.duration * n), 0, n - 1);
      }
      const img = Media.thumbImage(r.thumbs[idx], requestDraw);
      if (img) g.drawImage(img, tx, y + 16, tw, th);
    }
  }

  function drawWave(c, x0, x1, y, h, cx0, cx1) {
    const r = Media.rec(c.media);
    if (!r || !r.peaks) return;
    const peaks = r.peaks;
    const rate = r.peaks_rate || 100;
    const mid = y + 16 + (h - 18) / 2;
    const amp = (h - 20) / 2;
    const span = c.speed / (ppf * F()) * rate;     // 1 画素あたりの値の数
    g.fillStyle = 'rgba(210,255,225,0.75)';
    const a = Math.max(Math.floor(cx0), Math.floor(x0)), b = Math.min(Math.ceil(cx1), Math.ceil(x1));
    for (let x = a; x < b; x++) {
      const s = Proj.srcAt(p, c, frameAt(x)) - (r.audio_offset || 0);
      let i0 = Math.floor(s * rate);
      const i1 = Math.max(i0 + 1, Math.floor(s * rate + span));
      let m = 0;
      const step = Math.max(1, Math.floor((i1 - i0) / 24));
      for (let i = Math.max(0, i0); i < i1 && i < peaks.length; i += step) if (peaks[i] > m) m = peaks[i];
      if (!m) continue;
      const hh = Math.max(1, m / 255 * amp * dbToGain(c.volume_db || 0));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
  }

  function drawClip(c, r, x0, x1, ghost) {
    const kind = clipKind(c);
    const [col, colSel] = COLORS[kind];
    const isSel = sel.has(c.id);
    const y = r.y + 1, h = r.h - 2;
    const cx0 = Math.max(x0, HEAD_W), cx1 = Math.min(x1, W);
    if (cx1 <= cx0) return;
    g.save();
    if (ghost) g.globalAlpha = 0.55;
    roundRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0 - 1), h - 1, 5);
    g.fillStyle = isSel ? colSel : col;
    g.fill();
    g.save();
    g.clip();
    if (!c.enabled) g.globalAlpha *= 0.4;
    if (kind === 'audio') drawWave(c, x0, x1, y, h, cx0, cx1);
    else if (c.media) drawThumbs(c, x0, x1, y, h, cx0, cx1);
    // 名前の帯
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x0, y, x1 - x0, 15);
    g.fillStyle = '#fff';
    g.font = '11px -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif';
    g.textBaseline = 'middle';
    const label = c.name || (p.media[c.media] && p.media[c.media].name) || '';
    g.fillText(label + (c.speed !== 1 ? `（${c.speed}倍）` : ''), Math.max(x0, HEAD_W) + 5, y + 8);
    // フェードの斜線
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 1;
    if (c.fade_in > 0) { g.beginPath(); g.moveTo(x0, y + h); g.lineTo(x0 + c.fade_in * ppf, y + 15); g.stroke(); }
    if (c.fade_out > 0) { g.beginPath(); g.moveTo(x1 - c.fade_out * ppf, y + 15); g.lineTo(x1, y + h); g.stroke(); }
    g.restore();
    roundRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0 - 1), h - 1, 5);
    g.lineWidth = isSel ? 2 : 1;
    g.strokeStyle = isSel ? '#ffd23f' : 'rgba(255,255,255,0.25)';
    g.stroke();
    if (isSel && !ghost && x1 - x0 > 16) {
      g.fillStyle = '#ffd23f';
      roundRect(x0 + 1, y + 16, 5, h - 20, 2); g.fill();
      roundRect(x1 - 6, y + 16, 5, h - 20, 2); g.fill();
    }
    g.restore();
  }

  function draw() {
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, W, H);
    if (!p) return;
    clampScroll();
    const R = rows();
    const f0 = Math.floor(frameAt(HEAD_W)), f1 = Math.ceil(frameAt(W));
    // 段
    for (const r of R) {
      g.fillStyle = r.t.kind === 'video' ? '#1d2026' : '#1b2220';
      g.fillRect(HEAD_W, r.y, W - HEAD_W, r.h);
    }
    // 目盛りの縦線
    const step = rulerStep();
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    for (let f = Math.floor(f0 / step) * step; f <= f1; f += step) {
      const x = Math.round(xOf(f)) + 0.5;
      g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, H); g.stroke();
    }
    // クリップ
    const moving = act && act.type === 'move' && act.moved ? act.set : null;
    const trimming = act && act.type === 'trim' && act.frame !== undefined ? act : null;
    const trimSet = trimming ? new Set(Proj.linked(p, trimming.clip).map((c) => c.id)) : null;
    for (const r of R) {
      for (const c of Proj.clipsOn(p, r.t.id)) {
        if (Proj.end(c) < f0 || c.start > f1) continue;
        let x0 = xOf(c.start), x1 = xOf(Proj.end(c));
        if (trimSet && trimSet.has(c.id)) {
          const d = trimming.frame - (trimming.edge === 'start' ? trimming.clip.start : Proj.end(trimming.clip));
          if (trimming.edge === 'start') x0 += d * ppf; else x1 += d * ppf;
        }
        drawClip(c, r, x0, x1, moving && moving.has(c.id));
      }
    }
    // 移動中の影
    if (moving) {
      const map = act.shift ? moveTargets(act) : {};
      for (const id of act.ids) {
        const c = p.clips[id];
        const r = rowOf(map[id] || c.track);
        if (!r) continue;
        const x0 = xOf(c.start + act.delta), x1 = xOf(Proj.end(c) + act.delta);
        g.save();
        roundRect(x0 + 0.5, r.y + 1.5, Math.max(2, x1 - x0 - 1), r.h - 3, 5);
        g.strokeStyle = '#ffd23f'; g.lineWidth = 2; g.setLineDash([5, 3]); g.stroke();
        g.fillStyle = 'rgba(255,210,63,0.15)'; g.fill();
        g.restore();
      }
    }
    // スナップの線
    const snapAt = act && (act.type === 'move' || act.type === 'trim') ? act.snapAt : null;
    if (snapAt !== null && snapAt !== undefined) {
      const x = Math.round(xOf(snapAt)) + 0.5;
      g.strokeStyle = '#7fd1ff'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, H); g.stroke();
    }
    // 目盛り
    g.fillStyle = '#23262c';
    g.fillRect(HEAD_W, 0, W - HEAD_W, RULER_H);
    g.fillStyle = '#aab';
    g.font = '10px -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif';
    g.textBaseline = 'top';
    g.strokeStyle = '#667';
    for (let f = Math.floor(f0 / step) * step; f <= f1; f += step) {
      const x = Math.round(xOf(f)) + 0.5;
      if (x < HEAD_W) continue;
      g.beginPath(); g.moveTo(x, RULER_H - 9); g.lineTo(x, RULER_H); g.stroke();
      g.fillText(labelOf(f), x + 3, 5);
      const sub = step / 5;
      if (sub * ppf >= 8) for (let k = 1; k < 5; k++) {
        const xs = Math.round(xOf(f + sub * k)) + 0.5;
        g.beginPath(); g.moveTo(xs, RULER_H - 4); g.lineTo(xs, RULER_H); g.stroke();
      }
    }
    // マーカー
    for (const m of p.markers) {
      const x = xOf(m.frame);
      if (x < HEAD_W || x > W) continue;
      g.fillStyle = m.color || '#e0b030';
      g.beginPath(); g.moveTo(x - 6, 14); g.lineTo(x + 6, 14); g.lineTo(x, RULER_H - 2); g.closePath(); g.fill();
      g.strokeStyle = (m.color || '#e0b030') + '66';
      g.beginPath(); g.moveTo(x + 0.5, RULER_H); g.lineTo(x + 0.5, H); g.stroke();
    }
    // 再生ヘッド
    const ph = xOf(Engine.position());
    if (ph >= HEAD_W && ph <= W) {
      g.strokeStyle = '#ff4d4d'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(ph, RULER_H - 6); g.lineTo(ph, H); g.stroke();
      g.fillStyle = '#ff4d4d';
      g.beginPath(); g.moveTo(ph - 7, 0); g.lineTo(ph + 7, 0); g.lineTo(ph + 7, 10); g.lineTo(ph, RULER_H - 6); g.lineTo(ph - 7, 10); g.closePath(); g.fill();
    }
    // 見出し
    g.fillStyle = '#23262c';
    g.fillRect(0, 0, HEAD_W, H);
    for (const r of R) {
      if (r.y + r.h < RULER_H) continue;
      g.fillStyle = r.t.kind === 'video' ? '#262a32' : '#25302b';
      g.fillRect(0, r.y, HEAD_W - 1, r.h);
      g.fillStyle = '#dde';
      g.font = 'bold 12px -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif';
      g.textBaseline = 'top';
      g.fillText(r.t.name, 8, r.y + 6);
      g.font = '11px -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif';
      g.textBaseline = 'middle';
      for (const b of headButtons(r)) {
        const danger = (b.key === 'mute' && r.t.kind === 'audio' && b.on) || (b.key === 'lock' && b.on);
        g.fillStyle = b.on ? (danger ? '#b94a3f' : b.key === 'solo' ? '#c9a227' : '#3d74bd') : '#3a3f48';
        roundRect(b.x, b.y, b.w, b.h, 4); g.fill();
        g.fillStyle = '#fff';
        g.fillText(b.label, b.x + b.w / 2 - g.measureText(b.label).width / 2, b.y + b.h / 2 + 1);
      }
    }
    g.fillStyle = '#23262c';
    g.fillRect(0, 0, HEAD_W, RULER_H);
    g.fillStyle = '#aab';
    g.font = '11px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    g.fillText(fmtTC(Engine.position(), F()).slice(3), 6, RULER_H / 2);
  }

  return {
    init, setProject, draw: requestDraw, resize, zoom, fitAll, follow, select, toggleSelect, clearSelection, prune, selected,
    primaryClip, geom: () => ({ ppf, scrollX, scrollY, HEAD_W, rows: rows().map((r) => ({ id: r.t.id, y: r.y, h: r.h })) }),
    setMulti: (v) => { multi = v; }, setSnap: (v) => { snapOn = v; }, get snap() { return snapOn; }, get multi() { return multi; },
  };
})();
