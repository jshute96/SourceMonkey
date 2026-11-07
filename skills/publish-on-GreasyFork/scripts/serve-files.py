#!/usr/bin/env python3
"""
Serve local files to the prefill userscript for a short time, then exit.

greasyfork-url.py starts this in the background, because a browser can't be
handed a local file through a URL. It's given a folder and the paths under it
to serve, such as `serve-files.py proj img/shot.png`, and prints one line of
JSON with the URL the server runs at:

  {"base": "http://localhost:<port>/gf-prefill-<token>"}

Each file is at <base>/files/<path>, and <base>/alive answers while the
server is up. Nothing else is served. The prefill userscript refuses loopback
URLs without this "gf-prefill-" form, so a link can't use the script to read
from other local services.
"""
import argparse
import json
import mimetypes
import secrets
import sys
import threading
import time
from urllib.parse import unquote, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# How long to wait for the first request. The normal path contacts the server
# within seconds, so this only runs out when the userscript isn't installed; it
# leaves time to go and install it.
FIRST_CONTACT_SECONDS = 300

# How long to stay up after the last request. While someone signs in, the
# userscript pings every 20 seconds, but Chrome can slow timers in a hidden tab
# to once a minute, so this has to be longer than that.
IDLE_SECONDS = 90


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument("--first-contact-seconds", type=float, default=FIRST_CONTACT_SECONDS)
  parser.add_argument("--idle-seconds", type=float, default=IDLE_SECONDS)
  parser.add_argument("root", type=Path, help="the folder the paths are under")
  parser.add_argument("paths", nargs="*", help="the paths to serve, relative to the folder")
  args = parser.parse_args()

  # Only these exact paths are served, so ".." or another name finds nothing.
  allowed = set(args.paths)
  prefix = f"/gf-prefill-{secrets.token_urlsafe(16)}"
  # The time of the last request, or None before the first.
  last_request = [None]

  class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
      last_request[0] = time.monotonic()
      try:
        self.answer()
      finally:
        last_request[0] = time.monotonic()

    def answer(self):
      path = unquote(urlsplit(self.path).path)
      if path == f"{prefix}/alive":
        self.send_body(b"ok", "text/plain")
        return
      served = path.removeprefix(f"{prefix}/files/")
      if served == path or served not in allowed:
        self.send_error(404)
        return
      file = args.root / served
      try:
        body = file.read_bytes()
      except OSError:
        self.send_error(404)
        return
      self.send_body(body, mimetypes.guess_type(file.name)[0] or "application/octet-stream")

    def send_body(self, body, content_type):
      self.send_response(200)
      self.send_header("Content-Type", content_type)
      self.send_header("Content-Length", str(len(body)))
      self.end_headers()
      self.wfile.write(body)

    def log_message(self, format, *log_args):
      pass

  server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
  server.daemon_threads = True
  threading.Thread(target=server.serve_forever, daemon=True).start()

  print(json.dumps({"base": f"http://localhost:{server.server_address[1]}{prefix}"}), flush=True)
  sys.stdout.close()

  started = time.monotonic()
  while True:
    last = last_request[0]
    now = time.monotonic()
    if last is None and now - started > args.first_contact_seconds:
      return 0
    if last is not None and now - last > args.idle_seconds:
      return 0
    time.sleep(min(1, args.idle_seconds / 4))


if __name__ == "__main__":
  sys.exit(main())
