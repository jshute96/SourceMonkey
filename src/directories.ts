// Collection I/O: fetch + scan for every collection kind.
//
// Owns: path → URL conversion, content fetch, listing parsers, and the
// scanner that turns a collection path/URL into a list of FoundScript
// entries. All persistence lives in `src/script-store.ts`; this module
// is pure I/O.
//
// The following collection kinds all flow through the same downstream
// pipeline:
//   - local directory   (an absolute filesystem path; recursive scan)
//   - local single file (an absolute path ending in .user.js)
//   - http single file  (an http(s) URL whose pathname ends in .user.js)
//   - manifest          (anything whose pathname's basename is
//                        `script_manifest.json` — an absolute local
//                        path, a file:// URL, or an http(s) URL —
//                        returning a JSON list of script URLs that
//                        resolve against the manifest URL. The exact
//                        filename is the only manifest shape we accept.)
//
// Why XMLHttpRequest in page contexts (for file://): fetch() treats
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
// behavior, not a SW one. We pick the path at call time by checking
// for XHR availability.
//
// HTTP requirements:
//   - manifest: "<all_urls>" (or a narrower http(s) pattern) in
//     host_permissions so the SW/collections page can fetch arbitrary
//     origins without CORS blocking the response body.
//
// File requirements:
//   - manifest: "file:///*" in host_permissions
//   - user: enabled "Allow access to file URLs" on chrome://extensions
// The toggle is persistent across browser sessions, so unlike the File
// System Access API there is no per-session re-grant.

export type { FoundScript } from './collection-scan.js';
import { type FoundScript, MAX_SCAN_DEPTH, MANIFEST_FILENAME } from './collection-scan.js';
import { mapWithConcurrency, SCAN_DIRS_CONCURRENCY } from './concurrency.js';
export { MAX_SCAN_DEPTH } from './collection-scan.js';

// ---------- Collection-kind detection ----------

// All collection-kind checks key off the raw input string the user
// typed. `http://` / `https://` selects an HTTP collection; everything
// else is treated as an absolute filesystem path. Suffix tests look at
// the URL pathname (sans query/fragment) so e.g. `…/foo.user.js?v=2`
// still classifies as a single-file URL.

// The shapes a user may type as a location, as a sentence fragment.
// Shared because two validators reject on it — the collections page's
// Add field (`isValidCollectionInput`) and the viewer's preview
// (`isPreviewableInput`) — and their messages had already drifted into
// two different descriptions of one rule.
export const LOCATION_SHAPES =
  'must be an http(s):// or file:// URL, or an absolute path starting with /';

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

export function isFileUrl(input: string): boolean {
  return /^file:\/\//i.test(input);
}

// Container collections aggregate individually-added scripts of one
// kind (local files, web URLs, GitHub URLs). Their stored `path` is one
// of the synthetic identifiers below — not a real URL — and per-script
// `relativePath` carries the full URL/path the user added. There is no
// scan step for a container collection; refresh iterates the explicit
// scriptIds list and refetches each entry.
export type ContainerKind = 'file' | 'http' | 'github';

const CONTAINER_PATH_PREFIX = 'container:';

export function containerPath(kind: ContainerKind): string {
  return CONTAINER_PATH_PREFIX + kind;
}

export function isContainerCollection(input: string): boolean {
  return containerKind(input) !== null;
}

export function containerKind(input: string): ContainerKind | null {
  if (input === 'container:file') return 'file';
  if (input === 'container:http') return 'http';
  if (input === 'container:github') return 'github';
  return null;
}

// Pathname of an http(s) or file:// URL, sans query and fragment.
// Returns '' if the string doesn't parse as a URL — callers gate on
// isHttpUrl / isFileUrl first.
function urlPathname(input: string): string {
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
// pathname suffix. Single-script inputs no longer get their own
// collection row; the add flow routes them into the matching container
// collection (see `containerKindForSingleFileInput`).
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

// Classify a single-file input string by container kind. Callers that
// have already verified the input passes `isSingleFileInput` use this
// to pick which container collection the script gets added to. github
// URLs here mean both the human-facing `github.com/...` form and the
// already-normalized `raw.githubusercontent.com/...` form, since
// `normalizeCollectionInput` may have rewritten the input before this
// runs.
export function containerKindForSingleFileInput(input: string): ContainerKind {
  if (/^https?:\/\/(www\.)?github\.com\//i.test(input)) return 'github';
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(input)) return 'github';
  if (isHttpUrl(input)) return 'http';
  return 'file';
}

// GitHub-specific collection handling lives in `github-provider.ts`. We
// re-export only the symbols `script-store.ts` and `options.ts` use
// directly. Callers always go through `normalizeCollectionInput`; today
// that's just `normalizeGithubInput` under its public name, but
// keeping the public name generic lets future providers slot in
// without changing the callers.
export { isGithubDirCollection } from './github-provider.js';
export { normalizeGithubInput as normalizeCollectionInput } from './github-provider.js';
import {
  githubDirScriptFileUrl,
  githubDirScriptDisplayUrl,
  githubRawToBlobUrl,
  isGithubDirCollection,
  scanGithubDir,
} from './github-provider.js';
export { githubRawToBlobUrl } from './github-provider.js';
import { githubAuthHeaders } from './github-auth.js';
import { decodeForDisplay, leafName } from './script-display.js';
import { mustHopToWorker, readHttpViaWorker } from './http-read.js';
import {
  MarkupResponseError,
  isMarkupContentType,
  looksLikeMarkup,
  markupResponseMessage,
} from './markup-response.js';

// Leaf name (last path segment) of an http(s) URL, percent-decoded —
// used as the FoundScript.name for HTTP manifest entries so the
// collections page shows "foo.user.js" rather than the whole URL.
// Returns '' for anything that doesn't parse as a URL, which callers
// use as their "fall back to the raw entry" signal.
export function urlBaseName(input: string): string {
  return decodeForDisplay(leafName(urlPathname(input)));
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

// ---------- File / directory fetch ----------

export function fetchFileUrlText(url: string): Promise<string> {
  if (typeof XMLHttpRequest !== 'undefined') return fetchFileUrlTextXhr(url);
  return fetchFileUrlTextFetch(url);
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
      `Could not read ${url} in background refresh (file:// fetch is not permitted there) — ` +
      `try Refresh from the script page`,
    );
  }
  // An empty body here is a 0-byte file, not an error — keep it
  // distinct from "missing" so the row renders Size=0 Status=ERROR
  // (no metadata block) rather than getting flagged as gone.
  return await response.text();
}

// `fetchFileUrlText` for text that is about to be treated as a script.
//
// The markup guard can't live in `fetchFileUrlText` itself: among its
// other callers is the one that reads Chrome's `file://` directory
// listing, which is HTML *by design* (`parseListing`). So the two
// script-body call sites — the refresh pipeline and the preview —
// share this wrapper instead.
//
// What it catches locally: an `.user.js` path that is really a
// directory (Chrome answers with a generated listing), and an HTML
// file that got the suffix by mistake. The `file://` legs often report
// no Content-Type at all, so the body test is the only one available.
export async function fetchScriptFileUrlText(url: string): Promise<string> {
  const text = await fetchFileUrlText(url);
  if (looksLikeMarkup(text)) {
    // No `Could not read ${url}: ` prefix, unlike its siblings here:
    // the local wording already names the file, and the prefix would
    // print the same URL twice in one sentence.
    throw new MarkupResponseError(markupResponseMessage({ localUrl: url }));
  }
  return text;
}

// Best-effort "does the path point to a readable file" probe. Used to
// turn the otherwise-cryptic "Could not read …/" message into a
// clearer one when the user types a path to an existing non-userscript
// file. Returns false on any error (including non-existence and
// permission failures) — callers should only rely on a true result.
async function isReadableFile(absolutePath: string): Promise<boolean> {
  try {
    await fetchFileUrlText(pathToFileUrl(absolutePath));
    return true;
  } catch {
    return false;
  }
}

// ---------- HTTP fetch (with conditional GETs) ----------

export interface HttpFetchOptions {
  etag?: string;          // last-seen ETag — sent as If-None-Match
  lastModified?: string;  // last-seen Last-Modified — sent as If-Modified-Since
  expects?: HttpFetchExpects;  // defaults to JavaScript — see the type
}

export type HttpFetchResult =
  | { kind: 'ok'; text: string; etag?: string; lastModified?: string }
  | { kind: 'unchanged' };  // 304

// What the caller is going to do with the bytes, for the one message
// that has to name it: this fetcher reads both script bodies and
// collection manifests, and "not JavaScript" is the wrong complaint
// about a manifest.
export type HttpFetchExpects = 'JavaScript' | 'JSON';

// Fetch an http(s) URL, optionally with conditional headers. A 304
// response surfaces as `{kind: 'unchanged'}` so callers can preserve
// the prior content without re-parsing. We use `cache: 'no-store'`
// because we maintain our own validators (etag / lastModified) on each
// script row — the browser HTTP cache would otherwise serve a stale
// 200 without ever asking the server.
export async function fetchHttpText(
  url: string,
  opts: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const headers: Record<string, string> = {};
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

  // Page contexts hand the read to the service worker: a document that
  // fetches for itself acts on the response's `Link: rel=preload`
  // headers, and a login page — the case the markup check below exists
  // for — is exactly the kind of response that sends them. See
  // src/http-read.ts.
  if (mustHopToWorker()) {
    const reply = await readHttpViaWorker({ url, as: 'text', headers });
    if (reply) {
      if (reply.kind === 'error') {
        throw new Error(`Could not read ${url}: ${reply.message ?? reply.reason}`);
      }
      return interpretHttpText(url, opts, {
        status: reply.status,
        contentType: reply.contentType,
        etag: reply.etag,
        lastModified: reply.lastModified,
        text: reply.text ?? '',
      });
    }
    // No answer at all (worker evicted mid-message, extension
    // reloading). Falling through reads it here, which beats failing a
    // read the user asked for.
  }

  // Attach the configured GitHub token when the URL targets a GitHub
  // host. No-op for any other URL. Lets private-repo raw URLs and
  // private repo manifests fetch under auth without each call site
  // having to opt in. Header host-gating is enforced inside
  // githubAuthHeaders so a token can never be leaked to a non-GitHub
  // host. (Over the hop the worker attaches the same headers from its
  // own copy of the token, so it never rides on a message.)
  Object.assign(headers, githubAuthHeaders(url));

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', headers });
  } catch (err) {
    throw new Error(`Could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 304) return { kind: 'unchanged' };
  return interpretHttpText(url, opts, {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    etag: response.headers.get('ETag'),
    lastModified: response.headers.get('Last-Modified'),
    text: await response.text(),
  });
}

// What the response MEANS, applied identically to a response we read
// here and to one the worker read for us — so the two paths can't come
// to disagree about which statuses fail or which bodies are markup.
//
// A 304 never reaches here from the local path (it has no body to
// read); over the hop it arrives as an ordinary status and is answered
// the same way.
function interpretHttpText(
  url: string,
  opts: HttpFetchOptions,
  res: {
    status: number;
    contentType: string;
    etag: string | null;
    lastModified: string | null;
    text: string;
  },
): HttpFetchResult {
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status < 200 || res.status > 299) {
    throw new Error(`Could not read ${url}: HTTP ${res.status}`);
  }
  // Every caller of this treats the result as JavaScript (a script
  // body) or JSON (a manifest); neither can be markup. Rejecting here
  // rather than letting it through is what keeps a refresh that lands
  // on a login page from replacing a working script with a page of
  // HTML — a fetch failure preserves the prior copy, a "successful"
  // fetch of garbage does not.
  //
  // The header is quoted verbatim, not lowercased: it is evidence, and
  // evidence should read as what the server actually sent.
  const markupHeader = isMarkupContentType(res.contentType);
  if (markupHeader || looksLikeMarkup(res.text)) {
    throw new MarkupResponseError(
      `Could not read ${url}: ${markupResponseMessage({
        ...(markupHeader ? { contentType: res.contentType } : {}),
        expected: opts.expects ?? 'JavaScript',
      })}`,
    );
  }
  const result: HttpFetchResult = { kind: 'ok', text: res.text };
  if (res.etag) result.etag = res.etag;
  if (res.lastModified) result.lastModified = res.lastModified;
  return result;
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
//   - Per-context, not global. `directories.ts` is imported by the
//     extension pages too, and a check that runs in the page that
//     clicked never touches the worker's copy of this number.
//   - Every listing the context does, not just batched ones — the
//     recursive `scanForUserScripts` walk and collection refreshes land
//     here too, so a test has to reset around the window it cares about.
//   - Cache hits don't count, which is the point: it is the number a
//     test asserts on to show a batch shared one listing rather than
//     doing N.
//
// Exposed through the SW test surface (see src/background.ts).
let listingFetches = 0;
export function getDirectoryListingFetches(): number {
  return listingFetches;
}
export function resetDirectoryListingFetches(): void {
  listingFetches = 0;
}

async function listDirectory(
  absolutePath: string,
  cache?: DirectoryListingCache,
): Promise<readonly ListingEntry[]> {
  const hit = cache?.get(absolutePath);
  if (hit) return hit;
  const pending = (async () => {
    // Chrome only serves the directory listing for URLs ending with `/`.
    const url = pathToFileUrl(absolutePath) + '/';
    const entries = parseListing(await fetchFileUrlText(url));
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

// ---------- Scanning ----------

// Parse a manifest body. Accepts either a bare JSON array or
// `{scripts: [...]}`. Anything else is rejected with a message that
// points at the supported shapes. Empty strings inside the list are
// dropped so a trailing newline / typo doesn't fail the whole source.
//
// List elements are either a URL string or an object with a `path`
// holding that string. The object form lets a manifest carry extra
// per-script bookkeeping (author's notes, tags, …) alongside the URL;
// every field other than `path` is ignored here, so unknown keys are
// forward-compatible rather than an error.
export function parseManifest(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { scripts?: unknown }).scripts)) {
    arr = (parsed as { scripts: unknown[] }).scripts;
  } else {
    throw new Error('Manifest must be a JSON array of entries, or `{"scripts": [...]}`');
  }
  const entries: string[] = [];
  for (const item of arr as unknown[]) {
    let value: string;
    if (typeof item === 'string') {
      value = item;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      // An array is also `typeof 'object'`, hence the isArray guard —
      // otherwise `[["a.user.js"]]` would look for a `path` field on it.
      const entryPath = (item as { path?: unknown }).path;
      if (typeof entryPath !== 'string') {
        throw new Error('Manifest entry objects must have a "path" string');
      }
      value = entryPath;
    } else {
      throw new Error('Manifest entries must all be URL strings or objects with a "path"');
    }
    const trimmed = value.trim();
    if (trimmed) entries.push(trimmed);
  }
  return entries;
}

export async function scanForUserScripts(
  absolutePath: string,
  depth = 0,
  prefix = '',
): Promise<FoundScript[]> {
  // Collection-kind dispatch. Container collections don't have a
  // scannable backing store — refreshCollection builds a synthetic scan
  // from the existing scriptIds and never calls this for them. The
  // remaining branches are scheme-agnostic (raw path / file:// /
  // http(s):// handled uniformly); local directory is the only branch
  // that rejects HTTP, because there's no remote listing API.
  if (depth === 0) {
    if (isContainerCollection(absolutePath)) {
      throw new Error(
        'Internal error: this input kind is refreshed directly, not scanned',
      );
    }
    if (isManifestCollection(absolutePath)) {
      return scanManifest(collectionCanonicalUrl(absolutePath));
    }
    if (isGithubDirCollection(absolutePath)) {
      return scanGithubDir(absolutePath);
    }
    if (isHttpUrl(absolutePath)) {
      // No mention of "container collections": that's how we store a
      // stand-alone script, and the reader adding a URL has no name for
      // it — from the page it just looks like adding the script itself.
      // Ends with what to do, per the "name the fix" rule; the reader
      // is standing at the Add field that produced this.
      throw new Error(
        `This URL is neither a folder (use a github tree URL) nor a ${MANIFEST_FILENAME} — ` +
        'to install a single script, paste the URL of the .user.js file itself',
      );
    }
    // Local-directory only. Normalise file:// → raw path once so the
    // downstream listing + recursion all see a single form.
    absolutePath = locationFsPath(absolutePath);
  }
  // `readonly` because a listing can be batch-shared — see
  // `DirectoryListingCache`. The scan only reads it.
  let entries: readonly ListingEntry[];
  try {
    entries = await listDirectory(absolutePath);
  } catch (err) {
    // Common foot-gun at the top level: the user types a path to a file
    // whose name doesn't end with `.user.js` (e.g. `notes.md`). The
    // listing fetch above asks Chrome for `file://…/notes.md/`, which
    // produces an opaque "could not read" message. Probe by reading the
    // path as a plain file; if that succeeds we know the path exists
    // but isn't a userscript, so swap in a clearer message.
    if (depth === 0 && await isReadableFile(absolutePath)) {
      throw new Error(
        `${absolutePath} is a file, not a folder, and its name doesn't end in .user.js`,
      );
    }
    throw err;
  }
  const results: FoundScript[] = [];
  const subdirs: ListingEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDir && entry.name.endsWith('.user.js')) {
      const found: FoundScript = { name: entry.name, relativePath: prefix + entry.name };
      if (entry.size !== undefined) found.size = entry.size;
      if (entry.mtime !== undefined) found.mtime = entry.mtime;
      results.push(found);
    } else if (entry.isDir && depth < MAX_SCAN_DEPTH) {
      subdirs.push(entry);
    }
  }
  // Sibling directories are independent, so they are listed together
  // rather than one after another. This used to be an `await` inside the
  // loop, which made the scan cost one round trip per directory however
  // shallow the tree — the dominant phase of a refresh once the other
  // fan-outs were fixed.
  //
  // Rejection still fails the whole scan, as it did: the caller turns
  // that into the collection's `scanError`, and a listing we couldn't
  // read means we don't know what's there.
  const nested = await mapWithConcurrency(
    subdirs, SCAN_DIRS_CONCURRENCY,
    (entry) => scanForUserScripts(
      joinPath(absolutePath, entry.name),
      depth + 1,
      prefix + entry.name + '/',
    ),
  );
  for (const sub of nested) results.push(...sub);
  // Sorted here, so the concurrent walk above can finish in any order
  // without changing what the caller sees.
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

// ---------- Per-collection-kind scanners ----------

// Scheme-aware text fetcher used for the manifest body. Per-entry
// fetches (with their own per-scheme dispatch and conditional-GET
// handling) live in script-store.ts; this helper only needs to read
// a body, not negotiate freshness.
async function fetchManifestText(canonicalUrl: string): Promise<string> {
  if (isHttpUrl(canonicalUrl)) {
    const fetched = await fetchHttpText(canonicalUrl, { expects: 'JSON' });
    if (fetched.kind !== 'ok') {
      // Unreachable in practice: this call sends no conditional-GET
      // headers, so `fetchHttpText` can only answer `ok` or throw.
      throw new Error(`Internal error: unexpected result reading the manifest (${fetched.kind})`);
    }
    return fetched.text;
  }
  // file:// URLs (the only other scheme we accept here — pathToFileUrl
  // wrapped any raw path before reaching us).
  return await fetchFileUrlText(canonicalUrl);
}

// Fetch the manifest and turn each listed entry into a FoundScript.
// Works for any manifest scheme — http(s):// or file:// — because both
// share `new URL(entry, base)` resolution semantics and the only piece
// that differs is the manifest-body fetch.
//
// `relativePath` stores the raw entry (typically a bare filename for
// relative cases) so it survives across refreshes for stable
// per-script IDs; the per-entry fetcher resolves it back to an
// absolute URL via scriptFileUrl. Duplicate entries collapse to the
// first occurrence — the manifest is the user's source of truth, so
// we treat dupes as a harmless typo rather than an error.
//
// The manifest body itself is re-downloaded every refresh (no
// If-None-Match round-trip on the manifest URL). The per-script fetches
// still 304 individually, so the bandwidth cost is bounded. See TODO.md
// "HTTP collections — follow-ups" for the planned fix. Schemes a
// manifest entry's *resolved* URL is allowed to use. We mirror the
// suffix-test policy on the collection URL itself (which only accepts
// http(s) / file: / raw path): a manifest the user added shouldn't be
// able to escalate the SW's `<all_urls>` reach into things like `data:`
// (arbitrary inline content), `chrome-extension:` (cross-extension
// probing), or `blob:` (off-origin smuggling). The user can always add
// such collections directly if they want them.
const ALLOWED_ENTRY_SCHEMES = new Set(['http:', 'https:', 'file:']);

// Resolve a manifest entry against the manifest's canonical URL.
//
// On top of plain RFC 3986 resolution, if the entry doesn't bring its
// own query string and lands in the same origin as the manifest, the
// manifest's query string is propagated onto the resolved URL. This
// lets a single auth-bearing manifest URL (e.g. GitHub's
// `…/script_manifest.json?token=…`) reach its companion scripts
// without each manifest entry having to repeat the token. Cross-origin
// or self-querying entries are left alone — the propagation rule only
// fires when the entry is clearly "another file alongside the
// manifest". Throws on a malformed entry; the caller layers
// scheme-gating on top.
export function resolveManifestEntryUrl(entry: string, canonicalUrl: string): URL {
  const base = new URL(canonicalUrl);
  let resolved: URL;
  try {
    resolved = new URL(entry, canonicalUrl);
  } catch {
    throw new Error(`Manifest entry is not a valid URL: ${entry}`);
  }
  if (!resolved.search && base.search && resolved.origin === base.origin) {
    resolved.search = base.search;
  }
  return resolved;
}

async function scanManifest(canonicalUrl: string): Promise<FoundScript[]> {
  const body = await fetchManifestText(canonicalUrl);
  const rawEntries = parseManifest(body);
  const seen = new Set<string>();
  const results: FoundScript[] = [];
  for (const entry of rawEntries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    // Resolve once: validates the URL, gates the scheme, and gives us a
    // friendly display name. The actual fetch URL is rebuilt at refresh
    // time via scriptFileUrl from collectionCanonicalUrl + entry.
    const resolved = resolveManifestEntryUrl(entry, canonicalUrl);
    if (!ALLOWED_ENTRY_SCHEMES.has(resolved.protocol)) {
      throw new Error(
        `Manifest entry scheme ${resolved.protocol} is not allowed (use http, https, or file)`,
      );
    }
    // Use urlBaseName on the resolved URL so percent-encoded segments
    // come out human-readable, mirroring scanSingleFile's HTTP path.
    const name = urlBaseName(resolved.href) || entry;
    results.push({ name, relativePath: entry });
  }
  return results;
}

// Build the fetchable URL for a specific scanned script. One branch per
// collection-kind (container, manifest, github-dir, directory); each is
// scheme-agnostic and works for raw paths, file:// URLs, and http(s)
// URLs uniformly via `collectionCanonicalUrl` / `locationFsPath`.
//
// Why directory uses path-joining rather than URL resolution: the
// `relativePath` for a local directory comes from Chrome's listing
// verbatim (e.g. `weird?name.user.js`), and URL resolution would treat
// `?...` as a query string. `pathToFileUrl` percent-encodes per
// segment, which survives those characters correctly. Manifest entries
// are user-authored and expected to already be properly URL-encoded
// when they contain special characters.
export function scriptFileUrl(collectionPath: string, relativePath: string): string {
  if (isContainerCollection(collectionPath)) {
    // Container scripts carry the full URL/path the user added in
    // their `relativePath`. Coerce raw fs paths to file:// URLs so the
    // downstream fetcher sees a uniform URL form.
    if (isHttpUrl(relativePath) || isFileUrl(relativePath)) return relativePath;
    return pathToFileUrl(relativePath);
  }
  if (isManifestCollection(collectionPath)) {
    return resolveManifestEntryUrl(relativePath, collectionCanonicalUrl(collectionPath)).href;
  }
  if (isGithubDirCollection(collectionPath)) {
    return githubDirScriptFileUrl(collectionPath, relativePath);
  }
  // Local directory.
  return pathToFileUrl(joinPath(locationFsPath(collectionPath), relativePath));
}

// Human-displayable location for a specific scanned script. Three
// distinct shapes:
//   - file:// → bare fs path (more readable than the percent-encoded
//     URL form).
//   - github (github-dir collection, github-manifest collection, or
//     any github URL added as a script inside the github container) →
//     `github.com/<o>/<r>/blob/<ref>/<path>` page URL. The raw URL is
//     what we fetch from; the blob URL is what a human would open in
//     a browser.
//   - non-github http(s):// → URL verbatim.
// This is what the viewer's Location row shows for every collection kind
// without each collection-kind needing its own special case.
export function scriptAbsolutePath(collectionPath: string, relativePath: string): string {
  if (isGithubDirCollection(collectionPath)) {
    return githubDirScriptDisplayUrl(collectionPath, relativePath);
  }
  const url = scriptFileUrl(collectionPath, relativePath);
  // GitHub manifest entries and github-container scripts are stored as
  // raw URLs (after `normalizeGithubInput`). Convert back to the github
  // page URL so the Location row matches a github-dir collection's
  // display.
  const blobUrl = githubRawToBlobUrl(url);
  if (blobUrl) return blobUrl;
  return isFileUrl(url) ? locationFsPath(url) : url;
}
