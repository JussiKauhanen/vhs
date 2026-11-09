#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 - <<'PY'
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Timer
import webbrowser

with ThreadingHTTPServer(("127.0.0.1", 0), SimpleHTTPRequestHandler) as server:
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"VHS is running at {url}", flush=True)
    print("Keep this window open while using VHS. Press Control-C to quit.", flush=True)
    Timer(0.2, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
PY
