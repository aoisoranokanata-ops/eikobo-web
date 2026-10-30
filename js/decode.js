/* ------------------------------------------------------------
   書き出し用: 素材の「時刻 t に見えているコマ」を取り出す

   - FrameReader: mp4.js の標本表 → WebCodecs の VideoDecoder。前へ進む読み方が速い（書き出しは前へ進むだけ）。
     戻る時・3 秒より先へ飛ぶ時は、手前のキーフレームから読み直す。
   - ElementReader: 読めない形式（webm など・デコーダが対応しない時）の代わり。<video> を 1 コマずつ動かす（遅い）。
   frameAt(t) の返り値: { img, w, h, rot }（w・h は回転前の大きさ、rot は時計回りの度。描いたら手放さないこと）
   ------------------------------------------------------------ */
const Decode = (() => {
  class FrameReader {
    static async open(file, info) {
      if (!window.VideoDecoder || !info || !info.video) return null;
      const tk = info.video;
      const codec = Mp4.codecString(tk);
      if (!codec) return null;
      const config = { codec, description: tk.description, codedWidth: tk.codedWidth, codedHeight: tk.codedHeight };
      try {
        const s = await VideoDecoder.isConfigSupported(config);
        if (!s.supported) return null;
      } catch { return null; }
      return new FrameReader(file, tk, config);
    }

    constructor(file, tk, config) {
      this.file = file;
      this.tk = tk;
      this.config = config;
      this.st = Mp4.sampleTable(tk);
      // 1 コマの長さ（取り違えの許し）
      this.frameDur = tk.fps ? 1 / tk.fps : 1 / 30;
      this.queue = [];
      this.cur = null;
      this.error = null;
      this.wake = null;
      this.decoder = null;
      this.next = 0;
      this.flushed = false;
    }

    makeDecoder() {
      if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* 済み */ } }
      this.decoder = new VideoDecoder({
        output: (f) => { this.queue.push(f); this.poke(); },
        error: (e) => { this.error = e; this.poke(); },
      });
      this.decoder.configure(this.config);
      this.flushed = false;
    }

    poke() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }
    waitOutput(ms = 200) { return new Promise((r) => { this.wake = r; setTimeout(() => { if (this.wake === r) this.wake = null; r(); }, ms); }); }

    /** t 以下で一番近い表示時刻のキーフレーム（デコード順の番号） */
    keyBefore(t) {
      const { n, pts, sync } = this.st;
      let best = 0;
      for (let i = 0; i < n; i++) if (sync[i] && pts[i] <= t + 1e-6) best = i;
      return best;
    }

    reset(t) {
      for (const f of this.queue) f.close();
      this.queue = [];
      if (this.cur) { this.cur.close(); this.cur = null; }
      this.makeDecoder();
      this.next = this.keyBefore(t);
    }

    async feed(count) {
      const { n, offset, size, pts, sync } = this.st;
      for (let k = 0; k < count && this.next < n; k++) {
        const i = this.next++;
        const data = new Uint8Array(await this.file.slice(offset[i], offset[i] + size[i]).arrayBuffer());
        this.decoder.decode(new EncodedVideoChunk({ type: sync[i] ? 'key' : 'delta', timestamp: Math.round(pts[i] * 1e6), duration: Math.round(this.frameDur * 1e6), data }));
      }
    }

    result() {
      const f = this.cur;
      return f ? { img: f, w: f.displayWidth, h: f.displayHeight, rot: this.tk.rotation || 0 } : null;
    }

    async frameAt(t) {
      const eps = this.frameDur * 0.25;
      const curT = this.cur ? this.cur.timestamp / 1e6 : null;
      if (!this.decoder || (curT !== null && t < curT - eps)) this.reset(t);
      else if (curT !== null && t > curT + 3) {
        // 遠くへ飛ぶ時、途中にキーフレームがあればそこから
        const k = this.keyBefore(t);
        if (k > this.next) this.reset(t);
      }
      for (let guard = 0; guard < 100000; guard++) {
        if (this.error) throw this.error;
        while (this.queue.length && this.queue[0].timestamp / 1e6 <= t + eps) {
          if (this.cur) this.cur.close();
          this.cur = this.queue.shift();
        }
        if (this.queue.length && !this.cur) this.cur = this.queue.shift();   // t が最初のコマより前 → 最初のコマ
        if (this.queue.length && this.cur) return this.result();
        if (this.next >= this.st.n) {
          if (!this.flushed) { this.flushed = true; await this.decoder.flush(); continue; }
          return this.result();                   // 素材の最後のコマのまま
        }
        if (this.decoder.decodeQueueSize < 6 && this.queue.length < 4) await this.feed(3);
        else await this.waitOutput();
      }
      throw new Error('コマを読み出せませんでした');
    }

    close() {
      for (const f of this.queue) f.close();
      this.queue = [];
      if (this.cur) { this.cur.close(); this.cur = null; }
      if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* 済み */ } }
    }
  }

  class ElementReader {
    static async open(url) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = url;
      await new Promise((resolve, reject) => {
        v.onloadeddata = resolve;
        v.onerror = () => reject(new Error('動画を開けません'));
        setTimeout(resolve, 8000);
      });
      try { await v.play(); v.pause(); } catch { /* 消音なので通常は再生できる */ }
      return new ElementReader(v);
    }
    constructor(v) { this.v = v; }
    async frameAt(t) {
      const v = this.v;
      if (Math.abs(v.currentTime - t) > 1e-3) {
        await new Promise((resolve) => {
          const done = () => { v.removeEventListener('seeked', done); resolve(); };
          v.addEventListener('seeked', done);
          setTimeout(done, 3000);
          v.currentTime = Math.max(0, t);
        });
        if (v.requestVideoFrameCallback) await new Promise((r) => { v.requestVideoFrameCallback(() => r()); setTimeout(r, 120); });
      }
      return v.videoWidth ? { img: v, w: v.videoWidth, h: v.videoHeight, rot: 0 } : null;
    }
    close() { this.v.removeAttribute('src'); this.v.load(); }
  }

  /** 素材の読み手を作る（WebCodecs が使えればそちら） */
  async function reader(mediaId, rec) {
    const f = await Store.readFile(mediaId);
    if (!f) return null;
    const isMp4 = /\.(mp4|m4v|mov|3gp)$/i.test(rec.name) || /mp4|quicktime/.test(rec.mime || '');
    if (isMp4) {
      const info = await Mp4.parse(f);
      const r = await FrameReader.open(f, info);
      if (r) return r;
    }
    return ElementReader.open(await Media.url(mediaId));
  }

  return { FrameReader, ElementReader, reader };
})();
