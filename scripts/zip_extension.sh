#!/bin/bash

# Make a zip file for distributing the extension.
#
# Default output:           /tmp/SourceMonkey.zip
# With --release VERSION:   /tmp/SourceMonkey-vVERSION.zip, plus
#                           /tmp/SourceMonkey-vVERSION-store.zip
#
# The versioned name is used by scripts/release.sh so the
# downloaded release artifact is self-identifying.
#
# The store zip is for uploading to the Chrome Web Store, which doesn't
# accept a manifest with `key`, so it leaves that out. The other zip keeps
# `key`: Chrome derives an unpacked extension's ID from it, so a copy loaded
# from the zip gets the same ID as the store's copy and the browsers sm-dev
# launches, which is how sm-dev finds SourceMonkey in a person's own Chrome.
#
# `dist/` is the unpacked extension and nothing else, so this packs all
# of it. The `sourcemonkey` package is built separately into `lib/`
# (docs/architecture.md).

set -euo pipefail

usage() {
  cat <<EOF
Usage: scripts/zip_extension.sh [--release VERSION] [--help]

Builds the extension and zips dist/ for distribution.

Options:
  --release VERSION   Tag the zip with VERSION
                      (/tmp/SourceMonkey-vVERSION.zip), and also make
                      /tmp/SourceMonkey-vVERSION-store.zip without the
                      manifest's key, for the Chrome Web Store.
                      Default is /tmp/SourceMonkey.zip.
  --help              Show this help and exit.
EOF
}

VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      if [[ -z "${2:-}" || "$2" == -* ]]; then
        echo "--release requires a VERSION argument" >&2
        usage >&2
        exit 2
      fi
      VERSION="$2"
      shift 2
      ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ -n "$VERSION" ]]; then
  TARGET="/tmp/SourceMonkey-v${VERSION}.zip"
else
  TARGET="/tmp/SourceMonkey.zip"
fi

pnpm run build

rm -f "$TARGET"
(cd dist && zip -rq "$TARGET" .)

echo
echo "Made zip file in $TARGET ($(du -h "$TARGET" | cut -f1))"

if [[ -n "$VERSION" ]]; then
  STORE_TARGET="/tmp/SourceMonkey-v${VERSION}-store.zip"
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' EXIT
  cp -r dist/. "$STAGE"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    delete manifest.key;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  ' "$STAGE/manifest.json"
  rm -f "$STORE_TARGET"
  (cd "$STAGE" && zip -rq "$STORE_TARGET" .)
  echo "Made Chrome Web Store zip in $STORE_TARGET ($(du -h "$STORE_TARGET" | cut -f1))"
fi
