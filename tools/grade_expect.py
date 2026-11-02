"""exe の color.py・keyframes.py で見本を作る（node tools/test_grade.cjs が突き合わせる）。
python tools/grade_expect.py > tools/fixtures/grade_expect.json"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

EXE = Path(__file__).resolve().parents[2] / "eikobo" / "src"
sys.path.insert(0, str(EXE))
from eikobo.core import color, keyframes  # noqa: E402

grades = [
    {"exposure": 0.7}, {"contrast": 40}, {"contrast": -60}, {"gamma": 1.8}, {"shadows": 50}, {"highlights": -70},
    {"exposure": -0.5, "contrast": 20, "gamma": 0.8, "shadows": -30, "highlights": 25},
    {"temperature": 60, "tint": -40}, {"temperature": -80},
]
out = {"tone": [], "wb": [], "builtin": None, "keys": []}
for g in grades:
    out["tone"].append([g, color._tone_table(g).tolist()])
    wb = color._wb_tables(g)
    out["wb"].append([g, wb.tolist() if wb is not None else None])
cube = color._builtin("teal_orange")          # [b][g][r][3]
out["builtin"] = cube.reshape(-1).tolist()

keys = {"opacity": [[0, 0.0, "ease"], [30, 1.0, "linear"], [60, 0.5, "hold"], [90, 1.0, "ease_out"], [120, 0.2, "ease_in"]],
        "scale": [[10, 1.0, "ease_in"], [100, 2.5, "linear"]]}
clip = SimpleNamespace(start=100, duration=150, keys=keys, opacity=1.0, scale=1.0)
for f in [90, 100, 107, 115.5, 130, 145, 160, 175, 189, 199, 205, 219, 230, 260]:
    out["keys"].append([f, keyframes.value_at(clip, "opacity", f), keyframes.value_at(clip, "scale", f)])
c2 = SimpleNamespace(start=0, duration=80, keys={"opacity": [[0, 0.0, "linear"], [20, 1.0, "linear"], [50, 0.3, "linear"], [100, 0.9, "linear"]]})
keyframes.shift_keys(c2, 30)
out["shift"] = c2.keys
json.dump(out, sys.stdout)
