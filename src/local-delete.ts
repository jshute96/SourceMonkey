// Deleting a local copy — the script file itself, and optionally the
// dependency files that were copied beside it — off the disk.
//
// The counterpart of `local-copy.ts`, and it can only undo what that
// module did: `chrome.downloads.removeFile` deletes a file the browser
// itself downloaded, found by its absolute path in Chrome's download
// history. Nothing else an extension can call deletes a file, so a copy
// whose history entry is gone can only be reported, not removed.
//
// See docs/local-delete.md.

import { locationFsPath } from './file-locations.js';
import {
  describeError,
  type StoredCollection,
  type StoredScript,
} from './script-store.js';
import { dlog } from './debug-log.js';
import {
  downloadsCopiesDir,
  readDownloadsCopiesSetting,
  type DownloadsCopiesSetting,
} from './local-copy.js';

// The copies setting, or null when it can't be read — a surface that
// asks "is this row a local copy?" while painting must not be taken
// down by a storage failure, and null is the safe answer (no row
// offers a file deletion). One helper so the pages that ask can't
// drift on what a failure means.
export async function readCopiesSetting(): Promise<DownloadsCopiesSetting | null> {
  try {
    return await readDownloadsCopiesSetting();
  } catch (err) {
    dlog(`[SourceMonkey] could not read the local-copies setting: ${describeError(err)}`);
    return null;
  }
}

// ---------- Which scripts can be deleted from disk ----------

// The absolute path of `script`'s file when it is a copy we wrote, and
// null when it isn't. `collection` is the row's own collection.
//
// Both halves are required, and the collection is the important one:
// the row has to sit in the directory collection AT the copies
// directory. That is what makes the rest of this module's reasoning
// true — a file in that directory is shared only within that
// collection, so its scripts are the whole set that could be reading
// it, and `copyDeletePlan` can answer "does anything else need this?"
// from one collection's rows.
//
// A row somewhere else whose file happens to be in that directory — an
// individual script the user added by hand at that path — is refused.
// Deleting through it would compute the shared/own split against the
// wrong set of scripts and could take a library another copy is
// loading. Individual-file rows, overlapping directories and manifests
// all break the assumption in the same way; none of them is worth the
// mess (see TODO.md).
//
export function deletableCopyPath(
  script: Pick<StoredScript, 'fileUrl'>,
  collection: Pick<StoredCollection, 'path'> | null | undefined,
  setting: DownloadsCopiesSetting | null,
): string | null {
  if (!setting || !collection) return null;
  const dir = downloadsCopiesDir(setting.downloadsDir);
  if (!isCopiesDir(collection.path, dir)) return null;
  const path = locationFsPath(script.fileUrl);
  return path.startsWith(`${dir}/`) ? path : null;
}

// Is this collection the one at the copies directory? Compared as
// paths, so the collection is recognized however it was created — the
// one our first copy made, or one the user had already added there and
// we adopted (see local-copy.md).
function isCopiesDir(collectionPath: string, copiesDir: string): boolean {
  return locationFsPath(collectionPath).replace(/\/+$/, '') === copiesDir;
}

// ---------- What a deletion would take with it ----------

// One `@require` / `@resource` file the script is loading from disk,
// beside the copy.
export interface DeletableDependency {
  // Absolute path on disk.
  path: string;
  // Relative to the copies directory, which is how the dialog shows it
  // — the same spelling the copy dialog listed when it wrote the file.
  relativePath: string;
  // The declared URL this file stands in for.
  url: string;
}

export interface CopyDeletePlan {
  // The copy's own file.
  path: string;
  relativePath: string;
  // Dependency files only this script loads. They go with it: nothing
  // else is reading them, so there is no decision to put to the user.
  own: DeletableDependency[];
  // Dependency files another script in the collection loads too. Listed
  // under a heading that says they are staying, never deleted: removing
  // one would break a script the user didn't ask about.
  shared: DeletableDependency[];
}

// What deleting `script` would remove, given every script in its
// collection (`siblings`, which may include `script` itself).
//
// Only siblings are consulted because only they can be reading these
// files: a local stand-in is searched for under the script's own folder
// and its collection root (see local-file-overrides.md), so a file
// under the copies directory is invisible to a script outside it.
export function copyDeletePlan(
  script: StoredScript,
  siblings: readonly StoredScript[],
  copiesDir: string,
): CopyDeletePlan {
  // Which files another script in the collection is loading. Only
  // whether, not which scripts: the dialog doesn't name them — a
  // userscript name is long and there can be several.
  const others = new Set<string>();
  for (const other of siblings) {
    if (other.id === script.id) continue;
    for (const path of localDependencyPaths(other, copiesDir).keys()) others.add(path);
  }
  const own: DeletableDependency[] = [];
  const shared: DeletableDependency[] = [];
  for (const [path, url] of localDependencyPaths(script, copiesDir)) {
    const dep: DeletableDependency = {
      path,
      relativePath: path.slice(copiesDir.length + 1),
      url,
    };
    (others.has(path) ? shared : own).push(dep);
  }
  const path = locationFsPath(script.fileUrl);
  return {
    path,
    relativePath: path.startsWith(`${copiesDir}/`) ? path.slice(copiesDir.length + 1) : path,
    own,
    shared,
  };
}

// The files under `copiesDir` a script is currently loading its
// `@require` / `@resource` entries from, as path → declared URL.
//
// `localUrl` is the authority: it is what the load pipeline actually
// read, so this lists files in use rather than paths a copy might once
// have written. Deduped by path — one file can serve two declarations.
function localDependencyPaths(script: StoredScript, copiesDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of [...(script.requires ?? []), ...(script.resources ?? [])]) {
    if (!file.localUrl) continue;
    const path = locationFsPath(file.localUrl);
    if (!path.startsWith(`${copiesDir}/`) || out.has(path)) continue;
    out.set(path, file.url);
  }
  return out;
}

// ---------- Which files the browser can still be asked about ----------

// Every completed download whose file is this path AND that Chrome
// still believes is on disk. `filename` is an exact match on the
// absolute path, and the record outlives the session — it is cleared
// with the user's browsing data, not on restart.
//
// `exists` is the important half. Chrome refuses `removeFile` with
// *Download file already deleted* for a record it has marked gone, and
// that mark is sticky: it is set by Chrome's own existence checks, so a
// copy edited by a tool that saves via write-to-temp-and-rename can
// carry it while the file is sitting right there. Filtering here means
// the dialog's lists and the deletion agree — a file Chrome won't act
// on is shown as one we can't delete, before anything is pressed,
// rather than failing half way through.
function completedDownloads(path: string): Promise<chrome.downloads.DownloadItem[]> {
  return chrome.downloads.search({ filename: path, state: 'complete', exists: true });
}

// The subset of `paths` Chrome still holds a download record for — the
// only ones `removeFile` can act on. Asked up front so the dialog can
// say which files are going and which are being left, rather than
// finding out one failure at a time.
//
// A search that throws counts as "no record": the answer is only used
// to decide what to attempt, and attempting a file we can't ask about
// would fail anyway.
export async function trackedFiles(paths: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>();
  await Promise.all(paths.map(async (path) => {
    try {
      if ((await completedDownloads(path)).length > 0) tracked.add(path);
    } catch (err) {
      dlog(`[SourceMonkey] could not look up the download record for ${path}: ${describeError(err)}`);
    }
  }));
  return tracked;
}

// ---------- Deleting ----------

// Chrome holds no usable download record for the file, so `removeFile`
// has nothing to act on — the user cleared their downloads, or Chrome
// has marked the file gone (see `completedDownloads`). Two sentences,
// both punctuated: this lands in the dialog's error slot and in the
// viewer's message line, never spliced after a prefix
// (docs/diagnostics.md#wording).
//
// `subject` names what could not be deleted. The script's own file is
// `SCRIPT_FILE`, with no path in it: the dialog is already showing the
// file and its full path two rows up, and a relative path with a
// subdirectory in it makes the sentence hard to read. A dependency
// file, reported away from any list of its own, carries its path.
//
// `alsoOthers` when the same block would have taken other files with
// it — the copy's own dependencies. They are all still on disk, so the
// second line names them all rather than just the one it reports on.
//
// The second line says what to do next, not just that we can't. With
// `watched`, the dialog is showing this for the script file with its
// Delete disabled, and the row has no other trash can (a directory
// collection's rows are removed by refreshing, which scans the file
// straight back in) — so without it the user is looking at a dead
// end. The dialog watches for the file going and then offers to
// remove the entry (`watchDisk` in the dialog), which is what the
// line promises. Without `watched` — a dependency reported after the
// script has already gone, or a dialog that can't watch because file
// access is off — the line promises nothing.
export const SCRIPT_FILE = 'Script file';

export function noDownloadRecord(subject: string, alsoOthers = false, watched = false): string {
  const files = alsoOthers ? 'files' : 'file';
  return `${subject} is no longer in Chrome download history, so SourceMonkey cannot delete it.\n`
    + (watched
      ? `Delete the ${files} by hand, and Delete will then remove this script.`
      : `You can delete the ${files} by hand.`);
}

// Ends with a period, unlike most messages: it is joined with the
// other per-file reports into one line (the viewer's not-found detail,
// the collections page's error line), where an unpunctuated sentence
// runs into the next one. Nothing splices it after a prefix.
function deleteFailed(name: string, detail: string): string {
  return `Deleting ${name} failed: ${detail}.`;
}

// Delete one file the browser downloaded, by its absolute path.
// Resolves with null on success, or the message to show.
//
// `removeFile` deletes the bytes; `erase` then drops the history row,
// which would otherwise sit in the user's downloads list pointing at a
// file that is gone. Erasing is best effort — the file is already gone
// by then, which is what was asked for.
//
// **Nothing is erased unless the file went.** The record is the only
// handle there is on that file: erasing one we failed to delete with
// would leave the file on disk and take away the one way of ever
// removing it.
async function deleteDownloadedFile(
  path: string,
  name: string,
  kind: 'Script' | 'File' = 'File',
  alsoOthers = false,
): Promise<string | null> {
  let items: chrome.downloads.DownloadItem[];
  try {
    items = await completedDownloads(path);
  } catch (err) {
    return deleteFailed(name, describeError(err));
  }
  if (items.length === 0) {
    return noDownloadRecord(kind === 'Script' ? SCRIPT_FILE : `File ${name}`, alsoOthers);
  }
  // Newest first: one path can have been written several times over
  // (every Replace adds a record), and the latest is the one whose
  // file is on disk now. Older records for the same path are erased
  // too, so the downloads list doesn't keep rows for a file that has
  // gone.
  const ordered = [...items].sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
  let lastError = '';
  for (const item of ordered) {
    try {
      await chrome.downloads.removeFile(item.id);
    } catch (err) {
      // Chrome refuses a record it believes is already gone. Another
      // record for the same path may still hold the live one, so this
      // is only fatal once every record has been tried — and the
      // record we couldn't delete with is left alone.
      lastError = describeError(err);
      continue;
    }
    // The file is gone, so every record for that path now points at
    // nothing. Erased only from here.
    for (const stale of ordered) {
      try {
        await chrome.downloads.erase({ id: stale.id });
      } catch (err) {
        dlog(`[SourceMonkey] could not erase the download record for ${path}: ${describeError(err)}`);
      }
    }
    return null;
  }
  return deleteFailed(name, lastError || 'The file could not be removed');
}

export interface DeleteFilesRequest {
  // The copy's own file. Deleted first: it is what the user asked for,
  // and a failure there stops the dependencies from going with it.
  // Null when the dialog found it already gone from disk: there is
  // nothing to delete, and the dependencies go on their own.
  script: { path: string; relativePath: string } | null;
  // The files to take with it — already narrowed to this script's own
  // dependencies that Chrome still holds a record for (`trackedFiles`),
  // which is what the dialog showed the user.
  dependencies: readonly { path: string; relativePath: string }[];
}

export interface DeleteFilesResult {
  // Why the script file could not be deleted. Nothing else was touched.
  scriptError: string | null;
  // Dependency files that could not be deleted, after the script went.
  // Reported, not thrown: the script is gone, which is what was asked,
  // and the leftovers are a smaller problem the user can act on.
  dependencyErrors: string[];
}

export async function deleteCopyFiles(request: DeleteFilesRequest): Promise<DeleteFilesResult> {
  if (request.script) {
    const scriptError = await deleteDownloadedFile(
      request.script.path,
      request.script.relativePath,
      'Script',
      // The dependencies were going with it and are staying too, so the
      // message says so — the same answer the dialog gives when it knows
      // up front that the script's record has gone.
      request.dependencies.length > 0,
    );
    if (scriptError) return { scriptError, dependencyErrors: [] };
  }
  const dependencyErrors: string[] = [];
  for (const dep of request.dependencies) {
    const err = await deleteDownloadedFile(dep.path, dep.relativePath);
    if (err) dependencyErrors.push(err);
  }
  return { scriptError: null, dependencyErrors };
}
