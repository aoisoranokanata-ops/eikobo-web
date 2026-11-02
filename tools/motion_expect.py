"""exe の motion.py で、モーションの計算の見本を作る（node tools/test_motion.cjs が突き合わせる）。
python tools/motion_expect.py > tools/fixtures/motion_expect.json"""
import json
import sys
from pathlib import Path

EXE = Path(__file__).resolve().parents[2] / "eikobo" / "src"
sys.path.insert(0, str(EXE))
from eikobo.core import motion as mo  # noqa: E402

cat = mo.load_catalog([EXE.parent / "assets" / "telop_motions"])
out = {"ids": [m["id"] for m in cat.motions], "cases": [], "rand": []}
for mid, idx, salt in [("in.char_blur", 0, 0), ("in.char_blur", 7, 2), ("emph.shake", 3, 1), ("x", 12, 99)]:
    out["rand"].append([mid, idx, salt, mo.unit_random(mid, idx, salt)])
picks = {"in": None, "emph": None, "out": None}
cases = []
for m in cat.motions:
    cm = {m["kind"]: {"id": m["id"]}}
    cases.append(cm)
# 組み合わせもいくつか
ins = [m["id"] for m in cat.motions if m["kind"] == "in"]
emphs = [m["id"] for m in cat.motions if m["kind"] == "emph"]
outs = [m["id"] for m in cat.motions if m["kind"] == "out"]
for i in range(6):
    cases.append({"in": {"id": ins[i * 3 % len(ins)], "dur": 0.6}, "emph": {"id": emphs[i % len(emphs)]}, "out": {"id": outs[i * 2 % len(outs)]}})
counts = {"whole": 1, "line": 2, "char": 9}
geo = mo.Geometry(((300, 60), (0, 0, 600, 120)), [((300, 30), (0, 0, 600, 60)), ((300, 90), (0, 60, 600, 120))], 96.0, 1920, 1080)
for cm in cases:
    plan = mo.make_plan(cm, 3.0, counts, cat)
    rows = []
    for t in [0.0, 0.05, 0.13, 0.31, 0.5, 1.2, 2.0, 2.71, 2.93, 3.0]:
        for line, char in [(0, 0), (1, 5), (0, 8)]:
            st = mo.unit_state(plan, t, geo, line, char, (40 + char * 60, 30 + line * 60), (char * 60, line * 60, char * 60 + 60, line * 60 + 60))
            M = st.M
            rows.append([t, line, char, [M[0, 0], M[1, 0], M[0, 1], M[1, 1], M[0, 2], M[1, 2]], st.opacity, st.blur, st.tint,
                         [[list(w[0]), w[1], w[2]] for w in st.wipes]])
        bst = mo.unit_state(plan, t, geo, box=True)
        rows.append([t, -1, -1, None, bst.opacity, 0, 0, []])
    out["cases"].append({"motion": cm, "rows": rows})
json.dump(out, sys.stdout, ensure_ascii=False)
