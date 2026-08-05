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
//     message; the caller flips the script to status:'invalid' with
//     the message and preserves prior-known-good state.

import {
  fetchResourceBytes,
  isJsResourceUrl,
  resolveScriptResource,
} from './file-loader.js';
import { splitResourceValue } from './script-links.js';
import { sha256Hex, bytesToBase64 } from './bytes.js';
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
  // content change so the sources-page row-highlight stays accurate.
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
  // to status:'invalid' with this message. Partial lists aren't
  // useful for injection so we return empty arrays alongside.
  errorMessage?: string;
  // Line in the SCRIPT's own source that declared the file that failed.
  // The file itself never loaded, so it has no content to point into —
  // the `@require` / `@resource` line is the only place the reader can
  // actually go and act on. Absent when the declaration can't be
  // located (a header parsed before line numbers were recorded).
  errorLine?: number;
}

// Find the header line that declared a file, so a load failure can
// point at it. Matching is on the declaration's own text rather than
// on the resolved URL: resolution is exactly what may have failed, and
// the line the user has to edit is the one they wrote.
//
// Localized forms (`@require:de`) are skipped for the same reason
// `getValues` skips them — they are not the declarations that were
// loaded.
function declarationLine(
  header: ParsedHeader | null,
  tag: 'require' | 'resource',
  matches: (value: string) => boolean,
): number | undefined {
  if (!header) return undefined;
  for (const t of header.tags) {
    if (t.tag !== tag || t.locale) continue;
    if (matches(t.value.trim())) return t.line;
  }
  return undefined;
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
      return {
        requires: [],
        resources: [],
        errorMessage: res.errorMessage,
        errorLine: declarationLine(args.header, 'require', (v) => v === ref),
      };
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
      return {
        requires: [],
        resources: [],
        errorMessage: res.errorMessage,
        // Matched on NAME, which is what `distillResources` dedups on,
        // so the line found is the declaration that was actually
        // loaded rather than a later one the loader ignored.
        errorLine: declarationLine(
          args.header,
          'resource',
          (v) => splitResourceValue(v)?.prefix.trim() === decl.name,
        ),
      };
    }
    if (res.entry) resources.push(res.entry);
  }
  return { requires, resources };
}

// Fetch a single `@require` the way `attachFiles` would, for one
// preview TAB: the tabs are built from the header and render one body
// each, so a tab can't use the batch orchestrator (which returns all
// files or an error). The preview's parse check does use `attachFiles`
// — this is the per-tab path only, and the shared `fetchCache` means
// whichever runs first pays for the fetch. Routing through the same
// `loadRequire` keeps the validation and the error wording identical
// to what installing the script would produce.
//
// Throws (rather than returning an error field) because the caller is
// a lazy tab body, and a rejected promise is what the tab view renders
// as a load failure.
export async function fetchRequireForPreview(
  ref: string,
  scriptFileUrl: string,
  fetchCache: FileFetchCache,
  now: number,
): Promise<StoredRequire> {
  const res = await loadRequire({
    ref,
    scriptFileUrl,
    prior: new Map(),
    recheck: 'all',
    fetchCache,
    now,
    // Fresh per call: dedup across refs is the batch loader's job, and
    // the preview shows one tab per declared ref.
    seenUrls: new Set(),
  });
  if (res.errorMessage) throw new Error(res.errorMessage);
  if (!res.entry) throw new Error(`@require ${ref}: no content`);
  return res.entry;
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
  // No empty-string guard needed: an absent Content-Type (the file://
  // XHR case) is accepted by the predicate like any other non-markup
  // type.
  if (!requireAcceptContentType(got.contentType)) {
    return { errorMessage: `@require ${args.ref}: response is an HTML page (Content-Type "${got.contentType}"), not JavaScript` };
  }
  // Strict UTF-8 decode: catches binary regardless of what the server
  // claimed the type was (a misconfigured CDN serving a PNG, or the
  // generic octet-stream the content-type gate deliberately lets
  // through). Previously we used fatal:false and the bytes were
  // mojibake'd into JS source, where they'd produce a confusing
  // SyntaxError at eval. This is the gate that closes that hole.
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(got.bytes);
  } catch {
    return { errorMessage: `@require ${args.ref}: response is not valid UTF-8 (binary or wrong-encoding file)` };
  }
  const u8 = new Uint8Array(got.bytes);
  const contentHash = await sha256Hex(got.bytes);
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

// A denylist of markup types, not an allowlist. HTML is the only
// family worth rejecting: a `@require` is always JavaScript, never
// markup, so an HTML response is the classic soft-failure signature —
// a login / error page served at 200 in place of the real library.
// Rejecting it turns that into a clean fetch failure, which the
// refresh pipeline treats as a refresh failure (keep the prior good
// copy running) rather than silently swapping a working dependency for
// a page of markup. `text/html-sandboxed` is caught by the prefix and
// deserves to be; XHTML is spelled `application/xhtml+xml`, so it
// needs its own clause to match the same intent.
//
// `application/json` is deliberately *not* rejected: a JSON error
// envelope at 200 is a real soft-failure shape, but so is a legitimate
// JS module served by a mislabelling host, and the eval-side try/catch
// already contains the damage.
//
// Everything else is accepted, including `application/octet-stream`.
// That used to be rejected as a "give us anything binary" hole next to
// the suffix-only `.js` URL gate, but the strict-UTF-8 decode below is
// what actually closes that hole — and the generic type is common in
// practice, not exotic: GitHub serves *every* release asset as
// octet-stream regardless of extension, and release URLs are a normal
// place for a userscript to pin a library. Tampermonkey does no
// content-type gating on `@require` at all.
//
// Trims defensively so the rule holds for a caller that hands over a
// raw header rather than the lowercased/trimmed one every producer in
// file-loader.ts currently passes.
const requireAcceptContentType = (ct: string): boolean => {
  const type = ct.trim();
  return !type.startsWith('text/html') && !type.startsWith('application/xhtml');
};

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
  const contentHash = await sha256Hex(got.bytes);
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
