"""exe と Web のテロップの見た目を並べる。
1) python tools/telop_compare.py exe   → exe で描いた見本を tools/fixtures/telop_exe_<id>.png に
2) ブラウザで Web の見本を tools/fixtures/telop_web_<id>.png に（PUT）
3) python tools/telop_compare.py sheet → tools/fixtures/telop_sheet.png（左 exe・右 Web）"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tools" / "fixtures"
EXE = ROOT.parent / "eikobo"
IDS = ["triple_edge.yellow", "gradient_double.yellow", "metallic.gold", "neon.pink", "neon_tube.pink", "soft_glow.white",
       "lower_third.white", "pop_offset.yellow", "drop_shadow.white", "wafu.red", "news_flash.red", "kids_soft.pink"]
TEXT = "映工房テロップ"
SCALE = 0.6

if sys.argv[1] == "exe":
    sys.path.insert(0, str(EXE / "src"))
    from PIL import Image
    from eikobo.core import telop
    from eikobo.core.subrender import TextRenderer
    cat = telop.load_catalog([EXE / "assets" / "telop_styles"])
    r = TextRenderer()
    for sid in IDS:
        st = telop.to_clip_style(cat.get(sid))
        arr = r.render_text(TEXT, st, SCALE)
        Image.fromarray(arr, "RGBA").save(FIX / f"telop_exe_{sid}.png")
    print("ok")
else:
    from PIL import Image
    tiles = []
    for sid in IDS:
        a = Image.open(FIX / f"telop_exe_{sid}.png").convert("RGBA")
        b = Image.open(FIX / f"telop_web_{sid}.png").convert("RGBA")
        h = max(a.height, b.height)
        t = Image.new("RGBA", (a.width + b.width + 30, h + 10), (90, 110, 140, 255))
        t.alpha_composite(a, (5, 5))
        t.alpha_composite(b, (a.width + 25, 5))
        tiles.append(t)
    W = max(t.width for t in tiles)
    sheet = Image.new("RGBA", (W, sum(t.height for t in tiles)), (60, 60, 60, 255))
    y = 0
    for t in tiles:
        sheet.alpha_composite(t, (0, y))
        y += t.height
    sheet.save(FIX / "telop_sheet.png")
    print(sheet.size)
