#!/bin/sh
# Generate a SourceMonkey HTTP-manifest JSON from the *.user.js files
# under the current working directory and write it to stdout.
#
# SourceMonkey only recognises manifests under the fixed filename
# `script_manifest.json`, so the intended workflow is:
#   $ cd /path/to/userscripts && sh scripts/make_manifest.sh > script_manifest.json
# then serve the directory over HTTP and point SourceMonkey at
# https://.../script_manifest.json. Relative entries resolve against the
# manifest URL's parent (so "foo.user.js" becomes
# "<manifest-dir>/foo.user.js"); see docs/http-sources.md.
#
# Exits 1 (with a message to stderr) when no userscripts were found.

set -eu

# `find . -name '*.user.js'` returns paths like `./sub/foo.user.js`;
# strip the leading `./` so the manifest entries are bare relative
# paths. LC_ALL=C sort gives byte-deterministic ordering across
# environments.
files=$(find . -type f -name '*.user.js' -print | sed 's|^\./||' | LC_ALL=C sort)

if [ -z "$files" ]; then
  printf 'No *.user.js files found under %s\n' "$PWD" >&2
  exit 1
fi

# Bare JSON array of relative paths — the simpler of the two shapes
# parseManifest accepts. Filenames are escaped for JSON: backslash and
# double-quote only. Control characters in filenames are vanishingly
# rare; if any slip through, the consumer will reject the manifest and
# the user can rename the offending file.
printf '[\n'
first=true
printf '%s\n' "$files" | {
  while IFS= read -r f; do
    escaped=$(printf '%s' "$f" | sed -e 's|\\|\\\\|g' -e 's|"|\\"|g')
    if $first; then
      printf '  "%s"' "$escaped"
      first=false
    else
      printf ',\n  "%s"' "$escaped"
    fi
  done
}
printf '\n]\n'
