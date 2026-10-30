/* ------------------------------------------------------------
   作品（プロジェクト）のデータと編集の操作

   形は映工房（exe）の .ekp に合わせてある（フィールド名・単位とも同じ）。
   - 時刻はタイムラインのフレーム（整数）。素材の位置 src_in は秒。
   - clips は {ID: クリップ}。映像と音声は別のクリップで、同じ link の値で一緒に動く。
   - 編集は「移動先・トリム先は上書き」（exe の edit.py と同じ規則）。
   ------------------------------------------------------------ */
const Proj = (() => {
  const SCHEMA = 1;

  const TRACK_DEFAULTS = { muted: false, locked: false, volume_db: 0, solo: false, pan: 0 };
  const CLIP_DEFAULTS = {
    media: null, src_in: 0, speed: 1, link: null, enabled: true, name: '',
    opacity: 1, pos_x: 0, pos_y: 0, scale: 1, rotation: 0, fit: 'fit',
    volume_db: 0, fade_in: 0, fade_out: 0,
    text: null, style: null, keys: null, trans_in: null, grade: null, crop: null, fill: null, afx: null, motion: null,
  };

  function create(name = '無題の作品') {
    const now = Date.now();
    return normalize({
      schema: SCHEMA, id: uid('p'), name, created: now, modified: now,
      width: 1920, height: 1080, fps_num: 30, fps_den: 1, sample_rate: 48000,
      media: {}, clips: {}, markers: [], in_point: null, out_point: null, playhead: 0, master_db: 0,
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1' },
        { id: 'v2', kind: 'video', name: 'V2' },
        { id: 'a1', kind: 'audio', name: 'A1' },
        { id: 'a2', kind: 'audio', name: 'A2' },
      ],
      configured: false,
    });
  }

  /** 読み込んだ作品の足りない値を埋める */
  function normalize(p) {
    p.media = p.media || {};
    p.clips = p.clips || {};
    p.markers = p.markers || [];
    p.tracks = (p.tracks || []).map((t) => ({ ...TRACK_DEFAULTS, ...t }));
    for (const id of Object.keys(p.clips)) p.clips[id] = { ...CLIP_DEFAULTS, ...p.clips[id], id };
    if (!p.fps_num) { p.fps_num = 30; p.fps_den = 1; }
    if (!p.sample_rate) p.sample_rate = 48000;
    if (p.master_db === undefined) p.master_db = 0;
    return p;
  }

  const fps = (p) => p.fps_num / (p.fps_den || 1);
  const end = (c) => c.start + c.duration;
  const track = (p, id) => p.tracks.find((t) => t.id === id) || null;
  const tracksOf = (p, kind) => p.tracks.filter((t) => t.kind === kind);
  const clipsOn = (p, tid) => Object.values(p.clips).filter((c) => c.track === tid).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const duration = (p) => Object.values(p.clips).reduce((m, c) => Math.max(m, end(c)), 0);
  const linked = (p, c) => (c.link ? Object.values(p.clips).filter((x) => x.link === c.link) : [c]);
  /** タイムラインの frame（小数可）で見える素材の位置（秒） */
  const srcAt = (p, c, frame) => c.src_in + (frame - c.start) / fps(p) * c.speed;

  function clone(c, changes) {
    return { ...JSON.parse(JSON.stringify(c)), ...changes };
  }

  function limited(p, c) {
    if (!c.media) return false;
    const m = p.media[c.media];
    return !!m && m.kind !== 'image';
  }

  function withLinks(p, ids) {
    const seen = new Map();
    for (const id of ids) {
      const c = p.clips[id];
      if (!c) continue;
      for (const x of linked(p, c)) seen.set(x.id, x);
    }
    return [...seen.values()];
  }

  // ---- 範囲の計算（exe と同じ） ------------------------------------------------
  function mergeRanges(ranges) {
    const out = [];
    for (const [a, b] of ranges.map(([a, b]) => [Math.trunc(a), Math.trunc(b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
      else out.push([a, b]);
    }
    return out;
  }

  function subtractRanges(a, b, ranges) {
    const out = [];
    let cur = a;
    for (const [ra, rb] of ranges) {
      if (rb <= cur) continue;
      if (ra >= b) break;
      if (ra > cur) out.push([cur, Math.min(ra, b)]);
      cur = Math.max(cur, rb);
      if (cur >= b) break;
    }
    if (cur < b) out.push([cur, b]);
    return out;
  }

  function removedBefore(frame, ranges) {
    let total = 0;
    for (const [a, b] of ranges) {
      if (b <= frame) total += b - a;
      else if (a < frame) total += frame - a;
      else break;
    }
    return total;
  }

  const unlockedTracks = (p, kinds) => p.tracks.filter((t) => !t.locked && (!kinds || kinds.includes(t.kind))).map((t) => t.id);

  // ---- 置く・消す --------------------------------------------------------------
  /** track の [a, b) を空ける（はみ出したクリップは切り詰め・分割） */
  function clearRange(p, tid, a, b, exclude = new Set()) {
    if (b <= a) return;
    const f = fps(p);
    for (const c of clipsOn(p, tid)) {
      if (exclude.has(c.id) || end(c) <= a || c.start >= b) continue;
      if (c.start >= a && end(c) <= b) {
        delete p.clips[c.id];
      } else if (c.start < a && end(c) > b) {
        const right = clone(c, { id: uid('c'), link: null, trans_in: null, fade_in: 0 });
        right.src_in = c.src_in + (b - c.start) / f * c.speed;
        right.duration = end(c) - b;
        right.start = b;
        p.clips[right.id] = right;
        c.duration = a - c.start;
        c.fade_out = 0;
      } else if (c.start < a) {
        c.duration = a - c.start;
        c.fade_out = 0;
      } else {
        const cut = b - c.start;
        c.src_in += cut / f * c.speed;
        c.start = b;
        c.duration -= cut;
        c.trans_in = null;
        c.fade_in = 0;
      }
    }
  }

  function addClip(p, clip, overwrite = true) {
    if (clip.duration <= 0) throw new Error('長さ 0 のクリップは置けません');
    if (clip.start < 0) clip.start = 0;
    if (overwrite) clearRange(p, clip.track, clip.start, end(clip), new Set([clip.id]));
    p.clips[clip.id] = { ...CLIP_DEFAULTS, ...clip };
    return p.clips[clip.id];
  }

  function isFree(p, tid, a, b) {
    return !clipsOn(p, tid).some((c) => c.start < b && end(c) > a);
  }

  /** kind のトラックで [a, b) が空いている最初のもの（無ければ足す） */
  function freeTrack(p, kind, a, b, prefer) {
    const list = tracksOf(p, kind).filter((t) => !t.locked);
    if (prefer) {
      const t = list.find((x) => x.id === prefer);
      if (t && isFree(p, t.id, a, b)) return t.id;
    }
    for (const t of list) if (isFree(p, t.id, a, b)) return t.id;
    return addTrack(p, kind).id;
  }

  function addTrack(p, kind) {
    const same = tracksOf(p, kind);
    const letter = kind === 'video' ? 'V' : 'A';
    let n = same.length + 1;
    while (p.tracks.some((t) => t.name === letter + n)) n++;
    const t = { ...TRACK_DEFAULTS, id: uid(kind === 'video' ? 'v' : 'a'), kind, name: letter + n };
    // 同じ種類の最後の後ろに入れる
    const lastIdx = p.tracks.lastIndexOf(same[same.length - 1]);
    p.tracks.splice(lastIdx >= 0 ? lastIdx + 1 : p.tracks.length, 0, t);
    return t;
  }

  function mediaFrames(p, m) {
    if (m.kind === 'image') return Math.round(5 * fps(p));
    return Math.max(1, Math.floor(m.duration * fps(p) + 1e-6));
  }

  /** 素材を frame に置く（空いているトラックへ、映像と音声はリンクして）。置いたクリップを返す */
  function insertMedia(p, m, frame, opts = {}) {
    const dur = mediaFrames(p, m);
    const out = [];
    const hasV = m.has_video || m.kind === 'image';
    const link = hasV && m.has_audio ? uid('l') : null;
    const base = { start: Math.max(0, Math.round(frame)), duration: dur, media: m.id, src_in: 0, link, name: m.name };
    if (hasV) {
      const tid = opts.vtrack || freeTrack(p, 'video', base.start, base.start + dur);
      out.push(addClip(p, { ...base, id: uid('c'), track: tid }, true));
    }
    if (m.has_audio) {
      const tid = opts.atrack || freeTrack(p, 'audio', base.start, base.start + dur);
      out.push(addClip(p, { ...base, id: uid('c'), track: tid }, true));
    }
    return out;
  }

  function deleteClips(p, ids, ripple = false, followLinks = true) {
    const clips = followLinks ? withLinks(p, ids) : ids.map((i) => p.clips[i]).filter(Boolean);
    const spans = mergeRanges(clips.map((c) => [c.start, end(c)]));
    for (const c of clips) delete p.clips[c.id];
    if (ripple) {
      // 消した範囲のうち、どのトラックにも何も無くなった部分だけを詰める（同期を崩さない）
      const tracks = unlockedTracks(p);
      let gaps = [];
      for (const [a, b] of spans) gaps = gaps.concat(emptyRanges(p, a, b, tracks));
      rippleDeleteRanges(p, gaps, tracks);
    }
  }

  function emptyRanges(p, a, b, trackIds) {
    const occupied = mergeRanges(Object.values(p.clips).filter((c) => trackIds.includes(c.track) && end(c) > a && c.start < b).map((c) => [c.start, end(c)]));
    return subtractRanges(a, b, occupied);
  }

  /** 範囲を消して後ろを詰める。消えたフレーム数を返す */
  function rippleDeleteRanges(p, ranges, trackIds) {
    ranges = mergeRanges(ranges);
    if (!ranges.length) return 0;
    const tracks = new Set(trackIds || unlockedTracks(p));
    const f = fps(p);
    const relink = new Map();
    const taken = new Set();
    for (const c of Object.values(p.clips).sort((a, b) => a.start - b.start)) {
      if (!tracks.has(c.track)) continue;
      const pieces = subtractRanges(c.start, end(c), ranges);
      if (pieces.length === 1 && pieces[0][0] === c.start && pieces[0][1] === end(c)) {
        c.start -= removedBefore(c.start, ranges);
        continue;
      }
      delete p.clips[c.id];
      pieces.forEach(([ps, pe], i) => {
        const piece = clone(c, { id: i === 0 ? c.id : uid('c') });
        piece.src_in = c.src_in + (ps - c.start) / f * c.speed;
        piece.start = ps - removedBefore(ps, ranges);
        piece.duration = pe - ps;
        if (ps !== c.start) { piece.fade_in = 0; piece.trans_in = null; }
        if (pe !== end(c)) piece.fade_out = 0;
        if (c.link) {
          const key = c.link + '@' + ps;
          if (!relink.has(key)) {
            const v = taken.has(c.link) ? uid('l') : c.link;
            relink.set(key, v);
            taken.add(v);
          }
          piece.link = relink.get(key);
        }
        p.clips[piece.id] = piece;
      });
    }
    const kept = [];
    for (const m of p.markers) {
      if (m.end !== null && m.end !== undefined) {
        const rest = subtractRanges(m.frame, m.end, ranges);
        if (!rest.length) continue;
        m.frame = rest[0][0] - removedBefore(rest[0][0], ranges);
        m.end = rest[rest.length - 1][1] - removedBefore(rest[rest.length - 1][1], ranges);
        kept.push(m);
        continue;
      }
      if (ranges.some(([a, b]) => a <= m.frame && m.frame < b)) continue;
      m.frame -= removedBefore(m.frame, ranges);
      kept.push(m);
    }
    p.markers = kept;
    if (p.playhead) p.playhead -= removedBefore(p.playhead, ranges);
    return ranges.reduce((s, [a, b]) => s + b - a, 0);
  }

  // ---- 分割・トリム・移動 ----------------------------------------------------
  function splitClip(p, c, frame) {
    if (!(c.start < frame && frame < end(c))) return null;
    const cut = frame - c.start;
    const right = clone(c, { id: uid('c'), start: frame, duration: c.duration - cut, fade_in: 0, trans_in: null });
    right.src_in = c.src_in + cut / fps(p) * c.speed;
    c.fade_out = 0;
    c.duration = cut;
    p.clips[right.id] = right;
    return right;
  }

  /** frame で分割。ids を渡せばそれ（とリンク相手）、無ければ鍵の掛かっていない全トラック。右側の一覧を返す */
  function splitAt(p, frame, ids) {
    frame = Math.round(frame);
    const targets = ids && ids.length
      ? withLinks(p, ids).filter((c) => c.start < frame && frame < end(c))
      : Object.values(p.clips).filter((c) => c.start < frame && frame < end(c));
    const relink = new Map();
    const rights = [];
    for (const c of targets) {
      const t = track(p, c.track);
      if (t && t.locked) continue;
      const r = splitClip(p, c, frame);
      if (!r) continue;
      if (c.link) {
        if (!relink.has(c.link)) relink.set(c.link, uid('l'));
        r.link = relink.get(c.link);
      }
      rights.push(r);
    }
    return rights;
  }

  /** トリムで動かせる範囲 [最小, 最大]（edge の位置のフレーム、リンク相手も含めて） */
  function trimLimits(p, c, edge) {
    const f = fps(p);
    let lo = -Infinity, hi = Infinity;
    for (const x of linked(p, c)) {
      const d = edge === 'start' ? x.start - c.start : end(x) - end(c);   // 相手と自分の差
      if (edge === 'start') {
        const minStart = limited(p, x) ? x.start - Math.floor(x.src_in / x.speed * f + 1e-6) : 0;
        lo = Math.max(lo, Math.max(0, minStart) - d);
        hi = Math.min(hi, end(x) - 1 - d);
      } else {
        lo = Math.max(lo, x.start + 1 - d);
        if (limited(p, x)) {
          const m = p.media[x.media];
          hi = Math.min(hi, x.start + Math.floor((m.duration - x.src_in) / x.speed * f + 1e-6) - d);
        }
      }
    }
    return [lo, hi];
  }

  /** edge ('start' / 'end') を frame へ（範囲は trimLimits に収める）。隣と重なる分は上書き */
  function trim(p, c, edge, frame, followLinks = true) {
    const [lo, hi] = trimLimits(p, c, edge);
    frame = clamp(Math.round(frame), lo, hi);
    const f = fps(p);
    const targets = followLinks ? linked(p, c) : [c];
    const delta = frame - (edge === 'start' ? c.start : end(c));
    if (!delta) return 0;
    for (const x of targets) {
      if (edge === 'start') {
        x.src_in = Math.max(0, x.src_in + delta / f * x.speed);
        x.start += delta;
        x.duration -= delta;
      } else {
        x.duration += delta;
      }
      x.fade_in = Math.min(x.fade_in, x.duration);
      x.fade_out = Math.min(x.fade_out, x.duration);
      clearRange(p, x.track, x.start, end(x), new Set([x.id]));
    }
    return delta;
  }

  /**
   * クリップ（とリンク相手）を delta フレーム動かす。trackMap は {クリップ ID: 移動先トラック ID}（無ければそのまま）。
   * 移動先は上書き。
   */
  function moveClips(p, ids, delta, trackMap = {}, followLinks = true) {
    const clips = followLinks ? withLinks(p, ids) : ids.map((i) => p.clips[i]).filter(Boolean);
    if (!clips.length) return;
    const minStart = Math.min(...clips.map((c) => c.start));
    if (minStart + delta < 0) delta = -minStart;
    const moving = new Set(clips.map((c) => c.id));
    for (const c of clips) {
      c.start += delta;
      const dest = trackMap[c.id];
      if (dest && track(p, dest) && track(p, dest).kind === track(p, c.track).kind && !track(p, dest).locked) c.track = dest;
    }
    for (const c of clips) clearRange(p, c.track, c.start, end(c), moving);
  }

  function unlink(p, ids) {
    for (const c of withLinks(p, ids)) c.link = null;
  }

  /** 速さを変える（長さも変わる） */
  function setSpeed(p, c, speed) {
    speed = clamp(speed, 0.1, 16);
    const srcLen = c.duration * c.speed;
    c.speed = speed;
    c.duration = Math.max(1, Math.round(srcLen / speed));
    if (limited(p, c)) {
      const m = p.media[c.media];
      const maxDur = Math.floor((m.duration - c.src_in) / speed * fps(p) + 1e-6);
      c.duration = Math.max(1, Math.min(c.duration, maxDur));
    }
    clearRange(p, c.track, c.start, end(c), new Set([c.id]));
  }

  /** 作品の fps を変える（フレームで持っている値を同じ秒数になるよう直す） */
  function setFps(p, num, den = 1) {
    const k = (num / den) / fps(p);
    if (Math.abs(k - 1) > 1e-9) {
      for (const c of Object.values(p.clips)) {
        const s = Math.round(c.start * k);
        const e = Math.round(end(c) * k);
        c.start = s;
        c.duration = Math.max(1, e - s);
        c.fade_in = Math.round(c.fade_in * k);
        c.fade_out = Math.round(c.fade_out * k);
      }
      for (const m of p.markers) {
        m.frame = Math.round(m.frame * k);
        if (m.end !== null && m.end !== undefined) m.end = Math.round(m.end * k);
      }
      p.playhead = Math.round((p.playhead || 0) * k);
    }
    p.fps_num = num;
    p.fps_den = den;
  }

  function checkOverlaps(p) {
    const problems = [];
    for (const t of p.tracks) {
      let prev = null;
      for (const c of clipsOn(p, t.id)) {
        if (c.duration <= 0) problems.push(c.id + ' の長さが 0 以下');
        if (prev && c.start < end(prev)) problems.push(t.name + ': ' + prev.id + ' と ' + c.id + ' が重なっている');
        prev = c;
      }
    }
    return problems;
  }

  // ---- 履歴 ---------------------------------------------------------------------
  const SNAP_KEYS = ['width', 'height', 'fps_num', 'fps_den', 'media', 'tracks', 'clips', 'markers', 'in_point', 'out_point', 'master_db'];
  const snapshot = (p) => JSON.stringify(SNAP_KEYS.map((k) => p[k]));
  function restore(p, s) {
    const v = JSON.parse(s);
    SNAP_KEYS.forEach((k, i) => { p[k] = v[i]; });
  }

  class History {
    constructor(limit = 100) { this.undo = []; this.redo = []; this.limit = limit; }
    push(label, before, after) {
      this.undo.push({ label, before, after });
      if (this.undo.length > this.limit) this.undo.shift();
      this.redo = [];
    }
    clear() { this.undo = []; this.redo = []; }
  }

  return {
    SCHEMA, CLIP_DEFAULTS, create, normalize, fps, end, track, tracksOf, clipsOn, duration, linked, srcAt, withLinks, limited,
    mergeRanges, subtractRanges, removedBefore, clearRange, addClip, isFree, freeTrack, addTrack, mediaFrames, insertMedia,
    deleteClips, emptyRanges, rippleDeleteRanges, splitAt, trimLimits, trim, moveClips, unlink, setSpeed, setFps,
    checkOverlaps, snapshot, restore, History,
  };
})();

if (typeof module !== 'undefined') module.exports = Proj;
