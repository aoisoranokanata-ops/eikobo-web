r"""AI 高画質化・手ぶれ補正の試験素材を作る（python tools/make_ai_fixtures.py）。
- tools/fixtures/blur480.mp4: 640×480・30fps・3 秒。写真をゆっくり寄りながら、ぼかし・ノイズ・低いビットレート（古いアナログ映像の代わり）
- tools/fixtures/blur480_nat.mp4: 同じ作り方を Windows の写真（C:\Windows\Web\Screen\img103.jpg）で。
  45 コマ目の劣化させる前の 1440×1080 を blur480_nat_truth45.png に（AI と普通の拡大のどちらが元に近いか測る）
- tools/fixtures/shaky.mp4: 960×540・30fps・6 秒。ゆっくり右へパンしながら手ぶれ（ずれ・回転）。本当の動きは shaky_truth.json
写真は tools/fixtures/photo.jpg。ffmpeg は JDownloader 同梱のもの。
"""
import json
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np

FF = r"C:\Users\pck\AppData\Local\JDownloader 2.0\tools\Windows\ffmpeg\x64\ffmpeg.exe"
FIX = Path(__file__).resolve().parent / "fixtures"
photo = cv2.imread(str(FIX / "photo.jpg"))
H, W = photo.shape[:2]


def encode(path, w, h, fps, frames, extra):
    p = subprocess.Popen([FF, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                          "-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                          "-c:v", "libx264", "-pix_fmt", "yuv420p", *extra, str(path)], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    assert p.wait() == 0


def blur480(src=photo, name="blur480"):
    rng = np.random.default_rng(3)
    out = []
    H, W = src.shape[:2]
    for i in range(90):
        z = 1 + 0.15 * i / 89
        cw = min(W, H * 4 / 3) / z
        ch = cw * 3 / 4
        x0, y0 = (W - cw) / 2, (H - ch) / 2
        m = np.float32([[640 / cw, 0, -x0 * 640 / cw], [0, 480 / ch, -y0 * 480 / ch]])
        if i == 45 and name != "blur480":
            k = 1440 / 640
            mt = np.float32([[m[0, 0] * k, 0, m[0, 2] * k], [0, m[1, 1] * k, m[1, 2] * k]])
            cv2.imwrite(str(FIX / f"{name}_truth45.png"), cv2.warpAffine(src, mt, (1440, 1080), flags=cv2.INTER_AREA))
        f = cv2.warpAffine(src, m, (640, 480), flags=cv2.INTER_AREA)
        f = cv2.GaussianBlur(f, (0, 0), 1.3)
        f = np.clip(f.astype(np.float32) + rng.normal(0, 7, f.shape), 0, 255).astype(np.uint8)
        out.append(f)
    encode(FIX / f"{name}.mp4", 640, 480, 30, out, ["-b:v", "700k"])


def shaky():
    fps, n, ow, oh = 30, 180, 960, 540
    truth = []
    out = []
    for i in range(n):
        t = i / fps
        pan = 120 * t / 6
        dx = 12 * math.sin(2 * math.pi * 3.1 * t) + 6 * math.sin(2 * math.pi * 7.3 * t)
        dy = 9 * math.sin(2 * math.pi * 2.3 * t + 1) + 5 * math.sin(2 * math.pi * 6.1 * t)
        rot = 0.8 * math.sin(2 * math.pi * 1.7 * t)
        # カメラの中心（写真の画素）。写真 → 出力は 0.75 倍
        s = 0.75
        cx, cy = W / 2 - 60 + pan + dx, H / 2 + dy
        m = cv2.getRotationMatrix2D((cx, cy), rot, s)
        m[0, 2] += ow / 2 - cx
        m[1, 2] += oh / 2 - cy
        out.append(cv2.warpAffine(photo, m, (ow, oh), flags=cv2.INTER_LINEAR))
        # 画面の中身の動き（出力の画素）: カメラが +x へ動くと中身は −x へ
        truth.append({"x": -(pan + dx) * s, "y": -dy * s, "rot": rot, "shake_x": -dx * s, "shake_y": -dy * s})
    encode(FIX / "shaky.mp4", ow, oh, fps, out, ["-crf", "18"])
    (FIX / "shaky_truth.json").write_text(json.dumps(truth))


blur480()
blur480(cv2.imread(r"C:\Windows\Web\Screen\img103.jpg"), "blur480_nat")
shaky()
print("ok")
