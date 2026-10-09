// Making an editable copy of an installed script on local disk.
//
// The copy is written into the "Scripts copied in Downloads" directory
// collection — `<Downloads>/SourceMonkey/` — through `chrome.downloads`,
// the one write path an extension has that needs no dialog and reports
// back the absolute path of what it wrote. Everything else (the
// dialog, the enable sweep, the navigation) lives in `copy-dialog.ts`
// and `userscript.ts`; this module is the pure logic plus the write.
//
// See docs/local-copy.md.

import { base64ToBytes } from '../bytes.js';
import { assertWorkerContext } from '../run-context.js';
import { MAX_SCAN_DEPTH } from '../collection-scan.js';
import { collectionNameInUse } from './collection-display.js';
import {
  canonicalCollectionInput,
  isHttpUrl,
  baseName,
  joinPath,
  pathToFileUrl,
  statFromListing,
  type DirectoryListingCache,
} from '../file-locations.js';
import { localFileCandidates } from '../local-file-overrides.js';
import { scriptBasename } from '../script-display.js';
import { locationKey } from './script-identity.js';
import { dlog } from '../debug-log.js';
import {
  createCollection,
  describeError,
  getCollections,
  refreshCollection,
  setScriptsEnabled,
  withoutBodies,
  type ScriptMeta,
  type StoredCollection,
  type StoredScript,
} from './script-store.js';
import { callWorker } from './worker-client.js';
import { joinFullSource, splitHeaderBody } from '../userscript-header.js';

// ---------- The default collection and where Downloads is ----------

// The subdirectory of the browser's Downloads folder every copy lands
// in. Also the directory the default collection is created at.
export const DOWNLOADS_COPIES_SUBDIR = 'SourceMonkey';

// The default collection's seeded name. The user's to edit — the
// collection is found by the id recorded below, never by this.
export const DOWNLOADS_COPIES_NAME = 'Scripts copied in Downloads';

// `chrome.storage.local` key. Both values are learned from the first
// completed copy: Chrome exposes no API for where Downloads is, but a
// finished download reports its absolute path, and ours was written to
// a known relative name under it.
export const DOWNLOADS_COPIES_KEY = 'smDownloadsCopies';

export interface DownloadsCopiesSetting {
  // Absolute path of the browser's Downloads folder, no trailing slash.
  downloadsDir: string;
  // The id of the collection at `<downloadsDir>/SourceMonkey`, once one
  // exists. Outlives a rename; a removed collection is re-created (or a
  // hand-added one at the same directory adopted) on the next copy.
  collectionId: string | null;
}

export async function readDownloadsCopiesSetting(): Promise<DownloadsCopiesSetting | null> {
  const got = await chrome.storage.local.get(DOWNLOADS_COPIES_KEY);
  return parseDownloadsCopiesSetting(got[DOWNLOADS_COPIES_KEY]);
}

export function parseDownloadsCopiesSetting(raw: unknown): DownloadsCopiesSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const { downloadsDir, collectionId } = raw as Record<string, unknown>;
  if (typeof downloadsDir !== 'string' || !downloadsDir) return null;
  return {
    downloadsDir,
    collectionId: typeof collectionId === 'string' && collectionId ? collectionId : null,
  };
}

// Worker side (`ensureDownloadsCollection`). A page writes it through
// worker-client.ts's `writeSetting`.
async function writeDownloadsCopiesSetting(setting: DownloadsCopiesSetting): Promise<void> {
  assertWorkerContext('write storage');
  await chrome.storage.local.set({ [DOWNLOADS_COPIES_KEY]: setting });
}

// Where the copies go, as an absolute directory path.
export function downloadsCopiesDir(downloadsDir: string): string {
  return joinPath(downloadsDir, DOWNLOADS_COPIES_SUBDIR);
}

// The collection the setting names, or — failing the id — whichever
// collection already sits at the copies directory. Null when neither
// exists yet.
export function findDownloadsCollection(
  setting: DownloadsCopiesSetting | null,
  collections: readonly StoredCollection[],
): StoredCollection | null {
  if (!setting) return null;
  const byId = setting.collectionId
    ? collections.find((c) => c.id === setting.collectionId)
    : undefined;
  const wantedPath = dirKey(downloadsCopiesDir(setting.downloadsDir));
  // A collection the id names but that has since moved out from under
  // us — Chrome's Downloads location changed — is an ordinary directory
  // collection now, not ours.
  if (byId && dirKey(byId.path) === wantedPath) return byId;
  return collections.find((c) => dirKey(c.path) === wantedPath) ?? null;
}

// A directory path or `file://` URL as a comparable key: the bare
// path, with no trailing slash.
function dirKey(pathOrUrl: string): string {
  return canonicalCollectionInput(pathOrUrl).replace(/\/+$/, '');
}

// ---------- Names and paths ----------

// The relative path a copy of `script` gets by default: its own file
// name, made a `.user.js` if it isn't one. Nothing cleverer — a copy
// of a copy defaults to the same name too, and the dialog refuses
// that (`isCopyOfItself`) rather than inventing a name the user didn't
// ask for.
export function defaultCopyName(script: StoredScript): string {
  const base = scriptBasename(script.relativePath).replace(/[\\/:*?"<>|]/g, '_');
  return base.endsWith('.user.js') ? base : `${base.replace(/\.js$/, '')}.user.js`;
}

// Two sentences, so both take a period — see docs/diagnostics.md.
export const COPY_OVER_ITSELF =
  'The copy source and destination are the same. Choose another filename.';

// True when writing `fileName` under `copiesDir` would land on the very
// file `script` is loaded from — a copy standing in the copies
// directory, copied again under its own name.
export function isCopyOfItself(script: StoredScript, copiesDir: string, fileName: string): boolean {
  return locationKey(script.fileUrl) === locationKey(pathToFileUrl(joinPath(copiesDir, fileName.trim())));
}

export const COPY_NAME_REQUIRED = 'Filename is required';
export const COPY_NAME_NOT_USERSCRIPT = 'Filename must end with .user.js';
export const COPY_NAME_NOT_RELATIVE = 'Filename must be a relative path, with no leading slash or ..';
export const COPY_NAME_TOO_DEEP =
  `Filename can be at most ${MAX_SCAN_DEPTH} folders deep, or the collection will not find it`;
export const COPY_NAME_BAD_CHARS = 'Filename cannot contain \\ : * ? " < > |';

// Why `relativePath` can't name a copy, or null when it can. Mirrors
// what `chrome.downloads.download` refuses (absolute paths, `..`) and
// what the collection scan would never find (too deep).
export function validateCopyName(relativePath: string): string | null {
  const name = relativePath.trim();
  if (!name) return COPY_NAME_REQUIRED;
  if (UNWRITABLE_CHARS.test(name)) return COPY_NAME_BAD_CHARS;
  if (name.startsWith('/')) return COPY_NAME_NOT_RELATIVE;
  const segments = name.split('/');
  // `.trim()` catches a blank segment too — `a/ /b.user.js` would make
  // a directory named with a space.
  if (segments.some((s) => s.trim() === '' || s === '.' || s === '..')) {
    return COPY_NAME_NOT_RELATIVE;
  }
  if (!name.endsWith('.user.js') || segments[segments.length - 1] === '.user.js') {
    return COPY_NAME_NOT_USERSCRIPT;
  }
  if (segments.length - 1 > MAX_SCAN_DEPTH) return COPY_NAME_TOO_DEEP;
  return null;
}

// The Downloads folder a saved file implies: the absolute path Chrome
// reported, minus the relative name we asked for. Null when the file
// went somewhere else — the user has Chrome's "Ask where to save each
// file" on and picked another folder.
export function downloadsDirFromSaved(absolutePath: string, relativeName: string): string | null {
  const suffix = `/${relativeName}`;
  if (!absolutePath.endsWith(suffix)) return null;
  const dir = absolutePath.slice(0, -suffix.length);
  return dir || null;
}

// ---------- Header rewriting ----------

export interface HeaderEdits {
  // A tag's new value. `''` removes the tag line; `undefined` leaves
  // the header alone for that tag.
  version?: string;
  description?: string;
}

// The source with `@version` / `@description` replaced, added, or
// removed. Line-for-line otherwise: every other line, the line endings,
// and the spacing between tag and value are kept as they were, so a
// diff against the original shows only the edit. A source with no
// metadata block is returned unchanged — there is nowhere to write.
export function rewriteHeaderTags(source: string, edits: HeaderEdits): string {
  const split = splitHeaderBody(source);
  if (split.error) return source;
  const eol = split.headerText.includes('\r\n') ? '\r\n' : '\n';
  const lines = split.headerText.split(/\r\n|\r|\n/);
  for (const [tag, value] of [['version', edits.version], ['description', edits.description]] as const) {
    if (value === undefined) continue;
    applyTagEdit(lines, tag, value.trim());
  }
  // Not `joinFullSource`: it restores the line break after the closing
  // marker as a bare `\n`, which is fine for display but would leave a
  // CRLF file with one LF line in the middle.
  return split.leadingText + lines.join(eol) + eol + split.bodyText;
}

// Plain `@tag` only — a localized `@description:de` is a different tag
// and is left alone.
function tagLinePattern(tag: string): RegExp {
  return new RegExp(`^([ \\t]*\\/\\/[ \\t]*@${tag})(?:([ \\t]+)(.*\\S))?[ \\t]*$`);
}

function applyTagEdit(lines: string[], tag: string, value: string): void {
  const re = tagLinePattern(tag);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) {
    if (!value) {
      lines.splice(at, 1);
      return;
    }
    const m = re.exec(lines[at])!;
    lines[at] = `${m[1]}${m[2] ?? '  '}${value}`;
    return;
  }
  if (!value) return;
  // New line, placed after `@name` (any locale) and aligned to it, or
  // straight after the opening marker when there is no `@name`.
  const nameRe = /^([ \t]*\/\/[ \t]*@)name(?::[\w-]+)?(?:([ \t]+)(.*\S))?[ \t]*$/;
  const nameAt = lines.findIndex((l) => nameRe.test(l));
  let prefix = '// @';
  let valueColumn = -1;
  if (nameAt >= 0) {
    const m = nameRe.exec(lines[nameAt])!;
    prefix = m[1];
    if (m[3] !== undefined) valueColumn = lines[nameAt].length - m[3].length;
  }
  const head = `${prefix}${tag}`;
  const pad = valueColumn > head.length ? ' '.repeat(valueColumn - head.length) : ' ';
  lines.splice(nameAt >= 0 ? nameAt + 1 : 1, 0, `${head}${pad}${value}`);
}

// ---------- Dependencies ----------

// One `@require` / `@resource` file to write beside the copy.
export interface DependencyFile {
  // The declared URL, for the dialog's listing.
  url: string;
  // Where it goes, relative to the SCRIPT's own folder: the URL's
  // `<host>/<path>`, decoded to the on-disk spelling. This is the
  // longest candidate the local-overrides suffix rule tries, with the
  // script's own folder as the implicit first root — so the copy picks
  // the file up without any `@require` line being rewritten.
  relativePath: string;
  body: Blob;
  size: number;
}

// The dependency files a copy of `script` would carry: the bytes the
// row already holds, laid out as above. Deduped by target path, so two
// declarations of one URL write one file. Only http(s) URLs: a
// `file://` dependency is already on disk, and a `data:` one has no
// file to write.
export function dependencyFiles(script: StoredScript): DependencyFile[] {
  const out = new Map<string, DependencyFile>();
  const add = (url: string, body: Blob): void => {
    // http(s) only: a `file://` dependency is already on disk, and a
    // `data:` one has no file to write.
    if (!isHttpUrl(url)) return;
    const relativePath = mirrorPath(url);
    if (!relativePath || out.has(relativePath)) return;
    out.set(relativePath, { url, relativePath, body, size: body.size });
  };
  for (const r of script.requires ?? []) {
    add(r.url, new Blob([r.source], { type: 'text/javascript' }));
  }
  for (const r of script.resources ?? []) {
    add(r.url, new Blob([base64ToBytes(r.bytesBase64)], { type: r.contentType || 'application/octet-stream' }));
  }
  return [...out.values()];
}

// `<host>/<path>` of a URL as an on-disk relative path, via the same
// candidate builder the override lookup uses so the two can't drift.
// Null when the URL yields no candidate (no path, or a path that names
// a directory).
//
// The longest candidate `chrome.downloads` can actually write. It
// refuses a path with characters illegal on any platform — `:` above
// all, which a `host:port` mirror directory would carry. The lookup
// tries every shorter suffix too, so dropping to `lib/util.js` beside
// the script still resolves; a basename that itself can't be written
// yields null and the dependency is skipped.
export function mirrorPath(url: string): string | null {
  const root = 'file:///';
  for (const candidate of localFileCandidates(url, [root])) {
    if (!candidate.startsWith(root)) continue;
    let decoded: string;
    try {
      decoded = candidate.slice(root.length).split('/').map((seg) => decodeURIComponent(seg)).join('/');
    } catch {
      continue;
    }
    if (!UNWRITABLE_CHARS.test(decoded)) return decoded;
  }
  return null;
}

// What `chrome.downloads.download` rejects in a `filename` — the
// Windows-illegal set, enforced everywhere. Same set `validateCopyName`
// refuses for the script's own name.
const UNWRITABLE_CHARS = /[\\:*?"<>|]/;

// ---------- The files a copy consists of ----------

export interface CopyPlan {
  // The copy's path relative to the collection root.
  fileName: string;
  version: string;
  description: string;
  includeDependencies: boolean;
}

export interface PlannedFile {
  // Relative to the collection root.
  relativePath: string;
  body: Blob;
}

// Every file the copy writes, the script first. Dependencies sit under
// the script's own folder.
export function planFiles(script: StoredScript, plan: CopyPlan): PlannedFile[] {
  const source = joinFullSource(script.leadingText ?? '', script.headerText, script.bodyText);
  const text = rewriteHeaderTags(source, { version: plan.version, description: plan.description });
  const files: PlannedFile[] = [
    { relativePath: plan.fileName, body: new Blob([text], { type: 'text/javascript' }) },
  ];
  if (plan.includeDependencies) {
    const dir = plan.fileName.includes('/') ? plan.fileName.slice(0, plan.fileName.lastIndexOf('/')) : '';
    for (const dep of dependencyFiles(script)) {
      files.push({ relativePath: dir ? `${dir}/${dep.relativePath}` : dep.relativePath, body: dep.body });
    }
  }
  return files;
}

// ---------- What is already on disk ----------

// Which of a plan's files are already on disk. Replacing an installed
// script's file is allowed like any other: the file is what its row is
// built from, so the refresh that follows the write updates that row
// in place, id and all.
export interface ExistingFileCheck {
  // Relative paths (collection-relative) that already exist.
  existing: string[];
}

// Which of `files` already exist under `copiesDir`, read through the
// same directory listing a refresh uses. A listing that can't be read
// (the folder doesn't exist yet, say) counts as empty — the write will
// create it.
export async function checkExistingFiles(
  copiesDir: string,
  files: readonly { relativePath: string }[],
): Promise<ExistingFileCheck> {
  const cache: DirectoryListingCache = new Map();
  const existing: string[] = [];
  for (const f of files) {
    const abs = joinPath(copiesDir, f.relativePath);
    const slash = abs.lastIndexOf('/');
    let entry = null;
    try {
      entry = await statFromListing(abs.slice(0, slash), abs.slice(slash + 1), cache);
    } catch {
      // No listing, no file.
    }
    if (!entry || entry.isDir) continue;
    existing.push(f.relativePath);
  }
  return { existing };
}

// ---------- Writing ----------

export const COPY_CANCELLED = 'Saving the copy was cancelled';

// How long to wait for one download to finish. A blob of a few hundred
// KB completes in milliseconds; the budget only matters when Chrome is
// holding the file for a Save As box the user has left open.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// Write `files` under the Downloads folder via `chrome.downloads`, one
// download each, and return the absolute paths Chrome saved them at.
//
// Silent unless Chrome's "Ask where to save each file" setting is on
// — that preference is honoured regardless of `saveAs: false`, so the
// user then sees a Save As box already pointed at our path. Wherever
// they send it is what comes back here; the caller checks.
//
// `overwrite` is only passed once the dialog has shown the user what
// it would replace. Otherwise Chrome's default (`uniquify`) renames a
// colliding file, and the caller's path check reports the mismatch.
export interface WrittenFile {
  // The download's id, so a failure part-way through can take the file
  // back off disk.
  id: number;
  // Where Chrome says it put it.
  path: string;
}

export async function writeUnderDownloads(
  files: readonly { relativePath: string; body: Blob }[],
  overwrite: boolean,
): Promise<WrittenFile[]> {
  const saved: WrittenFile[] = [];
  for (const f of files) {
    saved.push(await downloadOne(f.relativePath, f.body, overwrite));
  }
  return saved;
}

// Delete files this copy wrote, after it turned out not to be a copy.
// Best effort and never thrown from: the caller is already reporting a
// failure, and a file we couldn't remove is a smaller problem than
// replacing that report with a second one.
//
// Why bother: a `.user.js` left behind in the copies directory is not
// inert. The next refresh of that collection scans it in as a new
// script — and a new row lands ENABLED — so an abandoned copy would
// start running a script the user never agreed to install.
async function discardWritten(written: readonly WrittenFile[]): Promise<void> {
  for (const w of written) {
    try {
      await chrome.downloads.removeFile(w.id);
    } catch (err) {
      dlog(`[SourceMonkey] could not remove ${w.path} after a failed copy: ${describeError(err)}`);
    }
    // The download-history entry too, so the failed copy doesn't sit in
    // the user's downloads list pointing at a file that is gone.
    try {
      await chrome.downloads.erase({ id: w.id });
    } catch {
      // Nothing to do about it, and nothing to tell the user.
    }
  }
}

async function downloadOne(relativePath: string, body: Blob, overwrite: boolean): Promise<WrittenFile> {
  const url = URL.createObjectURL(body);
  try {
    let id: number;
    try {
      id = await chrome.downloads.download({
        url,
        filename: relativePath,
        saveAs: false,
        conflictAction: overwrite ? 'overwrite' : 'uniquify',
      });
    } catch (err) {
      // Chrome's own wording ("Invalid filename") names neither the
      // file nor the step.
      throw new Error(`Saving ${relativePath} was refused by Chrome: ${describeChromeError(err)}`);
    }
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    let accepted = false;
    while (Date.now() < deadline) {
      const [item] = await chrome.downloads.search({ id });
      if (item) {
        if (item.state === 'complete') return { id, path: item.filename };
        if (item.state === 'interrupted') {
          if (item.error === 'USER_CANCELED') throw new Error(COPY_CANCELLED);
          throw new Error(`Saving ${relativePath} failed: ${item.error ?? 'download interrupted'}`);
        }
        // A file type Chrome wants confirmed before it lands. Not
        // expected for `.user.js` (verified), but the prompt is the
        // right answer if a Chrome policy ever flags it — once.
        if (item.danger !== 'safe' && item.danger !== 'accepted' && !accepted) {
          accepted = true;
          await chrome.downloads.acceptDanger(id);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Saving ${relativePath} timed out`);
  } finally {
    // The download has read the blob by the time `search` reports it
    // complete or interrupted, and a URL that outlives its page dies
    // with it either way.
    URL.revokeObjectURL(url);
  }
}

// ---------- The whole operation ----------

export interface LocalCopyRequest {
  script: StoredScript;
  plan: CopyPlan;
  overwrite: boolean;
}

export interface LocalCopyResult {
  script: ScriptMeta;
  collection: StoredCollection;
  // The absolute path the copy was written at.
  path: string;
}

export const COPY_NOT_FOUND_AFTER_REFRESH =
  'Internal error: the copy was written but the collection did not find it';

// Write the copy (and any dependencies), then make sure the Downloads
// collection exists and has scanned it in. Resolves with the new row.
//
// The first copy ever is the one that learns where Downloads is, so it
// has to write before it can create the collection; every later copy
// finds the setting in place. One order serves both.
export async function makeLocalCopy(request: LocalCopyRequest): Promise<LocalCopyResult> {
  const { script, plan } = request;
  const files = planFiles(script, plan).map((f) => ({
    ...f,
    downloadPath: `${DOWNLOADS_COPIES_SUBDIR}/${f.relativePath}`,
  }));
  // Only for telling a rename apart from a redirect below; the
  // authoritative answer is the path the write itself reports.
  const priorDir = (await readDownloadsCopiesSetting())?.downloadsDir ?? null;

  const written: WrittenFile[] = [];
  let downloadsDir = '';
  try {
    for (const f of files) {
      const one = await downloadOneChecked(f, request.overwrite);
      written.push(one);
      // Every file has to have landed where it was asked to: the script
      // because that is what gets registered, the dependencies because
      // a renamed one is a file the override lookup will never find.
      // The first file is also what teaches us where Downloads is.
      const dir = downloadsDirFromSaved(one.path, f.downloadPath);
      if (!dir || (downloadsDir && dir !== downloadsDir)) {
        throw new Error(savedElsewhere(
          one.path,
          f.downloadPath,
          downloadsDir ? downloadsCopiesDir(downloadsDir)
            : priorDir && downloadsCopiesDir(priorDir),
        ));
      }
      downloadsDir = dir;
    }
  } catch (err) {
    // Nothing is registered, so anything already on disk is a file the
    // user never asked to keep — and a `.user.js` among them would be
    // scanned in as a script on the next refresh.
    await discardWritten(written);
    throw err;
  }

  // The files are on disk; the worker, which alone writes storage,
  // makes them a script (docs/worker-writes.md).
  const registered = await callWorker('registerLocalCopy', downloadsDir, plan.fileName);
  return { ...registered, path: written[0].path };
}

// Worker side of a local copy, once its files are on disk in the
// copies directory under `downloadsDir`: the collection that holds
// them, refreshed so it lists the copy, and the copy turned on.
export async function registerLocalCopy(
  downloadsDir: string,
  fileName: string,
): Promise<{ script: ScriptMeta; collection: StoredCollection }> {
  const collection = await ensureDownloadsCollection(downloadsDir);
  const refreshed = await refreshCollection(collection.id);
  const row = refreshed?.scripts.find((s) => s.relativePath === fileName);
  if (!row) throw new Error(COPY_NOT_FOUND_AFTER_REFRESH);
  // Without its bodies: the page only needs which row it is.
  return { script: withoutBodies(await enableCopy(row)), collection: refreshed?.collection ?? collection };
}

// One file, written and reported. Split out only so `makeLocalCopy`'s
// loop reads as the checks it performs.
async function downloadOneChecked(
  file: { downloadPath: string; body: Blob },
  overwrite: boolean,
): Promise<WrittenFile> {
  return await downloadOne(file.downloadPath, file.body, overwrite);
}

// A copy is meant to be the version that runs, and the caller's
// exclusive-enable sweep only acts on a row that is already running.
// A REPLACED file inherits the row it replaced — including a prior
// `enabled: false`, which `rebuildCollection` deliberately preserves
// across a refresh — so without this, replacing a copy the user had
// switched off would land them on a page with nothing running and no
// explanation. Failing to write it is not worth blocking the copy over:
// the row exists either way, and the page shows its real enable state.
async function enableCopy(row: StoredScript): Promise<StoredScript> {
  if (row.enabled) return row;
  try {
    await setScriptsEnabled([{ id: row.id, enabled: true }]);
    return { ...row, enabled: true };
  } catch (err) {
    dlog(`[SourceMonkey] could not enable the new copy: ${describeError(err)}`);
    return row;
  }
}

function describeChromeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A file that didn't land where it was asked to. Two different things
// happened, and the fix differs, so they are two messages rather than
// one that guesses — see docs/diagnostics.md#wording.
//
// `copiesDir` is what we can compare against: null on the very first
// copy, where the Downloads folder is still unknown and "a different
// folder" is the only thing that can be said.
function savedElsewhere(path: string, asked: string, copiesDir: string | null): string {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (copiesDir && dir === copiesDir) {
    // Chrome renamed around a file that appeared between the dialog's
    // check and the write. The copy is on disk under a name nobody
    // asked for, so it is not registered.
    return `Chrome saved the copy as ${baseName(path)} instead of ${baseName(asked)}, `
      + 'so it was not added as a script. Delete that file, or copy again to replace it.';
  }
  return `The copy was saved to ${path}, outside the collection directory, `
    + 'so it was not added as a script';
}

// The Downloads collection for `downloadsDir`: the one the setting
// names, else one already at that directory (adopted), else a new one.
// Records what it found so the next copy needs no lookup by path.
export async function ensureDownloadsCollection(downloadsDir: string): Promise<StoredCollection> {
  const prior = await readDownloadsCopiesSetting();
  const setting: DownloadsCopiesSetting = { downloadsDir, collectionId: prior?.collectionId ?? null };
  const collections = await getCollections();
  let collection = findDownloadsCollection(setting, collections);
  if (!collection) {
    const created = await createCollection({
      kind: 'location',
      path: downloadsCopiesDir(downloadsDir),
      // The seeded name, unless something already wears it — the
      // collection at the previous Downloads location, say. Then the
      // path-derived name will do; nothing looks this collection up by
      // its name.
      name: collectionNameInUse(DOWNLOADS_COPIES_NAME, collections) ? undefined : DOWNLOADS_COPIES_NAME,
    });
    // `createCollection` answers null for a path that is already a
    // collection — which `findDownloadsCollection` just said there
    // wasn't, so another tab beat us to it. Take theirs.
    collection = created?.kind === 'newCollection'
      ? created.collection
      : findDownloadsCollection(setting, await getCollections());
    if (!collection) throw new Error('Internal error: could not create the Downloads collection');
  }
  if (prior?.downloadsDir !== downloadsDir || prior.collectionId !== collection.id) {
    await writeDownloadsCopiesSetting({ downloadsDir, collectionId: collection.id });
  }
  return collection;
}
