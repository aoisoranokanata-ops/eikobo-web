# 映工房 Web（eikobo-web）

映工房（exe、`../eikobo/`）の iPad 向けブラウザ版。動画編集の PWA。
利用端末: iPad Air 13 インチ（M4）Wi-Fi 256GB、Safari / ホーム画面に追加。公開は GitHub Pages。

## 決まり
- ビルドなし・外部ライブラリなし（例外は AI 高画質化の vendor/ort と models/ だけ。使う時に読み込む。THIRD_PARTY_NOTICES.md）。`index.html`＋`css/`＋`js/*.js`（**普通の script。module にしない**。グローバルで共有）。
- UI は日本語。ユーザー向けの文（途中経過・報告）も日本語。
- **ファイルを直したら `sw.js` の VERSION と `js/util.js` の APP_VERSION を両方上げる**。
- github.io は他の PWA とオリジンを共有する: キャッシュ名は `eikobo-web-` 始まり・自分の古い版だけ消す、
  IndexedDB は `eikobo-web`、OPFS は `eikobo-web/` の下、localStorage のキーは `eikobo-web:` 始まり。
- API キーが要る機能（クラウドの AI など）は入れない（紙工房 Web で外した経緯がある）。
- 作品のデータは exe の .ekp と同じフィールド名・単位（フレーム、src_in は秒、clips は {ID: クリップ}）。フェーズ6で往復させる。
- 検証で作った作品・素材は最後にブラウザから消す。

## 構成
| ファイル | 役目 |
|---|---|
| js/util.js | 小物（h()・時間の表示・トースト・小さな画面・進み具合） |
| js/store.js | 保存。IndexedDB（projects・media）＋ OPFS（素材のファイル） |
| js/opfs-worker.js | 素材を OPFS に書く Worker（Safari は同期ハンドルが Worker の中だけ） |
| js/mp4.js | MP4/MOV を自前で読む（箱・サンプル表・編集リスト・AAC→ADTS・生 PCM） |
| js/media.js | 素材の読み込み（保存→調べる→縮小画像→音声→波形）と再生用の URL・AudioBuffer・画像 |
| js/project.js | 作品のデータと編集の操作（exe の edit.py の移植）・履歴 |
| js/engine.js | 再生と合成（時計は AudioContext、動画は消音の video を時計に合わせ、canvas に重ねる）。drawFrame は書き出しと共通 |
| js/decode.js | 書き出し用に「時刻 t のコマ」を取り出す（VideoDecoder＋標本表、読めない時は video を 1 コマずつ） |
| js/stabilize.js | 手ぶれ補正（Lucas-Kanade で点を追う → RANSAC で相似変換 → 道筋をガウスでなめらかに）。解析は IndexedDB の stab |
| js/aienhance.js | AI 高画質化（Real-ESRGAN の小さい版を onnxruntime-web の WebGPU で、4 倍） |
| js/mux.js | MP4 / MOV を組み立てる（moov を前に。H.264＋AAC、AAC が無ければ MOV＋16bit PCM） |
| js/exporter.js | 書き出しの画面と本体（音声は OfflineAudioContext → AudioEncoder、映像は 1 コマずつ → VideoEncoder） |
| js/stream-worker.js | 書き出しの中身を OPFS（eikobo-web/export/）へ流す Worker |
| js/telop.js | テロップのスタイル・カタログ（assets/telop_styles を展開して 100 種）、字幕の既定、話者の吹き出しの既定、書体の置き換え |
| js/textrender.js | 文字を描く（帯 → 影 → 光彩 → 縁 → 塗り、1 行・1 文字ごとの層の絵、吹き出し）。exe の subrender.py の移植 |
| js/motion.js | モーション 71 種（assets/telop_motions）。exe の motion.py の移植（計算は完全に同じ） |
| js/telopdraw.js | テロップ・字幕を画面に置く（基準の位置・モーションの重ね方は exe の render.py と同じ） |
| js/srt.js | SRT の読み書き |
| js/stylepicker.js | スタイルのカタログの画面（見本・種類・色・検索・お気に入り） |
| js/keyframes.js | キーフレーム（exe の keyframes.py の移植）。位置・拡大・回転・不透明度・音量 |
| js/grade.js | 色調補正（exe の color.py と同じ式）を WebGL2 で。.cube の LUT は IndexedDB の luts |
| js/audiofx.js | 音声処理（exe の audiofx.py と同じ式）: ラウドネス・EQ・コンプ・ノイズ除去・リミッター・ダッキング |
| js/mixer.js | ミキサーの板（トラックの音量・パン・M/S・メーター、マスター・リミッター、ダッキング、全体のラウドネス） |
| js/recorder.js | ナレーション録音（getUserMedia → MediaRecorder → 素材にして置く） |
| js/zip.js | ZIP の読み書き（書くのは無圧縮・ZIP64、読むのは Deflate も・Shift_JIS の名前も） |
| js/ekp.js | 映工房（exe）の .ekp との変換と、ZIP（.ekp ＋ media/ ＋ luts/）の書き出し・読み込み |
| js/timeline.js | タイムライン（canvas、指・Pencil・マウス） |
| js/inspector.js | 調整パネル |
| js/gdrive.js | Google Drive（サインイン・ファイルを選ぶ画面・受け取り・分割で送る・作品のバックアップ/戻す）。oauth.html が戻り先 |
| js/app.js | 作品一覧・編集画面のつなぎ・素材の一覧・キーボード・自動保存 |

## 設計の要点
- **素材は OPFS**（IndexedDB に動画を入れない。WebKit は大きい Blob の保存に弱い）。作品から外した素材は、作品一覧に
  戻った時に「どの作品からも使われていない」ものだけ消す（編集中は取り消しで戻る可能性があるため）。
- **音声は動画ファイル丸ごとを decodeAudioData に渡さない**（4K の長い動画でメモリが尽きる）。mp4.js で音声の
  サンプルだけ読み、AAC は ADTS に包んで decodeAudioData、生 PCM（lpcm / in24 / sowt / twos …）は自前で数値に。
  QuickTime の in24 などは `enda` の箱でバイト順が変わる（ffmpeg の pcm_s24le は enda=1）。
  編集リストの頭のずれは `audio_offset`（秒）: バッファの i 番目の標本の表示時刻 = i / rate + offset。
- 再生: 音は AudioBufferSourceNode を時刻どおりに予約（フェード・音量は gain の自動化）。映像は時計とのずれが
  0.4 秒までは playbackRate を最大 ±12% 変えて寄せ、それ以上だけ飛ぶ。次のクリップは 1.5 秒前から頭で待たせる。
  出力の遅れ（outputLatency）を時計から引いて、聞こえている音に映像を合わせる。
- タイムラインのドラッグ中は作品を書き換えない（移動先は上書きなので、途中で書き換えると下のクリップが削れていく）。
  離した時に 1 回だけ編集。指は「選んだクリップ = 移動、それ以外 = 画面を動かす」、Pencil・マウスはどれでも移動。
- 素材を置く時は空いているトラックへ（無ければ足す）。exe は V1/A1 に上書きだが、指の操作で消してしまわないよう変えた。
- はめ方・位置・拡大・回転（正 = 時計回り）・フェードの式は exe の render.py と同じ。

### 書き出し（フェーズ2）の要点
- 映像の色: RGB の VideoFrame を VideoEncoder に渡すと、YUV への換算式はブラウザ任せ（Windows の Chrome は BT.601）。
  ファイルには BT.709 の印（colr）を付けるので、**canvas の RGB を自前で BT.709・リミテッドの I420 にしてから渡す**（exporter.js の toI420）。
  確かめる時は ffmpeg で `scale=in_color_matrix=bt709` を付けて読む（付けないと BT.601 で読まれる）。
  ffmpeg の testsrc は BT.601 で作られて印が無いので、Chrome（BT.709 として読む）とは元から色が違う。色の比較は写真（JPEG）の部分で。
- **ctts は常に符号付きで読む**（QuickTime の MOV は version 0 でも負の値。読み違えると表示時刻が 34 万秒になり、
  書き出しに毎回キーフレームが出た）。
- Worker への書き込みはバッファを「転送」するので、書いた後の Uint8Array は長さ 0。長さは書く前に測る（mux.js）。
- 音声の時刻: AAC の頭の遅れ（priming）には編集リストを付けていないが、ffmpeg で測ってずれ 0ms だった（Chrome）。
- **AAC の設定（AudioSpecificConfig）は `Mux.aacConfig` で取り出す**（v1.2.1）。iPad で書き出した動画が写真アプリで無音だった。
  前は `description.buffer` をそのまま使っていて、view（大きな ArrayBuffer の一部）で来ると関係ないバイトまで入り、AAC が読めなくなる
  （avcC の方は byteOffset を守っていた）。esds の箱・ES_Descriptor の形でも DecoderSpecificInfo を探し、48kHz・2ch の AAC でなければ
  既定（11 90）。中身が ADTS なら頭を外す（`Mux.stripAdts`）。`node tools/test_aac_mux.cjs` で各形を作り ffmpeg で鳴ることを確認
  （前の作りは decode エラー）。
- さらに書き出しの中で、作った AAC の大きい所 3 秒をその端末の AudioDecoder で戻し、元の RMS の 1/4 未満・エラーなら
  無圧縮の PCM（MOV）に切り替える（`verifyAac`）。書き出し後の画面に「音声: AAC…この端末で鳴ることを確認済み／無圧縮（MOV）…／無音です」を出す。
  MOV の hdlr は QuickTime の決まりどおり 'mhlr'。確かめは Playwright で偽の AudioEncoder（Safari の形の description・壊れた中身）を入れて書き出し → ffmpeg。
  **iPad 実機で確認済み（2026-11-03）**: 「AAC…この端末で鳴ることを確認済み」と出て、写真アプリで音が出た（MOV に切り替わらず、ファイルの大きさも普通）。
  → 原因は description の取り出し（view の .buffer）だったと見てよい。
- 共有（navigator.share）は押した操作の中でしか呼べない → 書き出しが終わったら「共有・写真に保存」ボタンを出す。
- 速さ（この PC の Chrome）: 1080p で実時間の約 2 倍（2:25 の MV が 77 秒）。I420 の換算と getImageData が半分くらい。
- 確かめる道具: `tools/sync_check.py`（光と音のずれ、試験素材は sync.mp4）、`tools/frame_map.py`（書き出しの各コマが元のどのコマか）。

### テロップ・字幕（フェーズ3）の要点
- データは exe と同じ: テロップ = 映像トラックの media 無し・text ありのクリップ（style・motion）、字幕 = kind 'subtitle' の
  トラックのクリップ、作品の subtitle_style（speakers に話者ごとの吹き出し）。style のフォント名は exe の名前のまま持ち、
  描く時だけ Telop.cssFamily で iPad の書体（ヒラギノ角ゴ・明朝・丸ゴ）に置き換える。
- カタログの JSON は exe の assets をそのまま写したもの（両方とも自作）。exe 側を直したら写し直す。
- 描き方: 縁は strokeText（線の太さ = 縁 × 2、角は丸）＋ fillText。ぼかし（影・光彩）は **ctx.filter が iPad で使えないので
  shadowBlur（= σ × 2）で、形を画面の外に描いて影だけを戻す**。光彩の強さ（1.6 など）は同じ影を重ねる回数で近似。
  古い style（outline / shadow: true）は TextRender.richen で同じ見た目の形に直して描く。
  exe と同じ文字・同じスタイルで、絵の大きさが 12 種すべて画素単位で一致（tools/telop_compare.py で並べて確認）。
- モーションの計算は `node tools/test_motion.cjs`（`python tools/motion_expect.py` で exe の値を作る）で 3084 か所が一致。
  単位ごとの乱数は zlib.crc32 と同じ CRC32。1 文字ずつのモーション中のぼかしは「縮めて広げる」近似、拭き取りは
  destination-in のグラデーション（exe と同じ柔らかさ）。
- 1 文字ずつ動かす時は「層ごとに全部の文字を描く」（exe と同じ。文字ごとに全部の層だと隣の縁が塗りに被る）。
- 描く速さ（この PC）: 1 文字ずつのモーション中の 1080p の 1 コマが約 3ms。文字の絵はキャッシュ（80 個）。

### 色・トランジション・キーフレーム（フェーズ4）の要点
- 色調補正は exe と同じ順（トーン表 → 彩度（HSV）→ ホワイトバランス → 3D LUT）を WebGL2 の 1 枚のシェーダで。
  共有の WebGL の canvas に描いてすぐ drawImage する。トーン表・WB・組み込み LUT・キーフレームは `node tools/test_grade.cjs`
  （`python tools/grade_expect.py` で exe の値）で 34 項目一致。写真で exe の Grader と比べて平均差 0.77。
  WebGL に直接渡せない絵（Safari の VideoFrame など）は 2D の canvas を通す。LUT の参照は builtin:teal_orange / user:<ID>
  （exe はファイルのパス。行き来はフェーズ6で名前で結ぶ）。
- トランジションは exe の Compositor._state と blend_transition と同じ: 切れ目を中心に、前後のクリップをはみ出させ、
  「下の段まで描いた絵 + 出る側」「+ 入る側」の 2 枚（作業 canvas）を種類ごとに混ぜる。素材の頭より前・終わりより後は
  最初・最後のコマ（映像）、音は無し（exe と同じ）。
- 音声: 音量のキー（dB のまま直線）・フェード・等パワーのクロスフェード・トラックの音量を 20ms ごとの値のカーブにして
  setValueCurveAtTime。再生と書き出しで同じ Engine.scheduleEntry（書き出しは renderMix）。
- キーフレームのある属性は、スライダーやプレビューのドラッグで動かすと再生位置のキーを作る・直す（無ければ普通の値）。
  分割・頭のトリム・上書き・詰めて削除でキーをずらし（Keys.shift）、切れ目の側のモーションを外す（exe と同じ）。
### 音声（フェーズ5）の要点
- 音の通り道: クリップ（音量のキー・フェード・クロスフェードのカーブ）→ トラック（音量 → パン（exe と同じ等パワーで
  中央 1.0、分けて左右に掛ける）→ ダッキング → メーター）→ マスター（音量 → 再生中は DynamicsCompressor で近似の
  リミッター）。書き出しはリミッターを exe と同じ計算（AudioFx.limit）で後から掛ける。トラックの音量は通り道で掛ける
  （ミキサーを動かしている間も止めずに Engine.liveMix で反映）。ダッキングの声の混ぜ方だけはトラックの音量込み（exe と同じ）。
- クリップのエフェクト（afx: eq / comp / denoise）は **素材の音を一度だけ JS で処理して覚える**（AudioFx.processed）。
  再生と書き出しで同じ音。順番は exe と同じ（ノイズ除去 → EQ → コンプ）。ノイズ除去は 6 秒で 0.3 秒ほど（PC）→ 選んだ時に
  進み具合を出して済ませておく。exe はプリロール 100ms でその場で掛けるが、素材全体に掛けるのと結果はほぼ同じ。
- `node tools/test_audio.cjs`（`python tools/audio_expect.py` で exe の結果）: ラウドネス・ピーク・EQ の係数と結果・
  コンプ・リミッター・ノイズ除去が一致。ダッキングの下げ幅は exe の式と 409 点で差 0.0 dB、書き出しで BGM がちょうど 12 dB 下がる。
- モノラルの素材は左右に同じ音として測る・鳴らす（Web Audio の up-mix と同じ）。
- 録音は再生と同時に始めるので、再生の始まりまでの差（約 0.1 秒＋出力の遅れ）だけ頭を削って置く。マイクの入力の遅れは見ていない。
  確かめる時は getUserMedia を OscillatorNode の MediaStreamDestination に差し替えると、録音 → 読み込み → 配置まで通せる。
### exe との往復（フェーズ6）の要点
- .ekp は exe の to_json / from_json と同じ形（format 3）。項目名は最初から同じにしてあるので、ekp.js は形を整えるだけ
  （exe の dataclass に無い項目は書かない）。Web だけの項目（作品の id・名前・cover など）は .ekp に入らない。
- 書き出し（作品一覧の ⋯ →「Windows 版へ・バックアップ」）: ZIP に `<名前>.ekp`・`media/<素材>`・`luts/<LUT>.cube`。
  素材の path / rel_path も LUT も .ekp からの相対パス。**exe は v1.3.1 で LUT も相対パスで探すようにした**
  （eikobo/tests/test_ekp_relative_lut.py）。ZIP は OPFS（eikobo-web/export/bundle.zip）へ流して作る。
- 読み込み（作品一覧の「読み込む」）: .ekp だけ・ZIP（Windows の「送る→圧縮」= Deflate、古い Windows の Shift_JIS 名も）。
  素材は rel_path（.ekp の場所から）→ ファイル名の順で ZIP の中を探し、**exe と同じ素材 ID のまま**取り込む
  （Media.importFile の opts.id）。見つからない素材は「素材」の「まとめて選ぶ」（名前で結ぶ）か 1 つずつ「差し替え」。
  同じ exe の作品を 2 回読み込むと素材は同じ ID なので使い回される。LUT は ZIP の中の .cube を取り込むか、同じ名前の読み込み済み LUT。
- 確かめ方: `python tools/roundtrip_exe.py [zip] [フレーム…]`（Web の ZIP を exe のコードで開いて、素材・LUT が見つかるか、
  exe の合成器で描いた絵と Web の絵 rt_web_<f>.png を比べる）。exe → Web は `python tools/make_sjis_zip.py` で
  Shift_JIS の ZIP も作れる。結果: Web → exe は平均差 2.6〜3.6（試験動画の BT.601/709 の解釈の違いが大半）、
  exe → Web（掛け合いサンプルの吹き出し字幕）は 1.5〜1.9。
- 往復の確認中に見つけた不具合: **VideoDecoder の flush を待つ間に出てきたコマを手元に溜めると、デコーダが次を出せずに
  止まる**（素材の終わり近くを読むと書き出しも止まりうる）→ flush は待たずに出てきたコマを受け取り続ける（decode.js）。
- exe の古い書き方の字幕（outline 指定）は行の高さに縁 × 2 を足し、文字を行の上端から描く（TextRender.richen の _legacy）。
- 切り抜きは見えている向きの割合。素材の回転（スマホの縦動画）がある時は回転前の割合に直して drawImage の範囲に。

### AI 高画質化・手ぶれ補正（v1.1.0）の要点
- **AI 高画質化**は書き出しの画面だけ（プレビューでは掛けない。1 コマ 0.5 秒かかるため）。「今のコマで試す」で等倍の比較。
  モデルは Real-ESRGAN の SRVGGNetCompact（BSD-3）。公式の .pth（GitHub の Release）を `tools/esrgan_to_onnx.py` で
  torch なしで ONNX に（pickle を自前で読む。--blend で 2 つを混ぜる、--fp16 で半精度）。`tools/esrgan_check.py` で numpy の手計算と一致を確認。
  実行は onnxruntime-web 1.30.0 の WebGPU（numThreads=1。GitHub Pages は SharedArrayBuffer が無い）。shader-f16 があれば *_fp16.onnx。
- 対象は 1280×720 以下の動画クリップ（iPad の canvas は約 1600 万画素まで、4 倍で 5120×2880）。既定は「出力で元より大きく映る」ものだけ、
  「拡大しない動画にも」でノイズ除去として全部。4 倍の絵は getSource の `iw・ih`（絵そのものの画素）で渡し、置き方は元の w・h で決める
  （Engine.drawClip）。同じ素材のコマ（スロー）は描き直さない。書き出しの描き手は `Exporter.framePainter`（「今のコマで試す」と共通）。
- 書き出しの大きさは短い辺で選ぶ（2160 / 1080 / 720、作品より大きいと「拡大」）。
- 速さ（GTX 1660S の Chrome、fp16）: 640×480 の 1 コマ 約 0.55 秒（general）・0.32 秒（anime）、うち推論 0.44 秒。1280×720 は約 1.3 秒。
  640 画素の区切り（1 回で回す）は 512 画素で 2 回より少し速い。iPad は未確認。
- 効果（tools/make_ai_fixtures.py の blur480_nat。写真を 640×480 に縮め、ぼかし σ1.3・ノイズ・700kbps）: 劣化前の 1440×1080 と比べて
  ふつうの拡大 PSNR 27.05 / SSIM 0.837 → general 28.26 / 0.895、anime 28.16 / 0.898、light 27.66 / 0.880。ノイズがほぼ消え、縁が締まる。
  失われた細部は戻らない（それらしく描くだけ）ことはユーザーに伝えてある。
- sw.js: vendor/ と models/ は版をまたぐ別のキャッシュ（`eikobo-web-ai-1`）にキャッシュ優先で。大きいので普段の 6 秒の待ちでは落ちる。
  中身を変える時はファイル名かキャッシュ名を変える。
- **手ぶれ補正**は AI のモデルではない（ワープスタビライザーと同じ考え方）。320 画素幅の白黒・見えている向きで解析（プレビューの video と
  書き出しの読み手で回転の扱いが違うため）。区画ごとの Shi-Tomasi の角 → ピラミッド式 Lucas-Kanade → RANSAC の相似変換。
  道筋（積み上げ）をガウス（σ = なめらかさ秒 × fps / 2）でなめらかにし、差だけ動かす。drawClip でクリップの回転の後・素材の回転の前に掛ける。
  自動の拡大 = 全コマで「回転した四角が画面を覆う大きさ＋ずれ」の最大（上限 1.5）。98 パーセンタイルにしたら端が 2 コマ見えた。
- 手ぶれの確かめ（shaky.mp4 = 写真をパン＋揺れ・回転、本当の動きは shaky_truth.json）: 推定の誤差 0.06 画素・0.01°、180 コマの解析 1.2 秒。
  補正後の揺れ 6.5 → 0.08 画素/コマ。書き出した動画をもう一度解析して 0.23 画素/コマ・回転 0.18 → 0.02°/コマ、端の黒は出ない。
- クリップの `stab = {on, strength, zoom}` は .ekp にも書く（exe は知らない項目を読み飛ばす）。解析の結果は IndexedDB の stab（素材 ID ごと。
  素材を消すと一緒に消す）。クリップの範囲を超えたら「解析し直す」（前の範囲も含めて解析）。
### Google Drive（v1.2.0）の要点
- 紙工房 Web の js/gdrive.js・oauth.html と同じ作り（ライブラリ無し、OAuth のトークンだけの流れ＋ Drive REST v3 を fetch / XHR で）。
  クライアント ID は利用者が作って貼る（localStorage `eikobo-web:gdrive`）。同じオリジンなので**紙工房 Web と同じクライアント ID を使える**
  （設定の画面で `kamikobo-web.gdrive` を読んで入れておく。Google Cloud で「承認済みのリダイレクト URI」に eikobo-web/oauth.html を足すだけ）。
  権限は drive.file ＋ drive.readonly、保存先はマイドライブの「映工房 Web」フォルダ。
- サインイン: Safari のタブ＝小窓（oauth.html が `eikobo-web:gdrive-token` に置き、本体は 0.5 秒ごとに見る）。ホーム画面アプリ・小窓が
  開けない時＝ページごと移る → oauth.html → `./` → 起動時の `GDrive.resume` が続きをする（編集中だった作品を開き直す。送りかけのファイルは
  OPFS の eikobo-web/export/gd-pending）。小窓はクリックの中でしか開けないので `GDrive.go` はボタンの中で await より前に呼ぶ。
- 動画は大きいので: 受け取りは OPFS（export/gd-…）へ 4MB ずつ流して File にし、使い終わったら消す（cleanTemp）。
  送るのは resumable を 32MB ずつ（Content-Range）。通信が切れたら待って `bytes */全体` で受け取り済みの所を聞き、続きから（6 回まで）。やめられる。
- 入口: 作品一覧の「☁️ Google Drive」（作品を読み込む・バックアップから戻す・すべての作品をバックアップ・クライアント ID・サインアウト）、
  作品の ⋯「☁️ Google Drive にバックアップ」（= 「Windows 版へ・バックアップ」と同じ .zip）、素材の「☁️ Drive」（動画・音声・画像）、
  見つからない素材の「☁️ Google Drive から選ぶ」（名前で結ぶ = App.linkFiles）、書き出し・.zip の後の「☁️ Google Drive に保存」。
- sw.js は ./ と index.html だけを index.html として覚える（oauth.html を混ぜない）。
- 確かめ方: Playwright で accounts.google.com・googleapis.com を route で偽物にして（302 で oauth.html#access_token=…、
  resumable は Location と 308 + Range）、小窓とページごと（window.open = () => null）の両方を通した。

## 確かめ方
- 開発サーバー: `.claude/launch.json` の `eikobo-web`（`python eikobo-web/tools/devserver.py 8678`）。no-store、`PUT /tools/fixtures/<名前>` で
  ブラウザから PNG などを書き出せる（画面が撮れない時はこれで canvas を見る）。
- `node tools/test_mp4.cjs [ファイル]`（MP4/MOV の解析と音声の数値化）、`node tools/test_edit.cjs`（編集の操作）。
- 試験用の素材は tools/fixtures（gitignore）に JDownloader 同梱の ffmpeg で作る（作り方は README の末尾）。
- ブラウザ枠が隠れていると requestAnimationFrame が止まる → 確かめる時だけ
  `window.requestAnimationFrame = f => setTimeout(() => f(performance.now()), 16)` に差し替える。
- 疑似の PointerEvent では setPointerCapture が例外になる → 呼び出しは try で囲んである。
- `Engine.debugVideos()` で動画の「あるべき位置 / 実際の位置」、`Timeline.geom()` で座標。

## フェーズ
1. **基盤（v0.1.0、2026-10-30）**: 作品一覧・素材の読み込み（動画・音声・画像、OPFS）・タイムライン（複数トラック、移動・トリム・
   分割・削除・詰めて削除・スナップ・マーカー・複数選択・拡大縮小）・プレビュー再生（音声同期・コマ送り）・プレビューで直接
   移動/拡大/回転・調整パネル（はめ方・位置・拡大・回転・不透明度・音量・フェード・速さ・有効）・取り消し・自動保存・オフライン。
2. **書き出し（v0.2.0、2026-10-30）**: MP4（H.264＋AAC、moov が前）。範囲（全体・選んだクリップ）・大きさ・画質、
   やめる、画面を消さない（Wake Lock）、共有シートで写真へ／ダウンロード。AAC が無い端末は MOV＋16bit PCM。
   PC の Chrome で: コマの位置は元と全コマ一致、音と映像のずれ 0ms、MV（H.264＋24bit lpcm の MOV）も一致。iPad 実機は未確認。
3. **テロップ・字幕（v0.3.0、2026-11-02）**: テキストクリップ（スタイル 100 種・書体・色・縁・帯・基準の位置）、モーション 71 種
   （登場・強調・退場、1 行・1 文字ずつ）、字幕トラック、SRT の読み書き、話者の吹き出し、字幕全体の見た目、書き出しで焼き込むか選ぶ。
4. **色・トランジション・キーフレーム（v0.4.0、2026-11-02）**: 色調補正 8 項目・ルック 8 種・LUT（組み込み・.cube）、
   トランジション 9 種（音声はクロスフェード）、キーフレーム（位置・拡大・回転・不透明度・音量、補間 5 種）、切り抜き、カラーマット。
5. **音声（v0.5.0、2026-11-02）**: ミキサー（音量・パン・M/S・メーター）、マスターの音量とリミッター、クリップの EQ・コンプ・
   ノイズ除去、ラウドネスをそろえる（同じ素材はまとめて）、全体のラウドネス、BGM の自動ダッキング（サイドチェイン）、
   ナレーション録音、タイムラインの音量の線。
6. **exe との往復（v1.0.0、2026-11-02）= 全フェーズ完了**: .ekp ＋素材＋ LUT の ZIP を書き出す（Windows 版へ・バックアップ）、
   .ekp / ZIP を読み込む（素材は相対パス → 名前で結ぶ、まとめて差し替え）。以降は使いながら改修。
   プロキシ（重い素材の軽い代わり）は入れていない（iPad の動画の再生は OS のハードウェアに任せている）。
7. **AI 高画質化・手ぶれ補正（v1.1.0、2026-11-03）**: 書き出しで AI 高画質化（Real-ESRGAN、4 倍、480p → 1080p など）、
   書き出しの大きさに拡大を追加、クリップの手ぶれ補正（動きの解析）。iPad 実機の WebGPU・速さは未確認。
8. **Google Drive（v1.2.0、2026-11-03）**: 紙工房 Web と同じ形で。作品のバックアップ（.zip）と戻す、ドライブの .ekp / .zip を読み込む、
   素材（動画・音声・画像）の読み込み・見つからない素材を名前で結ぶ、書き出した動画・.zip の保存。
   v1.2.1: iPad で書き出した動画が写真アプリで無音になる不具合を直した（AAC の設定の取り出し・端末での確かめ・だめなら PCM の MOV）。
   iPad 実機で AAC のまま音が出ることを確認済み。

## 既知の割り切り（フェーズ1）
- 音声は作品を開いている間メモリに置く（10 分のステレオで約 230MB）。とても長い素材は重い。エフェクトを掛けたクリップは
  処理済みの音も持つ（最大 12 個）。
- 速さを変えると音の高さも変わる（AudioBufferSourceNode の playbackRate）。
- iPad 実機での確認はユーザー待ち（Pencil・写真アプリからの読み込み・HEVC・OPFS の容量・AudioContext の遅れ）。
