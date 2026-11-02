// 書き出しの AAC の確かめ（node tools/test_aac_mux.cjs）
// Safari の AudioEncoder が返しうる形（大きな ArrayBuffer の一部の view・esds の箱・ES_Descriptor・ADTS の中身）を再現して
// mux.js で MP4 を作り、ffmpeg で音を戻して大きさを測る。前の作り（description.buffer をそのまま使う）も比べる。
// 素材は tools/fixtures に ffmpeg で作る:
//   ffmpeg -f lavfi -i testsrc=size=320x240:rate=30:duration=3 -c:v libx264 -bf 0 -pix_fmt yuv420p tools/fixtures/mux_v.mp4
//   ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -ac 2 -c:a aac -b:a 192k -f adts tools/fixtures/mux_a.aac
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Mp4 = require('../js/mp4.js');
const Mux = require('../js/mux.js');

const FIX = path.join(__dirname, 'fixtures');
const SR = 48000;

/** ADTS のファイル → フレームの並び（頭ごと） */
function adtsFrames(u8) {
  const out = [];
  for (let p = 0; p + 7 <= u8.length;) {
    if (u8[p] !== 0xff || (u8[p + 1] & 0xf6) !== 0xf0) throw new Error('ADTS ではない ' + p);
    const len = ((u8[p + 3] & 3) << 11) | (u8[p + 4] << 3) | (u8[p + 5] >> 5);
    out.push(u8.slice(p, p + len));
    p += len;
  }
  return out;
}

function esdsBox(asc) {
  const dsi = [0x05, asc.length, ...asc];
  const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 2, 0xee, 0, 0, 2, 0xee, 0, ...dsi];
  const es = [0x03, 3 + dcd.length + 3, 0, 0, 0, ...dcd, 0x06, 1, 2];
  const body = [0, 0, 0, 0, ...es];
  const n = 8 + body.length;
  return new Uint8Array([0, 0, 0, n, 0x65, 0x73, 0x64, 0x73, ...body]);
}

class Sink {
  constructor() { this.parts = []; }
  async write(u8) { this.parts.push(Buffer.from(u8)); }
}

async function build(name, desc, frames, { strip = true, old = false } = {}) {
  const blob = await fs.openAsBlob(path.join(FIX, 'mux_v.mp4'));
  const info = await Mp4.parse(blob);
  const v = info.video;
  const st = Mp4.sampleTable(v);
  const buf = Buffer.from(await blob.arrayBuffer());
  const asc = old
    ? new Uint8Array(desc.buffer || desc).slice()             // 前の作り
    : Mux.aacConfig(desc, SR, 2).asc;
  const sink = new Sink();
  const timescale = 30000, frameDur = 1000;
  const m = new Mux.Muxer({ mov: false, video: { width: v.width, height: v.height, timescale, avcC: v.description }, audio: { codec: 'aac', sampleRate: SR, channels: 2, asc, bitrate: 192000 } }, sink);
  let ai = 0;
  for (let i = 0; i < st.n; i++) {
    await m.addVideo(new Uint8Array(buf.subarray(st.offset[i], st.offset[i] + st.size[i])), i * frameDur, st.sync[i]);
    while (ai < frames.length && ai * 1024 / SR <= (i + 1) / 30 + 0.5) { await m.addAudio(strip ? Mux.stripAdts(frames[ai]) : frames[ai], 1024); ai++; }
  }
  while (ai < frames.length) { await m.addAudio(strip ? Mux.stripAdts(frames[ai]) : frames[ai], 1024); ai++; }
  const head = m.finish(frameDur);
  const out = path.join(FIX, `mux_${name}.mp4`);
  fs.writeFileSync(out, Buffer.concat([Buffer.from(head), ...sink.parts]));
  return { out, asc };
}

function volume(file) {
  let txt = '';
  try {
    txt = execFileSync('sh', ['-c', `ffmpeg -nostats -i "${file}" -map 0:a:0 -af volumedetect -f null - 2>&1`]).toString();
  } catch (e) { txt = String(e.stdout || '') + String(e.stderr || ''); }
  const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(txt);
  const errs = (txt.match(/\[aac[^\]]*\][^\n]*/g) || []).length;
  return { mean: mean ? Number(mean[1]) : null, decodeErrors: errs };
}

(async () => {
  const frames = adtsFrames(new Uint8Array(fs.readFileSync(path.join(FIX, 'mux_a.aac'))));
  const raw = frames.map((f) => Mux.stripAdts(f));
  const good = Mux.makeAsc(SR, 2);
  // 大きな ArrayBuffer の一部の view（Safari の形の一つ）
  const big = new Uint8Array(64).fill(0xaa);
  big.set(good, 20);
  const view = new Uint8Array(big.buffer, 20, 2);
  const cases = [
    ['arraybuffer', good.slice().buffer, raw],
    ['view', view, raw],
    ['esds_box', esdsBox(good), raw],
    ['es_descriptor', esdsBox(good).subarray(12), raw],
    ['adts_frames', null, frames],
    ['view_old', view, raw, { old: true }],
  ];
  let fail = 0;
  for (const [name, desc, fr, opt] of cases) {
    const { out, asc } = await build(name, desc, fr, opt || {});
    const v = volume(out);
    const ok = v.mean !== null && v.mean > -30 && !v.decodeErrors;
    const expectBad = name.endsWith('_old');
    if (ok === expectBad) fail++;
    console.log(`${name.padEnd(14)} asc=${Buffer.from(asc).toString('hex').padEnd(12)} mean=${v.mean} dB  errors=${v.decodeErrors}  ${ok ? '鳴る' : '鳴らない'}${expectBad ? '（前の作り）' : ''}`);
  }
  // 単体: parseAsc・stripAdts
  if (JSON.stringify(Mux.parseAsc(good)) !== JSON.stringify({ aot: 2, rate: 48000, channels: 2 })) { fail++; console.log('parseAsc NG'); }
  if (Mux.stripAdts(frames[0]).length !== frames[0].length - 7) { fail++; console.log('stripAdts NG'); }
  if (Mux.stripAdts(raw[0]) !== raw[0]) { fail++; console.log('stripAdts（生）NG'); }
  console.log(fail ? `NG ${fail}` : 'すべて OK');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
