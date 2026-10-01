// The service worker's side of sm-dev, the development tool: which tabs
// an sm-dev run controls (tab claims), and the events it streams to the
// runs. Design: docs/sm-dev-extension.md.
//
// Claims:
// - A claim names the run that controls a tab, and which of the
//   extension's scripts may run there: none for a harness run (it runs
//   the scripts itself), only the run's scratch scripts for an extension
//   run. `handleCheckPending` (background.ts) answers `skip` for the rest.
// - Per tab, not per document: it holds across reloads and navigations.
// - A lease: the run renews it, and an expired claim counts as gone, so
//   a killed run can't leave the person's tab running no scripts.
// - Kept in `chrome.storage.session` as well as memory, so a worker that
//   Chrome stopped while idle answers the same after it starts again.
//
// Events:
// - Each live run subscribes; while any does, events are written to the
//   worker's console as `console.debug(SM_DEV_EVENT, json)`, where
//   Playwright reports them to the run. Without a subscriber nothing is
//   written.
// - A subscription is a lease too, renewed with the run's claims. It
//   lives in memory only: a restarted worker has none, and the run
//   subscribes again when it sees the new worker.

/** The first argument of every event's console line. */
export const SM_DEV_EVENT = 'sm-dev-event';

/** The reason a skipped wrapper reports for a tab an sm-dev run controls. */
export const SKIP_REASON_SM_DEV = 'tab controlled by sm-dev';

export interface SmDevClaim {
  runId: string;
  /** The script ids that may run in the tab; null for none. */
  allow: string[] | null;
  /**
   * The tab runs none, whatever the run allows: `newtab --noscript`.
   * `renewRun`'s `allow` leaves it alone.
   */
  scriptsOff?: boolean;
  /** When the lease runs out, in epoch ms. */
  expires: number;
}

const CLAIMS_KEY = 'smDevClaims';

const claims = new Map<number, SmDevClaim>();
// Run id → when its event subscription runs out.
const subscribers = new Map<string, number>();

let loading: Promise<void> | null = null;

/**
 * Resolves once the claims kept in session storage are in memory. Called
 * before any answer that depends on them, so a worker that just started
 * can't answer `run` for a claimed tab.
 */
export function claimsReady(): Promise<void> {
  loading ??= (async () => {
    try {
      const got = await chrome.storage.session.get(CLAIMS_KEY);
      const stored = got[CLAIMS_KEY] as Record<string, SmDevClaim> | undefined;
      for (const [tabId, claim] of Object.entries(stored ?? {})) {
        // Ones set in memory meanwhile are newer.
        if (!claims.has(Number(tabId))) claims.set(Number(tabId), claim);
      }
    } catch (err) {
      console.info('[SourceMonkey] could not read the sm-dev tab claims:', err);
    }
  })();
  return loading;
}

function persist(): void {
  const stored: Record<string, SmDevClaim> = {};
  for (const [tabId, claim] of claims) stored[tabId] = claim;
  chrome.storage.session.set({ [CLAIMS_KEY]: stored }).catch((err) => {
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

/** Whether `scriptId` may run in a tab with this claim. */
export function claimAllows(claim: SmDevClaim, scriptId: string): boolean {
  return !claim.scriptsOff && claim.allow !== null && claim.allow.includes(scriptId);
}

export async function claimTab(tabId: number, runId: string, allow: string[] | null, ttlMs: number): Promise<void> {
  await claimsReady();
  claims.set(tabId, { runId, allow, expires: Date.now() + ttlMs });
  persist();
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
 * Extends a run's claims and event subscription by `ttlMs`, and sets
 * which scripts its tabs allow (it changes when a push changes the
 * run's scripts).
 *
 * `tabs` are the tabs the run holds. One whose claim is gone (it ran
 * out while the worker was stopped, or an extension reload cleared the
 * session storage) is claimed again, if the tab is still open. Returns
 * how many were.
 */
export async function renewRun(runId: string, ttlMs: number, allow: string[] | null, tabs: RunTab[] = []): Promise<number> {
  await claimsReady();
  const expires = Date.now() + ttlMs;
  for (const claim of claims.values()) {
    if (claim.runId !== runId) continue;
    claim.expires = expires;
    claim.allow = allow;
  }
  let restored = 0;
  for (const tab of tabs) {
    if (claims.has(tab.tabId)) continue;
    const open = await chrome.tabs.get(tab.tabId).then(() => true, () => false);
    if (!open) continue;
    claims.set(tab.tabId, { runId, allow, expires, ...(tab.scriptsOff ? { scriptsOff: true } : {}) });
    restored++;
  }
  subscribers.set(runId, expires);
  persist();
  return restored;
}

/** Ends a run's claims and its event subscription. */
export async function releaseRun(runId: string): Promise<void> {
  await claimsReady();
  for (const [tabId, claim] of claims) {
    if (claim.runId === runId) claims.delete(tabId);
  }
  subscribers.delete(runId);
  persist();
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
  claims.set(tabId, { ...claim, allow: claim.allow && [...claim.allow] });
  persist();
}

export function dropClaim(tabId: number): void {
  if (claims.delete(tabId)) persist();
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
