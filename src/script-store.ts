// Persistent userscript store backed by chrome.storage.local.
//
// Layout (one row per record, no monolithic blob):
//
//   "sources"          → string[]                   index of source IDs
//   "source:<sid>"     → StoredSource               per-directory metadata
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
  scanForUserScripts,
  scriptFileUrl,
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
  scanError?: string;    // set when the directory listing itself failed
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
export type FetchResult =
  | { ok: true; source: string }
  | { ok: false; errorMessage: string };

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
// renders "MISSING".
export function applyMissing(existing: StoredScript): StoredScript {
  const next: StoredScript = {
    ...existing,
    status: 'missing',
    size: null,
  };
  delete next.errorMessage;
  return next;
}

interface RebuildArgs {
  sourceId: string;
  sourcePath: string;
  existing: StoredScript[];
  scan: { relativePath: string }[];
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
    if (fr && fr.ok) {
      const built = buildScriptFromText({
        id,
        sourceId: args.sourceId,
        relativePath: found.relativePath,
        fileUrl,
        source: fr.source,
        now: args.now,
      });
      // Preserve the user's per-script enabled choice across refreshes.
      if (prior) built.enabled = prior.enabled;
      out.push(built);
    } else if (fr) {
      // Failed fetch. If we had prior content, keep it.
      if (prior) {
        out.push(applyFetchError(prior, fr.errorMessage));
      } else {
        out.push(buildInitialErrorEntry({
          id,
          sourceId: args.sourceId,
          relativePath: found.relativePath,
          fileUrl,
          errorMessage: fr.errorMessage,
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

// Register a brand-new directory: mints a UUID, persists an empty
// source row, then immediately runs a refresh to populate the scripts.
// Returns null if a source with this path is already registered.
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

// Rescan the directory + refetch all of its scripts. Adds new files,
// keeps known files (status updated based on fetch result), and flags
// vanished files as `missing`. Persists the updated source row plus
// every script row in one set call, and removes script rows that
// dropped out (which currently doesn't happen — `missing` rows stay).
export async function refreshSource(
  id: string,
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  const prior = await getSourceWithScripts(id);
  if (!prior) return null;
  const { source, scripts: existingScripts } = prior;

  let scan: { relativePath: string; name: string }[] = [];
  let scanError: string | undefined;
  try {
    scan = await scanForUserScripts(source.path);
  } catch (err) {
    scanError = describeError(err);
  }

  let fetchResults = new Map<string, FetchResult>();
  // Fetch every scanned file in parallel. If the scan itself failed,
  // scan is empty and we skip straight to marking everything missing.
  if (!scanError) {
    fetchResults = await fetchAllInParallel(source.path, scan.map((s) => s.relativePath));
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

// Refetch a single script. On success the entry is rewritten in full.
// On failure we preserve the prior content and just flip the status.
// Does NOT re-scan the parent dir, so this can't promote a script to
// `missing` — that's the directory-level Refresh's job.
export async function refreshScript(scriptId: string): Promise<StoredScript | null> {
  const prior = await getScript(scriptId);
  if (!prior) return null;
  const now = Date.now();
  let next: StoredScript;
  try {
    const source = await fetchFileUrlText(prior.fileUrl);
    next = buildScriptFromText({
      id: prior.id,
      sourceId: prior.sourceId,
      relativePath: prior.relativePath,
      fileUrl: prior.fileUrl,
      source,
      now,
    });
    next.enabled = prior.enabled;
  } catch (err) {
    next = applyFetchError(prior, describeError(err));
  }
  await chrome.storage.local.set({ [scriptKey(scriptId)]: next });
  return next;
}

async function fetchAllInParallel(
  sourcePath: string,
  relativePaths: string[],
): Promise<Map<string, FetchResult>> {
  const results = await Promise.all(
    relativePaths.map(async (rel): Promise<[string, FetchResult]> => {
      try {
        const source = await fetchFileUrlText(scriptFileUrl(sourcePath, rel));
        return [rel, { ok: true, source }];
      } catch (err) {
        return [rel, { ok: false, errorMessage: describeError(err) }];
      }
    }),
  );
  return new Map(results);
}

function describeError(err: unknown): string {
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
