"""Phase 0 baseline: record the same page with headless Chrome via recorder-pipe's Recorder.

Uses recorder-pipe only as a library (no edits). Run with headless Chrome already
listening on CDP_PORT, e.g.:
  Google Chrome --headless=new --remote-debugging-port=9339 --window-size=1440,810
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

PIPE_DIR = Path(
    os.environ.get("VIDEO_PIPE_DIR", Path.home() / "recorder-pipe")
).expanduser()
sys.path.insert(0, str(PIPE_DIR))

from pipe.browser_capture import Recorder  # noqa: E402


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("用法: python scripts/baseline_chrome.py <url> <out.mp4> [seconds]")
    url, out = sys.argv[1], Path(sys.argv[2])
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0
    port = int(os.environ.get("CDP_PORT", "9339"))

    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/new?" + urllib.parse.quote(url, safe=""), method="PUT"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        target = json.loads(resp.read().decode("utf-8"))

    out.parent.mkdir(parents=True, exist_ok=True)
    rec = Recorder(
        port,
        out,
        target,
        width=1920,
        height=1080,
        viewport_width=1440,
        fps=30,
        quality=90,
        settle=1.0,
    )
    try:
        rec.start()
        rec.wait(seconds)
        path = rec.stop()
    finally:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{target['id']}", timeout=5)
        except OSError:
            pass
    print(path)


if __name__ == "__main__":
    main()
