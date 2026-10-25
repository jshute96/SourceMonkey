#!/bin/bash

# Cut a release: the extension on GitHub, and the `sourcemonkey` and
# `sm-dev` packages on npm, all at one version, tagged vX.Y.Z.
#
# Before running: bump the version in package.json, src/manifest.json and
# packages/sm-dev/package.json to the same value, and commit and push it.
#
# There are two ways to release:
#
# A. In two steps, with a review in between (the usual way):
#
#    scripts/release.sh
#      Builds the release and puts it on GitHub as a draft, which only you
#      can see. Publishes nothing to npm.
#      - Checks the versions match, the tree is clean on main and in sync
#        with origin/main, and neither the tag nor the npm version is taken.
#      - Runs the unit tests, builds the zips, and packs the npm packages
#        into .tgz files.
#      - Pushes the tag and creates the draft GitHub release, with the zip
#        and both .tgz files attached.
#
#    Then review the draft (the command above prints its URL), check it, and
#    click "Publish release".
#
#    scripts/release.sh --publish-npm vX.Y.Z
#      Publishes the release's packages to npm. Builds nothing: it
#      downloads the .tgz files attached to the published GitHub release
#      and publishes those, so npm gets exactly what you reviewed. Skips a
#      package npm already has, so it can be rerun after a failure.
#
#    The npm step is separate because npm has no drafts: a version is
#    public as soon as it's published, and can never be published again.
#
# B. In one step, with no review:
#
#    scripts/release.sh --build-and-publish
#      Does everything the first command does, but creates the GitHub
#      release published instead of as a draft, then publishes the same
#      .tgz files to npm, as --publish-npm would.
#
# Files it writes:
#   /tmp/SourceMonkey-vX.Y.Z.zip        The extension, attached to the GitHub
#                                       release.
#   /tmp/SourceMonkey-vX.Y.Z-store.zip  The extension without the manifest's
#                                       key, to upload to the Chrome Web
#                                       Store by hand.
#   /tmp/sourcemonkey-X.Y.Z.tgz,        The npm packages, attached to the
#   /tmp/sm-dev-X.Y.Z.tgz               GitHub release.

# -E: the ERR traps below also fire for a failure inside a function
# (publish_npm).
set -Eeuo pipefail

usage() {
  cat <<EOF
Usage:
  scripts/release.sh         Build the release and create a draft
                             GitHub release with its files.

  scripts/release.sh --publish-npm vX.Y.Z
                             After publishing that draft on GitHub:
                             publish its attached .tgz files to npm.

  scripts/release.sh --build-and-publish
                             Build the release, publish it on GitHub, and
                             publish it to npm, with no draft stage.

  scripts/release.sh --help  Show this help.

Before running, update the version in package.json, src/manifest.json and
packages/sm-dev/package.json to the same value, and commit and push it.
See the comment at the top of this script for each step.
EOF
}

DRAFT_FLAG="--draft"
NPM_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-and-publish)   DRAFT_FLAG=""; shift ;;
    --publish-npm)
      if [[ -z "${2:-}" || "$2" == -* ]]; then
        echo "--publish-npm requires a version (vX.Y.Z)" >&2
        usage >&2
        exit 2
      fi
      NPM_TAG="v${2#v}"
      shift 2
      ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ -n "$NPM_TAG" && -z "$DRAFT_FLAG" ]]; then
  echo "--publish-npm and --build-and-publish don't go together." >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# The npm packages, in publish order: the sm-dev wrapper depends on
# sourcemonkey at this exact version.
PACKAGES=(sourcemonkey sm-dev)

# Publish each package's .tgz from DIR to npm, skipping one npm already has
# at VERSION, so a rerun after a failure finishes the job. Publishing the
# tarballs (not `pnpm publish`) sends exactly the files on the GitHub
# release, and runs no build or lifecycle scripts.
publish_npm() {
  local version="$1" dir="$2" name tgz
  for name in "${PACKAGES[@]}"; do
    tgz="$dir/$name-$version.tgz"
    # `return`, not `exit`: the caller's ERR trap prints how to recover.
    [[ -f "$tgz" ]] || { echo "Expected package at $tgz, not found."; return 1; }
    if [[ "$(npm view "$name@$version" version 2>/dev/null || true)" == "$version" ]]; then
      echo "npm already has $name@$version; skipping it."
      continue
    fi
    npm publish "$tgz"
  done
}

# 0. gh preflight.
command -v gh >/dev/null 2>&1 || { echo "gh CLI not found. Install from https://cli.github.com/."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated. Run 'gh auth login' first."; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "Not logged in to npm. Run 'npm login' first."; exit 1; }

# --publish-npm: publish a published GitHub release's packages to npm.
if [[ -n "$NPM_TAG" ]]; then
  IS_DRAFT=$(gh release view "$NPM_TAG" --json isDraft --jq .isDraft) \
    || { echo "No GitHub release $NPM_TAG found."; exit 1; }
  if [[ "$IS_DRAFT" == "true" ]]; then
    echo "$NPM_TAG is still a draft. Publish it on GitHub first."
    exit 1
  fi
  DOWNLOAD_DIR=$(mktemp -d)
  # shellcheck disable=SC2064  # expand $DOWNLOAD_DIR now, not at trap time
  trap "rm -rf '$DOWNLOAD_DIR'" EXIT
  gh release download "$NPM_TAG" --pattern '*.tgz' --dir "$DOWNLOAD_DIR"
  publish_npm "${NPM_TAG#v}" "$DOWNLOAD_DIR"
  echo
  echo "Published $NPM_TAG to npm."
  exit 0
fi

# 1. Verify versions match.
PKG_VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./src/manifest.json').version")
WRAPPER_VERSION=$(node -p "require('./packages/sm-dev/package.json').version")

if [[ "$PKG_VERSION" != "$MANIFEST_VERSION" || "$PKG_VERSION" != "$WRAPPER_VERSION" ]]; then
  echo "Version mismatch:"
  echo "  package.json:                 $PKG_VERSION"
  echo "  src/manifest.json:            $MANIFEST_VERSION"
  echo "  packages/sm-dev/package.json: $WRAPPER_VERSION"
  echo "Bump all three to the same value before releasing."
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

# 3. Tag unused, and the version not on npm yet.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
  exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin."
  exit 1
fi
for name in "${PACKAGES[@]}"; do
  if [[ "$(npm view "$name@$VERSION" version 2>/dev/null || true)" == "$VERSION" ]]; then
    echo "npm already has $name@$VERSION. Bump the version before releasing."
    exit 1
  fi
done

# The publish runs no lifecycle scripts, so run the unit tests here.
pnpm run test:unit

# 4. Build + zip.
bash scripts/zip_extension.sh --release "$VERSION"
ZIP="/tmp/SourceMonkey-v${VERSION}.zip"
STORE_ZIP="/tmp/SourceMonkey-v${VERSION}-store.zip"
[[ -f "$ZIP" ]] || { echo "Expected zip at $ZIP, not found."; exit 1; }
[[ -f "$STORE_ZIP" ]] || { echo "Expected zip at $STORE_ZIP, not found."; exit 1; }

# The packages, packed once: these files go on the GitHub release and,
# unchanged, to npm. `pnpm pack` writes the wrapper's `workspace:*`
# dependency as this exact version.
bash scripts/pack-npm.sh /tmp
PKG_TGZ="/tmp/sourcemonkey-${VERSION}.tgz"
WRAPPER_TGZ="/tmp/sm-dev-${VERSION}.tgz"

# No install-time scripts may ship: they would run in every repo that
# installs the package. .pnpmfile.cjs drops this repo's `scripts`.
for tgz in "$PKG_TGZ" "$WRAPPER_TGZ"; do
  # Read apart from the test, so a tar failure stops the script rather
  # than reading as "no install scripts".
  MANIFEST=$(tar -xOzf "$tgz" package/package.json)
  if node -e 'const s = JSON.parse(process.argv[1]).scripts ?? {};
              process.exit(["preinstall", "install", "postinstall"].some((k) => k in s) ? 0 : 1)' "$MANIFEST"; then
    echo "$tgz has an install-time script, which would run wherever it's installed."
    exit 1
  fi
done

# Check the packages with npm before anything is pushed.
for tgz in "$PKG_TGZ" "$WRAPPER_TGZ"; do
  npm publish --dry-run "$tgz" >/dev/null 2>&1 \
    || { echo "npm refuses $tgz:"; npm publish --dry-run "$tgz"; exit 1; }
done

# 5. Tag + push. The ERR trap prints the cleanup command if a later step
#    fails once the tag is already on the remote; cleared on success so an
#    unrelated failure can't print the wrong guidance.
git tag -a "$TAG" -m "Release $TAG"
# Drop the local tag if the push fails, so a rerun isn't stopped by it.
git push origin "$TAG" || { git tag -d "$TAG" >/dev/null; exit 1; }
# shellcheck disable=SC2064  # expand $TAG now, not at trap time
# It prints to stderr: the notes step below sends stdout to a file.
trap "{ echo; echo 'Release failed after the tag was pushed. To clean up and retry:'; echo '  git push --delete origin $TAG && git tag -d $TAG'; echo '  and, if the GitHub release was made: gh release delete $TAG'; } >&2" ERR

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
**Install the extension:** download \`$(basename "$ZIP")\` below and unzip it. In
Chrome, open \`chrome://extensions\`, enable **Developer mode**, click **Load
unpacked**, and select the unzipped directory.

**sm-dev:** run \`npx sm-dev@$VERSION\`, or install it in a repo of userscripts
with \`pnpm add -D sourcemonkey@$VERSION\`. The \`.tgz\` files below are the
same npm packages.

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

gh release create "$TAG" "$ZIP" "$PKG_TGZ" "$WRAPPER_TGZ" \
  --title "$TAG" \
  --notes-file "$NOTES_FILE" \
  $DRAFT_FLAG

# 7. npm, with --build-and-publish.
NPM_CMD="scripts/release.sh --publish-npm $TAG"
if [[ -z "$DRAFT_FLAG" ]]; then
  # The GitHub release is out by now, so keep the tag: --publish-npm
  # publishes its files, skipping a package npm already has.
  # shellcheck disable=SC2064  # expand $NPM_CMD now, not at trap time
  trap "{ echo; echo 'The npm publish failed. The GitHub release is out; once fixed, publish to npm with:'; echo '  $NPM_CMD'; } >&2" ERR
  publish_npm "$VERSION" /tmp
fi

trap - ERR

echo
if [[ -n "$DRAFT_FLAG" ]]; then
  echo "Drafted $TAG. Review and publish at the URL above, then publish to npm with:"
  echo "  $NPM_CMD"
else
  echo "Released $TAG"
fi
echo "Upload $STORE_ZIP to the Chrome Web Store developer dashboard and submit it for review."
