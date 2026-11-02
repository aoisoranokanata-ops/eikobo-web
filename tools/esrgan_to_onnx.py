"""Real-ESRGAN の小さい版（SRVGGNetCompact）の公式の重み（.pth）→ ONNX（torch なしで）。
python tools/esrgan_to_onnx.py 重み.pth 出力.onnx [--blend 別の重み.pth 割合] [--fp16]

- .pth（PyTorch の zip 形式）は pickle を自前で読む（torch のテンソルを numpy に置き換える）。
- 網の形: conv3x3(3→64) → PReLU → [conv3x3(64→64) → PReLU] × n → conv3x3(64→48) → PixelShuffle(4)（= DepthToSpace CRD）
  ＋ 入力を最近傍で 4 倍にしたもの（xinntao/Real-ESRGAN の SRVGGNetCompact と同じ）。
- --blend: 2 つの重みを混ぜる（Real-ESRGAN の denoise_strength と同じ。割合は 1 つ目の重みの比）。
- 入力 input [1, 3, H, W]（0〜1 の RGB）、出力 output [1, 3, 4H, 4W]。H・W は自由。
"""
import argparse
import pickle
import zipfile
from collections import OrderedDict

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64, "LongStorage": np.int64,
          "IntStorage": np.int32, "BFloat16Storage": None}


def load_pth(path):
    z = zipfile.ZipFile(path)
    pkl = next(n for n in z.namelist() if n.endswith("data.pkl"))
    root = pkl[: -len("data.pkl")]

    class Storage:
        def __init__(self, name):
            self.name = name

    def rebuild(storage, offset, size, stride, *args):
        dt, key = storage
        raw = np.frombuffer(z.read(f"{root}data/{key}"), dtype=dt)
        if not size:
            return raw[offset:offset + 1].reshape(()).copy()
        item = raw.itemsize
        return np.lib.stride_tricks.as_strided(raw[offset:], shape=tuple(size), strides=tuple(s * item for s in stride)).copy()

    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if mod == "torch._utils" and name == "_rebuild_tensor_v2":
                return rebuild
            if mod == "torch" and name.endswith("Storage"):
                return Storage(name)
            if mod == "collections" and name == "OrderedDict":
                return OrderedDict
            if mod == "torch._utils" and name == "_rebuild_parameter":
                return lambda data, requires_grad, hooks: data
            raise pickle.UnpicklingError(f"知らない型 {mod}.{name}")

        def persistent_load(self, pid):
            _, st, key, _loc, _n = pid
            return (DTYPES[st.name], key)

    obj = U(z.open(pkl)).load()
    for k in ("params_ema", "params"):
        if isinstance(obj, dict) and k in obj:
            return obj[k]
    return obj


def build(w, fp16=False):
    convs = sorted({int(k.split(".")[1]) for k in w if k.endswith(".weight") and w[k].ndim == 4})
    acts = {int(k.split(".")[1]) for k in w if k.endswith(".weight") and w[k].ndim == 1}
    dt = np.float16 if fp16 else np.float32
    et = TensorProto.FLOAT16 if fp16 else TensorProto.FLOAT
    inits, nodes = [], []
    x = "input"
    if fp16:
        nodes.append(helper.make_node("Cast", ["input"], ["x16"], to=TensorProto.FLOAT16))
        x = "x16"
    src = x
    cur = x
    for i in convs:
        W, B = w[f"body.{i}.weight"].astype(dt), w[f"body.{i}.bias"].astype(dt)
        inits += [numpy_helper.from_array(W, f"w{i}"), numpy_helper.from_array(B, f"b{i}")]
        out = f"c{i}"
        nodes.append(helper.make_node("Conv", [cur, f"w{i}", f"b{i}"], [out], kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        cur = out
        if i + 1 in acts:
            slope = w[f"body.{i + 1}.weight"].astype(dt).reshape(-1, 1, 1)
            inits.append(numpy_helper.from_array(slope, f"s{i + 1}"))
            nodes.append(helper.make_node("PRelu", [cur, f"s{i + 1}"], [f"a{i + 1}"]))
            cur = f"a{i + 1}"
    nodes.append(helper.make_node("DepthToSpace", [cur], ["up"], blocksize=4, mode="CRD"))
    inits.append(numpy_helper.from_array(np.array([1, 1, 4, 4], np.float32), "scales"))
    nodes.append(helper.make_node("Resize", [src, "", "scales"], ["base"], mode="nearest", coordinate_transformation_mode="asymmetric", nearest_mode="floor"))
    sum_out = "sum16" if fp16 else "output"
    nodes.append(helper.make_node("Add", ["up", "base"], [sum_out]))
    if fp16:
        nodes.append(helper.make_node("Cast", ["sum16"], ["output"], to=TensorProto.FLOAT))
    g = helper.make_graph(nodes, "srvgg", [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "H", "W"])],
                          [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, "H4", "W4"])], inits)
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], producer_name="eikobo-web")
    m.ir_version = 8
    onnx.checker.check_model(m)
    return m, len(convs) - 2


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pth")
    ap.add_argument("out")
    ap.add_argument("--blend", nargs=2, metavar=("PTH", "RATIO"))
    ap.add_argument("--fp16", action="store_true")
    a = ap.parse_args()
    w = load_pth(a.pth)
    if a.blend:
        w2, r = load_pth(a.blend[0]), float(a.blend[1])
        w = OrderedDict((k, (r * v.astype(np.float64) + (1 - r) * w2[k].astype(np.float64)).astype(np.float32)) for k, v in w.items())
    m, n = build(w, a.fp16)
    onnx.save(m, a.out)
    print(a.out, "body convs", n, "params", sum(v.size for v in w.values()))
