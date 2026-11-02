"""試験用の LUT（暖色寄り、9³）を tools/fixtures/warm.cube に作る。"""
from pathlib import Path

n = 9
lines = ['TITLE "warm test"', f"LUT_3D_SIZE {n}"]
for b in range(n):
    for g in range(n):
        for r in range(n):
            R, G, B = r / (n - 1), g / (n - 1), b / (n - 1)
            lines.append(f"{min(1, R * 1.1 + 0.03):.6f} {G:.6f} {max(0, B * 0.85):.6f}")
out = Path(__file__).resolve().parent / "fixtures" / "warm.cube"
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(out)
