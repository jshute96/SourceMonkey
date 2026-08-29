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
//     via relative resolution, and a local script's relative ref may
//     not climb out of its own folder. data: rejected.
//   - Same byte fetcher with size cap.
//   - Same per-refresh cross-script fetch cache: two scripts (and
//     two refs of either kind) pointing at the same URL share one
//     fetch. The typed assembly happens after the cache hit.
//   - Any failure (resolve-time or fetch-time) returns an error
//     message; the caller flips the script to status:'invalid' with
//     the message and preserves prior-known-good state.

import {
  fetchResourceBytes,
  isNotModified,
  isJsResourceUrl,
  resolveScriptResourceDetailed,
  type FetchFailure,
  type ResolveFailure,
} from './file-loader.js';
import { localFileCandidates } from './local-file-overrides.js';
import { splitResourceValue } from './script-links.js';
import { sha256Hex, bytesToBase64, base64ToBytes } from './bytes.js';
import { timePhase } from './phase-timing.js';
import { getValues, type ParsedHeader } from './userscript-header.js';
import {
  isMarkupContentType,
  looksLikeMarkup,
  markupResponseMessage,
} from './markup-response.js';

// Per-file limit. Big enough for jQuery (~90 KB) and most chunky
// userscript libraries; small enough to keep a runaway from draining
// the 10 MB chrome.storage.local quota in one row. Applies to both
// @require and @resource — split caps possible later if pain shows up.
export const MAX_FILE_BYTES = 1024 * 1024;

// Rendered in whole MB when the cap divides evenly, so messages say
// "1 MB" rather than "1024 KB". Exported because the offline validator
// reports the cap too, and two renderings of one number could disagree.
export const CAP_TEXT = MAX_FILE_BYTES % (1024 * 1024) === 0
  ? `${MAX_FILE_BYTES / (1024 * 1024)} MB`
  : `${Math.round(MAX_FILE_BYTES / 1024)} KB`;

// Split out so `isFetchFailureMessage` can recognize the one message
// whose text isn't fixed at module load, without either side spelling
// the prefix twice.
const HTTP_STATUS_PREFIX = 'The server returned HTTP ';

// Why a dependency wouldn't load, as a sentence of its own that lands
// after the subject: `@require ./lib.js: ` + one of these.
//
// These used to be bare predicates (`is empty`, `could not be fetched:
// HTTP 404`) that only parsed as English once the subject was glued on.
// Each now carries its own subject so it reads as a sentence wherever
// it lands, and takes the capital every message takes — see
// [docs/diagnostics.md](../docs/diagnostics.md#wording). Dropping the
// `could not be fetched: ` half also drops a second colon from a string
// that already arrives after one.
//
// These read as facts rather than as a list of possibilities because
// the fetcher now reports which case it hit. It used to return a bare
// `null`, so a single message had to cover "no response", "an HTTP
// error", and "over the limit" at once — and the offline validator
// reconstructed the real cause from a fetch log to make its report
// useful.
export function describeFetchFailure(failure: FetchFailure): string {
  switch (failure.reason) {
    case 'unsupported-scheme':
      // Unreachable for a dependency — resolution rejects anything
      // that isn't http(s) or a contained relative path long before
      // the fetch. Kept for totality.
      return 'That URL scheme cannot be fetched';
    case 'no-response':
      return 'No response from the server';
    case 'timeout':
      return 'The request timed out';
    case 'unreadable-file':
      // The one fetch failure that still names two causes, because a
      // file:// read has no HTTP layer: "isn't there" and "can't be
      // read" arrive identically. Not a network problem either way,
      // which is what this case used to be reported as.
      return 'The file may not exist, or may not be readable';
    case 'http-error':
      return `${HTTP_STATUS_PREFIX}${failure.status}`;
    case 'wrong-content-type':
      // Only reachable through the icon fetcher, which discards the
      // reason — no user reads this today.
      return 'The response was the wrong content type';
    case 'empty':
      return 'The file is empty';
    case 'oversize':
      return `The file is larger than the ${CAP_TEXT} limit`;
  }
}

// Every `FetchFailReason`, so the predicate below can't silently stop
// covering one. `FetchFailure` is a discriminated union, not an enum,
// so there is no runtime list to derive this from.
//
// A `Record` keyed by the union rather than an array: a `Record` is
// missing-key-checked, so adding a `FetchFailReason` without a line
// here fails the build. An array — even `as const satisfies
// readonly FetchFailure['reason'][]` — only checks that each entry IS a
// reason, never that none is missing, which is the direction that
// matters. A missed reason wouldn't throw; it would quietly stop being
// recognized, and the validator would mislabel that bucket.
const FETCH_FAILURE_REASONS: Record<FetchFailure['reason'], true> = {
  'unsupported-scheme': true,
  'no-response': true,
  'timeout': true,
  'unreadable-file': true,
  'http-error': true,
  'wrong-content-type': true,
  'empty': true,
  'oversize': true,
};

// Did this text come out of `describeFetchFailure`?
//
// Exists for `scripts/validate-userscripts.mjs`, which substitutes its
// own wording when the offline mirror's 404 is an artifact of the
// mirror rather than a real server answer — it has to recognize a
// fetch-layer failure to know when that substitution applies.
//
// A predicate rather than a regex over the wording: these strings are
// user-facing and get reworded, and a pattern living in the validator
// would go stale silently (it did — it matched a `could not be
// fetched: ` prefix that no longer exists).
export function isFetchFailureMessage(text: string): boolean {
  // `http-error` first and separately: its text carries the status, so
  // it's the one case that can't be compared against a fixed string.
  if (text.startsWith(HTTP_STATUS_PREFIX)) return true;
  const reasons = Object.keys(FETCH_FAILURE_REASONS) as (keyof typeof FETCH_FAILURE_REASONS)[];
  return reasons.some((reason) => {
    if (reason === 'http-error') return false;
    return describeFetchFailure({ failed: true, reason }) === text;
  });
}

// Why a ref couldn't be resolved to something fetchable. Same shape:
// a sentence that follows the subject, not a predicate glued to it.
export function describeResolveFailure(failure: ResolveFailure): string {
  switch (failure.reason) {
    case 'empty':
      // Unreachable — `distillRequires` / `distillResources` drop empty
      // refs before a loader sees one. Kept for totality.
      return 'The tag has no reference after it';
    case 'malformed-url':
      return 'The reference is not a valid URL';
    case 'unsupported-scheme':
      // Names what the author actually wrote. `file:` reaches this on
      // purpose — an absolute local path is not accepted even from a
      // local script (see file-loader.ts's module header). The scheme
      // is parenthesized rather than leading, so the sentence can open
      // with a capital of ours instead of a verbatim value.
      return `That URL scheme (${failure.scheme}) is not supported — ` +
        'use an http(s) URL, or a relative path resolved against the script\'s own location';
    case 'outside-script-folder':
      // Only reachable for a script loaded from `file://`: a relative
      // ref in a script served over http(s) may climb, the way it does
      // in Violentmonkey. So the message names the case it applies to
      // rather than stating a rule that isn't universal.
      return 'That path points outside the script\'s own folder — ' +
        'a relative path in a local script has to stay inside it';
  }
}

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
  // content change so the collections-page row-highlight stays
  // accurate.
  loadedAt: number;
  // The local file we actually read instead of `url`, when a stand-in
  // was found under one of the script's local search roots. Absent
  // whenever the declared URL is what was fetched — which is the normal
  // case, so its presence is exactly "this entry was overridden".
  //
  // `url` deliberately keeps the DECLARED URL even then: it is the dedup
  // key, it is what the script says it depends on, and it is what the
  // entry falls back to the moment the local file goes away.
  localUrl?: string;
  // Server-reported (lowercased) Content-Type, or '' when not
  // available (file:// XHR often omits it). Optional on
  // StoredRequire because pre-this-change stored rows won't carry
  // it; required on StoredResource because the field is load-bearing
  // for blob URL creation.
  contentType?: string;
  // HTTP validators (http(s) only), sent back as `If-None-Match` /
  // `If-Modified-Since` on the next explicit Refresh. Absent for
  // file://, for a local stand-in, and for servers that offer neither.
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
  // Set when these bytes came from the caller's own prior copy because
  // the server answered 304 — carrying the hash that prior was stored
  // under, so a loader can tell "this is MY unchanged copy" from "these
  // are someone else's bytes off the shared cache". See `loadRequire`.
  priorContentHash?: string;
  // Validators to send on the NEXT refresh's conditional request.
  // Absent for file://, for servers that offer neither, and on the
  // 304 path — where they are carried over from the prior entry by
  // `ensureFetch` instead, since a 304 body has no headers worth
  // keeping beyond what we already stored.
  etag?: string;
  lastModified?: string;
}

// What a caller already holds for a URL, so the fetch can be made
// conditional. `bytes` is required, not optional: a 304 transfers no
// body, so a caller that can't produce the prior bytes has nothing to
// resolve the shared cache entry with and must not ask for one.
export interface PriorCopy {
  etag?: string;
  lastModified?: string;
  bytes: ArrayBuffer;
  contentType: string;
  // What this copy is stored under, echoed back on the 304 path.
  contentHash: string;
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
  // Ordered local directories searched for a stand-in before the
  // declared URL is fetched — see `src/local-file-overrides.ts`. Empty (the
  // default) restores the pre-feature behavior exactly: no candidate
  // generation, no probe reads.
  localRoots?: readonly string[];
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
      localRoots: args.localRoots ?? [],
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
      localRoots: args.localRoots ?? [],
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
  localRoots: readonly string[] = [],
): Promise<StoredRequire> {
  const res = await loadRequire({
    ref,
    scriptFileUrl,
    prior: new Map(),
    recheck: 'all',
    fetchCache,
    now,
    localRoots,
    // Fresh per call: dedup across refs is the batch loader's job, and
    // the preview shows one tab per declared ref.
    seenUrls: new Set(),
  });
  if (res.errorMessage) throw new Error(res.errorMessage);
  // Defensive: `loadRequire` returns neither an entry nor an error only
  // when it skipped the fetch (a URL already seen this pass, or a
  // preserved prior), and this call can do neither — fresh `seenUrls`,
  // empty `prior`, `recheck: 'all'`. So it says nothing about the file.
  if (!res.entry) throw new Error(`@require ${ref}: Internal error: no content and no reason`);
  return res.entry;
}

// ---------- Per-kind loaders ----------

interface LoadResult<E> {
  entry?: E;
  errorMessage?: string;
}

// What we actually read for a declared URL, and from where.
interface LoadedBytes {
  // Set only when the bytes came from a local stand-in rather than the
  // declared URL, so callers can record it without re-deriving the
  // comparison. Absent means "the declared URL was fetched".
  localUrl?: string;
  got: FetchedFile | FileFailure;
}

// Read a declared file, preferring a local stand-in when one exists.
//
// Candidates are tried in order and the first that READS wins — the
// probe and the real read are the same fetch, so a hit costs nothing
// extra. A total miss costs one local read PER CANDIDATE, i.e. one per
// path segment of the declared URL plus one for the host-qualified
// form, not one overall. `ensureFetch`
// caches those for the rest of the pass, misses included.
//
// Returns `null` when no stand-in was found, so the caller can take its
// `recheck: 'preserve'` shortcut on the declared URL. That ordering is
// deliberate: a stand-in is checked on EVERY refresh, including
// opportunistic ones, so editing a local library shows up on the next
// navigation — while a remote dependency still gets the cached-and-left-
// alone treatment that keeps per-navigation cost bounded.
//
// A `null` here does NOT mean the caller can preserve any prior: a prior
// that itself carries a `localUrl` describes a file we just failed to
// find, so keeping it would serve a deleted stand-in indefinitely. Each
// caller's preserve shortcut checks for that.
async function readLocalStandIn(
  declaredUrl: string,
  localRoots: readonly string[],
  fetchCache: FileFetchCache,
): Promise<LoadedBytes | null> {
  for (const candidate of localFileCandidates(declaredUrl, localRoots)) {
    const got = await ensureFetch(fetchCache, candidate);
    // A candidate that doesn't read isn't a failure — it just isn't
    // there. Only an actual hit ends the search.
    if (!isFailure(got)) return { localUrl: candidate, got };
  }
  return null;
}

interface LoadRequireArgs {
  ref: string;
  scriptFileUrl: string;
  prior: Map<string, StoredRequire>;
  recheck: 'all' | 'preserve';
  fetchCache: FileFetchCache;
  now: number;
  seenUrls: Set<string>;
  localRoots: readonly string[];
}

async function loadRequire(args: LoadRequireArgs): Promise<LoadResult<StoredRequire>> {
  const resolved = resolveScriptResourceDetailed(args.ref, args.scriptFileUrl);
  if ('failed' in resolved) {
    return { errorMessage: `@require ${args.ref}: ${describeResolveFailure(resolved)}` };
  }
  if (resolved.kind === 'data') {
    return { errorMessage: `@require ${args.ref}: URLs with the data: scheme are not supported` };
  }
  if (!isJsResourceUrl(resolved.url)) {
    return { errorMessage: `@require ${args.ref}: The filename must end in .js` };
  }
  if (args.seenUrls.has(resolved.url)) return {};
  args.seenUrls.add(resolved.url);

  const prior = args.prior.get(resolved.url);

  // Local stand-in first, and before the preserve shortcut — see
  // `readLocalStandIn` for why an overridden file is never cached past
  // a refresh.
  const local = await timePhase('local-standin', () => readLocalStandIn(resolved.url, args.localRoots, args.fetchCache));
  if (!local && args.recheck === 'preserve' && prior && !prior.localUrl) {
    return { entry: prior };
  }

  const loaded = local ?? {
    got: await ensureFetch(args.fetchCache, resolved.url, priorCopyOf(prior, priorRequireBytes(prior))),
  };
  const got = loaded.got;
  if (isFailure(got)) {
    return { errorMessage: `@require ${args.ref}: ${got.errorMessage}` };
  }
  // The server answered 304 against OUR validator, so the copy we hold
  // IS the current one — reuse it whole.
  //
  // Not merely an optimisation (though it does drop a SHA-256 per
  // dependency per manual refresh). Rebuilding from the reconstructed
  // bytes would be wrong: `source` was decoded with a BOM-stripping
  // decoder, so re-encoding it does not reproduce the original bytes
  // for a BOM-prefixed file. That would hash differently, bump
  // `loadedAt`, shrink the stored `size` by three, and report a content
  // change the server just told us did not happen.
  //
  // Matched on the hash rather than on "did we send a validator",
  // because the shared cache may have resolved this URL from ANOTHER
  // script's prior. Equal hashes mean equal content, so reusing this
  // caller's own row is right; unequal means these are someone else's
  // bytes and the normal path below has to run.
  if (prior && got.priorContentHash !== undefined && got.priorContentHash === prior.contentHash) {
    return { entry: { ...prior, ref: args.ref, url: resolved.url, ...validatorFields(got) } };
  }
  // @require-specific markup gate. Applied here (not in the shared
  // fetch) so a @require + @resource pair pointing at the same URL
  // share one fetch without the require's stricter rule poisoning the
  // resource's cache entry — a `@resource` may legitimately BE an HTML
  // file.
  //
  // Only markup is rejected. `application/octet-stream` and other
  // vague types are accepted on purpose — they are common and
  // legitimate for JavaScript (GitHub serves every release asset that
  // way, and release URLs are a normal thing to pin a library to), and
  // the strict-UTF-8 decode below is what actually closes the
  // "anything binary gets through" hole. Tampermonkey does no
  // content-type gating on `@require` at all.
  if (isMarkupContentType(got.contentType)) {
    return {
      errorMessage: `@require ${args.ref}: ${markupResponseMessage({
        ...(loaded.localUrl ? { localUrl: loaded.localUrl } : {}),
        contentType: got.contentType,
      })}`,
    };
  }
  // Strict UTF-8 decode: catches binary regardless of what the server
  // claimed the type was (a misconfigured CDN serving a PNG, or the
  // generic octet-stream the markup gate deliberately lets
  // through). Previously we used fatal:false and the bytes were
  // mojibake'd into JS source, where they'd produce a confusing
  // SyntaxError at eval. This is the gate that closes that hole.
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(got.bytes);
  } catch {
    return { errorMessage: `@require ${args.ref}: The response is not valid UTF-8 (binary or wrong-encoding file)` };
  }
  // Second half of the same gate, on the bytes rather than the header.
  // The Content-Type test above can't fire when there is no
  // Content-Type — the common `file://` case, which is exactly where a
  // directory-listing HTML page comes from — nor when a server labels
  // its login page `text/plain`.
  if (looksLikeMarkup(source)) {
    return {
      errorMessage: `@require ${args.ref}: ${markupResponseMessage({
        ...(loaded.localUrl ? { localUrl: loaded.localUrl } : {}),
      })}`,
    };
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
      // Spread rather than assigned so the field is ABSENT (not
      // `undefined`) on the ordinary path — stored rows are compared
      // and JSON-round-tripped, and an explicit `undefined` would
      // survive as a key in some of those comparisons.
      ...(loaded.localUrl ? { localUrl: loaded.localUrl } : {}),
      ...validatorFields(got),
    },
  };
}

// The prior copy's bytes, for a conditional request. `source` was
// decoded from those bytes with a strict UTF-8 decoder, so re-encoding
// reproduces them exactly.
function priorRequireBytes(prior: StoredRequire | undefined): ArrayBuffer | null {
  if (!prior) return null;
  return new TextEncoder().encode(prior.source).buffer as ArrayBuffer;
}

// The prior copy's bytes, decoded back from storage.
function priorResourceBytes(prior: StoredResource | undefined): ArrayBuffer | null {
  if (!prior) return null;
  return base64ToBytes(prior.bytesBase64);
}

// Assemble the conditional-request input, or nothing when this entry
// can't support one.
//
// Withheld for a local stand-in (`localUrl`): the bytes we hold came
// off disk, and the validators — if any survived — describe the remote
// copy, so pairing them would ask the server about one file and answer
// with another.
function priorCopyOf(
  prior: {
    httpEtag?: string;
    httpLastModified?: string;
    contentType?: string;
    contentHash: string;
    localUrl?: string;
  } | undefined,
  bytes: ArrayBuffer | null,
): PriorCopy | undefined {
  if (!prior || !bytes) return undefined;
  if (prior.localUrl) return undefined;
  if (!prior.httpEtag && !prior.httpLastModified) return undefined;
  // Without a Content-Type the prior can't fully stand in for a
  // response. `StoredRequire.contentType` is optional — rows written
  // before it existed don't carry one — and a 304 resolved from such a
  // row would hand `''` to every sharer of that URL through the fetch
  // cache, including a `@resource` whose blob URL needs a real MIME.
  // Refetching unconditionally costs one body and keeps that honest.
  if (!prior.contentType) return undefined;
  return {
    bytes,
    contentType: prior.contentType,
    contentHash: prior.contentHash,
    ...(prior.httpEtag ? { etag: prior.httpEtag } : {}),
    ...(prior.httpLastModified ? { lastModified: prior.httpLastModified } : {}),
  };
}

// Validators onto the stored entry, absent rather than `undefined` for
// the same reason `localUrl` is spread above.
function validatorFields(got: FetchedFile): {
  httpEtag?: string;
  httpLastModified?: string;
} {
  return {
    ...(got.etag ? { httpEtag: got.etag } : {}),
    ...(got.lastModified ? { httpLastModified: got.lastModified } : {}),
  };
}

interface LoadResourceArgs {
  decl: ResourceDecl;
  scriptFileUrl: string;
  prior: Map<string, StoredResource>;
  recheck: 'all' | 'preserve';
  fetchCache: FileFetchCache;
  now: number;
  localRoots: readonly string[];
}

async function loadResource(args: LoadResourceArgs): Promise<LoadResult<StoredResource>> {
  // A `@resource` line carries a name AND a ref, and the name alone
  // doesn't say what failed to load. `@require` names its ref because
  // that is all it has; this names both.
  const subject = `@resource ${args.decl.name} (${args.decl.ref})`;
  const resolved = resolveScriptResourceDetailed(args.decl.ref, args.scriptFileUrl);
  if ('failed' in resolved) {
    return { errorMessage: `${subject}: ${describeResolveFailure(resolved)}` };
  }
  if (resolved.kind === 'data') {
    return { errorMessage: `${subject}: URLs with the data: scheme are not supported` };
  }
  // No suffix gate — resources can be any media type.
  // No URL-level dedup either: two `@resource` lines with different
  // names pointing at the same URL are intentional — we want two
  // distinct StoredResource entries so each name resolves to its own
  // GM_getResource* lookup. The shared FileFetchCache still ensures
  // we only fetch the URL once.

  // Prior lookup by URL.
  const prior = args.prior.get(resolved.url);

  // Local stand-in first, and before the preserve shortcut — same rule
  // and same reasoning as `@require`; see `readLocalStandIn`.
  const local = await timePhase('local-standin', () => readLocalStandIn(resolved.url, args.localRoots, args.fetchCache));
  if (
    !local && args.recheck === 'preserve' &&
    prior && prior.name === args.decl.name && !prior.localUrl
  ) {
    return { entry: prior };
  }

  // Resources accept anything — including HTML. A script that wants
  // to embed a fragment of HTML as a string via GM_getResourceText
  // shouldn't be blocked.
  const loaded = local ?? {
    got: await ensureFetch(args.fetchCache, resolved.url, priorCopyOf(prior, priorResourceBytes(prior))),
  };
  const got = loaded.got;
  if (isFailure(got)) {
    return { errorMessage: `${subject}: ${got.errorMessage}` };
  }
  // Same 304 reuse as `loadRequire`. The name has to match too: a
  // `@resource` renamed to the same URL is a changed declaration even
  // though the body is identical, and the normal path below is what
  // stamps the new name and bumps `loadedAt`.
  if (
    prior && prior.name === args.decl.name &&
    got.priorContentHash !== undefined && got.priorContentHash === prior.contentHash
  ) {
    return {
      entry: { ...prior, ref: args.decl.ref, url: resolved.url, ...validatorFields(got) },
    };
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
      ...(loaded.localUrl ? { localUrl: loaded.localUrl } : {}),
      ...validatorFields(got),
    },
  };
}

// ---------- Shared byte fetcher ----------

// `prior` is used only by the FIRST caller to ask for a given URL —
// whoever populates the cache entry. A later caller sharing the URL
// takes that entry as-is.
//
// That is safe even when the two hold different copies, because a 304
// resolves to the prior's BYTES rather than to a "nothing changed"
// marker. The cache entry always means "the current bytes for this
// URL", however they were obtained, so a script with no prior of its
// own still gets a body it can build from.
function ensureFetch(
  cache: FileFetchCache,
  url: string,
  prior?: PriorCopy,
): Promise<FetchedFile | FileFailure> {
  // The cache stores raw bytes + Content-Type, no kind-specific
  // filtering applied. Per-kind acceptance (the @require Content-Type
  // gate, the @require UTF-8 fatal decode, etc.) happens at the
  // typed call site after the cache hit. This way a @require + a
  // @resource pointing at the same URL share one fetch without
  // either's rules biasing the other's outcome.
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = timePhase('dep-fetch', () => fetchFileBytes(url, prior));
  cache.set(url, promise);
  return promise;
}

async function fetchFileBytes(
  url: string,
  prior?: PriorCopy,
): Promise<FetchedFile | FileFailure> {
  try {
    const res = await fetchResourceBytes(url, {
      maxBytes: MAX_FILE_BYTES,
      // Only conditional when we hold a validator to offer. A bare
      // prior with neither would send no header and just refetch.
      ...(prior && (prior.etag ?? prior.lastModified)
        ? { conditional: { etag: prior.etag, lastModified: prior.lastModified } }
        : {}),
    });
    if ('failed' in res) {
      return { failed: true, errorMessage: describeFetchFailure(res) };
    }
    if (isNotModified(res)) {
      // Unreachable without a prior — `conditional` is only set above
      // when one exists — but the type doesn't know that, and resolving
      // to the prior's bytes is what makes the shared cache entry mean
      // the same thing on both paths.
      if (!prior) {
        return {
          failed: true,
          errorMessage: 'Internal error: the server reported no change for a file we do not hold',
        };
      }
      // Validators carried forward, not re-read: a 304 need not repeat
      // them, and the ones we sent are by definition still current.
      const out: FetchedFile = {
        bytes: prior.bytes,
        contentType: prior.contentType,
        priorContentHash: prior.contentHash,
      };
      if (prior.etag) out.etag = prior.etag;
      if (prior.lastModified) out.lastModified = prior.lastModified;
      return out;
    }
    const out: FetchedFile = { bytes: res.body, contentType: res.contentType };
    if (res.etag) out.etag = res.etag;
    if (res.lastModified) out.lastModified = res.lastModified;
    return out;
  } catch (err) {
    return {
      failed: true,
      // NOT a `describeFetchFailure` string, deliberately.
      // `fetchResourceBytes` reports every fetch outcome as a
      // `FetchFailure` return and does not throw, so reaching here means
      // our own code broke its contract — which is what the reader is
      // being told, and why `isFetchFailureMessage` correctly declines
      // it. Phrasing it as one of the fetch failures would both invite
      // the offline validator to substitute mirror wording for a bug of
      // ours, and put a second `could not be fetched: ` colon into a
      // string that already lands after `@require <ref>: `.
      errorMessage: `Internal error: the file fetcher failed unexpectedly (${
        err instanceof Error ? err.message : String(err)})`,
    };
  }
}
