/* ------------------------------------------------------------
   MP4 / MOV の中身を読む（自前、外部ライブラリなし）

   - 大きな動画を丸ごとメモリに読まない。箱の頭と moov だけ Blob.slice で読む。
   - 音声は AAC なら ADTS に包み直して decodeAudioData、生 PCM（lpcm / sowt / twos / in24 …）はそのまま数値に。
     （動画ファイル全体を decodeAudioData に渡すと、4K の長い動画で iPad のメモリが足りなくなる）
   - 編集リスト（elst）の先頭のずれを offset（秒）として返す。
     音声バッファの i 番目の標本の表示時刻 = i / sampleRate + offset
   ------------------------------------------------------------ */
const Mp4 = (() => {
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
  const PCM_CODECS = new Set(['lpcm', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'raw ']);

  function fourcc(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  async function slice(blob, pos, len) {
    return new DataView(await blob.slice(pos, pos + len).arrayBuffer());
  }

  // 一番外側の箱を並べる（中身は読まない）
  async function topBoxes(blob) {
    const out = [];
    let pos = 0;
    while (pos + 8 <= blob.size) {
      const dv = await slice(blob, pos, 16);
      let size = dv.getUint32(0);
      const type = fourcc(dv, 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = blob.size - pos;
      if (size < hdr) break;
      out.push({ type, pos, size, hdr });
      pos += size;
    }
    return out;
  }

  // dv の [start, end) にある子の箱
  function children(dv, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = fourcc(dv, p + 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type, start: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }

  function child(dv, box, type) {
    return children(dv, box.start, box.end).find((b) => b.type === type) || null;
  }

  function path(dv, box, ...types) {
    let b = box;
    for (const t of types) { b = b && child(dv, b, t); }
    return b;
  }

  // 箱の中を深さ優先で探す（stsd の中の esds など、入れ子の深さが決まっていないもの）
  function findDeep(dv, start, end, type, depth = 0) {
    if (depth > 6) return null;
    for (const b of children(dv, start, end)) {
      if (b.type === type) return b;
      if (b.end - b.start >= 8) {
        const r = findDeep(dv, b.start, b.end, type, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function fullBoxVersion(dv, box) { return dv.getUint8(box.start); }

  function readMvhd(dv, box) {
    const v = fullBoxVersion(dv, box);
    return v === 1 ? dv.getUint32(box.start + 20) : dv.getUint32(box.start + 12);
  }

  function readMdhd(dv, box) {
    const v = fullBoxVersion(dv, box);
    if (v === 1) return { timescale: dv.getUint32(box.start + 20), duration: Number(dv.getBigUint64(box.start + 24)) };
    return { timescale: dv.getUint32(box.start + 12), duration: dv.getUint32(box.start + 16) };
  }

  function readTkhd(dv, box) {
    const v = fullBoxVersion(dv, box);
    const m = box.start + (v === 1 ? 52 : 40);
    const a = dv.getInt32(m) / 65536, b = dv.getInt32(m + 4) / 65536;
    const w = dv.getUint32(m + 36) / 65536, h = dv.getUint32(m + 40) / 65536;
    let rot = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    rot = ((rot % 360) + 360) % 360;
    return { width: w, height: h, rotation: rot };
  }

  function readElst(dv, box) {
    if (!box) return [];
    const v = fullBoxVersion(dv, box);
    const n = dv.getUint32(box.start + 4);
    const out = [];
    let p = box.start + 8;
    for (let i = 0; i < n; i++) {
      if (v === 1) {
        out.push({ dur: Number(dv.getBigUint64(p)), mediaTime: Number(dv.getBigInt64(p + 8)) });
        p += 20;
      } else {
        out.push({ dur: dv.getUint32(p), mediaTime: dv.getInt32(p + 4) });
        p += 12;
      }
    }
    return out;
  }

  // 表示の先頭が素材のどこに当たるか（秒）。空の編集 = 遅れ、media_time = 頭の切り捨て
  function editOffset(edits, movieTs, mediaTs) {
    let empty = 0;
    for (const e of edits) {
      if (e.mediaTime === -1) { empty += e.dur / movieTs; continue; }
      return empty - e.mediaTime / mediaTs;
    }
    return empty;
  }

  function readEsds(dv, box) {
    // ES_Descriptor(0x03) → DecoderConfigDescriptor(0x04) → DecoderSpecificInfo(0x05)
    let p = box.start + 4;
    const end = box.end;
    function len() {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const b = dv.getUint8(p++);
        n = (n << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return n;
    }
    let objectType = 0;
    while (p < end) {
      const tag = dv.getUint8(p++);
      const n = len();
      if (tag === 0x03) {
        p += 2;
        const flags = dv.getUint8(p++);
        if (flags & 0x80) p += 2;
        if (flags & 0x40) p += 1 + dv.getUint8(p);
        if (flags & 0x20) p += 2;
      } else if (tag === 0x04) {
        objectType = dv.getUint8(p);
        p += 13;
      } else if (tag === 0x05) {
        return { objectType, asc: new Uint8Array(dv.buffer, dv.byteOffset + p, n).slice() };
      } else {
        p += n;
      }
    }
    return { objectType, asc: null };
  }

  function readSampleEntry(dv, stsd, handler) {
    const entries = children(dv, stsd.start + 8, stsd.end);
    if (!entries.length) return null;
    const e = entries[0];
    const info = { codec: e.type };
    if (handler === 'vide') {
      info.codedWidth = dv.getUint16(e.start + 24);
      info.codedHeight = dv.getUint16(e.start + 26);
      const kids = children(dv, e.start + 78, e.end);
      const cfg = kids.find((k) => ['avcC', 'hvcC', 'vpcC', 'av1C'].includes(k.type));
      if (cfg) info.description = new Uint8Array(dv.buffer, dv.byteOffset + cfg.start, cfg.end - cfg.start).slice();
    } else if (handler === 'soun') {
      const qtVer = dv.getUint16(e.start + 8);
      let channels = dv.getUint16(e.start + 16);
      let bits = dv.getUint16(e.start + 18);
      let rate = dv.getUint32(e.start + 24) / 65536;
      let flags = 0;
      let bytesPerFrame = 0;
      let kidsAt = e.start + 28;
      if (qtVer === 1) {
        bytesPerFrame = dv.getUint32(e.start + 28 + 8);
        kidsAt += 16;
      } else if (qtVer === 2) {
        rate = dv.getFloat64(e.start + 32);
        channels = dv.getUint32(e.start + 40);
        bits = dv.getUint32(e.start + 48);
        flags = dv.getUint32(e.start + 52);
        bytesPerFrame = dv.getUint32(e.start + 56);
        kidsAt += 36;
      }
      info.channels = channels;
      info.sampleRate = rate;
      info.bits = bits;
      info.pcmFlags = flags;
      info.bytesPerFrame = bytesPerFrame;
      info.qtVersion = qtVer;
      const esds = findDeep(dv, kidsAt, e.end, 'esds');
      if (esds) Object.assign(info, readEsds(dv, esds));
      const enda = findDeep(dv, kidsAt, e.end, 'enda');      // QuickTime: in24 などのバイト順（1 = リトルエンディアン）
      if (enda && enda.end - enda.start >= 2) info.littleEndian = dv.getUint16(enda.start) === 1;
    }
    return info;
  }

  function readTable(dv, stbl) {
    const t = {};
    const stsz = child(dv, stbl, 'stsz');
    if (stsz) {
      const size = dv.getUint32(stsz.start + 4);
      const count = dv.getUint32(stsz.start + 8);
      t.sampleCount = count;
      if (size) t.sampleSize = size;
      else {
        t.sizes = new Uint32Array(count);
        for (let i = 0; i < count; i++) t.sizes[i] = dv.getUint32(stsz.start + 12 + i * 4);
      }
    }
    const stco = child(dv, stbl, 'stco');
    const co64 = child(dv, stbl, 'co64');
    if (stco || co64) {
      const b = stco || co64;
      const n = dv.getUint32(b.start + 4);
      t.chunks = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        t.chunks[i] = stco ? dv.getUint32(b.start + 8 + i * 4) : Number(dv.getBigUint64(b.start + 8 + i * 8));
      }
    }
    const stsc = child(dv, stbl, 'stsc');
    if (stsc) {
      const n = dv.getUint32(stsc.start + 4);
      t.stsc = [];
      for (let i = 0; i < n; i++) {
        const p = stsc.start + 8 + i * 12;
        t.stsc.push([dv.getUint32(p), dv.getUint32(p + 4)]);   // [最初のチャンク（1 始まり）, チャンクあたりの標本数]
      }
    }
    const stts = child(dv, stbl, 'stts');
    if (stts) {
      const n = dv.getUint32(stts.start + 4);
      t.stts = [];
      for (let i = 0; i < n; i++) {
        const p = stts.start + 8 + i * 8;
        t.stts.push([dv.getUint32(p), dv.getUint32(p + 4)]);   // [標本数, 1 標本の長さ]
      }
    }
    const ctts = child(dv, stbl, 'ctts');
    if (ctts) {
      // ずれは常に符号付きで読む（QuickTime は version 0 でも負の値を書く。iPhone や Final Cut の MOV）
      const n = dv.getUint32(ctts.start + 4);
      t.ctts = [];
      for (let i = 0; i < n; i++) {
        const p = ctts.start + 8 + i * 8;
        t.ctts.push([dv.getUint32(p), dv.getInt32(p + 4)]);
      }
    }
    const stss = child(dv, stbl, 'stss');
    if (stss) {
      const n = dv.getUint32(stss.start + 4);
      t.sync = new Uint32Array(n);
      for (let i = 0; i < n; i++) t.sync[i] = dv.getUint32(stss.start + 8 + i * 4);
    }
    return t;
  }

  /** ファイルを調べる。MP4 / MOV でなければ null。 */
  async function parse(blob) {
    let tops;
    try { tops = await topBoxes(blob); } catch { return null; }
    const moov = tops.find((b) => b.type === 'moov');
    if (!moov || moov.size > 256 * 1024 * 1024) return null;
    const dv = new DataView(await blob.slice(moov.pos, moov.pos + moov.size).arrayBuffer());
    const root = { start: moov.hdr, end: moov.size };
    const mvhd = child(dv, root, 'mvhd');
    const movieTs = mvhd ? readMvhd(dv, mvhd) : 1000;
    const tracks = [];
    for (const trak of children(dv, root.start, root.end).filter((b) => b.type === 'trak')) {
      const hdlr = path(dv, trak, 'mdia', 'hdlr');
      if (!hdlr) continue;
      const handler = fourcc(dv, hdlr.start + 8);
      if (handler !== 'vide' && handler !== 'soun') continue;
      const mdhd = path(dv, trak, 'mdia', 'mdhd');
      const stbl = path(dv, trak, 'mdia', 'minf', 'stbl');
      if (!mdhd || !stbl) continue;
      const stsd = child(dv, stbl, 'stsd');
      if (!stsd) continue;
      const { timescale, duration } = readMdhd(dv, mdhd);
      const entry = readSampleEntry(dv, stsd, handler);
      if (!entry) continue;
      const tk = {
        type: handler === 'vide' ? 'video' : 'audio',
        timescale, duration: timescale ? duration / timescale : 0,
        offset: editOffset(readElst(dv, path(dv, trak, 'edts', 'elst')), movieTs, timescale),
        table: readTable(dv, stbl),
        ...entry,
      };
      if (tk.type === 'video') {
        Object.assign(tk, readTkhd(dv, child(dv, trak, 'tkhd')));
        // 1 コマの長さで一番多いもの（編集リストで頭を切った長さで割るとずれる）
        let best = null;
        for (const e of tk.table.stts || []) if (!best || e[0] > best[0]) best = e;
        const n = tk.table.sampleCount || 0;
        tk.fps = best && best[1] ? timescale / best[1] : (tk.duration > 0 ? n / tk.duration : 0);
        tk.frameCount = n;
      }
      tracks.push(tk);
    }
    return {
      tracks,
      video: tracks.find((t) => t.type === 'video') || null,
      audio: tracks.find((t) => t.type === 'audio') || null,
    };
  }

  // チャンクごとの [ファイル上の位置, 最初の標本番号, 標本数]
  function chunkList(t) {
    const out = [];
    if (!t.chunks || !t.stsc) return out;
    let sample = 0;
    for (let c = 0; c < t.chunks.length; c++) {
      let per = 0;
      for (const [first, n] of t.stsc) { if (first <= c + 1) per = n; else break; }
      out.push([t.chunks[c], sample, per]);
      sample += per;
    }
    return out;
  }

  // 生 PCM の数値化（1 チャンク分の Uint8Array → 各チャンネルの Float32Array に書き足す）
  function pcmFormat(tk) {
    const c = tk.codec;
    let bits = tk.bits || 16, float = false, big = false;
    if (c === 'sowt') { bits = 16; }
    else if (c === 'twos') { bits = 16; big = true; }
    else if (c === 'in24') { bits = 24; big = true; }
    else if (c === 'in32') { bits = 32; big = true; }
    else if (c === 'fl32') { bits = 32; float = true; big = true; }
    else if (c === 'fl64') { bits = 64; float = true; big = true; }
    else if (c === 'raw ') { bits = 8; }
    else if (c === 'lpcm') { float = !!(tk.pcmFlags & 1); big = !!(tk.pcmFlags & 2); }
    if (tk.littleEndian !== undefined && c !== 'lpcm') big = !tk.littleEndian;
    const bytes = tk.bytesPerFrame && tk.qtVersion === 2 ? tk.bytesPerFrame / tk.channels : bits / 8;
    return { bits, bytes, float, big };
  }

  function decodePcm(u8, fmt, ch, outs, at, frames) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const le = !fmt.big;
    const step = fmt.bytes;
    let p = 0;
    for (let i = 0; i < frames; i++) {
      for (let k = 0; k < ch; k++) {
        let v;
        if (fmt.float) v = step === 8 ? dv.getFloat64(p, le) : dv.getFloat32(p, le);
        else if (step === 2) v = dv.getInt16(p, le) / 32768;
        else if (step === 3) {
          const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
          let x = le ? (b0 | (b1 << 8) | (b2 << 16)) : (b2 | (b1 << 8) | (b0 << 16));
          if (x & 0x800000) x -= 0x1000000;
          v = x / 8388608;
        } else if (step === 4) v = dv.getInt32(p, le) / 2147483648;
        else v = (dv.getUint8(p) - 128) / 128;
        outs[k][at + i] = v;
        p += step;
      }
    }
  }

  // AAC の 1 フレームに付ける ADTS の頭（7 バイト）
  function adtsHeader(asc, len) {
    const obj = asc[0] >> 3;
    const freq = ((asc[0] & 7) << 1) | (asc[1] >> 7);
    const ch = (asc[1] >> 3) & 15;
    const profile = Math.min(Math.max(obj, 1), 4) - 1;
    const n = len + 7;
    return [0xff, 0xf1, (profile << 6) | (freq << 2) | (ch >> 2), ((ch & 3) << 6) | (n >> 11), (n >> 3) & 0xff, ((n & 7) << 5) | 0x1f, 0xfc];
  }

  /**
   * 音声トラックを AudioBuffer にする。返り値 { buffer, offset }。読めなければ例外。
   * onProgress(0〜1)
   */
  async function decodeAudio(blob, info, actx, onProgress) {
    const tk = info.audio;
    if (!tk) throw new Error('音声がありません');
    const t = tk.table;
    const chunks = chunkList(t);
    const total = chunks.length || 1;
    if (PCM_CODECS.has(tk.codec)) {
      const fmt = pcmFormat(tk);
      const ch = Math.max(1, tk.channels | 0);
      const frameBytes = fmt.bytes * ch;
      const frames = chunks.reduce((s, c) => s + c[2], 0);
      if (!frames || frames > 48000 * 60 * 180) throw new Error('音声の長さが読めません');
      const outs = Array.from({ length: ch }, () => new Float32Array(frames));
      let at = 0;
      for (let i = 0; i < chunks.length; i++) {
        const [pos, , n] = chunks[i];
        const u8 = new Uint8Array(await blob.slice(pos, pos + n * frameBytes).arrayBuffer());
        decodePcm(u8, fmt, ch, outs, at, Math.min(n, Math.floor(u8.length / frameBytes)));
        at += n;
        if (onProgress && i % 16 === 0) onProgress(i / total);
      }
      const buf = actx.createBuffer(ch, frames, tk.sampleRate);
      outs.forEach((o, k) => buf.copyToChannel(o, k));
      return { buffer: buf, offset: tk.offset };
    }
    if (tk.codec === 'mp4a' && tk.asc && tk.asc.length >= 2 && ((tk.asc[0] & 7) << 1 | tk.asc[1] >> 7) !== 15) {
      const sizes = t.sizes;
      const sizeOf = (i) => (sizes ? sizes[i] : t.sampleSize);
      const parts = [];
      let bytes = 0;
      for (let i = 0; i < chunks.length; i++) {
        const [pos, first, n] = chunks[i];
        let len = 0;
        for (let s = 0; s < n; s++) len += sizeOf(first + s);
        const u8 = new Uint8Array(await blob.slice(pos, pos + len).arrayBuffer());
        let p = 0;
        for (let s = 0; s < n; s++) {
          const sz = sizeOf(first + s);
          const out = new Uint8Array(sz + 7);
          out.set(adtsHeader(tk.asc, sz), 0);
          out.set(u8.subarray(p, p + sz), 7);
          parts.push(out);
          bytes += out.length;
          p += sz;
        }
        if (onProgress && i % 16 === 0) onProgress(i / total);
      }
      const all = new Uint8Array(bytes);
      let p = 0;
      for (const x of parts) { all.set(x, p); p += x.length; }
      const buffer = await actx.decodeAudioData(all.buffer);
      return { buffer, offset: tk.offset };
    }
    throw new Error('この音声の形式（' + tk.codec + '）は読めません');
  }

  /**
   * 標本（コマ）ごとの表。並びはデコード順。pts は表示時刻（秒、編集リストのずれ込み）。
   */
  function sampleTable(tk) {
    const t = tk.table;
    const n = t.sampleCount || 0;
    const offset = new Float64Array(n), size = new Uint32Array(n), pts = new Float64Array(n), sync = new Uint8Array(n);
    for (let i = 0; i < n; i++) size[i] = t.sizes ? t.sizes[i] : t.sampleSize;
    for (const [pos, first, per] of chunkList(t)) {
      let o = pos;
      for (let s = first; s < first + per && s < n; s++) { offset[s] = o; o += size[s]; }
    }
    const dts = new Float64Array(n);
    let i = 0, d = 0;
    for (const [count, delta] of t.stts || []) for (let k = 0; k < count && i < n; k++) { dts[i++] = d; d += delta; }
    for (; i < n; i++) dts[i] = d;
    const cts = Float64Array.from(dts);
    if (t.ctts) {
      i = 0;
      for (const [count, off] of t.ctts) for (let k = 0; k < count && i < n; k++, i++) cts[i] = dts[i] + off;
    }
    for (let s = 0; s < n; s++) pts[s] = cts[s] / tk.timescale + tk.offset;
    if (t.sync) { for (const s of t.sync) if (s >= 1 && s <= n) sync[s - 1] = 1; } else sync.fill(1);
    return { n, offset, size, pts, sync };
  }

  const hex2 = (b) => b.toString(16).padStart(2, '0');

  /** WebCodecs に渡す形式名（avc1.64002a / hvc1.1.6.L120.90 など）。分からなければ null */
  function codecString(tk) {
    const d = tk.description;
    if (!d) return null;
    if (tk.codec === 'avc1' || tk.codec === 'avc3') return tk.codec + '.' + hex2(d[1]) + hex2(d[2]) + hex2(d[3]);
    if (tk.codec === 'hvc1' || tk.codec === 'hev1') {
      const space = d[1] >> 6, tier = (d[1] >> 5) & 1, profile = d[1] & 31;
      const flags = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
      let rev = 0;
      for (let i = 0; i < 32; i++) rev = ((rev << 1) | ((flags >>> i) & 1)) >>> 0;
      const cons = Array.from(d.subarray(6, 12));
      while (cons.length && cons[cons.length - 1] === 0) cons.pop();
      const parts = [tk.codec, (space ? 'ABC'[space - 1] : '') + profile, rev.toString(16), (tier ? 'H' : 'L') + d[12]];
      return parts.concat(cons.map((b) => b.toString(16))).join('.');
    }
    return null;
  }

  return { parse, decodeAudio, chunkList, topBoxes, sampleTable, codecString };
})();

if (typeof module !== 'undefined') module.exports = Mp4;
