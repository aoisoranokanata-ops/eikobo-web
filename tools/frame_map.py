"""書き出しの各コマが、元の動画のどのコマに一番似ているか（python tools/frame_map.py 元 書き出し [間隔]）。
コマの取り違え・時間のずれを探す用。小さく縮めた灰色の絵どうしで比べる。"""
import subprocess
import sys

import numpy as np

FF = r"C:\Users\pck\AppData\Local\JDownloader 2.0\tools\Windows\ffmpeg\x64\ffmpeg.exe"
W, H = 48, 27


def frames(path):
    out = subprocess.run([FF, "-v", "error", "-i", path, "-map", "0:v", "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).reshape(-1, W * H).astype(np.float32)


src, exp = frames(sys.argv[1]), frames(sys.argv[2])
step = int(sys.argv[3]) if len(sys.argv) > 3 else 50
print("コマ数", len(src), len(exp))
bad = 0
for i in range(0, len(exp), step):
    d = np.abs(src - exp[i]).mean(axis=1)
    j = int(d.argmin())
    same = float(np.abs(src[min(i, len(src) - 1)] - exp[i]).mean())
    flag = "" if j == i or same <= d[j] + 1.0 else "  ← ずれ"
    bad += bool(flag)
    print(f"書き出し {i:5d} → 元 {j:5d}（差 {d[j]:.1f}、同じ番号との差 {same:.1f}）{flag}")
print("ずれ", bad)
