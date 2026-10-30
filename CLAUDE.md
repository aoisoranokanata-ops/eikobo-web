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
| js/engine.js | 再生と合成（時計は AudioContext、動画は消音の video を時計に合わせ、canvas に重ねる） |
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
2. 書き出し（v0.2.0）: MP4（WebCodecs の VideoDecoder/VideoEncoder、音声は OfflineAudioContext で混ぜて AAC、MP4 の箱は自前）、
   範囲・大きさ・画質、共有シートで写真アプリへ。iPad Safari の AudioEncoder が無い時の代わりも考える。
3. テロップ・字幕（v0.3.0）: テキストクリップ、exe のスタイルカタログ・モーションの移植、字幕トラック、SRT の読み書き、吹き出し。
4. 色・トランジション・キーフレーム（v0.4.0）: WebGL の合成、色調補正・LUT、ディゾルブ・ワイプ、キーフレーム、切り抜き、カラーマット。
5. 音声（v0.5.0）: ミキサー（メーター）、音量の線、EQ・コンプ、LUFS 正規化、BGM の自動ダッキング、ナレーション録音。
6. exe との往復・仕上げ（v1.0.0）: .ekp の読み書き（素材はファイル名で結び付け）、作品のバックアップ、重い素材の扱い（プロキシ）。

## 既知の割り切り（フェーズ1）
- 書き出しはまだ無い（フェーズ2）。
- 音声は作品を開いている間メモリに置く（10 分のステレオで約 230MB）。とても長い素材は重い。
- 速さを変えると音の高さも変わる（AudioBufferSourceNode の playbackRate）。
- iPad 実機での確認はユーザー待ち（Pencil・写真アプリからの読み込み・HEVC・OPFS の容量・AudioContext の遅れ）。
