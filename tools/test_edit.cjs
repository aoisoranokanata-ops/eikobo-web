// project.js の編集操作の確かめ（node tools/test_edit.cjs）
let n = 0;
global.uid = (p = '') => p + (++n).toString(36);
global.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const Proj = require('../js/project.js');
const assert = require('assert');

function fresh() {
  const p = Proj.create('t');
  p.media.mv = { id: 'mv', name: 'mv.mp4', kind: 'video', duration: 10, has_video: true, has_audio: true };
  p.media.au = { id: 'au', name: 'bgm.mp3', kind: 'audio', duration: 4, has_video: false, has_audio: true };
  p.media.im = { id: 'im', name: 'a.jpg', kind: 'image', duration: 0, has_video: false, has_audio: false };
  return p;
}
const ok = (p) => assert.deepStrictEqual(Proj.checkOverlaps(p), []);
let tests = 0;
function t(name, fn) { fn(); tests++; console.log('ok', name); }

t('置くと映像と音声がリンクされ、空いているトラックへ', () => {
  const p = fresh();
  const [v, a] = Proj.insertMedia(p, p.media.mv, 0);
  assert.strictEqual(v.track, 'v1'); assert.strictEqual(a.track, 'a1');
  assert.strictEqual(v.duration, 300); assert.ok(v.link && v.link === a.link);
  const [v2] = Proj.insertMedia(p, p.media.mv, 100);
  assert.strictEqual(v2.track, 'v2');
  const [v3] = Proj.insertMedia(p, p.media.mv, 50);      // V1・V2 とも塞がっている → V3 を足す
  assert.strictEqual(Proj.track(p, v3.track).name, 'V3');
  assert.strictEqual(Proj.tracksOf(p, 'video').length, 3);
  assert.strictEqual(Proj.tracksOf(p, 'audio').length, 3);
  ok(p);
});

t('画像は 5 秒、音声だけの素材は音声トラックへ', () => {
  const p = fresh();
  const [i] = Proj.insertMedia(p, p.media.im, 0);
  assert.strictEqual(i.duration, 150); assert.strictEqual(i.track, 'v1');
  const out = Proj.insertMedia(p, p.media.au, 0);
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].track, 'a1'); assert.strictEqual(out[0].duration, 120);
});

t('分割はリンク相手も同じ所で切り、右側どうしを新しくリンク', () => {
  const p = fresh();
  const [v, a] = Proj.insertMedia(p, p.media.mv, 0);
  const rights = Proj.splitAt(p, 120, [v.id]);
  assert.strictEqual(rights.length, 2);
  assert.strictEqual(v.duration, 120); assert.strictEqual(a.duration, 120);
  assert.ok(Math.abs(rights[0].src_in - 4) < 1e-9);
  assert.ok(rights[0].link && rights[0].link === rights[1].link && rights[0].link !== v.link);
  ok(p);
});

t('トリムは素材の範囲で止まり、リンク相手も一緒', () => {
  const p = fresh();
  const [v, a] = Proj.insertMedia(p, p.media.mv, 30);
  Proj.trim(p, v, 'start', 0);                    // 素材の頭より前には伸ばせない
  assert.strictEqual(v.start, 30);
  Proj.trim(p, v, 'start', 60);
  assert.strictEqual(v.start, 60); assert.strictEqual(a.start, 60); assert.ok(Math.abs(a.src_in - 1) < 1e-9);
  Proj.trim(p, v, 'end', 10000);                  // 素材の終わりまで
  assert.strictEqual(Proj.end(v), 330);
  Proj.trim(p, v, 'start', 10);                   // 頭を戻す（src_in 1 秒 = 30 フレームまで）
  assert.strictEqual(v.start, 30); assert.strictEqual(v.src_in, 0);
  ok(p);
});

t('移動先は上書き（下のクリップを切り詰める・分割する）', () => {
  const p = fresh();
  const [v1] = Proj.insertMedia(p, p.media.mv, 0, { vtrack: 'v1', atrack: 'a1' });
  const [img] = Proj.insertMedia(p, p.media.im, 400, { vtrack: 'v2' });
  Proj.moveClips(p, [img.id], -300, { [img.id]: 'v1' });   // V1 の 100〜250 に重ねる → V1 は 3 つに
  assert.strictEqual(img.track, 'v1'); assert.strictEqual(img.start, 100);
  const on = Proj.clipsOn(p, 'v1');
  assert.deepStrictEqual(on.map((c) => [c.start, c.duration]), [[0, 100], [100, 150], [250, 50]]);
  assert.ok(Math.abs(on[2].src_in - 250 / 30) < 1e-9);
  ok(p);
  void v1;
});

t('リップル削除は全トラックが空いた所だけ詰める', () => {
  const p = fresh();
  const [a1v, a1a] = Proj.insertMedia(p, p.media.mv, 0);
  const [b1v, b1a] = Proj.insertMedia(p, p.media.mv, 300);
  const [bgm] = Proj.insertMedia(p, p.media.au, 0, { atrack: 'a2' });     // 0〜120 に BGM
  Proj.deleteClips(p, [a1v.id], true);
  // 0〜120 は BGM があるので残り、120〜300 だけ詰まる
  assert.strictEqual(b1v.start, 120); assert.strictEqual(b1a.start, 120); assert.strictEqual(bgm.start, 0);
  assert.ok(!p.clips[a1a.id]);
  ok(p);
});

t('速さ 2 倍で長さが半分、fps を変えても秒は同じ', () => {
  const p = fresh();
  const [v] = Proj.insertMedia(p, p.media.mv, 30, { vtrack: 'v1' });
  Proj.setSpeed(p, v, 2);
  assert.strictEqual(v.duration, 150);
  Proj.setFps(p, 60);
  assert.strictEqual(v.start, 60); assert.strictEqual(v.duration, 300);
});

t('履歴の写しと戻し', () => {
  const p = fresh();
  const before = Proj.snapshot(p);
  Proj.insertMedia(p, p.media.mv, 0);
  assert.notStrictEqual(Proj.snapshot(p), before);
  Proj.restore(p, before);
  assert.strictEqual(Object.keys(p.clips).length, 0);
});

console.log(tests, 'tests passed');
