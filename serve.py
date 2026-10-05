"""開発用の小さなサーバ。

    py -3 serve.py
    → http://127.0.0.1:8080/

ES モジュール（import / export）は file:// では動かないので、HTTP で配る必要がある。
標準ライブラリだけ。追加インストールは要らない。
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
PORT = 8080


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):      # アクセスログを静かにする
        pass

    def end_headers(self):
        # 作りかけを触るので、常に最新を読ませる
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    handler = partial(Handler, directory=str(BASE))
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"工業シミュレーション基盤  ->  http://127.0.0.1:{port}/")
    print("終了するには Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました。")
