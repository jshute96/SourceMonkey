#!/usr/bin/env bash
#
# Open a test browser with SourceMonkey loaded as an unpacked extension.
# Used for the cross-manager Playwright suite: tests connect via CDP at
# port 9222 (see tests/fixtures/manager.ts).
#
# The browser uses a persistent profile so the per-extension
# `user_scripts_allowed` toggle (Chrome >=138) survives across runs.
#
# Usage:
#   scripts/open-test-browser-with-SourceMonkey.sh          # about:blank
#   scripts/open-test-browser-with-SourceMonkey.sh <url>    # custom URL
#
# Prerequisites:
#   npm install
#   npx playwright install chromium
#   npm run build      # produces dist/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_DIR/.chrome-sourcemonkey-profile"
EXTENSION_DIR="$PROJECT_DIR/dist"
URL="${1:-about:blank}"

if [[ ! -d "$EXTENSION_DIR" || ! -f "$EXTENSION_DIR/manifest.json" ]]; then
  echo "Extension not built. Run: npm run build" >&2
  exit 1
fi

CHROME=$(find ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Error: Playwright's bundled Chromium not found." >&2
  echo "Install it with: npx playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium with SourceMonkey at $URL"
echo "Binary:    $CHROME"
echo "Profile:   $PROFILE_DIR"
echo "Extension: $EXTENSION_DIR"
echo "CDP port:  9222"
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=9222 \
  --disable-extensions-except="$EXTENSION_DIR" \
  --load-extension="$EXTENSION_DIR" \
  "$URL"
