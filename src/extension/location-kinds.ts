// Pure naming helpers for script and collection locations, split from
// directories.ts so pages that only label locations (the toolbar popup,
// via collection-display.ts) don't load the scanning and fetch code.
// directories.ts re-exports all of it.

import { isHttpUrl, type ContainerKind } from '../file-locations.js';

// Classify a script location by scheme: which built-in default
// container it would install into, and which scheme chip its row wears
// inside a container. github URLs here mean both the human-facing
// `github.com/...` form and the already-normalized
// `raw.githubusercontent.com/...` form, since `normalizeCollectionInput`
// may have rewritten the input before this runs.
export function containerKindForSingleFileInput(input: string): ContainerKind {
  if (/^https?:\/\/(www\.)?github\.com\//i.test(input)) return 'github';
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(input)) return 'github';
  if (isHttpUrl(input)) return 'http';
  return 'file';
}

// ---------- Scratch scripts ----------
//
// A script whose only copy is its text in extension storage, with no
// file or URL behind it. Only sm-dev, the development tool, writes
// them, over the worker's test surface (docs/sm-dev-design.md).
//
// - Each sm-dev run has its own collection of them, its test
//   collection, at `container:sm-dev:<run>`, where `<run>` is the run's
//   unique id.
// - Each "location" is a `scratch:///<run>/<path>.user.js` URL that
//   names the storage row holding the text, so the ordinary refresh
//   pipeline reads it back like any other body and a rewrite of the
//   same name is picked up as a content change.
// - The run in the URL is what lets the script run: only in tabs that
//   run's claim holds (sm-dev-link.ts).

const SM_DEV_CONTAINER_PREFIX = 'container:sm-dev:';
// Three slashes: with an empty host the run and name are the URL's
// path, so the basename every label is cut from is the script's own
// name rather than the whole URL.
const SCRATCH_SCHEME = 'scratch:///';
export const SCRATCH_TEXT_KEY_PREFIX = 'scratch:';
export const SCRATCH_FILES_KEY_PREFIX = 'scratchFiles:';
export const SCRATCH_SOURCE_KEY_PREFIX = 'scratchSource:';

// Kept to a URL path segment's safe characters.
function safeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function isScratchUrl(input: string): boolean {
  return input.startsWith(SCRATCH_SCHEME);
}

// The location for run `run`'s scratch script called `name`: a name,
// or the path sm-dev was given, relative or absolute, kept whole so
// two files of the same name stay apart. Ends in `.user.js` so every
// "is this a script" check reads it as one, and so its basename labels
// it in the viewer and the logs.
//
// Its segments are percent-encoded, as a file:// URL's would be, so the
// name reads back as written wherever it is shown decoded (the viewer,
// stack lines): `My%20Script.user.js` stays that, not `My-20Script`.
export function scratchUrl(run: string, name: string): string {
  const segments = name.split('/').map(encodeSegment);
  const base = (segments.pop() ?? '').replace(/\.user\.js$/i, '') || 'script';
  return `${SCRATCH_SCHEME}${safeSegment(run)}/${[...segments, `${base}.user.js`].join('/')}`;
}

// One URL path segment, percent-encoded. A lone surrogate has no
// encoding (encodeURIComponent throws on it), so it becomes U+FFFD, as
// a decoder would show it.
function encodeSegment(text: string): string {
  return encodeURIComponent(text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'));
}

// The run a scratch script belongs to. Null for a script that isn't one.
export function scratchRunOf(url: string): string | null {
  if (!isScratchUrl(url)) return null;
  const rest = url.slice(SCRATCH_SCHEME.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? '' : rest.slice(0, slash);
}

export function scratchTextKey(url: string): string {
  return SCRATCH_TEXT_KEY_PREFIX + url;
}

// The storage row holding the `@require` / `@resource` bodies sm-dev
// pushed with a scratch script: the ones it read from disk, which the
// extension couldn't (see `PushedFile` in external-files.ts).
export function scratchFilesKey(url: string): string {
  return SCRATCH_FILES_KEY_PREFIX + url;
}

// The storage row naming the file on the developer's disk a scratch
// script came from (`ScratchSource`), for sm-dev's `script list`.
export function scratchSourceKey(url: string): string {
  return SCRATCH_SOURCE_KEY_PREFIX + url;
}

/** Where a scratch script came from, as sm-dev pushed it. */
export interface ScratchSource {
  /** Its file's absolute `file://` URL. */
  fileUrl: string;
  /** Its path as the run was given it, often relative to where the run started. */
  given: string;
}

// The path of run `run`'s test collection.
export function smDevContainerPath(run: string): string {
  return SM_DEV_CONTAINER_PREFIX + safeSegment(run);
}

// An sm-dev test collection, which only its run changes: no script is
// moved into or out of one, or installed into one, by hand.
export function isSmDevCollection(path: string): boolean {
  return smDevRunOfContainer(path) !== null;
}

// The run a test collection belongs to, or null for any other
// collection.
export function smDevRunOfContainer(path: string): string | null {
  return path.startsWith(SM_DEV_CONTAINER_PREFIX) ? path.slice(SM_DEV_CONTAINER_PREFIX.length) : null;
}

// ---------- Imported scripts ----------
//
// A script brought in from a backup file with no location to load it
// from, or kept as the file had it (docs/import.md). The scratch
// mechanism with a second owner: its text is a storage row read back
// by the fetcher, and its `@require` / `@resource` bodies from the file
// are pushed files, under the same keys (`scratchTextKey`,
// `scratchFilesKey`). Unlike a scratch script it belongs to no run, so
// it runs everywhere, and it sits in an ordinary scripts collection.
//
// - Its location is `imported:///<tag>/<name>.user.js`, where `<tag>`
//   is random, so two imports of one name don't share a text row.
// - `importInfoKey` names a row saying where it came from.

const IMPORTED_SCHEME = 'imported:///';
export const IMPORT_INFO_KEY_PREFIX = 'importInfo:';

export function isImportedUrl(input: string): boolean {
  return input.startsWith(IMPORTED_SCHEME);
}

// A script whose only copy is its text in storage: a scratch script or
// an imported one.
export function isStoredTextUrl(input: string): boolean {
  return isScratchUrl(input) || isImportedUrl(input);
}

// A new location for an imported script called `name`.
export function importedUrl(name: string): string {
  const tag = crypto.randomUUID().slice(0, 8);
  return `${IMPORTED_SCHEME}${tag}/${encodeSegment(name.replace(/\.user\.js$/i, '') || 'script')}.user.js`;
}

export function importInfoKey(url: string): string {
  return IMPORT_INFO_KEY_PREFIX + url;
}

// Which manager wrote the file a script was imported from.
export type ImportSource = 'tampermonkey' | 'violentmonkey' | 'sourcemonkey' | 'other';

/** Where an imported script came from (`importInfoKey`). */
export interface ImportInfo {
  source: ImportSource;
  /** When it was imported, in ms. */
  importedAt: number;
  /** The id the file gave it: the other manager's, or SourceMonkey's. */
  foreignId?: string;
  /** Where it loaded from before, when the file said: a URL or a file path. */
  location?: string;
}

export type ScriptSchemeKind = ContainerKind | 'scratch' | 'imported';

// The scheme chip's kind for a container script: where it came from.
// A scratch or imported script has no location; its only copy is in
// storage.
export function scriptSchemeKind(location: string): ScriptSchemeKind {
  if (isScratchUrl(location)) return 'scratch';
  if (isImportedUrl(location)) return 'imported';
  return containerKindForSingleFileInput(location);
}
