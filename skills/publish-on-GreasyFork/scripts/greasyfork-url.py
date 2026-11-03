#!/usr/bin/env python3
"""
Build (and optionally launch) a Greasy Fork form URL with a prefilled hash.

Companion to the prefill-forms-from-hash.user.js userscript, which reads
the hash and fills the form; it has to be installed in the browser the URL
opens in. The publish-on-GreasyFork skill says where to get it, and its
.md has the full parameter list.

Relative paths for import are read against the repo root: the git checkout
holding the working directory.

Each subcommand's own options are listed further down; the options above
are shared and can go on either side of the subcommand.

Examples:
  # Post a new version, filled but not submitted, with two screenshots.
  greasyfork-url.py update 590960 \\
      --code-file sites/strava.com/fix-climb-slider.user.js \\
      --info-file sites/strava.com/fix-climb-slider.md \\
      --image-files sites/strava.com/screenshots/fix-climb-slider-before.png \\
      --image-files sites/strava.com/screenshots/fix-climb-slider-after.png \\
      --changelog-text 'Line the icons up with the slider.'

  # Post a new version, as above, but extracting the description and
  # screenshots from a script's .md doc file.
  # See extract-description.py for details.
  greasyfork-url.py update 590960 \\
      --extract-from-doc sites/strava.com/fix-climb-slider.md \\
      --changelog-text 'Update description.'

  # Post a new version of a library. The name, the description and
  # Additional info all come from the file and its sibling .md.
  greasyfork-url.py update 592124 --library lib/keyboard-comment-nav.js \\
      --changelog-text 'Land `j` on the first comment.'

  # Import from a web URL, so the script keeps syncing from that URL.
  # Local paths are converted to a GitHub URL; a full URL works too.
  greasyfork-url.py import sites/strava.com/fix-climb-slider.user.js \\
      --sync-type automatic

The page is only ever filled in, never submitted. Read it over and click
Greasy Fork's own button.

@require checking and rewriting:
  Greasy Fork rejects a raw.githubusercontent.com @require, so --code-file
  rewrites each one naming a library to that library's recorded
  latest_version_url before inlining the code. The mapping comes from the
  repo's script_manifest.json, if it has one (a library's `github_url` and
  its `greasyfork.latest_version_url`); a GitHub @require with no library
  entry (or no manifest) is an error rather than a silent pass-through. --no-rewrite-requires posts
  the file verbatim, unchecked.

  --code-upload and import hand Greasy Fork the file as it stands, with no
  chance to rewrite anything on the way, so a local path there is only
  checked: a @require naming a GitHub URL or a bare relative path stops the
  command. (A file the import names by URL isn't fetched, so isn't checked.)

Local files:
  --code-file and --info-file are read here and inlined into the URL, so
  they always work. --image-files and --code-upload can only be passed as a
  location for the browser to fetch, and file:// reads fail in userscript
  managers that run the request from a service worker. If that bites, serve
  the repo over HTTP and pass --http-base:

    python3 -m http.server 8765 --directory .
    greasyfork-url.py update 590960 --http-base http://localhost:8765 ...

  Local paths under --http-root (default: the repo root) are then rewritten
  to URLs under --http-base.
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from urllib.parse import quote

# The sibling scripts load with importlib; keep them from leaving
# __pycache__ directories in the skill.
sys.dont_write_bytecode = True

DEFAULT_BASE = "https://greasyfork.org"
DEFAULT_LOCALE = "en"

# Extension -> format, so passing a .md doc selects the Markdown radio
# without having to say so twice.
FORMAT_BY_SUFFIX = {".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html"}


def load_sibling(filename: str):
  """Import a script from this directory (their names aren't importable)."""
  path = Path(__file__).resolve().parent / filename
  spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
  if not spec or not spec.loader:
    raise SystemExit(f"error: cannot load {path}")
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def source_url(source: str, branch: str) -> str:
  """Return the URL Greasy Fork should import a script from.

  A local path becomes the raw.githubusercontent.com URL that serves it,
  and a URL passes through. It's greasyfork-scripts.py's own raw_url, so
  the two tools can't build different URLs for the same file.
  """
  return load_sibling("greasyfork-scripts.py").raw_url(source, branch)


def from_doc(doc_path: str) -> tuple[str, list[str]]:
  """Return the publishable description and screenshot list for a doc.

  The same thing `extract-description.py --no-images` / `--images` print:
  the doc's Summary section with the images (and their labels) taken out,
  and the image paths in the order they appear. It's that script's own
  function, so the two can't drift — including its warning about a
  multi-image doc with no `image-gallery-heading` comment.
  """
  return load_sibling("extract-description.py").description_and_images(Path(doc_path))


def code_for_greasyfork(path_str: str, rewrite: bool) -> str:
  """The script's source as it should be posted to Greasy Fork.

  Scripts may @require shared helpers from raw.githubusercontent.com,
  which Greasy Fork won't accept — so the
  posted copy names each library's recorded `latest_version_url`
  instead, and then the result is checked for any @require that still
  wouldn't work for someone installing from Greasy Fork. Both come from
  greasyfork-scripts.py, reading the same manifest, so the two tools
  can't disagree about which version a script requires.
  """
  source = read_text(path_str)
  if not rewrite:
    # Explicitly "post exactly this file" — so don't rewrite it, and
    # don't second-guess it either.
    return source
  module = load_sibling("greasyfork-scripts.py")
  source, changed = module.rewrite_requires(source, module.load_manifest())
  for old_url, new_url in changed:
    print(f"@require rewritten for Greasy Fork:\n  {old_url}\n  -> {new_url}", file=sys.stderr)
  module.check_publishable(source, path_str)
  return source


def library_fields(path_str: str) -> tuple[str, str, str | None]:
  """A library's Greasy Fork name, description, and doc path.

  A library has no metadata block, so the form's Name and Description
  fields have nothing to read them from. The conventions used here: the
  name is the file's basename without `.js` (which is also the slug in its
  Greasy Fork URL), and the description is the file's first `//` comment
  line, a one-line summary. The
  sibling `.md` supplies Additional info, if it exists.
  """
  path = Path(path_str)
  name = path.stem
  description = ""
  for line in read_text(path_str).splitlines():
    stripped = line.strip()
    if not stripped:
      continue
    if stripped.startswith("//"):
      description = stripped.lstrip("/").strip()
    break
  if not description:
    raise SystemExit(
      f"error: {path_str} doesn't open with a `// one-line summary` comment, "
      "so there's no description to post; pass --description")
  doc = path.with_suffix(".md")
  return name, description, str(doc) if doc.is_file() else None


def check_requires_of(path_str: str, what: str, repo_relative: bool = False) -> None:
  """Check a file we're handing to Greasy Fork whole, without rewriting.

  Uploads and imports post the file as it stands — Greasy Fork fetches
  or reads it itself, so there's no opportunity to fix a library
  @require on the way. A repo path is read and checked; a URL is left
  alone, since checking it would mean fetching it.

  `repo_relative` says how to read the path: import names files the way
  the manifest does, relative to the repo root whatever the working
  directory is, while --code-upload takes an ordinary path from the
  shell. Reading an import's path the second way would break the
  command anywhere but the repo root, where it used to work.
  """
  if "://" in path_str:
    return
  module = load_sibling("greasyfork-scripts.py")
  path = str(module.repo_path(path_str)) if repo_relative else path_str
  module.check_publishable(read_text(path), what)


def read_text(path_str: str) -> str:
  # Read rather than stat, so a pipe works too — process substitution
  # (`--info-file <(some-command)`) hands us a /dev/fd entry, which isn't
  # a regular file.
  try:
    return Path(path_str).read_text(encoding="utf-8")
  except OSError as error:
    raise SystemExit(f"error: cannot read {path_str}: {error}")


def format_for(path_str: str, override: str | None) -> str:
  if override:
    return override
  suffix = Path(path_str).suffix.lower()
  if suffix not in FORMAT_BY_SUFFIX:
    raise SystemExit(
      f"error: can't tell the format of {path_str} from its extension; pass it explicitly"
    )
  return FORMAT_BY_SUFFIX[suffix]


def as_location(path_str: str, args) -> str:
  """Turn a local path into something the *browser* can fetch."""
  if "://" in path_str:
    return path_str
  path = Path(path_str).resolve()
  if not path.is_file():
    raise SystemExit(f"error: no such file: {path}")
  if args.http_base:
    root = Path(args.http_root).resolve()
    try:
      relative = path.relative_to(root)
    except ValueError:
      raise SystemExit(f"error: {path} is not under --http-root {root}, so it can't be served")
    return f"{args.http_base.rstrip('/')}/{quote(str(relative))}"
  return f"file://{path}"


def build_hash(params: list[tuple[str, str]]) -> str:
  # quote() with an empty safe list matches the userscript's
  # decodeURIComponent parsing — notably it escapes "+", which would
  # otherwise be ambiguous.
  return "&".join(f"{key}={quote(value, safe='')}" for key, value in params)


def apply_library_defaults(args) -> None:
  """Turn `--library path/foo.js` into the fields the library form wants.

  The form has a Name and a Description of its own, in place of the
  @name/@description a library file hasn't got, and the script type has
  to be set to Library or the code is posted as an installable
  userscript. All three are derivable from the file, so this fills them
  in and leaves the rest of `script_params` to treat it as an ordinary
  --code-file. Anything given explicitly wins, so a one-off name or
  description doesn't mean giving up the flag.
  """
  if not args.library:
    return
  name, description, doc = library_fields(args.library)
  args.code_file = args.library
  derived = []
  if not args.script_type:
    args.script_type = "library"
    derived.append("script type 'library'")
  if not args.name:
    args.name = name
    derived.append(f"name {name!r}")
  if not args.description:
    args.description = description
    derived.append(f"description {description!r}")
  # The sibling .md is the library's Additional info, the same way a
  # script's doc is. Only defaulted: any explicit info flag means the
  # caller has said what to post, and --extract-from-doc rejects being
  # combined with those anyway.
  if doc and not (args.extract_from_doc or args.info_file or args.info_text
                  or args.image_files):
    args.extract_from_doc = doc
    derived.append(f"Additional info from {doc}")
  if derived:
    print(f"library {args.library}: using " + ", ".join(derived), file=sys.stderr)


def script_params(args) -> list[tuple[str, str]]:
  params: list[tuple[str, str]] = []

  if args.library and (args.code_file or args.code_url or args.code_upload):
    raise SystemExit("error: --library is the code to post; don't also pass "
                     "--code-file, --code-url or --code-upload")
  apply_library_defaults(args)
  code_sources = [bool(args.code_file), bool(args.code_url), bool(args.code_upload)]
  if sum(code_sources) > 1:
    raise SystemExit("error: pass only one of --code-file, --code-url, --code-upload")
  if args.code_file:
    params.append(("code", code_for_greasyfork(args.code_file, args.rewrite_requires)))
  elif args.code_url:
    params.append(("code_url", args.code_url))
  elif args.code_upload:
    check_requires_of(args.code_upload, args.code_upload)
    params.append(("code_upload", as_location(args.code_upload, args)))

  doc_images: list[str] = []
  if args.extract_from_doc:
    # The doc supplies Additional info, its format, and the images, so
    # anything else that sets one of those is a contradiction rather than
    # an override — say so instead of silently picking a winner.
    conflicting = [flag for flag, value in (("--info-file", args.info_file),
                                            ("--info-text", args.info_text),
                                            ("--info-format", args.info_format),
                                            ("--image-files", args.image_files))
                   if value]
    if conflicting:
      raise SystemExit("error: --extract-from-doc already sets what "
                       f"{', '.join(conflicting)} would set")
    body, doc_images = from_doc(args.extract_from_doc)
    params.append(("additional_info_markdown", body))
  if args.info_file and args.info_text:
    raise SystemExit("error: pass only one of --info-file, --info-text")
  if args.info_format and not (args.info_file or args.info_text):
    raise SystemExit("error: --info-format needs --info-file or --info-text")
  if args.info_file:
    info = read_text(args.info_file)
    params.append((f"additional_info_{format_for(args.info_file, args.info_format)}", info))
  elif args.info_text:
    params.append((f"additional_info_{args.info_format or 'html'}", args.info_text))

  # Each --image-files may itself be a comma-separated list; flatten in
  # the order given, which is the order they'll appear on the script.
  paths = [path for group in (args.image_files or []) for path in group.split(",") if path.strip()]
  paths = paths or doc_images
  if paths:
    params.append(("image_files", ",".join(as_location(p.strip(), args) for p in paths)))

  if args.script_type:
    params.append(("script_type", args.script_type))
  if args.name:
    params.append(("name", args.name))
  if args.description:
    params.append(("description", args.description))
  if args.adult:
    params.append(("adult", "1"))
  if args.source_editor is not None:
    params.append(("source_editor", "1" if args.source_editor else "0"))
  return params


def update_params(args) -> list[tuple[str, str]]:
  params = script_params(args)
  # Greasy Fork keeps the description on the version form, so posting code
  # without one leaves the old text in place — invisibly, since the field
  # arrives looking the way it always does. Say so; it's a warning rather
  # than an error because a code-only fix-up is a legitimate thing to want.
  if args.code_file and not (args.extract_from_doc or args.info_file or args.info_text):
    print("warning: posting code without updating description; the currently posted one "
          "stays. Pass --extract-from-doc <the script's .md> to update it.",
          file=sys.stderr)
  if args.changelog_text and args.changelog_file:
    raise SystemExit("error: pass only one of --changelog-text, --changelog-file")
  if args.changelog_format and not (args.changelog_text or args.changelog_file):
    raise SystemExit("error: --changelog-format needs --changelog-text or --changelog-file")
  if args.changelog_text:
    params.append((f"changelog_{args.changelog_format or 'html'}", args.changelog_text))
  elif args.changelog_file:
    # Read first, so a missing file reports that rather than complaining
    # about the extension.
    changelog = read_text(args.changelog_file)
    params.append((f"changelog_{format_for(args.changelog_file, args.changelog_format)}", changelog))
  # The doc is the whole story when --extract-from-doc is used: its text
  # replaces Additional info outright, so its screenshots replace the
  # gallery too. Greasy Fork *adds* uploads to what's already attached,
  # so without this a re-run doubles every image. A doc with no
  # screenshots therefore clears them — pass --no-remove-images to add
  # to the existing gallery instead.
  remove_images = args.remove_images
  if remove_images is None:
    remove_images = bool(args.extract_from_doc)
  if remove_images:
    params.append(("remove_images", "all"))
  return params


def script_id_of(value: str) -> str:
  """Accept a bare id, a slug, or any URL containing /scripts/<id>."""
  if "://" not in value:
    return value
  # Take the segment after "scripts", not the first digit-leading one: a
  # host like "127.0.0.1:8765" would otherwise be read as the script id.
  parts = value.split("/")
  if "scripts" in parts:
    index = parts.index("scripts") + 1
    if index < len(parts) and parts[index]:
      return parts[index]
  raise SystemExit(f"error: could not find a script id in {value}")


USAGE_LABEL = re.compile(r"^(?:\x1b\[[0-9;]*m)*usage: (?:\x1b\[0m)?")


class TopLevelParser(argparse.ArgumentParser):
  """Top-level parser that shows one usage line per subcommand.

  argparse's default usage is "{new,update,import} ...", which says
  nothing about what each command takes. This substitutes each
  subcommand's own usage instead, so the synopsis printed on an error
  (or by --help) shows the three commands and their flags. The shared
  options are hidden from the subparsers' help, so they're listed once
  on a trailing line.
  """

  def __init__(self, *args, **kwargs):
    super().__init__(*args, **kwargs)
    self.subcommand_parsers: list[argparse.ArgumentParser] = []

  def format_usage(self) -> str:
    if not self.subcommand_parsers:
      return super().format_usage()
    lines = []
    for index, sub in enumerate(self.subcommand_parsers):
      prefix = "usage: " if index == 0 else "       "
      # Python 3.14+ colors help on a terminal, wrapping "usage: " in ANSI
      # codes, so strip the label with any codes around it.
      lines.append(prefix + USAGE_LABEL.sub("", sub.format_usage(), count=1).rstrip())
    # The shared options carry help=SUPPRESS on the subparsers, so they
    # appear in none of the lines above.
    shared = " ".join(
      f"[{action.option_strings[0]}]" if action.nargs == 0
      else f"[{action.option_strings[0]} {action.dest.upper()}]"
      for action in self._actions
      if action.option_strings and action.dest != "help"
    )
    width = max(40, shutil.get_terminal_size().columns - 2)
    lines.append("\nshared options (either side of the subcommand):\n" + textwrap.fill(
      shared, width=width, initial_indent="  ", subsequent_indent="  ",
      # Without this, textwrap splits "[--keep-hash]" across two lines.
      break_on_hyphens=False,
    ))
    # Trailing blank line so the error argparse prints next doesn't butt up
    # against the shared-options list.
    return "\n".join(lines) + "\n\n"


def main() -> int:
  parser = TopLevelParser(
    description=__doc__,
    formatter_class=argparse.RawDescriptionHelpFormatter,
  )
  # The options below are accepted both before and after the subcommand,
  # which argparse only allows if they're declared on every parser. They
  # default to SUPPRESS so that a value given before the subcommand isn't
  # overwritten by the subparser's default; real defaults are applied after
  # parsing. On the subparsers they're also hidden from --help, so each
  # subcommand's help lists only what's specific to it and the shared
  # options are documented once, at the top.
  def add_hidden_help(sub):
    # The subparsers are built with add_help=False so that "[-h]" doesn't
    # repeat on every usage line; -h still works, just undocumented there.
    sub.add_argument("-h", "--help", action="help", help=argparse.SUPPRESS)

  def add_common_options(sub, documented: bool = True):
    def visible(text: str) -> str:
      return text if documented else argparse.SUPPRESS

    sub.add_argument("--base", default=argparse.SUPPRESS, help=visible(f"site root (default {DEFAULT_BASE})"))
    sub.add_argument("--locale", default=argparse.SUPPRESS, help=visible(f"URL locale segment (default {DEFAULT_LOCALE})"))
    sub.add_argument("--keep-hash", action="store_true", default=argparse.SUPPRESS, help=visible("leave the parameters in the address bar"))
    sub.add_argument("--print", dest="print_only", action="store_true", default=argparse.SUPPRESS, help=visible("print the URL, don't launch a browser"))
    sub.add_argument("--browser", default=argparse.SUPPRESS, help=visible("browser command (default google-chrome)"))
    sub.add_argument("--http-base", default=argparse.SUPPRESS, help=visible("serve local files from this URL prefix instead of file://"))
    sub.add_argument("--http-root", default=argparse.SUPPRESS, help=visible("directory --http-base serves (default: repo root)"))

  COMMON_DEFAULTS = {
    "base": DEFAULT_BASE,
    "locale": DEFAULT_LOCALE,
    "keep_hash": False,
    "print_only": False,
    "browser": "google-chrome",
    "http_base": None,
    "http_root": None,
  }

  add_common_options(parser)
  # parser_class: subparsers default to their parent's class, which would
  # make each of them recurse into printing its own subcommands.
  subparsers = parser.add_subparsers(
    dest="command", metavar="{new,update,import}", required=True,
    parser_class=argparse.ArgumentParser)
  # Repeated at the foot of each subcommand's help, since the shared
  # options are hidden there.
  shared_note = "Also accepts the shared options listed by `greasyfork-url.py --help`."

  def add_script_options(sub):
    sub.add_argument("--extract-from-doc", metavar="FILE",
                     help="extract description and image-files from the script's .md doc")
    sub.add_argument("--library", metavar="FILE",
                     help="post FILE, a shared helper, as a library: its code, plus "
                          "the name, description and Additional info derived from it")
    sub.add_argument("--code-file", metavar="FILE", help="read the code from FILE and inline it")
    sub.add_argument("--rewrite-requires", action=argparse.BooleanOptionalAction, default=True,
                     help="point --code-file's library @requires at Greasy Fork (default: on)")
    sub.add_argument("--code-url", metavar="URL", help="have the browser load the code from URL")
    sub.add_argument("--code-upload", metavar="FILE", help="attach FILE to the 'Or upload' input")
    sub.add_argument("--info-file", metavar="FILE", help="read Additional info from FILE (format from its extension)")
    sub.add_argument("--info-text", metavar="TEXT", help="Additional info as literal text")
    sub.add_argument("--info-format", choices=["html", "markdown"], help="override the Additional info format")
    sub.add_argument("--image-files", metavar="FILE[,FILE...]", action="append",
                     help="images to attach, in order (comma-separated, and repeatable)")
    sub.add_argument("--script-type", choices=["public", "unlisted", "library"], help="script type")
    sub.add_argument("--name", help="library name")
    sub.add_argument("--description", help="library description")
    sub.add_argument("--adult", action="store_true", help="tick the adult-content self-report")
    sub.add_argument("--source-editor", action=argparse.BooleanOptionalAction, default=None,
                     help="turn Greasy Fork's syntax-highlighting code editor on or off")

  new_parser = subparsers.add_parser(
    "new", add_help=False, help="post a new script", description="Fill the 'Post a new script' form.", epilog=shared_note)
  add_hidden_help(new_parser)
  add_common_options(new_parser, documented=False)
  add_script_options(new_parser)
  new_parser.add_argument("--script-locale", metavar="LANG", help="script language, e.g. 'es' or 'Spanish'")

  update_parser = subparsers.add_parser(
    "update", add_help=False, help="post a new version of an existing script",
    description="Fill the 'Post a new version' form for an existing script.", epilog=shared_note)
  update_parser.add_argument("script_id",
                             help="the Greasy Fork script id (an integer), or a slug or "
                                  "URL containing one")
  add_hidden_help(update_parser)
  add_common_options(update_parser, documented=False)
  add_script_options(update_parser)
  update_parser.add_argument("--changelog-text", metavar="TEXT", help="changelog as literal text")
  update_parser.add_argument("--changelog-file", metavar="FILE", help="read the changelog from FILE")
  update_parser.add_argument("--changelog-format", choices=["html", "markdown"], help="changelog format")
  update_parser.add_argument("--remove-images", action=argparse.BooleanOptionalAction, default=None,
                             help="tick remove on existing images, so new images will replace them")

  import_parser = subparsers.add_parser(
    "import", add_help=False, help="import scripts from source URLs",
    description="Fill the 'Import scripts' form.", epilog=shared_note)
  add_hidden_help(import_parser)
  add_common_options(import_parser, documented=False)
  import_parser.add_argument("urls", nargs="+", metavar="SOURCE",
                             help="scripts to import: repo-relative paths, or source URLs")
  import_parser.add_argument("--branch", default="main",
                             help="branch a path's raw URL points into (default main)")
  import_parser.add_argument("--language", choices=["detect", "js", "css"], help="script language")
  import_parser.add_argument("--sync-type", choices=["automatic", "manual"], help="initial sync type")

  parser.subcommand_parsers = [new_parser, update_parser, import_parser]

  args = parser.parse_args()
  for key, value in COMMON_DEFAULTS.items():
    if not hasattr(args, key):
      setattr(args, key, value)
  if args.http_root is None:
    args.http_root = str(load_sibling("greasyfork-scripts.py").REPO_ROOT)
  prefix = f"{args.base.rstrip('/')}/{args.locale}" if args.locale else args.base.rstrip("/")

  if args.command == "new":
    path = f"{prefix}/script_versions/new"
    params = script_params(args)
    if args.script_locale:
      params.append(("script_locale", args.script_locale))
  elif args.command == "update":
    path = f"{prefix}/scripts/{script_id_of(args.script_id)}/versions/new"
    params = update_params(args)
  else:
    path = f"{prefix}/import"
    # Greasy Fork fetches these from GitHub and keeps syncing from them,
    # so whatever @require lines are in the file are what its users get.
    for source in args.urls:
      check_requires_of(source, source, repo_relative=True)
    params = [("urls", "\n".join(source_url(s, args.branch) for s in args.urls))]
    if args.language:
      params.append(("language", args.language))
    if args.sync_type:
      params.append(("sync_type", args.sync_type))

  if args.keep_hash:
    params.append(("keep_hash", "1"))
  if not params:
    raise SystemExit("error: nothing to prefill")

  url = f"{path}#{build_hash(params)}"

  if args.print_only:
    print(url)
    return 0
  print(url, file=sys.stderr)
  open_in_browser(url, args.browser)
  return 0


# Chrome silently ignores a URL passed on the command line beyond roughly this
# length -- no error, no tab, and a zero exit status. A standalone copy inlines
# the whole script into the hash and lands well past it (25k+ for a script that
# @requires a library), while an import or a description update stays around
# 1-2k. Measured empirically; keep well under where it starts failing.
BROWSER_URL_ARG_LIMIT = 8000

# How long a launcher page is left on disk before a later run may clear it
# out. Only has to outlast the browser's read of it, which is immediate;
# the margin is for a browser that has to start up first.
LAUNCHER_KEEP_SECONDS = 600


def open_in_browser(url, browser):
  """Open `url`, routing over-long URLs through a local launcher page.

  Chrome accepts any length once it is *running*, so for a long URL we write a
  tiny file:// page that redirects itself, and pass that short path instead.
  """
  target = url
  if len(url) > BROWSER_URL_ARG_LIMIT:
    target = write_launcher(url)
    print(
      f"note: URL is {len(url)} chars, too long to pass to {browser} directly; "
      f"opening via {target}",
      file=sys.stderr,
    )
  try:
    subprocess.Popen(
      [browser, target],
      stdout=subprocess.DEVNULL,
      stderr=subprocess.DEVNULL,
      start_new_session=True,
    )
  except FileNotFoundError:
    raise SystemExit(f"error: browser command not found: {browser}")


def write_launcher(url):
  """Write a self-redirecting page for `url` and return a file:// URL for it.

  Each of these holds a whole inlined script, so they are not small. The
  browser reads the file asynchronously, so this one can't be deleted on the
  way out — instead every run clears out the ones left by earlier runs, but
  only those old enough that no browser can still be opening them. Deleting
  every launcher outright breaks the case this is most used for: multiple
  forms opened back to back, where the next run would pull the file out from
  under the tab the last one just launched.
  """
  stale_before = time.time() - LAUNCHER_KEEP_SECONDS
  for old_file in Path(tempfile.gettempdir()).glob("greasyfork-launch-*.html"):
    try:
      if old_file.stat().st_mtime < stale_before:
        old_file.unlink()
    except OSError:
      pass
  html = (
    "<!doctype html><meta charset=utf-8><title>Opening Greasy Fork\u2026</title>\n"
    "<body style=\"font:15px system-ui;padding:2rem\">\n"
    "<p>Sending you to the Greasy Fork form\u2026</p>\n"
    "<p><a id=a href=\"#\">Click here if it does not go automatically.</a></p>\n"
    "<script>\nvar u = " + json.dumps(url) + ";\n"
    "document.getElementById('a').href = u;\nlocation.replace(u);\n</script>\n"
  )
  handle, path = tempfile.mkstemp(prefix="greasyfork-launch-", suffix=".html")
  with os.fdopen(handle, "w", encoding="utf-8") as f:
    f.write(html)
  # as_uri() rather than "file://" + path: a temp dir with a space or a
  # non-ASCII character in it otherwise yields a malformed argument, which
  # the browser drops as silently as the over-long URL this is working around.
  return Path(path).as_uri()


if __name__ == "__main__":
  sys.exit(main())
