#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: installs what sm-dev
# and the tests need, so a new session can run them straight away.
# Each step is skipped when already done, since the hook runs on every
# session start, resume, clear and compact.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Dependencies: only when a file that decides what gets installed changed
# since the last successful install. The hash file lives in node_modules,
# so it goes away with the packages.
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  pnpm install
  sha256sum .claude/hooks/session-start.sh package.json pnpm-lock.yaml \
    pnpm-workspace.yaml packages/*/package.json > "$hashes" || rm -f "$hashes"
fi

# The Chromium build the pinned Playwright wants. The container's
# preinstalled browsers (PLAYWRIGHT_BROWSERS_PATH) can be a different
# build. Installing adds it alongside them; the preinstalled build stays,
# since the global Playwright still links to it. A no-op once installed.
pnpm exec playwright install chromium

# lib/ and dist/ (sm-dev and the unpacked extension): build when missing
# or older than any source file. Nothing is running sm-dev yet, so
# swapping in a new lib/ here is safe.
stamp=lib/harness/cli.js
if [ ! -f "$stamp" ] || [ -n "$(find src scripts/build.mjs package.json tsconfig*.json -newer "$stamp" -print -quit)" ]; then
  pnpm run build
fi
