"""Web 版が書き出した ZIP を exe のコードで開いて確かめる（python tools/roundtrip_exe.py [zip] [フレーム…]）。
展開 → Project.load → 素材・LUT が見つかるか → 指定のフレームを exe の合成器で描いて、Web の絵（rt_web_<f>.png）と比べる。"""
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tools" / "fixtures"
sys.path.insert(0, str(ROOT.parent / "eikobo" / "src"))
from eikobo.core.project import Project  # noqa: E402
from eikobo.core.render import Compositor  # noqa: E402

zpath = Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].endswith(".zip") else FIX / "roundtrip.zip"
frames = [int(a) for a in sys.argv[1:] if a.isdigit()] or [10, 60, 160]
tmp = Path(tempfile.mkdtemp())
try:
    zipfile.ZipFile(zpath).extractall(tmp)
    ekp = next(tmp.glob("*.ekp"))
    p = Project.load(str(ekp))
    print("tracks", [(t.name, t.kind) for t in p.tracks])
    print("clips", len(p.clips), "markers", [(m.frame, m.name) for m in p.markers])
    for m in p.media.values():
        print("media", m.name, "found" if Path(m.path).exists() else "MISSING")
    for c in p.clips.values():
        if c.grade and c.grade.get("lut"):
            print("lut", c.grade["lut"], "found" if Path(c.grade["lut"]).exists() or c.grade["lut"].startswith("builtin:") else "MISSING")
        if c.keys:
            print("keys", c.name or c.text, c.keys)
        if c.motion or c.trans_in or c.afx:
            print("extra", c.name or c.text, c.motion, c.trans_in, c.afx)
    print("ducking", p.ducking, "subtitle speakers", list((p.subtitle_style.get("speakers") or {}).keys()))
    comp = Compositor(p, scale=0.5)
    for f in frames:
        exe = comp.render(f).astype(float)
        web = np.asarray(Image.open(FIX / f"rt_web_{f}.png").convert("RGB"), float)
        d = np.abs(exe - web)
        Image.fromarray(np.hstack([exe, web]).astype(np.uint8)).save(FIX / f"rt_cmp_{f}.png")
        print(f"frame {f}: mean diff {d.mean():.2f}  (99% {np.percentile(d, 99):.0f})")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
