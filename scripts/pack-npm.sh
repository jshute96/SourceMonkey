#!/bin/bash

# Pack the npm packages, `sourcemonkey` and the `sm-dev` wrapper, into
# DEST (default /tmp) as sourcemonkey-X.Y.Z.tgz and sm-dev-X.Y.Z.tgz.
# scripts/release.sh uses it; run it alone to see what would ship.
#
# `pnpm pack` makes each one, running the hook in .pnpmfile.cjs on its
# package.json. Then this puts packages/sourcemonkey/README.md into the
# `sourcemonkey` package as its README.md, in place of the repo's, which is
# written for GitHub: npm shows the README inside the package, and pnpm
# can't pack another.

set -euo pipefail

# Absolute, since the wrapper is packed from its own directory.
mkdir -p "${1:-/tmp}"
DEST=$(cd "${1:-/tmp}" && pwd)
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
PKG_TGZ="$DEST/sourcemonkey-${VERSION}.tgz"
WRAPPER_TGZ="$DEST/sm-dev-${VERSION}.tgz"

rm -f "$PKG_TGZ" "$WRAPPER_TGZ"
pnpm pack --pack-destination "$DEST" >/dev/null
pnpm --dir packages/sm-dev pack --pack-destination "$DEST" >/dev/null
[[ -f "$PKG_TGZ" ]] || { echo "Expected package at $PKG_TGZ, not found."; exit 1; }
[[ -f "$WRAPPER_TGZ" ]] || { echo "Expected package at $WRAPPER_TGZ, not found."; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$PKG_TGZ" -C "$STAGE"
cp packages/sourcemonkey/README.md "$STAGE/package/README.md"
# Extracting applied this shell's umask to the modes, so set them as npm
# packs them: readable by all, directories and executables searchable.
tar -czf "$PKG_TGZ" -C "$STAGE" --owner=0 --group=0 --numeric-owner \
  --mode='u+rw,go+r,go-w,a+X' package

echo "Packed $PKG_TGZ and $WRAPPER_TGZ"
