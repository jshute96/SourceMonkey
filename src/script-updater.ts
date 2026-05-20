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
// second pass. This is the property that makes "one updater for
// everything" actually work: there's never more than one fetch + write
// for the same script/source at the same time, regardless of what
// triggered it.
//
// We deliberately don't try to mark tabs stale from here. The actual
// stale propagation happens via chrome.storage.onChanged in
// background.ts so that ANY write that changes a script's content
// (this module, external tools poking storage, future paths we haven't
// imagined) triggers the same propagation.

import {
  getScript,
  getSources,
  getSourceWithScripts,
  refreshAllSources,
  refreshScript,
  refreshSource,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { dlog } from './debug-log.js';
import { getScriptLogLabel } from './script-log-id.js';

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
  checkLog(`[VibeMonkey] update check (${mode}): ${label}`);
  let next: StoredScript | null;
  try {
    next = await refreshScript(scriptId);
  } catch (err) {
    console.info(`[VibeMonkey] update check failed: ${label}: ${describe(err)}`);
    throw err;
  }
  logScriptOutcome(label, prior, next, mode);
  return next;
}

async function runSourceCheck(
  sourceId: string,
  mode: UpdateMode,
): Promise<{ source: StoredSource; scripts: StoredScript[] } | null> {
  const prior = await getSourceWithScripts(sourceId);
  const priorBy = new Map((prior?.scripts ?? []).map((s) => [s.id, s]));
  const label = prior?.source.path ?? sourceId;
  console.log(`[VibeMonkey] source refresh (${mode}): ${label}`);
  let result: { source: StoredSource; scripts: StoredScript[] } | null;
  try {
    result = await refreshSource(sourceId);
  } catch (err) {
    console.info(`[VibeMonkey] source refresh failed: ${label}: ${describe(err)}`);
    throw err;
  }
  if (result) summarizeSourceOutcome(label, priorBy, result.scripts);
  return result;
}

async function runAllSourcesCheck(
  mode: UpdateMode,
): Promise<Map<string, { source: StoredSource; scripts: StoredScript[] }>> {
  console.log(`[VibeMonkey] refreshing all sources (${mode})`);
  // Snapshot priors BEFORE the refresh; reading after would just give
  // back the post-refresh state and the summary would always say 0
  // updated / 0 added.
  const priorBySourceId = await snapshotAllSourceScripts();
  const result = await refreshAllSources();
  for (const [, { source, scripts }] of result) {
    const priorBy = priorBySourceId.get(source.id) ?? new Map();
    summarizeSourceOutcome(source.path, priorBy, scripts);
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
    console.info(`[VibeMonkey] update check: ${label}: row vanished`);
    return;
  }
  if (next.status === 'error') {
    console.info(`[VibeMonkey] update check: ${label}: error — ${next.errorMessage ?? 'unknown'}`);
    return;
  }
  if (!prior || prior.loadedAt !== next.loadedAt) {
    // loadedAt bumps iff the load pipeline actually built from fresh
    // content. Same loadedAt means the size+mtime skip caught it.
    const size = next.size != null ? ` (${formatBytes(next.size)})` : '';
    console.log(`[VibeMonkey] loaded new content: ${label}${size}`);
  } else {
    // "no change" pairs with the entry log: visible on manual, gated
    // on opportunistic. Otherwise a Refresh click could log "update
    // check" with nothing following.
    const outcomeLog = mode === 'manual' ? console.log : dlog;
    outcomeLog(`[VibeMonkey] no change: ${label}`);
  }
}

function summarizeSourceOutcome(
  label: string,
  priorBy: Map<string, StoredScript>,
  nextScripts: StoredScript[],
): void {
  let changed = 0;
  let added = 0;
  let unchanged = 0;
  let errored = 0;
  for (const n of nextScripts) {
    const prior = priorBy.get(n.id);
    if (n.status === 'error') { errored++; continue; }
    if (!prior) { added++; continue; }
    if (prior.loadedAt !== n.loadedAt) changed++;
    else unchanged++;
  }
  const parts: string[] = [`${nextScripts.length} script(s)`];
  if (added) parts.push(`${added} new`);
  if (changed) parts.push(`${changed} updated`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (errored) parts.push(`${errored} error`);
  console.log(`[VibeMonkey] source refresh: ${label}: ${parts.join(', ')}`);
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
