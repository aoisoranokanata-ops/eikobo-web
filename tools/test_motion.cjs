// motion.js を exe の motion.py と突き合わせる
//   python tools/motion_expect.py > tools/fixtures/motion_expect.json
//   node tools/test_motion.cjs
const fs = require('fs');
const path = require('path');
global.fetch = async (u) => ({ json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', u), 'utf8').replace(/^﻿/, '')) });
const Motion = require('../js/motion.js');

(async () => {
  const exp = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'motion_expect.json'), 'utf8').replace(/^﻿/, ''));
  await Motion.load();
  const ids = Motion.catalog.motions.map((m) => m.id);
  const missing = exp.ids.filter((i) => !ids.includes(i));
  console.log('motions', ids.length, 'exe', exp.ids.length, 'missing', missing);
  let bad = 0, n = 0;
  for (const [id, idx, salt, v] of exp.rand) { n++; if (Math.abs(Motion.unitRandom(id, idx, salt) - v) > 1e-12) { bad++; console.log('rand', id, idx, salt); } }
  const geo = { whole: [[300, 60], [0, 0, 600, 120]], lines: [[[300, 30], [0, 0, 600, 60]], [[300, 90], [0, 60, 600, 120]]], sizePx: 96, W: 1920, H: 1080 };
  const counts = { whole: 1, line: 2, char: 9 };
  for (const cs of exp.cases) {
    const plan = Motion.makePlan(cs.motion, 3.0, counts);
    for (const [t, line, char, M, op, blur, tint, wipes] of cs.rows) {
      n++;
      const s = line < 0 ? Motion.unitState(plan, t, geo, { box: true })
        : Motion.unitState(plan, t, geo, { line, char, pivot: [40 + char * 60, 30 + line * 60], rect: [char * 60, line * 60, char * 60 + 60, line * 60 + 60] });
      const diffs = [];
      if (M) M.forEach((v, i) => { if (Math.abs(v - s.M[i]) > 1e-6) diffs.push(`M${i} ${v} vs ${s.M[i]}`); });
      if (Math.abs(op - s.opacity) > 1e-9) diffs.push(`opacity ${op} vs ${s.opacity}`);
      if (line >= 0 && Math.abs(blur - s.blur) > 1e-9) diffs.push(`blur ${blur} vs ${s.blur}`);
      if (line >= 0 && Math.abs(tint - s.tint) > 1e-9) diffs.push(`tint ${tint} vs ${s.tint}`);
      if (line >= 0 && JSON.stringify(wipes.map((w) => [w[1].toFixed(9), w[2]])) !== JSON.stringify(s.wipes.map((w) => [w[1].toFixed(9), w[2]]))) diffs.push('wipes');
      if (diffs.length) { bad++; if (bad < 10) console.log(JSON.stringify(cs.motion), t, line, char, diffs.join('; ')); }
    }
  }
  console.log(n, 'checks,', bad, 'mismatches');
  process.exit(bad ? 1 : 0);
})();
