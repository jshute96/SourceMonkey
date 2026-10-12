// Persistent userscript store backed by chrome.storage.local.
//
// Layout (one row per record, no monolithic blob):
//
//   "collections"      → string[]            index of collection IDs
//   "collection:<cid>" → StoredCollection     per-collection metadata
//   "script:<scid>"    → StoredScript         per-script content+header
//
// Collections own their scripts via `scriptIds`. Scripts back-reference
// their collection via `collectionId` so the viewer page can refresh a
// single script without first looking up its parent.
//
// All add/refresh flows go through one pipeline:
//   listing → fetch each file → splitHeaderBody → parseHeader →
//   validateHeader → distillMatching → buildScriptFromText.
// `validateHeader` onward is in script-build.ts, which touches no
// storage (the header parser is userscript-header.ts).
//
// A script is `ok` iff fetch succeeded AND splitHeaderBody returned no
// error AND validateHeader returned null. Otherwise `status: 'invalid'`
// with an `errorMessage`. On refresh, files that were known before but
// no longer appear in the scan listing are dropped — row and storage key
// both — whatever kind of collection they sat in, and however many
// went: a successful scan is the collection saying what it holds now.
// (A listing that isn't one — an error page, a moved directory — fails
// the scan instead, and a failed scan touches nothing; see
// `isDirectoryListing`.) In every error case we preserve the
// previously loaded content so the viewer (and the injector) keep
// working.
//
// Refresh failures get special, gentler handling so a transient
// outage never disables a working script. When a prior `ok` row's
// refresh fails — a hard fetch failure (network / 404 / unreadable
// file / disconnected mount), an http(s) 200 that parses `invalid` (a
// login / error page in place of the script), or a failed
// `@require`/`@resource` fetch — we keep the last-known-good row
// running (`status` stays `ok`, still injectable) and record the
// reason in `refreshError`. The next clean refresh clears it. A
// file:// body that parses `invalid` is the one exception: a local
// read returns the file's real bytes, so that's a genuine edit and we
// flag it `invalid` immediately. See [docs/storage.md].
//
// If the scan step itself fails (unreadable listing, unreadable
// manifest, …), refreshCollection records the error in `scanError` on
// the collection row and leaves every existing script untouched — see
// that function's docstring for the rationale.

import {
  canonicalCollectionInput,
  containerKindForSingleFileInput,
  containerPath,
  fetchScriptFileUrlText,
  fetchScriptFileWithStat,
  fetchHttpText,
  isContainerCollection,
  isHttpUrl,
  isLocalDirectoryCollection,
  isSingleFileInput,
  isScratchUrl,
  scratchFilesKey,
  scratchSourceKey,
  scratchTextKey,
  scratchUrl,
  isSmDevCollection,
  smDevContainerPath,
  smDevRunOfContainer,
  baseName,
  isFileUrl,
  isManifestCollection,
  parentDir,
  type ListingEntry,
  newContainerPath,
  normalizeCollectionInput,
  SINGLE_SCRIPT_USE_ADD_FIELD,
  scanForUserScripts,
  scriptFileUrl,
  statFileByListing,
  collectionCanonicalUrl,
  locationFsPath,
  statFromListing,
  hasCachedListing,
  type DirectoryListingCache,
  type ScratchSource,
} from './directories.js';
import {
  getValue,
  parseHeader,
} from '../userscript-header.js';
import {
  bindListingCache,
  prefetchKnownStandIns,
  type FileFetchCache,
  type PushedFile,
} from '../external-files.js';
import { type LocalFileScope, type LocalLookup } from '../local-file-overrides.js';
import { scanAllStorage, scanStorageRows } from './storage-scan.js';
import { cachedRows, cachedScriptRows, allCachedRows } from './row-cache.js';
import { callWorker } from './worker-client.js';
import { assertWorkerContext, isPageContext } from '../run-context.js';
import {
  blobKeysOf,
  clearMigrationFailureForTests,
  fromStorage,
  hydrateScriptRows,
  carryBodyRef,
  MISSING_BLOB_MESSAGE,
  markMissingBlobs,
  newBlobItems,
  storedForm,
  migrateToBlobs,
  STORE_FORMAT,
  STORE_FORMAT_KEY,
  sweepUnusedBlobs,
  withBlobs,
  type ScriptRow,
  type SweepResult,
} from './script-blobs.js';
import { sameScript } from './script-keys.js';
import { compareInCollection, preferredCopy } from './copy-preference.js';
import { wipeValues } from './value-store.js';
import { connectGrantsKey } from './connect-grants.js';
import { sourceUsesUnsafeWindow } from '../unsafe-window-use.js';
import type { VersionProbe } from '../version-probe.js';
import {
  describeDiagnostic,
  type DiagnosticLocation,
} from '../diagnostic-location.js';
import {
  collectionNameInUse,
  inferDisplayName,
  mayUseReservedName,
  RESERVED_COLLECTION_NAME,
} from './collection-display.js';
import { appendScriptLog, forgetScriptLogs, type LogLevel } from './script-log.js';
import { displayLocation, stripSriFragment, type LoadState } from '../script-display.js';
import { setRefreshError, pruneRefreshErrors } from './refresh-error.js';
import {
  mapWithConcurrency,
  FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
  FETCH_COLLECTIONS_CONCURRENCY,
  PARSE_RECHECK_CONCURRENCY,
} from './concurrency.js';
import { dlog } from '../debug-log.js';
import {
  COLLECTIONS_INDEX_KEY, COLLECTION_PREFIX, ENABLEMENT_TIMES_KEY, SCRIPT_PREFIX, collectionKey, scriptKey,
} from './structural-keys.js';
import { startPhaseTimer, storageSize, timePhase, formatMs, timingNow, type PhaseTimer } from '../phase-timing.js';
import {
  applyFetchError,
  applyFiles,
  applyParseCheck,
  applyVerdictFields,
  buildInitialInvalidEntry,
  buildScriptFromText,
  describeError,
  type FetchResult,
  locationIn,
  parseChecker,
  parseCheckKey,
  type ParseCheckMode,
  rederivedStartupLogs,
  RETIRED_CONTEXT_MENU_UNSUPPORTED,
  type ScriptMeta,
  type ScriptStatus,
  setScriptError,
  type StoredScript,
  validateHeader,
} from '../script-build.js';

// The storage-free half of the pipeline, re-exported for the callers
// that reach it through here.
export {
  applyFetchError,
  applyFiles,
  buildInitialInvalidEntry,
  buildScriptFromText,
  RETIRED_CONTEXT_MENU_UNSUPPORTED,
  describeError,
  distillMatching,
  extractStartupLogs,
  hashSource,
  IMPLICIT_UNSAFE_WINDOW_INFO,
  ISOLATED_UNSAFE_WINDOW_WARNING,
  NO_MATCH_OR_INCLUDE,
  NO_NAME,
  noConnectInfo,
  setParseChecker,
  setScriptError,
  SYNTAX_ERROR_PREFIX,
  unsupportedRunAtWarning,
  validateHeader,
} from '../script-build.js';
export type {
  FetchResult,
  HeaderProblem,
  ParseChecker,
  ParseCheckMode,
  ScriptMatching,
  ScriptMeta,
  ScriptStatus,
  StartupLog,
  StoredScript,
} from '../script-build.js';

// Two states that used to share the message `not loaded`, which read as
// the same fact but isn't: one is a row waiting for its first fetch, the
// other is a row whose fetch never happened and won't be retried until
// the next refresh.
const NOT_LOADED_YET = 'Not loaded yet';
const NOT_READ = 'Could not be read';

// The per-script Log entry a row's *persisted load state* warrants, or
// null when the row is healthy (`ok` with no `refreshError`).
//
// Single source of truth for "how do we phrase this failure in the
// Log tab", shared by every path that can surface one: the add path
// (script-store), the refresh outcome path and the startup replay
// (script-updater), and the deferred parse check. Sharing it means the
// same failure reads the same way whichever path reported it, so a
// user comparing two rows can tell "the same problem again" from "a
// different problem".
//
// Each entry carries the `state` it moved the row into — the same word
// the Status badge shows — so the Log tab's status column and the badge
// agree (see `LogEntry.state`). Because it carries a state, the entry
// never bumps the `loglevel:` sentinel: the badge comes from the row
// and clears when the row recovers.
//
// Levels (still recorded on the entry, though the Log tab's Status
// cell shows the `state` word instead):
//   - `invalid` → **error**. The script cannot run: the injector skips
//     `invalid` rows outright.
//   - `refreshError` → **warning**. The script IS still running, from
//     its last-known-good copy; only the *update* failed.
export function loadStateLogEntry(
  script: Pick<StoredScript, 'status' | 'errorMessage' | 'refreshError' | 'errorLocation'>,
): { level: LogLevel; state: LoadState; message: string; location?: DiagnosticLocation } | null {
  if (script.status === 'invalid') {
    // The location travels as its own field rather than being baked
    // into the text, so the Log tab can link it — and so this entry
    // says exactly what the status badge's hover text says.
    return {
      level: 'error',
      state: 'invalid',
      message: script.errorMessage ?? 'Unknown error',
      ...(script.errorLocation ? { location: script.errorLocation } : {}),
    };
  }
  if (script.refreshError) {
    return { level: 'warning', state: 'refresh-failed', message: `Refresh failed: ${script.refreshError}` };
  }
  return null;
}

// Log lines for local stand-ins that started, stopped, or changed on
// disk between two versions of a row.
//
// Why log this at all: running something other than what the `@require`
// line names is exactly the kind of substitution that must not be
// silent. The viewer marks it too (a `local` chip on the tab and in the
// details panel), but the Log is what says *when* it happened, and a
// re-read after an edit is the signal a developer is actually watching
// for.
//
// Why it isn't noisy: `contentHash` gates the "still using it" case, so
// a stand-in that hasn't changed says nothing on the dozens of
// opportunistic refreshes between edits.
//
// All `info`, losing a stand-in included: the script is back on the
// code its `@require` line names, which is not a fault. The line says
// what is loaded now, so the switch is still on record.
// How a declared reference reads in a Log line: the SRI hash tail
// dropped (it's most of the line's width and nothing the reader can act
// on) and percent-escapes decoded, so a URL carrying a script's name
// reads as `my lib/util.js` rather than `my%20lib/util.js`. Same
// treatment every other URL a human sees already gets.
const refText = (ref: string): string => displayLocation(stripSriFragment(ref));

export function localFileLogMessages(
  prior: ScriptMeta | undefined,
  next: ScriptMeta,
): { level: LogLevel; message: string }[] {
  const out: { level: LogLevel; message: string }[] = [];
  // Keyed by KIND + declared URL. The URL alone would collide: a
  // `@require` and a `@resource` pointing at the same URL is an
  // explicitly supported case (they share one fetch — see
  // external-files.ts), and a single map would hand the require the
  // resource's record on a last-write-wins basis.
  //
  // The URL rather than the ref is the right half of the key: it's the
  // field that stays put while the stand-in appears and disappears
  // underneath it.
  const priorFiles = new Map<string, { localUrl?: string; contentHash: string }>();
  const priorKey = (kind: string, url: string): string => `${kind}\n${url}`;
  for (const f of prior?.requires ?? []) {
    priorFiles.set(priorKey('require', f.url), { localUrl: f.localUrl, contentHash: f.contentHash });
  }
  for (const f of prior?.resources ?? []) {
    priorFiles.set(priorKey('resource', f.url), { localUrl: f.localUrl, contentHash: f.contentHash });
  }
  for (const kind of ['require', 'resource'] as const) {
    const list = kind === 'require' ? (next.requires ?? []) : (next.resources ?? []);
    for (const f of list) {
      const was = priorFiles.get(priorKey(kind, f.url));
      if (f.localUrl) {
        // Same file, same bytes as last pass → nothing happened.
        if (was?.localUrl === f.localUrl && was.contentHash === f.contentHash) continue;
        out.push({
          level: 'info',
          message: `@${kind} ${refText(f.ref)} is loading from ${displayLocation(f.localUrl)}`,
        });
      } else if (was?.localUrl) {
        out.push({
          level: 'info',
          message: `@${kind} ${refText(f.ref)} is no longer loading from a local file; `
            + 'the remote version is loaded instead',
        });
      }
    }
  }
  // A declaration the script dropped isn't reported — the `@require`
  // line going away is the event, and it isn't this function's to tell.
  //
  // Deduped because two `@resource` lines may name the same URL under
  // different names (deliberately — see `distillResources`), and both
  // entries would otherwise produce the identical line.
  const seen = new Set<string>();
  return out.filter((e) => !seen.has(e.message) && seen.add(e.message));
}

export interface StoredCollection {
  id: string;
  path: string;
  lastRefreshedAt: number;
  scriptIds: string[];
  scanError?: string;    // set when the scan itself failed (directory listing, manifest fetch, bad URL shape)
  enabled: boolean;      // per-collection toggle; defaults true on first load
  // Short, human-readable label for the collections page heading + the
  // viewer's Collection row. Backfilled from `inferDisplayName(path)`
  // on first read after upgrade (see `backfillCollectionDisplayNames`)
  // so every persisted row carries one. Treated as a future user-
  // overridable value: when set, the UI uses it verbatim; the inferred
  // form is only consulted when this field is absent/empty.
  displayName?: string;
  // Per-collection opt-OUT of local stand-ins for `@require` /
  // `@resource` files (see `src/local-file-overrides.ts` and
  // docs/local-file-overrides.md). Only an explicit `false` disables
  // it, so every row persisted before this field existed reads as
  // enabled — which is the behavior a local directory collection wants
  // by default.
  //
  // Off is for a directory of scripts you didn't write, where a file
  // sitting next to a script should NOT quietly stand in for the
  // library it names.
  localFiles?: boolean;
  // A `file://` manifest's own listing size and mtime at the last
  // successful scan, so a page can tell the manifest was edited without
  // re-reading it (file-changes.ts). Absent for every other kind, and
  // when the manifest's folder wouldn't list.
  manifestSize?: number;
  manifestMtime?: number;
}

// Treat any pre-`localFiles`-era stored entry as enabled, the same way
// `isCollectionEnabled` treats `enabled`.
export function collectionUsesLocalFiles(collection: StoredCollection): boolean {
  return collection.localFiles !== false;
}

// Everything the local-stand-in resolver needs from a collection row,
// in one value — so no caller can pass the toggle and forget the root.
export function localFileScope(collection: StoredCollection): LocalFileScope {
  return { enabled: collectionUsesLocalFiles(collection), collectionPath: collection.path };
}

// Treat any pre-`enabled`-era stored entry as enabled. The schema now
// requires `enabled: boolean`, but rows persisted before this field was
// introduced will read back as undefined; only an explicit `false`
// should count as disabled.
export function isCollectionEnabled(collection: StoredCollection): boolean {
  return collection.enabled !== false;
}
export function isScriptEnabled(script: ScriptMeta): boolean {
  return script.enabled !== false;
}

// Re-derive the parse verdict for rows that carry none, and persist
// what comes back.
//
// ---------- Why a second entry point ----------
//
// `applyParseCheck` runs inside the load pipeline, so it only ever
// sees rows that are being *built* — added, refreshed, edited. A row
// that was stored before the check existed, or while the check was
// failing open (no offscreen document, sandbox unavailable), keeps
// `status: 'ok'` with no `parseCheckedHash` and is never revisited
// until something rebuilds it. Registering one of those is how
// unparsable source reaches Chrome.
//
// That matters beyond the script not running. A registered entry that
// V8 refuses to compile raises an uncaught `SyntaxError` attributed to
// the extension, which Chrome files under
// `chrome://extensions/?errors` — nothing can catch it in-page, and it
// reads as SourceMonkey being broken rather than the script being
// broken. Not registering it is the only way to keep it out of there;
// the seal entry (`__smSealed`) stays as the backstop for whatever
// still gets through.
//
// Caller passes the rows it is about to register — checking a
// disabled script would spend a round trip on code nothing will run.
//
// Returns, keyed by id, the rows whose STORED state differs from the
// copy the caller passed in — the ones this pass wrote, and the ones it
// refused to write because someone else had already moved the row. The
// caller's job is the same either way: swap ours in. Returning only the
// rows we WROTE is what made the refusal branches below a bug —
// `revalidateCandidates` falls back to the snapshot it read before the
// check, which is the row that still says `ok`, and registers the very
// body we just declined to write a verdict over.
//
// One case is deliberately not covered: a row DELETED while the check
// was out is absent from the result, because there is no stored row to
// hand back. The caller keeps its snapshot and registers a script that
// no longer exists for one cycle, until the write that deleted it
// schedules the sync that drops it.
//
// Fails open exactly like the pipeline check: no checker, an
// inconclusive verdict, or a throw all leave the row alone.
export async function verifyParseChecks(
  scripts: StoredScript[],
): Promise<Map<string, StoredScript>> {
  const changed = new Map<string, StoredScript>();
  if (!parseChecker) return changed;
  // A row the check couldn't decide on records nothing, so it stays
  // stale and is asked about again on the next sync. That is
  // deliberate: the two ways to be undecided are "the machinery isn't
  // there" (answered without compiling anything, and it can come back
  // — the off-switch the tests use lives here) and "V8 ran out of
  // parser budget", which the sandbox's own circuit breaker already
  // rations. Remembering the verdict-free attempt instead would mean a
  // row checked while the machinery was down never gets checked again.
  const stale = scripts.filter(
    (s) => s.status === 'ok' && s.parseCheckedHash !== parseCheckKey(s),
  );
  if (stale.length === 0) return changed;
  // Rows another pass is already compiling are joined rather than
  // compiled again. Both entry points reach the same bytes on the
  // reload path — the deferred check the refresh started, and the sync
  // that same refresh's write scheduled — and a compile is the
  // expensive part of this whole feature. See `inFlightChecks`.
  const own: StoredScript[] = [];
  const joined: Promise<void>[] = [];
  for (const s of stale) {
    const running = inFlightChecks.get(inFlightCheckKey(s));
    if (running) joined.push(running.then((row) => { if (row) changed.set(s.id, row); }));
    else own.push(s);
  }
  // Declared out here and filled inside the `try` so a throw partway
  // through the claim loop still reaches the `finally` that settles it.
  // A claimed key with no resolver would wedge every later pass over
  // that row on a promise that never settles. (`const settle =` inside
  // the `try` cannot work — the `finally` would read it in its TDZ.)
  const settle = new Map<string, InFlightCheck>();
  try {
    claimInFlightChecks(own, settle);
    await Promise.all([runOwnParseChecks(own, changed), ...joined]);
  } finally {
    // Resolve with the row as it now stands so a joiner gets what a
    // caller of its own would have got — including the refusal cases,
    // where the row we hand back is someone else's write rather than
    // ours. A throw resolves them with the input row, which is what
    // "nothing was recorded" looks like to every reader.
    for (const [key, entry] of settle) {
      entry.resolve(changed.get(entry.id) ?? null);
      inFlightChecks.delete(key);
    }
  }
  return changed;
}

// The compile-and-store half of `verifyParseChecks`, for the rows this
// call owns. Fills `changed` in place.
async function runOwnParseChecks(
  own: StoredScript[],
  changed: Map<string, StoredScript>,
): Promise<void> {
  if (own.length === 0) return;
  // `prior` is deliberately undefined: the short-circuit it exists for
  // is the one the staleness filter already applied.
  //
  // Capped rather than `Promise.all`: `own` is normally empty or tiny,
  // but the first sync after an extension update finds the whole
  // library stale at once (the version is part of the key), and each
  // compile composes a whole program in memory.
  const checked = await mapWithConcurrency(
    own,
    PARSE_RECHECK_CONCURRENCY,
    (s) => applyParseCheck({ ...s }, undefined),
  );
  const verdicts = new Map<string, StoredScript>();
  for (const next of checked) {
    // Nothing to record when the check couldn't decide — no verdict,
    // no fingerprint, and the row is untouched.
    if (next.status === 'ok' && !next.parseCheckedHash) continue;
    verdicts.set(next.id, next);
  }
  if (verdicts.size === 0) return;
  // Rows this pass wrote and that can no longer run. Collected inside
  // the lock, reported outside it — a Log append is not storage-row
  // work and has its own queue.
  const flipped: StoredScript[] = [];
  await mutate(async () => {
    const keys = [...verdicts.keys()].map(scriptKey);
    const got = await getMany(keys);
    const toSet: Record<string, unknown> = {};
    for (const [id, next] of verdicts) {
      // Re-read rather than trusting the copy we checked: the check is
      // a round trip to the offscreen document, and a refresh could have
      // rewritten the row while it was out. A row whose fingerprint
      // inputs moved is one our verdict is no longer about.
      const current = got[scriptKey(id)] as StoredScript | undefined;
      // The row was deleted while the check was out. Nothing to write
      // and nothing to hand back — a row that isn't stored is not a row
      // the caller can be given a fresher copy of.
      if (!current) continue;
      if (parseCheckKey(current) !== parseCheckKey(next)) {
        // Refused, not dropped: the caller is holding a copy from
        // before this row moved, and letting it fall back to that is
        // how an unchecked body gets registered.
        changed.set(id, current);
        continue;
      }
      // The verdict was formed against a row that was `ok`. A row that
      // has since left that state left it for a reason this check knows
      // nothing about — a read failed, a `@require` stopped loading —
      // and writing our `status` over it would resurrect a state that
      // is no longer true. The fingerprint alone doesn't catch this:
      // `applyFetchError` preserves the content the fingerprint is made
      // of.
      if (current.status !== 'ok') {
        changed.set(id, current);
        continue;
      }
      // Merge the verdict ONTO the row we just read, rather than
      // writing the copy we checked. Same fingerprint doesn't mean same
      // row: `enabled`, `versionProbes` and the rest can have moved
      // while the check was out, and writing our copy would roll them
      // back.
      const merged = applyVerdictFields(current, next);
      changed.set(id, merged);
      toSet[scriptKey(id)] = merged;
      if (merged.status !== 'ok') flipped.push(merged);
    }
    if (Object.keys(toSet).length > 0) await writeLocal(toSet);
  });
  // Say so in the Log. This lives here rather than at a caller because
  // whichever pass wins the write is the one that knows — the deferred
  // check, the sync's gate before registration, or a later sync after
  // the worker was evicted mid-check. Keyed off what was WRITTEN, so a
  // refused verdict stays quiet rather than announcing a state it
  // didn't put there.
  for (const row of flipped) {
    const entry = loadStateLogEntry(row);
    if (entry) void appendScriptLog(row.id, { ...entry, source: 'parser' });
  }
}

// Save as `invalid` the rows among `ids` that point at a blob that isn't
// there, and say so in each one's Log. The registration sync calls this
// for the candidates it found that way: it's the one body reader that
// runs on its own, and without the write the pages, which read only the
// rows, would show the script as fine while it no longer runs.
//
// Decided again inside the lock from the rows and blobs stored then, so
// a refresh that repaired a row since isn't undone. A row already
// `invalid` is left alone.
export async function recordMissingBlobs(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const flipped: ScriptMeta[] = [];
  await mutate(async () => {
    const rows = await getRows(ids.map(scriptKey));
    const keys = [...new Set(Object.values(rows).flatMap(blobKeysOf))];
    const blobs = keys.length > 0 ? await chrome.storage.local.get(keys) : {};
    const toSet: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rows)) {
      const row = value as ScriptRow;
      if (row.status !== 'ok') continue;
      const marked = markMissingBlobs(row, blobs);
      if (!marked) continue;
      toSet[key] = marked;
      flipped.push(marked);
    }
    if (flipped.length > 0) await writeLocal(toSet);
  });
  for (const row of flipped) {
    const entry = loadStateLogEntry(row);
    if (entry) void appendScriptLog(row.id, { ...entry, source: 'storage' });
  }
}

// Parse checks in flight, keyed by row id + fingerprint, so two passes
// over the same bytes compile once. The reload path produces exactly
// that overlap by design: the refresh defers its check and starts one
// here, and its storage write schedules a sync whose registration gate
// finds the same row unchecked ~50 ms later.
//
// Keyed on the fingerprint as well as the id because a row that moved
// again is different work, not the same work twice.
//
// Per JS context, like every other module-level table here. Only the
// worker runs checks now, so in practice this is the worker's map.
interface InFlightCheck {
  id: string;
  resolve: (row: StoredScript | null) => void;
}
const inFlightChecks = new Map<string, Promise<StoredScript | null>>();
const inFlightCheckKey = (s: StoredScript): string => `${s.id}|${parseCheckKey(s)}`;

// Register `own` as in flight, recording into `settle` the resolvers the
// caller must settle when it is done. Claimed synchronously, before the
// first await, so a pass starting later in the same turn joins rather
// than duplicating.
//
// Fills a caller-owned map rather than returning one so a throw
// mid-loop still leaves the caller holding what was claimed so far —
// see the `finally` in `verifyParseChecks`.
function claimInFlightChecks(
  own: StoredScript[],
  settle: Map<string, InFlightCheck>,
): void {
  for (const s of own) {
    const key = inFlightCheckKey(s);
    if (inFlightChecks.has(key)) continue;   // same row twice in one call
    let resolve!: (row: StoredScript | null) => void;
    inFlightChecks.set(key, new Promise<StoredScript | null>((r) => { resolve = r; }));
    settle.set(key, { id: s.id, resolve });
  }
}

// No reset hook for `inFlightChecks`, unlike the other worker module
// state `resetAllState` clears by name: an entry only exists while a
// check is running and its `finally` removes it, so there is nothing
// for a storage wipe to strand. A wipe landing mid-check leaves at most
// one already-started compile whose write is refused when the row it
// judged is gone.

// Run the check a `ParseCheckMode: 'defer'` refresh skipped, after that
// refresh has already stored its row. Not awaited by its caller — the
// point of deferring is that nothing waits for the verdict.
//
// `verifyParseChecks` is the whole implementation: it re-reads the row
// inside the write lock, refuses to apply a verdict the row has moved
// out from under, and merges only the verdict's own fields. That is
// exactly the race a late verdict has to survive, so this deliberately
// does not open a second path to the same write.
//
// If the worker dies before the verdict lands, the row simply stays
// unchecked: it carries no `parseCheckedHash`, so the gate every
// registration sync runs (`revalidateCandidates` in injector.ts) finds
// it stale and derives the verdict before Chrome is offered the body.
// What is lost is timeliness, not the check.
export function checkParsesInBackground(script: StoredScript): void {
  if (script.status !== 'ok') return;
  if (script.parseCheckedHash === parseCheckKey(script)) return;
  void verifyParseChecks([script]).catch((err) => {
    // Same failing-open contract as the pipeline check: the row stays
    // unchecked, and the gate before registration asks again.
    dlog(`[SourceMonkey] deferred parse check failed for ${script.relativePath}: ${describeError(err)}`);
  });
}

interface ScanEntry {
  relativePath: string;
  size?: number;
  mtime?: number;
}

// Does an `invalid` parse of this entry keep the PRIOR copy running,
// rather than becoming the row's new state?
//
// True for an http(s) entry with a prior `ok` copy: a 200 that doesn't
// parse is usually a login or error page served in place of the script,
// so it is a *refresh* failure (`refreshError`, still injecting the
// cached body) and not a content replacement. A `file://` read returns
// the file's real bytes, so an `invalid` parse there is a genuine local
// edit the user wants flagged immediately.
//
// One predicate, two readers: the rule itself in `rebuildCollection`,
// and the decision about whether that entry's parse check may be
// deferred. Deferring is only safe where the verdict lands on the row
// directly, so the two have to answer the same question — hence one
// function rather than two spellings of it 60 lines apart.
function keepsPriorOnInvalid(
  fileUrl: string,
  prior: StoredScript | undefined,
): prior is StoredScript {
  return isHttpUrl(fileUrl) && prior?.status === 'ok';
}

interface RebuildArgs {
  collectionId: string;
  collectionPath: string;
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
  // level refresh entry point (refreshCollection / refreshScript /
  // refreshAllCollections); rebuildCollection itself never mutates the
  // entry semantics, just hands the cache to attachFiles.
  fileFetchCache?: FileFetchCache;
  // What this collection says about local stand-ins for the files its
  // scripts declare — the `StoredCollection.localFiles` toggle plus the
  // root to search. One value rather than the whole collection row, and
  // `localFileScope` is the one thing that builds it. Defaults to
  // disabled so a caller that hasn't thought about it gets the
  // declared-URL-only behavior.
  localFiles?: LocalFileScope;
  // Whether the rows this returns carry a parse verdict. Defaults to
  // 'await'; see `ParseCheckMode`. A 'defer' caller owes the rows a
  // `checkParsesInBackground` after it has written them.
  parseCheck?: ParseCheckMode;
}

// Pure orchestrator: given the prior state for a collection plus a
// fresh scan and the per-file fetch results, return the new list of
// `StoredScript`s in canonical order (scan order). Stable IDs come
// from looking up by relativePath in `existing`. No I/O — easy to test.
//
// Vanished-entry handling — an entry the scan no longer reports is
// dropped entirely (the `refreshCollection` caller then deletes the
// storage row), because a successful scan is the collection telling us
// what it holds now: a renamed or deleted file would otherwise linger
// as a row the user has to clear by hand. That holds for a scan that
// found nothing at all, too — an empty directory, or one with no
// `.user.js` files left in it, is as definite as an empty manifest.
// What it does NOT hold for is a scan that failed, and that never
// reaches here: `refreshCollection` records the `scanError` and leaves
// every row alone. The listing reader is what keeps the two apart
// (`isDirectoryListing` in directories.ts).
export async function rebuildCollection(args: RebuildArgs): Promise<StoredScript[]> {
  const newId = args.newId ?? (() => crypto.randomUUID());
  const recheckFiles = args.recheckFiles ?? 'all';
  const fileFetchCache: FileFetchCache = args.fileFetchCache ?? new Map();
  const localFiles: LocalFileScope = args.localFiles ?? { enabled: false };
  const parseCheck = args.parseCheck ?? 'await';
  // Deferring is only safe where the deferred verdict does exactly what
  // an awaited one would have done — and where `keepsPriorOnInvalid`
  // holds it would not, because that rule reads the status the pipeline
  // hands back and a verdict arriving after it has run would replace a
  // working script with the garbage instead of preserving it. Same
  // predicate as the rule itself, so the two cannot drift apart.
  const parseCheckFor = (
    fileUrl: string, prior: StoredScript | undefined,
  ): ParseCheckMode =>
    parseCheck === 'defer' && !keepsPriorOnInvalid(fileUrl, prior) ? 'defer' : 'await';
  const existingByPath = new Map<string, StoredScript>();
  for (const e of args.existing) existingByPath.set(e.relativePath, e);

  // Each scanned entry resolves to one StoredScript. Most paths are
  // synchronous (unchanged, error, defensive fallbacks); the `ok`
  // path goes through buildScriptFromText which is async because the
  // content-hash uses SubtleCrypto, and applyFiles which fetches this
  // entry's `@require` / `@resource` bodies. We collect every branch as
  // a thunk and run them with bounded concurrency at the end, so the
  // async work overlaps without putting every entry's dependency
  // payloads in flight at once, and the output order matches scan order.
  const entryTasks: (() => Promise<StoredScript>)[] = [];
  for (const found of args.scan) {
    const prior = existingByPath.get(found.relativePath);
    const id = prior?.id ?? newId();
    const fileUrl = scriptFileUrl(args.collectionPath, found.relativePath);
    const fr = args.fetchResults.get(found.relativePath);
    if (fr && 'ok' in fr && fr.ok) {
      entryTasks.push(async (): Promise<StoredScript> => {
        const built = await timePhase('build', () => buildScriptFromText({
          id,
          collectionId: args.collectionId,
          relativePath: found.relativePath,
          fileUrl,
          text: fr.text,
          now: args.now,
          // Pass prior so buildScriptFromText can preserve loadedAt when
          // the freshly fetched bytes hash to the same value — the
          // post-fetch leg of the unified change-detection path.
          prior,
          httpEtag: fr.httpEtag,
          httpLastModified: fr.httpLastModified,
        }));
        // Preserve the user's per-script enabled choice across refreshes.
        // `versionProbes` is deliberately NOT carried here — it's
        // re-applied from the persisted row by preserveConcurrentEdits
        // inside the write lock, which is strictly more current than
        // this pre-fetch snapshot.
        if (prior) built.enabled = prior.enabled;
        // Record the listing's mtime so the next refresh can decide to
        // skip a refetch.
        if (found.mtime !== undefined) built.fsMtime = found.mtime;
        const withFiles = await applyFiles(
          built, prior, recheckFiles, fileFetchCache, args.now, localFiles,
          parseCheckFor(fileUrl, prior), await pushedFilesOf(fileUrl));
        // Soft-failure preservation — see `keepsPriorOnInvalid`. Keep
        // the prior good body running and annotate `refreshError`
        // instead of clobbering it with what came back.
        if (withFiles.status === 'invalid' && keepsPriorOnInvalid(fileUrl, prior)) {
          return {
            ...prior,
            // Described, not bare: `refreshError` is a plain string
            // with no location field of its own, so flattening the
            // location into the text is the only way "where" survives
            // — and where in the fetched copy it went wrong is the
            // useful half of this message.
            refreshError: `Fetched copy is not a valid userscript (${
              withFiles.errorMessage
                ? describeDiagnostic(withFiles.errorMessage, withFiles.errorLocation)
                // Capitalized to match the `describeDiagnostic` string
                // it stands in for — the two share this slot, so a
                // lowercase fallback would read as a different kind of
                // thing depending on which branch ran.
                : 'Parse failed'
            })`,
          };
        }
        return withFiles;
      });
    } else if (fr && 'unchanged' in fr) {
      // Optimization path: the listing's size+mtime matched the prior
      // entry, so we never fetched. Reuse the prior entry verbatim.
      // (Defensive fallback if there's somehow no prior: treat as a
      // fresh-fetch failure — shouldn't happen because the orchestrator
      // only emits `unchanged` when prior exists.)
      if (prior) {
        // Recompute fileUrl unconditionally — if the collection's
        // path/URL ever changes (e.g. a future edit-collection UI), the
        // prior's fileUrl would silently lie. Cheap to recompute here.
        const next = { ...prior, fileUrl };
        if (found.mtime !== undefined) next.fsMtime = found.mtime;
        if (found.size !== undefined) next.size = found.size;
        // A proven-unchanged refetch (HTTP 304 or matching size+mtime)
        // means the collection is reachable and serving the same good
        // bytes again — clear any stale "refresh failed" annotation. If
        // a dep recheck below fails again, applyFiles re-sets
        // refreshError.
        delete next.refreshError;
        // Even when the body is unchanged, explicit Refresh still
        // rechecks @require + @resource bodies (the user may want to
        // pick up remote dep updates without touching the main
        // script). The opportunistic path passes 'preserve' which
        // short-circuits.
        entryTasks.push(
          async () => applyFiles(
            next, prior, recheckFiles, fileFetchCache, args.now, localFiles,
            parseCheckFor(fileUrl, prior), await pushedFilesOf(fileUrl)),
        );
      } else {
        entryTasks.push(() => Promise.resolve(buildInitialInvalidEntry({
          id,
          collectionId: args.collectionId,
          relativePath: found.relativePath,
          fileUrl,
          // Prefixed as internal because it is: the orchestrator told us
          // "unchanged" for a file we have never held. Nothing the user
          // can do about it, and saying so beats an accusation.
          errorMessage: 'Internal error: unchanged marker with no prior entry',
          now: args.now,
        })));
      }
    } else if (fr) {
      // Failed fetch. If we had prior content, keep it.
      const errorMessage =
        'errorMessage' in fr ? fr.errorMessage : 'Could not be read (no reason reported)';
      if (prior) {
        entryTasks.push(() => Promise.resolve(applyFetchError(prior, errorMessage)));
      } else {
        entryTasks.push(() => Promise.resolve(buildInitialInvalidEntry({
          id,
          collectionId: args.collectionId,
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
      entryTasks.push(() => Promise.resolve(prior
        ? applyFetchError(prior, NOT_READ)
        : buildInitialInvalidEntry({
            id, collectionId: args.collectionId, relativePath: found.relativePath,
            fileUrl, errorMessage: NOT_READ, now: args.now,
          })));
    }
  }

  const out = await mapWithConcurrency(
    entryTasks, FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY, (task) => task());

  // Anything in `existing` that the scan didn't see is dropped: it is
  // simply not in `out`. See the header comment.
  return out;
}

// ---------- chrome.storage.local I/O ----------

// Serialize every read-modify-write of the structural rows (the
// collection index, collection rows, script rows). chrome.storage.local
// has no compare-and-swap, so two operations that each read a row,
// derive a new value, and write it back would otherwise drop one
// another's change — e.g. a user's enable toggle reverted by a refresh
// that captured the old flag before the fetch, or an addCollection
// racing a removeCollection on the shared index. Callers run their read
// AND write inside one `mutate()` so the pair is atomic with respect to
// other mutators.
//
// The critical sections here are short (no network) — slow fetches stay
// OUTSIDE the lock (refresh fetches, then re-reads + writes inside it),
// so this doesn't serialize I/O. IMPORTANT: a `mutate()` block must
// never call another mutator (refreshCollection / addCollection / a set*),
// since this mutex is non-reentrant — keep orchestrator calls outside.
//
// SCOPE: `mutateChain` is module state, so the lock covers one JS
// context. Only the service worker writes (docs/worker-writes.md): pages
// ask it, and `writeLocal` throws in a page. So every mutator is under
// this one lock. Two rules still hold:
//
//   - Re-read inside the lock and merge, rather than writing values
//     captured before it: a refresh fetches outside the lock, and an
//     edit made meanwhile has to survive its write. See
//     `preserveConcurrentEdits` and the joined/departed reconcile in
//     `writeRefreshedCollection`.
//   - Keep sections short: every write in the worker waits on them.
//
// See docs/storage.md#one-lock-in-the-worker.
// A section's writes must be awaited before it returns: the blob cleanup
// relies on no script row landing outside a section
// (`checkScriptRowWrite`), and a write left running would land after.
let mutateChain: Promise<unknown> = Promise.resolve();
// Whether a section is running: what `checkScriptRowWrite` asks.
let sectionsRunning = 0;
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  const section = async (): Promise<T> => {
    sectionsRunning++;
    try {
      return await fn();
    } finally {
      sectionsRunning--;
    }
  };
  // Run after the prior section settles, regardless of its outcome.
  const run = mutateChain.then(section, section);
  // Advance the chain, swallowing the result so one section's rejection
  // doesn't reject the next waiter's gate (the rejection still
  // propagates to THIS caller via `run`).
  mutateChain = run.then(() => undefined, () => undefined);
  return run;
}

// Set to `true` the first time the SW seeds the default collections, so
// the seeding never runs again even after the user removes those
// collections.
const FIRST_RUN_DONE_KEY = 'firstRunComplete';

// Collections seeded on the very first run (by the collections page —
// see `seedDefaultCollectionsViaUi` in collections.ts). Each is fed
// through the normal add → Refresh flow, so any input shape
// `addCollection` accepts (github-dir / http(s) `.user.js` / manifest
// URL, or an absolute directory path) works here. `addCollection`
// dedupes by canonical collection path, so any accidental repeat
// collapses to one collection.
export const DEFAULT_COLLECTIONS: readonly string[] = [
  'https://github.com/jshute96/SourceMonkey/tree/main/tests/examples',
];

// ---------- Legacy key migration (temporary — see TODO.md) ----------
//
// Collections were called "sources" before the August 2026 rename, and
// a profile written then holds a `"sources"` index, `source:<id>` rows,
// and a `sourceId` back-reference on every script. Without this, an
// upgrade would read as a wiped profile: every collection gone, every
// script unregistered. Rewrite the rows once, on the first storage read
// in each JS context, and drop the old keys.
const LEGACY_INDEX_KEY = 'sources';
const LEGACY_COLLECTION_PREFIX = 'source:';

let migrationPromise: Promise<void> | null = null;

// Idempotent, memoized per context. Awaited by every read path in this
// module, and exported for the two SW modules that read the structural
// rows straight out of `chrome.storage.local` (`match-index.ts` and
// `injector.ts`) rather than through here. `script-log-id.ts` reads
// `script:*` rows directly too and deliberately does NOT await: script
// keys don't move, and it reads only `relativePath`.
//
// Only the worker writes (docs/worker-writes.md): a page that finds the
// old rows asks it to move them, and waits.
export function ensureCollectionKeysMigrated(): Promise<void> {
  const migrate = isPageContext() ? migrateViaWorker : () => asMigration(migrateLegacyCollectionKeys);
  migrationPromise ??= migrate().catch((err: unknown) => {
    // Never let a failed migration wedge every read behind it: clear the
    // memo so the next reader retries, and leave the old rows in place.
    console.info('[SourceMonkey] collection-key migration failed', err);
    migrationPromise = null;
  });
  return migrationPromise;
}

// Forget that this context has already checked. Only for the test
// surface's `resetAllState`, which wipes storage — the memo describes a
// profile that no longer exists, and a test seeding pre-rename rows
// afterwards would otherwise never see them migrated.
//
// Scope is the calling context only: `resetAllState` runs in the service
// worker, so an extension page already open keeps its own resolved memo.
// A test that seeds pre-rename rows has to open the page afterwards.
export function resetCollectionKeyMigrationForTests(): void {
  migrationPromise = null;
}

async function migrateViaWorker(): Promise<void> {
  if (await hasLegacyRows()) await callWorker('migrateCollectionKeys');
}

async function hasLegacyRows(): Promise<boolean> {
  return LEGACY_INDEX_KEY in await chrome.storage.local.get(LEGACY_INDEX_KEY);
}

// The worker's answer to a page that found the old rows: the
// migration, then a failure if the rows are still there, so the page
// forgets its own memo and asks again on its next read.
export async function migrateCollectionKeysForPage(): Promise<void> {
  const first = ensureCollectionKeysMigrated();
  await first;
  // This worker's memo may predate the rows (old data restored since it
  // checked): look again, once. Only the first page to ask resets it;
  // another one asking meanwhile shares the new run.
  if (await hasLegacyRows()) {
    if (migrationPromise === first) migrationPromise = null;
    await ensureCollectionKeysMigrated();
  }
  if (await hasLegacyRows()) throw new Error('Internal error: Could not move the collections to their current storage keys');
}

async function migrateLegacyCollectionKeys(): Promise<void> {
  // Cheap gate first. A profile with any collection at all has the old
  // index row, so its absence means there is nothing to move. The memo
  // means this runs at most once per worker wake (a page's request can
  // re-run it), and the full scan below reads every row.
  const probe = await chrome.storage.local.get(LEGACY_INDEX_KEY);
  if (!(LEGACY_INDEX_KEY in probe)) return;

  const all = await scanAllStorage('key migration');
  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [LEGACY_INDEX_KEY];
  // Seed the index ONLY when the new spelling isn't there yet. This runs
  // outside `mutate()`, so a run that read `all` before an earlier run
  // finished migrating would otherwise write the stale legacy id list
  // over an index a later add had already extended — orphaning that
  // collection's row from the index.
  if (!(COLLECTIONS_INDEX_KEY in all)) {
    const ids = all[LEGACY_INDEX_KEY];
    toSet[COLLECTIONS_INDEX_KEY] = Array.isArray(ids) ? ids : [];
  }

  let scriptsMoved = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(LEGACY_COLLECTION_PREFIX)) {
      toSet[collectionKey(key.slice(LEGACY_COLLECTION_PREFIX.length))] = value;
      toRemove.push(key);
      continue;
    }
    if (!key.startsWith('script:')) continue;
    const row = value as StoredScript & { sourceId?: string };
    if (row?.sourceId === undefined) continue;
    const { sourceId, ...rest } = row;
    toSet[key] = { ...rest, collectionId: rest.collectionId ?? sourceId };
    scriptsMoved++;
  }

  // Write the new rows before dropping the old ones: an interrupted
  // migration then leaves both spellings present, and the re-run is a
  // no-op over the rows it already moved.
  await setLocal(toSet);
  await chrome.storage.local.remove(toRemove);
  console.log(
    `[SourceMonkey] migrated ${toRemove.length - 1} collections and `
    + `${scriptsMoved} scripts to the collection:* key spelling`,
  );
}

// Script rows come back as full scripts, their bodies read from their
// blobs (script-blobs.ts). `getRows` reads them as stored, without the
// bodies (`ScriptMeta`), for code that doesn't need them.
async function getRaw<T>(key: string): Promise<T | undefined> {
  return (await getMany([key]))[key] as T | undefined;
}

async function getMany(keys: string[]): Promise<Record<string, unknown>> {
  return await hydrateScriptRows(await getRows(keys));
}

// Rows as stored. A script row written back from here with a field
// changed keeps its bodies (its blob refs) as they are, and the write
// hashes nothing.
//
// In the worker, from its row cache when that is loaded (row-cache.ts).
async function getRows(keys: string[]): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  await ensureCollectionKeysMigrated();
  const cached = cachedRows(keys);
  if (!cached) return await chrome.storage.local.get(keys);
  if (cached.rest.length === 0) return cached.found;
  return { ...await chrome.storage.local.get(cached.rest), ...cached.found };
}

async function getRow<T>(key: string): Promise<T | undefined> {
  return (await getRows([key]))[key] as T | undefined;
}

// ---------- Storage format ----------
//
// Format 2 keeps bodies out of the script rows (docs/storage.md#content-blobs).
// The service worker moves format 1 rows over once, at startup
// (`migrateToBlobs`). Reads take either format, so only writes wait for
// it; only the worker writes.

let storeFormatPromise: Promise<void> | null = null;

// Resolves once script rows may be written. Never rejects, so a failure
// can't wedge every write behind it: a failed migration is logged and
// tried again in the next browser session (`migrateToBlobs`). Writes
// carry on meanwhile, in format 2, as they always do.
export function storeFormatReady(): Promise<void> {
  storeFormatPromise ??= migrateStore().catch((err: unknown) => {
    console.info('[SourceMonkey] storage format migration failed:', describeError(err));
  });
  return storeFormatPromise;
}

async function migrateStore(): Promise<void> {
  // The old key spelling first: it moves rows the blob migration reads.
  await ensureCollectionKeysMigrated();
  await asMigration(migrateToBlobs);
}

// One unused-blob check (`sweepUnusedBlobs`), inside the write lock. A
// write of a script row can't land between the check reading the rows
// and deleting what they don't use: every one takes the lock too
// (`checkScriptRowWrite`). One that found a blob still stored, and so
// didn't write it again, would otherwise be left pointing at nothing.
//
// `started`: called once the check holds the lock; false skips the check
// (null result).
export function sweepUnusedBlobsLocked(started?: () => boolean): Promise<SweepResult | null> {
  return mutate(async () => {
    if (started && !started()) return null;
    await storeFormatReady();
    return await sweepUnusedBlobs((await cachedScriptRows()) ?? undefined);
  });
}

// For the test surface: rows a test writes straight into storage, under
// the lock like every other write of a script row
// (`checkScriptRowWrite`).
export function seedStorageForTests(items: Record<string, unknown>): Promise<void> {
  return mutate(() => chrome.storage.local.set(items));
}

// The migrations write script rows outside the lock: they run before
// any write that takes it (`storeFormatReady`), and the cleanup waits
// for them the same way. While one runs, every script-row write is let
// through, so a legacy-key migration started mid-session (a page found
// old rows) widens the check for its length. Rare: old rows restored
// into a running profile.
//
// That mid-session run is also unguarded: it writes the script rows as
// its scan read them, so a `removeScript` landing between the scan and
// the write gets its row written back (its blobs possibly already
// swept). It isn't moved under the lock because reads inside the lock
// await this migration, so a section waiting on it would deadlock.
let migrationsRunning = 0;
async function asMigration<T>(run: () => Promise<T>): Promise<T> {
  migrationsRunning++;
  try {
    return await run();
  } finally {
    migrationsRunning--;
  }
}

// The worker's wrapped write calls this before every write (row-cache.ts):
// a script row written outside the lock could race the blob cleanup.
// A bug, so it throws. It sees whether SOME section is running, not
// whether this write is in it: a write outside the lock made while a
// section runs passes, so this catches most mistakes, not all.
export function checkScriptRowWrite(keys: readonly string[]): void {
  if (sectionsRunning > 0 || migrationsRunning > 0) return;
  const row = keys.find((k) => k.startsWith(SCRIPT_PREFIX));
  if (row) throw new Error(`Internal error: ${row} was written outside the store's write lock`);
}

// Test-only: run the migration again, as a worker start would. For
// tests that seed format 1 rows.
export async function rerunStoreMigrationForTests(): Promise<void> {
  await forgetStoreMigrationForTests();
  await storeFormatReady();
}

// Test-only: as a worker just started, before anything asked for the
// format. The next write here runs the migration.
export async function forgetStoreMigrationForTests(): Promise<void> {
  storeFormatPromise = null;
  await clearMigrationFailureForTests();
}

// Only for the test surface's `resetAllState`, which wipes storage: the
// worker records the empty profile as format 2 again, as a fresh
// profile's migration would, so a worker started later in the test
// doesn't scan for format 1 rows.
export async function markStoreFormatForTests(): Promise<void> {
  await chrome.storage.local.set({ [STORE_FORMAT_KEY]: STORE_FORMAT });
}

async function readCollectionIndex(): Promise<string[]> {
  return (await getRaw<string[]>(COLLECTIONS_INDEX_KEY)) ?? [];
}

// Test-only: while set, EVERY collection-refresh write throws this
// message instead of touching storage.
//
// Module state, so it only arms the context that set it. The service
// worker and each extension page run their own copy of this module, and
// the collections page does its own storage work — so a test arming
// this over the SW test surface does NOT affect an add or refresh the
// page performs itself. Sticky until cleared with null —
// the out-of-quota case it stands in for fails every collection, not
// just the next one, and a test covering that needs one arming call.
//
// Exists because the failure it stands in for — an exhausted
// `chrome.storage.local` quota — is impractical to produce honestly in a
// test. Filling 10 MB means writing ~10 MB of userscripts through the
// real pipeline on every run, which is slow, and it leaves the profile
// wedged for whatever runs next. The reporting path is the same either
// way: the write throws, and everything downstream reacts to that.
let collectionWriteFailure: string | null = null;
export function _setCollectionWriteFailureForTests(message: string | null): void {
  collectionWriteFailure = message;
}

// How full `chrome.storage.local` is, or null when the browser won't
// say. `quota` is Chrome's own `QUOTA_BYTES` — 10 MB shared by the whole
// extension, because the manifest does not take `unlimitedStorage`.
//
// That coupling is load-bearing and unenforced: `QUOTA_BYTES` reads the
// same 10485760 whether or not the permission is held, so taking
// `unlimitedStorage` (still an open option in TODO.md) would leave this
// reporting a ceiling that no longer applies, and the collections page
// calling a healthy profile full. Revisit here if that permission lands.
//
// Read live rather than tracked, so it needs nothing persisted and is
// correct after a write from any context. The collections page uses it
// to explain a refresh that couldn't be saved: "the write failed" is a
// symptom, "storage is full" is the cause and the thing the user can
// act on.
export async function readLocalStorageUsage(): Promise<
  { used: number; quota: number } | null
> {
  try {
    const quota = chrome.storage.local.QUOTA_BYTES;
    if (typeof quota !== 'number' || quota <= 0) return null;
    return { used: await chrome.storage.local.getBytesInUse(null), quota };
  } catch {
    // Purely advisory — a page that can't measure simply doesn't show
    // the banner.
    return null;
  }
}

// Fraction of the quota at which the page starts warning. Below this a
// refresh that failed to save had some other cause, and pointing at
// storage would send the reader somewhere useless.
export const STORAGE_NEARLY_FULL = 0.9;

// Read every registered collection's metadata (without scripts). Order
// preserved from the index.
export async function getCollections(): Promise<StoredCollection[]> {
  const ids = await readCollectionIndex();
  const got = await getMany(ids.map(collectionKey));
  return ids
    .map((id) => got[collectionKey(id)] as StoredCollection | undefined)
    .filter((s): s is StoredCollection => s != null);
}

// Read a collection plus all its scripts in declared order.
export async function getCollectionWithScripts(
  id: string,
): Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null> {
  const collection = await getRaw<StoredCollection>(collectionKey(id));
  if (!collection) return null;
  const got = await getMany(collection.scriptIds.map(scriptKey));
  const scripts = collection.scriptIds
    .map((sid) => got[scriptKey(sid)] as StoredScript | undefined)
    .filter((s): s is StoredScript => s != null);
  return { collection, scripts };
}

// Same as `getCollectionWithScripts`, without the scripts' bodies.
export async function getCollectionWithScriptMeta(
  id: string,
): Promise<{ collection: StoredCollection; scripts: ScriptMeta[] } | null> {
  const collection = await getRow<StoredCollection>(collectionKey(id));
  if (!collection) return null;
  return { collection, scripts: await getScriptMetas(collection.scriptIds) };
}

export async function getScript(scriptId: string): Promise<StoredScript | undefined> {
  return await getRaw<StoredScript>(scriptKey(scriptId));
}

// A full script as its row would read without the bodies, for a caller
// that holds one and needs only the rest (an answer sent to a page).
export function withoutBodies(script: StoredScript): ScriptMeta {
  const { bodyText, requires, resources, ...rest } = script;
  return {
    ...rest,
    ...(requires ? { requires: requires.map(({ source, ...r }) => r) } : {}),
    ...(resources ? { resources: resources.map(({ bytesBase64, ...r }) => r) } : {}),
  };
}

export async function getScriptMeta(scriptId: string): Promise<ScriptMeta | undefined> {
  return await getRow<ScriptMeta>(scriptKey(scriptId));
}

// Read several scripts' rows, without their bodies, in one storage
// call. Missing ids are left out.
export async function getScriptMetas(scriptIds: readonly string[]): Promise<ScriptMeta[]> {
  const got = await getRows(scriptIds.map(scriptKey));
  return scriptIds
    .map((id) => got[scriptKey(id)] as ScriptMeta | undefined)
    .filter((s): s is ScriptMeta => s != null);
}

// Every stored script without its bodies (across all collections,
// regardless of status): only the script rows are read.
//
// In the worker, from its row cache, which this loads (row-cache.ts).
export async function getAllScriptMetas(reason = 'all script rows'): Promise<ScriptMeta[]> {
  await ensureCollectionKeysMigrated();
  const rows = await cachedScriptRows()
    ?? await scanStorageRows(reason, (k) => k.startsWith(SCRIPT_PREFIX));
  return Object.values(rows) as ScriptMeta[];
}

// Read every stored script (across all collections, regardless of
// status), bodies included. One `get(null)` scan rather than N
// per-collection reads. Prefer `getAllScriptMetas` unless the bodies
// are needed.
export async function getAllScripts(): Promise<StoredScript[]> {
  await ensureCollectionKeysMigrated();
  const all = await scanAllStorage('all scripts');
  const rows: ScriptRow[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('script:')) rows.push(value as ScriptRow);
  }
  return await fromStorage(rows, all);
}

// Several collection rows in one storage call. Missing ids are left out.
export async function getCollectionsById(ids: readonly string[]): Promise<StoredCollection[]> {
  const got = await getRows(ids.map(collectionKey));
  return ids
    .map((id) => got[collectionKey(id)] as StoredCollection | undefined)
    .filter((c): c is StoredCollection => c != null);
}

export async function getCollection(id: string): Promise<StoredCollection | undefined> {
  return await getRaw<StoredCollection>(collectionKey(id));
}

// Result of `addCollection` / `createCollection` / `installScript`.
// Three outcomes:
//   - newCollection: a brand-new collection row was created (a directory /
//     manifest / github-dir collection, a user-created scripts
//     collection, or a built-in default container auto-created by the
//     first install that targeted it). The caller appends a fresh
//     section to the DOM.
//   - existingContainer: a single script was installed into a container
//     that already existed. The caller re-renders that container's
//     section in place.
//   - null: the input was a duplicate (an already-registered collection
//     path, or a script URL/path already present in the target
//     container). The caller surfaces the duplicate message and jumps
//     to the existing section.
export type AddCollectionResult =
  | { kind: 'newCollection'; collection: StoredCollection }
  | { kind: 'existingContainer'; collection: StoredCollection; scriptId: string }
  | null;

// Messages shared by the store's collection-shape checks and the
// collection dialog's live validation, so the dialog can't say one
// thing and the store another.
export const COLLECTION_ALREADY_REGISTERED = 'This collection is already registered';
export const COLLECTION_NAME_REQUIRED = 'Name is required for scripts collections';
export const COLLECTION_GONE = 'This collection no longer exists';
export function collectionNameInUseMessage(name: string): string {
  return `Collection named "${name.trim()}" already exists`;
}

// What `createCollection` is asked to make.
export type NewCollectionSpec =
  | {
      // A folder of individually installed scripts. Named by the user.
      kind: 'scripts';
      name: string;
      localFiles?: boolean;
    }
  | {
      // A scanned directory, a GitHub tree, or a `script_manifest.json`.
      kind: 'location';
      path: string;
      // Blank → inferred from the path, as the Add field always did.
      name?: string;
      localFiles?: boolean;
    };

// Register a new collection from a raw user input — the Add field's
// one-string entry point. Dispatches by input shape:
//   - single-file `.user.js` URL/path → installed into the built-in
//     default container for its scheme (created on demand). The script
//     is added to the container's `scriptIds` and its initial fetch
//     runs immediately so the table populates without a manual
//     Refresh.
//   - everything else (directory, manifest, github-dir URL) → a new
//     location-backed collection, as `createCollection` would make.
//
// `normalizeCollectionInput` runs first so a github.com
// `/blob/.../foo.user.js` (or `/blob/.../script_manifest.json`) URL
// gets rewritten to its raw counterpart before we hit the duplicate
// check. The github blob URL serves HTML, not raw bytes, so storing it
// verbatim would silently load the page chrome instead of the script —
// see [docs/http-collections.md].
export async function addCollection(rawPath: string): Promise<AddCollectionResult> {
  const path = await canonicalLocation(rawPath);
  if (isSingleFileInput(path)) {
    return await addScriptToContainer(path, { schemeDefault: true });
  }
  return await createLocationCollection(path, {});
}

// Two canonicalizations, in order: provider rewriting (github blob →
// raw), then the one-spelling-per-location rule. The second is what
// keeps `/x/a.user.js` typed into the collections page and
// `file:///x/a.user.js` arriving from a captured navigation from
// becoming two rows for one file — see `canonicalCollectionInput`.
export async function canonicalLocation(rawPath: string): Promise<string> {
  return canonicalCollectionInput(await normalizeCollectionInput(rawPath));
}

// Create a collection the collection dialog described. A scripts
// collection is an empty container row with the user's name; a
// location collection is what `addCollection` makes, plus the name and
// local-files choice from the dialog.
export async function createCollection(spec: NewCollectionSpec): Promise<AddCollectionResult> {
  if (spec.kind === 'scripts') {
    const name = spec.name.trim();
    if (!name) throw new Error(COLLECTION_NAME_REQUIRED);
    const created = await mutate(async () => {
      const collections = await getCollections();
      if (!mayUseReservedName(name, null)) throw new Error(RESERVED_COLLECTION_NAME);
      if (collectionNameInUse(name, collections)) {
        throw new Error(collectionNameInUseMessage(name));
      }
      const id = crypto.randomUUID();
      const seed: StoredCollection = {
        id,
        path: newContainerPath(),
        lastRefreshedAt: 0,
        scriptIds: [],
        enabled: true,
        displayName: name,
      };
      if (spec.localFiles === false) seed.localFiles = false;
      await writeLocal({
        [COLLECTIONS_INDEX_KEY]: [...collections.map((s) => s.id), id],
        [collectionKey(id)]: seed,
      });
      return seed;
    });
    return { kind: 'newCollection', collection: created };
  }
  const path = await canonicalLocation(spec.path);
  if (isSingleFileInput(path)) throw new Error(SINGLE_SCRIPT_USE_ADD_FIELD);
  return await createLocationCollection(path, spec);
}

// What the collection dialog runs before creating a location-backed
// collection: the same listing / manifest fetch / GitHub lookup a
// refresh does, so a location that can't be read is refused in the
// dialog instead of landing as a collection stuck in a scan error.
// Nothing is written. The count lets the dialog warn about an empty
// directory without refusing it — a directory can fill up later.
export async function probeCollectionLocation(
  rawPath: string,
): Promise<{ path: string; scriptCount: number }> {
  const path = await canonicalLocation(rawPath);
  if (isSingleFileInput(path)) throw new Error(SINGLE_SCRIPT_USE_ADD_FIELD);
  const found = await scanForUserScripts(path);
  return { path, scriptCount: found.length };
}

// Mint a UUID, persist an empty collection row for an already-canonical
// location, then refresh to populate the scripts.
async function createLocationCollection(
  path: string,
  opts: { name?: string; localFiles?: boolean },
): Promise<AddCollectionResult> {
  // Only a name the user actually chose is held to the uniqueness rule.
  // Inferred names can legitimately collide — two refs of one GitHub
  // tree both read as `<owner>/<repo>/<path>` — and refusing those
  // would block adding a real, distinct collection.
  const inferred = inferDisplayName(path);
  const chosen = opts.name?.trim() || '';
  const explicitName = chosen && chosen !== inferred ? chosen : '';
  // Dedup-and-register atomically so two concurrent adds of the same
  // path can't both create a collection (and so this index write can't
  // lose a race with another index mutator). The refresh runs OUTSIDE
  // the lock (it acquires the lock itself for its own write).
  const created = await mutate(async () => {
    const collections = await getCollections();
    // Canonicalize the stored side too, for the same reason the
    // container check does: a collection row written before
    // `addCollection` collapsed `file://` inputs still carries the URL
    // spelling.
    if (collections.some((s) => canonicalCollectionInput(s.path) === path)) return null;
    if (explicitName) {
      if (!mayUseReservedName(explicitName, null)) throw new Error(RESERVED_COLLECTION_NAME);
      if (collectionNameInUse(explicitName, collections)) {
        throw new Error(collectionNameInUseMessage(explicitName));
      }
    }
    const id = crypto.randomUUID();
    const seed: StoredCollection = {
      id,
      path,
      lastRefreshedAt: 0,
      scriptIds: [],
      enabled: true,
      // Seed a displayName at add-time so a viewer opened mid-add (or
      // any other reader) doesn't briefly see a row whose name only
      // materialises on the next backfill pass.
      displayName: explicitName || inferred,
    };
    if (opts.localFiles === false) seed.localFiles = false;
    const nextIndex = [...collections.map((s) => s.id), id];
    await writeLocal({
      [COLLECTIONS_INDEX_KEY]: nextIndex,
      [collectionKey(id)]: seed,
    });
    return { id, seed };
  });
  if (!created) return null;
  const { id, seed } = created;
  const refreshed = await refreshCollection(id, { adding: true });
  // The updater-driven refresh paths already emit per-script Log
  // entries when a script's load state goes bad. This initial-add path
  // bypasses the updater, so anything that lands already broken would
  // otherwise have an empty Log tab. Emit once per non-OK script here
  // so the user can always click the row's badge and read what went
  // wrong. Awaited so the loglevel sentinel write lands before the
  // caller's `getAllMaxLogLevels` read — otherwise the first paint of
  // the row would briefly show OK and only flip on the storage-change
  // listener.
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLog));
  }
  return { kind: 'newCollection', collection: refreshed?.collection ?? seed };
}

// First-run gate. Seeding the default collections is driven from the
// collections page (so the user watches the normal add → Refresh flow,
// rather than scripts appearing silently from the SW); the SW only
// opens that page on install. These two helpers are the persisted flag
// the page and SW share.
export async function isFirstRunComplete(): Promise<boolean> {
  return (await getRaw<boolean>(FIRST_RUN_DONE_KEY)) === true;
}

// Record that first-run handling is done so the SW stops opening the
// seeding page and the collections page stops re-seeding — including
// after the user deletes the seeded collections. Also called by the
// test-surface reset so a cleared store isn't re-seeded.
export async function markFirstRunComplete(): Promise<void> {
  await writeLocal({ [FIRST_RUN_DONE_KEY]: true });
}

// Where a single script should be installed: a specific container by
// id, or the built-in default container for the script's own scheme
// (created if it doesn't exist).
export type InstallTarget = { collectionId: string } | { schemeDefault: true } | { smDevRun: string };

// Install one `.user.js` location into a container collection. Returns
// null if the location is already a script in THAT container — the
// same location may be installed into several containers, which is
// what the "Other versions" panel and its exclusive-enable rule exist
// for. The fetch runs as part of `refreshCollection` so the new row
// lands populated.
export async function installScript(
  rawLocation: string,
  target: InstallTarget,
): Promise<AddCollectionResult> {
  const path = await canonicalLocation(rawLocation);
  if (!isSingleFileInput(path)) {
    throw new Error('Internal error: only a .user.js location can be installed into a collection');
  }
  return await addScriptToContainer(path, target);
}

// ---------- Scratch scripts ----------
//
// Scripts whose only copy is their text in storage (see directories.ts).
// Only sm-dev writes them (docs/sm-dev-design.md). Each sm-dev run
// gets its own collection of them, its test collection, shown on the
// collections page like any other; their text is a storage row the
// fetcher reads back, so every refresh path treats them as ordinary
// scripts.

// The bodies pushed with a scratch script, or undefined when none were
// (or the script isn't one).
async function pushedFilesOf(url: string): Promise<Record<string, PushedFile> | undefined> {
  if (!isScratchUrl(url)) return undefined;
  const files = await getRaw<Record<string, PushedFile>>(scratchFilesKey(url));
  return files && Object.keys(files).length > 0 ? files : undefined;
}

// The name a run's test collection is shown under.
export function smDevCollectionName(run: string): string {
  return `sm-dev test collection (run ${run})`;
}

export interface WriteRunScriptResult {
  scriptId: string;
  collectionId: string;
  status: ScriptStatus;
  errorMessage?: string;
  errorLocation?: DiagnosticLocation;
  /** True when a scratch script of this name already existed and got replaced. */
  replaced: boolean;
}

// What sm-dev pushes for one of a run's scripts.
export interface RunScriptArgs {
  run: string;
  text: string;
  name?: string;
  // The `@require` / `@resource` bodies it read from disk, by ref.
  files?: Record<string, PushedFile>;
  // The file it was read from, as an absolute `file://` URL (sm-dev 1.2).
  source?: string;
}

// Install or replace one of run `run`'s scripts, in its test collection.
// The name (the `@name`, or one the caller gives) is the identity:
// writing it again replaces the earlier text in place, keeping the row's
// id and its GM values, which is what lets a page reload hot-swap the
// new version. A new script that doesn't parse is reported and not
// kept, so the collection holds only scripts the run has.
export async function writeRunScript(args: RunScriptArgs): Promise<WriteRunScriptResult> {
  // Its scripts' URLs carry it as is, and '' would be no run's.
  if (!/^[A-Za-z0-9._-]+$/.test(args.run)) throw new Error(`Internal error: ${JSON.stringify(args.run)} is not an sm-dev run id`);
  const header = parseHeader(args.text);
  const name = args.name?.trim() || (header ? getValue(header, 'name')?.trim() : '') || 'script';
  const url = scratchUrl(args.run, name);
  // The text and its files in one write, so no refresh reads one
  // without the other. Replaced whole, so a body the script no longer
  // reads from disk goes.
  const hasFiles = args.files !== undefined && Object.keys(args.files).length > 0;
  const source: ScratchSource | undefined = args.source ? { fileUrl: args.source, given: name } : undefined;
  await writeLocal({
    [scratchTextKey(url)]: args.text,
    ...(hasFiles ? { [scratchFilesKey(url)]: args.files } : {}),
    ...(source ? { [scratchSourceKey(url)]: source } : {}),
  });
  const stale = [...(hasFiles ? [] : [scratchFilesKey(url)]), ...(source ? [] : [scratchSourceKey(url)])];
  if (stale.length > 0) await removeLocal(stale);
  const container = (await getCollections()).find((c) => c.path === smDevContainerPath(args.run));
  let scriptId: string | undefined;
  let collectionId: string | undefined;
  let replaced = false;
  if (container) {
    const rows = await getRows(container.scriptIds.map(scriptKey));
    for (const sid of container.scriptIds) {
      const row = rows[scriptKey(sid)] as ScriptMeta | undefined;
      if (row?.relativePath === url) {
        scriptId = sid;
        collectionId = container.id;
        replaced = true;
      }
    }
  }
  if (scriptId === undefined) {
    let result: AddCollectionResult;
    try {
      result = await installScript(url, { smDevRun: args.run });
    } catch (err) {
      // The install took its seed back out; the text rows go with it.
      await removeLocal([scratchTextKey(url), scratchFilesKey(url), scratchSourceKey(url)]);
      throw err;
    }
    if (!result) throw new Error('Internal error: the scratch script was neither installed nor found');
    collectionId = result.collection.id;
    scriptId = result.kind === 'existingContainer'
      ? result.scriptId
      : result.collection.scriptIds[result.collection.scriptIds.length - 1];
  } else {
    // Re-read the text; the scratch fetcher has no size or mtime to skip
    // on, so the new content lands and the hash says whether it changed.
    await refreshScript(scriptId);
  }
  const row = await getScript(scriptId);
  if (!row) throw new Error('Internal error: the scratch script vanished during install');
  const out: WriteRunScriptResult = { scriptId, collectionId: collectionId!, status: row.status, replaced };
  if (row.errorMessage) out.errorMessage = row.errorMessage;
  if (row.errorLocation) out.errorLocation = row.errorLocation;
  if (!replaced && row.status !== 'ok') await removeScript(scriptId);
  return out;
}

// Remove run `run`'s test collection, its rows, their GM values, and the
// text rows behind them. Returns what went, for the caller's
// registration sync. `removeCollection` deletes the text rows, keeping
// any that a copy moved into another collection still reads.
export async function removeSmDevCollection(run: string): Promise<{ scriptIds: string[]; collectionId: string | null }> {
  const container = (await getCollections()).find((c) => smDevRunOfContainer(c.path) === run);
  if (!container) return { scriptIds: [], collectionId: null };
  for (const sid of container.scriptIds) await wipeValues(sid);
  await removeCollection(container.id);
  return { scriptIds: container.scriptIds, collectionId: container.id };
}

// The runs that have a test collection.
export async function smDevCollectionRuns(): Promise<string[]> {
  return (await getCollections()).map((c) => smDevRunOfContainer(c.path)).filter((run) => run !== null);
}

// Does this container already hold `canonicalPath`?
//
// A container holds one row per location, and both the install and the
// move path have to agree on what "the same location" means — so the
// rule lives here rather than being spelled twice. The STORED value is
// canonicalized too: rows written before `addCollection` started
// collapsing `file://` inputs still carry the URL spelling, and
// comparing raw would offer a second copy of a file we already have.
//
// `canonicalPath` must already be through `canonicalCollectionInput`.
// Caller-side, because both callers have it in hand.
async function containerHoldsLocation(
  container: StoredCollection,
  canonicalPath: string,
): Promise<boolean> {
  const rows = await getRows(container.scriptIds.map(scriptKey));
  for (const sid of container.scriptIds) {
    const s = rows[scriptKey(sid)] as ScriptMeta | undefined;
    if (s && canonicalCollectionInput(s.relativePath) === canonicalPath) return true;
  }
  return false;
}

// A brand-new container row. One spelling of the default field values,
// so an install-created container and a move-created one can't drift
// apart on `enabled`, the inferred name, or the never-refreshed marker.
function newContainerRow(
  id: string,
  path: string,
  scriptIds: string[],
): StoredCollection {
  return {
    id,
    path,
    lastRefreshedAt: 0,
    scriptIds,
    enabled: true,
    displayName: inferDisplayName(path),
  };
}

async function addScriptToContainer(
  path: string,
  target: InstallTarget,
): Promise<AddCollectionResult> {
  // Dedup-check and seed the container + script atomically so a
  // concurrent install (or index mutator) can't lose this scriptIds/index
  // write. The refresh runs OUTSIDE the lock. Returns null on duplicate.
  const seeded = await mutate(async () => {
    const collections = await getCollections();
    let existingContainer: StoredCollection | undefined;
    let cPath: string;
    if ('collectionId' in target) {
      existingContainer = collections.find((s) => s.id === target.collectionId);
      // The dropdown was built from a snapshot; the row can have been
      // removed from another tab since.
      if (!existingContainer) throw new Error(COLLECTION_GONE);
      if (!isContainerCollection(existingContainer.path)) {
        throw new Error('Internal error: scripts can only be installed into a scripts collection');
      }
      if (isSmDevCollection(existingContainer.path)) throw new Error(SM_DEV_COLLECTION_LOCKED);
      cPath = existingContainer.path;
    } else if ('smDevRun' in target) {
      cPath = smDevContainerPath(target.smDevRun);
      existingContainer = collections.find((s) => s.path === cPath);
    } else {
      cPath = containerPath(containerKindForSingleFileInput(path));
      existingContainer = collections.find((s) => s.path === cPath);
    }
    const isNew = !existingContainer;
    // Each container script's `relativePath` is the full URL/path the
    // user added; any prior row with the same value is a duplicate.
    // `path` arrived canonical (see `installScript`).
    if (existingContainer && await containerHoldsLocation(existingContainer, path)) return null;

    const now = Date.now();
    const containerId = existingContainer?.id ?? crypto.randomUUID();
    const scriptId = crypto.randomUUID();
    const priorScriptIds = existingContainer?.scriptIds ?? [];
    const nextContainer: StoredCollection = existingContainer
      ? { ...existingContainer, scriptIds: [...priorScriptIds, scriptId] }
      : newContainerRow(containerId, cPath, [scriptId]);
    if (isNew && 'smDevRun' in target) nextContainer.displayName = smDevCollectionName(target.smDevRun);
    const seedScript = buildInitialInvalidEntry({
      id: scriptId,
      collectionId: containerId,
      relativePath: path,
      fileUrl: scriptFileUrl(cPath, path),
      errorMessage: NOT_LOADED_YET,
      now,
    });

    // Single set call so a SW restart between writes can never leave a
    // half-populated container — either the new script lands with its
    // container's scriptIds pointing at it (and, for a new container,
    // the collections index pointing at the container), or nothing does.
    const toSet: Record<string, unknown> = {
      [collectionKey(containerId)]: nextContainer,
      [scriptKey(scriptId)]: seedScript,
    };
    if (isNew) {
      toSet[COLLECTIONS_INDEX_KEY] = [...collections.map((s) => s.id), containerId];
    }
    await writeLocal(toSet);
    return { isNew, containerId, scriptId, nextContainer };
  });
  if (!seeded) return null;
  const { isNew, containerId, scriptId, nextContainer } = seeded;

  let refreshed: Awaited<ReturnType<typeof refreshCollection>>;
  try {
    refreshed = await refreshCollection(containerId);
  } catch (err) {
    // The seed above is a placeholder with no content and no header —
    // it only becomes a script once this refresh writes the fetched
    // body. When that write is refused (an exhausted storage quota is
    // the realistic case — though anything the refresh throws lands
    // here), leaving the seed behind installs a row that
    // matches nothing, runs nothing, and shows "Not loaded yet" until
    // the user notices and refreshes it by hand. Nothing else about the
    // install has happened yet, so take the seed back out and let the
    // install fail as the failure it is. A fetch that fails is
    // different: the refresh then WRITES the row with its error, and
    // that row is the honest record of an install that landed.
    await unseedScript(scriptId, containerId, isNew);
    throw err;
  }
  if (refreshed) {
    await Promise.all(refreshed.scripts.map(emitInitialLoadLog));
  }
  const finalCollection = refreshed?.collection ?? nextContainer;
  if (isNew) return { kind: 'newCollection', collection: finalCollection };
  return { kind: 'existingContainer', collection: finalCollection, scriptId };
}

// Undo `addScriptToContainer`'s seed after its refresh could not be
// saved: drop the placeholder row and its slot in the container, and
// the container itself (plus its index entry) when this install created
// it. Re-read under the lock rather than replayed from the seed: another
// tab can have installed into, or removed, the same container since.
//
// Every write here makes storage smaller — a `remove`, or a `set` of a
// row with one id fewer — which Chrome accepts on a full quota, so this
// works in exactly the state that made it necessary. Best effort all the
// same: the caller is already reporting a failure, and a rollback that
// can't land must not replace that report with its own.
async function unseedScript(
  scriptId: string,
  containerId: string,
  createdContainer: boolean,
): Promise<void> {
  try {
    await mutate(async () => {
      const container = await getRaw<StoredCollection>(collectionKey(containerId));
      const remaining = container?.scriptIds.filter((id) => id !== scriptId) ?? [];
      const dropContainer = createdContainer && remaining.length === 0;
      const toRemove = [scriptKey(scriptId)];
      const toSet: Record<string, unknown> = {};
      if (container) {
        if (dropContainer) {
          toRemove.push(collectionKey(containerId));
          const index = await readCollectionIndex();
          toSet[COLLECTIONS_INDEX_KEY] = index.filter((id) => id !== containerId);
        } else if (remaining.length !== container.scriptIds.length) {
          toSet[collectionKey(containerId)] = { ...container, scriptIds: remaining };
        }
      }
      // The `set` first: it is the only step Chrome can refuse, so if
      // it does, nothing has changed. A `remove` can't be refused, so
      // the pair only splits if the worker dies between them — leaving
      // an unlisted row, which `reconcileScriptMembership` re-lists.
      if (Object.keys(toSet).length > 0) await writeLocal(toSet);
      await removeLocal(toRemove);
      if (dropContainer) await setRefreshError(containerId, null);
    });
  } catch (err) {
    // Not debug-gated: the state this leaves (a "Not loaded yet" row
    // nothing will explain) is otherwise invisible.
    console.info(`[SourceMonkey] could not undo a failed install: ${describeError(err)}`);
  }
}

export const SCRIPT_GONE = 'This script no longer exists';

// The one thing both `installScript` and `moveScript` decline: the
// target container already holds this location. Shared, so the install
// callout and the viewer's Move picker can't word the same refusal two
// ways.
export const ALREADY_INSTALLED_IN_TARGET = 'This script is already installed there';

// Both ends of a move have to be container collections. A directory or
// manifest script's `relativePath` is relative to its collection root,
// so moving it would mean rewriting it to an absolute location — a
// different feature. The UI never offers the button in that case, so
// this is a wiring error, not something the user can act on.
export const NOT_A_MOVABLE_SCRIPT =
  'Internal error: only a script in an individual scripts collection can be moved';

// The pages never offer it (see `installOptionsFor`); said if another
// path tries.
export const SM_DEV_COLLECTION_LOCKED =
  'Scripts can\'t be moved into or out of an sm-dev test collection, or installed into one, since only its sm-dev run changes it';

// Move one already-installed script from its container collection into
// another. The stored row keeps its `id`, so its Chrome registration,
// its `gmval:` rows, and its Log all follow it untouched — only the
// `collectionId` and the two `scriptIds` lists change.
//
// Returns null when the destination already holds this location (the
// same case `installScript` returns null for) or is the collection the
// script is already in.
//
// What DOES change with the parent: whether the script runs at all
// (`isRegistrationCandidate` requires the collection to be enabled
// too), and the local-stand-in policy — so a move between collections
// that disagree about `localFiles` ends with a refresh, because the
// `@require` / `@resource` bodies were resolved under the old rule.
export async function moveScript(
  scriptId: string,
  target: InstallTarget,
): Promise<ScriptMeta | null> {
  const moved = await mutate(async () => {
    const script = await getRow<ScriptMeta>(scriptKey(scriptId));
    if (!script) throw new Error(SCRIPT_GONE);
    const source = await getRaw<StoredCollection>(collectionKey(script.collectionId));
    if (!source || !isContainerCollection(source.path)) throw new Error(NOT_A_MOVABLE_SCRIPT);
    if (isSmDevCollection(source.path)) throw new Error(SM_DEV_COLLECTION_LOCKED);
    const collections = await getCollections();
    let dest: StoredCollection | undefined;
    let destPath: string;
    if ('collectionId' in target) {
      dest = collections.find((c) => c.id === target.collectionId);
      // The dropdown was built from a snapshot; the row can have been
      // removed from another tab since.
      if (!dest) throw new Error(COLLECTION_GONE);
      if (!isContainerCollection(dest.path)) throw new Error(NOT_A_MOVABLE_SCRIPT);
      if (isSmDevCollection(dest.path)) throw new Error(SM_DEV_COLLECTION_LOCKED);
      destPath = dest.path;
    } else {
      destPath = containerPath(containerKindForSingleFileInput(script.relativePath));
      dest = collections.find((c) => c.path === destPath);
    }
    if (dest?.id === source.id) return null;
    // Same dedup rule as an install, via the same helper — the stored
    // `relativePath` needs canonicalizing here because it may predate
    // the store doing so on the way in.
    const here = canonicalCollectionInput(script.relativePath);
    if (dest && await containerHoldsLocation(dest, here)) return null;

    const destId = dest?.id ?? crypto.randomUUID();
    const nextDest: StoredCollection = dest
      ? { ...dest, scriptIds: [...dest.scriptIds, scriptId] }
      : newContainerRow(destId, destPath, [scriptId]);
    const nextScript: ScriptMeta = { ...script, collectionId: destId };
    // One set call: a SW restart between writes must never leave the
    // row listed by both collections, or by neither.
    const toSet: Record<string, unknown> = {
      [collectionKey(source.id)]: {
        ...source,
        scriptIds: source.scriptIds.filter((id) => id !== scriptId),
      } satisfies StoredCollection,
      [collectionKey(destId)]: nextDest,
      [scriptKey(scriptId)]: nextScript,
    };
    if (!dest) toSet[COLLECTIONS_INDEX_KEY] = [...collections.map((c) => c.id), destId];
    await writeLocal(toSet);
    return {
      script: nextScript,
      localFilesChanged: collectionUsesLocalFiles(source) !== collectionUsesLocalFiles(nextDest),
    };
  });
  if (!moved) return null;
  if (!moved.localFilesChanged) return moved.script;
  try {
    // Outside the lock: `refreshScript` takes it itself.
    return (await refreshScript(scriptId)) ?? moved.script;
  } catch (err) {
    // The move itself landed and is what the caller asked for; only the
    // re-resolve of the declared files failed. Reporting it as a failed
    // move would be wrong, and the user can click Refresh.
    dlog(`[SourceMonkey] refresh after move failed: ${describeError(err)}`);
    return moved.script;
  }
}

// Copy a freshly-added script's load failure — and any local stand-in
// it picked up — into its Log tab. (Named for what it does now: it
// also runs for a perfectly healthy script that resolved a stand-in.)
//
// The updater-driven refresh paths do this themselves; the add path
// bypasses the updater, so without this a script that lands broken on
// its very first load would show a red badge over an empty Log, and a
// script running a local file in place of a declared URL would never
// have said so.
//
// Plain append. Adding a single file to an *existing* container
// refreshes every sibling, and we run over all of them — so a sibling
// that is still broken logs that again. It was genuinely re-read, so
// saying so is honest, and the add path is a deliberate user action
// rather than something that fires on its own.
async function emitInitialLoadLog(script: StoredScript): Promise<void> {
  // `undefined` prior: everything this row loaded is news at add time.
  for (const entry of localFileLogMessages(undefined, script)) {
    await appendScriptLog(script.id, { ...entry, source: 'add' });
  }
  const entry = loadStateLogEntry(script);
  if (!entry) return;
  await appendScriptLog(script.id, { ...entry, source: 'add' });
}

// A row with no name that one can be inferred for: a user-created
// container infers none, so is left as it is.
export function needsDisplayName(collection: StoredCollection): boolean {
  return !collection.displayName?.trim() && inferDisplayName(collection.path) !== '';
}

// Fill in `displayName` on any collection row that doesn't have one
// yet. The collections page asks for it at boot when a row needs one.
// Cheap: one read of the collection index plus one bulk write iff
// anything was missing. The pure-inference rules live in
// `collection-display.ts`; that module only imports a TYPE from this
// file so the cycle is compile-time only.
export async function backfillCollectionDisplayNames(): Promise<void> {
  // Read and written under the lock: a removal or refresh landing in
  // between would otherwise be written over with the rows read before.
  await mutate(async () => {
    const collections = await getCollections();
    const toSet: Record<string, unknown> = {};
    for (const s of collections) {
      if (!needsDisplayName(s)) continue;
      const next: StoredCollection = { ...s, displayName: inferDisplayName(s.path) };
      toSet[collectionKey(s.id)] = next;
    }
    if (Object.keys(toSet).length > 0) {
      await writeLocal(toSet);
    }
  });
}

// One-time pass over stored script rows to fill `usesUnsafeWindow` for
// rows written before the field existed. Returns how many rows changed.
//
// Why it can't wait for a refresh: `buildScriptFromText` derives the flag
// on every load, but a row is only rebuilt when a fetch actually happens.
// The cheap-skip paths (unchanged size+mtime on disk, a conditional GET
// answered 304) keep an untouched script's row exactly as it was, so a
// script that uses `unsafeWindow` ungranted could sit broken
// indefinitely after the upgrade that would have fixed it.
//
// Idempotent and cheap to repeat: every row whose body doesn't contain
// the name at all costs one `indexOf`. Rows that already carry the flag,
// and error rows (which never run), are skipped. `startupLogs` is
// re-derived for the rows that change so the row stays self-consistent
// with what the injector will do with it.
//
// The backfills read and write inside the write lock, as every write of
// a script row must (`checkScriptRowWrite`): a row removed between the
// read and the write would otherwise come back, pointing at blobs the
// cleanup has deleted. They run once per extension update, so holding
// the lock for a full read costs nothing that matters.
export async function backfillUsesUnsafeWindow(): Promise<number> {
  return mutate(async () => {
    const scripts = await getAllScripts();
    const toSet: Record<string, unknown> = {};
    for (const script of scripts) {
      if (script.status !== 'ok' || script.usesUnsafeWindow === true) continue;
      if (!sourceUsesUnsafeWindow(script.bodyText)) continue;
      const next: StoredScript = { ...script, usesUnsafeWindow: true };
      const logs = rederivedStartupLogs(script, true);
      if (logs.length > 0) next.startupLogs = logs;
      else delete next.startupLogs;
      toSet[scriptKey(script.id)] = next;
    }
    const changed = Object.keys(toSet).length;
    if (changed > 0) await writeLocal(toSet);
    return changed;
  });
}

// Re-derive `startupLogs` on stored rows, so a new parse-time check
// (e.g. the no-`@connect` warning) reaches scripts already installed.
// Same reason as `backfillUsesUnsafeWindow`: an unchanged script's row
// is never rebuilt. Runs after that backfill, so `usesUnsafeWindow` is
// current. Writes only rows whose logs changed; returns how many.
export async function backfillStartupLogs(): Promise<number> {
  return mutate(async () => {
    const scripts = await getAllScriptMetas('startup log backfill');
    const toSet: Record<string, unknown> = {};
    for (const script of scripts) {
      if (script.status !== 'ok') continue;
      const logs = rederivedStartupLogs(script, script.usesUnsafeWindow === true);
      if (JSON.stringify(logs) === JSON.stringify(script.startupLogs ?? [])) continue;
      const next: ScriptMeta = { ...script };
      if (logs.length > 0) next.startupLogs = logs;
      else delete next.startupLogs;
      toSet[scriptKey(script.id)] = next;
    }
    const changed = Object.keys(toSet).length;
    if (changed > 0) await writeLocal(toSet);
    return changed;
  });
}

// Re-run all of `validateHeader` on stored `ok` rows, so a header
// check added in an update stops scripts already installed rather than
// only new or changed ones. Same reason as the backfills above: an
// unchanged script's row is never rebuilt. Writes only rows that now
// fail; returns how many.
//
// Each flipped row gets its error in the Log here: the boot replay
// runs on the same wake and may have read the row while it was still
// `ok`, which would leave an INVALID badge over a Log that says nothing.
export async function backfillHeaderProblems(): Promise<number> {
  const flipped = await mutate(async () => {
    const scripts = await getAllScriptMetas('header check backfill');
    const toSet: Record<string, unknown> = {};
    for (const script of scripts) {
      if (script.status !== 'ok') continue;
      const problem = validateHeader(script.header);
      if (!problem) continue;
      const next: ScriptMeta = { ...script, status: 'invalid' };
      setScriptError(next, problem.message, locationIn(script.relativePath, problem.line));
      // Same shape as a freshly built invalid row (see
      // `buildScriptFromText`): no startup logs, parse verdict or world
      // flag, and no stale refresh failure competing with the error.
      delete next.startupLogs;
      delete next.parseCheckedHash;
      delete next.usesUnsafeWindow;
      delete next.refreshError;
      toSet[scriptKey(script.id)] = next;
    }
    const rows = Object.values(toSet) as ScriptMeta[];
    if (rows.length > 0) await writeLocal(toSet);
    return rows;
  });
  // Outside the lock: the Log has its own queue.
  for (const row of flipped) {
    const entry = loadStateLogEntry(row);
    if (entry) await appendScriptLog(row.id, { ...entry, source: 'extension-update' });
  }
  return flipped.length;
}

// The opposite of `backfillHeaderProblems`: ids of rows an older build
// refused with a check that no longer exists (`@run-at context-menu`,
// before manual scripts). The caller refreshes them; a refresh always
// refetches an invalid row (see `fetchOrSkipInParallel`), and the
// rebuild then also loads the `@require` / `@resource` files an invalid
// row never got. Flipping the row to `ok` in place would skip those.
export async function retiredHeaderProblemIds(): Promise<string[]> {
  const scripts = await getAllScriptMetas('retired header check');
  return scripts
    .filter((s) => s.status === 'invalid' && s.errorMessage === RETIRED_CONTEXT_MENU_UNSUPPORTED)
    .map((s) => s.id);
}

// Reorder the collections index by moving the given collection one
// position up or down. No-op if the collection is already at the
// boundary in the requested direction (caller-side Up/Down buttons
// disable themselves at the ends, but the function tolerates a
// redundant call). Only the index row is rewritten; per-collection rows
// are untouched.
export async function moveCollection(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  await mutate(async () => {
    const ids = await readCollectionIndex();
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= ids.length) return;
    const next = ids.slice();
    [next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!];
    await writeLocal({ [COLLECTIONS_INDEX_KEY]: next });
  });
}

export async function removeCollection(id: string): Promise<void> {
  const nextIndex = await mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    const ids = await readCollectionIndex();
    const next = ids.filter((sid) => sid !== id);
    const scriptIds = collection?.scriptIds ?? [];
    const rows = await getRows(scriptIds.map(scriptKey));
    const removed = scriptIds.map((sid) => rows[scriptKey(sid)] as ScriptMeta | undefined)
      .filter((r): r is ScriptMeta => r !== undefined);
    const removeKeys = [
      collectionKey(id),
      ...scriptIds.map(scriptKey),
      ...scriptIds.map(connectGrantsKey),
      ...await unreferencedScratchKeys(removed),
    ];
    await writeLocal({ [COLLECTIONS_INDEX_KEY]: next, ...await withoutTimes(scriptIds) });
    await removeLocal(removeKeys);
    return next;
  });
  // Session-storage bookkeeping, so a removed collection can't leave a
  // banner counting a section that is no longer on the page. After the
  // write, not inside it: the local write is the one that has to be
  // atomic, and a failure here must not undo a removal that succeeded.
  await pruneRefreshErrors(nextIndex);
}

// Drop a single script row from storage and remove its ID from the
// parent collection's scriptIds list. Used by the collections-page
// trash-cans (container rows, `missing` rows from older versions), the
// delete-local-file dialog, and `refreshScript` when a directory no
// longer lists the file — refreshCollection won't recreate the row
// because it only adds entries the scan currently reports.
export async function removeScript(id: string): Promise<void> {
  await mutate(async () => {
    const script = await getRow<ScriptMeta>(scriptKey(id));
    if (!script) return;
    const collection = await getRaw<StoredCollection>(collectionKey(script.collectionId));
    const toSet: Record<string, unknown> = await withoutTimes([id]);
    if (collection) {
      const nextIds = collection.scriptIds.filter((sid) => sid !== id);
      if (nextIds.length !== collection.scriptIds.length) {
        toSet[collectionKey(collection.id)] = { ...collection, scriptIds: nextIds };
      }
    }
    if (Object.keys(toSet).length > 0) await writeLocal(toSet);
    await removeLocal([
      scriptKey(id), connectGrantsKey(id), ...await unreferencedScratchKeys([script]),
    ]);
  });
  // After the write, not inside it: the local write is the one that has
  // to be atomic, and a failure here must not undo a removal that
  // succeeded. The refresh path drops rows the same way and clears their
  // logs the same way.
  await forgetScriptLogs([id]);
}

// The text rows (and pushed-file rows) of the scratch scripts among
// `removed` that no other script row still reads. A scratch script moved into another collection
// keeps reading its text row, so a URL some remaining row names keeps
// its text. Reads nothing more when no scratch script is among those
// removed, and otherwise only the container collections' rows: a
// scratch script can only be moved into another container. Call
// inside `mutate`, before the rows are deleted.
async function unreferencedScratchKeys(removed: readonly ScriptMeta[]): Promise<string[]> {
  const urls = new Set(removed.map((r) => r.relativePath).filter(isScratchUrl));
  if (urls.size === 0) return [];
  const removedIds = new Set(removed.map((r) => r.id));
  const collectionRows = await getMany((await readCollectionIndex()).map(collectionKey));
  const others: string[] = [];
  for (const value of Object.values(collectionRows)) {
    const c = value as StoredCollection | undefined;
    if (!c || !isContainerCollection(c.path)) continue;
    for (const sid of c.scriptIds) if (!removedIds.has(sid)) others.push(sid);
  }
  const rows = await getRows(others.map(scriptKey));
  for (const value of Object.values(rows)) {
    urls.delete((value as ScriptMeta).relativePath);
  }
  return [...urls].flatMap((url) => [scratchTextKey(url), scratchFilesKey(url), scratchSourceKey(url)]);
}

// ---------- Membership reconciliation ----------

// The rows `reconcileScriptMembership` needs when the caller hasn't
// already read them: every script row, and every collection row the
// INDEX still lists.
//
// Index-filtered so this agrees with the collections page, which passes
// what `getCollections` gave it. A `collection:` row the index has lost
// is not somewhere a script can be put back — nothing renders or
// refreshes it — so both callers have to treat scripts naming one as
// collectionless rather than re-link them into a collection no surface
// shows.
//
// The filter also means a de-indexed row's stale cross-listing is left
// alone rather than dropped. That listing is invisible either way, and
// leaving one row of garbage beats writing to a collection we've just
// decided isn't real.
async function scanMembershipRows(): Promise<{
  collections: StoredCollection[]; scripts: ScriptMeta[];
}> {
  const all = await allCachedRows() ?? await scanStorageRows('membership reconcile', (k) =>
    k === COLLECTIONS_INDEX_KEY || k.startsWith(COLLECTION_PREFIX) || k.startsWith(SCRIPT_PREFIX));
  // Out of the scan rather than a second read, so the index and the rows
  // it filters are one snapshot. `ensureCollectionKeysMigrated` already
  // ran, so this is the post-rename spelling.
  const index = all[COLLECTIONS_INDEX_KEY];
  const indexed = new Set(Array.isArray(index) ? index as string[] : []);
  const collections: StoredCollection[] = [];
  const scripts: ScriptMeta[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(COLLECTION_PREFIX)) {
      if (indexed.has(key.slice(COLLECTION_PREFIX.length))) {
        collections.push(value as StoredCollection);
      }
    } else if (key.startsWith(SCRIPT_PREFIX)) {
      scripts.push(value as ScriptMeta);
    }
  }
  return { collections, scripts };
}

//
// Make `collection.scriptIds` agree with the `collectionId` on each
// script row. Every mutator writes both together, so a disagreement is
// a bug state rather than a shape the store means to represent — but a
// refresh that raced an install or a move used to overwrite the list
// from its pre-fetch snapshot and leave one behind (both directions
// now handled in `writeRefreshedCollection`).
//
// This heals profiles that already hit it. The row's own `collectionId`
// is the authority, because that is what the injector and the viewer
// read — a row unlisted by it is invisible on the collections page and
// never refreshed again, and one listed by a collection it doesn't name
// shows up under a collection it doesn't belong to.
//
// Finding a row nothing points at needs every row, so this does not run
// on a schedule of its own. The collections page (the surface where an
// unlisted row is missing, and the one the user is looking at when they
// notice) asks the worker for it on every full render, which reads the
// rows from its row cache.
//
// A row whose collection is GONE is left alone: `removeCollection`
// drops both together so it shouldn't arise, there is nowhere to put
// such a row back, and quietly deleting a user's script on a hunch is
// worse than leaving an inert row.
export async function reconcileScriptMembership(): Promise<number> {
  await ensureCollectionKeysMigrated();
  const rows = await scanMembershipRows();

  // {script id → the collections currently listing it}. Built over
  // every collection row rather than a flat "is listed" set, so a row
  // listed by the WRONG collection is caught too.
  const listedBy = new Map<string, string[]>();
  const known = new Set<string>();
  for (const collection of rows.collections) {
    known.add(collection.id);
    for (const sid of collection.scriptIds ?? []) {
      const owners = listedBy.get(sid);
      if (owners) owners.push(collection.id);
      else listedBy.set(sid, [collection.id]);
    }
  }

  // Per collection: ids it should list but doesn't, and ids it lists
  // that name somewhere else.
  const toAdd = new Map<string, string[]>();
  const toDrop = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, cid: string, sid: string): void => {
    const ids = map.get(cid);
    if (ids) ids.push(sid);
    else map.set(cid, [sid]);
  };
  let collectionless = 0;
  for (const script of rows.scripts) {
    const owners = listedBy.get(script.id) ?? [];
    const cid = script.collectionId;
    if (cid === undefined || !known.has(cid)) {
      collectionless++;
      continue;
    }
    if (!owners.includes(cid)) push(toAdd, cid, script.id);
    for (const other of owners) if (other !== cid) push(toDrop, other, script.id);
  }
  if (collectionless > 0) {
    console.log(
      `[SourceMonkey] membership: ${collectionless} script row(s) name no `
      + 'existing collection; left in place',
    );
  }
  await pruneEnablementTimes(new Set(rows.scripts.map((sc) => sc.id)));
  if (toAdd.size === 0 && toDrop.size === 0) return 0;

  // Re-read inside the lock: the scan is stale by now, and a concurrent
  // refresh or move may already have adopted (or legitimately removed)
  // one of these rows. Read every row this pass touches in two batched
  // gets rather than one per id — the mutex is held throughout, and the
  // rest of the module keeps its critical sections short.
  return await mutate(async () => {
    const cids = new Set([...toAdd.keys(), ...toDrop.keys()]);
    const sids = new Set([...toAdd.values(), ...toDrop.values()].flat());
    const collections = await getMany([...cids].map(collectionKey));
    const scripts = await getRows([...sids].map(scriptKey));
    const ownerOf = (sid: string): string | undefined =>
      (scripts[scriptKey(sid)] as ScriptMeta | undefined)?.collectionId;

    const toSet: Record<string, unknown> = {};
    let moved = 0;
    for (const cid of cids) {
      const collection = collections[collectionKey(cid)] as StoredCollection | undefined;
      if (!collection) continue;
      const before = collection.scriptIds ?? [];
      const has = new Set(before);
      // Re-checked against the row as it stands now, so a move that
      // landed since the scan isn't undone by acting on stale reads.
      const add = (toAdd.get(cid) ?? []).filter((sid) => !has.has(sid) && ownerOf(sid) === cid);
      const drop = new Set((toDrop.get(cid) ?? []).filter((sid) => ownerOf(sid) !== cid));
      const after = [...before.filter((sid) => !drop.has(sid)), ...add];
      if (after.length === before.length && add.length === 0) continue;
      toSet[collectionKey(cid)] = { ...collection, scriptIds: after } satisfies StoredCollection;
      moved += add.length + drop.size;
    }
    if (moved === 0) return 0;
    await writeLocal(toSet);
    console.log(
      `[SourceMonkey] membership: reconciled ${moved} script listing(s) across `
      + `${Object.keys(toSet).length} collection(s)`,
    );
    return moved;
  });
}

// Rescan a collection + refetch all of its scripts. Adds new files,
// keeps known files (status updated based on fetch result), and drops
// the ones the scan no longer reports (see `rebuildCollection`).
// Persists the updated collection row plus every
// script row that actually changed, in one set call — see
// `changedScriptRows`.
//
// Scan failure (unreadable directory listing, unreadable manifest, bad
// URL) records a `scanError` on the collection and **leaves every script
// untouched** — content, status, and enabled state all preserved. We
// can't tell whether a collection that won't list is actually empty or
// just temporarily unreachable (remote mount with timed-out creds,
// flaky network, …), so we err on the side of keeping the user's
// scripts running until we see definitive evidence they're gone.
//
// Optimisation: skip the fetch and reuse the prior entry verbatim when
// the collection can prove a file is unchanged — file:// uses Chrome's
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
  // Shared cross-script file-fetch cache. When refreshAllCollections
  // calls multiple refreshCollection concurrently, threading one cache
  // through them lets two scripts (across two collections) referencing
  // the same URL share one fetch. Single refreshCollection calls let it
  // default to an empty fresh map.
  fileFetchCache?: FileFetchCache;
  // The collection was just added (`createLocationCollection`). Its new
  // copies then win over other active copies, rather than defer to
  // them (`settleNewCopies`).
  adding?: boolean;
}

export async function refreshCollection(
  id: string,
  opts: RefreshOptions = {},
): Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null> {
  const timer = startPhaseTimer('collection refresh');
  const prior = await getCollectionWithScripts(id);
  if (!prior) return null;
  const { collection, scripts: existingScripts } = prior;
  timer.mark('read');
  timer.note(collection.path);

  let scan: { relativePath: string; size?: number; mtime?: number }[] = [];
  let scanError: string | undefined;
  let manifestStat: ListingEntry | null = null;
  if (isContainerCollection(collection.path)) {
    // Container collections have no scan step — their child scripts are
    // explicit. Build a synthetic scan from the existing rows so the
    // rest of the pipeline can refetch each URL/path. A `file://` child
    // gets the same listing stat a directory scan would give it (one
    // listing per folder), so an unchanged one is skipped and a page
    // can tell an edited one; HTTP children skip via conditional GET.
    const listings: DirectoryListingCache = new Map();
    scan = await Promise.all(existingScripts.map(async (s) => {
      const entry: { relativePath: string; size?: number; mtime?: number } = { relativePath: s.relativePath };
      if (isFileUrl(s.fileUrl)) {
        const stat = await statFileByListing(locationFsPath(s.fileUrl), listings);
        if (stat?.size !== undefined) entry.size = stat.size;
        if (stat?.mtime !== undefined) entry.mtime = stat.mtime;
      }
      return entry;
    }));
  } else {
    // A `file://` manifest's own stat, recorded beside the scan it
    // produced so the collections page can tell the manifest was
    // edited since. Taken BEFORE the read: an edit landing between the
    // two then shows as a change rather than being silently folded
    // into this refresh. The listing is shared with the scan, whose
    // entries usually sit in the same folder.
    const listings: DirectoryListingCache = new Map();
    if (isManifestCollection(collection.path) && isFileUrl(collectionCanonicalUrl(collection.path))) {
      manifestStat = await statFileByListing(locationFsPath(collection.path), listings);
    }
    try {
      scan = await scanForUserScripts(collection.path, 0, '', listings);
    } catch (err) {
      scanError = describeError(err);
    }
  }

  timer.mark('scan');
  const now = Date.now();

  // Scan failure (unreadable manifest, unreadable top-level directory,
  // bad URL shape) is treated as "we don't actually know what's there
  // right now" — keep every existing script row, its content, and its
  // enabled state untouched. The collection row records the scanError so
  // the collections page can surface it. Without this guard, the
  // rebuildCollection path below would drop every script — silently
  // taking the scripts away. That's the wrong call when the collection might
  // just be a remote mount with timed-out credentials, a flaky network,
  // etc.; the user wants the scripts to stay enabled until the collection
  // is actually proven gone.
  if (scanError) {
    return await mutate(async () => {
      // Re-read inside the lock so a concurrent setCollectionEnabled
      // (or displayName backfill) that landed during the scan isn't
      // reverted — we only own lastRefreshedAt + scanError here.
      const curCollection = await getRaw<StoredCollection>(collectionKey(id)) ?? collection;
      const nextCollection: StoredCollection = {
        ...curCollection,
        lastRefreshedAt: now,
        scanError,
      };
      await writeLocal({ [collectionKey(id)]: nextCollection });
      return { collection: nextCollection, scripts: existingScripts };
    });
  }

  // Fetch every scanned file — with bounded concurrency — except those
  // whose size+mtime are already current.
  const fetchResults = await fetchOrSkipInParallel(
    collection.path,
    scan,
    existingScripts,
  );
  // Marked here so the breakdown says whether the time went to reading
  // files or to everything downstream of having read them (dependency
  // fetches, hashing, the parse check).
  timer.mark('fetch');

  const scripts = await rebuildCollection({
    collectionId: collection.id,
    collectionPath: collection.path,
    existing: existingScripts,
    scan,
    fetchResults,
    now,
    recheckFiles: opts.recheckFiles,
    fileFetchCache: opts.fileFetchCache,
    localFiles: localFileScope(collection),
  });
  timer.mark('rebuild');
  // Thunked: counting the skips walks every fetch result, which a
  // disabled timer must not pay for.
  timer.note(() => {
    const skipped = [...fetchResults.values()].filter((r) => 'unchanged' in r).length;
    return `${scripts.length} scripts, ${skipped} unchanged`;
  });

  // Re-read the current rows INSIDE the lock and write atomically, so a
  // concurrent enable toggle (setCollectionEnabled / setScriptEnabled)
  // that landed during the fetch isn't reverted by stale values
  // captured before it. Content (and any deliberate refresh-owned
  // `enabled` change) is kept; we only re-apply the user's toggle when the
  // persisted `enabled` actually changed vs the snapshot this refresh
  // started from — that's the signal a setScriptEnabled landed
  // mid-fetch.
  const priorById = new Map(existingScripts.map((s) => [s.id, s]));
  // The write is the last thing that can fail, and it is the one failure
  // `chrome.storage.local` can't record — an exhausted quota rejects the
  // error row for the same reason it rejected the refresh. The reason
  // goes to `chrome.storage.session` instead, where the collections page
  // reads it. Every refresh path funnels through here, including the one
  // `addCollection` runs directly, so this is the only place that needs
  // to know. See src/extension/refresh-error.ts.
  // Copies elsewhere that a new copy might meet (`settleNewCopies`):
  // found with a full scan here, before the lock, so the write's window
  // stays one round-trip. Inside the lock only these rows are re-read.
  const scannedNew = scripts.filter((s) => !priorById.has(s.id));
  const rivalIds = scannedNew.length > 0 ? await possibleRivals(id, scannedNew) : [];
  try {
    const written = await writeRefreshedCollection();
    timer.mark('write');
    timer.done();
    // Clears on the way out, so a collection that recovers stops
    // reporting a failure the next refresh already fixed.
    await setRefreshError(id, null);
    if (!written) return null;
    // After the write, not inside it — same rule `removeScript` follows:
    // the storage.local write is the one that has to be atomic, and a
    // log we failed to clear must not undo a refresh that landed.
    await forgetScriptLogs(written.droppedIds);
    return { collection: written.collection, scripts: written.scripts };
  } catch (err) {
    await setRefreshError(id, describeError(err));
    throw err;
  }

  // Reports `droppedIds` alongside the written state so the caller can
  // clear those scripts' logs outside the lock.
  async function writeRefreshedCollection(): Promise<
    { collection: StoredCollection; scripts: StoredScript[]; droppedIds: string[] } | null
  > {
    return await mutate(async () => {
      const curCollection = await getRaw<StoredCollection>(collectionKey(id));
      if (!curCollection) {
        // Collection was removed during the refresh — abandon the write
        // rather than resurrect a deleted collection row.
        return null;
      }
      // Without their bodies: see `changedScriptRows`.
      const curScripts = await getRows(scripts.map((s) => scriptKey(s.id)));
      const priorIds = new Set(existingScripts.map((s) => s.id));

      // Membership moves under us in both directions, and the freshly
      // re-read row is the authority on both. `scripts` was rebuilt
      // from a snapshot taken before the fetch (for a container, that
      // snapshot IS the synthetic scan), so it describes a membership
      // that may be minutes stale.
      //
      // LEFT during the fetch — the row is gone (`removeScript`) or now
      // names another collection (`moveScript`). Writing the rebuilt
      // row back would resurrect a deleted script, or revert the move
      // AND leave the destination still listing it, so the same script
      // shows under two collections. `preserveConcurrentEdits` can't
      // rescue this: it re-applies fields onto the rebuilt row, and
      // what's wrong here is that the row belongs to someone else now.
      const departed = new Set<string>();
      for (const s of scripts) {
        const cur = curScripts[scriptKey(s.id)] as ScriptMeta | undefined;
        // A row the scan found for the first time has no stored
        // counterpart yet — that's a new script, not a departure.
        if (!cur) {
          if (priorIds.has(s.id)) departed.add(s.id);
        } else if (cur.collectionId !== id) {
          departed.add(s.id);
        }
      }
      const kept = scripts.filter((s) => !departed.has(s.id));
      const finalScripts = kept.map((s) => preserveConcurrentEdits(
        s,
        priorById.get(s.id),
        curScripts[scriptKey(s.id)] as ScriptMeta | undefined,
      ));

      // JOINED during the fetch — an `installScript` / `moveScript`
      // into this collection that the snapshot never saw. Writing the
      // rebuilt list verbatim would erase its id while leaving the
      // `script:` row in storage — unlisted: still pointing here via
      // `collectionId`, still injected, but shown by no collection and
      // never refreshed again.
      const rebuiltIds = finalScripts.map((s) => s.id);
      const rebuilt = new Set(rebuiltIds);
      const joinedDuringRefresh = curCollection.scriptIds.filter(
        (sid) => !rebuilt.has(sid) && !priorIds.has(sid) && !departed.has(sid),
      );

      const nextCollection: StoredCollection = {
        ...curCollection,
        lastRefreshedAt: now,
        scriptIds: [...rebuiltIds, ...joinedDuringRefresh],
      };
      // Clear any scanError left by a previous failed refresh — control
      // only reaches here when the scan succeeded (the early-return above
      // handles the failure case).
      delete nextCollection.scanError;
      // Both or neither, like a script row's size + fsMtime: a lone
      // value can't be compared against a listing.
      if (manifestStat?.size !== undefined && manifestStat.mtime !== undefined) {
        nextCollection.manifestSize = manifestStat.size;
        nextCollection.manifestMtime = manifestStat.mtime;
      } else {
        delete nextCollection.manifestSize;
        delete nextCollection.manifestMtime;
      }

      // Drop rows whose IDs are no longer referenced — an entry that
      // fell off the listing, or a manifest entry the user removed. Of
      // the ids the snapshot had, since a row that joined mid-refresh
      // was never reconciled against the scan; and never a departed
      // one, whose row is either already deleted or now owned by the
      // collection it moved to.
      const droppedIds = [...priorIds]
        .filter((sid) => !rebuilt.has(sid) && !departed.has(sid));

      // The collection row always goes: `lastRefreshedAt` moved, and
      // that's the record of the check having happened at all. The
      // script rows only go if they actually changed — see
      // `changedScriptRows`.
      const toSet: Record<string, unknown> = { [collectionKey(id)]: nextCollection };
      // Scripts the scan found for the first time: one active copy per
      // script, and their active times. Also drops the times of rows
      // dropped below.
      const newIds = new Set(finalScripts
        .filter((s) => !priorIds.has(s.id) && !curScripts[scriptKey(s.id)])
        .map((s) => s.id));
      if (newIds.size > 0 || droppedIds.length > 0) {
        Object.assign(toSet, await settleNewCopies(
          nextCollection, finalScripts, newIds, droppedIds, rivalIds, opts.adding === true,
        ));
      }
      const changed = await changedScriptRows(finalScripts, curScripts, (sid) => priorById.get(sid));
      Object.assign(toSet, changed.items);
      timer.note(`rows written: ${changed.count}`);
      // Placed where a real quota rejection lands — after everything was
      // fetched and reconciled, with nothing written — so the test
      // exercises the same state the production failure produces.
      if (collectionWriteFailure !== null) {
        throw translateStorageError(new Error(collectionWriteFailure));
      }
      await writeLocal(toSet);
      if (droppedIds.length > 0) {
        await removeLocal([...droppedIds.map(scriptKey), ...droppedIds.map(connectGrantsKey)]);
      }

      return { collection: nextCollection, scripts: finalScripts, droppedIds };
    });
  }
}

// The ids of stored rows in other collections that are copies of one of
// `newRows` (`sameScript`). One full scan, run before the refresh's lock.
async function possibleRivals(collectionId: string, newRows: readonly StoredScript[]): Promise<string[]> {
  const all = await scanStorageRows('new copies', (k) => k.startsWith(SCRIPT_PREFIX));
  const out: string[] = [];
  for (const value of Object.values(all)) {
    const row = value as ScriptMeta;
    if (row.collectionId !== collectionId && newRows.some((n) => sameScript(n, row))) out.push(row.id);
  }
  return out;
}

// What a refresh does about copies it finds for the first time, inside
// its write lock (docs/script-enablement.md#new-copies). Edits the new
// rows in `finalScripts` in place, and returns the other writes: rows
// it turned off elsewhere, and the active-times map.
//
//   - Two new copies of one script: only the first by
//     `compareInCollection` (highest `@version`, then location) stays
//     ticked.
//   - `adding` (the collection was just added): it counts as turning
//     the collection on, so each new active copy turns off the other
//     active copies of its script elsewhere.
//   - Otherwise (a later refresh found a new file): a new copy whose
//     script already has an active copy lands unticked, and the active
//     one stays active.
//
// `rivalIds` are the rows elsewhere that might be copies
// (`possibleRivals`); only they are re-read here. An sm-dev run's
// collection is left out both ways, as everywhere.
async function settleNewCopies(
  collection: StoredCollection,
  finalScripts: StoredScript[],
  newIds: ReadonlySet<string>,
  droppedIds: readonly string[],
  rivalIds: readonly string[],
  adding: boolean,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const got = await getRows([...rivalIds.map(scriptKey), ENABLEMENT_TIMES_KEY]);
  const times: EnablementTimesMap = { ...(got[ENABLEMENT_TIMES_KEY] as EnablementTimesMap | undefined) };
  let timesChanged = false;
  for (const sid of droppedIds) {
    if (times[sid]) {
      delete times[sid];
      timesChanged = true;
    }
  }
  // Re-read inside the lock: a rival moved into this collection since
  // the scan is one of `finalScripts` now, or not listed at all.
  const others = rivalIds
    .map((sid) => got[scriptKey(sid)] as ScriptMeta | undefined)
    .filter((r): r is ScriptMeta => r !== undefined && r.collectionId !== collection.id);
  const collIds = [...new Set(others.map((r) => r.collectionId))];
  const gotColls = await getMany(collIds.map(collectionKey));
  const collections = new Map<string, StoredCollection>([[collection.id, collection]]);
  for (const cid of collIds) {
    const c = gotColls[collectionKey(cid)] as StoredCollection | undefined;
    if (c) collections.set(cid, c);
  }
  const counts = (c: StoredCollection | undefined) => !c || !isSmDevCollection(c.path);
  const isActive = (row: ScriptMeta) => {
    const c = collections.get(row.collectionId);
    return isScriptEnabled(row) && (c ? isCollectionEnabled(c) : true);
  };
  const newRows = finalScripts.filter((s) => newIds.has(s.id));
  // Rows of this collection that were already there count as "already
  // active" copies too, as their refreshed rows say.
  const existing = finalScripts.filter((s) => !newIds.has(s.id));
  const at = nextEnablementStamp();
  if (counts(collection)) {
    // One ticked copy among the new ones of each script.
    const facts = (row: StoredScript) => ({
      enabled: true, collectionOn: true, collectionName: '',
      version: (row.header ? getValue(row.header, 'version')?.trim() : '') || null,
      location: row.fileUrl,
    });
    for (const row of newRows) {
      if (!isScriptEnabled(row)) continue;
      const group = newRows.filter((o) => isScriptEnabled(o) && sameScript(o, row));
      if (preferredCopy(group, facts, compareInCollection) !== row) row.enabled = false;
    }
    for (const row of newRows) {
      if (!isScriptEnabled(row)) continue;
      const rivals = [...others, ...existing].filter((o) =>
        isActive(o) && counts(collections.get(o.collectionId)) && sameScript(o, row));
      if (rivals.length === 0) continue;
      if (!adding) {
        row.enabled = false;
        continue;
      }
      // Only a copy that is itself active displaces: one under a
      // collection turned off mid-add doesn't.
      if (!isActive(row)) continue;
      for (const o of rivals) {
        if (o.collectionId === collection.id) continue;
        out[scriptKey(o.id)] = { ...o, enabled: false };
        if (stampTimes(times, o.id, true, false, at)) timesChanged = true;
      }
    }
  }
  for (const row of newRows) {
    if (isActive(row) && stampTimes(times, row.id, false, true, at)) timesChanged = true;
  }
  if (timesChanged) out[ENABLEMENT_TIMES_KEY] = times;
  return out;
}

// ---------- Batched single-script refreshes ----------
//
// The `refreshScript` calls one navigation starts — the reload fast
// path's one-per-matching-script fan-out and the opportunistic sweep
// queued off the same commit (see
// docs/injection.md#shared-work-across-the-batch). Scripts matching one
// page usually live in one collection and one folder, so without
// sharing each check re-reads the same collection row and re-lists the
// same directory, and on the worker's single thread each duplicate
// lands inside its siblings' measured time.
//
// **Scoped to one commit, never global, never with a TTL.** That bound
// is the whole safety argument, so state it as what it actually is
// rather than as "the calls all start together" — they don't:
//
//   - The fast path fans out after a single `ensureLoaded()`.
//   - The sweep runs inside `enqueueTabWork` and does `ensureLoaded()`
//     plus two session-storage round-trips first.
//
// So an entry can be written at T0 and read at T0+Δ, where Δ is
// page-load scale and widest when the worker is cold or the tab's work
// queue is backed up. Bounded by the commit, but not zero — and the
// consequence is real: a script that joined the match set inside Δ sees
// a listing captured before it started, so a save landing in that
// window reads as "unchanged" and waits for the next check. One
// navigation late, which is the same lateness a non-reload navigation
// has always had.
//
// A cache that outlived the commit would turn that bounded window into
// an unbounded one, and would need invalidation to be safe at all.
export interface RefreshBatch {
  // Collection rows by collection id. Promise-keyed so concurrent
  // starters join one read.
  collectionRows: Map<string, Promise<StoredCollection | undefined>>;
  // `file://` directory listings by absolute directory path.
  listings: DirectoryListingCache;
  // `@require` / `@resource` bodies by URL — the same sharing
  // `refreshAllCollections` already threads through its collections.
  fileFetchCache: FileFetchCache;
  // 'known' for a page load's checks: a `file://` script and the
  // stand-ins its last check found are read at their known paths, with
  // no folder listed while they still read. A listing costs more than
  // the rest of such a check, and the reload fast path has 500 ms. The
  // searching checks (a focus check past the rate limit, Refresh) find
  // a stand-in that appeared since. See
  // docs/local-file-overrides.md#page-load-checks and, for the budget,
  // docs/injection.md#reload-fast-path.
  localLookup: LocalLookup;
}

export function createRefreshBatch(localLookup: LocalLookup = 'search'): RefreshBatch {
  const listings: DirectoryListingCache = new Map();
  const fileFetchCache: FileFetchCache = new Map();
  bindListingCache(fileFetchCache, listings);
  return { collectionRows: new Map(), listings, fileFetchCache, localLookup };
}

// How many collection rows `refreshScript` has actually read from
// storage since the last reset — batch hits excluded. The other half of
// what a `RefreshBatch` shares, and the phase (`read-collection`) that
// motivated it, so it gets the same kind of counter the listings do:
// without one, a change that stopped threading the batch into the row
// read would leave every test green. Same scoping caveats as
// `getDirectoryListingFetches` — per JS context, reset around the window
// under test.
let collectionRowReads = 0;
export function getCollectionRowReads(): number {
  return collectionRowReads;
}
export function resetCollectionRowReads(): void {
  collectionRowReads = 0;
}

// The batch's copy of a collection row, or a fresh read when there is no
// batch. Returns whether it was shared so the caller's phase timer can
// say so rather than just reporting a suspiciously fast phase.
async function batchCollectionRow(
  batch: RefreshBatch | undefined,
  collectionId: string,
): Promise<CollectionRowRead> {
  const hit = batch?.collectionRows.get(collectionId);
  if (hit) return { row: await hit, shared: true, ownReadMs: 0 };
  collectionRowReads += 1;
  const started = timingNow();
  const finish = async (p: Promise<StoredCollection | undefined>): Promise<CollectionRowRead> =>
    ({ row: await p, shared: false, ownReadMs: timingNow() - started });
  if (!batch) return finish(getRaw<StoredCollection>(collectionKey(collectionId)));
  const pending = getRaw<StoredCollection>(collectionKey(collectionId));
  batch.collectionRows.set(collectionId, pending);
  // A failed read must not be remembered. A cached rejection is rethrown
  // into every later sibling, so each one throws out of `refreshScript`
  // and `runScriptCheck` writes it a `Could not check for updates` Log
  // row — one transient storage failure reported once per script on the
  // page, with nothing ever retrying it. Dropping the entry restores the
  // pre-batch blast radius: the read that failed fails, its siblings try
  // again. The identity check keeps a late rejection from evicting a
  // newer entry that has already replaced it.
  void pending.catch(() => {
    if (batch.collectionRows.get(collectionId) === pending) {
      batch.collectionRows.delete(collectionId);
    }
  });
  return finish(pending);
}

interface CollectionRowRead {
  row: StoredCollection | undefined;
  shared: boolean;
  // How long THIS call's own storage read took. Zero for a sharer,
  // which performed none, and zero whenever debug logging is off.
  //
  // Separate from the `read-collection` phase on purpose. That phase
  // spans from the caller's own script-row read to this promise
  // settling, so a sharer's copy measures waiting, and even the
  // reader's includes any time the worker's single thread spent on
  // unrelated work before the read's callback could run. When the two
  // disagree the phase is not describing this code — which is exactly
  // what a full-namespace `scanAllStorage` elsewhere in the worker did
  // to it once already.
  ownReadMs: number;
}

// Only the single-script path can defer the parse check: it is the one
// with a caller (the reload fast path) that a page is blocking on, and
// deferring means one row to re-check afterwards rather than a
// collection's worth.
export interface ScriptRefreshOptions extends RefreshOptions {
  parseCheck?: ParseCheckMode;
  // Work shared with the other `refreshScript` calls started alongside
  // this one. Single-script only: `refreshCollection` /
  // `refreshAllCollections` have their own sharing story (one scan, one
  // `fileFetchCache` threaded across collections) and must not be given
  // one of these.
  batch?: RefreshBatch;
}

// Refetch a single script. Goes through the same per-file pipeline as
// the directory-level Refresh (fetchOrSkipInParallel →
// rebuildCollection) so the two paths can't drift — same skip rules,
// same fsMtime handling, same enabled-preservation, same error shape.
// The single-file path additionally gets the size+mtime the skip check
// needs: by listing the file's parent dir, or, on a page-load check
// (`localLookup: 'known'`), from a direct read of the file, listing only
// if that read fails.
//
// A local-directory script whose file the parent listing no longer
// shows, and whose read then fails, is dropped here, the same as the
// directory-level Refresh would drop it: the listing is the directory
// saying what it holds now, and this path lists it for the size+mtime
// skip (a page-load check only once its direct read has failed). Only a
// listing that was read — a failed listing leaves the scan bare and the
// row alone — and only in a directory
// collection: a manifest entry or a single file is listed for the
// skip too, but its row is the manifest's or the user's to drop, so a
// vanished one fails its fetch and keeps running from the cached body
// with a `refreshError`. The read is required too because this path
// runs on every navigation and tab focus, so it can catch a file in
// the gap of an unlink-and-rename save; one that reads fine is not
// gone.
//
// Timed, because this is what the reload fast-path races against a
// 500 ms window (docs/injection.md#reload-fast-path) and "it didn't
// make it" was previously unattributable. The phases mirror the
// collection-refresh timer's so the two lines read the same way.
export async function refreshScript(
  scriptId: string,
  opts: ScriptRefreshOptions = {},
): Promise<StoredScript | null> {
  const timer = startPhaseTimer('script check');
  // The script's row (from the worker's row cache, so usually no
  // storage call) and its collection's row, necessarily in series: the
  // collection key comes out of the script row. The script's stored
  // code is read separately, alongside the file reads below
  // (`bodies` in the `gets:` note).
  //
  // History: these were two storage reads, measured at ~150-190ms
  // combined on the reload fast path — by far its largest fixed cost,
  // and paid by unchanged scripts too — so they are marked separately.
  // The script row then carried the whole source; the collection row is
  // a few fields, and it used to read SLOWER — which was never about
  // either row. A
  // full-namespace storage scan elsewhere in the worker was holding
  // the only thread, so the read's callback couldn't run. Neither
  // payload nor the batch's duplicate reads explained it; both were
  // guessed first and both were wrong.
  //
  // The `gets:` note is what settled it, and is why it stays: it
  // measures the read itself, next to a phase that measures the read
  // PLUS whoever else owns the thread. When those two disagree, the
  // phase is not describing this code. See
  // docs/diagnostics.md#read-collection-is-still-slow.
  //
  // "The read itself" is really `getRaw`, which gates on
  // `ensureCollectionKeysMigrated`. Memoised, so free after the first
  // call in a worker generation — but the first check after a wake
  // attributes the migration probe to `gets: script`, and on an
  // unmigrated profile the whole migration scan with it.
  const scriptReadStarted = timingNow();
  const meta = await getScriptMeta(scriptId);
  const scriptReadMs = timingNow() - scriptReadStarted;
  if (!meta) return null;
  timer.mark('read-script');
  // The bodies (one storage call for the script's blobs), in flight
  // while the collection row and the files are read. Nothing before
  // `read-bodies` below needs them.
  let bodiesReadMs = 0;
  const priorRead = (async () => {
    const started = timingNow();
    try {
      return await getScript(scriptId);
    } finally {
      bodiesReadMs = timingNow() - started;
    }
  })();
  // Settled below in every path; this keeps an early return from
  // leaving a rejection unhandled.
  priorRead.catch(() => {});
  // Shared across the batch when there is one: the scripts a page
  // matches are usually all in the same collection, so this row is read
  // once for the group instead of once per script.
  const collection = await batchCollectionRow(opts.batch, meta.collectionId);
  const collectionRow = collection.row;
  if (!collectionRow) return null;
  timer.mark('read-collection');
  if (collection.shared) timer.note('collection row shared with batch');
  else timer.note(() => `gets: script ${formatMs(scriptReadMs)}, collection ${formatMs(collection.ownReadMs)}`);
  timer.note(meta.relativePath);
  timer.note(() => `${Math.round((meta.size ?? 0) / 1024)} KB row`);

  // Build a single-entry scan. Any `file://` script gets the size+mtime
  // its collection's refresh would give it, from a listing of its
  // folder or a direct read; HTTP entries rely on the conditional GET
  // inside fetchOrSkipInParallel.
  const scan: ScannedFile[] = [{ relativePath: meta.relativePath }];
  const fileUrl = scriptFileUrl(collectionRow.path, meta.relativePath);
  const usesListingStat = isFileUrl(fileUrl);
  const knownPaths = opts.batch?.localLookup === 'known';
  // The parent listing was read and does not show the file.
  let unlisted = false;
  const localFiles: LocalFileScope = {
    ...localFileScope(collectionRow),
    ...(knownPaths ? { lookup: 'known' as const } : {}),
  };
  if (knownPaths && opts.batch && usesListingStat && localFiles.enabled) {
    // Read in parallel with the script file below, rather than after
    // it: which files to load comes from the script's header, but the
    // stand-ins the last check found are the likely answer. Only a
    // `file://` script with local files on can have stand-ins; a
    // scratch script's `localUrl`s name files sm-dev pushed, which are
    // read from storage instead.
    prefetchKnownStandIns(opts.fileFetchCache ?? opts.batch.fileFetchCache, meta);
  }
  // A page-load check reads the file itself rather than listing its
  // folder: the read reports the same size and modified time, and the
  // body comes with it. Only a read that fails lists the folder, below,
  // to tell a deleted file from one that wouldn't read.
  if (usesListingStat && knownPaths) {
    try {
      const read = await fetchScriptFileWithStat(fileUrl);
      scan[0].size = read.size;
      if (read.fsMtime !== undefined) scan[0].mtime = read.fsMtime;
      scan[0].text = read.text;
      timer.note('read directly');
    } catch {
      timer.note('direct read failed; listed the folder');
    }
  }
  if (usesListingStat && scan[0].text === undefined) {
    const fsPath = locationFsPath(fileUrl);
    const dirAbs = parentDir(fsPath);
    // Read BEFORE the call, which is what populates the cache.
    const sharedListing = hasCachedListing(opts.batch?.listings, dirAbs);
    let stat: ListingEntry | null | undefined;
    try {
      stat = await statFromListing(dirAbs, baseName(fsPath), opts.batch?.listings);
    } catch {
      /* listing failed; scan stays bare → always-fetch */
    }
    if (sharedListing) timer.note('listing shared with batch');
    // Listed, and not there. Not dropped yet: the fetch below runs
    // anyway (a bare scan means always-fetch), and a file that is back
    // by the time its body is read is a file mid-save — an editor that
    // writes by unlink + rename — not a deleted one. Only a listing
    // that lacked it AND a read that failed drops the row.
    unlisted = stat === null;
    if (stat) {
      if (stat.size !== undefined) scan[0].size = stat.size;
      if (stat.mtime !== undefined) scan[0].mtime = stat.mtime;
    }
  }
  // A direct read on a page-load check, else one `file://` directory
  // listing, shared across the batch when there is one — so N scripts
  // in the same folder list it once between them rather than N times.
  // Unbatched callers still list per script.
  timer.mark('stat');
  const prior = await priorRead;
  if (!prior) return null;
  // Moved to another file or collection between the two reads: the
  // file read above was of where it used to be. Rare (a move takes the
  // store's lock); start again from where it is now.
  if (prior.relativePath !== meta.relativePath || prior.collectionId !== meta.collectionId) {
    timer.note('moved during the check; checking again');
    timer.done();
    return await refreshScript(scriptId, opts);
  }
  // Usually 0: the bodies arrived while the file was read.
  timer.mark('read-bodies');
  timer.note(() => `bodies ${formatMs(bodiesReadMs)}`);

  const fetchResults = await fetchOrSkipInParallel(collectionRow.path, scan, [prior]);
  // Cheap when size+mtime match the stored row (no body read at all),
  // expensive when they don't. The `skipped` note is what separates
  // "the file really changed" from "we re-read it for no reason".
  timer.mark('fetch');
  timer.note(() => {
    const one = [...fetchResults.values()][0];
    return one && 'unchanged' in one ? 'unchanged' : 'refetched';
  });
  const fetched = fetchResults.get(prior.relativePath);
  // Only a directory collection mirrors the disk. A manifest entry
  // whose file is gone is still the manifest's to keep or drop, so it
  // stays — running from its cached body with a `refreshError`.
  if (unlisted && isLocalDirectoryCollection(collectionRow.path)
    && fetched && 'ok' in fetched && !fetched.ok) {
    // The directory doesn't list it and it can't be read: the file is
    // gone. Dropped the way the collection-level refresh drops it
    // (row, storage key, logs) — see the header comment. Callers
    // already handle a null result as "the row went away during the
    // check".
    console.info(`[SourceMonkey] ${prior.relativePath}: file no longer in its directory; dropping the script`);
    timer.note('file not in listing and unreadable; dropping');
    await removeScript(scriptId);
    timer.mark('drop');
    timer.done();
    return null;
  }
  const result = await rebuildCollection({
    collectionId: prior.collectionId,
    collectionPath: collectionRow.path,
    existing: [prior],
    scan,
    fetchResults,
    now: Date.now(),
    recheckFiles: opts.recheckFiles,
    // The batch's, when there is one — so two scripts on the same page
    // `@require`ing one library fetch it once between them. The `??`
    // only reflects that `fileFetchCache` is part of the inherited
    // `RefreshOptions`; no caller of `refreshScript` sets it today.
    fileFetchCache: opts.fileFetchCache ?? opts.batch?.fileFetchCache,
    localFiles,
    parseCheck: opts.parseCheck,
  });
  const next = result[0];
  if (!next) return null;
  // Covers the header parse, the `@require`/`@resource` pass (which
  // reaches the network in `recheckFiles: 'all'` mode), the source
  // hash, and the parse check.
  timer.mark('rebuild');
  // Nothing to write, the common case: answered from the worker's copy
  // of the row, without the store's lock or a storage call. Only when
  // nothing would be written, so it's no write outside the lock.
  const unchanged = await unchangedAsStored(scriptId, next, prior);
  if (unchanged) {
    timer.note('nothing to write');
    timer.mark('write');
    timer.done();
    if (opts.parseCheck === 'defer') checkParsesInBackground(unchanged);
    return unchanged;
  }
  // Re-read inside the lock and write atomically so edits that landed
  // during the fetch (an enable toggle, an update probe) aren't
  // reverted by values captured before them.
  const written = await mutate(async () => {
    // Without its bodies: see `changedScriptRows`.
    const cur = await getRow<ScriptMeta>(scriptKey(scriptId));
    // The row is gone. We read it at the top of this function, so its
    // absence now means something deleted it while we were fetching —
    // `removeCollection` (which drops the collection row and every
    // script under it) or a per-script removal. Writing would resurrect
    // an orphan: a script row no collection's `scriptIds` references,
    // invisible to the UI and never refreshed again.
    //
    // The window pre-dates the batch — the collection row was always
    // read long before this write, with the fetch and rebuild in
    // between — but a shared row widens it, because a sibling that
    // starts after the removal now takes the cached collection row
    // instead of reading `undefined` and bailing early. Checked here
    // rather than by re-reading the collection row: this covers both
    // removal paths, and costs nothing since we needed `cur` anyway.
    if (!cur) return null;
    const merged = preserveConcurrentEdits(next, prior, cur);
    // Same rule as the collection path: a check that found nothing new
    // doesn't rewrite the row. This one matters most — it's the
    // opportunistic path, so it runs on navigations rather than clicks.
    // There's no collection row here to carry a "we checked" timestamp,
    // and that's fine: nothing reads a per-script one.
    const changed = await changedScriptRows([merged], { [scriptKey(scriptId)]: cur }, () => prior);
    if (changed.count > 0) await writeLocal(changed.items);
    return merged;
  });
  timer.mark('write');
  timer.done();
  // Deferred check, started AFTER the write and deliberately not
  // awaited: the caller that asked to defer is one a page is waiting
  // on. Started from the row as written, so the verdict is judged
  // against what is actually stored.
  //
  // Asks about the row rather than about the mode the ENTRY ran in, so
  // an http(s) entry that `rebuildCollection` downgraded to `'await'`
  // reaches here too. It is a no-op unless that awaited check failed
  // open, in which case this retries it — one extra compile the pure-
  // await path wouldn't have made, on a row that genuinely has no
  // verdict. Not worth plumbing the per-entry decision back out for.
  // `null` when the row was deleted mid-refresh (see the write above).
  // Callers already have a story for it: `runScriptCheck` logs "row
  // vanished" to the SW console, and nothing to the script's Log, which
  // went with the row.
  if (!written) return null;
  if (opts.parseCheck === 'defer') checkParsesInBackground(written);
  return written;
}

// A refresh's result merged onto the stored row, when writing it would
// change nothing; else null, and the caller takes the lock and writes.
//
// Checked outside the lock against the row as stored now (the row
// cache, so no storage call in the worker), as `changedScriptRows`
// would inside it. A write by someone else after this doesn't make it
// wrong: not writing leaves their row, as a later write of ours would
// have been compared against it anyway.
//
// Only when the bodies the row points at are known to be there: the
// read of `prior` found them all (a missing one makes it a
// `MISSING_BLOB_MESSAGE` row). The locked path's key listing is what
// restores a missing one, so that case goes there.
async function unchangedAsStored(
  scriptId: string,
  next: StoredScript,
  prior: StoredScript,
): Promise<StoredScript | null> {
  if (prior.errorMessage === MISSING_BLOB_MESSAGE) return null;
  const cur = await getRow<ScriptMeta>(scriptKey(scriptId));
  if (!cur) return null;
  // New content always moves one of these, so a write is known without
  // hashing the bodies here, which the locked path would do again.
  if (next.loadedAt !== cur.loadedAt || next.contentHash !== cur.contentHash) return null;
  const merged = preserveConcurrentEdits(next, prior, cur);
  carryBodyRef(prior, merged);
  const form = await storedForm(merged);
  return sameStoredValue(form.row, cur) ? merged : null;
}

// Re-apply the parts of a script row that a refresh doesn't own, onto
// the row it just built. Called inside the write lock by both refresh
// entry points, against the row as it stands right now (`cur`) and the
// snapshot the refresh started from (`prior`).
//
//   - `enabled` — only when it actually changed under us, which is the
//     signal that a setScriptEnabled landed mid-fetch. Otherwise a
//     deliberate refresh-owned change has to win.
//   - `versionProbes` — always, because no refresh path ever produces
//     them. They arrive only from setVersionProbes, so whatever is
//     persisted now is by definition newer than what the refresh
//     started with.
//   - `collectionId` — always, for the same reason: only `moveScript`
//     writes it, so the stored value is a move that landed during the
//     fetch. A refresh rebuilds the row under the collection it was
//     asked about, and writing that back would silently revert the
//     move and leave the two collections disagreeing about who owns
//     the row. (The collection path drops such a row before it gets
//     here — see `departed` in `writeRefreshedCollection`; this is
//     what covers the single-script path.)
function preserveConcurrentEdits(
  next: StoredScript,
  prior: ScriptMeta | undefined,
  cur: ScriptMeta | undefined,
): StoredScript {
  if (!cur) return next;
  const out: StoredScript = { ...next };
  if (prior && cur.enabled !== prior.enabled) out.enabled = cur.enabled;
  out.collectionId = cur.collectionId;
  if (cur.versionProbes) out.versionProbes = cur.versionProbes;
  else delete out.versionProbes;
  return out;
}

// The writes for those of `finalScripts` that actually differ from
// what's already stored, or point at a blob that isn't stored: each
// one's small row, plus the blobs not yet stored.
//
// Every refresh path rebuilds a full row per script — including the ones
// that took the size+mtime / 304 skip and came back byte-identical — so
// without this a refresh of N scripts writes N rows to answer a question
// about one.
//
// Compared in stored form (`storedForm`): the rebuilt script's small row
// against the stored row, read without its bodies. A body that didn't
// change has the same hash, so the comparison needs no blob read, and
// the write that follows doesn't hash the body again. A format 1 row
// (bodies inline) never compares equal, so it's rewritten in format 2.
//
// Chrome already declines to fire `storage.onChanged` for a `set` whose
// value matches what's stored (the behavior `retryRejectedRegistrations`
// in injector.ts is built around), so this changes no downstream
// listener — it drops the serialize-and-store cost that happens before
// Chrome gets far enough to compare.
//
// Callers must still return the FULL list to their own callers: what
// gets written narrows, what a refresh reports does not.
//
// Takes the rows as read inside the write lock, never the pre-fetch
// snapshot — comparing against a stale read would skip a write that a
// concurrent edit had made necessary. (`refreshScript` asks first,
// outside the lock, against the row as stored now: `unchangedAsStored`.)
//
// `priorOf` gives the copy each refresh started from, read with its
// bodies: a body unchanged from it reuses its hash (`carryBodyRef`).
async function changedScriptRows(
  finalScripts: readonly StoredScript[],
  curByKey: Record<string, unknown>,
  priorOf: (id: string) => StoredScript | undefined,
): Promise<{ count: number; items: Record<string, unknown> }> {
  if (finalScripts.length === 0) return { count: 0, items: {} };
  const stored = new Set(await chrome.storage.local.getKeys());
  const items: Record<string, unknown> = {};
  let count = 0;
  for (const s of finalScripts) {
    carryBodyRef(priorOf(s.id), s);
    const form = await storedForm(s);
    const absent = newBlobItems(form.blobs, stored);
    // An equal row whose blob is gone still gets written: the refresh
    // that just fetched the body again is what puts the blob back.
    if (Object.keys(absent).length === 0 && sameStoredValue(form.row, curByKey[scriptKey(s.id)])) continue;
    Object.assign(items, { [scriptKey(s.id)]: form.row }, absent);
    count++;
  }
  return { count, items };
}

// The fields a `script:*` write can move without touching anything
// downstream of the match index's change listener: the registration,
// the match index, the tab badges. See `onlyAnnotationsChanged`.
//   - `versionProbes`: an update check's result (`setVersionProbes`).
//   - `parseCheckedHash`: the parse check's verdict, when it passed. It
//     lands just after the change it checked, whose own write started
//     a sync then; the registration built from the row is the same
//     either way. A failed one changes `status` too, which does count.
const ANNOTATION_FIELDS = ['versionProbes', 'parseCheckedHash'] as const;

// A row without its annotations, for comparing two rows apart from them.
// `sameStoredValue` treats an undefined-valued key as absent, so that's
// how a field is left out.
export function withoutAnnotations<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const field of ANNOTATION_FIELDS) out[field] = undefined;
  return out as T;
}

// Structural equality over the JSON shapes `chrome.storage.local` round-
// trips: objects, arrays, and primitives.
//
// Key ORDER is deliberately not significant. A stored row's order comes
// from however it was last serialized, while a rebuilt one's comes from
// the spread-and-delete sequence that built it (`{...prior}` then
// `delete next.refreshError`, say) — so two rows that mean the same
// thing routinely disagree on order, and a `JSON.stringify` comparison
// would call every one of them changed and quietly do nothing.
//
// `undefined`-valued keys are treated as absent, matching what a storage
// round-trip does to them: a freshly built row carrying `foo: undefined`
// and a stored row with no `foo` at all are the same row.
//
// Exported for unit tests.
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => sameStoredValue(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  // `hasOwnProperty`, not `k in bo`: a row that came back through
  // `JSON.parse` can carry an own `__proto__`, and `in` would answer for
  // the prototype chain — comparing a stored value against an inherited
  // function. That direction only ever yields "changed" (a redundant
  // write), but own-keys-only is what this means, so it says so.
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && sameStoredValue(ao[k], bo[k]),
  );
}

// A file a refresh looks at, with the size and modified time its
// folder's listing gave (or a direct read did), and the body when the
// read already happened. `text` is what that read returned, so a
// changed file isn't read twice.
interface ScannedFile {
  relativePath: string;
  size?: number;
  mtime?: number;
  text?: string;
}

// Fetch each scanned file, at most
// FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY at a time.
//
// Dispatch is per *entry URL*, not per collection: a manifest
// collection may list http(s):// entries, file:// entries, or a mix, so
// each entry picks its fetcher and skip strategy based on the resolved
// URL scheme.
//
// Scheme behaviors:
//   - http(s)://: conditional GET. We send the prior row's ETag /
//     Last-Modified as If-None-Match / If-Modified-Since; a server 304
//     becomes `unchanged`, a 200 carries new validators back through
//     FetchResult.ok for rebuildCollection to persist.
//   - file://: direct fetch. If the scan supplied size+mtime (every
//     scan does for a local file whose folder listed), we apply the
//     pre-fetch listing skip when those match the prior row.
//
// In both modes a prior error/missing entry always refetches so it has
// a chance to recover.
export async function fetchOrSkipInParallel(
  collectionPath: string,
  scan: ScannedFile[],
  existing: StoredScript[],
): Promise<Map<string, FetchResult>> {
  const byPath = new Map(existing.map((s) => [s.relativePath, s]));
  // Bounded, not `Promise.all`: an unbounded fan-out over a large
  // collection holds every fetched body live at once. See
  // src/extension/concurrency.ts.
  const results = await mapWithConcurrency(
    scan, FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
    async (found): Promise<[string, FetchResult]> => {
      const prior = byPath.get(found.relativePath);
      const url = scriptFileUrl(collectionPath, found.relativePath);
      if (isHttpUrl(url)) {
        try {
          const fetched = await fetchHttpText(url, prior?.status === 'ok' ? {
            etag: prior.httpEtag,
            lastModified: prior.httpLastModified,
          } : {});
          if (fetched.kind === 'unchanged') {
            return [found.relativePath, { unchanged: true }];
          }
          const ok: FetchResult = { ok: true, text: fetched.text };
          if (fetched.etag) ok.httpEtag = fetched.etag;
          if (fetched.lastModified) ok.httpLastModified = fetched.lastModified;
          return [found.relativePath, ok];
        } catch (err) {
          return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
        }
      }
      // file:// (or any other non-HTTP URL the file fetcher can handle).
      const canSkip =
        prior != null &&
        prior.status === 'ok' &&
        found.size !== undefined && found.mtime !== undefined &&
        prior.size === found.size &&
        prior.fsMtime === found.mtime;
      if (canSkip) {
        return [found.relativePath, { unchanged: true }];
      }
      if (found.text !== undefined) return [found.relativePath, { ok: true, text: found.text }];
      try {
        const text = await fetchScriptFileUrlText(url);
        return [found.relativePath, { ok: true, text }];
      } catch (err) {
        return [found.relativePath, { ok: false, errorMessage: describeError(err) }];
      }
    },
  );
  return new Map(results);
}

// Refresh every registered collection, a bounded few at a time. Returns
// the new state per collection so callers can compute "what changed"
// without a second read.
//
// One collection failing never takes the pass down, and never costs the
// others their results — its slot in the result map is simply absent.
// Both failure kinds have a durable home to be read from afterwards, so
// dropping the throw loses nothing:
//   - a scan failure → the collection row's `scanError`
//   - a write failure → the session-storage map in src/extension/refresh-error.ts
//
// Rethrowing instead would reject the caller at the first failure while
// the remaining collections were still being written, so their outcomes
// could never be reported — and on an exhausted quota EVERY collection
// fails, which made that the normal case rather than the rare one.
export async function refreshAllCollections(
  opts: RefreshOptions = {},
): Promise<Map<string, { collection: StoredCollection; scripts: StoredScript[] }>> {
  const collections = await getCollections();
  // One shared file-fetch cache across every collection in this pass so
  // two scripts (across two collections) referencing the same canonical
  // URL share one fetch. Caller can override by passing their own.
  const fileFetchCache = opts.fileFetchCache ?? new Map();
  // Bounded like the per-file fan-out inside each collection: without a
  // cap here, N collections would each run their own in-flight set at
  // the same time and the per-collection bound wouldn't cap anything.
  // Deliberately the smaller limit of the pair, because each slot here
  // expands into a whole collection's worth of fetches — and because a
  // profile with many collections is the rarer case. See
  // src/extension/concurrency.ts.
  const entries = await mapWithConcurrency(
    collections, FETCH_COLLECTIONS_CONCURRENCY, async (s) => {
      try {
        const r = await refreshCollection(s.id, { ...opts, fileFetchCache });
        return [s.id, r] as const;
      } catch (err) {
        // `refreshCollection` already recorded the reason where the UI
        // reads it; all this has to do is keep the sibling collections
        // running. The console line is for the SW log, not the user —
        // named, because the motivating case fails every collection at
        // once and an unattributed line would be noise. Says "failed"
        // rather than naming a cause: most throws here are the write,
        // but this catch doesn't verify that.
        console.info(`[SourceMonkey] collection refresh failed: ${s.path}: ${describeError(err)}`);
        return [s.id, null] as const;
      }
    },
  );
  const out = new Map<string, { collection: StoredCollection; scripts: StoredScript[] }>();
  for (const [id, r] of entries) {
    if (r) out.set(id, r);
  }
  return out;
}

// Chrome's own wording for a `chrome.storage.local` write that would
// exceed the extension's quota. The text has changed across versions
// (`QUOTA_BYTES quota exceeded`, `Resource::kQuotaBytes quota
// exceeded`), so match the constant part.
const CHROME_QUOTA_REJECTION = /quota exceeded/i;

// The one message for a write that didn't fit. Names the cause and the
// fix, and takes the place of the internal-vocabulary wording Chrome
// gives — a user reading `Resource::kQuotaBytes quota exceeded` in a
// Log entry has nothing to act on. Two sentences, so both are
// punctuated (docs/diagnostics.md#wording).
export function storageFullMessage(): string {
  const quota = chrome.storage.local.QUOTA_BYTES;
  const limit = typeof quota === 'number' && quota > 0
    ? ` (Chrome allows ${Math.round(quota / (1024 * 1024))} MB)`
    : '';
  // "Out of storage space" is also the collections banner's heading
  // (`renderStorageBanner`), so the two read as one condition.
  return `SourceMonkey is out of storage space${limit}. `
    + 'Remove a script or collection you no longer need to free space.';
}

// Every `chrome.storage.local.set` in this module goes through here, so
// an out-of-quota rejection reads the same wherever it surfaces — the
// install callout, a Log entry, the collections banner. Any other
// rejection is passed through as Chrome worded it.
//
// Script rows are written in format 2: a full script splits into its
// small row plus the blobs it points at, in this same `set`.
async function writeLocal(items: Record<string, unknown>): Promise<void> {
  assertWorkerContext('write storage');
  await storeFormatReady();
  await setLocal(await withBlobs(items));
}

// `writeLocal` without the format handling, for the key-rename
// migration, which runs before the format migration and writes rows as
// it read them.
async function setLocal(items: Record<string, unknown>): Promise<void> {
  assertWorkerContext('write storage');
  try {
    await chrome.storage.local.set(items);
  } catch (err) {
    throw translateStorageError(err);
  }
}

// Every script-row removal in this module, so none lands while the
// worker is still converting rows (a converted copy would bring the row
// back). The blobs stay; see docs/storage.md#writing-and-cleanup.
async function removeLocal(keys: string | string[]): Promise<void> {
  assertWorkerContext('write storage');
  await storeFormatReady();
  await chrome.storage.local.remove(keys);
}

// Chrome's error rides along as `cause` for DevTools; `describeError`
// reads only `.message`, so it never reaches a user-facing string.
function translateStorageError(err: unknown): unknown {
  return CHROME_QUOTA_REJECTION.test(describeError(err))
    ? new Error(storageFullMessage(), { cause: err })
    : err;
}

// Flip a collection's enabled flag. The match-index listens for
// `collection:<id>` changes and re-evaluates the effective enabled state
// of every script under this collection. Turning it on or off doesn't
// touch other collections; `setCollectionEnabledExclusive`
// (script-enablement.ts) is the toggle that keeps one copy active.
export async function setCollectionEnabled(
  id: string,
  enabled: boolean,
): Promise<StoredCollection | null> {
  return (await writeEnablement({ collection: { id, enabled } })).collection;
}

// One enable change: any of a collection's flag, scripts' flags, and
// copies to stamp as starting now.
export interface EnablementWrite {
  collection?: { id: string; enabled: boolean };
  scripts?: readonly { id: string; enabled: boolean }[];
  // Copies already active to stamp as becoming active at this write,
  // though no flag of theirs changes: one that became active in an
  // earlier write (an install, a move) and only now displaces its other
  // copies. Gives it the same time the copies it displaced go inactive.
  started?: readonly string[];
}

// When each copy last became active and last went inactive, in epoch
// ms. Active means its own flag and its collection's are both on, so it
// fires on the pages it matches. One storage key holding every script's
// times, rather than fields on the script rows: a collection toggle
// changes the times of every copy under it, and stamping them on the
// rows would rewrite each full row (bodies and all). See
// [docs/script-enablement.md](../../docs/script-enablement.md#active-times).
export { ENABLEMENT_TIMES_KEY };

export interface EnablementTimes {
  activeSince?: number;
  inactiveSince?: number;
}
export type EnablementTimesMap = Record<string, EnablementTimes>;

export async function getEnablementTimes(): Promise<EnablementTimesMap> {
  return (await getRaw<EnablementTimesMap>(ENABLEMENT_TIMES_KEY)) ?? {};
}

// The time for one enable change. Strictly later than this context's
// previous one, so two writes in one millisecond can't look like one
// change: the restore on collection-off (script-enablement.ts) matches
// times exactly.
let lastEnablementStamp = 0;
function nextEnablementStamp(): number {
  lastEnablementStamp = Math.max(Date.now(), lastEnablementStamp + 1);
  return lastEnablementStamp;
}

// Record one copy's change in `times` (a copy the caller owns): became
// active, went inactive, or (`restarted`) stays active but is stamped as
// becoming active now. Returns whether anything changed.
function stampTimes(
  times: EnablementTimesMap,
  id: string,
  wasActive: boolean,
  nowActive: boolean,
  at: number,
  restarted = false,
): boolean {
  if (nowActive && (!wasActive || restarted)) {
    times[id] = { ...times[id], activeSince: at };
    return true;
  }
  if (wasActive && !nowActive) {
    times[id] = { ...times[id], inactiveSince: at };
    return true;
  }
  return false;
}

// Drop active times kept for scripts that no longer exist. A removal
// drops its rows' times in the same write, so these are left from
// before only the worker wrote, when a removal in a page could race
// another context's write of the times back in. `live` is a scan of
// the script rows; an id missing from it is re-checked inside the lock,
// so a row added since the scan keeps its times.
async function pruneEnablementTimes(live: ReadonlySet<string>): Promise<void> {
  const stale = Object.keys(await getEnablementTimes()).filter((id) => !live.has(id));
  if (stale.length === 0) return;
  await mutate(async () => {
    const got = await getRows([...stale.map(scriptKey), ENABLEMENT_TIMES_KEY]);
    const times = { ...(got[ENABLEMENT_TIMES_KEY] as EnablementTimesMap | undefined) };
    const gone = stale.filter((id) => !got[scriptKey(id)] && times[id]);
    if (gone.length === 0) return;
    for (const id of gone) delete times[id];
    await writeLocal({ [ENABLEMENT_TIMES_KEY]: times });
  });
}

// The active-times write that forgets `ids` (rows being removed), or
// nothing when none of them has times. Called inside the removal's lock.
async function withoutTimes(ids: readonly string[]): Promise<Record<string, unknown>> {
  const times = await getEnablementTimes();
  if (!ids.some((id) => times[id])) return {};
  const next = { ...times };
  for (const id of ids) delete next[id];
  return { [ENABLEMENT_TIMES_KEY]: next };
}

// Every enable write goes through here: the flags and the active times
// land together in ONE storage write, so one change fires one
// `storage.onChanged` and one registration sync. Each copy whose active
// state the change flips is stamped with the same time
// (`nextEnablementStamp`); a copy whose state stays put is left alone.
// Only script rows whose own flag changes are rewritten.
//
// Returns the collection as written (null when it's gone, or none was
// asked for) and every script row whose flag it changed.
//
// `timer` is the caller's, when it timed its own steps first; the
// write's steps are added to it and the caller prints the line.
// Otherwise the write prints its own `enablement write` line.
export async function writeEnablement(
  w: EnablementWrite,
  timer?: PhaseTimer,
): Promise<EnablementResult> {
  const t = timer ?? startPhaseTimer('enablement write');
  const result = await mutate(async () => {
    t.mark('lock wait');
    return applyEnablement(w, t);
  });
  if (!timer) t.done();
  return result;
}

// The collection as written (null when it's gone, or none was asked
// for) and every script row whose flag the write changed.
export interface EnablementResult {
  collection: StoredCollection | null;
  scripts: ScriptMeta[];
}

// The rows an enable plan is computed from (see `writeEnablementFrom`).
export interface EnablementRows {
  scripts: ScriptMeta[];
  collections: StoredCollection[];
  times: EnablementTimesMap;
}

// An enable write whose changes depend on the store: which other copies
// are active, which ones a collection displaced. `plan` decides them
// inside the lock, from `scriptIds` and `collectionIds` (plus each of
// those scripts' collections) as they are at that moment, so a write
// that landed while this one waited is part of what it sees. Planned
// outside the lock, two quick clicks on two copies each saw the other
// as off, and both stayed on.
//
// The caller picks the ids from a read made before the lock, and only
// those are re-read: a full read here would hold the lock (and every
// other write in this context) for as long as it takes. A copy that
// appears between the two reads is missed, which needs an install to
// land at that moment.
//
// `plan` returning null writes nothing.
export async function writeEnablementFrom(
  scope: { scriptIds: Iterable<string>; collectionIds?: Iterable<string> },
  plan: (rows: EnablementRows) => EnablementWrite | null,
  timer?: PhaseTimer,
): Promise<EnablementResult> {
  const t = timer ?? startPhaseTimer('enablement write');
  const result = await mutate(async () => {
    t.mark('lock wait');
    const ids = [...new Set(scope.scriptIds)];
    const got = await getRows([...ids.map(scriptKey), ENABLEMENT_TIMES_KEY]);
    const scripts = ids
      .map((id) => got[scriptKey(id)] as ScriptMeta | undefined)
      .filter((s): s is ScriptMeta => s != null);
    const collIds = [...new Set([...(scope.collectionIds ?? []), ...scripts.map((s) => s.collectionId)])];
    const colls = await getRows(collIds.map(collectionKey));
    t.mark('re-read', () => storageSize({ ...got, ...colls }));
    const w = plan({
      scripts,
      collections: collIds
        .map((id) => colls[collectionKey(id)] as StoredCollection | undefined)
        .filter((c): c is StoredCollection => c != null),
      times: (got[ENABLEMENT_TIMES_KEY] as EnablementTimesMap | undefined) ?? {},
    });
    t.mark('plan');
    return w ? applyEnablement(w, t) : { collection: null, scripts: [] };
  });
  if (!timer) t.done();
  return result;
}

// The body of an enable write. Caller holds the lock.
async function applyEnablement(w: EnablementWrite, t: PhaseTimer): Promise<EnablementResult> {
  const at = nextEnablementStamp();
  const toSet: Record<string, unknown> = {};
  let collection: StoredCollection | null = null;
  const scriptIds = new Set<string>([...(w.scripts ?? []).map((u) => u.id), ...(w.started ?? [])]);
  if (w.collection) {
    collection = (await getRow<StoredCollection>(collectionKey(w.collection.id))) ?? null;
    t.mark('read collection');
    if (collection) {
      // Its scripts' active state follows its flag, so they may need
      // stamping even though none of their own flags change.
      for (const sid of collection.scriptIds) scriptIds.add(sid);
      collection = { ...collection, enabled: w.collection.enabled };
      toSet[collectionKey(collection.id)] = collection;
    }
  }
  // The rows as stored: an enable change rewrites a script's small row
  // and leaves its bodies alone.
  const got = await getRows([...[...scriptIds].map(scriptKey), ENABLEMENT_TIMES_KEY]);
  t.mark('read rows', () => storageSize(got));
  const scripts = [...scriptIds]
    .map((sid) => got[scriptKey(sid)] as ScriptMeta | undefined)
    .filter((s): s is ScriptMeta => s != null);
  const times: EnablementTimesMap = { ...(got[ENABLEMENT_TIMES_KEY] as EnablementTimesMap | undefined) };
  // Each script's collection, before and after this write.
  const collIds = [...new Set(scripts.map((s) => s.collectionId))];
  const colls = await getRows(collIds.map(collectionKey));
  t.mark('read collections', () => storageSize(colls));
  const collOn = (cid: string, after: boolean): boolean => {
    if (after && collection && cid === collection.id) return isCollectionEnabled(collection);
    const c = colls[collectionKey(cid)] as StoredCollection | undefined;
    return c ? isCollectionEnabled(c) : true;
  };
  const wanted = new Map((w.scripts ?? []).map((u) => [u.id, u.enabled]));
  const started = new Set(w.started ?? []);
  const written: ScriptMeta[] = [];
  let timesChanged = false;
  for (const script of scripts) {
    const flag = wanted.get(script.id) ?? isScriptEnabled(script);
    const wasActive = isScriptEnabled(script) && collOn(script.collectionId, false);
    const nowActive = flag && collOn(script.collectionId, true);
    if (stampTimes(times, script.id, wasActive, nowActive, at, started.has(script.id))) timesChanged = true;
    if (script.enabled === flag) continue;
    const next: ScriptMeta = { ...script, enabled: flag };
    toSet[scriptKey(script.id)] = next;
    written.push(next);
  }
  if (timesChanged) toSet[ENABLEMENT_TIMES_KEY] = times;
  if (Object.keys(toSet).length > 0) {
    await writeLocal(toSet);
    t.mark('write', () => storageSize(toSet));
  }
  return { collection, scripts: written };
}

// The per-collection settings the collection dialog edits.
export interface CollectionOptions {
  // The name shown everywhere. For a scripts collection it is required
  // and must be unique; for a location collection blank means "back to
  // the name inferred from the path".
  displayName?: string;
  // Per-collection opt-out of local stand-ins. Writing the field only —
  // nothing is refetched here, because the flag changes what the NEXT
  // refresh resolves to, and the collections page follows a change with
  // its own Refresh so the user sees the effect immediately.
  localFiles?: boolean;
}

export async function setCollectionOptions(
  id: string,
  options: CollectionOptions,
): Promise<StoredCollection | null> {
  return mutate(async () => {
    const collection = await getRaw<StoredCollection>(collectionKey(id));
    if (!collection) return null;
    const next: StoredCollection = { ...collection };
    if (options.displayName !== undefined) {
      const name = options.displayName.trim();
      const inferred = inferDisplayName(collection.path);
      if (!name && !inferred) throw new Error(COLLECTION_NAME_REQUIRED);
      // Same rule as `createLocationCollection`: only a name the user
      // chose is held unique; the inferred one may collide.
      if (name && name !== inferred) {
        // The default that already owns a reserved name is exempt — it
        // keeps it — but nothing else may take it.
        if (!mayUseReservedName(name, collection.path)) throw new Error(RESERVED_COLLECTION_NAME);
        const all = await getCollections();
        if (collectionNameInUse(name, all, id)) throw new Error(collectionNameInUseMessage(name));
      }
      next.displayName = name || inferred;
    }
    if (options.localFiles !== undefined) next.localFiles = options.localFiles;
    await writeLocal({ [collectionKey(id)]: next });
    return next;
  });
}

// Test-surface convenience; the dialog goes through `setCollectionOptions`.
export async function setCollectionLocalFiles(
  id: string,
  localFiles: boolean,
): Promise<StoredCollection | null> {
  return setCollectionOptions(id, { localFiles });
}

// Record what a script's upstream `@updateURL` / `@downloadURL` last
// claimed. Separate from every refresh entry point on purpose: a probe
// annotates, it never changes what runs, so this touches exactly one
// field and leaves `status`, `refreshError`, and the body alone.
//
// The caller is expected to have already decided a probe was due (see
// `probesAreFresh` and `ProbePolicy`), so this always writes: the
// refreshed `checkedAt` is what stops the next check from probing
// again. Every write costs a storage.onChanged, and thus a userscript
// re-registration pass in the background SW — so the only thing
// keeping that off the per-navigation and per-reload paths is the
// caller's staleness gate. Don't hand this a probe you didn't pace.
//
// Passing an empty list clears the field, which is how a script that
// dropped its `@updateURL` sheds a stale annotation.
export async function setVersionProbes(
  id: string,
  probes: VersionProbe[],
): Promise<ScriptMeta | null> {
  return mutate(async () => {
    const script = await getRow<ScriptMeta>(scriptKey(id));
    if (!script) return null;
    if (probes.length === 0 && !script.versionProbes) return script;
    const next: ScriptMeta = { ...script };
    if (probes.length > 0) next.versionProbes = probes;
    else delete next.versionProbes;
    await writeLocal({ [scriptKey(id)]: next });
    return next;
  });
}

export async function setScriptEnabled(
  id: string,
  enabled: boolean,
): Promise<ScriptMeta | null> {
  const { scripts } = await writeEnablement({ scripts: [{ id, enabled }] });
  return scripts[0] ?? (await getScriptMeta(id)) ?? null;
}

// Flip many scripts' enabled flags in a single storage write. This is
// the bulk-toggle path: it fires exactly one `storage.onChanged` event
// (instead of N), so the background SW's syncRegistrations runs once
// instead of once per script — turning a 15-script toggle from
// quadratic-feeling into a single round-trip.
export async function setScriptsEnabled(
  updates: { id: string; enabled: boolean }[],
  timer?: PhaseTimer,
): Promise<void> {
  if (updates.length === 0) return;
  await writeEnablement({ scripts: updates }, timer);
}
