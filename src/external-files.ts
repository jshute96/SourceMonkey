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
//   - Any URL, with or without a `.js` suffix (CDN shorthands like
//     `cdn.jsdelivr.net/npm/sweetalert2@11` have none, and TM and VM
//     don't gate on it). Strict UTF-8 decode on the fetched bytes —
//     non-UTF-8 fails the script outright. We never inject binary as
//     JS.
//
// `@resource`:
//   - Arbitrary bytes (any media type). Stored as base64 so the
//     chrome.storage.local JSON layer can carry them.
//   - Exposed to userscripts at runtime via GM_getResourceText
//     (UTF-8 decode on demand, mojibake-tolerant) and
//     GM_getResourceURL (blob: URL minted in the page with the
//     fetched content-type, or a data: URL given `false`).
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
//   - A `@require` failure (resolve-time or fetch-time) returns an error
//     message; the caller flips the script to status:'invalid' with
//     the message and preserves prior-known-good state. So does a
//     `@resource` that fails with a good copy held. Otherwise a
//     `@resource` failure is a `ResourceProblem`, and the script runs
//     without the file.

import {
  fetchResourceBytes,
  isNotModified,
  resolveScriptResourceDetailed,
  type FetchFailure,
  type ResolveFailure,
} from './file-loader.js';
import {
  localCandidateMayExist,
  localFileCandidatesDetailed,
  type LocalLookup,
} from './local-file-overrides.js';
import { type DirectoryListingCache } from './file-locations.js';
import { splitResourceValue } from './script-links.js';
import { sha256Hex, bytesToBase64, base64ToBytes, decodeDataUrl } from './bytes.js';
import { timePhase } from './phase-timing.js';
import { getValues, type ParsedHeader } from './userscript-header.js';
import { iconDeclFromHeader, isIconContentType, MAX_ICON_BYTES } from './script-icon.js';
import {
  isMarkupContentType,
  looksLikeMarkup,
  markupResponseMessage,
} from './markup-response.js';

// Per-file limit. Big enough for jQuery (~90 KB) and the 1-2 MB
// libraries scripts pin (MathJax, video.js, babel-standalone, the
// stockfish engines); small enough to keep a runaway from draining the
// 10 MB chrome.storage.local quota in one row. Applies to both
// @require and @resource.
//
// This is the extension's limit. The tools run this pipeline too, but
// `prepareScript` lifts the limit there (`setFileByteLimit`): another
// manager has limits of its own, and under SourceMonkey the extension
// refuses the file when the script reaches it.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

let fileByteLimit = MAX_FILE_BYTES;

// What `validate` warns of, since it doesn't apply the limit itself: the
// extension refuses such a file, and another manager may take it.
export function overFileLimitWarning(kind: 'require' | 'resource'): string {
  const outcome = kind === 'require' ? 'so SourceMonkey refuses it' : 'so SourceMonkey doesn\'t load it, and the script gets an empty string';
  return `The file is larger than SourceMonkey's ${byteLimitText(MAX_FILE_BYTES)} limit, ${outcome}. Other managers may accept it.`;
}

// The limit on `@require` and `@resource` fetches from here on.
export function setFileByteLimit(maxBytes: number): void {
  fileByteLimit = maxBytes;
}

// Rendered in whole MB when the cap divides evenly, so messages say
// "1 MB" rather than "1024 KB".
function byteLimitText(maxBytes: number): string {
  return maxBytes % (1024 * 1024) === 0
    ? `${maxBytes / (1024 * 1024)} MB`
    : `${Math.round(maxBytes / 1024)} KB`;
}

// Why a `data:` URL dependency won't load: its payload didn't decode
// (no comma, or bad base64). Exported so the corpus validator can
// recognize it without matching the wording.
export const BAD_DATA_URL = 'The data: URL could not be decoded';

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
// error", and "over the limit" at once — and the corpus validator
// reconstructed the real cause from a fetch log to make its report
// useful.
//
// `maxBytes` is the limit the fetch was made with, for the oversize
// message: `@require` / `@resource` by default, smaller for an `@icon`.
export function describeFetchFailure(failure: FetchFailure, maxBytes = MAX_FILE_BYTES): string {
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
      // Only the icon fetches ask for a content type.
      return 'The file is not an image';
    case 'empty':
      return 'The file is empty';
    case 'oversize':
      return `The file is larger than the ${byteLimitText(maxBytes)} limit`;
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
// Exists for the corpus validator
// (`greasyfork-testing/validate-corpus.mjs`), which substitutes
// its own wording when the offline mirror's 404 is an artifact of the
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
      return `That URL scheme (${failure.scheme}) is not supported; ` +
        'use an http(s) URL, or a relative path resolved against the script\'s own location';
    case 'outside-script-folder':
      // Only reachable for a script loaded from `file://`: a relative
      // ref in a script served over http(s) may climb, the way it does
      // in Violentmonkey. So the message names the case it applies to
      // rather than stating a rule that isn't universal.
      return 'That path points outside the script\'s own folder; ' +
        'a relative path in a local script has to stay inside it';
    case 'relative-in-scratch':
      // A scratch script is text alone, without the files beside it.
      return 'A scratch script can use a relative path only to a file pushed along with its text. ' +
        'Use an http(s) URL, or push the file with the script.';
    case 'relative-in-imported':
      return 'An imported script can use a relative path only to a file imported along with it. ' +
        'Use an http(s) URL, or import a backup that includes the file.';
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
  // The stand-in's listing mtime when it was read, so a page can tell
  // an edited stand-in from the one it holds without re-reading it
  // (file-changes.ts). Only ever set beside `localUrl`.
  fsMtime?: number;
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
  // A `file://` read's modified time, in listing units. See
  // `fsMtimeFromLastModified`.
  fsMtime?: number;
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
  // Which download failure it was, when the download is what failed.
  reason?: FetchFailure['reason'];
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

// A `@require` / `@resource` body pushed with a scratch script, by the
// ref its header declares (sm-dev reads them from disk, see
// docs/sm-dev-design.md), or held in a backup for an imported one
// (docs/import.md). It stands in for the declared file, and no fetch is
// made:
// - a relative ref, which a scratch script has no folder to resolve
//   against: `url` is the `file://` URL it named on disk;
// - a remote URL with a local stand-in under one of sm-dev's search
//   roots: `url` is the declared URL, `localUrl` the file read.
export interface PushedFile {
  url: string;
  localUrl?: string;
  bytesBase64: string;
  contentType: string;
  // Set instead of a body when this `@resource` can't be had: sm-dev
  // couldn't read it, or it's over the extension's limit. Why, as
  // `ResourceProblem` words it.
  failure?: { detail: string; reason?: FetchFailure['reason'] };
}

// A declared `@resource` that didn't load. The script still runs, with
// the getters answering "" for that name (docs/resources.md#failure-handling).
export interface ResourceProblem {
  name: string;
  ref: string;
  // Absent when the ref itself was refused.
  url?: string;
  // Why, as a message of its own; see `resourceProblemMessage`.
  detail: string;
  // Which download failure it was, when the download is what failed.
  failure?: FetchFailure['reason'];
  // Set when the failure may pass on its own (no response, a timeout),
  // so a background refresh looks again rather than keeping it.
  retry?: true;
}

export function resourceProblemMessage(problem: Pick<ResourceProblem, 'name' | 'ref' | 'detail'>): string {
  return `@resource ${problem.name} (${problem.ref}): ${problem.detail}`;
}

// What the script's Log says when the script asks for this resource. A
// detail may already end in a period, as a message of two sentences does.
export function resourceAskedMessage(api: string, problem: Pick<ResourceProblem, 'name' | 'ref' | 'detail'>): string {
  const message = resourceProblemMessage(problem);
  return `${api} returned an empty string. ${message}${message.endsWith('.') ? '' : '.'}`;
}

// An over-limit file is an error: it fails on every load until the
// script changes. Other failures can come right by themselves, or are
// outside the author's hands.
export function resourceProblemLevel(problem: Pick<ResourceProblem, 'failure'>): 'warn' | 'error' {
  return problem.failure === 'oversize' ? 'error' : 'warn';
}

// The header line that declared a `@resource`. Matched on NAME, which is
// what `distillResources` dedups on, so the line found is the declaration
// that was actually loaded rather than a later one the loader ignored.
export function resourceDeclarationLine(header: ParsedHeader | null, name: string): number | undefined {
  return declarationLine(header, 'resource', (v) => splitResourceValue(v)?.prefix.trim() === name);
}

export interface AttachFilesArgs {
  // The script's own canonical URL. Resolution base for relative refs.
  scriptFileUrl: string;
  header: ParsedHeader | null;
  // Prior typed entries from the last successful build, keyed by
  // canonical URL. Used for the recheck:'preserve' fast path and for
  // loadedAt preservation when the freshly fetched bytes are unchanged.
  priorRequires: Map<string, StoredRequire>;
  priorResources: Map<string, StoredResource>;
  // The problems the last build found, by name, for 'preserve' to keep.
  priorResourceProblems?: Map<string, ResourceProblem>;
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
  // How a stand-in found by the last check is looked for. 'known'
  // reads its stored path first and lists nothing when it still reads;
  // 'search' (the default) searches the roots in order. See
  // `readLocalStandIn`.
  localLookup?: LocalLookup;
  // A scratch or imported script's pushed bodies, by ref; see `PushedFile`.
  pushedFiles?: Readonly<Record<string, PushedFile>>;
}

export interface AttachFilesResult {
  requires: StoredRequire[];
  resources: StoredResource[];
  // The `@resource` files that didn't load, when the script has no
  // earlier copy of them. These don't stop the script.
  resourceProblems?: ResourceProblem[];
  // Set when a `@require` failed, or a `@resource` the script already
  // holds a good copy of. The caller flips the script to status:'invalid'
  // with this message, or keeps its good copy. Partial lists aren't useful
  // for injection so we return empty arrays alongside.
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
export function declarationLine(
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

/**
 * Why a body pushed with a scratch script can't be kept, if a `@require`
 * is over the limit: pushed bodies aren't fetched, so the fetcher's check
 * doesn't see them. Only for pushes; a backup's bundled files were already
 * installed somewhere, so an import keeps them.
 */
export function oversizePushedRequire(
  header: ParsedHeader | null,
  files: Readonly<Record<string, PushedFile>>,
): string | undefined {
  for (const [ref, file] of Object.entries(files)) {
    if (!isDeclaredRequire(header, ref) || base64ToBytes(file.bytesBase64).byteLength <= fileByteLimit) continue;
    return `@require ${ref}: ${describeFetchFailure({ failed: true, reason: 'oversize' }, fileByteLimit)}`;
  }
  return undefined;
}

/**
 * The pushed files with any over-limit `@resource` body replaced by its
 * failure, so the body stays out of storage and the script loads without
 * it, as it does when fetching such a file.
 */
export function withoutOversizeResources(
  header: ParsedHeader | null,
  files: Readonly<Record<string, PushedFile>>,
): Record<string, PushedFile> {
  return Object.fromEntries(Object.entries(files).map(([ref, file]) => {
    if (isDeclaredRequire(header, ref) || base64ToBytes(file.bytesBase64).byteLength <= fileByteLimit) return [ref, file];
    const failure = { detail: describeFetchFailure({ failed: true, reason: 'oversize' }, fileByteLimit), reason: 'oversize' as const };
    return [ref, { url: file.url, bytesBase64: '', contentType: '', failure }];
  }));
}

function isDeclaredRequire(header: ParsedHeader | null, ref: string): boolean {
  return (header?.tags ?? []).some((t) => !t.locale && t.tag === 'require' && t.value.trim() === ref);
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
  const localRoots = args.localRoots ?? [];
  const localLookup = args.localLookup ?? 'search';

  // All files load at once, rather than one after another: each is a
  // round trip of its own (a stand-in read, a network fetch), and on a
  // page-load check they decide whether the reload's window is met.
  // Started in declaration order, and `loadRequire` claims its URL in
  // `seenUrls` before its first await, so the first of two refs to one
  // URL is still the one that loads. Failures are reported for the
  // first failing declaration, as the serial loop did.
  const requireLoads = requireRefs.map((ref) => loadRequire({
    ref,
    scriptFileUrl: args.scriptFileUrl,
    prior: args.priorRequires,
    recheck: args.recheck,
    fetchCache: args.fetchCache,
    now: args.now,
    seenUrls: seenRequireUrls,
    localRoots,
    localLookup,
    pushed: args.pushedFiles?.[ref],
  }));
  const resourceLoads = resourceDecls.map((decl) => loadResource({
    decl,
    scriptFileUrl: args.scriptFileUrl,
    prior: args.priorResources,
    priorProblems: args.priorResourceProblems,
    recheck: args.recheck,
    fetchCache: args.fetchCache,
    now: args.now,
    localRoots,
    localLookup,
    pushed: args.pushedFiles?.[decl.ref],
  }));
  const [requireResults, resourceResults] = await Promise.all([
    Promise.all(requireLoads), Promise.all(resourceLoads),
  ]);

  for (const [i, res] of requireResults.entries()) {
    if (res.errorMessage) {
      const ref = requireRefs[i];
      return {
        requires: [],
        resources: [],
        errorMessage: res.errorMessage,
        errorLine: declarationLine(args.header, 'require', (v) => v === ref),
      };
    }
    if (res.entry) requires.push(res.entry);
  }

  const resourceProblems: ResourceProblem[] = [];
  for (const [i, res] of resourceResults.entries()) {
    if (res.errorMessage) {
      return {
        requires: [],
        resources: [],
        errorMessage: res.errorMessage,
        errorLine: resourceDeclarationLine(args.header, resourceDecls[i]!.name),
      };
    }
    if (res.entry) resources.push(res.entry);
    if (res.problem) resourceProblems.push(res.problem);
  }
  return { requires, resources, ...(resourceProblems.length > 0 ? { resourceProblems } : {}) };
}

// ---------- @icon check ----------

// What the last `@icon` check found. Stored on the script row so a
// background refresh can keep it rather than download the icon again.
export interface IconCheck {
  // The declared reference that was checked, and the URL it resolved
  // to. Both are compared before a stored answer is kept: a relative
  // ref resolves elsewhere once the script's own URL changes.
  ref: string;
  url?: string;
  // Set when a local stand-in was checked rather than the declared URL,
  // with the stand-in's own URL (absent on rows written before it was
  // recorded).
  local?: true;
  localUrl?: string;
  // Why the icon can't be shown, as a load-time warning. Absent when
  // it can.
  message?: string;
  // Which download failure it was, when the download is what failed.
  // For a caller that sorts failures (the corpus validator's tags)
  // without reading `message`.
  failure?: FetchFailure['reason'];
  // Set when the failure may pass on its own (no response, a timeout),
  // so a background refresh looks again rather than keeping it.
  retry?: true;
}

export interface CheckIconArgs {
  header: ParsedHeader | null;
  scriptFileUrl: string;
  prior: IconCheck | undefined;
  recheck: 'all' | 'preserve';
  fetchCache: FileFetchCache;
  localRoots: readonly string[];
  // As for the dependencies; see `readLocalStandIn`.
  localLookup?: LocalLookup;
}

// Check that the script's `@icon` can be shown: that it resolves,
// downloads, is an image, and is within `MAX_ICON_BYTES`. The pages
// that paint icons apply the same rules and just show a globe when one
// fails, so this is the only place the reason is reported.
//
// Never makes the script invalid: the icon is cosmetic. Downloads on
// the same terms as `@require`:
// - `recheck: 'preserve'` keeps the prior answer for an unchanged
//   reference, so a background refresh doesn't download it again.
//   Not one that may pass on its own (no response, a timeout).
// - A local stand-in is re-read every pass, like a `@require`'s.
//
// Returns null when there is nothing to check: no `@icon`, or an inline
// `data:` icon, which has nothing to download.
export async function checkScriptIcon(args: CheckIconArgs): Promise<IconCheck | null> {
  const decl = iconDeclFromHeader(args.header);
  if (!decl || decl.ref.startsWith('data:')) return null;
  const { ref } = decl;
  const problem = (reason: string): IconCheck => ({ ref, message: `@icon ${ref}: ${reason}` });

  const resolved = resolveScriptResourceDetailed(ref, args.scriptFileUrl);
  if ('failed' in resolved) return problem(describeResolveFailure(resolved));
  const { url } = resolved;

  // A stand-in the page could show wins. One it couldn't (too big, not
  // an image) is skipped, as the page skips it for the declared URL.
  // Read through the shared fetch, which has no icon rules, so they
  // are applied to the bytes here.
  const prior = args.prior;
  // A 'known' lookup goes by what the last check of this same reference
  // found. A row that recorded a stand-in without its URL is searched.
  const last = args.localLookup === 'known' && prior?.ref === ref && prior.url === url &&
    (!prior.local || prior.localUrl)
    ? { localUrl: prior.localUrl } : undefined;
  const local = await readLocalStandIn(url, args.localRoots, args.fetchCache, last);
  if (
    local?.localUrl && !isFailure(local.got) &&
    local.got.bytes.byteLength <= MAX_ICON_BYTES &&
    (!local.got.contentType || isIconContentType(local.got.contentType))
  ) {
    return { ref, url, local: true, localUrl: local.localUrl };
  }
  if (
    args.recheck === 'preserve' && prior?.ref === ref && prior.url === url &&
    !prior.local && !prior.retry
  ) {
    return prior;
  }
  // Not through the shared fetch cache: that one fetches up to the
  // `@require` limit, and an icon has its own limit and type rule.
  const res = await fetchResourceBytes(url, {
    maxBytes: MAX_ICON_BYTES,
    acceptContentType: isIconContentType,
  });
  if ('failed' in res) {
    const transient = res.reason === 'no-response' || res.reason === 'timeout';
    return {
      ...problem(describeFetchFailure(res, MAX_ICON_BYTES)),
      url,
      failure: res.reason,
      ...(transient ? { retry: true as const } : {}),
    };
  }
  return { ref, url };
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
    localLookup: 'search',
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
  problem?: ResourceProblem;
}

// What we actually read for a declared URL, and from where.
interface LoadedBytes {
  // Set only when the bytes came from a local stand-in rather than the
  // declared URL, so callers can record it without re-deriving the
  // comparison. Absent means "the declared URL was fetched".
  localUrl?: string;
  // The stand-in's modified time, in listing units, when the read
  // reported one.
  fsMtime?: number;
  got: FetchedFile | FileFailure;
}

// The stored fields that say a stand-in was read, and its stat. Empty
// on the ordinary path, so nothing is written for a declared-URL fetch.
function standInFields(loaded: LoadedBytes): Pick<SharedFileFields, 'localUrl' | 'fsMtime'> {
  if (!loaded.localUrl) return {};
  return {
    localUrl: loaded.localUrl,
    ...(loaded.fsMtime !== undefined ? { fsMtime: loaded.fsMtime } : {}),
  };
}

// A pushed body as what was read for its ref. A relative ref's body is
// the declared file itself, so only a stand-in for a remote URL counts
// as one.
function pushedBytes(pushed: PushedFile): LoadedBytes {
  return {
    ...(pushed.localUrl ? { localUrl: pushed.localUrl } : {}),
    got: pushed.failure
      ? { failed: true, errorMessage: pushed.failure.detail, ...(pushed.failure.reason ? { reason: pushed.failure.reason } : {}) }
      : { bytes: base64ToBytes(pushed.bytesBase64), contentType: pushed.contentType },
  };
}

// Read a declared file, preferring a local stand-in when one exists.
//
// Candidates are tried in order and the first that READS wins — the
// probe and the real read are the same fetch, so a hit costs nothing
// extra. A root is listed only when the search reaches it, to rule out
// candidates under it that can't exist (see `localCandidateMayExist`),
// so a hit in an early root never lists the later ones. `ensureFetch`
// caches the reads for the rest of the pass, misses included.
//
// `last` is what the last check found, passed by the page-load checks
// (a listing per root costs more than the whole rest of such a check):
//   - its stand-in, when still a candidate under these roots, is read
//     first and no root is listed. A path that no longer reads falls
//     through to the search.
//   - no stand-in last time means none is looked for: one appearing is
//     rare, and searching would list every root on every page load.
// Either can miss a copy that appeared since, nearer or at all; the
// searching checks (focus, Refresh) find it.
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
  last?: { localUrl?: string },
): Promise<LoadedBytes | null> {
  const candidates = localFileCandidatesDetailed(declaredUrl, localRoots);
  if (last && !last.localUrl) return null;
  const known = last?.localUrl;
  if (known && candidates.some((c) => c.url === known)) {
    const got = await ensureFetch(fetchCache, known);
    if (!isFailure(got)) return standInRead(known, got);
  }
  const listings = listingsFor(fetchCache);
  for (const candidate of candidates) {
    if (!await localCandidateMayExist(candidate, listings)) continue;
    const got = await ensureFetch(fetchCache, candidate.url);
    // A candidate that doesn't read isn't a failure — it just isn't
    // there. Only an actual hit ends the search.
    if (!isFailure(got)) return standInRead(candidate.url, got);
  }
  return null;
}

// A stand-in that read, with its modified time for the "modified" chip.
// The time comes from the read itself (`Last-Modified`), in the units a
// listing of its folder would give.
function standInRead(localUrl: string, got: FetchedFile): LoadedBytes {
  return { localUrl, got, ...(got.fsMtime !== undefined ? { fsMtime: got.fsMtime } : {}) };
}

// The root-directory listings the stand-in search gates on,
// given the same lifetime as the fetch cache they sit beside: one
// refresh pass, or the page for the install preview's page-lifetime
// cache, which memoizes misses for that long anyway. Keyed off the fetch cache
// rather than threaded as another parameter because every entry point
// that builds a `FileFetchCache` would otherwise have to build this one
// too, and the two must never outlive each other — a listing that
// outlived its pass would hide a stand-in created after it was taken.
const listingCaches = new WeakMap<FileFetchCache, DirectoryListingCache>();

// A pass that already keeps directory listings (the navigation
// `RefreshBatch`) registers them here, so the stat it took of the
// script's own folder and the gate's read of that same folder are one
// listing rather than two.
export function bindListingCache(fetchCache: FileFetchCache, listings: DirectoryListingCache): void {
  listingCaches.set(fetchCache, listings);
}

function listingsFor(fetchCache: FileFetchCache): DirectoryListingCache {
  let listings = listingCaches.get(fetchCache);
  if (!listings) {
    listings = new Map();
    listingCaches.set(fetchCache, listings);
  }
  return listings;
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
  localLookup: LocalLookup;
  pushed?: PushedFile;
}

// What the last check found for this file, under a 'known' lookup. A
// file the last check didn't load (newly declared) has nothing known,
// so it is searched for.
function lastLookup(lookup: LocalLookup, prior: { localUrl?: string } | undefined): { localUrl?: string } | undefined {
  return lookup === 'known' ? prior : undefined;
}

// Start reading the stand-ins a script's last check found, into the
// pass's fetch cache, so a check can overlap them with reading the
// script itself. The loaders then take them from the cache. Only for a
// 'known' lookup, which reads these paths first anyway.
export function prefetchKnownStandIns(
  fetchCache: FileFetchCache,
  prior: { requires?: readonly { localUrl?: string }[]; resources?: readonly { localUrl?: string }[] },
): void {
  for (const entry of [...(prior.requires ?? []), ...(prior.resources ?? [])]) {
    if (entry.localUrl) void ensureFetch(fetchCache, entry.localUrl);
  }
}

// Where a ref resolves: the pushed body's URL when there is one, which
// the pusher already resolved and checked, else the ref resolved
// against the script.
//
// A `data:` ref carries its own body, decoded here into `inline` in
// place of a fetch. It has no local stand-in, and its URL (the whole
// `data:` string) is what the stored entry and the prior lookup key on.
function resolveRef(
  ref: string,
  scriptFileUrl: string,
  pushed: PushedFile | undefined,
): { url: string; inline?: LoadedBytes } | { failure: string } {
  if (pushed) return { url: pushed.url };
  const resolved = resolveScriptResourceDetailed(ref, scriptFileUrl);
  if ('failed' in resolved) return { failure: describeResolveFailure(resolved) };
  if (resolved.kind === 'data') {
    const decoded = decodeDataUrl(resolved.url);
    if (!decoded) return { failure: BAD_DATA_URL };
    return { url: resolved.url, inline: { got: { bytes: decoded.bytes.buffer, contentType: decoded.contentType } } };
  }
  return { url: resolved.url };
}

async function loadRequire(args: LoadRequireArgs): Promise<LoadResult<StoredRequire>> {
  const resolved = resolveRef(args.ref, args.scriptFileUrl, args.pushed);
  if ('failure' in resolved) {
    return { errorMessage: `@require ${args.ref}: ${resolved.failure}` };
  }
  if (args.seenUrls.has(resolved.url)) return {};
  args.seenUrls.add(resolved.url);

  const prior = args.prior.get(resolved.url);

  // Local stand-in first, and before the preserve shortcut — see
  // `readLocalStandIn` for why an overridden file is never cached past
  // a refresh. A pushed body is read every time for the same reason.
  const local = args.pushed ? pushedBytes(args.pushed)
    : resolved.inline ?? await timePhase('local-standin', () => readLocalStandIn(
      resolved.url, args.localRoots, args.fetchCache, lastLookup(args.localLookup, prior)));
  if (!local && !args.pushed && args.recheck === 'preserve' && prior && !prior.localUrl) {
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
      ...standInFields(loaded),
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
  priorProblems: Map<string, ResourceProblem> | undefined;
  recheck: 'all' | 'preserve';
  fetchCache: FileFetchCache;
  now: number;
  localRoots: readonly string[];
  localLookup: LocalLookup;
  pushed?: PushedFile;
}

async function loadResource(args: LoadResourceArgs): Promise<LoadResult<StoredResource>> {
  const { name, ref } = args.decl;
  // A failure with a good copy held is a failed refresh: the caller keeps
  // the whole script on its good copy. That covers this name at another
  // URL too, such as an update bumping a versioned CDN URL. Without one,
  // the script runs without this resource.
  const failed = (detail: string, url?: string, reason?: FetchFailure['reason']): LoadResult<StoredResource> => {
    const heldCopy = [...args.prior.values()].some((p) => p.name === name || p.url === url);
    if (heldCopy) return { errorMessage: resourceProblemMessage({ name, ref, detail }) };
    const transient = reason === 'no-response' || reason === 'timeout';
    return {
      problem: {
        name,
        ref,
        ...(url !== undefined ? { url } : {}),
        detail,
        ...(reason ? { failure: reason } : {}),
        ...(transient ? { retry: true as const } : {}),
      },
    };
  };
  const resolved = resolveRef(ref, args.scriptFileUrl, args.pushed);
  if ('failure' in resolved) return failed(resolved.failure);
  // Resources can be any media type.
  // No URL-level dedup: two `@resource` lines with different
  // names pointing at the same URL are intentional — we want two
  // distinct StoredResource entries so each name resolves to its own
  // GM_getResource* lookup. The shared FileFetchCache still ensures
  // we only fetch the URL once.

  // Prior lookup by URL.
  const prior = args.prior.get(resolved.url);

  // Its last failure, which also means no stand-in was found last time.
  const priorProblem = args.priorProblems?.get(name);

  // Local stand-in first, and before the preserve shortcut — same rule
  // and same reasoning as `@require`; see `readLocalStandIn`.
  const local = args.pushed ? pushedBytes(args.pushed)
    : resolved.inline ?? await timePhase('local-standin', () => readLocalStandIn(
      resolved.url, args.localRoots, args.fetchCache, lastLookup(args.localLookup, prior ?? (priorProblem ? {} : undefined))));
  if (
    !local && args.recheck === 'preserve' &&
    prior && prior.name === args.decl.name && !prior.localUrl
  ) {
    return { entry: prior };
  }
  // A recorded failure is kept until a recheck, as for an `@icon`, so a dead
  // URL isn't fetched again on each page load. Not one that may pass on
  // its own.
  if (
    !local && args.recheck === 'preserve' &&
    priorProblem?.ref === ref && priorProblem.url === resolved.url && !priorProblem.retry
  ) {
    return { problem: priorProblem };
  }

  // Resources accept anything — including HTML. A script that wants
  // to embed a fragment of HTML as a string via GM_getResourceText
  // shouldn't be blocked.
  const loaded = local ?? {
    got: await ensureFetch(args.fetchCache, resolved.url, priorCopyOf(prior, priorResourceBytes(prior))),
  };
  const got = loaded.got;
  if (isFailure(got)) return failed(got.errorMessage, resolved.url, got.reason);
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
      ...standInFields(loaded),
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
      maxBytes: fileByteLimit,
      // Only conditional when we hold a validator to offer. A bare
      // prior with neither would send no header and just refetch.
      ...(prior && (prior.etag ?? prior.lastModified)
        ? { conditional: { etag: prior.etag, lastModified: prior.lastModified } }
        : {}),
    });
    if ('failed' in res) {
      return { failed: true, errorMessage: describeFetchFailure(res, fileByteLimit), reason: res.reason };
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
    if (res.fsMtime !== undefined) out.fsMtime = res.fsMtime;
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
      // the corpus validator to substitute mirror wording for a bug of
      // ours, and put a second `could not be fetched: ` colon into a
      // string that already lands after `@require <ref>: `.
      errorMessage: `Internal error: the file fetcher failed unexpectedly (${
        err instanceof Error ? err.message : String(err)})`,
    };
  }
}
