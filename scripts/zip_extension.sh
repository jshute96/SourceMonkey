#!/bin/bash

# Make a zip file for distributing the extension.
#
# Default output:           /tmp/SourceMonkey.zip
# With --release VERSION:   /tmp/SourceMonkey-vVERSION.zip
#
# The versioned name is used by scripts/release-extension.sh so the
# downloaded release artifact is self-identifying.
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
                      (/tmp/SourceMonkey-vVERSION.zip).
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
cd dist && zip -rq "$TARGET" .

echo
echo "Made zip file in $TARGET ($(du -h "$TARGET" | cut -f1))"
