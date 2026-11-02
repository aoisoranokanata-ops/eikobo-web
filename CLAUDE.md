# 映工房 Web（eikobo-web）

映工房（exe、`../eikobo/`）の iPad 向けブラウザ版。動画編集の PWA。
利用端末: iPad Air 13 インチ（M4）Wi-Fi 256GB、Safari / ホーム画面に追加。公開は GitHub Pages。

## 決まり
- ビルドなし・外部ライブラリなし。`index.html`＋`css/`＋`js/*.js`（**普通の script。module にしない**。グローバルで共有）。
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
| js/timeline.js | タイムライン（canvas、指・Pencil・マウス） |
| js/inspector.js | 調整パネル |
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
- 切り抜きは見えている向きの割合。素材の回転（スマホの縦動画）がある時は回転前の割合に直して drawImage の範囲に。

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
5. 音声（v0.5.0）: ミキサー（メーター）、音量の線、EQ・コンプ、LUFS 正規化、BGM の自動ダッキング、ナレーション録音。
6. exe との往復・仕上げ（v1.0.0）: .ekp の読み書き（素材はファイル名で結び付け）、作品のバックアップ、重い素材の扱い（プロキシ）。

## 既知の割り切り（フェーズ1）
- 音声は作品を開いている間メモリに置く（10 分のステレオで約 230MB）。とても長い素材は重い。
- 速さを変えると音の高さも変わる（AudioBufferSourceNode の playbackRate）。
- iPad 実機での確認はユーザー待ち（Pencil・写真アプリからの読み込み・HEVC・OPFS の容量・AudioContext の遅れ）。
