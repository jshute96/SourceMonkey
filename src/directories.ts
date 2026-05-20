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
//   - manifest          (anything whose pathname ends in .json — an
//                        absolute local path, a file:// URL, or an
//                        http(s) URL — returning a JSON list of script
//                        URLs that resolve against the manifest URL)
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
//     host_permissions so the SW/options page can fetch arbitrary
//     origins without CORS blocking the response body.
//
// File requirements:
//   - manifest: "file:///*" in host_permissions
//   - user: enabled "Allow access to file URLs" on chrome://extensions
// The toggle is persistent across browser sessions, so unlike the File
// System Access API there is no per-session re-grant.

export interface FoundScript {
  name: string;         // leaf file name, e.g. "foo.user.js"
  relativePath: string; // path relative to the source root (basename for single-file / manifest entries)
  size?: number;        // file byte size as reported by Chrome's listing (file:// only — undefined for HTTP)
  mtime?: number;       // modification time as reported by Chrome's listing — opaque integer used only for equality (file:// only)
}

// ---------- Source-kind detection ----------

// All source-kind checks key off the raw source string the user typed.
// `http://` / `https://` selects an HTTP source; everything else is
// treated as an absolute filesystem path. Suffix tests look at the URL
// pathname (sans query/fragment) so e.g. `…/foo.user.js?v=2` still
// classifies as a single-file source.

export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function isFileUrl(source: string): boolean {
  return /^file:\/\//i.test(source);
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

// True for any single-file source — http(s):// URL, file:// URL, or
// an absolute local path — whose pathname ends in `.user.js`.
// Scheme-agnostic counterpart to `isManifestSource`. Call sites that
// genuinely care about scheme combine this with `isHttpUrl(s)`.
export function isSingleFileSource(source: string): boolean {
  return sourcePathname(source).endsWith('.user.js');
}

// True for any manifest source — http(s):// URL, file:// URL, or an
// absolute local path — whose pathname ends in `.json`. Scheme-agnostic
// counterpart to `isSingleFileSource`.
export function isManifestSource(source: string): boolean {
  return sourcePathname(source).endsWith('.json');
}

// Leaf name (last path segment) of an http(s) URL — used as the
// FoundScript.name / relativePath for an HTTP single-file source so
// the options table shows "foo.user.js" rather than the whole URL.
function urlBaseName(source: string): string {
  const path = urlPathname(source);
  const slash = path.lastIndexOf('/');
  const last = slash < 0 ? path : path.slice(slash + 1);
  // Decode percent-encoded segments so the user sees the filename
  // they'd recognise; falls back to the raw segment if decoding fails.
  try { return decodeURIComponent(last); } catch { return last; }
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
    xhr.onerror = () => reject(new Error(`error fetching ${url}`));
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
    throw new Error(`error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok && response.status !== 0) {
    throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  }
  // Opaque responses (response.type === 'opaque') have an unreadable
  // body; surface a distinct error rather than returning empty content,
  // so a manual refresh from a page context can succeed where the SW
  // path fell through.
  if (response.type === 'opaque') {
    throw new Error(`opaque response from ${url} (file:// fetch not permitted in this context)`);
  }
  // An empty body here is a 0-byte file, not an error — keep it
  // distinct from "missing" so the row renders Size=0 Status=ERROR
  // (no metadata block) rather than getting flagged as gone.
  return await response.text();
}

// Best-effort "does the path point to a readable file" probe. Used to
// turn the otherwise-cryptic "error fetching …/" message into a
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

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', headers });
  } catch (err) {
    throw new Error(`error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 304) return { kind: 'unchanged' };
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
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

export const MAX_SCAN_DEPTH = 2; // levels of subdirectory below the root

// Parse a manifest body. Accepts either a bare JSON array of strings
// or `{scripts: [...]}`. Anything else is rejected with a message that
// points at the supported shapes. Empty strings inside the list are
// dropped so a trailing newline / typo doesn't fail the whole source.
export function parseManifest(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { scripts?: unknown }).scripts)) {
    arr = (parsed as { scripts: unknown[] }).scripts;
  } else {
    throw new Error('manifest must be a JSON array of URL strings, or `{"scripts": [...]}`');
  }
  const entries: string[] = [];
  for (const item of arr as unknown[]) {
    if (typeof item !== 'string') {
      throw new Error('manifest entries must all be strings');
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
  // Source-kind dispatch. Order: manifest first, then single-file,
  // then reject any HTTP URL with an unrecognised shape; everything
  // else falls through to the local-directory listing. The first two
  // branches are scheme-agnostic (raw path / file:// / http(s)://
  // handled uniformly); local directory is the only branch that
  // rejects HTTP, because there's no remote listing API.
  if (depth === 0) {
    if (isManifestSource(absolutePath)) {
      return scanManifest(sourceCanonicalUrl(absolutePath));
    }
    if (isSingleFileSource(absolutePath)) {
      return scanSingleFile(absolutePath);
    }
    if (isHttpUrl(absolutePath)) {
      throw new Error('URL must end in .user.js (single script) or .json (manifest)');
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
    // produces an opaque "error fetching" message. Probe by reading the
    // path as a plain file; if that succeeds we know the path exists
    // but isn't a userscript, so swap in a clearer message.
    if (depth === 0 && await isReadableFile(absolutePath)) {
      throw new Error(`filename doesn't end with .user.js`);
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

// One-entry "scan" for a single-file source (any scheme). The two
// sub-cases differ only in how the next refresh decides to skip
// re-fetching: local sources record listing-reported size+mtime here
// so the same Refresh-All skip applies, while HTTP sources rely on the
// per-entry conditional GET (`If-None-Match` / `If-Modified-Since`)
// and so don't need anything captured at scan time. Returning [] for
// a vanished local file lets the refresh pipeline flag the prior
// entry as `missing` (same treatment as a vanished file in a
// directory source).
async function scanSingleFile(source: string): Promise<FoundScript[]> {
  if (isHttpUrl(source)) {
    const name = urlBaseName(source) || source;
    return [{ name, relativePath: name }];
  }
  const fsPath = sourceFsPath(source);
  const dir = parentDir(fsPath);
  const name = baseName(fsPath);
  const stat = await statFromListing(dir, name);
  if (!stat || stat.isDir) return [];
  const found: FoundScript = { name, relativePath: name };
  if (stat.size !== undefined) found.size = stat.size;
  if (stat.mtime !== undefined) found.mtime = stat.mtime;
  return [found];
}

// Scheme-aware text fetcher used for the manifest body. Per-entry
// fetches (with their own per-scheme dispatch and conditional-GET
// handling) live in script-store.ts; this helper only needs to read
// a body, not negotiate freshness.
async function fetchManifestText(canonicalUrl: string): Promise<string> {
  if (isHttpUrl(canonicalUrl)) {
    const fetched = await fetchHttpText(canonicalUrl);
    if (fetched.kind !== 'ok') {
      throw new Error(`manifest fetch returned unexpected ${fetched.kind}`);
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
    throw new Error(`manifest entry is not a valid URL: ${entry}`);
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
        `manifest entry scheme ${resolved.protocol} is not allowed (use http, https, or file)`,
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
// per source-kind (manifest, single-file, directory); each is
// scheme-agnostic and works for raw paths, file:// URLs, and http(s)
// URLs uniformly via `sourceCanonicalUrl` / `sourceFsPath`.
//
// Why directory uses path-joining rather than URL resolution: the
// `relativePath` for a local directory comes from Chrome's listing
// verbatim (e.g. `weird?name.user.js`), and URL resolution would treat
// `?...` as a query string. `pathToFileUrl` percent-encodes per
// segment, which survives those characters correctly. Manifest entries
// are user-authored and expected to already be properly URL-encoded
// when they contain special characters.
export function scriptFileUrl(sourcePath: string, relativePath: string): string {
  if (isManifestSource(sourcePath)) {
    return resolveManifestEntryUrl(relativePath, sourceCanonicalUrl(sourcePath)).href;
  }
  if (isSingleFileSource(sourcePath)) {
    return sourceCanonicalUrl(sourcePath);
  }
  // Local directory.
  return pathToFileUrl(joinPath(sourceFsPath(sourcePath), relativePath));
}

// Human-displayable location for a specific scanned script. The rule
// is uniform: file:// → bare fs path (more readable than the
// percent-encoded URL form), http(s):// → URL. This is what the
// viewer's Location row shows for every source kind — including local
// manifest entries (file://) and HTTP manifest entries (http://) —
// without each source-kind needing its own special case.
export function scriptAbsolutePath(sourcePath: string, relativePath: string): string {
  const url = scriptFileUrl(sourcePath, relativePath);
  return isFileUrl(url) ? sourceFsPath(url) : url;
}
