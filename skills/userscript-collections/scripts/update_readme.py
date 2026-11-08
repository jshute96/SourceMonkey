#!/usr/bin/env python3
"""Rewrite the script and library tables in README.md from script_manifest.json.

Each table in README.md sits under a placeholder comment. A script
table's placeholder is:

  <!-- update_readme.py [category=<name>,...] [manifest=<path or URL>] -->

* `category=` names the manifest categories the table shows, merged and
  sorted into one table. Without it, the table shows all the manifest's
  scripts. A manifest entry's `category` field gives its category, and
  entries with none are in `default`. Categories named must exist in
  the manifest.
* `manifest=` names the manifest to read: a file path, relative to the
  --root directory (where README.md is), or a URL. Default: `script_manifest.json`
  in the --root directory.

A manifest can also list libraries: shared helper `.js` files that
scripts `@require`, in its `libraries` list. A table of them has its
own placeholder, with the same `manifest=` option:

  <!-- update_readme.py libraries [manifest=<path or URL>] -->

Everything from the line after a placeholder up to the next blank line
is the generated table, and is replaced wholesale. A script table looks
like this:

  <!-- update_readme.py category=tools -->
  | Site | Script | Doc | GF | Description |
  | :---: | --- | --- | --- | --- |
  | <img src="site-icons/example.com.png" ...> | [Example: Fix the thing](sites/example.com/fix.user.js) | [doc](sites/example.com/fix.md) | [GF](https://greasyfork.org/scripts/...) | What it does. |

Script rows are sorted by the name the table shows (`@name`: site, then
title, ignoring case); library rows stay in manifest order.

For a script, the row's name and description are its `@name` and
`@description` headers. A script with no `@name` shows its filename, and
one with no `@description` a blank description. The Doc column links the
sibling `.md`, when there is one; a table where no entry has one leaves
the column out, and the same for the Site column (icons).

The script, icon and doc paths in a manifest are read relative to it,
and each listed script is read for its `@name` and `@description`.
Categories a README doesn't name are left out. A category can be in
more than one table. Each run also lists what's left out, by manifest:
its categories, and `[libraries]` for its libraries.

* From a GitHub file page (`https://github.com/<owner>/<repo>/blob/<ref>/<path>`),
  the manifest and its files are read from raw.githubusercontent.com,
  and scripts and docs link to their GitHub pages, as they do for a
  manifest in this repo. Icons link the raw files.
* From another URL, a row links the script at its URL. Its doc link
  points at GitHub's page for the doc, for a manifest on a GitHub Pages
  project site (published from its default branch's root) or on
  raw.githubusercontent.com, and at the doc's own URL otherwise.
* From a file, the links are paths relative to README.md, which only
  work on GitHub when the file is inside this repo.

A script entry's `site_icons` (written by update_site_icons.py) are shown
as small images before its name, in the README and on the `#` title line
of its doc, which is rewritten as the icons followed by `@name`.

For a library (an entry in the manifest's `libraries` list) there is
no metadata block to read, so the row's name is the filename and its
description is the file's first line (see `parse_library_metadata`).
Doc title lines are only rewritten for this collection's own scripts.

Usage:
  update_readme.py                  # rewrite README.md in place
  update_readme.py --check          # exit 1 if README.md or a doc title is out of date
  update_readme.py --root DIR       # another collection repo with the same layout

The collection is the git checkout holding the working directory, unless
--root names another. The `GF` column (links to Greasy Fork) appears
only when some entry has a `greasyfork` field.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urljoin


def find_repo_root():
  """The git checkout holding the working directory, or the directory itself.

  Not this file's location: the script may live in a skill directory, or
  be run through a symlink, while the collection it updates is whatever
  repo the person is working in.
  """
  try:
    top = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                         capture_output=True, text=True, check=True).stdout.strip()
    return Path(top).resolve()
  except (OSError, subprocess.CalledProcessError):
    return Path.cwd().resolve()


REPO_ROOT = find_repo_root()
MANIFEST = REPO_ROOT / 'script_manifest.json'
README = REPO_ROOT / 'README.md'

PLACEHOLDER_RE = re.compile(r'<!--\s*update_readme\.py\s+(.*?)\s*-->')
CATEGORY_RE = re.compile(r'[\w-]+')


def parse_placeholder(text):
  """Return the placeholder's settings from the text after `update_readme.py`.

  {'manifest': a UrlManifest or FileManifest, plus either
  'libraries': True for a libraries table, or 'categories': [...] (None
  for all) for a script table}.
  """
  tokens = text.split()
  libraries = bool(tokens) and tokens[0] == 'libraries'
  if libraries:
    tokens = tokens[1:]
  allowed = ('manifest',) if libraries else ('category', 'manifest')
  fields = {}
  for token in tokens:
    key, eq, value = token.partition('=')
    if not eq or key not in allowed or key in fields or not value:
      sys.exit(f'README.md: bad placeholder "{text}": expected '
               '"[category=<a>,...] [manifest=<path or URL>]", or '
               '"libraries [manifest=<path or URL>]"')
    fields[key] = value
  if libraries:
    return {'libraries': True, 'manifest': manifest_source(fields.get('manifest'))}
  categories = fields['category'].split(',') if 'category' in fields else None
  if categories and not all(CATEGORY_RE.fullmatch(c) for c in categories):
    sys.exit(f'README.md: bad category list in placeholder "{text}"')
  manifest = fields.get('manifest')
  return {'categories': categories, 'manifest': manifest_source(manifest)}

# Table rows are built as lists of cells, ending with Doc, GF and
# Description, so table_line() can drop Doc and GF as columns rather than
# by parsing text. They're found from the end because only script tables
# start with an icons column.
SCRIPT_HEADER = [['{icons}', 'Script', 'Doc', 'GF', 'Description'],
                 [':---:', '---', '---', '---', '---']]
# Set in main(): whether any entry is on Greasy Fork, so the GF column
# is worth showing.
SHOW_GF = True


def icon_column_header(rows):
  """`Site`, padded to hold the most icons in one of these rows.

  GitHub's `img { max-width: 100% }` makes an image in a table count as
  zero width when the column is sized, so only the header text holds
  the icon column open; with too little, the icons wrap or get squashed.
  "Site" alone fits one icon; two need an &nbsp; each side, and each one
  after that 3 more each side.
  """
  most = max((row.count('<img ') for row in rows), default=1)
  pad = '&nbsp;' * (3 * most - 5) if most > 1 else ''
  return f'{pad}Site{pad}'


LIBRARY_HEADER = [['Library', 'Doc', 'GF', 'Description'],
                  ['---', '---', '---', '---']]


def table_line(cells, show_doc=True):
  """A Markdown table line from its cells, dropping `GF` unless shown,
  and `Doc` when `show_doc` is false."""
  doc, gf, description = cells[-3:]
  cells = cells[:-3] + ([doc] if show_doc else []) + ([gf] if SHOW_GF else []) + [description]
  return '| ' + ' | '.join(cells) + ' |'


def table_lines(header, rows, icons=False):
  """The header lines and `rows` (lists of cells) as one table.

  The Doc column is left out when no row links a doc, and with `icons`
  (the first column is the site icons), so is that column when no row
  has any.
  """
  show_doc = any(row[-3] for row in rows)
  if icons and not any(row[0] for row in rows):
    header, rows = [cells[1:] for cells in header], [cells[1:] for cells in rows]
  return [table_line(cells, show_doc) for cells in header + rows]


def parse_manifest(data):
  """Return (scripts, libraries) from a manifest's parsed JSON.

  The manifest is either a bare list of scripts or an object with
  `scripts` and (optionally) `libraries` lists. An entry may be written
  as a bare path string.
  """
  if isinstance(data, list):
    scripts, libraries = data, []
  else:
    scripts, libraries = data.get('scripts', []), data.get('libraries', [])
  normalize = lambda entries: [{'path': e} if isinstance(e, str) else e for e in entries]
  return normalize(scripts), normalize(libraries)


def parse_metadata(text, filename):
  """Return (name, description) from a userscript's metadata block.

  With no `@name` the name is the filename, and with no `@description`
  the description is empty, so a script with a broken or missing header
  (a deliberately bad example, say) still gets a row.
  """
  fields = {}
  for line in text.splitlines():
    if line.strip() == '// ==/UserScript==':
      break
    m = re.match(r'//\s*@(\w+)\s+(.*)', line)
    if m:
      fields.setdefault(m.group(1), m.group(2).strip())
  return fields.get('name', filename), fields.get('description', '')


def parse_library_metadata(text, filename, label):
  """Return (name, description) for a shared `@require` library.

  Libraries are plain `.js` files with no metadata block, so there's no
  `@name` or `@description` to read. The name is the filename (what a
  script's `@require` line names it by), and the description is the
  file's first line, which by convention is a one-sentence `//` comment
  saying what the file is. `label` names the file in an error.
  """
  lines = text.splitlines()
  m = re.match(r'\s*//\s*(\S.*)', lines[0]) if lines else None
  if not m:
    sys.exit(f'{label}: first line should be a "//" comment describing '
             'the library; that is what the README table shows')
  return filename, m.group(1).strip()


def escape_cell(text):
  """Escape what a Markdown table cell would otherwise eat."""
  return text.replace('|', '\\|').replace('<', '&lt;').replace('>', '&gt;')


def doc_path(rel):
  """The path of the doc beside a script (`.user.js`) or library (`.js`),
  whether or not it exists; None for another kind of file."""
  for suffix in ('.user.js', '.js'):
    if rel.endswith(suffix):
      return rel[: -len(suffix)] + '.md'
  return None


def doc_cell(doc):
  """The `Doc` column: a link to the doc, or empty."""
  return f'[doc]({doc})' if doc else ''


def gf_cell(entry):
  """The `GF` column: a link to the published copy, or empty."""
  gf = entry.get('greasyfork')
  return f'[GF]({gf["url"]})' if gf else ''


def icons_html(entry, size, base='.', sep=' ', src=None):
  """The entry's site icons as <img> tags (with a trailing space), or ''.

  `base` is the directory the HTML is in, relative to the repo root.
  `src`, for another collection's entry, maps each icon path to its
  link instead.
  """
  src = src or (lambda icon: os.path.relpath(icon, base))
  tags = [f'<img src="{src(icon)}" width="{size}" height="{size}" alt="">'
          for icon in entry.get('site_icons', [])]
  return sep.join(tags) + ' ' if tags else ''


def doc_title_updates(scripts):
  """Return {doc path: new text} for docs whose title line is stale.

  The title is the doc's first line: `# `, the script's site icons, then
  its `@name`.
  """
  updates = {}
  for entry in scripts:
    rel = entry['path']
    doc_rel = doc_path(rel)
    if not doc_rel or not (REPO_ROOT / doc_rel).exists():
      continue
    doc = REPO_ROOT / doc_rel
    name, _ = parse_metadata((REPO_ROOT / rel).read_text(encoding='utf-8'), Path(rel).name)
    title = f'# {icons_html(entry, 24, os.path.dirname(rel))}{name}'
    text = doc.read_text(encoding='utf-8')
    first, sep, rest = text.partition('\n')
    if not first.startswith('# '):
      sys.exit(f'{doc.relative_to(REPO_ROOT)}: first line should be the "# " title')
    if first != title:
      updates[doc] = title + sep + rest
  return updates


def sort_key(name):
  """Sort by the site part of `Site: title`, then the title, ignoring case.

  Sorting the whole name would put `Strava Upload: ...` before
  `Strava: ...`, since a space sorts before a colon.
  """
  site, _, title = name.partition(':')
  return site.strip().casefold(), title.strip().casefold()


def fetch(url, method='GET'):
  """The response to a request for `url`, or exit naming the URL."""
  request = urllib.request.Request(url, method=method,
                                   headers={'User-Agent': 'update_readme.py'})
  try:
    return urllib.request.urlopen(request, timeout=30)
  except urllib.error.HTTPError:
    raise
  except (OSError, ValueError) as e:
    sys.exit(f'{url}: {e}')


def fetch_text(url):
  """The text at `url`, or exit naming it."""
  try:
    with fetch(url) as response:
      return response.read().decode('utf-8')
  except urllib.error.HTTPError as e:
    sys.exit(f'{url}: HTTP {e.code}')


def url_exists(url):
  """Whether `url` is there: True on a success, False on a 404."""
  try:
    with fetch(url, method='HEAD'):
      return True
  except urllib.error.HTTPError as e:
    if e.code == 404:
      return False
    sys.exit(f'{url}: HTTP {e.code}')


def github_page_url(url):
  """GitHub's page for a file served from GitHub Pages or raw.githubusercontent.com.

  A Pages URL is taken as a project site (`<owner>.github.io/<repo>/`)
  published from the root of the default branch (`HEAD`). Other URLs
  come back unchanged.
  """
  m = re.match(r'https://([\w-]+)\.github\.io/([^/]+)/(.+)', url)
  if m:
    return f'https://github.com/{m[1]}/{m[2]}/blob/HEAD/{m[3]}'
  m = re.match(r'https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/(.+)', url)
  if m:
    return f'https://github.com/{m[1]}/{m[2]}/blob/{m[3]}'
  return url


class UrlManifest:
  """A manifest at a URL.

  A GitHub file page (`github.com/<owner>/<repo>/blob/<ref>/<path>`) is
  read from raw.githubusercontent.com, and its scripts and docs link to
  their GitHub pages, as this collection's own do. Icons come from the
  raw files, since a GitHub page isn't an image.
  """

  def __init__(self, url):
    self.name = url
    m = re.match(r'https://github\.com/([^/]+)/([^/]+)/blob/(.+)', url)
    self.github = bool(m)
    # Where files are read from.
    self.url = f'https://raw.githubusercontent.com/{m[1]}/{m[2]}/{m[3]}' if m else url
    # Where scripts and docs link to.
    self.page_url = url

  def read_manifest(self):
    return fetch_text(self.url)

  def read(self, rel):
    return fetch_text(urljoin(self.url, rel))

  def exists(self, rel):
    return url_exists(urljoin(self.url, rel))

  def link(self, rel):
    """A script's link: its GitHub page, or else its URL, which installs it."""
    return urljoin(self.page_url if self.github else self.url, rel)

  def doc_link(self, rel):
    """A doc's link: GitHub's rendered page for it where there is one."""
    return urljoin(self.page_url, rel) if self.github else github_page_url(urljoin(self.url, rel))

  def icon_src(self, icon):
    return urljoin(self.url, icon)


class FileManifest:
  """A manifest in a local file: this collection's, or another's.

  Links are relative to the README's directory, so they work in a
  checkout, but not on GitHub when the file is outside this repo.
  """

  def __init__(self, path):
    self.path = path
    self.dir = path.parent
    self.name = os.path.relpath(path, REPO_ROOT)

  def read_manifest(self):
    try:
      return self.path.read_text(encoding='utf-8')
    except OSError as e:
      sys.exit(f'{self.name}: {e.strerror}')

  def read(self, rel):
    try:
      return (self.dir / rel).read_text(encoding='utf-8')
    except OSError as e:
      sys.exit(f'{self.name}: {rel}: {e.strerror}')

  def exists(self, rel):
    return (self.dir / rel).exists()

  def link(self, rel):
    return os.path.relpath(self.dir / rel, REPO_ROOT)

  doc_link = link
  icon_src = link


def manifest_source(value):
  """The manifest a placeholder's `manifest=` names, or this collection's.

  A value with a URL scheme is a URL; anything else is a file path,
  relative to the --root directory (where README.md is).
  """
  if value is None:
    return FileManifest(MANIFEST.resolve())
  if re.match(r'[a-zA-Z][\w+.-]*://', value):
    return UrlManifest(value)
  return FileManifest((REPO_ROOT / value).resolve())


_manifest_scripts = {}


def read_manifest_once(manifest):
  """(scripts, libraries) from a manifest, read once."""
  if manifest.name not in _manifest_scripts:
    try:
      data = json.loads(manifest.read_manifest())
    except json.JSONDecodeError as e:
      sys.exit(f'{manifest.name}: not valid JSON: {e}')
    _manifest_scripts[manifest.name] = parse_manifest(data)
  return _manifest_scripts[manifest.name]


def manifest_scripts(manifest):
  """The script entries in a manifest."""
  return read_manifest_once(manifest)[0]


def manifest_libraries(manifest):
  """The library entries in a manifest, or exit when it has none."""
  libraries = read_manifest_once(manifest)[1]
  if not libraries:
    sys.exit(f'{manifest.name}: a "libraries" placeholder names it, but it lists no libraries')
  return libraries


def manifest_entries(manifest, categories):
  """The entries in the given categories of a manifest, or all of them
  when `categories` is None."""
  scripts = manifest_scripts(manifest)
  if categories is None:
    return scripts
  present = {e.get('category', 'default') for e in scripts}
  missing = [c for c in categories if c not in present]
  if missing:
    sys.exit(f'{manifest.name}: no scripts in categories: {", ".join(missing)}')
  return [e for e in scripts if e.get('category', 'default') in categories]


def build_script_rows(manifest, entries):
  """[(sort key, row cells), ...] for a manifest's script entries."""
  named = []
  for entry in entries:
    rel = entry['path']
    name, description = parse_metadata(manifest.read(rel), rel.rsplit('/', 1)[-1])
    doc_rel = doc_path(rel)
    doc = manifest.doc_link(doc_rel) if doc_rel and manifest.exists(doc_rel) else None
    row = [icons_html(entry, 16, sep='&nbsp;', src=manifest.icon_src).strip(),
           f'[{escape_cell(name)}]({manifest.link(rel)})', doc_cell(doc),
           gf_cell(entry), escape_cell(description)]
    named.append((sort_key(name), row))
  return named


def build_library_rows(manifest):
  """Return [row cells, ...] for a manifest's libraries, in manifest order."""
  rows = []
  for entry in manifest_libraries(manifest):
    rel = entry['path']
    name, description = parse_library_metadata(
        manifest.read(rel), rel.rsplit('/', 1)[-1], f'{manifest.name}: {rel}')
    doc_rel = doc_path(rel)
    doc = manifest.doc_link(doc_rel) if doc_rel and manifest.exists(doc_rel) else None
    rows.append([f'[{escape_cell(name)}]({manifest.link(rel)})', doc_cell(doc),
                 gf_cell(entry), escape_cell(description)])
  return rows


def left_out(tables):
  """'<manifest>: <category>, ...' for each manifest with categories no
  table shows, including this collection's even when no table uses it.
  Libraries no table shows are listed as `[libraries]`.

  `tables` is the placeholders, as parse_placeholder() returns them.
  """
  manifests = {}
  shown = {}
  for p in [{'manifest': manifest_source(None), 'categories': []}] + tables:
    name = p['manifest'].name
    manifests.setdefault(name, p['manifest'])
    if p.get('libraries'):
      shown.setdefault(name, set()).add('[libraries]')
      continue
    present = {e.get('category', 'default') for e in manifest_scripts(p['manifest'])}
    shown.setdefault(name, set()).update(present if p['categories'] is None else p['categories'])
  out = []
  for name, manifest in manifests.items():
    present = {e.get('category', 'default') for e in manifest_scripts(manifest)}
    if read_manifest_once(manifest)[1]:
      present.add('[libraries]')
    missing = sorted(present - shown[name])
    if missing:
      out.append(f'{name}: {", ".join(missing)}')
  return out


def placeholders(readme_text):
  """Each placeholder in the README, as parse_placeholder() returns it."""
  return [parse_placeholder(m.group(1)) for line in readme_text.splitlines()
          if (m := PLACEHOLDER_RE.search(line))]


def render(readme_text, tables):
  """Return README text with each placeholder's table replaced.

  `tables` is placeholders(readme_text), in the same order.
  """
  tables = iter(tables)
  lines = readme_text.splitlines()
  out = []
  i = 0
  while i < len(lines):
    line = lines[i]
    out.append(line)
    i += 1
    m = PLACEHOLDER_RE.search(line)
    if not m:
      continue
    placeholder = next(tables)
    while i < len(lines) and lines[i].strip():  # drop the old table
      i += 1
    if placeholder.get('libraries'):
      out.extend(table_lines(LIBRARY_HEADER, build_library_rows(placeholder['manifest'])))
      continue
    manifest = placeholder['manifest']
    named = build_script_rows(manifest, manifest_entries(manifest, placeholder['categories']))
    table = [row for _, row in sorted(named, key=lambda pair: pair[0])]
    icons = icon_column_header([row[0] for row in table])
    header = [[cell.format(icons=icons) for cell in SCRIPT_HEADER[0]]] + SCRIPT_HEADER[1:]
    out.extend(table_lines(header, table, icons=True))

  return '\n'.join(out) + '\n'


def main():
  parser = argparse.ArgumentParser(description=__doc__,
                                   formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--check', action='store_true',
                      help="don't write; exit 1 if README.md is out of date")
  parser.add_argument('--root', type=Path,
                      help='collection to update (default: the git checkout holding '
                           'the working directory)')
  args = parser.parse_args()

  global REPO_ROOT, MANIFEST, README, SHOW_GF
  if args.root:
    REPO_ROOT = args.root.resolve()
    MANIFEST = REPO_ROOT / 'script_manifest.json'
    README = REPO_ROOT / 'README.md'

  if not MANIFEST.is_file():
    sys.exit(f'{MANIFEST}: not found; run this inside a collection, or pass --root')
  own = manifest_source(None)
  scripts, libraries = read_manifest_once(own)
  for entry in scripts + libraries:
    if not own.exists(entry['path']):
      sys.exit(f'{own.name}: {entry["path"]}: listed but not found')
  old = README.read_text(encoding='utf-8')
  tables = placeholders(old)
  shown = [entry for p in tables
           for entry in (manifest_libraries(p['manifest']) if p.get('libraries')
                         else manifest_entries(p['manifest'], p['categories']))]
  SHOW_GF = any(entry.get('greasyfork') for entry in shown)
  new = render(old, tables)
  docs = doc_title_updates(scripts)

  not_shown = left_out(tables)
  left_out_line = 'Not in any table: ' + '; '.join(not_shown) if not_shown else None

  if new == old and not docs:
    print('README.md and doc titles are up to date.')
  elif args.check:
    stale = (['README.md'] if new != old else []) + [
        str(d.relative_to(REPO_ROOT)) for d in docs]
    print(f'Out of date: {", ".join(stale)}; run update_readme.py.', file=sys.stderr)
  else:
    if new != old:
      README.write_text(new, encoding='utf-8')
      print('README.md updated.')
    for doc, text in docs.items():
      doc.write_text(text, encoding='utf-8')
      print(f'{doc.relative_to(REPO_ROOT)}: title updated.')
  if left_out_line:
    print(left_out_line)
  if args.check and (new != old or docs):
    sys.exit(1)

if __name__ == '__main__':
  main()
