# 映工房 Web

iPad で使う動画編集アプリ（ブラウザで動く PWA）。映工房（Windows 版）の姉妹アプリです。

公開先: https://aoisoranokanata-ops.github.io/eikobo-web/

## 使い方
1. Safari で開き、共有ボタン →「ホーム画面に追加」（全画面で使え、端末の保存領域も消されにくくなります）。
2. 「＋ 新しい作品」→「＋ 読み込む」で、写真アプリ・ファイル・iCloud Drive から動画・音声・画像を選びます。
   タイムラインが空なら、読み込んだ順に並びます。素材の「＋」で再生位置に置けます。
3. タイムライン
   - 指でクリップをタップして選ぶ → もう一度ドラッグで移動（上下の段にも）。端の黄色い取っ手でトリム。
   - 選んでいない所のドラッグは画面の移動、2 本指で拡大縮小。Apple Pencil・マウスはどのクリップもそのまま動かせます。
   - 目盛りを触ると再生位置が動きます。
   - 「分割」は再生位置で切ります（選んでいればそのクリップ、無ければ全部）。「詰めて削除」は空いた所を詰めます。
   - 見出しの「目」= 映像の表示、「M」= ミュート、「S」= ソロ、「鍵」= ロック。トラック名を触ると名前・音量・削除。
4. プレビューで選んだクリップをドラッグ = 移動、角 = 拡大、2 本指 = 拡大と回転。細かい値は右の「調整」で。
5. 保存は自動です（左上に「保存済み」）。

### キーボード（Magic Keyboard など）
スペース 再生・停止／← → 1 コマ（Shift で 1 秒）／↑ ↓ 前後の編集点／S または ⌘K 分割／Delete 削除（Shift で詰めて削除）／
M マーカー／⌘Z 取り消し・⇧⌘Z やり直し／＋ − 拡大縮小／\ 全体

## 注意
- 素材はこの端末のブラウザの中に保存されます（他の端末とは共有されません）。
- 写真アプリから選ぶと、iPad が動画を変換して小さくすることがあります。元のままにしたい時は「ファイル」から選んでください。
- 動画の書き出しは次の版で入ります。

## 開発メモ
設計・確かめ方は CLAUDE.md。試験用の素材の作り方（ffmpeg）:
```
ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=30:duration=8 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=8 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 tools/fixtures/clipA.mp4
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24:duration=5 -f lavfi -i sine=frequency=660:duration=5 -c:v libx264 -pix_fmt yuv420p -c:a pcm_s24le tools/fixtures/pcm.mov
```
