#!/bin/bash

# Make a zip file for distributing the extension.
#
# Default output:           /tmp/SourceMonkey.zip
# With --release VERSION:   /tmp/SourceMonkey-vVERSION.zip
#
# The versioned name is used by scripts/release-extension.sh so the
# downloaded release artifact is self-identifying.
#
# `dist/` is both the unpacked extension and the `sourcemonkey` npm
# package, so it holds two things Chrome never loads: the `.d.ts`
# declarations a TypeScript consumer of the package needs, and
# `harness/`, the Node-side development harness (docs/harness-design.md).
# Neither is packed. Nothing the extension loads imports either — the
# harness imports the extension's modules, not the other way round.

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
cd dist && zip -rq "$TARGET" . -x '*.d.ts' 'harness/*'

echo
echo "Made zip file in $TARGET ($(du -h "$TARGET" | cut -f1))"
