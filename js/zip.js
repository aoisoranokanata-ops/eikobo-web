/* ------------------------------------------------------------
   ZIP の読み書き（自前）
   - 書く: 無圧縮（動画はもう圧縮されているので）。CRC を先に計算してから中身を流す（データ記述子を使わない、
     どのソフトでも開ける形）。4GB を超える時は ZIP64。中身は sink（OPFS へ流す）に順に書く。
   - 読む: 中央ディレクトリ（ZIP64 も）を読み、無圧縮は Blob.slice のまま、Deflate は DecompressionStream で戻す。
     名前は UTF-8 の印があれば UTF-8、無ければ UTF-8 として読めなければ Shift_JIS（日本語の Windows で作った zip）。
   ------------------------------------------------------------ */
const Zip = (() => {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();

  function crcUpdate(crc, u8) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const CHUNK = 8 * 1024 * 1024;

  async function crcOf(blob, onProgress) {
    let crc = 0;
    for (let p = 0; p < blob.size; p += CHUNK) {
      crc = crcUpdate(crc, new Uint8Array(await blob.slice(p, p + CHUNK).arrayBuffer()));
      if (onProgress) onProgress(Math.min(1, (p + CHUNK) / blob.size));
    }
    return crc;
  }

  function dosTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return [time, date];
  }

  class Bytes {
    constructor(n) { this.u8 = new Uint8Array(n); this.dv = new DataView(this.u8.buffer); this.p = 0; }
    u16(v) { this.dv.setUint16(this.p, v, true); this.p += 2; return this; }
    u32(v) { this.dv.setUint32(this.p, v >>> 0, true); this.p += 4; return this; }
    u64(v) { this.dv.setUint32(this.p, v % 4294967296, true); this.dv.setUint32(this.p + 4, Math.floor(v / 4294967296), true); this.p += 8; return this; }
    raw(b) { this.u8.set(b, this.p); this.p += b.length; return this; }
  }

  /**
   * ZIP を書く。entries: [{name, blob}]、sink: {write(u8)}。onProgress(文字, 割合)。
   * 書いた大きさを返す（中身は sink に）。
   */
  async function write(entries, sink, onProgress) {
    const enc = new TextEncoder();
    const [time, date] = dosTime(new Date());
    const central = [];
    let offset = 0;
    const put = async (u8) => { const n = u8.length; await sink.write(u8); offset += n; };
    const total = entries.reduce((s, e) => s + e.blob.size, 0) || 1;
    let done = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const size = e.blob.size;
      const crc = await crcOf(e.blob, (r) => onProgress && onProgress(`確かめています: ${e.name}`, (done + size * r * 0.5) / total));
      const z64 = size >= 0xffffffff || offset >= 0xffffffff;
      const local = new Bytes(30 + name.length + (z64 ? 20 : 0));
      local.u32(0x04034b50).u16(z64 ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date).u32(crc)
        .u32(z64 ? 0xffffffff : size).u32(z64 ? 0xffffffff : size).u16(name.length).u16(z64 ? 20 : 0).raw(name);
      if (z64) local.u16(1).u16(16).u64(size).u64(size);
      const at = offset;
      await put(local.u8);
      for (let p = 0; p < size; p += CHUNK) {
        await put(new Uint8Array(await e.blob.slice(p, p + CHUNK).arrayBuffer()));
        if (onProgress) onProgress(`まとめています: ${e.name}`, (done + size * 0.5 + Math.min(size, p + CHUNK) * 0.5) / total);
      }
      done += size;
      central.push({ name, crc, size, at });
    }
    const cdStart = offset;
    for (const c of central) {
      const big = c.size >= 0xffffffff || c.at >= 0xffffffff;
      const ex = big ? 28 : 0;
      const b = new Bytes(46 + c.name.length + ex);
      b.u32(0x02014b50).u16(45).u16(big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date).u32(c.crc)
        .u32(big ? 0xffffffff : c.size).u32(big ? 0xffffffff : c.size).u16(c.name.length).u16(ex).u16(0).u16(0).u16(0).u32(0)
        .u32(big ? 0xffffffff : c.at).raw(c.name);
      if (big) b.u16(1).u16(24).u64(c.size).u64(c.size).u64(c.at);
      await put(b.u8);
    }
    const cdSize = offset - cdStart;
    const z64 = cdStart >= 0xffffffff || central.length >= 0xffff || central.some((c) => c.size >= 0xffffffff || c.at >= 0xffffffff);
    if (z64) {
      const eocd64At = offset;
      const r = new Bytes(56);
      r.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(central.length).u64(central.length).u64(cdSize).u64(cdStart);
      await put(r.u8);
      const l = new Bytes(20);
      l.u32(0x07064b50).u32(0).u64(eocd64At).u32(1);
      await put(l.u8);
    }
    const e = new Bytes(22);
    e.u32(0x06054b50).u16(0).u16(0).u16(Math.min(0xffff, central.length)).u16(Math.min(0xffff, central.length))
      .u32(Math.min(0xffffffff, cdSize)).u32(z64 ? 0xffffffff : cdStart).u16(0);
    await put(e.u8);
    return offset;
  }

  // ---- 読む --------------------------------------------------------------------
  function decodeName(u8, utf8) {
    if (utf8) return new TextDecoder('utf-8').decode(u8);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* 下へ */ }
    try { return new TextDecoder('shift_jis').decode(u8); } catch { return new TextDecoder('latin1').decode(u8); }
  }

  async function dvAt(blob, pos, len) { return new DataView(await blob.slice(pos, pos + len).arrayBuffer()); }

  /** 中身の一覧 [{name, method, csize, usize, offset}]（フォルダは除く） */
  async function list(blob) {
    const tailLen = Math.min(blob.size, 65536 + 22);
    const tail = await dvAt(blob, blob.size - tailLen, tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('ZIP ではないか、壊れています');
    let count = tail.getUint16(e + 10, true);
    let cdSize = tail.getUint32(e + 12, true);
    let cdStart = tail.getUint32(e + 16, true);
    if (cdStart === 0xffffffff || count === 0xffff) {
      const loc = e - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
        const at = Number(tail.getBigUint64(loc + 8, true));
        const r = await dvAt(blob, at, 56);
        count = Number(r.getBigUint64(32, true));
        cdSize = Number(r.getBigUint64(40, true));
        cdStart = Number(r.getBigUint64(48, true));
      }
    }
    const cd = await dvAt(blob, cdStart, cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true);
      const nlen = cd.getUint16(p + 28, true), elen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = decodeName(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen), !!(flags & 0x0800));
      // ZIP64 の追加の情報（0xFFFFFFFF の項目だけ、この順で入っている）
      let x = p + 46 + nlen;
      const xe = x + elen;
      while (x + 4 <= xe) {
        const id = cd.getUint16(x, true), sz = cd.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.getBigUint64(q, true)); }
        }
        x += 4 + sz;
      }
      if (!name.endsWith('/')) out.push({ name: name.replace(/\\/g, '/'), method, csize, usize, offset });
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  /** 中身を File として取り出す（無圧縮は切り出しだけ、Deflate は展開） */
  async function file(blob, entry, type = '') {
    const h = await dvAt(blob, entry.offset, 30);
    const start = entry.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const part = blob.slice(start, start + entry.csize);
    const base = entry.name.split('/').pop();
    if (entry.method === 0) return new File([part], base, { type });
    if (entry.method !== 8) throw new Error(`${entry.name}: この圧縮の形（${entry.method}）は読めません`);
    if (!window.DecompressionStream) throw new Error('このブラウザは ZIP の展開に対応していません');
    const out = await new Response(part.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    return new File([out], base, { type });
  }

  return { write, list, file, crcOf, crcUpdate };
})();
