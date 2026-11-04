#!/usr/bin/env python3
"""Save each script's icons into site-icons/ and list them in the manifest.

A script's icons are what SourceMonkey's collections page shows beside
it: its own `@icon` if it has one, otherwise the favicon of each site
it runs on, in page order. update_readme.py shows them before each
script's name in the README and on its doc's title line.

This starts an sm-dev run (a temp browser) with every script in the
manifest, or just the ones named, and for each one runs `sm-dev
script N save --include icon,site-icons`. Then:

- A site icon is saved as `site-icons/<host and path>.<ext>`, the name
  sm-dev gives it. Scripts on the same site share the file.
- A remote `@icon` is saved as `site-icons/icon-<host, path and query>.<ext>`,
  named for its URL, so scripts with the same `@icon` share the file.
  A relative `@icon` is already a file beside the script, and is
  listed where it is.
- A PNG bigger than 32x32 is scaled down to fit; the README shows them
  at 16px.
- Each manifest entry gets a `site_icons` list of repo-relative paths,
  or none when there's nothing to show (sm-dev's globe).
- Scripts not named keep the icons they have, and so do scripts
  `sm-dev validate` finds invalid, which a run can't load.
- Files in site-icons/ that no script uses any more are deleted.
- An entry with `"site_icons_pinned": true` is left as it is, files and
  all. Use it for an icon fixed by hand, such as one a site only shows
  when logged in (the temp browser never is).

Site icons come from the live sites, so a run can differ when a site
changes its favicon, or can't be reached.

Usage:
  update_site_icons.py                    # the collection you're in
  update_site_icons.py sites/x/y.user.js  # just these scripts (e.g. a new one), from here or the root
  update_site_icons.py --root DIR         # another collection repo with the same layout
  update_site_icons.py --run D1           # use a running sm-dev run that has the scripts loaded

sm-dev is SourceMonkey's development tool. It runs as `pnpm sm-dev` in
the git checkout holding the working directory, which needs the
`sourcemonkey` dev dependency installed; --root can then name another
collection that has none of its own. Needs Pillow (`python3-pil`), to
scale the icons.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

from PIL import Image

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


# Where `pnpm sm-dev` runs: the checkout the command is run from.
REPO_ROOT = find_repo_root()
ICON_DIR = 'site-icons'
MAX_SIZE = 32


def sm_dev(*args, check=True):
  """Run `pnpm sm-dev` in REPO_ROOT; return the CompletedProcess.

  It runs here even for another collection (given absolute paths), so
  that collection needs no sm-dev or browser of its own.
  """
  result = subprocess.run(['pnpm', 'sm-dev', *args], cwd=REPO_ROOT,
                          capture_output=True, text=True)
  if check and result.returncode != 0:
    sys.exit(f'sm-dev {" ".join(args)} failed:\n{result.stdout}{result.stderr}')
  return result


def json_lines(text):
  """The JSON objects in sm-dev's --json=single output, one per line."""
  return [json.loads(line) for line in text.splitlines() if line.startswith('{')]


def relative_to(root, file):
  """A script path from sm-dev, relative to `root` when it's in it.

  sm-dev gives paths under the directory it runs in (REPO_ROOT) relative
  to it, which differs from `root` with --root.
  """
  path = (REPO_ROOT / file).resolve()
  return path.relative_to(root).as_posix() if path.is_relative_to(root) else file


def script_path(root, given):
  """A script path given on the command line, relative to `root`.

  A relative path can be from the current directory or from `root`.
  """
  path = given.resolve() if given.is_absolute() or given.exists() else (root / given).resolve()
  if not path.is_relative_to(root):
    sys.exit(f'{given}: not in {root}')
  return path.relative_to(root).as_posix()


def shrink(path):
  """Scale a PNG bigger than MAX_SIZE down to fit, in place."""
  if path.suffix.lower() != '.png':
    return
  with Image.open(path) as img:
    if max(img.size) <= MAX_SIZE:
      return
    img.thumbnail((MAX_SIZE, MAX_SIZE), Image.LANCZOS)
    img.save(path, optimize=True)


def icon_file_stem(url):
  """`icon-<host, path and query>` for a remote `@icon` URL, as a filename.

  The query is kept: favicon services (`.../favicons?domain=x.com`) differ
  only there.
  """
  parts = urllib.parse.urlsplit(url)
  path = parts.path.rsplit('.', 1)[0] if '.' in parts.path.rsplit('/', 1)[-1] else parts.path
  query = '_' + parts.query if parts.query else ''
  return 'icon-' + re.sub(r'[^A-Za-z0-9.-]+', '_', parts.netloc + path + query).strip('_')


def save_icons(root, run, script_id, rel, icon_dir):
  """Save one script's icons; return their repo-relative paths, in order."""
  with tempfile.TemporaryDirectory() as tmp:
    result = sm_dev('--run', run, '--json=single', 'script', script_id, 'save',
                    tmp, '--include', 'icon,site-icons', '--flat', check=False)
    saved = [r for r in json_lines(result.stdout) if r.get('command') == 'script save']
    if not saved:
      if 'files to save' in result.stdout + result.stderr:
        return []
      sys.exit(f'{rel}: sm-dev script save failed:\n{result.stdout}{result.stderr}')
    report = saved[0]

    own = [f for f in report['files'] if f['kind'] == 'icon']
    if own:
      url = own[0]['url']
      local = root.as_uri() + '/'
      if url.startswith(local):
        return [url[len(local):]]
      dest = icon_dir / (icon_file_stem(url) + Path(own[0]['path']).suffix)
    else:
      dest = None

    paths = []
    for f in own[:1] if own else [s for s in report['siteIcons'] if 'path' in s]:
      target = dest or icon_dir / f['path']
      shutil.copyfile(Path(tmp) / f['path'], target)
      shrink(target)
      paths.append(target.relative_to(root).as_posix())
    return paths


def read_entries(manifest, manifest_path):
  """The manifest's script entries, each as an object.

  The manifest is a bare list or a `{"scripts": [...]}` object, and an
  entry may be a bare path string. A string becomes `{"path": ...}`
  here and in `manifest` itself, so a `site_icons` field can go on it;
  `write_entries` turns back the ones that got none.
  """
  raw = manifest if isinstance(manifest, list) else manifest.get('scripts')
  if not isinstance(raw, list):
    sys.exit(f'{manifest_path}: not a script list or a {{"scripts": [...]}} object')
  were_strings = set()
  for i, entry in enumerate(raw):
    if isinstance(entry, str):
      raw[i] = {'path': entry}
      were_strings.add(i)
    elif not (isinstance(entry, dict) and isinstance(entry.get('path'), str)):
      sys.exit(f'{manifest_path}: an entry is neither a path nor an object with a "path": {entry!r}')
  return raw, were_strings


def write_entries(entries, were_strings):
  """Turn entries that were strings, and got no other field, back into strings."""
  for i in were_strings:
    if list(entries[i]) == ['path']:
      entries[i] = entries[i]['path']


def main():
  parser = argparse.ArgumentParser(description=__doc__,
                                   formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--root', type=Path,
                      help='collection to update (default: the git checkout holding '
                           'the working directory)')
  parser.add_argument('scripts', nargs='*', type=Path,
                      help='scripts to update (default: all in the manifest)')
  parser.add_argument('--run', help='an sm-dev run that already has the scripts to update loaded')
  args = parser.parse_args()
  root = (args.root or REPO_ROOT).resolve()
  manifest_path = root / 'script_manifest.json'
  if not manifest_path.is_file():
    sys.exit(f'{manifest_path}: not found; run this inside a collection, or pass --root')
  manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
  entries, were_strings = read_entries(manifest, manifest_path)
  if args.scripts:
    wanted = {script_path(root, p) for p in args.scripts}
    missing = wanted - {e['path'] for e in entries}
    if missing:
      sys.exit(f'Not in the manifest: {", ".join(sorted(missing))}')
    selected = [e for e in entries if e['path'] in wanted]
  else:
    selected = entries

  run = args.run or 'Dicons'
  if not args.run:
    # A run refuses to start with an invalid script, so leave those out.
    results = json_lines(sm_dev('--json=single', 'validate',
                                *[str(root / e['path']) for e in selected], check=False).stdout)
    invalid = {relative_to(root, r['script'])
               for doc in results for r in doc.get('results', [])
               if r.get('verdict') == 'invalid'}
    for rel in sorted(invalid):
      print(f'{rel}: skipped, since it is invalid')
    selected = [e for e in selected if e['path'] not in invalid]
    print(f'Starting sm-dev run {run} with {len(selected)} scripts...')
    sm_dev('--run', run, 'start', *[str(root / e['path']) for e in selected],
           '--notab', '--detach')
  try:
    status = json_lines(sm_dev('--run', run, '--json=single', 'status').stdout)[0]
    ids = {relative_to(root, s['file']): s['id'] for s in status['scripts']}
    icon_dir = root / ICON_DIR
    icon_dir.mkdir(exist_ok=True)
    for entry in selected:
      rel = entry['path']
      if entry.get('site_icons_pinned'):
        print(f'{rel}: {", ".join(entry.get("site_icons", [])) or "(none)"} (pinned)')
        continue
      if rel not in ids:
        sys.exit(f'{rel}: not loaded in run {run}')
      icons = save_icons(root, run, ids[rel], rel, icon_dir)
      print(f'{rel}: {", ".join(icons) or "(none)"}')
      if icons:
        entry['site_icons'] = icons
      else:
        entry.pop('site_icons', None)
  finally:
    if not args.run:
      sm_dev('--run', run, 'stop', check=False)

  used = {icon for e in entries for icon in e.get('site_icons', [])}
  for f in sorted(icon_dir.iterdir()):
    if f.relative_to(root).as_posix() not in used:
      print(f'Removing unused {f.relative_to(root)}')
      f.unlink()
  write_entries(entries, were_strings)
  manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n',
                           encoding='utf-8')
  print('Manifest updated. Run update_readme.py to show the icons.')


if __name__ == '__main__':
  main()
