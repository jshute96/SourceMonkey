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
// Page-only API under the hood, but the wrapper answers "allowed" from
// any context that can't ask — and only `classifyLocation`, which is
// page-only anyway, calls it.
import { isFileSchemeAccessAllowed } from './file-access.js';
export { MAX_SCAN_DEPTH } from './collection-scan.js';

// ---------- Collection-kind detection ----------

// All collection-kind checks key off the raw input string the user
// typed. `http://` / `https://` selects an HTTP collection; everything
// else is treated as an absolute filesystem path. Suffix tests look at
// the URL pathname (sans query/fragment) so e.g. `…/foo.user.js?v=2`
// still classifies as a single-file URL.

// The shapes a user may type as a location, as a sentence fragment.
// Shared because two validators reject on it — `isValidLocationShape`
// below and the viewer's preview (`isPreviewableInput`) — and their
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
// (http(s) and GitHub, a manifest, a single-file container) names its
// scripts some other way.
export function isLocalDirectoryCollection(collectionPath: string): boolean {
  return !isHttpUrl(collectionPath)
    && !isManifestCollection(collectionPath)
    && !isContainerCollection(collectionPath);
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
// path rather than persisted, so a row can't disagree with itself.
export type CollectionKind = 'scripts' | 'directory' | 'manifest';

export function collectionKind(path: string): CollectionKind {
  if (isContainerCollection(path)) return 'scripts';
  if (isManifestCollection(path)) return 'manifest';
  return 'directory';
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

// ---------- What a typed location turns out to be ----------

// The verdict `classifyLocation` reaches about one location string.
// `script` is a single `.user.js`: a real thing to install, but not a
// collection — the caller decides whether to offer the install route or
// refuse.
export type LocationVerdict =
  | { kind: 'directory' | 'manifest' | 'script' }
  | { kind: 'invalid'; message: string };

// A single script typed where a collection was expected. Two spellings
// of one message: the bare sentence for a surface that offers the
// install route itself (the collection dialog puts a button under it),
// and the sentence plus the fix for surfaces that can only refuse.
export const SINGLE_SCRIPT_NOT_A_COLLECTION = 'This is a single script, not a collection';
export const SINGLE_SCRIPT_USE_ADD_FIELD =
  `${SINGLE_SCRIPT_NOT_A_COLLECTION}. To install it, paste it in the Add field instead.`;

// A readable local file of a shape no collection can be built from.
// Says what would work rather than what didn't, per the "name the fix"
// rule.
export const UNSUPPORTED_LOCATION_FILE =
  `File must be a script (.user.js) or a manifest (${MANIFEST_FILENAME})`;

// An http(s) URL that names no collection we recognise. GitHub is the
// only folder we can scan over http — a plain web directory has no
// listing to read — so naming it is not an example but the whole rule.
// Deliberately shaped like `UNSUPPORTED_LOCATION_FILE`: one sentence
// saying what would work.
export const HTTP_URL_NOT_A_COLLECTION =
  `URL must be a GitHub folder or a manifest (${MANIFEST_FILENAME})`;

// A local path nothing could be read from. A file:// read fails
// identically for "not there" and "not allowed", so the caller passes
// in the answer to the second (`isFileSchemeAccessAllowed`) and the
// message names one cause rather than listing both.
//
// The off case opens on the same words as the file-access banner
// (`renderFileAccessBanner`) so the two read as one story, and points
// at the settings without repeating the banner's link: the banner is
// already on the page behind this dialog.
export function locationNotReadableMessage(location: string, fileAccess: boolean): string {
  // `Could not read …` matches the wording every other read failure in
  // this module uses, so one session can't show two names for one
  // failure.
  //
  // Ends with a period, unlike the single-sentence messages above: the
  // no-trailing-period rule is there so a message can take a `(in
  // <where>)` suffix, which these never do — they render alone in the
  // dialog's error slot — and a run of sentences whose last one is the
  // only bare one reads as a typo. Same shape as the other multi-
  // sentence messages here (`SINGLE_SCRIPT_USE_ADD_FIELD`).
  return fileAccess
    ? `Could not read ${location}. Check that the path exists.`
    : `Could not read ${location}. File access is disabled for this extension. Enable in extension settings.`;
}

// The shapes a location may be typed in: an http(s) URL, a file:// URL,
// or an absolute POSIX path that isn't the filesystem root. Shared by
// every surface that accepts one, so the rule and the message
// (`LOCATION_SHAPES`) can't drift apart.
export function isValidLocationShape(input: string): boolean {
  if (isHttpUrl(input)) return true;
  if (isFileUrl(input)) return !isFilesystemRoot(locationFsPath(input));
  return input.startsWith('/') && !isFilesystemRoot(input);
}

// Whether a POSIX path names the filesystem root, however it is
// spelled. Scanning `/` would walk the whole disk, so every spelling
// has to be refused — not just the bare one: `//`, `/.` and `/../..`
// all land in the same place, and a length test (what this used to be)
// lets each of them through. A path built only from separators and
// dots can't name anything else.
function isFilesystemRoot(path: string): boolean {
  return /^[/.]*$/.test(path.trim());
}

// Decide what a location IS, reading it where we can rather than
// guessing from its name. Local paths get probed — a directory listing
// first, then a plain file read — so a path that doesn't exist says so
// instead of being filed as a directory and failing later in a scan.
//
// http(s) URLs are classified by shape alone: there is no remote
// listing, and a keystroke-rate classifier must not fire network reads
// at arbitrary origins. Their readability is checked when the
// collection is created.
//
// Only for page contexts (the collection dialog). A service worker has
// no XMLHttpRequest, and its `fetch` of a file:// directory answers
// opaquely — see the module header.
export async function classifyLocation(input: string): Promise<LocationVerdict> {
  const value = input.trim();
  if (!isValidLocationShape(value)) {
    return { kind: 'invalid', message: `Location ${LOCATION_SHAPES}` };
  }
  if (isHttpUrl(value)) {
    if (isSingleFileInput(value)) return { kind: 'script' };
    if (isManifestCollection(value)) return { kind: 'manifest' };
    if (isGithubDirInput(value)) return { kind: 'directory' };
    return { kind: 'invalid', message: HTTP_URL_NOT_A_COLLECTION };
  }
  // Local. Probe through the canonical URL rather than a filesystem
  // path: `locationFsPath` mangles the Windows shapes `pathToFileUrl`
  // can't rebuild, and a URL the user typed is already in the form the
  // read wants.
  // Safe to strip: the shape check above refused everything that
  // collapses to `/`, so this can't eat `file://`'s own slashes.
  const url = collectionCanonicalUrl(value).replace(/\/+$/, '');
  // Directory first: Chrome serves a listing for a directory URL with
  // OR without the trailing slash, so a plain read can't tell the two
  // apart — but only a directory answers the slashed form at all.
  if (await canReadFileUrl(url + '/')) return { kind: 'directory' };
  if (await canReadFileUrl(url)) {
    if (isSingleFileInput(value)) return { kind: 'script' };
    if (isManifestCollection(value)) return { kind: 'manifest' };
    return { kind: 'invalid', message: UNSUPPORTED_LOCATION_FILE };
  }
  // Which of the two reasons it is IS knowable, so the message says
  // which rather than listing both: with file access off, every local
  // path reads as missing, and "check that the path exists" would send
  // the user hunting for a file that is sitting right there.
  const fileAccess = await isFileSchemeAccessAllowed();
  return {
    kind: 'invalid',
    message: locationNotReadableMessage(canonicalCollectionInput(value), fileAccess),
  };
}

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
  isGithubDirInput,
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

// Best-effort "can this file:// URL be read" probe. Returns false on
// any error (including non-existence and permission failures) —
// callers should only rely on a true result.
async function canReadFileUrl(url: string): Promise<boolean> {
  try {
    await fetchFileUrlText(url);
    return true;
  } catch {
    return false;
  }
}

// Best-effort "does the path point to a readable file" probe. Used to
// turn the otherwise-cryptic "Could not read …/" message into a
// clearer one when the user types a path to an existing non-userscript
// file.
async function isReadableFile(absolutePath: string): Promise<boolean> {
  return await canReadFileUrl(pathToFileUrl(absolutePath));
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

// Whether an input names one script file, checked against the raw
// input before any canonicalization: an http(s) or file:// URL, or an
// absolute local path — the same shapes the collections page's Add
// field accepts for a single script. Checked before canonicalizing
// because `collectionCanonicalUrl` turns anything else into a file://
// URL, and an `ftp://…` would otherwise fail with a baffling
// `file:///ftp%3A//…` error instead of being named.
export function isSingleFileLocation(input: string): boolean {
  return isHttpUrl(input) || isFileUrl(input) || input.startsWith('/');
}

// The text at a single-file location — the two shapes one can take once
// canonicalized, http(s) or file://. What the install preview fetches,
// and what the compare page fetches to stand a download against an
// installed copy.
export async function fetchSingleFileText(url: string): Promise<string> {
  if (isFileUrl(url)) return fetchScriptFileUrlText(url);
  const result = await fetchHttpText(url);
  // `unchanged` needs a conditional request to happen, and we send
  // none — but the type includes it, so fail loudly rather than
  // rendering an empty page if that ever changes.
  if (result.kind !== 'ok') throw new Error('No content returned');
  return result.text;
}

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
    const html = await fetchFileUrlText(url);
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
  // Listings to share with the caller — a manifest refresh stats the
  // manifest file from the same folder its entries usually sit in.
  listings?: DirectoryListingCache,
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
      return scanManifest(collectionCanonicalUrl(absolutePath), listings);
    }
    if (isGithubDirCollection(absolutePath)) {
      return scanGithubDir(absolutePath);
    }
    if (isHttpUrl(absolutePath)) {
      // No mention of "container collections": that's how we store a
      // stand-alone script, and the reader adding a URL has no name for
      // it — from the page it just looks like adding the script itself.
      throw new Error(HTTP_URL_NOT_A_COLLECTION);
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
    // Not when the listing was refused for its shape: Chrome serves a
    // listing for a directory URL without the slash too, so the probe
    // would "succeed" on a real folder and blame the user's path.
    const shapeRefused = err instanceof Error && err.message.includes(NOT_A_DIRECTORY_LISTING);
    if (depth === 0 && !shapeRefused && await isReadableFile(absolutePath)) {
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

async function scanManifest(
  canonicalUrl: string,
  // One listing per folder the entries sit in, for the stat below.
  listings: DirectoryListingCache = new Map(),
): Promise<FoundScript[]> {
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
    const found: FoundScript = { name, relativePath: entry };
    // A `file://` entry gets the same listing stat a directory scan
    // gives its files, so the refresh can skip an unchanged one and a
    // page can tell an edited one (file-changes.ts). Best effort: an
    // entry whose folder won't list just stays always-fetch.
    if (resolved.protocol === 'file:') {
      const stat = await statFileByListing(locationFsPath(resolved.href), listings);
      if (stat?.size !== undefined) found.size = stat.size;
      if (stat?.mtime !== undefined) found.mtime = stat.mtime;
    }
    results.push(found);
  }
  return results;
}

// The listing entry for one file by absolute path — its parent folder
// listed once per `cache` — or null when it isn't listed or the folder
// can't be read.
export async function statFileByListing(
  absolutePath: string,
  cache?: DirectoryListingCache,
): Promise<ListingEntry | null> {
  try {
    return await statFromListing(parentDir(absolutePath), baseName(absolutePath), cache);
  } catch {
    return null;
  }
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
