# 他の作者のもの（AI 高画質化で使う部品）

映工房 Web 本体は外部のライブラリを使っていませんが、書き出しの「AI 高画質化」だけは次のものを同梱しています。
どちらも使う時（初めて AI 高画質化を選んだ時）に読み込まれます。

## onnxruntime-web 1.30.0（`vendor/ort/`）
AI のモデルをブラウザ（WebGPU）で動かす部品。npm の `onnxruntime-web` から
`ort.webgpu.min.js`・`ort-wasm-simd-threaded.asyncify.mjs`・`ort-wasm-simd-threaded.asyncify.wasm` を写したもの（手を加えていない）。
onnxruntime が使っている他の部品の告知: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Real-ESRGAN の重み（`models/`）
https://github.com/xinntao/Real-ESRGAN の公式の重み（SRVGGNetCompact）を `tools/esrgan_to_onnx.py` で ONNX にしたもの。
- `general_x4*.onnx` = realesr-general-x4v3
- `general_light_x4*.onnx` = realesr-general-x4v3 と realesr-general-wdn-x4v3 を半分ずつ混ぜたもの（Real-ESRGAN の denoise_strength 0.5 と同じ）
- `anime_x4*.onnx` = realesr-animevideov3
- `*_fp16.onnx` は同じ重みを半精度にしたもの

```
BSD 3-Clause License

Copyright (c) 2021, Xintao Wang
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
