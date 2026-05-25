// Prefetched external files referenced by a userscript: `@require`
// libraries and `@resource` data blobs. Both flow through the same
// resolution + fetch + dedup pipeline; the diff is the typed shape
// each produces and how they're consumed downstream.
//
// `@require`:
//   - JS text prepended before the script body at injection time
//     (the registered userScript carries the concatenated source so
//     no runtime fetch is needed at injection time — Chrome's
//     userScripts API can't fetch on its own).
//   - `.js` suffix gate on the resolved URL; strict UTF-8 decode on
//     the fetched bytes — non-UTF-8 fails the script outright. We
//     never inject binary as JS.
//
// `@resource`:
//   - Arbitrary bytes (any media type). Stored as base64 so the
//     chrome.storage.local JSON layer can carry them.
//   - Exposed to userscripts at runtime via GM_getResourceText
//     (UTF-8 decode on demand, mojibake-tolerant) and
//     GM_getResourceURL (blob: URL minted in the page with the
//     fetched content-type).
//
// Shared semantics:
//   - resolveScriptResource rules from file-loader: absolute
//     http(s):// or relative-against-script. file:// only reachable
//     via relative resolution; no traversal. data: rejected.
//   - Same byte fetcher with size cap.
//   - Same per-refresh cross-script fetch cache: two scripts (and
//     two refs of either kind) pointing at the same URL share one
//     fetch. The typed assembly happens after the cache hit.
//   - Any failure (resolve-time or fetch-time) returns an error
//     message; the caller flips the script to status:'error' with
//     the message and preserves prior-known-good state.

import {
  fetchResourceBytes,
  isJsResourceUrl,
  resolveScriptResource,
} from './file-loader.js';
import { splitResourceValue } from './script-links.js';
import { getValues, type ParsedHeader } from './userscript-header.js';

// Per-file limit. Big enough for jQuery (~90 KB) and most chunky
// userscript libraries; small enough to keep a runaway from draining
// the 10 MB chrome.storage.local quota in one row. Applies to both
// @require and @resource — split caps possible later if pain shows up.
export const MAX_FILE_BYTES = 1024 * 1024;

interface SharedFileFields {
  // Verbatim ref from the metadata line (post-trim). Kept so error
  // messages name what the user wrote, not the canonicalized URL.
  ref: string;
  // Canonical resolved URL. Stable dedup key.
  url: string;
  // Byte length of the fetched body. Non-zero (the fetcher rejects
  // empty bodies).
  size: number;
  // SHA-256 hex of the fetched bytes.
  contentHash: string;
  // Epoch ms of the last successful (re)fetch. Bumps only on a true
  // content change so the options-page row-highlight stays accurate.
  loadedAt: number;
  // Server-reported (lowercased) Content-Type, or '' when not
  // available (file:// XHR often omits it). Optional on
  // StoredRequire because pre-this-change stored rows won't carry
  // it; required on StoredResource because the field is load-bearing
  // for blob URL creation.
  contentType?: string;
  // HTTP validators (http(s) only). Captured for future conditional
  // GET support — not yet round-tripped through the byte fetcher.
  httpEtag?: string;
  httpLastModified?: string;
}

export interface StoredRequire extends SharedFileFields {
  // Decoded JS source. Validated as strict UTF-8 at fetch time.
  source: string;
}

export interface StoredResource extends SharedFileFields {
  // Resource name from `@resource <name> <url>`.
  name: string;
  // Body bytes, base64-encoded for JSON-friendly storage. The wrapper
  // decodes back to bytes on first GM_getResourceText / GM_getResourceURL.
  bytesBase64: string;
  // Required (not optional like SharedFileFields.contentType) because
  // GM_getResourceURL needs a MIME for the blob and the field is
  // present on every newly-built StoredResource.
  contentType: string;
}

// Cross-script fetch dedup, shared across requires + resources for a
// single refresh pass. Keyed by canonical URL; value is the raw byte
// fetch result (not typed) so a require and a resource referencing
// the same URL share one network round-trip.
export type FileFetchCache = Map<string, Promise<FetchedFile | FileFailure>>;

export interface FetchedFile {
  failed?: false;
  bytes: ArrayBuffer;
  contentType: string;
}

interface FileFailure {
  failed: true;
  errorMessage: string;
}

function isFailure(v: FetchedFile | FileFailure): v is FileFailure {
  return (v as FileFailure).failed === true;
}

// ---------- Header distillation ----------

// Unique `@require` refs in declaration order. Localized variants
// (`@require:de`) are ignored. Empty / whitespace-only refs dropped.
// Duplicate refs collapse to first occurrence — TM does the same.
export function distillRequires(header: ParsedHeader | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of getValues(header, 'require')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface ResourceDecl {
  name: string;
  ref: string;
}

// Unique `@resource` declarations in declaration order. Each line is
// `<name> <url>`; we split via the same helper the viewer uses so
// linkification and load semantics stay aligned. Lines with no URL
// portion (no whitespace gap) are dropped silently. Duplicate names
// keep the first declaration — TM/VM raise an error; being lenient
// means a typo only loses one resource rather than failing the
// whole script.
export function distillResources(header: ParsedHeader | null): ResourceDecl[] {
  if (!header) return [];
  const out: ResourceDecl[] = [];
  const seenName = new Set<string>();
  for (const raw of getValues(header, 'resource')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parts = splitResourceValue(trimmed);
    if (!parts) continue;
    const name = parts.prefix.trim();
    const ref = parts.url.trim();
    if (!name || !ref) continue;
    if (seenName.has(name)) continue;
    seenName.add(name);
    out.push({ name, ref });
  }
  return out;
}

// ---------- Hashing + base64 ----------

async function sha256HexOfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

// Chunked binary→base64. `String.fromCharCode.apply(null, hugeArray)`
// throws "Maximum call stack size exceeded" past ~125k args in V8,
// so we walk the buffer in 32 KiB slices and concatenate. Linear and
// bounded.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

// ---------- attachFiles orchestrator ----------

export interface AttachFilesArgs {
  // The script's own canonical URL. Resolution base for relative refs.
  scriptFileUrl: string;
  header: ParsedHeader | null;
  // Prior typed entries from the last successful build, keyed by
  // canonical URL. Used for the recheck:'preserve' fast path and for
  // loadedAt preservation when the freshly fetched bytes are unchanged.
  priorRequires: Map<string, StoredRequire>;
  priorResources: Map<string, StoredResource>;
  // 'all'      — refetch every declared file. Explicit Refresh uses
  //              this so users can pick up remote changes.
  // 'preserve' — reuse cached priors verbatim; only fetch refs the
  //              script newly declares. Opportunistic refresh.
  recheck: 'all' | 'preserve';
  // Cross-script + cross-kind fetch cache.
  fetchCache: FileFetchCache;
  // Wall-clock for new loadedAt stamps.
  now: number;
}

export interface AttachFilesResult {
  requires: StoredRequire[];
  resources: StoredResource[];
  // Set when at least one file failed. The caller flips the script
  // to status:'error' with this message. Partial lists aren't useful
  // for injection so we return empty arrays alongside.
  errorMessage?: string;
}

export async function attachFiles(args: AttachFilesArgs): Promise<AttachFilesResult> {
  const requireRefs = distillRequires(args.header);
  const resourceDecls = distillResources(args.header);
  if (requireRefs.length === 0 && resourceDecls.length === 0) {
    return { requires: [], resources: [] };
  }
  const requires: StoredRequire[] = [];
  const resources: StoredResource[] = [];
  // @require dedup is at URL granularity (TM/VM also do this).
  // @resource dedup is at NAME granularity, handled in distillResources —
  // two names pointing at the same URL produce two distinct entries.
  const seenRequireUrls = new Set<string>();

  for (const ref of requireRefs) {
    const res = await loadRequire({
      ref,
      scriptFileUrl: args.scriptFileUrl,
      prior: args.priorRequires,
      recheck: args.recheck,
      fetchCache: args.fetchCache,
      now: args.now,
      seenUrls: seenRequireUrls,
    });
    if (res.errorMessage) {
      return { requires: [], resources: [], errorMessage: res.errorMessage };
    }
    if (res.entry) requires.push(res.entry);
  }

  for (const decl of resourceDecls) {
    const res = await loadResource({
      decl,
      scriptFileUrl: args.scriptFileUrl,
      prior: args.priorResources,
      recheck: args.recheck,
      fetchCache: args.fetchCache,
      now: args.now,
    });
    if (res.errorMessage) {
      return { requires: [], resources: [], errorMessage: res.errorMessage };
    }
    if (res.entry) resources.push(res.entry);
  }
  return { requires, resources };
}

// ---------- Per-kind loaders ----------

interface LoadResult<E> {
  entry?: E;
  errorMessage?: string;
}

interface LoadRequireArgs {
  ref: string;
  scriptFileUrl: string;
  prior: Map<string, StoredRequire>;
  recheck: 'all' | 'preserve';
  fetchCache: FileFetchCache;
  now: number;
  seenUrls: Set<string>;
}

async function loadRequire(args: LoadRequireArgs): Promise<LoadResult<StoredRequire>> {
  const resolved = resolveScriptResource(args.ref, args.scriptFileUrl);
  if (!resolved) {
    return { errorMessage: `@require ${args.ref}: blocked or invalid reference (must be http(s) or a relative path inside the script's directory)` };
  }
  if (resolved.kind === 'data') {
    return { errorMessage: `@require ${args.ref}: data: URLs are not supported` };
  }
  if (!isJsResourceUrl(resolved.url)) {
    return { errorMessage: `@require ${args.ref}: filename must end in .js` };
  }
  if (args.seenUrls.has(resolved.url)) return {};
  args.seenUrls.add(resolved.url);

  const prior = args.prior.get(resolved.url);
  if (args.recheck === 'preserve' && prior) {
    return { entry: prior };
  }

  const pending = ensureFetch(args.fetchCache, resolved.url);
  const got = await pending;
  if (isFailure(got)) {
    return { errorMessage: `@require ${args.ref}: ${got.errorMessage}` };
  }
  // @require-specific content-type predicate. Applied here (not in
  // the shared fetch) so a @require + @resource pair pointing at the
  // same URL share one fetch without the require's stricter rule
  // poisoning the resource's cache entry.
  if (got.contentType && !requireAcceptContentType(got.contentType)) {
    return { errorMessage: `@require ${args.ref}: response Content-Type "${got.contentType}" is not JavaScript or text` };
  }
  // Strict UTF-8 decode: catches binary smuggled past the `.js` URL
  // gate (e.g. a misconfigured CDN serving a PNG with the right
  // content-type). Previously we used fatal:false and the bytes were
  // mojibake'd into JS source, where they'd produce a confusing
  // SyntaxError at eval. This is the gate that closes that hole.
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(got.bytes);
  } catch {
    return { errorMessage: `@require ${args.ref}: response is not valid UTF-8 (binary or wrong-encoding file)` };
  }
  const u8 = new Uint8Array(got.bytes);
  const contentHash = await sha256HexOfBytes(got.bytes);
  const unchanged = prior?.contentHash === contentHash;
  const loadedAt = unchanged && prior ? prior.loadedAt : args.now;
  return {
    entry: {
      ref: args.ref,
      url: resolved.url,
      source,
      size: u8.byteLength,
      contentHash,
      contentType: got.contentType,
      loadedAt,
    },
  };
}

// Tightened from the prior accept list: dropped
// `application/octet-stream`. Combined with the `.js` URL gate it was
// a "give us anything binary" hole — and now the strict-UTF-8 decode
// would reject those anyway, but failing earlier with a clearer
// error is friendlier. Servers shipping JS as octet-stream are
// vanishingly rare and the user can route around them via a proxy.
const requireAcceptContentType = (ct: string): boolean =>
  ct.includes('javascript') || ct.startsWith('text/');

interface LoadResourceArgs {
  decl: ResourceDecl;
  scriptFileUrl: string;
  prior: Map<string, StoredResource>;
  recheck: 'all' | 'preserve';
  fetchCache: FileFetchCache;
  now: number;
}

async function loadResource(args: LoadResourceArgs): Promise<LoadResult<StoredResource>> {
  const resolved = resolveScriptResource(args.decl.ref, args.scriptFileUrl);
  if (!resolved) {
    return { errorMessage: `@resource ${args.decl.name}: blocked or invalid reference (must be http(s) or a relative path inside the script's directory)` };
  }
  if (resolved.kind === 'data') {
    return { errorMessage: `@resource ${args.decl.name}: data: URLs are not supported` };
  }
  // No suffix gate — resources can be any media type.
  // No URL-level dedup either: two `@resource` lines with different
  // names pointing at the same URL are intentional — we want two
  // distinct StoredResource entries so each name resolves to its own
  // GM_getResource* lookup. The shared FileFetchCache still ensures
  // we only fetch the URL once.

  // Prior lookup by URL.
  const prior = args.prior.get(resolved.url);
  if (args.recheck === 'preserve' && prior && prior.name === args.decl.name) {
    return { entry: prior };
  }

  // Resources accept anything — including HTML. A script that wants
  // to embed a fragment of HTML as a string via GM_getResourceText
  // shouldn't be blocked.
  const pending = ensureFetch(args.fetchCache, resolved.url);
  const got = await pending;
  if (isFailure(got)) {
    return { errorMessage: `@resource ${args.decl.name}: ${got.errorMessage}` };
  }
  const u8 = new Uint8Array(got.bytes);
  const contentHash = await sha256HexOfBytes(got.bytes);
  const unchanged = prior && prior.contentHash === contentHash && prior.name === args.decl.name;
  const loadedAt = unchanged && prior ? prior.loadedAt : args.now;
  return {
    entry: {
      ref: args.decl.ref,
      url: resolved.url,
      name: args.decl.name,
      bytesBase64: bytesToBase64(u8),
      size: u8.byteLength,
      contentHash,
      contentType: got.contentType,
      loadedAt,
    },
  };
}

// ---------- Shared byte fetcher ----------

function ensureFetch(
  cache: FileFetchCache,
  url: string,
): Promise<FetchedFile | FileFailure> {
  // The cache stores raw bytes + Content-Type, no kind-specific
  // filtering applied. Per-kind acceptance (the @require Content-Type
  // gate, the @require UTF-8 fatal decode, etc.) happens at the
  // typed call site after the cache hit. This way a @require + a
  // @resource pointing at the same URL share one fetch without
  // either's rules biasing the other's outcome.
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = fetchFileBytes(url);
  cache.set(url, promise);
  return promise;
}

async function fetchFileBytes(url: string): Promise<FetchedFile | FileFailure> {
  try {
    const res = await fetchResourceBytes(url, { maxBytes: MAX_FILE_BYTES });
    if (!res) {
      return {
        failed: true,
        errorMessage: 'fetch failed (network error, 404, or oversize)',
      };
    }
    return { bytes: res.body, contentType: res.contentType };
  } catch (err) {
    return {
      failed: true,
      errorMessage: `fetch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
