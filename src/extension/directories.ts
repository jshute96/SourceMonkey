// Collection I/O: fetch + scan for every collection kind.
//
// Owns: content fetch and the scanner that turns a collection path/URL
// into a list of FoundScript entries. Path helpers, the `file://`
// reader and listing parser are in `src/file-locations.ts`, which this
// re-exports. All persistence lives in `src/extension/script-store.ts`; this
// module is pure I/O.
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

export type { FoundScript } from '../collection-scan.js';
import { type FoundScript, MAX_SCAN_DEPTH, MANIFEST_FILENAME, ALLOWED_ENTRY_SCHEMES, parseManifest, resolveManifestEntryUrl } from '../collection-scan.js';

// The manifest helpers live in the shared collection-scan.ts, so sm-dev
// reads manifests the same way; re-exported for this module's callers.
export { parseManifest, resolveManifestEntryUrl };
import { mapWithConcurrency, SCAN_DIRS_CONCURRENCY } from './concurrency.js';
// Page-only API under the hood, but the wrapper answers "allowed" from
// any context that can't ask — and only `classifyLocation`, which only
// the collection dialog calls, uses it.
import { isFileSchemeAccessAllowed } from './file-access.js';
export { MAX_SCAN_DEPTH } from '../collection-scan.js';

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
// Called from the collection dialog, a page. The reads would work from
// the worker too (docs/worker-writes.md#checked-what-the-worker-can-do),
// but its file-access check (`isFileSchemeAccessAllowed`) can only ask
// from a page.
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
  isGithubDirCollection,
  isGithubDirInput,
  scanGithubDir,
} from './github-provider.js';
import { githubRawToBlobUrl } from '../github-urls.js';
export { githubRawToBlobUrl } from '../github-urls.js';
import { githubAuthHeaders } from '../github-auth.js';
import { decodeForDisplay, leafName } from '../script-display.js';
import { mustHopToWorker, readHttpViaWorker } from '../http-read.js';
import {
  MarkupResponseError,
  isMarkupContentType,
  looksLikeMarkup,
  markupResponseMessage,
} from '../markup-response.js';

import {
  baseName,
  canonicalCollectionInput,
  collectionCanonicalUrl,
  type DirectoryListingCache,
  isContainerCollection,
  isFileUrl,
  isHttpUrl,
  isManifestCollection,
  isSingleFileInput,
  joinPath,
  listDirectory,
  type ListingEntry,
  LOCATION_SHAPES,
  locationFsPath,
  NOT_A_DIRECTORY_LISTING,
  parentDir,
  pathToFileUrl,
  readFileUrlText,
  readFileUrlWithStat,
  statFromListing,
  urlPathname,
} from '../file-locations.js';
// Location and listing helpers, re-exported for the callers that reach
// them through here.
export * from '../file-locations.js';
// Scratch-script and sm-dev collection naming, likewise.
export * from './location-kinds.js';
import { isScratchUrl, scratchTextKey } from './location-kinds.js';

// Leaf name (last path segment) of an http(s) URL, percent-decoded —
// used as the FoundScript.name for HTTP manifest entries so the
// collections page shows "foo.user.js" rather than the whole URL.
// Returns '' for anything that doesn't parse as a URL, which callers
// use as their "fall back to the raw entry" signal.
export function urlBaseName(input: string): string {
  return decodeForDisplay(leafName(urlPathname(input)));
}

async function fetchScratchText(url: string): Promise<string> {
  const got = await chrome.storage.local.get(scratchTextKey(url));
  const text = got[scratchTextKey(url)];
  if (typeof text !== 'string') throw new Error(`Could not read ${url}: The scratch script's text was cleared. Push it again.`);
  return text;
}

// ---------- File / directory fetch ----------

export function fetchFileUrlText(url: string): Promise<string> {
  if (isScratchUrl(url)) return fetchScratchText(url);
  return readFileUrlText(url);
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
  return refuseMarkup(url, await fetchFileUrlText(url));
}

// `fetchScriptFileUrlText` for a `file://` script, with the size and
// modified time a listing of its folder would give. See
// `readFileUrlWithStat`.
export async function fetchScriptFileWithStat(
  url: string,
): Promise<{ text: string; size: number; fsMtime?: number }> {
  const read = await readFileUrlWithStat(url);
  refuseMarkup(url, read.text);
  return read;
}

function refuseMarkup(url: string, text: string): string {
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

// ---------- Scanning ----------

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
// "HTTP collections — follow-ups" for the planned fix.
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
    if (isHttpUrl(relativePath) || isFileUrl(relativePath) || isScratchUrl(relativePath)) return relativePath;
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
