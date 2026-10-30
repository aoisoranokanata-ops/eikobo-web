"""音と映像のずれを測る（python tools/sync_check.py <動画>…）。
sync.mp4 のような「白く光るコマ」と「カチッという音」が同時にある動画で、光った時刻と鳴った時刻の差（ミリ秒）を出す。
ffmpeg は JDownloader 同梱のものを使う。"""
import subprocess
import sys

import numpy as np

FF = r"C:\Users\pck\AppData\Local\JDownloader 2.0\tools\Windows\ffmpeg\x64\ffmpeg.exe"


def flashes(path):
    out = subprocess.run([FF, "-v", "error", "-i", path, "-map", "0:v", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    fr = np.frombuffer(out, np.uint8).reshape(-1, 36 * 64).mean(axis=1)
    rate = float(subprocess.run([FF, "-i", path], capture_output=True, text=True).stderr.split(" fps")[0].split()[-1])
    idx = [i for i in range(1, len(fr)) if fr[i] > 128 and fr[i - 1] <= 128]
    return [i / rate for i in idx]


def clicks(path):
    out = subprocess.run([FF, "-v", "error", "-i", path, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    a = np.abs(np.frombuffer(out, np.float32))
    on = np.where(a > 0.2)[0]
    res = []
    last = -1e9
    for s in on:
        if s - last > 4800:
            res.append(s / 48000)
        last = s
    return res


for p in sys.argv[1:]:
    f, c = flashes(p), clicks(p)
    print(p, "光:", [round(x, 3) for x in f], "音:", [round(x, 3) for x in c],
          "差(ms 音-光):", [round((cc - ff) * 1000, 1) for ff, cc in zip(f, c)])
