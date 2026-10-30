/* ------------------------------------------------------------
   MP4 / MOV を組み立てる（自前、外部ライブラリなし）

   - 中身（mdat の本体）は sink に順に流し、最後に頭（ftyp＋moov＋mdat の頭）だけを作る。
     ファイル = 頭 + 本体（moov が前にあるので、iPad の写真アプリでもすぐ再生が始まる）。
   - 映像: H.264（avcC は VideoEncoder がくれるもの）。音声: AAC（mp4a＋esds）か、生 PCM（MOV の sowt、16bit）。
   - 1 標本 = 1 チャンク（PCM は 1 回に渡したかたまりが 1 チャンク）。位置は 4GB を超えたら co64。
   ------------------------------------------------------------ */
const Mux = (() => {
  // ---- 箱を作る小物 -------------------------------------------------------------
  class W {
    constructor() { this.parts = []; this.len = 0; }
    u8(v) { return this.raw(new Uint8Array([v & 255])); }
    u16(v) { return this.raw(new Uint8Array([(v >> 8) & 255, v & 255])); }
    u24(v) { return this.raw(new Uint8Array([(v >> 16) & 255, (v >> 8) & 255, v & 255])); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this.raw(b); }
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0); return this.raw(b); }
    u64(v) { const b = new Uint8Array(8); const dv = new DataView(b.buffer); dv.setUint32(0, Math.floor(v / 4294967296)); dv.setUint32(4, v >>> 0); return this.raw(b); }
    str(s) { return this.raw(new Uint8Array([...s].map((c) => c.charCodeAt(0)))); }
    zeros(n) { return this.raw(new Uint8Array(n)); }
    raw(b) { this.parts.push(b); this.len += b.length; return this; }
    bytes() { const out = new Uint8Array(this.len); let p = 0; for (const b of this.parts) { out.set(b, p); p += b.length; } return out; }
  }

  function box(type, ...kids) {
    const w = new W();
    let n = 8;
    for (const k of kids) n += k.length;
    w.u32(n).str(type);
    for (const k of kids) w.raw(k);
    return w.bytes();
  }
  const fbox = (type, version, flags, ...kids) => box(type, new W().u8(version).u24(flags).bytes(), ...kids);
  const MATRIX = () => new W().u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000).bytes();

  // 連続する同じ値をまとめる（stts など）
  function runs(values) {
    const out = [];
    for (const v of values) {
      if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
      else out.push([1, v]);
    }
    return out;
  }

  function descLen(n) { return new Uint8Array([0x80, 0x80, 0x80, n]); }
  function esds(asc, bitrate) {
    const dsi = new W().u8(0x05).raw(descLen(asc.length)).raw(asc).bytes();
    const dcdBody = new W().u8(0x40).u8(0x15).u24(0).u32(bitrate).u32(bitrate).raw(dsi).bytes();
    const dcd = new W().u8(0x04).raw(descLen(dcdBody.length)).raw(dcdBody).bytes();
    const sl = new W().u8(0x06).raw(descLen(1)).u8(0x02).bytes();
    const esBody = new W().u16(1).u8(0).raw(dcd).raw(sl).bytes();
    const es = new W().u8(0x03).raw(descLen(esBody.length)).raw(esBody).bytes();
    return fbox('esds', 0, 0, es);
  }

  /**
   * opts: { mov: bool,
   *         video: { width, height, timescale, avcC },
   *         audio: { codec: 'aac' | 'pcm', sampleRate, channels, asc, bitrate } | null }
   * sink: { write(Uint8Array): Promise }
   */
  class Muxer {
    constructor(opts, sink) {
      this.o = opts;
      this.sink = sink;
      this.pos = 0;                // 本体の中の位置
      this.v = { off: [], size: [], pts: [], key: [] };
      this.a = { off: [], size: [], frames: [] };
      this.queue = Promise.resolve();
    }

    async write(u8) { const at = this.pos; this.pos += u8.length; await this.sink.write(u8); return at; }   // u8 はこの後使えない

    /** 映像の 1 コマ（data は Uint8Array、pts は表示の順番を timescale で） */
    // 長さは書く前に測る（sink は中身を Worker へ渡すので、書いた後の data は空になる）
    async addVideo(data, pts, key) {
      const len = data.length;
      const off = await this.write(data);
      this.v.off.push(off); this.v.size.push(len); this.v.pts.push(pts); this.v.key.push(key ? 1 : 0);
    }

    /** 音声のかたまり（AAC は 1 フレーム = 1024 標本、PCM はインターリーブ済みの 16bit） */
    async addAudio(data, frames) {
      const len = data.length;
      const off = await this.write(data);
      this.a.off.push(off); this.a.size.push(len); this.a.frames.push(frames);
    }

    /** 頭（ftyp＋moov＋mdat の頭）を作る。ファイル = 頭 + 本体 */
    finish(videoFrameDur) {
      const build = (base) => {
        const ftyp = this.o.mov
          ? box('ftyp', new W().str('qt  ').u32(0x200).str('qt  ').bytes())
          : box('ftyp', new W().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').bytes());
        const vt = this.videoTrak(base, videoFrameDur);
        const at = this.o.audio && this.a.off.length ? this.audioTrak(base) : null;
        const vDur = this.v.pts.length * videoFrameDur / this.o.video.timescale;
        const aDur = at ? this.a.frames.reduce((s, x) => s + x, 0) / this.o.audio.sampleRate : 0;
        const dur = Math.round(Math.max(vDur, aDur) * 1000);
        const mvhd = fbox('mvhd', 0, 0, new W().u32(0).u32(0).u32(1000).u32(dur).u32(0x10000).u16(0x100).zeros(10).raw(MATRIX()).zeros(24).u32(at ? 3 : 2).bytes());
        const moov = box('moov', mvhd, vt, ...(at ? [at] : []));
        const big = this.pos + 16 > 0xffffffff;
        const mdatHead = big ? new W().u32(1).str('mdat').u64(this.pos + 16).bytes() : new W().u32(this.pos + 8).str('mdat').bytes();
        return { ftyp, moov, mdatHead };
      };
      // 位置の表は moov の大きさで変わる → 1 回作って大きさを測り、もう 1 回
      const first = build(0);
      const base = first.ftyp.length + first.moov.length + first.mdatHead.length;
      const r = build(base);
      const head = new W().raw(r.ftyp).raw(r.moov).raw(r.mdatHead).bytes();
      if (head.length !== base) throw new Error('moov の大きさが変わりました');
      return head;
    }

    tkhd(id, dur, w, h, audio) {
      return fbox('tkhd', 0, 3, new W().u32(0).u32(0).u32(id).u32(0).u32(dur).zeros(8).u16(0).u16(audio ? 1 : 0).u16(audio ? 0x100 : 0).u16(0)
        .raw(MATRIX()).u32(w * 65536).u32(h * 65536).bytes());
    }

    chunkOffsets(offs, base) {
      const big = offs.length && offs[offs.length - 1] + base > 0xffffffff;
      const w = new W().u32(offs.length);
      for (const o of offs) big ? w.u64(o + base) : w.u32(o + base);
      return big ? fbox('co64', 0, 0, w.bytes()) : fbox('stco', 0, 0, w.bytes());
    }

    videoTrak(base, frameDur) {
      const o = this.o.video;
      const n = this.v.pts.length;
      // デコード順の時刻 = 表示時刻を小さい順に並べたもの。差（ctts）が負になる分は全体をずらす
      const sorted = [...this.v.pts].sort((x, y) => x - y);
      let shift = 0;
      for (let i = 0; i < n; i++) shift = Math.max(shift, sorted[i] - this.v.pts[i]);
      const dts = sorted.map((x) => x - shift);
      const ctts = this.v.pts.map((p, i) => p - dts[i]);
      const hasCtts = ctts.some((c) => c !== 0);
      const durs = dts.map((d, i) => (i + 1 < n ? dts[i + 1] - d : frameDur));
      const mediaDur = n * frameDur;
      const movieDur = Math.round(mediaDur / o.timescale * 1000);
      const stts = runs(durs);
      const sttsW = new W().u32(stts.length); stts.forEach(([c, d]) => sttsW.u32(c).u32(d));
      const kids = [];
      const avc1 = box('avc1', new W().zeros(6).u16(1).zeros(16).u16(o.width).u16(o.height).u32(0x480000).u32(0x480000).u32(0).u16(1)
        .zeros(32).u16(0x18).u16(0xffff).bytes(),
      box('avcC', o.avcC),
      box('colr', new W().str('nclx').u16(1).u16(1).u16(1).u8(0).bytes()),
      box('pasp', new W().u32(1).u32(1).bytes()));
      kids.push(fbox('stsd', 0, 0, new W().u32(1).bytes(), avc1));
      kids.push(fbox('stts', 0, 0, sttsW.bytes()));
      if (hasCtts) {
        const r = runs(ctts);
        const w = new W().u32(r.length); r.forEach(([c, d]) => w.u32(c).i32(d));
        kids.push(fbox('ctts', 1, 0, w.bytes()));
      }
      if (this.v.key.some((k) => !k)) {
        const keys = []; this.v.key.forEach((k, i) => { if (k) keys.push(i + 1); });
        const w = new W().u32(keys.length); keys.forEach((k) => w.u32(k));
        kids.push(fbox('stss', 0, 0, w.bytes()));
      }
      kids.push(fbox('stsc', 0, 0, new W().u32(1).u32(1).u32(1).u32(1).bytes()));
      const sz = new W().u32(0).u32(n); this.v.size.forEach((s) => sz.u32(s));
      kids.push(fbox('stsz', 0, 0, sz.bytes()));
      kids.push(this.chunkOffsets(this.v.off, base));
      const stbl = box('stbl', ...kids);
      const minf = box('minf', fbox('vmhd', 0, 1, new W().zeros(8).bytes()), box('dinf', fbox('dref', 0, 0, new W().u32(1).bytes(), fbox('url ', 0, 1))), stbl);
      const mdia = box('mdia',
        fbox('mdhd', 0, 0, new W().u32(0).u32(0).u32(o.timescale).u32(mediaDur).u16(0x55c4).u16(0).bytes()),
        fbox('hdlr', 0, 0, new W().u32(0).str('vide').zeros(12).str('VideoHandler').u8(0).bytes()),
        minf);
      const edts = shift ? box('edts', fbox('elst', 0, 0, new W().u32(1).u32(movieDur).i32(shift).u32(0x10000).bytes())) : null;
      return box('trak', this.tkhd(1, movieDur, o.width, o.height, false), ...(edts ? [edts] : []), mdia);
    }

    audioTrak(base) {
      const o = this.o.audio;
      const pcm = o.codec === 'pcm';
      const total = this.a.frames.reduce((s, x) => s + x, 0);
      const movieDur = Math.round(total / o.sampleRate * 1000);
      const kids = [];
      let entry;
      if (pcm) {
        entry = box('sowt', new W().zeros(6).u16(1).u16(0).u16(0).u32(0).u16(o.channels).u16(16).u16(0).u16(0).u32(o.sampleRate * 65536).bytes());
      } else {
        entry = box('mp4a', new W().zeros(6).u16(1).zeros(8).u16(o.channels).u16(16).u16(0).u16(0).u32(o.sampleRate * 65536).bytes(), esds(o.asc, o.bitrate || 192000));
      }
      kids.push(fbox('stsd', 0, 0, new W().u32(1).bytes(), entry));
      if (pcm) {
        kids.push(fbox('stts', 0, 0, new W().u32(1).u32(total).u32(1).bytes()));
        const r = [];      // [最初のチャンク, チャンクあたりの標本数]
        this.a.frames.forEach((f, i) => { if (!r.length || r[r.length - 1][1] !== f) r.push([i + 1, f]); });
        const w = new W().u32(r.length); r.forEach(([c, f]) => w.u32(c).u32(f).u32(1));
        kids.push(fbox('stsc', 0, 0, w.bytes()));
        kids.push(fbox('stsz', 0, 0, new W().u32(o.channels * 2).u32(total).bytes()));
      } else {
        const r = runs(this.a.frames);
        const sw = new W().u32(r.length); r.forEach(([c, d]) => sw.u32(c).u32(d));
        kids.push(fbox('stts', 0, 0, sw.bytes()));
        kids.push(fbox('stsc', 0, 0, new W().u32(1).u32(1).u32(1).u32(1).bytes()));
        const sz = new W().u32(0).u32(this.a.size.length); this.a.size.forEach((s) => sz.u32(s));
        kids.push(fbox('stsz', 0, 0, sz.bytes()));
      }
      kids.push(this.chunkOffsets(this.a.off, base));
      const stbl = box('stbl', ...kids);
      const minf = box('minf', fbox('smhd', 0, 0, new W().u32(0).bytes()), box('dinf', fbox('dref', 0, 0, new W().u32(1).bytes(), fbox('url ', 0, 1))), stbl);
      const mdia = box('mdia',
        fbox('mdhd', 0, 0, new W().u32(0).u32(0).u32(o.sampleRate).u32(total).u16(0x55c4).u16(0).bytes()),
        fbox('hdlr', 0, 0, new W().u32(0).str('soun').zeros(12).str('SoundHandler').u8(0).bytes()),
        minf);
      return box('trak', this.tkhd(2, movieDur, 0, 0, true), mdia);
    }
  }

  return { Muxer, box, fbox };
})();

if (typeof module !== 'undefined') module.exports = Mux;
