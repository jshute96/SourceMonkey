// The service worker's side of sm-dev, the development tool: which tabs
// an sm-dev run controls (tab claims), and the events it streams to the
// runs. Design: docs/sm-dev-extension.md.
//
// Claims:
// - A claim names the run that controls a tab, and whether the run's
//   own scripts run there: the ones in its test collection, for an
//   extension run. A harness run's tabs run none of the extension's (it
//   runs its scripts itself). `handleCheckPending` (background.ts)
//   answers `skip` for the rest.
// - Per tab, not per document: it holds across reloads and navigations.
// - A lease: the run renews it, and an expired claim counts as gone, so
//   a killed run can't leave the person's tab running no scripts.
// - Kept in `chrome.storage.session` as well as memory, so a worker that
//   Chrome stopped while idle answers the same after it starts again.
//
// Runs:
// - Each run has a lease of its own, renewed with its claims, whether
//   or not it holds a tab. A run's test collection outlives the lease
//   by a grace period (`staleRuns`), then the worker removes it: the
//   run crashed or lost its browser connection.
// - Kept in session storage too, like the claims.
//
// Events:
// - Each live run subscribes; while any does, events are written to the
//   worker's console as `console.debug(SM_DEV_EVENT, json)`, where
//   Playwright reports them to the run. Without a subscriber nothing is
//   written.
// - A subscription is a lease too, renewed with the run's claims. It
//   lives in memory only: a restarted worker has none, and the run
//   subscribes again when it sees the new worker.
//
// Live-claim listener:
// - While any claim is live, every wrapper must ask before running its
//   body, since a claim can `skip` a script on any navigation (see
//   `canSkipDecision` in userscript-prelude.js). The listener hears
//   each change, and `claimTab` / `renewRun` wait for it, so a tab's
//   first navigation already runs under the flag.

/** The first argument of every event's console line. */
export const SM_DEV_EVENT = 'sm-dev-event';

/** The reason a skipped wrapper reports for a tab an sm-dev run controls. */
export const SKIP_REASON_SM_DEV = 'tab controlled by sm-dev';

export interface SmDevClaim {
  runId: string;
  /** The run's own scripts (its test collection's) run in the tab; otherwise none do. */
  ownScripts: boolean;
  /** The tab runs none, the run's own included: `newtab --noscript`. */
  scriptsOff?: boolean;
  /** When the lease runs out, in epoch ms. */
  expires: number;
}

const CLAIMS_KEY = 'smDevClaims';
const RUNS_KEY = 'smDevRuns';
const LAST_SWEEP_KEY = 'smDevLastSweep';

/**
 * How long a run's test collection is kept after its lease runs out,
 * in case the run was only stalled.
 */
export const RUN_GRACE_MS = 5 * 60_000;

/**
 * Sweeps come every minute while any test collection exists. A longer
 * gap means the computer slept, or the browser stalled, and sm-dev with
 * it, so the leases that ran out meanwhile say nothing about its runs.
 */
const SWEEP_GAP_MS = 3 * 60_000;

const claims = new Map<number, SmDevClaim>();
// Run id → when its lease runs out.
const runs = new Map<string, number>();
// When `staleRuns` last ran, or 0.
let lastSweep = 0;
// Run id → when its event subscription runs out.
const subscribers = new Map<string, number>();

let loading: Promise<void> | null = null;

let liveListener: ((live: boolean) => Promise<void>) | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Hears whether any claim is live, on every change. One listener. */
export function onClaimsLiveChange(listener: (live: boolean) => Promise<void>): void {
  liveListener = listener;
  // Claims that started loading first reported to no one.
  if (loading) void loading.then(() => reportLive());
}


/**
 * Tells the listener whether any claim is live, and arms a timer for
 * the next lease to run out, since nothing else happens then. The
 * listener ignores a call that changes nothing.
 */
function reportLive(): Promise<void> {
  const now = Date.now();
  let next = Infinity;
  for (const claim of claims.values()) {
    if (claim.expires >= now) next = Math.min(next, claim.expires);
  }
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = next === Infinity ? null : setTimeout(() => void reportLive(), next - now + 1);
  return liveListener ? liveListener(next !== Infinity) : Promise.resolve();
}

/**
 * Resolves once the claims kept in session storage are in memory. Called
 * before any answer that depends on them, so a worker that just started
 * can't answer `run` for a claimed tab.
 */
export function claimsReady(): Promise<void> {
  loading ??= (async () => {
    try {
      const got = await chrome.storage.session.get([CLAIMS_KEY, RUNS_KEY, LAST_SWEEP_KEY]);
      const stored = got[CLAIMS_KEY] as Record<string, SmDevClaim> | undefined;
      for (const [tabId, claim] of Object.entries(stored ?? {})) {
        // Ones set in memory meanwhile are newer.
        if (!claims.has(Number(tabId))) claims.set(Number(tabId), claim);
      }
      const storedRuns = got[RUNS_KEY] as Record<string, number> | undefined;
      for (const [runId, expires] of Object.entries(storedRuns ?? {})) {
        if (!runs.has(runId)) runs.set(runId, expires);
      }
      if (lastSweep === 0 && typeof got[LAST_SWEEP_KEY] === 'number') lastSweep = got[LAST_SWEEP_KEY];
    } catch (err) {
      console.info('[SourceMonkey] could not read the sm-dev tab claims:', err);
    }
    // Not awaited: every check-pending answer waits on `claimsReady`,
    // and must not wait on the registration sync this can start too.
    // The flag itself is set before this returns.
    void reportLive();
  })();
  return loading;
}

function persist(): void {
  const stored: Record<string, SmDevClaim> = {};
  for (const [tabId, claim] of claims) stored[tabId] = claim;
  chrome.storage.session.set({ [CLAIMS_KEY]: stored, [RUNS_KEY]: Object.fromEntries(runs), [LAST_SWEEP_KEY]: lastSweep }).catch((err) => {
    console.info('[SourceMonkey] could not save the sm-dev tab claims:', err);
  });
}

/** The tab's claim, if one is in force. Call after `claimsReady`. */
export function activeClaim(tabId: number): SmDevClaim | null {
  const claim = claims.get(tabId);
  if (!claim) return null;
  if (claim.expires < Date.now()) {
    claims.delete(tabId);
    persist();
    return null;
  }
  return claim;
}

/**
 * Whether a script may run in a tab with this claim. `scriptRun`: the
 * run a scratch script belongs to (`scratchRunOf`), null for any other.
 */
export function claimAllows(claim: SmDevClaim, scriptRun: string | null): boolean {
  return !claim.scriptsOff && claim.ownScripts && scriptRun === claim.runId;
}

export async function claimTab(tabId: number, runId: string, ownScripts: boolean, ttlMs: number): Promise<void> {
  await claimsReady();
  const expires = Date.now() + ttlMs;
  claims.set(tabId, { runId, ownScripts, expires });
  runs.set(runId, Math.max(runs.get(runId) ?? 0, expires));
  persist();
  await reportLive();
}

/** Turns a claimed tab's scripts off, or back on (`open --noscript` / `--script`). */
export async function setTabScriptsOff(tabId: number, off: boolean): Promise<void> {
  await claimsReady();
  const claim = claims.get(tabId);
  if (!claim) return;
  if (off) claim.scriptsOff = true;
  else delete claim.scriptsOff;
  persist();
}

/** A tab a run holds, as the run knows it, for `renewRun` to restore. */
export interface RunTab {
  tabId: number;
  scriptsOff?: boolean;
}

/**
 * Extends a run's lease, claims and event subscription by `ttlMs`.
 *
 * `tabs` are the tabs the run holds. One whose claim is gone (it ran
 * out while the worker was stopped, or an extension reload cleared the
 * session storage) is claimed again, if the tab is still open. Returns
 * how many were. `subscribe`: the run hears the extension's events.
 */
export async function renewRun(runId: string, ttlMs: number, ownScripts: boolean, tabs: RunTab[] = [], subscribe = true): Promise<number> {
  await claimsReady();
  const expires = Date.now() + ttlMs;
  runs.set(runId, expires);
  for (const claim of claims.values()) {
    if (claim.runId === runId) claim.expires = expires;
  }
  let restored = 0;
  for (const tab of tabs) {
    if (claims.has(tab.tabId)) continue;
    const open = await chrome.tabs.get(tab.tabId).then(() => true, () => false);
    if (!open) continue;
    claims.set(tab.tabId, { runId, ownScripts, expires, ...(tab.scriptsOff ? { scriptsOff: true } : {}) });
    restored++;
  }
  // A run that only claims (a harness run) hears no events.
  if (subscribe) subscribers.set(runId, expires);
  persist();
  await reportLive();
  return restored;
}

/**
 * Ends a run's lease, claims and event subscription. The caller removes
 * its test collection.
 */
export async function releaseRun(runId: string): Promise<void> {
  await claimsReady();
  for (const [tabId, claim] of claims) {
    if (claim.runId === runId) claims.delete(tabId);
  }
  runs.delete(runId);
  subscribers.delete(runId);
  persist();
  await reportLive();
}

/**
 * Of the runs that have a test collection, the ones whose collection
 * should go: their lease ran out more than `RUN_GRACE_MS` ago.
 *
 * - A run with no lease on record (one from before the browser
 *   restarted) starts its grace period now.
 * - After a gap since the last sweep (`SWEEP_GAP_MS`), every lease
 *   starts its grace period now instead, and none is stale: a run that
 *   slept with the computer renews again within seconds.
 */
export async function staleRuns(withCollections: string[], now = Date.now()): Promise<string[]> {
  await claimsReady();
  const stale: string[] = [];
  const gap = lastSweep > 0 && now - lastSweep > SWEEP_GAP_MS;
  lastSweep = now;
  for (const runId of withCollections) {
    if (!runs.has(runId)) runs.set(runId, now);
  }
  if (gap) {
    for (const [runId, expires] of runs) runs.set(runId, Math.max(expires, now));
    persist();
    return stale;
  }
  // Every long-gone run is forgotten, one without a collection too (a
  // harness run that was killed).
  for (const [runId, expires] of runs) {
    if (expires + RUN_GRACE_MS >= now) continue;
    runs.delete(runId);
    if (withCollections.includes(runId)) stale.push(runId);
  }
  persist();
  return stale;
}

/**
 * Forgets every claim, lease and subscription, for the e2e tests' reset.
 * Resolves once the wrappers no longer have to ask (the sync that
 * re-registers them), so a live claim can't carry into the next test.
 */
export function resetSmDevLinkForTests(): Promise<void> {
  claims.clear();
  runs.clear();
  subscribers.clear();
  lastSweep = 0;
  return reportLive();
}

/**
 * A tab a claimed tab opened (`window.open`, a link to a new tab) gets
 * its opener's claim. Called from `onCreatedNavigationTarget`, which
 * comes before the new tab's scripts ask: they wait on `claimsReady`
 * too, behind this.
 */
export async function inheritClaim(sourceTabId: number, tabId: number): Promise<void> {
  await claimsReady();
  const claim = activeClaim(sourceTabId);
  if (!claim) return;
  claims.set(tabId, { ...claim });
  persist();
}

export function dropClaim(tabId: number): void {
  if (!claims.delete(tabId)) return;
  persist();
  void reportLive();
}

/** Sends an event to the subscribed runs, if any is live. */
export function emitSmDevEvent(event: Record<string, unknown>): void {
  const now = Date.now();
  let live = false;
  for (const [runId, expires] of subscribers) {
    if (expires < now) subscribers.delete(runId);
    else live = true;
  }
  if (!live) return;
  try {
    console.debug(SM_DEV_EVENT, JSON.stringify({ ...event, at: now }));
  } catch {
    // An event that can't be serialized is dropped.
  }
}
