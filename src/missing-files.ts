// Noticing, at paint time, that a local file a page is naming has been
// deleted — before any refresh has run and updated the stored row.
//
// Every surface that shows a `file://` path paints from storage, and
// storage only learns a file is gone when the next refresh lists its
// directory. Until then the viewer's Location row, its Local overrides
// row, the versions table and the collections page all describe a
// file that isn't there. This module lets them say so: a row tags the
// element carrying the path (`data-fs-path`, plus the tooltip to use
// in `data-missing-hint`), and `markMissingFiles` probes the disk and
// adds a "deleted" chip beside each one that has gone.
//
// See docs/missing-files.md.

import {
  baseName,
  isLocalDirectoryCollection,
  isManifestCollection,
  listDirectory,
  parentDir,
  type DirectoryListingCache,
} from './directories.js';
import { dlog } from './debug-log.js';

// Which of `paths` are no longer on disk. Answered from directory
// listings, one per distinct parent directory, rather than a fetch per
// file: a table can name many files in one folder, and a listing is
// one small read however many rows it settles.
//
// Conservative by construction. A path is reported missing only when
// its directory listed successfully and the name is not in it. A
// listing that fails — the directory itself is gone, file access is
// off, a transient read error — settles nothing, so its files are not
// reported. That is the right way round for every caller: a chip that
// says "deleted" about a file that is there would be worse than no
// chip, and the delete dialog acts on the answer.
//
// `maxAgeMs` lets a caller that re-probes on every repaint reuse a
// listing read moments ago: the collections page repaints on every
// storage write, an enable toggle included, and nothing about the disk
// changed for that. A listing older than `maxAgeMs` is read again, so
// a deletion still shows up on the next repaint after that.
export async function missingFiles(
  paths: Iterable<string>,
  maxAgeMs = 0,
): Promise<Set<string>> {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = parentDir(path);
    const list = byDir.get(dir);
    if (list) list.push(path);
    else byDir.set(dir, [path]);
  }
  const missing = new Set<string>();
  const cache: DirectoryListingCache = new Map();
  await Promise.all([...byDir].map(async ([dir, files]) => {
    let names: Set<string>;
    try {
      names = await listedNames(dir, cache, maxAgeMs);
    } catch (err) {
      dlog(`[SourceMonkey] could not list ${dir} to check for deleted files: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const path of files) {
      if (!names.has(baseName(path))) missing.add(path);
    }
  }));
  return missing;
}

// Recent successful listings, as the file names they held, for
// `maxAgeMs`. Failures are not remembered: the next probe retries.
const recentListings = new Map<string, { at: number; names: Set<string> }>();

async function listedNames(
  dir: string,
  cache: DirectoryListingCache,
  maxAgeMs: number,
): Promise<Set<string>> {
  const recent = recentListings.get(dir);
  if (recent && Date.now() - recent.at < maxAgeMs) return recent.names;
  const entries = await listDirectory(dir, cache);
  const names = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
  recentListings.set(dir, { at: Date.now(), names });
  return names;
}

// Tag an element as naming a local file, for `markMissingFiles`.
// `hint` is the chip's tooltip: what the deletion means on this
// surface and what will happen next, since that differs — a script
// file is dropped by the next refresh, a stand-in is replaced by the
// remote copy.
export function tagLocalFile(el: HTMLElement, fsPath: string, hint: string): void {
  el.dataset.fsPath = fsPath;
  el.dataset.missingHint = hint;
}

export const MISSING_FILE_CHIP_CLASS = 'missing-file-chip';

// Probe every tagged element under `root` and put a chip after each
// one whose file is gone. Safe to call after every repaint: an earlier
// chip is removed first, so a file that came back loses its chip, and
// an element that left the document before the probe returns is
// simply annotated where nobody can see it.
//
// Async and deliberately not awaited by renders: the probe is a disk
// read, and a synchronous paint must not wait on it.
export async function markMissingFiles(root: ParentNode, maxAgeMs = 0): Promise<void> {
  const tagged = [...root.querySelectorAll<HTMLElement>('[data-fs-path]')];
  if (tagged.length === 0) return;
  const missing = await missingFiles(tagged.map((el) => el.dataset.fsPath!), maxAgeMs);
  for (const el of tagged) {
    const prior = el.nextElementSibling;
    if (prior?.classList.contains(MISSING_FILE_CHIP_CLASS)) prior.remove();
    if (!missing.has(el.dataset.fsPath!)) continue;
    const chip = document.createElement('span');
    chip.className = MISSING_FILE_CHIP_CLASS;
    chip.textContent = 'deleted';
    chip.title = el.dataset.missingHint ?? '';
    el.after(chip);
  }
}

// The hints, in one place so the surfaces that name the same file
// agree on what its deletion means. Keyed by the collection the row
// sits in, because that is what decides what happens next:
//
// - A directory collection mirrors the disk, so the next refresh drops
//   the row.
// - A manifest entry is the manifest's to keep or drop: the row stays,
//   running from its last copy, until the entry leaves the manifest.
// - A file added on its own is the user's: the row stays until they
//   remove it (the trash can on its row).
export function scriptFileMissingHint(collectionPath: string): string {
  if (isLocalDirectoryCollection(collectionPath)) {
    return 'This file has been deleted. The next refresh will remove this script.';
  }
  if (isManifestCollection(collectionPath)) {
    return 'This file has been deleted. The script keeps running from its last copy '
      + 'until the entry is removed from the manifest.';
  }
  return 'This file has been deleted. The last copy of the script keeps running until you remove it.';
}

// A local stand-in for a `@require` / `@resource`: the declared URL is
// still there, so the next refresh loads it from there instead.
export const STAND_IN_MISSING_HINT =
  'This file has been deleted. The next refresh will reload the remote version.';
