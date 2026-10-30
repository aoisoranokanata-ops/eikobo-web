"""アイコンを作る（python tools/make_icons.py）。フィルムの枠に「映」。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT = r"C:\Windows\Fonts\YuGothB.ttc"


def icon(size: int, pad_ratio: float = 0.0) -> Image.Image:
    S = size * 4
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = int(S * pad_ratio)
    r = int(S * 0.22)
    d.rounded_rectangle([pad, pad, S - pad - 1, S - pad - 1], r, fill=(27, 31, 40, 255))
    inner = S - 2 * pad
    # フィルムの穴
    hole_w, hole_h = int(inner * 0.07), int(inner * 0.05)
    for i in range(6):
        x = pad + int(inner * (0.12 + i * 0.152))
        for y in (pad + int(inner * 0.08), pad + int(inner * 0.87)):
            d.rounded_rectangle([x, y, x + hole_w, y + hole_h], int(hole_h * 0.3), fill=(61, 139, 253, 255))
    # 文字
    font = ImageFont.truetype(FONT, int(inner * 0.5))
    text = "映"
    bb = d.textbbox((0, 0), text, font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    d.text((S / 2 - tw / 2 - bb[0] - inner * 0.06, S / 2 - th / 2 - bb[1]), text, font=font, fill=(240, 242, 246, 255))
    # 再生の三角
    t = int(inner * 0.09)
    cx, cy = pad + int(inner * 0.85), pad + int(inner * 0.70)
    d.polygon([(cx - t * 0.6, cy - t), (cx - t * 0.6, cy + t), (cx + t, cy)], fill=(255, 210, 63, 255))
    return im.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    icon(192).save(out / "icon-192.png")
    icon(512).save(out / "icon-512.png")
    # iOS は角を自分で丸めるので、四角いまま塗りつぶす
    im = icon(180)
    bg = Image.new("RGBA", im.size, (27, 31, 40, 255))
    bg.alpha_composite(im)
    bg.convert("RGB").save(out / "apple-touch-icon.png")
    print("ok")


if __name__ == "__main__":
    main()
