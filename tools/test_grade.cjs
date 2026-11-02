// 色調補正の表・キーフレームを exe と突き合わせる
//   python tools/grade_expect.py > tools/fixtures/grade_expect.json
//   node tools/test_grade.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
global.uid = () => 'x';
global.Store = {};
const Keys = require('../js/keyframes.js');
// grade.js は普通の script なので、そのまま読んで Grade を取り出す
const ctx = { console, Math, Float32Array, Uint8Array, Number, Object, String, Error, Map, document: { createElement: () => ({}) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'grade.js'), 'utf8') + '\nthis.Grade = Grade;', ctx);
const Grade = ctx.Grade;

const exp = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'grade_expect.json'), 'utf8').replace(/^﻿/, ''));
let bad = 0, n = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

for (const [g, table] of exp.tone) {
  const t = Grade.toneTable(g);
  let worst = 0;
  table.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - t[i])); });
  n++; if (worst > 0) { bad++; console.log('tone', JSON.stringify(g), 'worst', worst); }
}
for (const [g, tables] of exp.wb) {
  n++;
  if (!tables) continue;
  const f = Grade.wbFactors(g);
  let worst = 0;
  tables.forEach((row, i) => row.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - Math.min(255, Math.max(0, Math.floor(i * f[k] + 0.5))))); }));
  if (worst > 0) { bad++; console.log('wb', JSON.stringify(g), 'worst', worst); }
}
const b = Grade.builtin('teal_orange');
let worst = 0;
exp.builtin.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - b.data[i])); });
n++; if (worst > 1e-6) { bad++; console.log('builtin LUT worst', worst); }

const keys = { opacity: [[0, 0, 'ease'], [30, 1, 'linear'], [60, 0.5, 'hold'], [90, 1, 'ease_out'], [120, 0.2, 'ease_in']], scale: [[10, 1, 'ease_in'], [100, 2.5, 'linear']] };
const clip = { start: 100, duration: 150, keys, opacity: 1, scale: 1 };
for (const [f, op, sc] of exp.keys) {
  n++;
  const a = Keys.valueAt(clip, 'opacity', f), s = Keys.valueAt(clip, 'scale', f);
  if (!near(a, op, 1e-12) || !near(s, sc, 1e-12)) { bad++; console.log('keys', f, a, op, s, sc); }
}
const c2 = { start: 0, duration: 80, keys: { opacity: [[0, 0, 'linear'], [20, 1, 'linear'], [50, 0.3, 'linear'], [100, 0.9, 'linear']] } };
Keys.shift(c2, 30);
n++; if (JSON.stringify(c2.keys) !== JSON.stringify(exp.shift)) { bad++; console.log('shift', JSON.stringify(c2.keys), JSON.stringify(exp.shift)); }

console.log(n, 'checks,', bad, 'mismatches');
process.exit(bad ? 1 : 0);
