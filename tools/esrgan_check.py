"""変換した ONNX が正しいかを確かめる（python tools/esrgan_check.py 重み.pth モデル.onnx 試験の画像 出力フォルダ）。
1) 小さな切れ端で numpy の手計算（同じ網）と onnxruntime の結果を比べる。
2) 画像を 480p 相当に劣化（ぼかし・雑音・JPEG）→ ふつうの拡大と AI の拡大を並べた絵を保存。速さも測る。"""
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).resolve().parent))
from esrgan_to_onnx import load_pth  # noqa: E402

pth, onnx_path, img_path, out_dir = sys.argv[1:5]
w = load_pth(pth)
sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])


def conv(x, W, b):
    c, h, ww = x.shape
    p = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    out = np.zeros((W.shape[0], h, ww), np.float64)
    for dy in range(3):
        for dx in range(3):
            out += np.einsum("oc,chw->ohw", W[:, :, dy, dx], p[:, dy:dy + h, dx:dx + ww])
    return out + b[:, None, None]


def ref(x):
    convs = sorted({int(k.split(".")[1]) for k in w if k.endswith(".weight") and w[k].ndim == 4})
    y = x.astype(np.float64)
    for i in convs:
        y = conv(y, w[f"body.{i}.weight"].astype(np.float64), w[f"body.{i}.bias"].astype(np.float64))
        if f"body.{i + 1}.weight" in w and w[f"body.{i + 1}.weight"].ndim == 1:
            a = w[f"body.{i + 1}.weight"].astype(np.float64)[:, None, None]
            y = np.where(y >= 0, y, a * y)
    c, h, ww = y.shape
    r = 4
    y = y.reshape(c // (r * r), r, r, h, ww).transpose(0, 3, 1, 4, 2).reshape(c // (r * r), h * r, ww * r)
    return y + np.repeat(np.repeat(x, r, axis=1), r, axis=2)


rng = np.random.default_rng(1)
patch = rng.random((3, 12, 10)).astype(np.float32)
a = ref(patch)
b = sess.run(None, {"input": patch[None]})[0][0]
print("numpy と onnxruntime の最大差", float(np.abs(a - b).max()))

img = cv2.imread(img_path)[:, :, ::-1]
small = cv2.resize(img, (640, 480), interpolation=cv2.INTER_AREA)
deg = cv2.GaussianBlur(small, (0, 0), 1.2)
deg = np.clip(deg.astype(np.float32) + rng.normal(0, 6, deg.shape), 0, 255).astype(np.uint8)
ok, enc = cv2.imencode(".jpg", deg[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 45])
deg = cv2.imdecode(enc, 1)[:, :, ::-1]
x = (deg.astype(np.float32) / 255).transpose(2, 0, 1)[None]
t0 = time.time()
y = sess.run(None, {"input": x})[0][0]
sec = time.time() - t0
up = (np.clip(y, 0, 1).transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8)
hd = cv2.resize(up, (1440, 1080), interpolation=cv2.INTER_AREA)
bic = cv2.resize(deg, (1440, 1080), interpolation=cv2.INTER_CUBIC)
crop = lambda im: im[300:700, 400:1000]
out = Path(out_dir)
cv2.imwrite(str(out / "sr_compare.png"), np.hstack([crop(bic), crop(hd)])[:, :, ::-1])
print(f"640×480 → 2560×1920（CPU の onnxruntime）{sec:.2f} 秒")
