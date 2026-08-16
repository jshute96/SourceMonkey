#!/bin/bash

# Cut a GitHub release for the Chrome extension.
#
# Tag scheme: vX.Y.Z.
# Version source: package.json and src/manifest.json (must match).
# Artifact: /tmp/SourceMonkey-vX.Y.Z.zip (built from dist/).
#
# Steps:
#   0. Verify gh (the GitHub CLI) is installed + authenticated.
#   1. Verify versions in package.json and src/manifest.json match.
#   2. Verify the working tree is clean and we're on main, in sync with origin/main.
#   3. Verify the tag doesn't already exist locally or on the remote.
#   4. Build + zip via scripts/zip_extension.sh --release VERSION.
#   5. Create + push an annotated tag.
#   6. gh release create with the zip attached and auto-generated notes.
#      Always creates a draft by default — review and publish from the
#      GitHub UI. Pass --publish to skip the draft step.
#
# Usage:
#   scripts/release-extension.sh             # creates a draft release (default)
#   scripts/release-extension.sh --publish   # publishes immediately, no draft
#
# Bump versions before running by editing both package.json and src/manifest.json.

set -euo pipefail

usage() {
  cat <<EOF
Usage: scripts/release-extension.sh [--publish] [--help]

Cuts a GitHub release for the Chrome extension. By default creates a
draft so you can review and publish from the GitHub UI.

Options:
  --publish   Publish immediately instead of creating a draft.
  --help      Show this help and exit.

Bump the version in package.json and src/manifest.json (must match) and
commit before running.
EOF
}

DRAFT_FLAG="--draft"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish)   DRAFT_FLAG=""; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

# 0. gh preflight.
command -v gh >/dev/null 2>&1 || { echo "gh CLI not found. Install from https://cli.github.com/."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated. Run 'gh auth login' first."; exit 1; }

# 1. Verify versions match.
PKG_VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./src/manifest.json').version")

if [[ "$PKG_VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "Version mismatch:"
  echo "  package.json:      $PKG_VERSION"
  echo "  src/manifest.json: $MANIFEST_VERSION"
  echo "Bump both to the same value before releasing."
  exit 1
fi

VERSION="$PKG_VERSION"
TAG="v$VERSION"
echo "Releasing $TAG"

# 2. Clean tree on main, in sync with origin/main.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Not on main (on $BRANCH). Switch to main before releasing."
  exit 1
fi

git fetch origin main --quiet
LOCAL_SHA=$(git rev-parse main)
REMOTE_SHA=$(git rev-parse origin/main)
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "Local main ($LOCAL_SHA) does not match origin/main ($REMOTE_SHA)."
  echo "Pull or push so they match before releasing."
  exit 1
fi

# 3. Tag unused.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
  exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin."
  exit 1
fi

# 4. Build + zip.
bash scripts/zip_extension.sh --release "$VERSION"
ZIP="/tmp/SourceMonkey-v${VERSION}.zip"
[[ -f "$ZIP" ]] || { echo "Expected zip at $ZIP, not found."; exit 1; }

# 5. Tag + push. The ERR trap prints the cleanup command if a later step
#    fails once the tag is already on the remote; cleared on success so an
#    unrelated failure can't print the wrong guidance.
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"
# shellcheck disable=SC2064  # expand $TAG now, not at trap time
trap "echo; echo 'Release failed after the tag was pushed. To clean up and retry:'; echo '  git push --delete origin $TAG && git tag -d $TAG'" ERR

# 6. Create the GitHub release: install instructions prefixed onto the
#    auto-generated notes.
NOTES_FILE=$(mktemp)
# shellcheck disable=SC2064  # expand $NOTES_FILE now, not at trap time
trap "rm -f '$NOTES_FILE'" EXIT

# Baseline the notes on the previous release tag, if there is one. The new
# tag is first in the descending list (we just created it locally), so the
# second entry is the prior release. Empty on the first release — then we
# let GitHub pick the baseline.
PREV_TAG=$(git tag --list 'v*' --sort=-v:refname | sed -n 2p)

{
  cat <<EOF
**Install:** download \`$(basename "$ZIP")\` below and unzip it. In Chrome, open
\`chrome://extensions\`, enable **Developer mode**, click **Load unpacked**, and
select the unzipped directory.

---

EOF
  if [[ -n "$PREV_TAG" ]]; then
    gh api repos/{owner}/{repo}/releases/generate-notes \
      -f tag_name="$TAG" \
      -f previous_tag_name="$PREV_TAG" \
      --jq .body
  else
    gh api repos/{owner}/{repo}/releases/generate-notes \
      -f tag_name="$TAG" \
      --jq .body
  fi
} > "$NOTES_FILE"

gh release create "$TAG" "$ZIP" \
  --title "$TAG" \
  --notes-file "$NOTES_FILE" \
  $DRAFT_FLAG

trap - ERR

echo
if [[ -n "$DRAFT_FLAG" ]]; then
  echo "Drafted $TAG. Review and publish at the URL above."
else
  echo "Released $TAG"
fi
