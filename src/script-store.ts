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
// error AND validateHeader returned null. Otherwise `status: 'error'`
// with an `errorMessage`. On refresh, files that were known before but
// no longer appear in the scan listing become `status: 'missing'`; in
// every error/missing case we preserve the previously loaded content
// so the viewer (and, eventually, the injector) keep working.

import {
  fetchFileUrlText,
  fetchHttpText,
  isHttpUrl,
  isManifestSource,
  isSingleFileSource,
  joinPath,
  parentDir,
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

export type ScriptStatus = 'ok' | 'error' | 'missing';

export interface ScriptMatching {
  matches: string[];   // @match values
  excludes: string[];  // @exclude values
  includes: string[];  // @include values
}

export interface StoredScript {
  id: string;            // UUID, stable across refreshes (keyed on relativePath)
  sourceId: string;
  relativePath: string;
  fileUrl: string;
  status: ScriptStatus;
  errorMessage?: string;
  size: number | null;   // UTF-8 byte length; null when status === 'missing'
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
  headerText: string;
  bodyText: string;
  header: ParsedHeader | null;
  matching: ScriptMatching;
  loadedAt: number;      // epoch ms — bumped each time fresh content lands
  enabled: boolean;      // per-script toggle; defaults true on first load
}

export interface StoredSource {
  id: string;
  path: string;
  lastRefreshedAt: number;
  scriptIds: string[];
  scanError?: string;    // set when the scan itself failed (directory listing, manifest fetch, bad URL shape)
  enabled: boolean;      // per-source toggle; defaults true on first load
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
  httpEtag?: string;
  httpLastModified?: string;
}

// Compose a `StoredScript` from freshly fetched source text. Always
// records the new content (so the viewer reflects what's on disk),
// then determines status by running it through split + parse +
// validate. Any failure along that chain lands in `errorMessage` while
// the content fields stay populated.
export function buildScriptFromText(args: BuildArgs): StoredScript {
  const split = splitHeaderBody(args.source);
  const header = parseHeader(args.source);
  const matching = distillMatching(header);
  // UTF-16 string length ≠ file byte length for non-ASCII content;
  // TextEncoder gives us the wire-accurate UTF-8 byte count.
  const size = new TextEncoder().encode(args.source).length;

  let status: ScriptStatus = 'ok';
  let errorMessage: string | undefined;
  if (split.error) {
    status = 'error';
    errorMessage = split.error;
  } else {
    const validationError = validateHeader(header);
    if (validationError) {
      status = 'error';
      errorMessage = validationError;
    }
  }

  const entry: StoredScript = {
    id: args.id,
    sourceId: args.sourceId,
    relativePath: args.relativePath,
    fileUrl: args.fileUrl,
    status,
    size,
    headerText: split.headerText,
    bodyText: split.bodyText,
    header,
    matching,
    loadedAt: args.now,
    // New rows default enabled; existing rows preserve their prior
    // value via the merge in rebuildSource / refreshScript.
    enabled: true,
  };
  if (errorMessage) entry.errorMessage = errorMessage;
  if (args.httpEtag) entry.httpEtag = args.httpEtag;
  if (args.httpLastModified) entry.httpLastModified = args.httpLastModified;
  return entry;
}

// Apply a fetch failure to an existing entry: preserve the prior
// content and just flip status/errorMessage. Size stays at its last
// known value (we know nothing fresh).
export function applyFetchError(
  existing: StoredScript,
  errorMessage: string,
): StoredScript {
  return { ...existing, status: 'error', errorMessage };
}

// Build an `error` entry for a brand-new (never-loaded-successfully)
// script whose first fetch failed. No content to preserve, so the
// content fields stay empty and size is null.
export function buildInitialErrorEntry(args: {
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
    status: 'error',
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

// Flip an existing entry to `missing`. Preserves content for the
// viewer and the (future) injector; nulls out size so the table
// renders "MISSING". Also turns the per-script enabled flag off so a
// script whose file vanished stops being injected — the row stays in
// storage (for the viewer) but won't run. If the file later returns,
// rebuildSource preserves the now-false `enabled` so the user has to
// explicitly opt back in.
//
// HTTP validators (httpEtag / httpLastModified) ride along untouched.
// The conditional-GET path is gated on `prior.status === 'ok'`, so
// stale validators are dormant; if the entry returns and fetches
// cleanly, buildScriptFromText overwrites them from the fresh response.
export function applyMissing(existing: StoredScript): StoredScript {
  const next: StoredScript = {
    ...existing,
    status: 'missing',
    size: null,
    enabled: false,
  };
  delete next.errorMessage;
  return next;
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
}

// Pure orchestrator: given the prior state for a source plus a fresh
// scan and the per-file fetch results, return the new list of
// `StoredScript`s in canonical order (scan order, then any entries
// that fell off the listing tagged `missing`). Stable IDs come from
// looking up by relativePath in `existing`. No I/O — easy to test.
export function rebuildSource(args: RebuildArgs): StoredScript[] {
  const newId = args.newId ?? (() => crypto.randomUUID());
  const existingByPath = new Map<string, StoredScript>();
  for (const e of args.existing) existingByPath.set(e.relativePath, e);

  const out: StoredScript[] = [];
  const handledPaths = new Set<string>();
  for (const found of args.scan) {
    handledPaths.add(found.relativePath);
    const prior = existingByPath.get(found.relativePath);
    const id = prior?.id ?? newId();
    const fileUrl = scriptFileUrl(args.sourcePath, found.relativePath);
    const fr = args.fetchResults.get(found.relativePath);
    if (fr && 'ok' in fr && fr.ok) {
      const built = buildScriptFromText({
        id,
        sourceId: args.sourceId,
        relativePath: found.relativePath,
        fileUrl,
        source: fr.source,
        now: args.now,
        httpEtag: fr.httpEtag,
        httpLastModified: fr.httpLastModified,
      });
      // Preserve the user's per-script enabled choice across refreshes.
      if (prior) built.enabled = prior.enabled;
      // Record the listing's mtime so the next refresh can decide to
      // skip a refetch.
      if (found.mtime !== undefined) built.fsMtime = found.mtime;
      out.push(built);
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
        out.push(next);
      } else {
        out.push(buildInitialErrorEntry({
          id,
          sourceId: args.sourceId,
          relativePath: found.relativePath,
          fileUrl,
          errorMessage: 'unchanged marker with no prior entry',
          now: args.now,
        }));
      }
    } else if (fr) {
      // Failed fetch. If we had prior content, keep it.
      const errorMessage = 'errorMessage' in fr ? fr.errorMessage : 'unknown error';
      if (prior) {
        out.push(applyFetchError(prior, errorMessage));
      } else {
        out.push(buildInitialErrorEntry({
          id,
          sourceId: args.sourceId,
          relativePath: found.relativePath,
          fileUrl,
          errorMessage,
          now: args.now,
        }));
      }
    } else {
      // No fetch attempted at all. Treat like a fetch error with a
      // generic message; this branch is mostly defensive — the
      // orchestrator should always supply a result.
      out.push(prior
        ? applyFetchError(prior, 'not loaded')
        : buildInitialErrorEntry({
            id, sourceId: args.sourceId, relativePath: found.relativePath,
            fileUrl, errorMessage: 'not loaded', now: args.now,
          }));
    }
  }

  // Anything in `existing` that the scan didn't see → missing.
  for (const e of args.existing) {
    if (!handledPaths.has(e.relativePath)) out.push(applyMissing(e));
  }
  return out;
}

// ---------- chrome.storage.local I/O ----------

const SOURCES_INDEX_KEY = 'sources';
const sourceKey = (id: string) => `source:${id}`;
const scriptKey = (id: string) => `script:${id}`;

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

export async function getSource(id: string): Promise<StoredSource | undefined> {
  return await getRaw<StoredSource>(sourceKey(id));
}

// Register a brand-new source (local path or http(s) URL): mints a
// UUID, persists an empty source row, then immediately runs a refresh
// to populate the scripts. Returns null if a source with this path is
// already registered.
export async function addSource(path: string): Promise<StoredSource | null> {
  const sources = await getSources();
  if (sources.some((s) => s.path === path)) return null;

  const id = crypto.randomUUID();
  const seed: StoredSource = {
    id,
    path,
    lastRefreshedAt: 0,
    scriptIds: [],
    enabled: true,
  };
  const nextIndex = [...sources.map((s) => s.id), id];
  await chrome.storage.local.set({
    [SOURCES_INDEX_KEY]: nextIndex,
    [sourceKey(id)]: seed,
  });
  const refreshed = await refreshSource(id);
  return refreshed?.source ?? seed;
}

export async function removeSource(id: string): Promise<void> {
  const source = await getRaw<StoredSource>(sourceKey(id));
  const ids = await readSourceIndex();
  const nextIndex = ids.filter((sid) => sid !== id);
  const removeKeys = [sourceKey(id), ...(source?.scriptIds ?? []).map(scriptKey)];
  await chrome.storage.local.set({ [SOURCES_INDEX_KEY]: nextIndex });
  await chrome.storage.local.remove(removeKeys);
}

// Rescan a source + refetch all of its scripts. Adds new files,
// keeps known files (status updated based on fetch result), and flags
// vanished files as `missing`. Persists the updated source row plus
// every script row in one set call, and removes script rows that
// dropped out (which currently doesn't happen — `missing` rows stay).
//
// Optimisation: skip the fetch and reuse the prior entry verbatim when
// the source can prove a file is unchanged — file:// uses Chrome's
// directory-listing size+mtime; http(s):// uses a conditional GET
// (304 from the server). This keeps "Refresh All" cheap when most
// scripts are unchanged.
export async function refreshSource(
  id: string,
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  const prior = await getSourceWithScripts(id);
  if (!prior) return null;
  const { source, scripts: existingScripts } = prior;

  let scan: { relativePath: string; size?: number; mtime?: number }[] = [];
  let scanError: string | undefined;
  try {
    scan = await scanForUserScripts(source.path);
  } catch (err) {
    scanError = describeError(err);
  }

  let fetchResults = new Map<string, FetchResult>();
  // Fetch every scanned file in parallel except those whose size+mtime
  // are already current. If the scan itself failed, scan is empty and
  // we skip straight to marking everything missing.
  if (!scanError) {
    fetchResults = await fetchOrSkipInParallel(source.path, scan, existingScripts);
  }

  const now = Date.now();
  const scripts = rebuildSource({
    sourceId: source.id,
    sourcePath: source.path,
    existing: existingScripts,
    scan,
    fetchResults,
    now,
  });

  const nextSource: StoredSource = {
    ...source,
    lastRefreshedAt: now,
    scriptIds: scripts.map((s) => s.id),
  };
  if (scanError) nextSource.scanError = scanError;
  else delete nextSource.scanError;

  // Drop rows whose IDs are no longer referenced (currently never, but
  // defensive: protects us if we ever add per-script Remove).
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
// result is `status: 'error'`.)
export async function refreshScript(scriptId: string): Promise<StoredScript | null> {
  const prior = await getScript(scriptId);
  if (!prior) return null;
  const sourceRow = await getRaw<StoredSource>(sourceKey(prior.sourceId));
  if (!sourceRow) return null;

  // Build a single-entry scan. Only local directory / single-file
  // sources support the targeted size+mtime listing lookup; HTTP and
  // manifest sources rely on the per-entry skip strategy inside
  // fetchOrSkipInParallel (conditional GETs for HTTP entries, always-
  // fetch for file:// entries reached through a manifest).
  const scan: { relativePath: string; size?: number; mtime?: number }[] = [
    { relativePath: prior.relativePath },
  ];
  const usesListingStat =
    !isHttpUrl(sourceRow.path) && !isManifestSource(sourceRow.path);
  if (usesListingStat) {
    const slash = prior.relativePath.lastIndexOf('/');
    const subDir = slash >= 0 ? prior.relativePath.slice(0, slash) : '';
    const fileName = slash >= 0 ? prior.relativePath.slice(slash + 1) : prior.relativePath;
    // For a single-file source, the "scan directory" is the file's parent
    // — sourceRow.path itself points at the file. For a directory source,
    // it's the source path plus any subDir prefix from the relativePath.
    // Normalise any file:// URL form back to a raw fs path before doing
    // path arithmetic so parentDir/joinPath behave correctly. The
    // local-vs-HTTP gate already happened above via `usesListingStat`,
    // so isSingleFileSource here distinguishes single-file from
    // directory within the local case.
    const fsRoot = sourceFsPath(sourceRow.path);
    const dirAbs = isSingleFileSource(sourceRow.path)
      ? parentDir(fsRoot)
      : (subDir ? joinPath(fsRoot, subDir) : fsRoot);
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
  const result = rebuildSource({
    sourceId: prior.sourceId,
    sourcePath: sourceRow.path,
    existing: [prior],
    scan,
    fetchResults,
    now: Date.now(),
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
export async function refreshAllSources(): Promise<
  Map<string, { source: StoredSource; scripts: StoredScript[] }>
> {
  const sources = await getSources();
  const entries = await Promise.all(
    sources.map(async (s) => {
      const r = await refreshSource(s.id);
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
