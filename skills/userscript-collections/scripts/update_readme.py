#!/usr/bin/env python3
"""Rewrite the script and library tables in README.md from script_manifest.json.

Each table in README.md sits under a placeholder comment. Script tables
name the category they hold:

  <!-- update_readme.py category=default -->
  | Site | Script | Doc | GF | Description |
  | :---: | --- | --- | --- | --- |
  | ... |

and the one table of shared `@require` libraries is marked:

  <!-- update_readme.py libraries -->

Everything from the line after the placeholder up to the next blank line
is the generated table, and is replaced wholesale. Rows come from
`script_manifest.json`. Script rows are sorted by the name the table
shows (`@name`: site, then title, ignoring case); library rows stay in manifest order.

For a script, the row's name and description are its `@name` and
`@description` headers. A script with no `@name` shows its filename, and
one with no `@description` a blank description. The Doc column links the
sibling `.md`, when there is one; a table where no entry has one leaves
the column out, and the same for the Site column (icons). A manifest
entry's `category` field selects the table; entries with no `category` go in `default`. The set of categories
used in the manifest must match the set of placeholders in README.md
exactly.

A script entry's `site_icons` (written by update_site_icons.py) are shown
as small images before its name, in the README and on the `#` title line
of its doc, which is rewritten as the icons followed by `@name`.

For a library (an entry in the manifest's `libraries` list) there is
no metadata block to read, so the row's name is the filename and its
description is the file's first line (see `read_library_metadata`).

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
from pathlib import Path


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

PLACEHOLDER_RE = re.compile(
    r'<!--\s*update_readme\.py\s+(?:category=([\w-]+)|(libraries))\s*-->')

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


def load_manifest():
  """Return (scripts, libraries) as lists of entry objects.

  The manifest is either a bare list of scripts or an object with
  `scripts` and (optionally) `libraries` lists. An entry may be written
  as a bare path string.
  """
  data = json.loads(MANIFEST.read_text(encoding='utf-8'))
  if isinstance(data, list):
    scripts, libraries = data, []
  else:
    scripts, libraries = data.get('scripts', []), data.get('libraries', [])
  normalize = lambda entries: [{'path': e} if isinstance(e, str) else e for e in entries]
  return normalize(scripts), normalize(libraries)


def read_metadata(script_path):
  """Return (name, description) from a userscript's metadata block.

  With no `@name` the name is the filename, and with no `@description`
  the description is empty, so a script with a broken or missing header
  (a deliberately bad example, say) still gets a row.
  """
  fields = {}
  for line in script_path.read_text(encoding='utf-8').splitlines():
    if line.strip() == '// ==/UserScript==':
      break
    m = re.match(r'//\s*@(\w+)\s+(.*)', line)
    if m:
      fields.setdefault(m.group(1), m.group(2).strip())
  return fields.get('name', script_path.name), fields.get('description', '')


def read_library_metadata(library_path):
  """Return (name, description) for a shared `@require` library.

  Libraries are plain `.js` files with no metadata block, so there's no
  `@name` or `@description` to read. The name is the filename — that's
  what a script's `@require` line names it by — and the description is
  the file's first line, which by convention is a one-sentence `//`
  comment saying what the file is.
  """
  lines = library_path.read_text(encoding='utf-8').splitlines()
  m = re.match(r'\s*//\s*(\S.*)', lines[0]) if lines else None
  if not m:
    sys.exit(f'{library_path}: first line should be a "//" comment describing '
             'the library; that is what the README table shows')
  return library_path.name, m.group(1).strip()


def escape_cell(text):
  """Escape what a Markdown table cell would otherwise eat."""
  return text.replace('|', '\\|').replace('<', '&lt;').replace('>', '&gt;')


def sibling_doc(rel, suffix):
  """The doc file beside a script or library, or None if there isn't one."""
  doc = rel[: -len(suffix)] + '.md'
  return doc if (REPO_ROOT / doc).exists() else None


def doc_cell(doc):
  """The `Doc` column: a link to the doc, or empty."""
  return f'[doc]({doc})' if doc else ''


def gf_cell(entry):
  """The `GF` column: a link to the published copy, or empty."""
  gf = entry.get('greasyfork')
  return f'[GF]({gf["url"]})' if gf else ''


def icons_html(entry, size, base='.', sep=' '):
  """The entry's site icons as <img> tags (with a trailing space), or ''.

  `base` is the directory the HTML is in, relative to the repo root.
  """
  tags = [f'<img src="{os.path.relpath(icon, base)}" width="{size}" height="{size}" alt="">'
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
    doc_rel = sibling_doc(rel, '.user.js')
    if not doc_rel:
      continue
    doc = REPO_ROOT / doc_rel
    name, _ = read_metadata(REPO_ROOT / rel)
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


def build_rows(scripts):
  """Return {category: [row cells, ...]}, sorted by script name.

  The manifest is in path order, but the table shows `@name`, which
  can sort differently.
  """
  rows = {}
  for entry in scripts:
    rel = entry['path']
    script = REPO_ROOT / rel
    if not script.exists():
      sys.exit(f'{rel}: listed in the manifest but not found')
    doc = sibling_doc(rel, '.user.js')
    name, description = read_metadata(script)
    # Joined by &nbsp;, so the icons don't wrap onto separate lines.
    row = [icons_html(entry, 16, sep="&nbsp;").strip(),
           f'[{escape_cell(name)}]({rel})', doc_cell(doc),
           gf_cell(entry), escape_cell(description)]
    rows.setdefault(entry.get('category', 'default'), []).append((sort_key(name), row))
  return {category: [row for _, row in sorted(named)]
          for category, named in rows.items()}


def build_library_rows(libraries):
  """Return [row cells, ...] for the libraries table, in manifest order."""
  rows = []
  for entry in libraries:
    rel = entry['path']
    library = REPO_ROOT / rel
    if not library.exists():
      sys.exit(f'{rel}: listed in the manifest but not found')
    doc = sibling_doc(rel, '.js')
    name, description = read_library_metadata(library)
    rows.append([f'[{escape_cell(name)}]({rel})', doc_cell(doc),
                 gf_cell(entry), escape_cell(description)])
  return rows


def render(readme_text, rows, library_rows):
  """Return README text with each placeholder's table replaced."""
  lines = readme_text.splitlines()
  out = []
  seen = []
  libraries_seen = 0
  i = 0
  while i < len(lines):
    line = lines[i]
    out.append(line)
    i += 1
    m = PLACEHOLDER_RE.search(line)
    if not m:
      continue
    category = m.group(1)
    if category:
      seen.append(category)
    else:
      libraries_seen += 1
    while i < len(lines) and lines[i].strip():  # drop the old table
      i += 1
    if category:
      table = rows.get(category, [])
      icons = icon_column_header([row[0] for row in table])
      header = [[cell.format(icons=icons) for cell in SCRIPT_HEADER[0]]] + SCRIPT_HEADER[1:]
      out.extend(table_lines(header, table, icons=True))
    else:
      out.extend(table_lines(LIBRARY_HEADER, library_rows))

  manifest_categories = set(rows)
  readme_categories = set(seen)
  if len(seen) != len(readme_categories):
    dupes = sorted({c for c in seen if seen.count(c) > 1})
    sys.exit(f'README.md: duplicate category placeholders: {", ".join(dupes)}')
  if manifest_categories != readme_categories:
    only_manifest = sorted(manifest_categories - readme_categories)
    only_readme = sorted(readme_categories - manifest_categories)
    problems = []
    if only_manifest:
      problems.append('in the manifest but with no README placeholder: '
                      + ', '.join(only_manifest))
    if only_readme:
      problems.append('with a README placeholder but no scripts: '
                      + ', '.join(only_readme))
    sys.exit('Category mismatch: ' + '; '.join(problems))
  if libraries_seen > 1:
    sys.exit('README.md: more than one "libraries" placeholder')
  if bool(library_rows) != bool(libraries_seen):
    sys.exit('README.md: the manifest lists libraries but README.md has no '
             '"libraries" placeholder' if library_rows else
             'README.md: has a "libraries" placeholder but the manifest lists '
             'no libraries')

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
  scripts, libraries = load_manifest()
  SHOW_GF = any(entry.get('greasyfork') for entry in scripts + libraries)
  old = README.read_text(encoding='utf-8')
  new = render(old, build_rows(scripts), build_library_rows(libraries))
  docs = doc_title_updates(scripts)

  if new == old and not docs:
    print('README.md and doc titles are up to date.')
    return
  if args.check:
    stale = (['README.md'] if new != old else []) + [
        str(d.relative_to(REPO_ROOT)) for d in docs]
    sys.exit(f'Out of date: {", ".join(stale)}; run update_readme.py.')
  if new != old:
    README.write_text(new, encoding='utf-8')
    print('README.md updated.')
  for doc, text in docs.items():
    doc.write_text(text, encoding='utf-8')
    print(f'{doc.relative_to(REPO_ROOT)}: title updated.')


if __name__ == '__main__':
  main()
