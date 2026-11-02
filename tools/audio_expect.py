"""exe の audiofx.py で見本を作る（node tools/test_audio.cjs が突き合わせる）。
python tools/audio_expect.py  → tools/fixtures/audio_in.f32（試験の音、48k ステレオ）と audio_expect.json・audio_*.f32"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tools" / "fixtures"
sys.path.insert(0, str(ROOT.parent / "eikobo" / "src"))
from eikobo.core import audiofx as fx  # noqa: E402

SR = 48000
rng = np.random.default_rng(7)
t = np.arange(SR * 6) / SR
# 声らしい音（強弱のあるうなり）＋ 雑音、右は少し違う
env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.7 * t) ** 2
voice = (0.3 * np.sin(2 * np.pi * 220 * t) + 0.15 * np.sin(2 * np.pi * 1300 * t)) * env * (t > 1.0)
noise = rng.normal(0, 0.02, (len(t), 2))
x = np.stack([voice, voice * 0.8], axis=1) + noise
x[int(SR * 4.0):int(SR * 4.05)] *= 4          # 大きな山（リミッター用）
x = x.astype(np.float32)
x.tofile(FIX / "audio_in.f32")

out = {}
m = fx.LoudnessMeter()
m.feed(x)
out["lufs"] = m.integrated()
out["peak_db"] = m.peak_db()
eq = fx.EQ_PRESETS["声をくっきり"]
out["eq_sos"] = fx.eq_sos(eq).tolist()
out["eq_sos_tel"] = fx.eq_sos(fx.EQ_PRESETS["電話の声"]).tolist()
from scipy import signal  # noqa: E402
signal.sosfilt(fx.eq_sos(eq), x, axis=0).astype(np.float32).tofile(FIX / "audio_eq.f32")
fx.compress(x, -20.0, 3.0, 4.0).astype(np.float32).tofile(FIX / "audio_comp.f32")
fx.Limiter(-1.0).process((x * 3).astype(np.float32)).astype(np.float32).tofile(FIX / "audio_lim.f32")
fx.denoise_block(x, fx.noise_profile((x * 32767).astype(np.int16)), 0.8).astype(np.float32).tofile(FIX / "audio_dn.f32")
(FIX / "audio_expect.json").write_text(json.dumps(out), encoding="utf-8")
print("lufs", out["lufs"])
