// Source I/O for userscript sources.
//
// Owns: path → URL conversion, content fetch, listing parsers, and the
// scanner that turns a source path/URL into a list of FoundScript
// entries. All persistence lives in `src/script-store.ts`; this module
// is pure I/O.
//
// The following source kinds all flow through the same downstream
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
//     host_permissions so the SW/sources page can fetch arbitrary
//     origins without CORS blocking the response body.
//
// File requirements:
//   - manifest: "file:///*" in host_permissions
//   - user: enabled "Allow access to file URLs" on chrome://extensions
// The toggle is persistent across browser sessions, so unlike the File
// System Access API there is no per-session re-grant.

export type { FoundScript } from './source-scan.js';
import { type FoundScript, MAX_SCAN_DEPTH, MANIFEST_FILENAME } from './source-scan.js';
export { MAX_SCAN_DEPTH } from './source-scan.js';

// ---------- Source-kind detection ----------

// All source-kind checks key off the raw source string the user typed.
// `http://` / `https://` selects an HTTP source; everything else is
// treated as an absolute filesystem path. Suffix tests look at the URL
// pathname (sans query/fragment) so e.g. `…/foo.user.js?v=2` still
// classifies as a single-file URL.

// The shapes a user may type as a location, as a sentence fragment.
// Shared because two validators reject on it — the sources page's Add
// field (`isValidSourceInput`) and the viewer's preview
// (`isPreviewableInput`) — and their messages had already drifted into
// two different descriptions of one rule.
export const LOCATION_SHAPES =
  'must be an http(s):// or file:// URL, or an absolute path starting with /';

export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function isFileUrl(source: string): boolean {
  return /^file:\/\//i.test(source);
}

// Container sources aggregate individually-added scripts of one kind
// (local files, web URLs, GitHub URLs). Their stored `path` is one of
// the synthetic identifiers below — not a real URL — and per-script
// `relativePath` carries the full URL/path the user added. There is no
// scan step for a container source; refresh iterates the explicit
// scriptIds list and refetches each entry.
export type ContainerKind = 'file' | 'http' | 'github';

const CONTAINER_PATH_PREFIX = 'container:';

export function containerPath(kind: ContainerKind): string {
  return CONTAINER_PATH_PREFIX + kind;
}

export function isContainerSource(source: string): boolean {
  return containerKind(source) !== null;
}

export function containerKind(source: string): ContainerKind | null {
  if (source === 'container:file') return 'file';
  if (source === 'container:http') return 'http';
  if (source === 'container:github') return 'github';
  return null;
}

// Pathname of an http(s) or file:// URL, sans query and fragment.
// Returns '' if the string doesn't parse as a URL — callers gate on
// isHttpUrl / isFileUrl first.
function urlPathname(source: string): string {
  try {
    return new URL(source).pathname;
  } catch {
    return '';
  }
}

// Pathname for *any* source-input form (raw filesystem path, file://
// URL, or http(s):// URL). Used by suffix tests that don't care about
// scheme.
function sourcePathname(source: string): string {
  if (isHttpUrl(source) || isFileUrl(source)) return urlPathname(source);
  return source;
}

// Canonical URL form for a source input. Raw filesystem paths get
// percent-encoded and wrapped as file://; URLs pass through. Used as
// the base for URL.resolution of manifest entries so a local manifest
// can list relative paths the same way an HTTP one can.
export function sourceCanonicalUrl(source: string): string {
  if (isHttpUrl(source) || isFileUrl(source)) return source;
  return pathToFileUrl(source);
}

// Inverse of sourceCanonicalUrl for local inputs: a file:// URL turns
// into the absolute filesystem path it points at; a raw path passes
// through. Lets the local directory/single-file branches accept the
// URL form the user typed without each branch having to special-case
// the parse. Percent-encoded segments (e.g. `my%20scripts`) are
// decoded so downstream path helpers see the on-disk name verbatim.
export function sourceFsPath(source: string): string {
  if (!isFileUrl(source)) return source;
  try {
    return decodeURIComponent(new URL(source).pathname);
  } catch {
    return source;  // unparseable URL → let the caller's I/O fail with a clearer message
  }
}

// Windows drive-letter (`file:///C:/…`) and UNC (`file://server/…`)
// URLs. `sourceFsPath` mangles both — it strips only the leading POSIX
// slash and discards `host` — so the canonicalizer below leaves them
// as URLs rather than producing a path that points somewhere else.
// The rest of the module is POSIX-only by design (see `pathToFileUrl`,
// `parentDir`), so this is containment, not Windows support.
function isNonPosixFileUrl(source: string): boolean {
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    return false;
  }
  return u.host !== '' || /^\/[A-Za-z]:/.test(u.pathname);
}

// One canonical spelling for a source input, so every entry point
// agrees on what a given file is called: the sources page's path
// field, an `addSource` call, and a captured `file://` navigation all
// have to produce the same `relativePath`, or one file on disk ends up
// with two installed rows.
//
// The bare filesystem path is the winner because it is what the path
// field (the oldest and most common route) has always stored. http(s)
// inputs pass through untouched — there is only one spelling of those.
export function canonicalSourceInput(source: string): string {
  if (!isFileUrl(source) || isNonPosixFileUrl(source)) return source;
  return sourceFsPath(source);
}

// True for any input pointing at an individual `.user.js` script —
// http(s):// URL, file:// URL, or absolute local path — based on the
// pathname suffix. Single-script inputs no longer get their own source
// row; the add flow routes them into the matching container source
// (see `containerKindForSingleFileInput`).
export function isSingleFileInput(source: string): boolean {
  return sourcePathname(source).endsWith('.user.js');
}

// True for any manifest source — http(s):// URL, file:// URL, or an
// absolute local path — whose pathname's basename is exactly
// `MANIFEST_FILENAME`. The fixed-filename rule (rather than a generic
// `.json` suffix) keeps unrelated JSON files from being mistaken for
// script manifests and gives the convention a single, searchable name.
export function isManifestSource(source: string): boolean {
  const p = sourcePathname(source);
  return p === MANIFEST_FILENAME
    || p.endsWith('/' + MANIFEST_FILENAME);
}

// Classify a single-file input string by container kind. Callers that
// have already verified the input passes `isSingleFileInput` use this
// to pick which container source the script gets added to. github URLs
// here mean both the human-facing `github.com/...` form and the
// already-normalized `raw.githubusercontent.com/...` form, since
// `normalizeSourceInput` may have rewritten the input before this runs.
export function containerKindForSingleFileInput(source: string): ContainerKind {
  if (/^https?:\/\/(www\.)?github\.com\//i.test(source)) return 'github';
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(source)) return 'github';
  if (isHttpUrl(source)) return 'http';
  return 'file';
}

// GitHub-specific source handling lives in `github-source.ts`. We
// re-export only the symbols `script-store.ts` and `options.ts` use
// directly. Callers always go through `normalizeSourceInput`; today
// that's just `normalizeGithubInput` under its public name, but
// keeping the public name generic lets future providers slot in
// without changing the callers.
export { isGithubDirSource } from './github-source.js';
export { normalizeGithubInput as normalizeSourceInput } from './github-source.js';
import {
  githubDirScriptFileUrl,
  githubDirScriptDisplayUrl,
  githubRawToBlobUrl,
  isGithubDirSource,
  scanGithubDir,
} from './github-source.js';
export { githubRawToBlobUrl } from './github-source.js';
import { githubAuthHeaders } from './github-auth.js';
import { decodeForDisplay, leafName } from './script-display.js';

// Leaf name (last path segment) of an http(s) URL, percent-decoded —
// used as the FoundScript.name for HTTP manifest entries so the
// sources page shows "foo.user.js" rather than the whole URL. Returns
// '' for anything that doesn't parse as a URL, which callers use as
// their "fall back to the raw entry" signal.
export function urlBaseName(source: string): string {
  return decodeForDisplay(leafName(urlPathname(source)));
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
}

export type HttpFetchResult =
  | { kind: 'ok'; text: string; etag?: string; lastModified?: string }
  | { kind: 'unchanged' };  // 304

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
  // Attach the configured GitHub token when the URL targets a GitHub
  // host. No-op for any other URL. Lets private-repo raw URLs and
  // private repo manifests fetch under auth without each call site
  // having to opt in. Header host-gating is enforced inside
  // githubAuthHeaders so a token can never be leaked to a non-GitHub
  // host.
  Object.assign(headers, githubAuthHeaders(url));

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', headers });
  } catch (err) {
    throw new Error(`Could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 304) return { kind: 'unchanged' };
  if (!response.ok) throw new Error(`Could not read ${url}: HTTP ${response.status}`);
  const text = await response.text();
  const result: HttpFetchResult = { kind: 'ok', text };
  const etag = response.headers.get('ETag');
  if (etag) result.etag = etag;
  const lastModified = response.headers.get('Last-Modified');
  if (lastModified) result.lastModified = lastModified;
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

async function listDirectory(absolutePath: string): Promise<ListingEntry[]> {
  // Chrome only serves the directory listing for URLs ending with `/`.
  const url = pathToFileUrl(absolutePath) + '/';
  return parseListing(await fetchFileUrlText(url));
}

// Targeted version of listDirectory: list a single directory and return
// just the entry for `fileName` (or null if absent). Used by the
// single-file refresh path so it can capture the file's current
// size/mtime without doing a full recursive scan — keeps the
// unchanged-file skip honest for the next Refresh All.
export async function statFromListing(
  absoluteDir: string,
  fileName: string,
): Promise<ListingEntry | null> {
  const entries = await listDirectory(absoluteDir);
  return entries.find((e) => e.name === fileName) ?? null;
}

// ---------- Scanning ----------

// Parse a manifest body. Accepts either a bare JSON array of strings
// or `{scripts: [...]}`. Anything else is rejected with a message that
// points at the supported shapes. Empty strings inside the list are
// dropped so a trailing newline / typo doesn't fail the whole source.
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
    throw new Error('Manifest must be a JSON array of URL strings, or `{"scripts": [...]}`');
  }
  const entries: string[] = [];
  for (const item of arr as unknown[]) {
    if (typeof item !== 'string') {
      throw new Error('Manifest entries must all be strings');
    }
    const trimmed = item.trim();
    if (trimmed) entries.push(trimmed);
  }
  return entries;
}

export async function scanForUserScripts(
  absolutePath: string,
  depth = 0,
  prefix = '',
): Promise<FoundScript[]> {
  // Source-kind dispatch. Container sources don't have a scannable
  // backing store — refreshSource builds a synthetic scan from the
  // existing scriptIds and never calls this for them.
  // The remaining branches are scheme-agnostic (raw path / file:// /
  // http(s):// handled uniformly); local directory is the only branch
  // that rejects HTTP, because there's no remote listing API.
  if (depth === 0) {
    if (isContainerSource(absolutePath)) {
      throw new Error(
        'Internal error: this source kind is refreshed directly, not scanned',
      );
    }
    if (isManifestSource(absolutePath)) {
      return scanManifest(sourceCanonicalUrl(absolutePath));
    }
    if (isGithubDirSource(absolutePath)) {
      return scanGithubDir(absolutePath);
    }
    if (isHttpUrl(absolutePath)) {
      // No mention of "container sources": that's how we store a
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
    absolutePath = sourceFsPath(absolutePath);
  }
  let entries: ListingEntry[];
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
  for (const entry of entries) {
    if (!entry.isDir && entry.name.endsWith('.user.js')) {
      const found: FoundScript = { name: entry.name, relativePath: prefix + entry.name };
      if (entry.size !== undefined) found.size = entry.size;
      if (entry.mtime !== undefined) found.mtime = entry.mtime;
      results.push(found);
    } else if (entry.isDir && depth < MAX_SCAN_DEPTH) {
      const sub = await scanForUserScripts(
        joinPath(absolutePath, entry.name),
        depth + 1,
        prefix + entry.name + '/',
      );
      results.push(...sub);
    }
  }
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

// ---------- Per-source-kind scanners ----------

// Scheme-aware text fetcher used for the manifest body. Per-entry
// fetches (with their own per-scheme dispatch and conditional-GET
// handling) live in script-store.ts; this helper only needs to read
// a body, not negotiate freshness.
async function fetchManifestText(canonicalUrl: string): Promise<string> {
  if (isHttpUrl(canonicalUrl)) {
    const fetched = await fetchHttpText(canonicalUrl);
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
// If-None-Match round-trip on the manifest URL). The per-script
// fetches still 304 individually, so the bandwidth cost is bounded.
// See TODO.md "HTTP sources — follow-ups" for the planned fix.
// Schemes a manifest entry's *resolved* URL is allowed to use. We
// mirror the suffix-test policy on the source URL itself (which only
// accepts http(s) / file: / raw path): a manifest the user added
// shouldn't be able to escalate the SW's `<all_urls>` reach into
// things like `data:` (arbitrary inline content), `chrome-extension:`
// (cross-extension probing), or `blob:` (off-origin smuggling). The
// user can always add such sources directly if they want them.
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
    // Resolve once: validates the URL, gates the scheme, and gives us
    // a friendly display name. The actual fetch URL is rebuilt at
    // refresh time via scriptFileUrl from sourceCanonicalUrl + entry.
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

// Build the fetchable URL for a specific scanned script. One branch
// per source-kind (container, manifest, github-dir, directory); each
// is scheme-agnostic and works for raw paths, file:// URLs, and
// http(s) URLs uniformly via `sourceCanonicalUrl` / `sourceFsPath`.
//
// Why directory uses path-joining rather than URL resolution: the
// `relativePath` for a local directory comes from Chrome's listing
// verbatim (e.g. `weird?name.user.js`), and URL resolution would treat
// `?...` as a query string. `pathToFileUrl` percent-encodes per
// segment, which survives those characters correctly. Manifest entries
// are user-authored and expected to already be properly URL-encoded
// when they contain special characters.
export function scriptFileUrl(sourcePath: string, relativePath: string): string {
  if (isContainerSource(sourcePath)) {
    // Container scripts carry the full URL/path the user added in
    // their `relativePath`. Coerce raw fs paths to file:// URLs so the
    // downstream fetcher sees a uniform URL form.
    if (isHttpUrl(relativePath) || isFileUrl(relativePath)) return relativePath;
    return pathToFileUrl(relativePath);
  }
  if (isManifestSource(sourcePath)) {
    return resolveManifestEntryUrl(relativePath, sourceCanonicalUrl(sourcePath)).href;
  }
  if (isGithubDirSource(sourcePath)) {
    return githubDirScriptFileUrl(sourcePath, relativePath);
  }
  // Local directory.
  return pathToFileUrl(joinPath(sourceFsPath(sourcePath), relativePath));
}

// Human-displayable location for a specific scanned script. Three
// distinct shapes:
//   - file:// → bare fs path (more readable than the percent-encoded
//     URL form).
//   - github (github-dir source, github-manifest source, or any github
//     URL added as a script inside the github container) →
//     `github.com/<o>/<r>/blob/<ref>/<path>` page URL. The raw URL is
//     what we fetch from; the blob URL is what a human would open in
//     a browser.
//   - non-github http(s):// → URL verbatim.
// This is what the viewer's Location row shows for every source kind
// without each source-kind needing its own special case.
export function scriptAbsolutePath(sourcePath: string, relativePath: string): string {
  if (isGithubDirSource(sourcePath)) {
    return githubDirScriptDisplayUrl(sourcePath, relativePath);
  }
  const url = scriptFileUrl(sourcePath, relativePath);
  // GitHub manifest entries and github-container scripts are stored as
  // raw URLs (after `normalizeGithubInput`). Convert back to the github
  // page URL so the Location row matches a github-dir source's display.
  const blobUrl = githubRawToBlobUrl(url);
  if (blobUrl) return blobUrl;
  return isFileUrl(url) ? sourceFsPath(url) : url;
}
