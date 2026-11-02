"""日本語の Windows の古い「圧縮フォルダー」と同じ、名前が Shift_JIS（UTF-8 の印なし）の ZIP を作る（読み込みの確認用）。
python tools/make_sjis_zip.py 出力.zip 中の名前=元のファイル …"""
import sys
import zipfile


def _sjis(self):
    return self.filename.encode("cp932"), self.flag_bits & ~0x800


zipfile.ZipInfo._encodeFilenameFlags = _sjis
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for arg in sys.argv[2:]:
        name, src = arg.split("=", 1)
        z.write(src, name)
with open(sys.argv[1], "rb") as f:
    data = f.read()
print("flags", [hex(i.flag_bits) for i in zipfile.ZipFile(sys.argv[1], metadata_encoding="cp932").infolist()],
      [i.filename for i in zipfile.ZipFile(sys.argv[1], metadata_encoding="cp932").infolist()])
