#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 - <<'PY'
import ctypes
import json
import sys
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Timer


def load_pointer():
    """Read the Mac's mouse position with CoreGraphics (no extra installs)."""
    if sys.platform != "darwin":
        return None
    try:
        cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

        class Point(ctypes.Structure):
            _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

        class Size(ctypes.Structure):
            _fields_ = [("w", ctypes.c_double), ("h", ctypes.c_double)]

        class Rect(ctypes.Structure):
            _fields_ = [("origin", Point), ("size", Size)]

        cg.CGEventCreate.restype = ctypes.c_void_p
        cg.CGEventCreate.argtypes = [ctypes.c_void_p]
        cg.CGEventGetLocation.restype = Point
        cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
        cg.CGEventSourceButtonState.restype = ctypes.c_bool
        cg.CGEventSourceButtonState.argtypes = [ctypes.c_int32, ctypes.c_uint32]
        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGGetActiveDisplayList.restype = ctypes.c_int32
        cg.CGGetActiveDisplayList.argtypes = [
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_uint32),
        ]
        cg.CGDisplayBounds.restype = Rect
        cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
        cf.CFRelease.argtypes = [ctypes.c_void_p]

        def pointer():
            event = cg.CGEventCreate(None)
            if not event:
                return None
            try:
                p = cg.CGEventGetLocation(event)
            finally:
                cf.CFRelease(event)
            # Source state 0 = combined session, button 0 = left.
            return p.x, p.y, 1 if cg.CGEventSourceButtonState(0, 0) else 0

        def displays():
            ids = (ctypes.c_uint32 * 16)()
            count = ctypes.c_uint32(0)
            cg.CGGetActiveDisplayList(16, ids, ctypes.byref(count))
            main = cg.CGMainDisplayID()
            out = []
            for i in range(count.value):
                r = cg.CGDisplayBounds(ids[i])
                out.append({
                    "x": r.origin.x, "y": r.origin.y,
                    "w": r.size.w, "h": r.size.h,
                    "main": ids[i] == main,
                })
            return out

        if pointer() is None or not displays():
            return None
        return pointer, displays
    except Exception as err:
        print("Pointer tracking is unavailable:", err, flush=True)
        return None


POINTER = load_pointer()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/__vhs/info"):
            return self.info()
        if self.path.startswith("/__vhs/pointer"):
            return self.pointer_stream()
        return super().do_GET()

    def info(self):
        body = json.dumps({
            "pointer": bool(POINTER),
            "displays": POINTER[1]() if POINTER else [],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def pointer_stream(self):
        """Server-sent events: wall-clock ms, x, y (screen points), button."""
        if not POINTER:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        get = POINTER[0]
        try:
            while True:
                p = get()
                if p:
                    line = "data: %d,%.1f,%.1f,%d\n\n" % (time.time() * 1000, *p)
                    self.wfile.write(line.encode())
                    self.wfile.flush()
                time.sleep(1 / 60)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


server = None
for port in (8765, 0):
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        break
    except OSError:
        continue

with server:
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"VHS is running at {url}", flush=True)
    print("Pointer tracking:", "on" if POINTER else "off", flush=True)
    print("Keep this window open while using VHS. Press Control-C to quit.", flush=True)
    Timer(0.2, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
PY
