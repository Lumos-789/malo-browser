#!/usr/bin/env bash
# Build and pack the prebuilt DSH bundle for a GitHub Release.
#
# Why this exists: `out/` is gitignored and produced from TypeScript, so a plain
# `dsh plugin add <repo>` leaves index.js pointing at a compiled entry that does
# not exist. The release asset is what makes the DSH install work without a build
# step. Re-run this before every release whose entry points at a `tarball:`.
#
# Usage: scripts/pack-dsh-bundle.sh [--upload]
#   --upload  create (or replace) the release asset for the package version
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
NAME="malo-browser-${VERSION}-dsh"
STAGE="$(mktemp -d)"
OUT="/tmp/${NAME}.tgz"

trap 'rm -rf "$STAGE"' EXIT

echo "==> building out/"
npm run build >/dev/null

echo "==> staging ${NAME}"
mkdir -p "$STAGE/package"
# The bundled skill links to docs/*.md and schemas/scene.schema.json, so the
# tarball must carry them (npm's `files` is not what stages this directory).
cp -R index.js cordis.patch.yml package.json assets skills out docs schemas \
      README.md README_CN.md CHANGELOG.md LICENSE "$STAGE/package/"

echo "==> packing ${OUT}"
tar -C "$STAGE" -czf "$OUT" package

echo "==> verifying the tarball installs and imports"
VERIFY="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$VERIFY"' EXIT
(cd "$VERIFY" && npm init -y >/dev/null 2>&1 && npm install "$OUT" --no-audit --no-fund >/dev/null)
(cd "$VERIFY" && node -e "
import('malo-browser').then((m) => {
  if (typeof m.apply !== 'function' || m.name !== 'malo-browser') throw new Error('bundle does not export apply');
  console.log('   import ok: name=' + m.name + ' inject=' + JSON.stringify(m.inject));
}).catch((e) => { console.error(e.message); process.exit(1); });
")
test -f "$VERIFY/node_modules/malo-browser/out/main/index.js" || {
  echo "out/main/index.js missing from the installed bundle" >&2
  exit 1
}

echo "==> ${OUT} ($(shasum -a 256 "$OUT" | cut -d' ' -f1))"

if [[ "${1:-}" == "--upload" ]]; then
  TAG="v${VERSION}"
  echo "==> uploading to release ${TAG}"
  gh release view "$TAG" --repo Lumos-789/malo-browser >/dev/null 2>&1 || {
    echo "create the release first: gh release create ${TAG} --title '${TAG}' --notes-file <file>" >&2
    exit 1
  }
  gh release upload "$TAG" "$OUT" --repo Lumos-789/malo-browser --clobber
  echo "==> https://github.com/Lumos-789/malo-browser/releases/download/${TAG}/${NAME}.tgz"
fi
