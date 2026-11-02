#!/usr/bin/env python3
"""
Convert a userscript into a thin "pointer" script that loads the body
dynamically from a file:// URL.

The resulting script can be installed in Tampermonkey; on every page load
Tampermonkey will fetch the script body live from local disk.

Usage:
  convert-to-file-pointer.py <script-path>
"""
import argparse
import re
import sys
from pathlib import Path

HEADER_START = "// ==UserScript=="
HEADER_END = "// ==/UserScript=="


def convert(path: Path) -> str:
  text = path.read_text(encoding="utf-8")
  lines = text.splitlines()

  try:
    start = next(i for i, ln in enumerate(lines) if ln.strip() == HEADER_START)
    end = next(i for i, ln in enumerate(lines) if ln.strip() == HEADER_END)
  except StopIteration:
    raise SystemExit(f"error: {path}: did not find a complete UserScript header block")

  header = lines[start : end + 1]

  # Strip auto-update directives: the pointer script is local-only and
  # should not try to fetch updates from the original URL. Pre-existing
  # @require lines are kept verbatim: the pointer's added file:// @require
  # for the body sits alongside them and Tampermonkey loads each in order.
  header = [ln for ln in header if not re.match(r"^//\s*@(updateURL|downloadURL)\b", ln)]

  name_idx = next(
    (i for i, ln in enumerate(header) if re.match(r"^//\s*@name\s+\S", ln)),
    None,
  )
  if name_idx is None:
    raise SystemExit(f"error: {path}: did not find @name in header")

  header[name_idx] = re.sub(
    r"^(//\s*@name\s+)(.*\S)\s*$",
    r"\1\2 (from local file)",
    header[name_idx],
  )

  abs_path = path.resolve()
  require_line = f"// @require      file://{abs_path}"
  header.insert(-1, require_line)

  return "\n".join(header) + "\n"


def main() -> int:
  ap = argparse.ArgumentParser(
    description=__doc__,
    formatter_class=argparse.RawDescriptionHelpFormatter,
  )
  ap.add_argument("script_path", type=Path, nargs="?", help="path to the source userscript")
  args = ap.parse_args()

  if args.script_path is None:
    ap.print_help(sys.stderr)
    return 0

  if not args.script_path.is_file():
    print(f"error: not a file: {args.script_path}", file=sys.stderr)
    return 2

  sys.stdout.write(convert(args.script_path))
  return 0


if __name__ == "__main__":
  sys.exit(main())
