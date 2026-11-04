#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build

PORT=4788
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory out/fixture >/tmp/malo-browser-fixture.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 1

npx electron . --mode=record --seconds=10 --out=evidence --label=hidden
npx electron . --mode=record --window-mode=inactive --seconds=10 --out=evidence --label=inactive
