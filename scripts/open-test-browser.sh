#!/usr/bin/env bash
#
# Open a browser with one of the external userscript managers
# (Tampermonkey or Violentmonkey) in a persistent profile, for trying
# the examples by hand and for scripts/sync-manager-scripts.mjs, which
# connects to it over CDP. The test suites don't use it: they start a
# new browser each run (see tests/fixtures/manager-launch.ts).
#
# The profile directory, CDP port, and Web Store listing all come from
# tests/fixtures/managers.mjs, so this script and the Playwright
# fixture can't drift apart.
#
# First-run setup (manual, once per checkout — the profile lives in the
# working tree):
#   1. Run this script.
#   2. In the launched Chromium, install the manager from the Chrome
#      Web Store (the URL is printed below).
#   3. Open chrome://extensions, enable "Developer mode", and on the
#      manager's card flip "Allow access to file URLs" — a couple of
#      examples load their pages over file://.
#
# The persistent profile keeps the manager installed across runs.
#
# Usage:
#   scripts/open-test-browser.sh <manager>          # about:blank
#   scripts/open-test-browser.sh <manager> <url>    # custom URL
#
# where <manager> is `tampermonkey` or `violentmonkey`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MANAGER="${1:-}"
if [[ -z "$MANAGER" ]]; then
  echo "Usage: scripts/open-test-browser.sh <tampermonkey|violentmonkey> [url]" >&2
  exit 2
fi
URL="${2:-about:blank}"

# MANAGER_LABEL / MANAGER_PROFILE_DIR / MANAGER_CDP_PORT / MANAGER_CWS_URL.
# Assign first, then eval: `eval "$(...)"` would report the *eval's*
# status, so an unknown manager (node exits 2 with its own message)
# would sail past `set -e` and fail two lines later on an unbound
# variable instead. An assignment propagates the substitution's status.
MANAGER_VARS="$(node "$PROJECT_DIR/tests/fixtures/managers.mjs" --shell "$MANAGER")"
eval "$MANAGER_VARS"

CHROME=$(find ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Error: Playwright's bundled Chromium not found." >&2
  echo "Install it with: pnpm exec playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium with the $MANAGER_LABEL profile at $URL"
echo "Binary:    $CHROME"
echo "Profile:   $MANAGER_PROFILE_DIR"
echo "CDP port:  $MANAGER_CDP_PORT"
echo ""
echo "If this is the first run, install $MANAGER_LABEL from the Chrome"
echo "Web Store: $MANAGER_CWS_URL"
echo "The profile persists across runs."
echo ""

exec "$CHROME" \
  --user-data-dir="$MANAGER_PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port="$MANAGER_CDP_PORT" \
  "$URL"
