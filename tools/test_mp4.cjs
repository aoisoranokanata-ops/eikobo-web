// mp4.js の確かめ（node tools/test_mp4.cjs [ファイル…]）
// 動画の情報と、音声を数値にした結果（PCM は最大値、AAC は ADTS を tools/fixtures/out_*.aac に書く）を出す。
const fs = require('fs');
const path = require('path');
const Mp4 = require('../js/mp4.js');

const fakeCtx = {
  createBuffer(ch, frames, rate) {
    const data = Array.from({ length: ch }, () => new Float32Array(frames));
    return { numberOfChannels: ch, length: frames, sampleRate: rate, duration: frames / rate, data, copyToChannel(a, k) { data[k].set(a); } };
  },
  async decodeAudioData(buf) { return { adts: new Uint8Array(buf) }; },
};

(async () => {
  const dir = path.join(__dirname, 'fixtures');
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : fs.readdirSync(dir).filter((f) => /\.(mp4|mov|m4a)$/i.test(f)).map((f) => path.join(dir, f));
  for (const f of files) {
    const blob = await fs.openAsBlob(f);
    const info = await Mp4.parse(blob);
    if (!info) { console.log(path.basename(f), '→ MP4 ではない'); continue; }
    const v = info.video, a = info.audio;
    console.log(path.basename(f));
    if (v) console.log('  video', v.codec, `${v.width}x${v.height}`, 'rot', v.rotation, 'fps', v.fps.toFixed(3), 'dur', v.duration.toFixed(3), 'offset', v.offset.toFixed(4), 'desc', v.description ? v.description.length : 0);
    if (a) {
      console.log('  audio', a.codec, a.sampleRate, 'ch', a.channels, 'bits', a.bits, 'dur', a.duration.toFixed(3), 'offset', a.offset.toFixed(4), 'asc', a.asc ? Buffer.from(a.asc).toString('hex') : '-');
      const t0 = Date.now();
      const r = await Mp4.decodeAudio(blob, info, fakeCtx);
      if (r.buffer.adts) {
        const out = path.join(dir, 'out_' + path.basename(f) + '.aac');
        fs.writeFileSync(out, r.buffer.adts);
        console.log('  → ADTS', r.buffer.adts.length, 'bytes', out, Date.now() - t0, 'ms');
      } else {
        let peak = 0;
        for (const ch of r.buffer.data) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
        console.log('  → PCM', r.buffer.length, 'frames', (r.buffer.duration).toFixed(3), 's peak', peak.toFixed(4), Date.now() - t0, 'ms');
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
