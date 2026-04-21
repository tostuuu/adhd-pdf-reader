#!/usr/bin/env python3
"""Focus PDF Reader backend.

Serves the static web app AND exposes a tiny JSON store API so bookmarks live
in a real file on disk (outside the browser's sandboxed storage), and can be
backed up, moved between machines, or inspected with any text editor.

Storage location (macOS): ~/Library/Application Support/FocusPDFReader/bookmarks.json
"""

import http.server
import json
import os
import pathlib
import socket
import sys
import threading
from urllib.parse import urlparse

PORT = int(os.environ.get("FOCUSPDF_PORT", "8765"))
WEBROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# Platform-appropriate app data directory
if sys.platform == "darwin":
    APP_DIR = pathlib.Path.home() / "Library" / "Application Support" / "FocusPDFReader"
elif sys.platform.startswith("win"):
    APP_DIR = pathlib.Path(os.environ.get("APPDATA", pathlib.Path.home())) / "FocusPDFReader"
else:
    APP_DIR = pathlib.Path(os.environ.get("XDG_DATA_HOME", pathlib.Path.home() / ".local" / "share")) / "FocusPDFReader"

APP_DIR.mkdir(parents=True, exist_ok=True)
STORE_FILE = APP_DIR / "bookmarks.json"

_lock = threading.Lock()

DEFAULT_STORE = {
    "version": 1,
    "settings": {
        "defaultWpm": 250,
        "defaultBandSize": 5,
        "defaultAutoScroll": True,
        "defaultZoom": 1.25,
    },
    "bookmarks": {},
}


def load_store():
    with _lock:
        if not STORE_FILE.exists():
            return json.loads(json.dumps(DEFAULT_STORE))  # deep copy
        try:
            data = json.loads(STORE_FILE.read_text("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("store must be a JSON object")
            data.setdefault("version", 1)
            data.setdefault("settings", {})
            data.setdefault("bookmarks", {})
            # fill missing default setting keys
            for k, v in DEFAULT_STORE["settings"].items():
                data["settings"].setdefault(k, v)
            return data
        except Exception as e:
            print(f"[focuspdf] WARNING: corrupt store, backing up and starting fresh: {e}", file=sys.stderr)
            try:
                STORE_FILE.replace(STORE_FILE.with_suffix(".json.bak"))
            except Exception:
                pass
            return json.loads(json.dumps(DEFAULT_STORE))


def save_store(obj):
    with _lock:
        tmp = STORE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False), "utf-8")
        tmp.replace(STORE_FILE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEBROOT), **kwargs)

    # ---------- helpers ----------
    def _json_response(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- routing ----------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/store":
            return self._json_response(200, load_store())
        if path == "/api/store/meta":
            return self._json_response(200, {
                "path": str(STORE_FILE),
                "exists": STORE_FILE.exists(),
                "size": STORE_FILE.stat().st_size if STORE_FILE.exists() else 0,
            })
        return super().do_GET()

    def do_PUT(self):
        path = urlparse(self.path).path
        if path == "/api/store":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                raw = self.rfile.read(length) or b"{}"
                payload = json.loads(raw)
            except Exception:
                return self._json_response(400, {"error": "invalid JSON"})
            if not isinstance(payload, dict):
                return self._json_response(400, {"error": "expected object"})
            payload.setdefault("version", 1)
            payload.setdefault("settings", {})
            payload.setdefault("bookmarks", {})
            save_store(payload)
            return self._json_response(200, {"ok": True, "path": str(STORE_FILE)})
        self.send_error(404, "Unknown API endpoint")

    def do_DELETE(self):
        path = urlparse(self.path).path
        # /api/bookmarks/<hash>
        if path.startswith("/api/bookmarks/"):
            h = path[len("/api/bookmarks/"):]
            data = load_store()
            if h in data["bookmarks"]:
                del data["bookmarks"][h]
                save_store(data)
                return self._json_response(200, {"ok": True})
            return self._json_response(404, {"error": "not found"})
        self.send_error(404)

    def log_message(self, format, *args):
        # Only log errors and non-/api traffic to keep the console clean
        if args and isinstance(args[0], str) and args[0].startswith('"GET /api') :
            return
        sys.stderr.write("[focuspdf] %s - %s\n" % (self.address_string(), format % args))


class ReusableThreadingHTTPServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True


def main():
    print(f"[focuspdf] serving {WEBROOT} on http://localhost:{PORT}")
    print(f"[focuspdf] bookmark store: {STORE_FILE}")
    try:
        with ReusableThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        print(f"[focuspdf] could not bind port {PORT}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
