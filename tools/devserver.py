"""開発用サーバー（python -m http.server と同じ）＋ 検証用のファイル受け取り。

PUT /tools/fixtures/<名前> で、ブラウザが作ったファイル（動画・PNG など）を tools/fixtures/ に書く。
検証用。127.0.0.1 だけで待ち受け、fixtures の外には書かない。
キャッシュさせない（Cache-Control: no-store）ので、直したスクリプトがすぐ読み込まれる。
  python tools/devserver.py 8678
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tools" / "fixtures"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self):
        name = self.path.split("?")[0]
        if not name.startswith("/tools/fixtures/"):
            self.send_error(403)
            return
        target = (ROOT / name.lstrip("/")).resolve()
        if FIX.resolve() not in target.parents:
            self.send_error(403)
            return
        n = int(self.headers.get("Content-Length", "0"))
        FIX.mkdir(exist_ok=True)
        target.write_bytes(self.rfile.read(n))
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8678
    ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT))).serve_forever()
