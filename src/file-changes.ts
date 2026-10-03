// Noticing, at paint time, that a local file a page is naming has
// changed on disk — deleted, or edited — before any refresh has run
// and updated the stored row. And, for a directory collection, that
// files have appeared which a refresh would pick up.
//
// Every surface that shows a `file://` path paints from storage, and
// storage only learns about the disk when the next refresh lists a
// directory. Until then the viewer's Location row, its Local overrides
// row, the versions table and the collections page all describe the
// file as it was last read. This module lets them say otherwise: a
// row tags the element carrying the path (`tagLocalFile`: the path,
// the size and mtime the row was read at, and the tooltips to use),
// and `markFileChanges` probes the disk and adds a chip beside each
// one that has gone or changed.
//
// See docs/file-changes.md.

import {
  baseName,
  isFileUrl,
  isLocalDirectoryCollection,
  isManifestCollection,
  listDirectory,
  locationFsPath,
  parentDir,
  type DirectoryListingCache,
} from './file-locations.js';
import { dlog } from './debug-log.js';
import type { StoredScript } from './script-build.js';

// What the disk says about a file the page names, against what the
// stored row was read from.
//
// - `missing`: its directory listed, and the name was not there.
// - `modified`: listed, and the listing's size or mtime differs from
//   the row's. Only answerable for a row that recorded both, which
//   every local file's row does once its folder has listed (the
//   refresh records the stat; a folder that wouldn't list leaves it
//   off).
// - `present`: listed with the same size and mtime, or listed with no
//   stored stat to compare against.
// - `unknown`: the directory could not be listed. Nothing is claimed.
export type FileState = 'present' | 'missing' | 'modified' | 'unknown';

export interface FileToProbe {
  // Absolute path.
  path: string;
  // The size and listing mtime the stored row was read at, when known
  // (`StoredScript.size` / `fsMtime`).
  size?: number;
  mtime?: number;
}

// One directory listing, reduced to what the probes need.
interface ListedDir {
  files: Map<string, { size?: number; mtime?: number }>;
  // Served from the memo rather than read just now.
  remembered: boolean;
}

// Probe `files` against their directory listings — one listing per
// distinct parent directory, rather than a read per file: a table can
// name many files in one folder, and a listing is one small read
// however many rows it settles.
//
// Conservative by construction. A file is reported missing only when
// its directory listed successfully and the name is not in it, and
// modified only when the listing supplies a size and mtime that differ
// from the stored ones. A listing that fails — the directory itself is
// gone, file access is off, a transient read error — settles nothing:
// its files come back `unknown`. That is the right way round for every
// caller: a chip that says "deleted" about a file that is there would
// be worse than no chip, and the delete dialog acts on the answer.
//
// `maxAgeMs` lets a caller that re-probes on every repaint reuse a
// listing read moments ago: the collections page repaints on every
// storage write, an enable toggle included, and nothing about the disk
// changed for that. A listing older than `maxAgeMs` is read again.
//
// A remembered listing is only ever trusted for the answer "present":
// a listing that agrees with the row is right whatever its age, but
// one that disagrees may simply predate the refresh that just updated
// the row (the refresh lists through its own cache, not this memo), so
// a folder with any other answer is listed again before it is given.
// The common case — nothing changed — pays no extra read; a change
// costs one, and the fresh listing replaces the memo.
//
// Answers one state per input, in input order — not per path: the same
// file can be held by several rows (one collection per copy), each
// read at a different time with a different stat, and each is its own
// question.
export async function probeFiles(
  files: readonly FileToProbe[],
  maxAgeMs = 0,
): Promise<FileState[]> {
  const byDir = new Map<string, number[]>();
  files.forEach((file, i) => {
    const dir = parentDir(file.path);
    const list = byDir.get(dir);
    if (list) list.push(i);
    else byDir.set(dir, [i]);
  });
  const states: FileState[] = new Array(files.length).fill('unknown');
  const cache: DirectoryListingCache = new Map();
  await Promise.all([...byDir].map(async ([dir, indexes]) => {
    let listed = await listedDir(dir, cache, maxAgeMs);
    if (listed?.remembered && indexes.some((i) => stateOf(files[i], listed!) !== 'present')) {
      listed = await listedDir(dir, cache, 0);
    }
    if (!listed) return;
    for (const i of indexes) states[i] = stateOf(files[i], listed);
  }));
  return states;
}

function stateOf(file: FileToProbe, listed: ListedDir): FileState {
  const entry = listed.files.get(baseName(file.path));
  if (!entry) return 'missing';
  // The same test the refresh uses to decide whether to re-read the
  // file (`canSkip` in script-store.ts), so a `modified` chip predicts
  // exactly what a refresh will do. Equality on mtime, not ordering:
  // the value is an opaque listing timestamp.
  if (
    file.size !== undefined && file.mtime !== undefined
    && entry.size !== undefined && entry.mtime !== undefined
    && (entry.size !== file.size || entry.mtime !== file.mtime)
  ) {
    return 'modified';
  }
  return 'present';
}

// The subset of `paths` that are no longer on disk. The delete dialog's
// question; a convenience over `probeFiles`.
export async function missingFiles(paths: Iterable<string>): Promise<Set<string>> {
  const files = [...paths].map((path) => ({ path }));
  const states = await probeFiles(files);
  return new Set(files.filter((_, i) => states[i] === 'missing').map((f) => f.path));
}

// `.user.js` files on disk in a directory collection that no row
// accounts for — what a refresh would add. Looks in the collection's
// root and in every directory a known script sits in, which is where
// new files land in practice; a new subdirectory with nothing known in
// it is not seen until a refresh scans it (docs/file-changes.md).
//
// Returns paths relative to the collection root, so they read the way
// the rows do.
export async function newScriptFiles(
  collectionPath: string,
  knownRelativePaths: Iterable<string>,
  maxAgeMs = 0,
): Promise<string[]> {
  const root = locationFsPath(collectionPath).replace(/\/+$/, '');
  const known = new Set(knownRelativePaths);
  const dirs = new Set<string>([root]);
  for (const rel of known) dirs.add(parentDir(`${root}/${rel}`));
  const out: string[] = [];
  const cache: DirectoryListingCache = new Map();
  await Promise.all([...dirs].map(async (dir) => {
    const listed = await listedDir(dir, cache, maxAgeMs);
    if (!listed) return;
    const prefix = dir === root ? '' : `${dir.slice(root.length + 1)}/`;
    for (const name of listed.files.keys()) {
      if (!name.endsWith('.user.js')) continue;
      const rel = prefix + name;
      if (!known.has(rel)) out.push(rel);
    }
  }));
  return out.sort();
}

// Recent successful listings, kept for `maxAgeMs`. Failures are not
// remembered: the next probe retries. Bounded by the number of
// folders a page names.
const recentListings = new Map<string, { at: number; listed: ListedDir }>();

// The listing for `dir`, or null when it could not be read (logged,
// not thrown: callers treat it as "nothing known").
async function listedDir(
  dir: string,
  cache: DirectoryListingCache,
  maxAgeMs: number,
): Promise<ListedDir | null> {
  const recent = recentListings.get(dir);
  if (recent && Date.now() - recent.at < maxAgeMs) return { ...recent.listed, remembered: true };
  try {
    const entries = await listDirectory(dir, cache);
    const files = new Map<string, { size?: number; mtime?: number }>();
    for (const e of entries) {
      if (!e.isDir) files.set(e.name, { size: e.size, mtime: e.mtime });
    }
    const listed: ListedDir = { files, remembered: false };
    recentListings.set(dir, { at: Date.now(), listed });
    return listed;
  } catch (err) {
    dlog(`[SourceMonkey] could not list ${dir} to check for file changes: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------- Tagging elements and painting chips ----------

export interface LocalFileTag {
  fsPath: string;
  // The stored size and listing mtime, when the row has them. Without
  // both, the file can only be reported missing, never modified.
  size?: number;
  mtime?: number;
  // Tooltips: what a deletion, and what an edit, means on this surface
  // and what will happen next — which differs: a deleted script file
  // is dropped or kept by the next refresh depending on its
  // collection, a deleted stand-in is replaced by the remote copy.
  // `modifiedHint` may be omitted by a surface that doesn't report
  // edits.
  missingHint: string;
  modifiedHint?: string;
}

// The tag for a script's own file, or null when the script isn't a
// local file. One builder for every surface that shows one (the
// viewer's Location row, the versions table, the collections page), so
// they can't disagree on the path, the stat, or the wording.
export function scriptFileTag(
  script: Pick<StoredScript, 'fileUrl' | 'size' | 'fsMtime'>,
  collectionPath: string,
): LocalFileTag | null {
  if (!isFileUrl(script.fileUrl)) return null;
  const tag: LocalFileTag = {
    fsPath: locationFsPath(script.fileUrl),
    missingHint: scriptFileMissingHint(collectionPath),
    modifiedHint: SCRIPT_FILE_MODIFIED_HINT,
  };
  // Both or neither: a row with a size but no listing mtime (its
  // folder didn't list when it was read) can't be compared, and a lone
  // size would miss same-size edits — worse than saying nothing.
  if (script.size != null && script.fsMtime !== undefined) {
    tag.size = script.size;
    tag.mtime = script.fsMtime;
  }
  return tag;
}

// Tag an element as naming a local file, for `markFileChanges`.
export function tagLocalFile(el: HTMLElement, tag: LocalFileTag): void {
  el.dataset.fsPath = tag.fsPath;
  if (tag.size !== undefined) el.dataset.fsSize = String(tag.size);
  if (tag.mtime !== undefined) el.dataset.fsMtime = String(tag.mtime);
  el.dataset.missingHint = tag.missingHint;
  if (tag.modifiedHint) el.dataset.modifiedHint = tag.modifiedHint;
}

export const FILE_CHIP_CLASS = 'file-change-chip';

// Probe every tagged element under `root` and put a chip after each
// one whose file is gone or changed. Safe to call after every repaint:
// an earlier chip is removed first, so a file that came back (or was
// re-read) loses its chip, and an element that left the document
// before the probe returns is simply annotated where nobody can see
// it. Resolves with the state of every tagged element, for a caller
// that wants to summarize.
//
// Async and deliberately not awaited by renders: the probe is a disk
// read, and a synchronous paint must not wait on it.
export async function markFileChanges(
  root: ParentNode,
  maxAgeMs = 0,
): Promise<Map<HTMLElement, FileState>> {
  const tagged = [...root.querySelectorAll<HTMLElement>('[data-fs-path]')];
  const states = new Map<HTMLElement, FileState>();
  if (tagged.length === 0) return states;
  const probed = await probeFiles(tagged.map((el) => ({
    path: el.dataset.fsPath!,
    size: el.dataset.fsSize === undefined ? undefined : Number(el.dataset.fsSize),
    mtime: el.dataset.fsMtime === undefined ? undefined : Number(el.dataset.fsMtime),
  })), maxAgeMs);
  tagged.forEach((el, i) => states.set(el, probed[i]));
  for (const el of tagged) {
    // The chip follows the path — and a copy button that directly
    // follows the path, since that button belongs beside the text it
    // copies (the viewer's Location and Local overrides rows).
    let anchor: Element = el;
    if (anchor.nextElementSibling?.classList.contains('copy-btn')) anchor = anchor.nextElementSibling;
    const prior = anchor.nextElementSibling;
    if (prior?.classList.contains(FILE_CHIP_CLASS)) prior.remove();
    const state = states.get(el);
    const hint = state === 'missing'
      ? el.dataset.missingHint
      : state === 'modified' ? el.dataset.modifiedHint : undefined;
    // A modified file with no hint is one this surface doesn't report
    // edits for.
    if (!hint) continue;
    const chip = document.createElement('span');
    chip.className = `${FILE_CHIP_CLASS} ${FILE_CHIP_CLASS}-${state}`;
    chip.textContent = state === 'missing' ? 'deleted' : 'modified';
    chip.title = hint;
    anchor.after(chip);
  }
  return states;
}

// ---------- Wording ----------
//
// The hints, in one place so the surfaces that name the same file agree
// on what its deletion means. Keyed by the collection the row sits in,
// because that is what decides what happens next:
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
    return 'This file has been deleted. The last copy of the script keeps running '
      + 'until the entry is removed from the manifest.';
  }
  return 'This file has been deleted. The last copy of the script keeps running until you remove it.';
}

// An edited script file: the same for every collection kind, since a
// refresh re-reads it wherever it sits.
export const SCRIPT_FILE_MODIFIED_HINT =
  'This file has changed on disk. The next refresh will load the new version.';

// A local stand-in for a `@require` / `@resource`. Deleted: the
// declared URL is still there, so the next refresh loads it from
// there instead. Edited: the next refresh (opportunistic ones
// included — a stand-in is re-read every pass) picks it up.
export const STAND_IN_MISSING_HINT =
  'This file has been deleted. The next refresh will reload the remote version.';
// The same words as for a script file: the outcome is the same.
export const STAND_IN_MODIFIED_HINT = SCRIPT_FILE_MODIFIED_HINT;

// A file sm-dev pushed with a scratch script: a snapshot no refresh
// rereads. It has no stored mtime, so only a deletion can be told.
export const PUSHED_FILE_MISSING_HINT =
  'This file has been deleted since sm-dev pushed it. The script still runs the snapshot it pushed.';

// The tag for a stand-in, given its path and the stored entry. The
// entry's `size` is the bytes read, which is the file's size; with the
// listing mtime recorded beside it, an edit can be told apart.
// `pushed` is for a snapshot sm-dev pushed.
export function standInTag(
  fsPath: string,
  entry: { size?: number; fsMtime?: number },
  pushed = false,
): LocalFileTag {
  const tag: LocalFileTag = {
    fsPath,
    missingHint: pushed ? PUSHED_FILE_MISSING_HINT : STAND_IN_MISSING_HINT,
    ...(pushed ? {} : { modifiedHint: STAND_IN_MODIFIED_HINT }),
  };
  if (entry.size !== undefined && entry.fsMtime !== undefined) {
    tag.size = entry.size;
    tag.mtime = entry.fsMtime;
  }
  return tag;
}

// The tooltip of a collection's "refresh pending" chip: what its
// directory holds that its rows don't, and what to do. Empty when
// nothing differs. Counts per kind, because each is a different thing
// for the user to go and check.
export function refreshPendingHint(counts: {
  modified: number;
  deleted: number;
  added: number;
  // The collection's manifest file itself has changed.
  manifest?: boolean;
}): string {
  const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
  const parts: string[] = [];
  if (counts.manifest) parts.push('the manifest changed');
  if (counts.modified > 0) parts.push(`${files(counts.modified)} modified`);
  if (counts.deleted > 0) parts.push(`${files(counts.deleted)} deleted`);
  if (counts.added > 0) parts.push(`${counts.added} new ${counts.added === 1 ? 'file' : 'files'}`);
  if (parts.length === 0) return '';
  const text = parts.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)} on disk. Refresh to load.`;
}

export const REFRESH_PENDING_CHIP_CLASS = `${FILE_CHIP_CLASS} ${FILE_CHIP_CLASS}-pending`;

// Put a "refresh pending" chip at the end of `nameEl` (a collection's
// display name), or remove the one there, to match `hint` (empty =
// nothing pending). Inside the name rather than after it: the heading
// is a two-column grid (bubble, name), where a third child would start
// a new row.
export function syncRefreshPendingChip(nameEl: HTMLElement, hint: string): void {
  const existing = nameEl.querySelector<HTMLElement>(`:scope > .${FILE_CHIP_CLASS}-pending`);
  if (!hint) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.title = hint;
    return;
  }
  const chip = document.createElement('span');
  chip.className = REFRESH_PENDING_CHIP_CLASS;
  chip.textContent = 'refresh pending';
  chip.title = hint;
  nameEl.appendChild(chip);
}
