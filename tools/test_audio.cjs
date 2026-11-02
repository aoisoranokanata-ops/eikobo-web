// audiofx.js を exe の audiofx.py と突き合わせる
//   python tools/audio_expect.py
//   node tools/test_audio.cjs
const fs = require('fs');
const path = require('path');
global.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const Fx = require('../js/audiofx.js');
const FIX = path.join(__dirname, 'fixtures');

function readStereo(name) {
  const b = fs.readFileSync(path.join(FIX, name));
  const all = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const n = all.length / 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[i * 2]; R[i] = all[i * 2 + 1]; }
  return [L, R];
}
function diff(a, b, from = 0, to = a[0].length) {
  let worst = 0, sum = 0, n = 0;
  for (let c = 0; c < 2; c++) for (let i = from; i < to; i++) { const d = Math.abs(a[c][i] - b[c][i]); worst = Math.max(worst, d); sum += d; n++; }
  return { worst, mean: sum / n };
}

(async () => {
  const exp = JSON.parse(fs.readFileSync(path.join(FIX, 'audio_expect.json'), 'utf8'));
  const x = readStereo('audio_in.f32');
  let bad = 0;
  const check = (name, ok, info) => { console.log(ok ? 'ok ' : 'NG ', name, info); if (!ok) bad++; };

  const m = new Fx.LoudnessMeter(48000);
  m.feed(x[0], x[1]);
  check('ラウドネス', Math.abs(m.integrated() - exp.lufs) < 0.01, `${m.integrated().toFixed(3)} / exe ${exp.lufs.toFixed(3)}`);
  check('ピーク', Math.abs(m.peakDb() - exp.peak_db) < 1e-4, `${m.peakDb().toFixed(3)} / exe ${exp.peak_db.toFixed(3)}`);

  for (const [name, preset, key] of [['EQ 係数（声をくっきり）', '声をくっきり', 'eq_sos'], ['EQ 係数（電話の声）', '電話の声', 'eq_sos_tel']]) {
    const s = Fx.eqSections(Fx.EQ_PRESETS[preset], 48000);
    let worst = s.length === exp[key].length ? 0 : 1;
    s.forEach((sec, i) => { const e = exp[key][i]; const want = [e[0], e[1], e[2], e[4], e[5]]; sec.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - want[k])); }); });
    check(name, worst < 1e-9, `段 ${s.length} 最大差 ${worst.toExponential(2)}`);
  }

  const eq = [Float32Array.from(x[0]), Float32Array.from(x[1])];
  const sec = Fx.eqSections(Fx.EQ_PRESETS['声をくっきり'], 48000);
  eq.forEach((ch) => Fx.sosfilt(sec, ch));
  let d = diff(eq, readStereo('audio_eq.f32'));
  check('EQ の結果', d.worst < 1e-5, `最大差 ${d.worst.toExponential(2)}`);

  const cp = [Float32Array.from(x[0]), Float32Array.from(x[1])];
  Fx.compress(cp, 48000, -20, 3, 4);
  const ce = readStereo('audio_comp.f32');
  d = diff(cp, ce, 0, cp[0].length - 2000);           // 終わり（scipy は端を折り返す）を除く
  check('コンプレッサー', d.worst < 1e-4, `最大差 ${d.worst.toExponential(2)}`);

  const lm = [x[0].map((v) => v * 3), x[1].map((v) => v * 3)];
  Fx.limit(lm, 48000, -1);
  d = diff(lm, readStereo('audio_lim.f32'), 0, lm[0].length - 2000);
  check('リミッター', d.worst < 1e-4, `最大差 ${d.worst.toExponential(2)}`);

  const dn = [Float32Array.from(x[0]), Float32Array.from(x[1])];
  await Fx.denoise(dn, 0.8);
  const de = readStereo('audio_dn.f32');
  d = diff(dn, de, 4096, dn[0].length - 4096);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  check('ノイズ除去', d.mean < 2e-3, `平均差 ${d.mean.toExponential(2)}（元の音の RMS ${rms(x[0]).toFixed(3)}、処理後 ${rms(dn[0]).toFixed(3)} / exe ${rms(de[0]).toFixed(3)}）`);

  console.log(bad ? `${bad} 件ちがう` : 'すべて一致');
  process.exit(bad ? 1 : 0);
})();
