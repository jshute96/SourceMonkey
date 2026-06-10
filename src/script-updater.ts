// Single entry point for every userscript refresh path.
//
// Two trigger modes share the same underlying work (refreshScript /
// refreshSource / refreshAllSources in script-store.ts):
//
//   - 'manual'        — the user clicked a Refresh button. Always runs.
//                       Awaited by the caller so the UI can show a
//                       spinner and react to the result.
//   - 'opportunistic' — the SW noticed a page that uses some scripts
//                       and wants to check whether their source files
//                       changed on disk. Fire-and-forget. Rate-limited
//                       to no sooner than UPDATE_MIN_INTERVAL_MS after
//                       the previous completion, and never concurrent
//                       for the same resource.
//
// In both modes a check that's currently in flight for a resource is
// shared — a manual click that lands while an opportunistic check is
// already running awaits that existing promise instead of starting a
// second pass. This holds PER gate key: the script gate
// (`updateScript`), the source gate (`updateSource`), and the
// all-sources gate (`updateAllSources`) are independent maps, so an
// opportunistic `updateScript(X)` can still run alongside a manual
// `updateSource(S⊇X)` or `updateAllSources` that also rebuilds X. They
// fetch the same bytes, and their storage writes are serialized and
// re-read user-owned state by `script-store.ts`'s `mutate()` lock (see
// docs/storage.md "Write serialization"), so the overlap is idempotent
// rather than corrupting — but it is NOT deduped to a single fetch.
//
// We deliberately don't try to mark tabs stale from here. The actual
// stale propagation happens via chrome.storage.onChanged in
// background.ts so that ANY write that changes a script's content
// (this module, external tools poking storage, future paths we haven't
// imagined) triggers the same propagation.

import {
  getAllScripts,
  getScript,
  getSources,
  getSourceWithScripts,
  refreshAllSources,
  refreshScript,
  refreshSource,
  type StartupLog,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { dlog } from './debug-log.js';
import { githubTokenLogSuffix } from './github-auth.js';
import { getScriptLogLabel } from './script-log-id.js';
import { getScriptLog, logScriptEvent } from './script-log.js';

export type UpdateMode = 'manual' | 'opportunistic';

// Minimum gap between opportunistic checks for the same resource. The
// 10s figure is a balance: short enough that a user editing a script
// and switching tabs sees the update within a click or two, long
// enough that the background work doesn't measurably affect navigation.
export const UPDATE_MIN_INTERVAL_MS = 10_000;

type Resource = string; // arbitrary key — see resource* helpers below

export interface GateSlot<T> {
  inFlight?: { promise: Promise<T> };
  lastCompletedAt?: number;
}

// Allow tests to swap the clock. Production uses Date.now.
let nowMsImpl: () => number = () => Date.now();
export function _setNowForTests(fn: () => number): void {
  nowMsImpl = fn;
}

// Pure-ish core: run `task` if and only if there isn't one already in
// flight for this resource, and (for opportunistic mode) the cooldown
// has elapsed. Returns the active promise either way. The state Map is
// mutated in place; callers pass in a stable per-resource-type map so
// independent resources can run concurrently.
//
// Exported so tests can exercise the concurrency/rate-limit logic
// without touching chrome.storage.
export function gate<T>(
  state: Map<Resource, GateSlot<T>>,
  key: Resource,
  mode: UpdateMode,
  task: () => Promise<T>,
  skipResult: T,
): Promise<T> {
  let slot = state.get(key);
  if (!slot) {
    slot = {};
    state.set(key, slot);
  }
  // Coalesce onto any in-flight work for this resource regardless of
  // mode. A manual click during a background check shouldn't start a
  // second fetch; it should wait for the running one.
  if (slot.inFlight) return slot.inFlight.promise;
  if (mode === 'opportunistic') {
    const last = slot.lastCompletedAt ?? 0;
    if (nowMsImpl() - last < UPDATE_MIN_INTERVAL_MS) {
      return Promise.resolve(skipResult);
    }
  }
  const promise = (async () => {
    try {
      return await task();
    } finally {
      const s = state.get(key);
      if (s) {
        s.inFlight = undefined;
        s.lastCompletedAt = nowMsImpl();
      }
    }
  })();
  slot.inFlight = { promise };
  return promise;
}

// Separate maps per result type so type inference stays clean.
const scriptState = new Map<Resource, GateSlot<StoredScript | null>>();
const sourceState = new Map<Resource, GateSlot<{ source: StoredSource; scripts: StoredScript[] } | null>>();
const allSourcesState = new Map<Resource, GateSlot<unknown>>();

// "all sources" is one global slot, but reuse the same shape so the
// concurrency/rate-limit logic stays uniform.
const ALL_SOURCES_KEY = '*';

// Public API ---------------------------------------------------------

export function updateScript(
  scriptId: string,
  mode: UpdateMode,
): Promise<StoredScript | null> {
  return gate(scriptState, scriptId, mode, () => runScriptCheck(scriptId, mode), null);
}

export function updateSource(
  sourceId: string,
  mode: UpdateMode,
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  return gate(sourceState, sourceId, mode, () => runSourceCheck(sourceId, mode), null);
}

export function updateAllSources(
  mode: UpdateMode,
): Promise<Map<string, { source: StoredSource; scripts: StoredScript[] }>> {
  // We have to do the cast dance because gate is generic over a single
  // result type and the skip result for "no work done" is just an empty
  // map, not null.
  return gate<unknown>(
    allSourcesState,
    ALL_SOURCES_KEY,
    mode,
    () => runAllSourcesCheck(mode) as Promise<unknown>,
    new Map(),
  ) as Promise<Map<string, { source: StoredSource; scripts: StoredScript[] }>>;
}

// ---------- Task wrappers that log lifecycle to the SW console -------
//
// Each user-visible check goes through these so the SW console tells
// the story: "checking X", then either "no change", "loaded new
// content", or "failed: <err>". Without this it's hard to tell
// whether the opportunistic refresh is even running.
//
// We do a getScript / getSourceWithScripts read BEFORE the refresh so
// we have the prior loadedAt to compare against the post-refresh row.
// One extra storage read per check — cheap.

// `@require` + `@resource` policy by trigger mode. Manual clicks
// rebuild deps from scratch so users can pick up remote updates
// without touching the main script. Opportunistic background checks
// preserve the cached entries verbatim and only fetch newly-declared
// refs — keeping page-load cost bounded.
function fileRecheckMode(mode: UpdateMode): 'all' | 'preserve' {
  return mode === 'manual' ? 'all' : 'preserve';
}

async function runScriptCheck(
  scriptId: string,
  mode: UpdateMode,
): Promise<StoredScript | null> {
  const prior = await getScript(scriptId);
  const label = getScriptLogLabel(scriptId);
  // Manual checks fire on a deliberate user click and are infrequent;
  // their start + "no change" outcome stays at console.log so the user
  // gets unconditional confirmation that the click did something.
  // Opportunistic checks fire on every navigation and are gated by the
  // debug flag.
  const checkLog = mode === 'manual' ? console.log : dlog;
  const tokenSuffix = prior?.fileUrl ? githubTokenLogSuffix(prior.fileUrl) : '';
  checkLog(`[SourceMonkey] update check (${mode}): ${label}${tokenSuffix}`);
  logScriptEvent(scriptId, {
    level: 'info',
    source: `refresh-${mode}`,
    message: `update check started`,
  });
  let next: StoredScript | null;
  try {
    next = await refreshScript(scriptId, { recheckFiles: fileRecheckMode(mode) });
  } catch (err) {
    const msg = describe(err);
    console.info(`[SourceMonkey] update check failed: ${label}: ${msg}`);
    logScriptEvent(scriptId, {
      level: 'error',
      source: `refresh-${mode}`,
      message: `update check threw: ${msg}`,
    });
    throw err;
  }
  logScriptOutcome(label, prior, next, mode);
  emitScriptOutcomeLog(scriptId, prior, next, mode);
  return next;
}

async function runSourceCheck(
  sourceId: string,
  mode: UpdateMode,
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  const prior = await getSourceWithScripts(sourceId);
  const priorBy = new Map((prior?.scripts ?? []).map((s) => [s.id, s]));
  const label = prior?.source.path ?? sourceId;
  // Suffix the start line with "(with GitHub token)" when the source
  // URL would carry the GitHub auth header on fetch. Lets the user
  // confirm from the SW console that their Options-page token is
  // actually in play for this source (otherwise a silent "still
  // hitting unauthenticated rate limits" is hard to diagnose).
  const tokenSuffix = prior?.source.path ? githubTokenLogSuffix(prior.source.path) : '';
  console.log(`[SourceMonkey] source refresh (${mode}): ${label}${tokenSuffix}`);
  let result: { source: StoredSource; scripts: StoredScript[] } | null;
  try {
    result = await refreshSource(sourceId, { recheckFiles: fileRecheckMode(mode) });
  } catch (err) {
    console.info(`[SourceMonkey] source refresh failed: ${label}: ${describe(err)}`);
    throw err;
  }
  if (result) summarizeSourceOutcome(label, priorBy, result.scripts, mode);
  return result;
}

async function runAllSourcesCheck(
  mode: UpdateMode,
): Promise<Map<string, { source: StoredSource; scripts: StoredScript[] }>> {
  console.log(`[SourceMonkey] refreshing all sources (${mode})`);
  // Snapshot priors BEFORE the refresh; reading after would just give
  // back the post-refresh state and the summary would always say 0
  // updated / 0 added.
  const priorBySourceId = await snapshotAllSourceScripts();
  const result = await refreshAllSources({ recheckFiles: fileRecheckMode(mode) });
  for (const [, { source, scripts }] of result) {
    const priorBy = priorBySourceId.get(source.id) ?? new Map();
    summarizeSourceOutcome(source.path, priorBy, scripts, mode);
  }
  return result;
}

async function snapshotAllSourceScripts(): Promise<Map<string, Map<string, StoredScript>>> {
  const sources = await getSources();
  const entries = await Promise.all(sources.map(async (s) => {
    const data = await getSourceWithScripts(s.id);
    const byId = new Map((data?.scripts ?? []).map((sc) => [sc.id, sc]));
    return [s.id, byId] as const;
  }));
  return new Map(entries);
}

// ---------- Logging helpers ----------

function logScriptOutcome(
  label: string,
  prior: StoredScript | undefined,
  next: StoredScript | null,
  mode: UpdateMode,
): void {
  if (!next) {
    console.info(`[SourceMonkey] update check: ${label}: row vanished`);
    return;
  }
  if (next.status === 'invalid') {
    console.info(`[SourceMonkey] update check: ${label}: invalid — ${next.errorMessage ?? 'unknown'}`);
    return;
  }
  // Refresh failed but the cached good copy keeps running. Log once on
  // the transition (or when the reason changes) so a source that stays
  // down doesn't spam the console on every opportunistic check.
  if (next.refreshError && prior?.refreshError !== next.refreshError) {
    console.info(`[SourceMonkey] refresh failed: ${label}: ${next.refreshError}`);
    return;
  }
  if (!prior || prior.loadedAt !== next.loadedAt) {
    // loadedAt bumps iff the load pipeline actually built from fresh
    // content. Same loadedAt means the size+mtime skip caught it.
    const size = next.size != null ? ` (${formatBytes(next.size)})` : '';
    console.log(`[SourceMonkey] loaded new content: ${label}${size}`);
  } else {
    // "no change" pairs with the entry log: visible on manual, gated
    // on opportunistic. Otherwise a Refresh click could log "update
    // check" with nothing following.
    const outcomeLog = mode === 'manual' ? console.log : dlog;
    outcomeLog(`[SourceMonkey] no change: ${label}`);
  }
}

// Append a structured per-script log entry mirroring the SW-console
// outcome line. Skipped for unchanged-state opportunistic checks so the
// log doesn't fill with thousands of "no change" rows from background
// polling — those still get debug-gated console output via dlog.
function emitScriptOutcomeLog(
  scriptId: string,
  prior: StoredScript | undefined,
  next: StoredScript | null,
  mode: UpdateMode,
): void {
  if (!next) {
    logScriptEvent(scriptId, {
      level: 'warning',
      source: `refresh-${mode}`,
      message: 'row vanished during refresh',
    });
    return;
  }
  if (next.status === 'invalid') {
    logScriptEvent(scriptId, {
      level: 'error',
      source: `refresh-${mode}`,
      message: next.errorMessage ?? 'unknown error',
    });
    return;
  }
  if (next.status === 'missing' && prior?.status !== 'missing') {
    // Surface the vanished-file transition once into the Log tab so
    // users opening a MISSING row's logs see why it's flagged. Repeat
    // refreshes against an already-missing row stay quiet.
    logScriptEvent(scriptId, {
      level: 'error',
      source: `refresh-${mode}`,
      message: next.errorMessage ?? 'source file is missing',
    });
    return;
  }
  if (next.refreshError && prior?.refreshError !== next.refreshError) {
    // The refresh failed but the cached good copy keeps running. Record
    // it at warning level (the script isn't broken, just stale). Only on
    // the transition / reason change, so a persistently-down source
    // doesn't flood the Log tab from background polling.
    logScriptEvent(scriptId, {
      level: 'warning',
      source: `refresh-${mode}`,
      message: `refresh failed: ${next.refreshError}`,
    });
    return;
  }
  if (!prior || prior.loadedAt !== next.loadedAt) {
    const size = next.size != null ? ` (${formatBytes(next.size)})` : '';
    logScriptEvent(scriptId, {
      level: 'info',
      source: `refresh-${mode}`,
      message: `loaded new content${size}`,
    });
    // Replay parse-time diagnostics whenever a new version lands. They
    // appear AFTER the "loaded new content" line so it's clear which
    // version the warning belongs to. One entry per content version —
    // a refresh that doesn't change content adds nothing.
    for (const entry of next.startupLogs ?? []) {
      logScriptEvent(scriptId, {
        level: startupLogLevelToLogLevel(entry.level),
        source: 'parser',
        message: entry.message,
      });
    }
    return;
  }
  if (mode === 'manual') {
    logScriptEvent(scriptId, {
      level: 'info',
      source: `refresh-${mode}`,
      message: 'no change',
    });
  }
}

// Map a StartupLog level (page-console-flavored: log/info/warn/error)
// to the per-script LogEntry level (info/warning/error). 'log' and
// 'info' both land as 'info' because the Log tab doesn't render a
// separate 'log' level.
function startupLogLevelToLogLevel(level: StartupLog['level']): 'info' | 'warning' | 'error' {
  if (level === 'warn') return 'warning';
  if (level === 'error') return 'error';
  return 'info';
}

// Sentinel key in chrome.storage.session that records "we've already
// replayed startup logs for THIS Chrome session." session storage is
// cleared on Chrome shutdown, so a fresh Chrome session always misses
// the sentinel; SW restarts within a session always hit it.
const BOOT_REPLAY_SENTINEL_KEY = 'sm:startup-logs-replayed-at';

// Surface parse-time diagnostics into the Log tab once per Chrome
// session, at SW startup. Without this, a fresh Chrome session sees
// an empty Log tab even when storage.local already has scripts whose
// `startupLogs` were computed in a prior session — the user would
// have to manually refresh each script to see the warnings again.
//
// The sentinel makes it idempotent: SW restarts within the same
// Chrome session bail out immediately. The replay itself reuses the
// same `parser`-source log line format as the refresh path so the
// Log tab is visually uniform.
export async function replayStartupLogsAtBoot(): Promise<void> {
  const got = await chrome.storage.session.get(BOOT_REPLAY_SENTINEL_KEY);
  if (got[BOOT_REPLAY_SENTINEL_KEY]) return;
  await chrome.storage.session.set({ [BOOT_REPLAY_SENTINEL_KEY]: Date.now() });

  // Single chrome.storage.local.get(null) scan via getAllScripts —
  // cheaper than per-source reads when most scripts won't have
  // diagnostics anyway.
  for (const script of await getAllScripts()) {
    await ensureStartupLogsInLogTab(script);
  }
}

// Append any of `script.startupLogs` that aren't already present in
// the per-script Log tab as a `parser`-source row. The existence
// check protects against the cold-boot race where an opportunistic
// refresh fires concurrently with `replayStartupLogsAtBoot` — if the
// refresh path already wrote the same parser row this turn, replay
// sees it and skips.
//
// Residual race: if replay emits first and then a refresh for the
// same content version fires, the refresh path will still write a
// duplicate row (it doesn't consult existing entries). Bounded to at
// most one extra row per script per Chrome session and only triggers
// when content actually changed on disk between Chrome shutdown and
// the user's first navigation after restart.
async function ensureStartupLogsInLogTab(script: StoredScript): Promise<void> {
  const logs = script.startupLogs ?? [];
  if (logs.length === 0) return;
  const existing = await getScriptLog(script.id);
  const seenParserMessages = new Set<string>();
  for (const entry of existing) {
    if (entry.source === 'parser') seenParserMessages.add(entry.message);
  }
  for (const sl of logs) {
    if (seenParserMessages.has(sl.message)) continue;
    logScriptEvent(script.id, {
      level: startupLogLevelToLogLevel(sl.level),
      source: 'parser',
      message: sl.message,
    });
  }
}

function summarizeSourceOutcome(
  label: string,
  priorBy: Map<string, StoredScript>,
  nextScripts: StoredScript[],
  mode: UpdateMode = 'manual',
): void {
  let changed = 0;
  let added = 0;
  let unchanged = 0;
  let errored = 0;
  let refreshFailed = 0;
  for (const n of nextScripts) {
    const prior = priorBy.get(n.id);
    emitScriptOutcomeLog(n.id, prior, n, mode);
    if (n.status === 'invalid') { errored++; continue; }
    // A still-running row whose latest refresh failed counts as its own
    // bucket, not "unchanged" — the content is unchanged but the outcome
    // wasn't a clean check.
    if (n.refreshError) { refreshFailed++; continue; }
    if (!prior) { added++; continue; }
    if (prior.loadedAt !== n.loadedAt) changed++;
    else unchanged++;
  }
  const parts: string[] = [`${nextScripts.length} script(s)`];
  if (added) parts.push(`${added} new`);
  if (changed) parts.push(`${changed} updated`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (refreshFailed) parts.push(`${refreshFailed} refresh-failed`);
  if (errored) parts.push(`${errored} error`);
  console.log(`[SourceMonkey] source refresh: ${label}: ${parts.join(', ')}`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Convenience: kick off opportunistic checks for a batch of script IDs
// without awaiting. Each id gates independently; ids whose check is
// rate-limited or already in flight are dropped silently. Used by the
// background SW when a navigation matches one or more scripts.
export function requestOpportunisticScriptChecks(scriptIds: string[]): void {
  for (const id of scriptIds) {
    // Swallow rejections — opportunistic work shouldn't ever surface a
    // user-visible error; the failure was already logged by the fetch.
    updateScript(id, 'opportunistic').catch(() => {});
  }
}

// Test/debug hook so tests can reset the rate-limiter without
// timing-mock gymnastics.
export function _resetUpdaterStateForTests(): void {
  scriptState.clear();
  sourceState.clear();
  allSourcesState.clear();
}
