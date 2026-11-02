/* ------------------------------------------------------------
   映工房（Windows 版）の .ekp とのやり取り
   - .ekp は {app: "eikobo", format: 3, playhead, settings: [幅, 高さ, fps の分子, 分母, 標本化周波数], media, tracks, clips,
     markers, io: [イン, アウト], subtitle_style, transcript, master: [マスター音量, リミッター, ダッキング]}
     （exe の Project.to_json / from_json）。項目名はもともと同じにしてあるので、形を整えるだけ。
   - 書き出し: ZIP に project.ekp・media/<素材>・luts/<LUT>.cube。素材の場所は .ekp からの相対パス（rel_path）で書くので、
     Windows で展開して .ekp を開けばそのまま見つかる。LUT も相対パス（exe は .ekp の場所から探す）。
   - 読み込み: .ekp だけ、または ZIP（.ekp と素材）。素材は rel_path → ファイル名の順で探し、見つかった物は同じ ID で取り込む。
   ------------------------------------------------------------ */
const Ekp = (() => {
  const FORMAT = 3;
  const MEDIA_FIELDS = ['id', 'path', 'name', 'kind', 'duration', 'fps', 'width', 'height', 'has_video', 'has_audio', 'audio_rate', 'audio_channels', 'rotation', 'rel_path'];
  const TRACK_FIELDS = ['id', 'kind', 'name', 'muted', 'locked', 'volume_db', 'solo', 'pan'];
  const CLIP_FIELDS = ['id', 'track', 'start', 'duration'].concat(Object.keys(Proj.CLIP_DEFAULTS));
  const MARKER_FIELDS = ['frame', 'name', 'color', 'end', 'kind'];

  const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const baseName = (s) => String(s || '').replace(/\\/g, '/').split('/').pop();
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');

  /** 作品 → .ekp の中身。mediaPaths = {素材 ID: 相対パス}、lutPaths = {LUT の参照: 相対パス} */
  function toJson(p, mediaPaths = {}, lutPaths = {}) {
    const media = {};
    for (const [id, m] of Object.entries(p.media)) {
      const rel = mediaPaths[id] || '';
      media[id] = { ...pick(m, MEDIA_FIELDS), id, path: rel || m.name, rel_path: rel };
    }
    const clips = {};
    for (const [id, c] of Object.entries(p.clips)) {
      const o = clone(pick(c, CLIP_FIELDS));
      o.id = id;
      if (o.grade && o.grade.lut && lutPaths[o.grade.lut]) o.grade.lut = lutPaths[o.grade.lut];
      clips[id] = o;
    }
    return {
      app: 'eikobo', format: FORMAT, playhead: Math.round(p.playhead || 0),
      settings: [p.width, p.height, p.fps_num, p.fps_den || 1, p.sample_rate || 48000],
      media, tracks: p.tracks.map((t) => pick(t, TRACK_FIELDS)), clips,
      markers: (p.markers || []).map((m) => ({ name: '', color: '#e0b030', end: null, kind: '', ...pick(m, MARKER_FIELDS) })),
      io: [p.in_point ?? null, p.out_point ?? null],
      subtitle_style: clone(p.subtitle_style || Telop.defaultSubtitleStyle()),
      transcript: p.transcript || null,
      master: [p.master_db || 0, clone(p.limiter || { on: true, ceiling: -1 }), p.ducking ? clone(p.ducking) : null],
    };
  }

  /** .ekp の中身 → 新しい作品（素材のファイルはまだ無い） */
  function fromJson(data, name) {
    if (!data || data.app !== 'eikobo') throw new Error('映工房のプロジェクトファイルではありません');
    if (Number(data.format || 0) > FORMAT) throw new Error('新しい版の映工房で保存されたファイルです');
    const p = Proj.create(name);
    const [w, h, num, den, sr] = data.settings || [1920, 1080, 30, 1, 48000];
    Object.assign(p, { width: w, height: h, fps_num: num, fps_den: den || 1, sample_rate: sr || 48000, configured: true });
    p.media = {};
    for (const [id, m] of Object.entries(data.media || {})) p.media[id] = { ...pick(m, MEDIA_FIELDS), id, name: m.name || baseName(m.path) };
    p.tracks = (data.tracks || []).map((t) => pick(t, TRACK_FIELDS));
    p.clips = {};
    for (const [id, c] of Object.entries(data.clips || {})) p.clips[id] = { ...pick(c, CLIP_FIELDS), id };
    p.markers = (data.markers || []).map((m) => pick(m, MARKER_FIELDS));
    [p.in_point, p.out_point] = data.io || [null, null];
    p.subtitle_style = { ...Telop.defaultSubtitleStyle(), ...(data.subtitle_style || {}) };
    p.transcript = data.transcript || null;
    const master = data.master || [0, { on: true, ceiling: -1 }, null];
    p.master_db = Number(master[0]) || 0;
    p.limiter = { on: true, ceiling: -1, ...(master[1] || {}) };
    p.ducking = master[2] || null;
    p.playhead = Number(data.playhead || 0);
    return Proj.normalize(p);
  }

  // ---- 書き出し ---------------------------------------------------------------
  /** 作品を ZIP に。withMedia なら素材も入れる。返り値 File */
  async function exportZip(p, withMedia, onProgress) {
    const entries = [];
    const mediaPaths = {};
    const used = new Set();
    const unique = (dir, name) => {
      let n = safe(name), k = 2;
      const dot = n.lastIndexOf('.');
      while (used.has(dir + n.toLowerCase())) { n = dot > 0 ? `${safe(name).slice(0, dot)} (${k})${safe(name).slice(dot)}` : `${safe(name)} (${k})`; k++; }
      used.add(dir + n.toLowerCase());
      return dir + n;
    };
    const missing = [];
    for (const [id, m] of Object.entries(p.media)) {
      if (!withMedia) { mediaPaths[id] = 'media/' + safe(m.name); continue; }
      const f = await Store.readFile(id);
      if (!f) { missing.push(m.name); continue; }
      const path = unique('media/', m.name);
      mediaPaths[id] = path;
      entries.push({ name: path, blob: f });
    }
    const lutPaths = {};
    for (const c of Object.values(p.clips)) {
      const ref = c.grade && c.grade.lut;
      if (!ref || !ref.startsWith('user:') || lutPaths[ref]) continue;
      const rec = await Store.get('luts', ref.slice(5));
      if (!rec) continue;
      const path = unique('luts/', (rec.file || rec.name + '.cube'));
      lutPaths[ref] = path;
      entries.push({ name: path, blob: new Blob([rec.text], { type: 'text/plain' }) });
    }
    const json = JSON.stringify(toJson(p, mediaPaths, lutPaths), null, 1);
    entries.unshift({ name: safe(p.name || 'project') + '.ekp', blob: new Blob([json], { type: 'application/json' }) });
    const sink = await Store.openStream('bundle.zip');
    try {
      await Zip.write(entries, sink, onProgress);
      const body = await sink.close();
      return { file: new File([body], safe(p.name || '映工房') + '.zip', { type: 'application/zip' }), missing };
    } catch (err) { await sink.abort(); throw err; }
  }

  // ---- 読み込み ---------------------------------------------------------------
  /** パスをつなぐ（.. と . を解く） */
  function joinPath(base, rel) {
    const parts = (base ? base.split('/') : []).concat(String(rel).replace(/\\/g, '/').split('/'));
    const out = [];
    for (const s of parts) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return out.join('/');
  }

  /**
   * .ekp か ZIP を読み込んで新しい作品を作る。返り値 {project, found, missing}
   * step(文字, 割合)
   */
  async function importFile(file, step = () => {}) {
    let data, ekpName = file.name.replace(/\.(ekp|zip|json)$/i, '');
    let entries = null, base = '';
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      entries = await Zip.list(file);
      const ek = entries.find((e) => /\.ekp$/i.test(e.name));
      if (!ek) throw new Error('ZIP の中に .ekp がありません');
      data = JSON.parse(await (await Zip.file(file, ek)).text());
      base = ek.name.includes('/') ? ek.name.slice(0, ek.name.lastIndexOf('/')) : '';
      ekpName = baseName(ek.name).replace(/\.ekp$/i, '');
    } else {
      data = JSON.parse(await file.text());
    }
    const p = fromJson(data, ekpName);
    const found = [], missing = [];
    const byPath = new Map(), byName = new Map();
    if (entries) for (const e of entries) { byPath.set(e.name.toLowerCase(), e); byName.set(baseName(e.name).toLowerCase(), byName.get(baseName(e.name).toLowerCase()) || e); }
    const findEntry = (rel, path) => {
      if (!entries) return null;
      if (rel) { const e = byPath.get(joinPath(base, rel).toLowerCase()); if (e) return e; }
      return byName.get(baseName(path || rel).toLowerCase()) || null;
    };
    // LUT（.cube）
    const lutMap = new Map();
    for (const c of Object.values(p.clips)) {
      const ref = c.grade && c.grade.lut;
      if (!ref || ref.startsWith('builtin:') || ref.startsWith('user:') || lutMap.has(ref)) continue;
      let to = null;
      const e = findEntry(ref, ref);
      if (e) {
        const f = await Zip.file(file, e, 'text/plain');
        try { to = (await Grade.importCube(f)).ref; } catch { /* 読めない LUT はそのまま */ }
      } else {
        const known = (await Grade.userLuts()).find((u) => u.name.toLowerCase() === baseName(ref).replace(/\.cube$/i, '').toLowerCase());
        if (known) to = known.ref;
      }
      lutMap.set(ref, to);
    }
    for (const c of Object.values(p.clips)) if (c.grade && lutMap.get(c.grade.lut)) c.grade = { ...c.grade, lut: lutMap.get(c.grade.lut) };
    // 素材
    const ids = Object.keys(p.media);
    for (let i = 0; i < ids.length; i++) {
      const m = p.media[ids[i]];
      const e = findEntry(m.rel_path, m.path);
      if (!e) { missing.push(m.name); continue; }
      step(`${i + 1} / ${ids.length}　${m.name}`, i / ids.length);
      const f = await Zip.file(file, e);
      const rec = await Media.importFile(f, (t, r) => step(t ? `${i + 1} / ${ids.length}　${m.name}：${t}` : null, r !== null && r !== undefined ? (i + r) / ids.length : null), { id: m.id });
      p.media[m.id] = { ...Media.projectInfo(rec), name: m.name };
      found.push(m.name);
    }
    return { project: p, found, missing };
  }

  return { FORMAT, toJson, fromJson, exportZip, importFile, joinPath, baseName };
})();
