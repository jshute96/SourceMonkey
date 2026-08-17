#!/usr/bin/env bash
#
# Open a test browser configured for cross-manager testing against
# Tampermonkey. Tests connect via CDP at port 9223 (see
# tests/fixtures/manager.ts).
#
# First-run setup (manual, once per machine):
#   1. Run this script.
#   2. In the launched Chromium, install Tampermonkey from the Chrome
#      Web Store:
#      https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo
#   3. Open chrome://extensions, enable "Developer mode", and on the
#      Tampermonkey card flip "Allow access to file URLs" if you want
#      the file:// example variants to work too.
#   4. Close the browser. The persistent profile keeps TM installed
#      across runs.
#
# Usage:
#   scripts/open-test-browser-with-Tampermonkey.sh          # about:blank
#   scripts/open-test-browser-with-Tampermonkey.sh <url>    # custom URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_DIR/.chrome-tampermonkey-profile"
URL="${1:-about:blank}"

CHROME=$(find ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Error: Playwright's bundled Chromium not found." >&2
  echo "Install it with: pnpm exec playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium with Tampermonkey profile at $URL"
echo "Binary:    $CHROME"
echo "Profile:   $PROFILE_DIR"
echo "CDP port:  9223"
echo ""
echo "If this is the first run, install Tampermonkey from the Chrome"
echo "Web Store. The profile persists across runs."
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=9223 \
  "$URL"
