// Persistent userscript store backed by chrome.storage.local.
//
// Layout (one row per record, no monolithic blob):
//
//   "sources"          → string[]                   index of source IDs
//   "source:<sid>"     → StoredSource               per-source metadata
//   "script:<scid>"    → StoredScript               per-script content+header
//
// Sources own their scripts via `scriptIds`. Scripts back-reference
// their source via `sourceId` so the viewer page can refresh a single
// script without first looking up its parent.
//
// All add/refresh flows go through one pipeline:
//   listing → fetch each file → splitHeaderBody → parseHeader →
//   validateHeader → distillMatching → buildScriptFromText.
// A script is `ok` iff fetch succeeded AND splitHeaderBody returned no
// error AND validateHeader returned null. Otherwise `status: 'invalid'`
// with an `errorMessage`. On refresh, files that were known before but
// no longer appear in the scan listing are reconciled per source kind:
// directory sources mark them `status: 'missing'` (file may come
// back); manifest sources delete the row (user explicitly removed the
// entry). In every error/missing case we preserve the previously
// loaded content so the viewer (and the injector) keep working.
//
// If the scan step itself fails (unreadable listing, unreadable
// manifest, …), refreshSource records the error in `scanError` on the
// source row and leaves every existing script untouched — see that
// function's docstring for the rationale.

import {
  containerKindForSingleFileInput,
  containerPath,
  fetchFileUrlText,
  fetchHttpText,
  isContainerSource,
  isHttpUrl,
  isManifestSource,
  isSingleFileInput,
  joinPath,
  normalizeSourceInput,
  scanForUserScripts,
  scriptFileUrl,
  sourceFsPath,
  statFromListing,
} from './directories.js';
import {
  getValue,
  getValues,
  parseHeader,
  splitHeaderBody,
  type ParsedHeader,
} from './userscript-header.js';
import {
  attachFiles,
  distillRequires,
  distillResources,
  type FileFetchCache,
  type StoredRequire,
  type StoredResource,
} from './external-files.js';
import { resolveGrants } from './gm-api-catalog.js';
import { inferDisplayName } from './source-display.js';
import { appendScriptLog } from './script-log.js';

// `invalid` is the umbrella for "we couldn't load/use this script":
// metadata-block parse failure, header validation failure, fetch
// failure, or a missing/broken @require / @resource. All of them
// surface in the UI as INVALID (the user-facing label) because from
// the user's perspective the script can't run. `missing` is reserved
// for the narrower case where the source file vanished from its
// listing — the row is preserved with its last-known content but the
// file is gone.
export type ScriptStatus = 'ok' | 'invalid' | 'missing';

export interface ScriptMatching {
  matches: string[];   // @match values
  excludes: string[];  // @exclude values
  includes: string[];  // @include values
}

// Diagnostic produced at parse time and surfaced two ways:
//   1. spliced into the script's wrapper as a `console.<level>(...)`
//      that fires in the page DevTools console on every matching page
//      load (see buildStartupLogsSnippet in injector.ts), and
//   2. emitted as a Log-tab entry once per content version (see
//      emitScriptOutcomeLog in script-updater.ts).
// Today's only producer is the unknown-`@grant` check; future
// detectors (header validation warnings, deprecated-tag notices, etc.)
// can append in extractStartupLogs.
export interface StartupLog {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

export interface StoredScript {
  id: string;            // UUID, stable across refreshes (keyed on relativePath)
  sourceId: string;
  relativePath: string;
  fileUrl: string;
  status: ScriptStatus;
  errorMessage?: string;
  // UTF-8 byte length of the cached content. `0` is a valid value for
  // an empty file. `null` only on a never-loaded-successfully initial-
  // error row (no body to size); `missing` rows keep their last known
  // size so the UI reflects the cached body.
  size: number | null;
  // Universal "last-change token": a content-derived hash of the
  // fetched source text on the last successful load. Lets the refresh
  // pipeline decide "did anything actually change?" uniformly across
  // source kinds and schemes — the per-scheme cheap-skip paths
  // (size+fsMtime, conditional GET) avoid the fetch entirely when the
  // source/server cooperates; this hash catches the cases where a
  // fetch did happen but the content turned out identical (a manifest
  // entry whose server returns no ETag / Last-Modified, or a file://
  // entry inside a manifest where the scan has no per-file stat).
  // Absent only on never-loaded rows.
  contentHash?: string;
  // Modification time as reported by Chrome's directory listing on the
  // last successful scan. Opaque integer used only for equality —
  // combined with `size`, it lets refresh skip refetching a file whose
  // listing-reported size+mtime are unchanged. Optional because older
  // listings / older stored rows may not have it.
  fsMtime?: number;
  // HTTP-source validators captured from the last successful fetch.
  // Sent back as If-None-Match / If-Modified-Since on the next refresh
  // so the server can answer 304 instead of resending the body. The
  // 304 path lands in fetchOrSkipInParallel as `unchanged`, mirroring
  // the local size+mtime skip.
  httpEtag?: string;
  httpLastModified?: string;
  // Anything in the source file above the `// ==UserScript==` line.
  // Optional because pre-leadingText stored rows won't carry it; the
  // viewer must treat `undefined` as empty.
  leadingText?: string;
  headerText: string;
  bodyText: string;
  header: ParsedHeader | null;
  matching: ScriptMatching;
  loadedAt: number;      // epoch ms — bumped each time fresh content lands
  enabled: boolean;      // per-script toggle; defaults true on first load
  // Prefetched `@require` bodies, in declaration order, deduped by
  // canonical URL. Optional because pre-`@require`-era stored rows
  // won't carry it; downstream code must treat `undefined` as empty.
  // See [docs/requires.md] / src/external-files.ts for the lifecycle.
  requires?: StoredRequire[];
  // Prefetched `@resource` blobs, in declaration order, deduped by
  // resource name (first declaration wins). Optional because
  // pre-`@resource`-era stored rows won't carry it. Resources share
  // the same fetch + storage pipeline as requires (external-files.ts)
  // but carry raw bytes (base64) rather than decoded text — so they
  // can serve images, fonts, JSON, CSS, etc. via GM_getResource*.
  resources?: StoredResource[];
  // Parse-time diagnostics (today: unknown @grant names). Only
  // populated for `status === 'ok'` rows; error rows don't run so the
  // diagnostics would be dead bytes, and applyMissing / applyFetchError
  // inherit whatever the prior `ok` row had (correct because they also
  // preserve the body the diagnostics were derived from). Persisted so
  // the wrapper rebuild at every SW startup doesn't have to re-derive
  // them — and so the Log-tab emission at content-change time can read
  // them straight off the freshly built row.
  startupLogs?: readonly StartupLog[];
}

export interface StoredSource {
  id: string;
  path: string;
  lastRefreshedAt: number;
  scriptIds: string[];
  scanError?: string;    // set when the scan itself failed (directory listing, manifest fetch, bad URL shape)
  enabled: boolean;      // per-source toggle; defaults true on first load
  // Short, human-readable label for the sources page heading + the
  // viewer's Source row. Backfilled from `inferDisplayName(path)` on
  // first read after upgrade (see `backfillSourceDisplayNames`) so
  // every persisted row carries one. Treated as a future user-
  // overridable value: when set, the UI uses it verbatim; the inferred
  // form is only consulted when this field is absent/empty.
  displayName?: string;
}

// Treat any pre-`enabled`-era stored entry as enabled. The schema now
// requires `enabled: boolean`, but rows persisted before this field was
// introduced will read back as undefined; only an explicit `false`
// should count as disabled.
export function isSourceEnabled(source: StoredSource): boolean {
  return source.enabled !== false;
}
export function isScriptEnabled(script: StoredScript): boolean {
  return script.enabled !== false;
}

// ---------- Pure helpers (exported for unit tests) ----------

// What the orchestrator hands back from each per-file load attempt.
//   - `ok` : freshly fetched content (with HTTP validators when available)
//   - `error`: fetch attempted and failed
//   - `unchanged`: we skipped the fetch because either (file://) the
//     listing reported the same size+mtime as the stored entry, or
//     (http) the server answered 304 to our conditional GET
export type FetchResult =
  | { ok: true; source: string; httpEtag?: string; httpLastModified?: string }
  | { ok: false; errorMessage: string }
  | { unchanged: true };

// Compute the universal change-detection token for a fetched script
// source. Uses the Web Crypto SubtleCrypto SHA-256 — available
// uniformly in service workers, page contexts, and Node ≥19, so the
// same helper works in production and in unit tests with no
// per-environment polyfill. Async by necessity (SubtleCrypto has no
// sync form on the web platform); buildScriptFromText and
// rebuildSource are async in turn.
export async function hashSource(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

// Pull `@match` / `@exclude` / `@include` lists out of a parsed header.
// These feed the future page-matching/injection logic.
export function distillMatching(header: ParsedHeader | null): ScriptMatching {
  if (!header) return { matches: [], excludes: [], includes: [] };
  return {
    matches: getValues(header, 'match'),
    excludes: getValues(header, 'exclude'),
    includes: getValues(header, 'include'),
  };
}

// Derive parse-time diagnostics from the metadata block. Today this
// only flags unknown `@grant` names; add other producers here as
// they come up (e.g. deprecated header tags, soft `@resource`
// failures, `@grant`-but-never-called dead grants). Anything that
// blocks `validateHeader` belongs in there instead — error rows skip
// the startup-logs attachment in `buildScriptFromText`.
export function extractStartupLogs(header: ParsedHeader | null): StartupLog[] {
  if (!header) return [];
  const logs: StartupLog[] = [];
  const grants = getValues(header, 'grant');
  if (grants.length > 0) {
    const resolved = resolveGrants(grants);
    if (resolved.unknown.length > 0) {
      logs.push({
        level: 'warn',
        message: `unknown @grant entries dropped: ${resolved.unknown.join(', ')}`,
      });
    }
  }
  return logs;
}

// Verify the parsed header has the fields we require to consider a
// script `ok`. Returns null on success, otherwise a human-readable
// error message. Required: an `@name` plus at least one of
// `@match` / `@include` (otherwise the script can never match a page).
export function validateHeader(header: ParsedHeader | null): string | null {
  if (!header) return 'no metadata block';
  if (!getValue(header, 'name')) return 'missing @name';
  const matches = getValues(header, 'match');
  const includes = getValues(header, 'include');
  if (matches.length === 0 && includes.length === 0) {
    return 'missing @match or @include';
  }
  return null;
}

interface BuildArgs {
  id: string;
  sourceId: string;
  relativePath: string;
  fileUrl: string;
  source: string;
  now: number;
  // Prior row, if any. Used purely for the content-hash compare: if
  // the freshly fetched bytes hash to the same value as the prior
  // row's `contentHash`, we preserve the prior `loadedAt` so callers
  // (notably the sources page's row-highlight code) can tell that
  // nothing actually changed. This is the universal post-fetch
  // change-detection path — it catches cases the cheap pre-fetch
  // skips (size+mtime, HTTP 304) couldn't handle, e.g. manifest
  // entries or servers that don't return validators.
  prior?: StoredScript;
  httpEtag?: string;
  httpLastModified?: string;
}

// Compose a `StoredScript` from freshly fetched source text. Always
// records the new content (so the viewer reflects what's on disk),
// then determines status by running it through split + parse +
// validate. Any failure along that chain lands in `errorMessage` while
// the content fields stay populated. Async because hashing the source
// for the universal change-detection token uses SubtleCrypto.
export async function buildScriptFromText(args: BuildArgs): Promise<StoredScript> {
  const split = splitHeaderBody(args.source);
  const header = parseHeader(args.source);
  const matching = distillMatching(header);
  // UTF-16 string length ≠ file byte length for non-ASCII content;
  // TextEncoder gives us the wire-accurate UTF-8 byte count.
  const size = new TextEncoder().encode(args.source).length;
  const contentHash = await hashSource(args.source);

  let status: ScriptStatus = 'ok';
  let errorMessage: string | undefined;
  if (split.error) {
    status = 'invalid';
    errorMessage = split.error;
  } else {
    const validationError = validateHeader(header);
    if (validationError) {
      status = 'invalid';
      errorMessage = validationError;
    }
  }

  // Same bytes as last time → preserve the prior load timestamp so
  // the sources page's "what changed" highlight stays accurate even
  // when the cheap skip paths didn't fire. Status still reflects the
  // current parse outcome (parser fixes between refreshes are rare
  // but shouldn't be silently masked).
  const unchanged = args.prior?.contentHash === contentHash;
  const loadedAt = unchanged && args.prior ? args.prior.loadedAt : args.now;

  const entry: StoredScript = {
    id: args.id,
    sourceId: args.sourceId,
    relativePath: args.relativePath,
    fileUrl: args.fileUrl,
    status,
    size,
    contentHash,
    headerText: split.headerText,
    bodyText: split.bodyText,
    header,
    matching,
    loadedAt,
    // New rows default enabled; existing rows preserve their prior
    // value via the merge in rebuildSource / refreshScript.
    enabled: true,
  };
  if (errorMessage) entry.errorMessage = errorMessage;
  if (args.httpEtag) entry.httpEtag = args.httpEtag;
  if (args.httpLastModified) entry.httpLastModified = args.httpLastModified;
  // Only persist leadingText when non-empty so the vast majority of
  // scripts (which start at `// ==UserScript==`) don't carry an
  // empty-string field.
  if (split.leadingText) entry.leadingText = split.leadingText;
  // Parse-time diagnostics. Only attached when status is `ok` — error
  // rows don't run and never reach the wrapper, so the diagnostics
  // would just be dead bytes in storage. Same shape filter for the
  // empty case keeps the persisted row free of empty arrays.
  if (status === 'ok') {
    const startupLogs = extractStartupLogs(header);
    if (startupLogs.length > 0) entry.startupLogs = startupLogs;
  }
  return entry;
}

// Apply a fetch failure to an existing entry: preserve the prior
// content and just flip status/errorMessage. Size stays at its last
// known value (we know nothing fresh).
export function applyFetchError(
  existing: StoredScript,
  errorMessage: string,
): StoredScript {
  return { ...existing, status: 'invalid', errorMessage };
}

// Build an `invalid` entry for a brand-new (never-loaded-successfully)
// script whose first fetch failed. No content to preserve, so the
// content fields stay empty and size is null.
export function buildInitialInvalidEntry(args: {
  id: string;
  sourceId: string;
  relativePath: string;
  fileUrl: string;
  errorMessage: string;
  now: number;
}): StoredScript {
  return {
    id: args.id,
    sourceId: args.sourceId,
    relativePath: args.relativePath,
    fileUrl: args.fileUrl,
    status: 'invalid',
    errorMessage: args.errorMessage,
    size: null,
    headerText: '',
    bodyText: '',
    header: null,
    matching: { matches: [], excludes: [], includes: [] },
    loadedAt: args.now,
    enabled: true,
  };
}

// Flip an existing entry to `missing`. Preserves content (including
// the size of the cached body) for the viewer and the injector — the
// file is gone but we still hold what we last read, so the size column
// reflects that and is distinct from genuine "unknown size" rows.
//
// `enabled` only flips to false on the FIRST ok→missing transition —
// i.e. only when `existing.status === 'ok'`. Once a row has left `ok`
// (it's already `missing`, or it's `error` because an opportunistic
// per-script refetch hit a vanished file before the directory-level
// refresh ran), applyMissing leaves `enabled` alone. Otherwise we'd
// silently clobber a user who has re-enabled a missing row to run from
// the cached body: any subsequent refresh while the file is still gone
// would re-disable it. If the file later returns, rebuildSource
// preserves whatever `enabled` value the user left in place.
//
// HTTP validators (httpEtag / httpLastModified) ride along untouched.
// The conditional-GET path is gated on `prior.status === 'ok'`, so
// stale validators are dormant; if the entry returns and fetches
// cleanly, buildScriptFromText overwrites them from the fresh response.
export function applyMissing(existing: StoredScript): StoredScript {
  const next: StoredScript = { ...existing, status: 'missing' };
  if (existing.status === 'ok') next.enabled = false;
  delete next.errorMessage;
  return next;
}

// Resolve + fetch a script's `@require` bodies AND `@resource` blobs,
// attaching both lists onto the StoredScript. On any failure preserves
// the prior's last-known-good state and flips status to 'invalid' with a
// message naming the offending URL — mirrors `applyFetchError`'s
// content-preservation policy for body-fetch failures, so a flaky
// dependency doesn't clobber the user's working version. Without
// declared deps a userscript usually breaks worse than not injecting,
// so erroring out is safer than running headless.
//
// `recheck === 'preserve'` reuses every cached prior verbatim and only
// fetches refs the script newly declares. `recheck === 'all'` refetches
// every declared file (used by explicit Refresh). The fetchCache is
// shared across all scripts in a single refresh pass so two scripts
// referencing the same canonical URL share one fetch — and a require
// + a resource pointing at the same URL also share a single fetch.
async function applyFiles(
  built: StoredScript,
  prior: StoredScript | undefined,
  recheck: 'all' | 'preserve',
  fetchCache: FileFetchCache,
  now: number,
): Promise<StoredScript> {
  const priorRequires = new Map((prior?.requires ?? []).map((r) => [r.url, r]));
  const priorResources = new Map((prior?.resources ?? []).map((r) => [r.url, r]));
  // `recheck: 'preserve'` short-circuits when both lists are identical
  // to the prior's: no resolve work, no fetch, just keep what we had.
  // This is the hot path on opportunistic refresh.
  if (recheck === 'preserve' && prior) {
    const newReqRefs = distillRequires(built.header);
    const sameReqs =
      newReqRefs.length === (prior.requires?.length ?? 0) &&
      newReqRefs.every((ref, i) => prior.requires?.[i]?.ref === ref);
    const newResDecls = distillResources(built.header);
    const sameRess =
      newResDecls.length === (prior.resources?.length ?? 0) &&
      newResDecls.every((d, i) => {
        const p = prior.resources?.[i];
        return p && p.name === d.name && p.ref === d.ref;
      });
    if (sameReqs && sameRess) {
      if (prior.requires) built.requires = prior.requires;
      else delete built.requires;
      if (prior.resources) built.resources = prior.resources;
      else delete built.resources;
      return built;
    }
  }
  const result = await attachFiles({
    scriptFileUrl: built.fileUrl,
    header: built.header,
    priorRequires,
    priorResources,
    recheck,
    fetchCache,
    now,
  });
  if (result.errorMessage) {
    // Preserve the last-known-good script state when we have one.
    // This rolls the *entire* refresh back to the prior — the new
    // body isn't applied either, because injecting a fresh body
    // against partial/stale dependencies would be unsafe. The user
    // sees the error message and their script keeps running its
    // prior version until they fix the bad reference.
    if (prior && prior.status === 'ok') {
      return { ...prior, status: 'invalid', errorMessage: result.errorMessage };
    }
    built.status = 'invalid';
    built.errorMessage = result.errorMessage;
    delete built.requires;
    delete built.resources;
    return built;
  }
  if (result.requires.length > 0) built.requires = result.requires;
  else delete built.requires;
  if (result.resources.length > 0) built.resources = result.resources;
  else delete built.resources;
  return built;
}

interface ScanEntry {
  relativePath: string;
  size?: number;
  mtime?: number;
}

interface RebuildArgs {
  sourceId: string;
  sourcePath: string;
  existing: StoredScript[];
  scan: ScanEntry[];
  fetchResults: Map<string, FetchResult>;  // keyed by relativePath
  now: number;
  newId?: () => string;
  // `@require` + `@resource` recheck policy:
  //   - 'all'     : refetch every declared dep regardless of whether
  //                 the script body changed. Used by explicit Refresh
  //                 so users can pick up remote updates even when the
  //                 main script body is unchanged.
  //   - 'preserve': reuse cached priors verbatim; only fetch refs the
  //                 script newly declares. Used by opportunistic
  //                 (background) refresh to keep page-load cost
  //                 bounded — the user can always click Refresh to
  //                 pick up remote dep updates.
  // Defaults to 'all' so the conservative behavior is the fallback.
  recheckFiles?: 'all' | 'preserve';
  // Cross-script file-fetch cache. Two scripts referencing the same
  // canonical URL share one fetch — and a require + resource pointing
  // at the same URL also share. Caller passes a fresh map per top-
  // level refresh entry point (refreshSource / refreshScript /
  // refreshAllSources); rebuildSource itself never mutates the entry
  // semantics, just hands the cache to attachFiles.
  fileFetchCache?: FileFetchCache;
}

// Pure orchestrator: given the prior state for a source plus a fresh
// scan and the per-file fetch results, return the new list of
// `StoredScript`s in canonical order (scan order, then any entries
// that fell off the listing tagged `missing`). Stable IDs come from
// looking up by relativePath in `existing`. No I/O — easy to test.
//
// Vanished-entry handling depends on the source kind:
//   - Manifest sources: an entry that's no longer listed is treated
//     as an explicit user removal — the row is dropped entirely (the
//     `refreshSource` caller then deletes the storage row).
//   - Other sources (local directory): the prior row is tagged
//     `missing` and auto-disabled. The file might come back; the row
//     stays so the viewer keeps working.
export async function rebuildSource(args: RebuildArgs): Promise<StoredScript[]> {
  const newId = args.newId ?? (() => crypto.randomUUID());
  const recheckFiles = args.recheckFiles ?? 'all';
  const fileFetchCache: FileFetchCache = args.fileFetchCache ?? new Map();
  const existingByPath = new Map<string, StoredScript>();
  for (const e of args.existing) existingByPath.set(e.relativePath, e);

  // Each scanned entry resolves to one StoredScript. Most paths are
  // synchronous (unchanged, error, defensive fallbacks); the `ok`
  // path goes through buildScriptFromText which is async because the
  // content-hash uses SubtleCrypto. We wrap every branch in a Promise
  // and Promise.all at the end so the hash work overlaps and the
  // output order matches scan order.
  const entryPromises: Promise<StoredScript>[] = [];
  const handledPaths = new Set<string>();
  for (const found of args.scan) {
    handledPaths.add(found.relativePath);
    const prior = existingByPath.get(found.relativePath);
    const id = prior?.id ?? newId();
    const fileUrl = scriptFileUrl(args.sourcePath, found.relativePath);
    const fr = args.fetchResults.get(found.relativePath);
    if (fr && 'ok' in fr && fr.ok) {
      entryPromises.push((async (): Promise<StoredScript> => {
        const built = await buildScriptFromText({
          id,
          sourceId: args.sourceId,
          relativePath: found.relativePath,
          fileUrl,
          source: fr.source,
          now: args.now,
          // Pass prior so buildScriptFromText can preserve loadedAt when
          // the freshly fetched bytes hash to the same value — the
          // post-fetch leg of the unified change-detection path.
          prior,
          httpEtag: fr.httpEtag,
          httpLastModified: fr.httpLastModified,
        });
        // Preserve the user's per-script enabled choice across refreshes.
        if (prior) built.enabled = prior.enabled;
        // Record the listing's mtime so the next refresh can decide to
        // skip a refetch.
        if (found.mtime !== undefined) built.fsMtime = found.mtime;
        return applyFiles(built, prior, recheckFiles, fileFetchCache, args.now);
      })());
    } else if (fr && 'unchanged' in fr) {
      // Optimization path: the listing's size+mtime matched the prior
      // entry, so we never fetched. Reuse the prior entry verbatim.
      // (Defensive fallback if there's somehow no prior: treat as a
      // fresh-fetch failure — shouldn't happen because the orchestrator
      // only emits `unchanged` when prior exists.)
      if (prior) {
        // Recompute fileUrl unconditionally — if the source's path/URL
        // ever changes (e.g. a future edit-source UI), the prior's
        // fileUrl would silently lie. Cheap to recompute here.
        const next = { ...prior, fileUrl };
        if (found.mtime !== undefined) next.fsMtime = found.mtime;
        if (found.size !== undefined) next.size = found.size;
        // Even when the body is unchanged, explicit Refresh still
        // rechecks @require + @resource bodies (the user may want to
        // pick up remote dep updates without touching the main
        // script). The opportunistic path passes 'preserve' which
        // short-circuits.
        entryPromises.push(applyFiles(next, prior, recheckFiles, fileFetchCache, args.now));
      } else {
        entryPromises.push(Promise.resolve(buildInitialInvalidEntry({
          id,
          sourceId: args.sourceId,
          relativePath: found.relativePath,
          fileUrl,
          errorMessage: 'unchanged marker with no prior entry',
          now: args.now,
        })));
      }
    } else if (fr) {
      // Failed fetch. If we had prior content, keep it.
      const errorMessage = 'errorMessage' in fr ? fr.errorMessage : 'unknown error';
      if (prior) {
        entryPromises.push(Promise.resolve(applyFetchError(prior, errorMessage)));
      } else {
        entryPromises.push(Promise.resolve(buildInitialInvalidEntry({
          id,
          sourceId: args.sourceId,
          relativePath: found.relativePath,
          fileUrl,
          errorMessage,
          now: args.now,
        })));
      }
    } else {
      // No fetch attempted at all. Treat like a fetch error with a
      // generic message; this branch is mostly defensive — the
      // orchestrator should always supply a result.
      entryPromises.push(Promise.resolve(prior
        ? applyFetchError(prior, 'not loaded')
        : buildInitialInvalidEntry({
            id, sourceId: args.sourceId, relativePath: found.relativePath,
            fileUrl, errorMessage: 'not loaded', now: args.now,
          })));
    }
  }

  const out = await Promise.all(entryPromises);

  // Anything in `existing` that the scan didn't see → either marked
  // missing (directory sources: file may come back) or dropped
  // (manifest sources: the user explicitly removed the entry).
  const dropVanished = isManifestSource(args.sourcePath);
  for (const e of args.existing) {
    if (handledPaths.has(e.relativePath)) continue;
    if (dropVanished) continue;
    out.push(applyMissing(e));
  }
  return out;
}

// ---------- chrome.storage.local I/O ----------

const SOURCES_INDEX_KEY = 'sources';
const sourceKey = (id: string) => `source:${id}`;
const scriptKey = (id: string) => `script:${id}`;

// Set to `true` the first time the SW seeds the default sources, so the
// seeding never runs again even after the user removes those sources.
const FIRST_RUN_DONE_KEY = 'firstRunComplete';

// Sources seeded on the very first run (by the sources page — see
// `seedDefaultSourcesViaUi` in sources.ts). Each is fed through the
// normal add → Refresh flow, so any input shape `addSource` accepts
// (github-dir / http(s) `.user.js` / manifest URL, or an absolute
// directory path) works here. `addSource` dedupes by canonical source
// path, so any accidental repeat collapses to one source.
export const DEFAULT_SOURCES: readonly string[] = [
  'https://github.com/jshute96/SourceMonkey/tree/main/tests/examples',
  'https://github.com/jshute96/SourceMonkey/tree/main/userscripts',
];

async function getRaw<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function getMany(keys: string[]): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  return await chrome.storage.local.get(keys);
}

async function readSourceIndex(): Promise<string[]> {
  return (await getRaw<string[]>(SOURCES_INDEX_KEY)) ?? [];
}

// Read every registered source's metadata (without scripts). Order
// preserved from the index.
export async function getSources(): Promise<StoredSource[]> {
  const ids = await readSourceIndex();
  const got = await getMany(ids.map(sourceKey));
  return ids
    .map((id) => got[sourceKey(id)] as StoredSource | undefined)
    .filter((s): s is StoredSource => s != null);
}

// Read a source plus all its scripts in declared order.
export async function getSourceWithScripts(
  id: string,
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  const source = await getRaw<StoredSource>(sourceKey(id));
  if (!source) return null;
  const got = await getMany(source.scriptIds.map(scriptKey));
  const scripts = source.scriptIds
    .map((sid) => got[scriptKey(sid)] as StoredScript | undefined)
    .filter((s): s is StoredScript => s != null);
  return { source, scripts };
}

export async function getScript(scriptId: string): Promise<StoredScript | undefined> {
  return await getRaw<StoredScript>(scriptKey(scriptId));
}

// Read every stored script (across all sources, regardless of status).
// One `get(null)` scan rather than N per-source reads; used by the
// sources page + viewer to compute global log IDs in one pass.
export async function getAllScripts(): Promise<StoredScript[]> {
  const all = await chrome.storage.local.get(null);
  const out: StoredScript[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('script:')) out.push(value as StoredScript);
  }
  return out;
}

export async function getSource(id: string): Promise<StoredSource | undefined> {
  return await getRaw<StoredSource>(sourceKey(id));
}

// Result of `addSource`. Three outcomes:
//   - newSource: a brand-new source row was created (a directory /
//     manifest / github-dir source, or a never-before-seen container
//     auto-created for the first single-file add of its kind). The
//     caller appends a fresh section to the DOM.
//   - existingContainer: the input was a single-file URL/path added
//     into a container that already existed. The caller re-renders
//     that container's section in place.
//   - null: the input was a duplicate (an already-registered source
//     path, or a script URL/path already present in its container).
//     The caller surfaces the duplicate message and jumps to the
//     existing section.
export type AddSourceResult =
  | { kind: 'newSource'; source: StoredSource }
  | { kind: 'existingContainer'; source: StoredSource; scriptId: string }
  | null;

// Register a new source from a raw user input. Dispatches by input
// shape:
//   - single-file `.user.js` URL/path → folded into the matching
//     container source (created on demand if none exists). The script
//     is added to the container's `scriptIds` and its initial fetch
//     runs immediately so the table populates without a manual
//     Refresh.
//   - everything else (directory, manifest, github-dir URL) → mints a
//     UUID, persists an empty source row, then refreshes to populate
//     the scripts.
//
// `normalizeSourceInput` runs first so a github.com `/blob/.../foo.user.js`
// (or `/blob/.../script_manifest.json`) URL gets rewritten to its raw
// counterpart before we hit the duplicate check. The github blob URL
// serves HTML, not raw bytes, so storing it verbatim would silently
// load the page chrome instead of the script — see [docs/http-sources.md].
export async function addSource(rawPath: string): Promise<AddSourceResult> {
  const path = await normalizeSourceInput(rawPath);

  if (isSingleFileInput(path)) {
    return await addScriptToContainer(path);
  }

  const sources = await getSources();
  if (sources.some((s) => s.path === path)) return null;

  const id = crypto.randomUUID();
  const seed: StoredSource = {
    id,
    path,
    lastRefreshedAt: 0,
    scriptIds: [],
    enabled: true,
    // Seed an inferred displayName at add-time so a viewer opened
    // mid-add (or any other reader) doesn't briefly see a row whose
    // name only materialises on the next backfill pass.
    displayName: inferDisplayName(path),
  };
  const nextIndex = [...sources.map((s) => s.id), id];
  await chrome.storage.local.set({
    [SOURCES_INDEX_KEY]: nextIndex,
    [sourceKey(id)]: seed,
  });
  const refreshed = await refreshSource(id);
  // The updater-driven refresh paths already emit per-script Log
  // entries when a script transitions into invalid / missing. This
  // initial-add path bypasses the updater, so anything that lands
  // already broken would otherwise have an empty Log tab. Emit once
  // per non-OK script here so the user can always click the row's
  // INVALID badge and read what went wrong. Awaited so the loglevel
  // sentinel write lands before the caller's `getAllMaxLogLevels`
  // read — otherwise the first paint of the row would briefly show
  // OK and only flip on the storage-change listener.
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLogIfBroken));
  }
  return { kind: 'newSource', source: refreshed?.source ?? seed };
}

// First-run gate. Seeding the default sources is driven from the
// sources page (so the user watches the normal add → Refresh flow,
// rather than scripts appearing silently from the SW); the SW only
// opens that page on install. These two helpers are the persisted flag
// the page and SW share.
export async function isFirstRunComplete(): Promise<boolean> {
  return (await getRaw<boolean>(FIRST_RUN_DONE_KEY)) === true;
}

// Record that first-run handling is done so the SW stops opening the
// seeding page and the sources page stops re-seeding — including after
// the user deletes the seeded sources. Also called by the test-surface
// reset so a cleared store isn't re-seeded.
export async function markFirstRunComplete(): Promise<void> {
  await chrome.storage.local.set({ [FIRST_RUN_DONE_KEY]: true });
}

// Add a single-file input to the matching container source. Creates
// the container row if this is the first script of its kind. Returns
// null if the URL/path is already registered as a script under its
// container. The fetch runs as part of `refreshSource` so the new row
// lands populated.
async function addScriptToContainer(path: string): Promise<AddSourceResult> {
  const kind = containerKindForSingleFileInput(path);
  const cPath = containerPath(kind);
  const sources = await getSources();
  const existingContainer = sources.find((s) => s.path === cPath);
  const isNew = !existingContainer;
  if (existingContainer) {
    // Each container script's `relativePath` is the full URL/path the
    // user added; any prior row with the same value is a duplicate.
    const existingScripts = await getMany(existingContainer.scriptIds.map(scriptKey));
    for (const sid of existingContainer.scriptIds) {
      const s = existingScripts[scriptKey(sid)] as StoredScript | undefined;
      if (s?.relativePath === path) return null;
    }
  }

  const now = Date.now();
  const containerId = existingContainer?.id ?? crypto.randomUUID();
  const scriptId = crypto.randomUUID();
  const priorScriptIds = existingContainer?.scriptIds ?? [];
  const nextContainer: StoredSource = existingContainer
    ? { ...existingContainer, scriptIds: [...priorScriptIds, scriptId] }
    : {
        id: containerId,
        path: cPath,
        lastRefreshedAt: 0,
        scriptIds: [scriptId],
        enabled: true,
        displayName: inferDisplayName(cPath),
      };
  const seedScript = buildInitialInvalidEntry({
    id: scriptId,
    sourceId: containerId,
    relativePath: path,
    fileUrl: scriptFileUrl(cPath, path),
    errorMessage: 'not loaded',
    now,
  });

  // Single set call so a SW restart between writes can never leave a
  // half-populated container — either the new script lands with its
  // container's scriptIds pointing at it (and, for a new container,
  // the sources index pointing at the container), or nothing does.
  const toSet: Record<string, unknown> = {
    [sourceKey(containerId)]: nextContainer,
    [scriptKey(scriptId)]: seedScript,
  };
  if (isNew) {
    toSet[SOURCES_INDEX_KEY] = [...sources.map((s) => s.id), containerId];
  }
  await chrome.storage.local.set(toSet);

  const refreshed = await refreshSource(containerId);
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLogIfBroken));
  }
  const finalSource = refreshed?.source ?? nextContainer;
  if (isNew) return { kind: 'newSource', source: finalSource };
  return { kind: 'existingContainer', source: finalSource, scriptId };
}

async function emitInitialLoadLogIfBroken(script: StoredScript): Promise<void> {
  // `applyMissing` is unreachable from the initial-add path (a brand-
  // new source has nothing existing to mark missing), so this branch
  // is effectively dead today; keep it so a future caller routing
  // through this helper from another entry point gets the same
  // treatment.
  if (script.status !== 'invalid' && script.status !== 'missing') return;
  await appendScriptLog(script.id, {
    level: 'error',
    source: 'add-source',
    message: script.errorMessage
      ?? (script.status === 'missing' ? 'source file is missing' : 'unknown error'),
  });
}

// Fill in `displayName` on any source row that doesn't have one yet.
// Runs at sources-page boot (and at any other entry point that wants
// stable display labels for older rows). Cheap — one read of the
// source index plus one bulk write iff anything was missing. The
// pure-inference rules live in `source-display.ts`; that module only
// imports a TYPE from this file so the cycle is compile-time only.
export async function backfillSourceDisplayNames(): Promise<void> {
  const sources = await getSources();
  const toSet: Record<string, unknown> = {};
  for (const s of sources) {
    if (s.displayName && s.displayName.trim()) continue;
    const next: StoredSource = { ...s, displayName: inferDisplayName(s.path) };
    toSet[sourceKey(s.id)] = next;
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
}

// Reorder the sources index by moving the given source one position
// up or down. No-op if the source is already at the boundary in the
// requested direction (caller-side Up/Down buttons disable themselves
// at the ends, but the function tolerates a redundant call). Only the
// index row is rewritten; per-source rows are untouched.
export async function moveSource(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const ids = await readSourceIndex();
  const idx = ids.indexOf(id);
  if (idx < 0) return;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= ids.length) return;
  const next = ids.slice();
  [next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!];
  await chrome.storage.local.set({ [SOURCES_INDEX_KEY]: next });
}

export async function removeSource(id: string): Promise<void> {
  const source = await getRaw<StoredSource>(sourceKey(id));
  const ids = await readSourceIndex();
  const nextIndex = ids.filter((sid) => sid !== id);
  const removeKeys = [sourceKey(id), ...(source?.scriptIds ?? []).map(scriptKey)];
  await chrome.storage.local.set({ [SOURCES_INDEX_KEY]: nextIndex });
  await chrome.storage.local.remove(removeKeys);
}

// Drop a single script row from storage and remove its ID from the
// parent source's scriptIds list. Used by the sources-page trash-can
// next to a `missing` row so the user can clear out records for files
// that are gone for good — refreshSource won't recreate the row because
// it only adds entries the scan currently reports.
export async function removeScript(id: string): Promise<void> {
  const script = await getRaw<StoredScript>(scriptKey(id));
  if (!script) return;
  const source = await getRaw<StoredSource>(sourceKey(script.sourceId));
  const toSet: Record<string, unknown> = {};
  if (source) {
    const nextIds = source.scriptIds.filter((sid) => sid !== id);
    if (nextIds.length !== source.scriptIds.length) {
      toSet[sourceKey(source.id)] = { ...source, scriptIds: nextIds };
    }
  }
  if (Object.keys(toSet).length > 0) await chrome.storage.local.set(toSet);
  await chrome.storage.local.remove(scriptKey(id));
  // Drop the per-script Log + max-log-level sentinel along with the
  // row itself — otherwise an orphaned session-storage entry would
  // outlive the script it described and confuse any later renderer
  // that happens to scan log levels.
  try {
    await chrome.storage.session.remove([`log:${id}`, `loglevel:${id}`]);
  } catch { /* best-effort: a missing session row isn't an error */ }
}

// Rescan a source + refetch all of its scripts. Adds new files, keeps
// known files (status updated based on fetch result), and reconciles
// vanished files per source kind: directory sources mark them
// `missing` (the file may come back), manifest sources delete them
// (the user explicitly removed the entry). Persists the updated source
// row plus every script row in one set call.
//
// Scan failure (unreadable directory listing, unreadable manifest, bad
// URL) records a `scanError` on the source and **leaves every script
// untouched** — content, status, and enabled state all preserved. We
// can't tell whether a source that won't list is actually empty or
// just temporarily unreachable (remote mount with timed-out creds,
// flaky network, …), so we err on the side of keeping the user's
// scripts running until we see definitive evidence they're gone.
//
// Optimisation: skip the fetch and reuse the prior entry verbatim when
// the source can prove a file is unchanged — file:// uses Chrome's
// directory-listing size+mtime; http(s):// uses a conditional GET
// (304 from the server). This keeps "Refresh All" cheap when most
// scripts are unchanged.
export interface RefreshOptions {
  // `@require` + `@resource` recheck policy. Defaults to 'all'
  // (explicit-Refresh semantics) so callers that don't care get the
  // conservative behavior. The script-updater passes 'preserve' on
  // the opportunistic path so background checks don't redownload
  // every dep on every navigation.
  recheckFiles?: 'all' | 'preserve';
  // Shared cross-script file-fetch cache. When refreshAllSources
  // calls multiple refreshSource concurrently, threading one cache
  // through them lets two scripts (across two sources) referencing
  // the same URL share one fetch. Single refreshSource calls let it
  // default to an empty fresh map.
  fileFetchCache?: FileFetchCache;
}

export async function refreshSource(
  id: string,
  opts: RefreshOptions = {},
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  const prior = await getSourceWithScripts(id);
  if (!prior) return null;
  const { source, scripts: existingScripts } = prior;

  let scan: { relativePath: string; size?: number; mtime?: number }[] = [];
  let scanError: string | undefined;
  if (isContainerSource(source.path)) {
    // Container sources have no scan step — their child scripts are
    // explicit. Build a synthetic scan from the existing rows so the
    // rest of the pipeline can refetch each URL/path. No size/mtime
    // hints; HTTP entries skip via conditional GET, file:// entries
    // always refetch.
    scan = existingScripts.map((s) => ({ relativePath: s.relativePath }));
  } else {
    try {
      scan = await scanForUserScripts(source.path);
    } catch (err) {
      scanError = describeError(err);
    }
  }

  const now = Date.now();

  // Scan failure (unreadable manifest, unreadable top-level directory,
  // bad URL shape) is treated as "we don't actually know what's there
  // right now" — keep every existing script row, its content, and its
  // enabled state untouched. The source row records the scanError so
  // the sources page can surface it. Without this guard, the
  // rebuildSource path below would mark every script `missing` (or, for
  // manifest sources, drop them entirely) — both of which silently
  // disable the scripts. That's the wrong call when the source might
  // just be a remote mount with timed-out credentials, a flaky network,
  // etc.; the user wants the scripts to stay enabled until the source
  // is actually proven gone.
  if (scanError) {
    const nextSource: StoredSource = {
      ...source,
      lastRefreshedAt: now,
      scanError,
    };
    await chrome.storage.local.set({ [sourceKey(id)]: nextSource });
    return { source: nextSource, scripts: existingScripts };
  }

  // Fetch every scanned file in parallel except those whose size+mtime
  // are already current.
  const fetchResults = await fetchOrSkipInParallel(
    source.path,
    scan,
    existingScripts,
  );

  const scripts = await rebuildSource({
    sourceId: source.id,
    sourcePath: source.path,
    existing: existingScripts,
    scan,
    fetchResults,
    now,
    recheckFiles: opts.recheckFiles,
    fileFetchCache: opts.fileFetchCache,
  });

  const nextSource: StoredSource = {
    ...source,
    lastRefreshedAt: now,
    scriptIds: scripts.map((s) => s.id),
  };
  // Clear any scanError left by a previous failed refresh — control
  // only reaches here when the scan succeeded (the early-return above
  // handles the failure case).
  delete nextSource.scanError;

  // Drop rows whose IDs are no longer referenced. Hit by manifest
  // sources whose user removed an entry; also defensive against any
  // future per-script Remove.
  const priorIds = new Set(existingScripts.map((s) => s.id));
  const nextIds = new Set(scripts.map((s) => s.id));
  const toRemove = [...priorIds].filter((sid) => !nextIds.has(sid)).map(scriptKey);

  const toSet: Record<string, unknown> = { [sourceKey(id)]: nextSource };
  for (const s of scripts) toSet[scriptKey(s.id)] = s;
  await chrome.storage.local.set(toSet);
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);

  return { source: nextSource, scripts };
}

// Refetch a single script. Goes through the same per-file pipeline as
// the directory-level Refresh (fetchOrSkipInParallel → rebuildSource)
// so the two paths can't drift — same skip rules, same fsMtime
// handling, same enabled-preservation, same error shape. The single-
// file path additionally lists the file's parent dir once so it has
// the size+mtime needed by the skip check.
//
// Note: does NOT re-scan the parent dir for VANISHED files, so this
// can't promote a script to `missing` — that's the directory-level
// Refresh's job. (If the file is gone, the fetch will fail and the
// result is `status: 'invalid'`.)
export async function refreshScript(
  scriptId: string,
  opts: RefreshOptions = {},
): Promise<StoredScript | null> {
  const prior = await getScript(scriptId);
  if (!prior) return null;
  const sourceRow = await getRaw<StoredSource>(sourceKey(prior.sourceId));
  if (!sourceRow) return null;

  // Build a single-entry scan. Only local-directory sources support
  // the targeted size+mtime listing lookup; HTTP, manifest, and
  // container sources rely on the per-entry skip strategy inside
  // fetchOrSkipInParallel (conditional GETs for HTTP entries, always-
  // fetch for file:// entries reached through a manifest or container).
  const scan: { relativePath: string; size?: number; mtime?: number }[] = [
    { relativePath: prior.relativePath },
  ];
  const usesListingStat =
    !isHttpUrl(sourceRow.path) &&
    !isManifestSource(sourceRow.path) &&
    !isContainerSource(sourceRow.path);
  if (usesListingStat) {
    const slash = prior.relativePath.lastIndexOf('/');
    const subDir = slash >= 0 ? prior.relativePath.slice(0, slash) : '';
    const fileName = slash >= 0 ? prior.relativePath.slice(slash + 1) : prior.relativePath;
    // The "scan directory" is the source path plus any subDir prefix
    // from the relativePath. Normalise any file:// URL form back to a
    // raw fs path before doing path arithmetic so parentDir/joinPath
    // behave correctly.
    const fsRoot = sourceFsPath(sourceRow.path);
    const dirAbs = subDir ? joinPath(fsRoot, subDir) : fsRoot;
    try {
      const stat = await statFromListing(dirAbs, fileName);
      if (stat) {
        if (stat.size !== undefined) scan[0].size = stat.size;
        if (stat.mtime !== undefined) scan[0].mtime = stat.mtime;
      }
    } catch {
      /* listing failed; scan stays bare → always-fetch */
    }
  }

  const fetchResults = await fetchOrSkipInParallel(sourceRow.path, scan, [prior]);
  const result = await rebuildSource({
    sourceId: prior.sourceId,
    sourcePath: sourceRow.path,
    existing: [prior],
    scan,
    fetchResults,
    now: Date.now(),
    recheckFiles: opts.recheckFiles,
    fileFetchCache: opts.fileFetchCache,
  });
  const next = result[0];
  if (!next) return null;
  await chrome.storage.local.set({ [scriptKey(scriptId)]: next });
  return next;
}

// Fetch each scanned file in parallel.
//
// Dispatch is per *entry URL*, not per source: a manifest source may
// list http(s):// entries, file:// entries, or a mix, so each entry
// picks its fetcher and skip strategy based on the resolved URL scheme.
//
// Scheme behaviors:
//   - http(s)://: conditional GET. We send the prior row's ETag /
//     Last-Modified as If-None-Match / If-Modified-Since; a server 304
//     becomes `unchanged`, a 200 carries new validators back through
//     FetchResult.ok for rebuildSource to persist.
//   - file://: direct fetch. If the scan supplied size+mtime (only
//     local-directory scans do — manifests don't), we apply the
//     pre-fetch listing skip when those match the prior row.
//
// In both modes a prior error/missing entry always refetches so it has
// a chance to recover.
export async function fetchOrSkipInParallel(
  sourcePath: string,
  scan: { relativePath: string; size?: number; mtime?: number }[],
  existing: StoredScript[],
): Promise<Map<string, FetchResult>> {
  const byPath = new Map(existing.map((s) => [s.relativePath, s]));
  const results = await Promise.all(
    scan.map(async (found): Promise<[string, FetchResult]> => {
      const prior = byPath.get(found.relativePath);
      const url = scriptFileUrl(sourcePath, found.relativePath);
      if (isHttpUrl(url)) {
        try {
          const fetched = await fetchHttpText(url, prior?.status === 'ok' ? {
            etag: prior.httpEtag,
            lastModified: prior.httpLastModified,
          } : {});
          if (fetched.kind === 'unchanged') {
            return [found.relativePath, { unchanged: true }];
          }
          const ok: FetchResult = { ok: true, source: fetched.text };
          if (fetched.etag) ok.httpEtag = fetched.etag;
          if (fetched.lastModified) ok.httpLastModified = fetched.lastModified;
          return [found.relativePath, ok];
        } catch (err) {
          return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
        }
      }
      // file:// (or any other non-HTTP URL fetchFileUrlText can handle).
      const canSkip =
        prior != null &&
        prior.status === 'ok' &&
        found.size !== undefined && found.mtime !== undefined &&
        prior.size === found.size &&
        prior.fsMtime === found.mtime;
      if (canSkip) {
        return [found.relativePath, { unchanged: true }];
      }
      try {
        const source = await fetchFileUrlText(url);
        return [found.relativePath, { ok: true, source }];
      } catch (err) {
        return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
      }
    }),
  );
  return new Map(results);
}

// Refresh every registered source in parallel. Returns the new state
// per source so callers can compute "what changed" without a second
// read. A failed source-level refresh (e.g. one source's scan
// throws) doesn't take the rest down — its slot in the result map is
// just absent, and the source's `scanError` field carries the reason.
export async function refreshAllSources(
  opts: RefreshOptions = {},
): Promise<Map<string, { source: StoredSource; scripts: StoredScript[] }>> {
  const sources = await getSources();
  // One shared file-fetch cache across every source in this pass so
  // two scripts (across two sources) referencing the same canonical
  // URL share one fetch. Caller can override by passing their own.
  const fileFetchCache = opts.fileFetchCache ?? new Map();
  const entries = await Promise.all(
    sources.map(async (s) => {
      const r = await refreshSource(s.id, { ...opts, fileFetchCache });
      return [s.id, r] as const;
    }),
  );
  const out = new Map<string, { source: StoredSource; scripts: StoredScript[] }>();
  for (const [id, r] of entries) {
    if (r) out.set(id, r);
  }
  return out;
}

// Coerce a caught throw into a printable string. Exported so other
// modules (notably the injector) don't have to duplicate the helper.
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Flip a source's enabled flag without touching anything else. The
// match-index listens for `source:<id>` changes and re-evaluates the
// effective enabled state of every script under this source.
export async function setSourceEnabled(
  id: string,
  enabled: boolean,
): Promise<StoredSource | null> {
  const source = await getRaw<StoredSource>(sourceKey(id));
  if (!source) return null;
  const next: StoredSource = { ...source, enabled };
  await chrome.storage.local.set({ [sourceKey(id)]: next });
  return next;
}

export async function setScriptEnabled(
  id: string,
  enabled: boolean,
): Promise<StoredScript | null> {
  const script = await getRaw<StoredScript>(scriptKey(id));
  if (!script) return null;
  const next: StoredScript = { ...script, enabled };
  await chrome.storage.local.set({ [scriptKey(id)]: next });
  return next;
}

// Flip many scripts' enabled flags in a single storage write. This is
// the bulk-toggle path: it fires exactly one `storage.onChanged` event
// (instead of N), so the background SW's syncRegistrations runs once
// instead of once per script — turning a 15-script toggle from
// quadratic-feeling into a single round-trip.
export async function setScriptsEnabled(
  updates: { id: string; enabled: boolean }[],
): Promise<void> {
  if (updates.length === 0) return;
  const keys = updates.map((u) => scriptKey(u.id));
  const got = await getMany(keys);
  const toSet: Record<string, unknown> = {};
  for (const u of updates) {
    const script = got[scriptKey(u.id)] as StoredScript | undefined;
    if (!script) continue;          // row vanished; skip silently
    if (script.enabled === u.enabled) continue;  // already in target state
    toSet[scriptKey(u.id)] = { ...script, enabled: u.enabled };
  }
  if (Object.keys(toSet).length === 0) return;
  await chrome.storage.local.set(toSet);
}
