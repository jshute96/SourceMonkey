// Telling locations apart (http, file, container and collection
// paths), path helpers, reading a `file://` URL, and Chrome's `file://`
// directory listings.
//
// The part of directories.ts that loading a script's local files
// needs, in its own module so the development harness can use it
// without the collection scanners and GitHub provider. directories.ts
// re-exports it for its other callers.

import { MANIFEST_FILENAME } from './collection-scan.js';

// ---------- Collection-kind detection ----------

// All collection-kind checks key off the raw input string the user
// typed. `http://` / `https://` selects an HTTP collection; everything
// else is treated as an absolute filesystem path. Suffix tests look at
// the URL pathname (sans query/fragment) so e.g. `…/foo.user.js?v=2`
// still classifies as a single-file URL.

// The shapes a user may type as a location, as a sentence fragment.
// Shared because two validators reject on it — `isValidLocationShape`
// (directories.ts) and the viewer's preview (`isPreviewableInput`) — and their
// messages had already drifted into two different descriptions of one
// rule.
export const LOCATION_SHAPES =
  'must be a URL or absolute file path';

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

export function isFileUrl(input: string): boolean {
  return /^file:\/\//i.test(input);
}

// Container collections hold individually-installed scripts — the
// folder-like collections the user creates and names, plus the three
// built-in defaults. Their stored `path` is a synthetic
// `container:<…>` identifier — not a real URL — and per-script
// `relativePath` carries the full URL/path the user installed. A
// container can mix local, web, and GitHub scripts: there is no scan
// step, refresh iterates the explicit scriptIds list and refetches each
// entry from its own location.
//
// Two spellings of the identifier:
//   - `container:file` / `container:http` / `container:github` — the
//     built-in default for each scheme ("Scripts from local disk" /
//     "…from web" / "…from GitHub"). Created on demand by an install
//     that targets it; recognised by this fixed path, never by name,
//     so a rename doesn't stop it being the default.
//   - `container:<uuid>` — a collection the user created.
export type ContainerKind = 'file' | 'http' | 'github';

const CONTAINER_PATH_PREFIX = 'container:';

// The fixed path of the built-in default container for a scheme.
export function containerPath(kind: ContainerKind): string {
  return CONTAINER_PATH_PREFIX + kind;
}

// A fresh path for a user-created container.
export function newContainerPath(): string {
  return CONTAINER_PATH_PREFIX + crypto.randomUUID();
}

// A collection that is a local folder scanned for `*.user.js` files —
// the kind whose listing is its source of truth, so a file it no
// longer shows is dropped (see `rebuildCollection`). Everything else
// (http(s) and GitHub, a manifest, a single-file container, an import)
// names its scripts some other way.
export function isLocalDirectoryCollection(collectionPath: string): boolean {
  return !isHttpUrl(collectionPath)
    && !isManifestCollection(collectionPath)
    && !isContainerCollection(collectionPath)
    && !isImportCollection(collectionPath);
}

export function isContainerCollection(input: string): boolean {
  return input.startsWith(CONTAINER_PATH_PREFIX);
}

// Which scheme this container is the built-in default for — or null
// for a user-created container (and for anything that isn't a
// container). NOT a restriction on what the container may hold.
export function containerKind(input: string): ContainerKind | null {
  if (input === 'container:file') return 'file';
  if (input === 'container:http') return 'http';
  if (input === 'container:github') return 'github';
  return null;
}

// The three shapes a collection row can take. Derived from the stored
// path rather than persisted, so a row can't disagree with itself. An
// import collection is `scripts`-shaped: its rows were named one at a
// time by the backup, and it has no location of its own.
export type CollectionKind = 'scripts' | 'directory' | 'manifest';

export function collectionKind(path: string): CollectionKind {
  if (isContainerCollection(path) || isImportCollection(path)) return 'scripts';
  if (isManifestCollection(path)) return 'manifest';
  return 'directory';
}

// Import collections hold scripts handed to us in a backup file rather
// than fetched from anywhere. Their stored `path` is `import:<uuid>` —
// a fresh id per import run, so two imports never collide on the
// duplicate-path check and each stands as its own section. Like
// containers they have no scan step; unlike containers their bodies
// have no collection-level upstream, so the collection never refreshes.
// See docs/import-export-tampermonkey.md.
const IMPORT_PATH_PREFIX = 'import:';

export function importCollectionPath(importId: string): string {
  return IMPORT_PATH_PREFIX + importId;
}

export function isImportCollection(input: string): boolean {
  return input.startsWith(IMPORT_PATH_PREFIX) && input.length > IMPORT_PATH_PREFIX.length;
}

// Stand-in `fileUrl` for an imported script with no upstream — one
// that was written or edited inside the other manager and exists
// nowhere else.
//
// Why a synthetic URL rather than an empty string: `fileUrl` is the
// base every `@require` / `@resource` / `@icon` ref resolves against,
// and `new URL(ref, '')` throws even when `ref` is absolute — which
// would take out the ordinary absolute-URL requires these scripts do
// have. A parseable base keeps absolute refs working and makes a
// relative one fail as `unsupported-scheme`, which is the truth: there
// is no directory to resolve it against.
//
// The `imported` host keeps these clear of the `sourcemonkey://
// SourceMonkey/…` URLs the injector emits for devtools (see
// `script-source-url.ts`). Nothing fetches this URL; `isHttpUrl` and
// `isFileUrl` are both false for it, so local-file overrides and
// update probes skip such scripts without needing to know why.
const PINNED_URL_PREFIX = 'sourcemonkey://imported/';

export function pinnedScriptUrl(scriptId: string, filename: string): string {
  return `${PINNED_URL_PREFIX}${encodeURIComponent(scriptId)}/${encodeURIComponent(filename)}`;
}

export function isPinnedScriptUrl(fileUrl: string): boolean {
  return fileUrl.startsWith(PINNED_URL_PREFIX);
}

// Pathname of an http(s) or file:// URL, sans query and fragment.
// Returns '' if the string doesn't parse as a URL — callers gate on
// isHttpUrl / isFileUrl first.
export function urlPathname(input: string): string {
  try {
    return new URL(input).pathname;
  } catch {
    return '';
  }
}

// Pathname for *any* collection-input form (raw filesystem path,
// file:// URL, or http(s):// URL). Used by suffix tests that don't care
// about scheme.
function locationPathname(input: string): string {
  if (isHttpUrl(input) || isFileUrl(input)) return urlPathname(input);
  return input;
}

// Canonical URL form for a collection input. Raw filesystem paths get
// percent-encoded and wrapped as file://; URLs pass through. Used as
// the base for URL.resolution of manifest entries so a local manifest
// can list relative paths the same way an HTTP one can.
export function collectionCanonicalUrl(input: string): string {
  if (isHttpUrl(input) || isFileUrl(input)) return input;
  return pathToFileUrl(input);
}

// Inverse of collectionCanonicalUrl for local inputs: a file:// URL
// turns into the absolute filesystem path it points at; a raw path
// passes through. Lets the local directory/single-file branches accept
// the URL form the user typed without each branch having to
// special-case the parse. Percent-encoded segments (e.g.
// `my%20scripts`) are decoded so downstream path helpers see the
// on-disk name verbatim.
export function locationFsPath(input: string): string {
  if (!isFileUrl(input)) return input;
  try {
    return decodeURIComponent(new URL(input).pathname);
  } catch {
    return input;  // unparseable URL → let the caller's I/O fail with a clearer message
  }
}

// Windows drive-letter (`file:///C:/…`) and UNC (`file://server/…`)
// URLs. `locationFsPath` mangles both — it strips only the leading POSIX
// slash and discards `host` — so the canonicalizer below leaves them
// as URLs rather than producing a path that points somewhere else.
// The rest of the module is POSIX-only by design (see `pathToFileUrl`,
// `parentDir`), so this is containment, not Windows support.
// Exported because the collections page's `?refresh_file=` validator
// has to refuse the same two shapes before comparing paths — a mangled
// path there would silently match the wrong local collection.
export function isNonPosixFileUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  return u.host !== '' || /^\/[A-Za-z]:/.test(u.pathname);
}

// One canonical spelling for a collection input, so every entry point
// agrees on what a given file is called: the collections page's path
// field, an `addCollection` call, and a captured `file://` navigation
// all have to produce the same `relativePath`, or one file on disk ends
// up with two installed rows.
//
// The bare filesystem path is the winner because it is what the path
// field (the oldest and most common route) has always stored. http(s)
// inputs pass through untouched — there is only one spelling of those.
export function canonicalCollectionInput(input: string): string {
  if (!isFileUrl(input) || isNonPosixFileUrl(input)) return input;
  return locationFsPath(input);
}

// True for any input pointing at an individual `.user.js` script —
// http(s):// URL, file:// URL, or absolute local path — based on the
// pathname suffix. Single-script inputs don't get their own collection
// row; the install flow puts them into a container collection (by
// default the one for their scheme — see `containerKindForSingleFileInput`).
export function isSingleFileInput(input: string): boolean {
  return locationPathname(input).endsWith('.user.js');
}

// True for any manifest collection — http(s):// URL, file:// URL, or an
// absolute local path — whose pathname's basename is exactly
// `MANIFEST_FILENAME`. The fixed-filename rule (rather than a generic
// `.json` suffix) keeps unrelated JSON files from being mistaken for
// script manifests and gives the convention a single, searchable name.
export function isManifestCollection(input: string): boolean {
  const p = locationPathname(input);
  return p === MANIFEST_FILENAME
    || p.endsWith('/' + MANIFEST_FILENAME);
}

// ---------- URL / path helpers ----------

// Build a file:// URL from an absolute filesystem path, percent-encoding
// each segment so spaces and other reserved characters produce a valid
// URL. POSIX paths get the conventional `file://` + leading slash.
export function pathToFileUrl(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

export function joinPath(base: string, child: string): string {
  return base.replace(/\/+$/, '') + '/' + child;
}


// Return the parent directory of an absolute POSIX path. The result
// has no trailing slash; for a top-level path like `/foo` returns `/`.
export function parentDir(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return '';
  if (slash === 0) return '/';
  return trimmed.slice(0, slash);
}

// Return the leaf name of an absolute POSIX path (the part after the
// last `/`). Trailing slashes are stripped first.
export function baseName(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

// ---------- Reading a file:// URL ----------

// A `file://` URL's text.
//
// Why XMLHttpRequest in page contexts: fetch() treats
// chrome-extension:// → file:// as cross-origin and returns an opaque
// response (status 0, unreadable body). XHR doesn't apply that
// restriction. For file:// XHRs, `status` stays 0 even on success
// (there's no HTTP layer); a missing file fires `onerror`, while a
// readable file (including a 0-byte one) fires `onload`.
//
// Service-worker fallback: MV3 service workers have no XMLHttpRequest
// at all, so we can't use the XHR path there. fetch() does work from a
// SW for `file://` URLs as long as the manifest grants `file:///*` in
// host_permissions (and the user has flipped "Allow access to file
// URLs") — the cross-origin restriction above is a document-context
// behavior, not a SW one. Node (the harness) takes this path too. We
// pick the path at call time by checking for XHR availability.
export function readFileUrlText(url: string): Promise<string> {
  if (typeof XMLHttpRequest !== 'undefined') return fetchFileUrlTextXhr(url);
  return fetchFileUrlTextFetch(url);
}

// `readFileUrlText`, plus what a listing of the file's folder would
// report for it: its size in bytes and its modified time. One read
// instead of a listing and a read, for a check that knows the file's
// path. `fsMtime` is absent when Chrome sent no `Last-Modified`.
export async function readFileUrlWithStat(
  url: string,
): Promise<{ text: string; size: number; fsMtime?: number }> {
  const { bytes, lastModified } = typeof XMLHttpRequest !== 'undefined'
    ? await fetchFileUrlBytesXhr(url)
    : await fetchFileUrlBytesFetch(url);
  // Decoded as the worker's `response.text()` does: UTF-8, a UTF-8 BOM
  // dropped, bad bytes replaced rather than thrown on. (A page's
  // `responseText` would also detect a UTF-16 BOM; nothing here reads
  // one, and no page calls this today.)
  const text = new TextDecoder().decode(bytes);
  const fsMtime = fsMtimeFromLastModified(lastModified);
  return { text, size: bytes.byteLength, ...(fsMtime !== undefined ? { fsMtime } : {}) };
}

// Chrome gives a `file://` response the file's modified time as
// `Last-Modified`. Its directory listing reports the same time in whole
// seconds, which `Last-Modified` can't be finer than, so dividing gives
// the listing's number exactly. That lets a direct read stand in for
// listing the folder.
export function fsMtimeFromLastModified(header: string | null): number | undefined {
  if (!header) return undefined;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function fetchFileUrlBytesXhr(url: string): Promise<{ bytes: ArrayBuffer; lastModified: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => resolve({
      bytes: (xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0),
      lastModified: xhr.getResponseHeader('last-modified'),
    });
    xhr.onerror = () => reject(new Error(`Could not read ${url}`));
    xhr.send();
  });
}

async function fetchFileUrlBytesFetch(url: string): Promise<{ bytes: ArrayBuffer; lastModified: string | null }> {
  const response = await fetchFileUrlResponse(url);
  return { bytes: await response.arrayBuffer(), lastModified: response.headers.get('last-modified') };
}

function fetchFileUrlTextXhr(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'text';
    // For file:// XHRs status is always 0. A readable file (including
    // a 0-byte one) fires `onload`; a missing file fires `onerror`.
    // Resolve with whatever responseText we got — '' is a valid result
    // for an empty file and must not be conflated with "missing".
    xhr.onload = () => resolve(xhr.responseText ?? '');
    xhr.onerror = () => reject(new Error(`Could not read ${url}`));
    xhr.send();
  });
}

// Service-worker path: fetch() works for file:// URLs when the SW has
// the matching host permission. `response.ok` is true for file://
// fetches that succeed (Chrome synthesises status 200); a 404-style
// missing file shows up as a fetch rejection or response.ok === false,
// not a thrown exception with a specific status code, so we have to
// inspect both.
async function fetchFileUrlTextFetch(url: string): Promise<string> {
  // An empty body here is a 0-byte file, not an error — keep it
  // distinct from "missing" so the row renders Size=0 Status=ERROR
  // (no metadata block) rather than getting flagged as gone.
  return await (await fetchFileUrlResponse(url)).text();
}

// The worker's `file://` response, once it is known to have read. Shared
// by the text and byte readers, so a failure reads the same from both.
async function fetchFileUrlResponse(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`Could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok && response.status !== 0) {
    throw new Error(`Could not read ${url}: HTTP ${response.status}`);
  }
  // Opaque responses (response.type === 'opaque') have an unreadable
  // body; surface a distinct error rather than returning empty content,
  // so a manual refresh from a page context can succeed where the SW
  // path fell through.
  if (response.type === 'opaque') {
    throw new Error(
      `Could not read ${url} in background refresh (file:// fetch is not permitted there). ` +
      `Try Refresh from the script page.`,
    );
  }
  return response;
}

// ---------- Directory listing parser ----------

export interface ListingEntry {
  name: string;
  isDir: boolean;
  size?: number;     // bytes; undefined if the listing didn't supply it
  mtime?: number;    // opaque modification-time integer for equality only
}

// Chrome's file:// directory listing is an HTML page that injects
// entries via JavaScript calls like:
//   addRow("name", "url", isdir, size, "size_str", date, "date_str")
// where `isdir` is 0/1 (older Chrome) or true/false. We pull:
//   - the name (first arg) and the isdir flag (third) to classify;
//   - the numeric size (fourth) and date (sixth) so the refresh
//     pipeline can skip refetching files whose size+mtime are
//     unchanged.
//
// This is intentionally tolerant: Chrome's exact listing format isn't
// a stable contract, so the regex matches the common shape and ignores
// any addRow calls it can't parse. The size/mtime captures are
// optional — entries without them parse but with size/mtime undefined,
// at which point the refresh pipeline falls back to always-refetch
// for those files.
//
// An empty result is ambiguous on its own — a listing with no rows, or
// a page that isn't a listing at all — which is why `listDirectory`
// checks `isDirectoryListing` first.
export function parseListing(html: string): ListingEntry[] {
  const entries: ListingEntry[] = [];
  const re = /addRow\("((?:\\.|[^"\\])*)"\s*,\s*"(?:\\.|[^"\\])*"\s*,\s*(0|1|true|false)\b(?:\s*,\s*(-?\d+))?(?:\s*,\s*"(?:\\.|[^"\\])*")?(?:\s*,\s*(-?\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let name: string;
    try {
      // The captured first argument is a JS string literal body —
      // JSON.parse round-trips the standard \" \\ \n \uXXXX escapes.
      name = JSON.parse('"' + m[1] + '"');
    } catch {
      continue;
    }
    if (name === '..' || name === '.') continue;
    const isDir = m[2] === '1' || m[2] === 'true';
    const entry: ListingEntry = { name, isDir };
    if (m[3] !== undefined) entry.size = Number(m[3]);
    if (m[4] !== undefined) entry.mtime = Number(m[4]);
    entries.push(entry);
  }
  return entries;
}

// Listings shared by one batch of refreshes, keyed by absolute
// directory path. Keyed on the promise rather than the result so
// concurrent listers of the same directory join one fetch instead of
// starting a second before the first resolves.
//
// `readonly` on the entries because the array is handed out by
// reference to every sibling in the batch. Today's only consumer just
// reads `size`/`mtime`, but nothing else would stop a future one from
// sorting or splicing it out from under the others — this makes that a
// type error rather than a silent corruption.
//
// **Batch-scoped, never global.** There is no invalidation here and no
// TTL: a cache is created for one fan-out and dropped when it ends, so
// every entry describes the directory as of that batch. A cache that
// outlived its batch would hand a later refresh a stale size/mtime and
// make it skip a file that had actually changed.
export type DirectoryListingCache = Map<string, Promise<readonly ListingEntry[]>>;

// How many directory listings this JS context has fetched SUCCESSFULLY
// since the last reset. Scoped and counted narrowly on purpose:
//
//   - Per-context, not global. This module is imported by the
//     extension pages too, and a check that runs in the page that
//     clicked never touches the worker's copy of this number.
//   - Every listing the context does, not just batched ones — the
//     recursive `scanForUserScripts` walk and collection refreshes land
//     here too, so a test has to reset around the window it cares about.
//   - Cache hits don't count, which is the point: it is the number a
//     test asserts on to show a batch shared one listing rather than
//     doing N.
//
// Exposed through the SW test surface (see src/extension/background.ts).
let listingFetches = 0;
export function getDirectoryListingFetches(): number {
  return listingFetches;
}
export function resetDirectoryListingFetches(): void {
  listingFetches = 0;
}

// Is this page Chrome's directory listing at all? The listing page
// opens with a `start("<path>")` call before any rows, and an empty
// directory still has that. Anything without it — an error page, a
// path that is now a file, a format Chrome changed under us — is
// refused rather than read as "no entries", because those two answers
// have opposite consequences for a refresh: an empty listing drops
// every script in the collection, a failed one leaves them all alone.
export function isDirectoryListing(html: string): boolean {
  return /\bstart\s*\(\s*"/.test(html);
}

export const NOT_A_DIRECTORY_LISTING = 'Chrome did not return a directory listing for this folder';

export async function listDirectory(
  absolutePath: string,
  cache?: DirectoryListingCache,
): Promise<readonly ListingEntry[]> {
  const hit = cache?.get(absolutePath);
  if (hit) return hit;
  const pending = (async () => {
    // Chrome only serves the directory listing for URLs ending with `/`.
    const url = pathToFileUrl(absolutePath) + '/';
    const html = await readFileUrlText(url);
    if (!isDirectoryListing(html)) {
      throw new Error(`Could not read ${url}: ${NOT_A_DIRECTORY_LISTING}`);
    }
    const entries = parseListing(html);
    // Counted after the fetch resolves, so the number means what its
    // name says. A throw leaves it alone.
    listingFetches += 1;
    return entries;
  })();
  if (cache) {
    cache.set(absolutePath, pending);
    // A failed listing must not be remembered. Otherwise one transient
    // read error is inherited by every later sibling in the batch, none
    // of which ever retries — turning a single script's bad luck into
    // the whole page refetching bodies it didn't need to. (Safe either
    // way: `refreshScript` catches, leaving the scan bare, which means
    // always-fetch. The cost is wasted reads, never a missed change.)
    // The identity check keeps a late rejection from evicting a newer
    // entry that has already replaced it.
    void pending.catch(() => {
      if (cache.get(absolutePath) === pending) cache.delete(absolutePath);
    });
  }
  return pending;
}

// Whether `cache` already holds a listing for this directory — i.e.
// whether the next `statFromListing` will pay for a fetch. Read by the
// refresh path's phase timer so a shared listing shows up as a shared
// listing rather than as a phase that mysteriously got fast.
export function hasCachedListing(
  cache: DirectoryListingCache | undefined,
  absoluteDir: string,
): boolean {
  return cache?.has(absoluteDir) ?? false;
}

// Targeted version of listDirectory: list a single directory and return
// just the entry for `fileName` (or null if absent). Used by the
// single-file refresh path so it can capture the file's current
// size/mtime without doing a full recursive scan — keeps the
// unchanged-file skip honest for the next Refresh All.
//
// `cache` is optional and batch-scoped: a navigation's fan-out passes
// one so N scripts in the same folder list it once between them.
export async function statFromListing(
  absoluteDir: string,
  fileName: string,
  cache?: DirectoryListingCache,
): Promise<ListingEntry | null> {
  const entries = await listDirectory(absoluteDir, cache);
  return entries.find((e) => e.name === fileName) ?? null;
}
