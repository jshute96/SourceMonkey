// Per-tab script-status model + badge computation.
//
// For each tab we track two views of the world:
//   - `matches` (expected) — what the in-memory match index says should
//     be running on this URL. Computed on navigation by background.ts.
//   - `actual` — what injected wrappers have actually reported via
//     sm:start / sm:error. Driven by chrome.runtime.onUserScriptMessage.
//
// Each script in the union of those two sets gets a status here. The
// toolbar badge's color and tooltip are summed up from the popup's
// view of them (src/extension/toolbar-summary.ts). Keeping the
// computation here (pure) makes it easy to unit test without the
// chrome.* surface.

import type { MatchedScript } from './match-index.js';
import type { InjectionWorld } from '../script-world.js';
import { compareScriptNames } from '../script-display.js';

export type ScriptRunState = 'started' | 'error';

export interface ActualStatus {
  state: ScriptRunState;
  // @name as reported by the wrapper (we want this even for scripts
  // that aren't in our `matches` list — see UNEXPECTED below).
  name: string;
  // Populated only for state === 'error'.
  message?: string;
}

// One run of a script in one of the page's iframes (docs/frames.md).
export interface FrameRun extends ActualStatus {
  // Chrome's id for the frame (its slot in the tab), and the URL its
  // document was at when the script reported.
  frameId: number;
  url: string;
  // It ran code that has changed since, so the frame shows Updated
  // until it loads again. Kept per run, not per script: a frame that
  // reloads runs the new code.
  stale?: true;
}

export interface TabMatchState {
  // The current document's ID, from chrome.webNavigation. State is keyed
  // by tabId in storage, but invalidated whenever this changes — bfcache
  // restores preserve documentId, SPA pushState preserves it, only a
  // fresh document load gets a new one. That matches Chrome's actual
  // userScripts injection lifecycle: one injection per document.
  documentId: string;
  // The most-recent URL seen for this document. Useful for the log
  // line and as a fallback if documentId is missing.
  url: string;
  // Accumulated expected matches: the union of every script that
  // matched at any URL we've seen for this document. Doesn't shrink
  // when a SPA navigation lands on a URL with fewer matches — those
  // earlier scripts were expected to have already injected and we
  // still want to flag them MISSING if they didn't.
  matches: MatchedScript[];
  actual: Record<string, ActualStatus>;
  // Script IDs whose on-disk content has changed since the wrapper for
  // this document ran. The badge surfaces these as RELOAD/purple so the
  // user knows a page reload would pick up the new version. Cleared
  // implicitly when the document is replaced (new documentId → new
  // state). Optional so older persisted records still parse.
  staleScriptIds?: string[];
  // True when this document was loaded via the popup's "Reload
  // page with no userscripts": the SW answered every wrapper's
  // check-pending with `skip`, so no `actual` report is coming. The
  // badge shows the expected scripts as NOT_LOADED (grey) instead of
  // MISSING (orange) — nothing is wrong, the user asked for this.
  // Dies with the document like everything else on this state.
  scriptsSkipped?: boolean;
  // The narrower forms, from the popup's per-script reloads: this
  // document was loaded with only this script (`skipOnly`), or with
  // every script but this one (`skipWithout`). The rest show as NOT
  // LOADED, like a full skip.
  skipOnly?: string;
  skipWithout?: string;
  // Set when an sm-dev run controlled the tab as this document loaded
  // (sm-dev-link.ts): the script ids it let run, or null for none. The
  // rest were told to skip, so they show as NOT_LOADED too.
  smDevAllow?: string[] | null;
  // And the run that claimed it, whose own scripts the badge lists.
  smDevRun?: string;
  // What our wrappers' own reports say about this document, for
  // explaining a script that never started (src/extension/missing-scripts.ts):
  //   - `reportedWorlds`: the worlds a wrapper reported from. A world
  //     listed here is one Chrome did inject into.
  //   - `opaqueOrigin`: some wrapper saw `self.origin === 'null'`, which
  //     on an http(s) page means a CSP `sandbox` header.
  reportedWorlds?: InjectionWorld[];
  opaqueOrigin?: boolean;
  // Set once the post-load check for scripts that never started has
  // run, so it logs at most once per document.
  missingChecked?: boolean;
  // While the page is still settling, until this time (epoch ms): its
  // scripts may still be on their way, so a MISSING one isn't yet a
  // reason to reload (the popup's banner).
  //   - Set at a navigation commit. Not where no load is coming (a
  //     document first seen after an extension restart, or a pushState).
  //   - Dropped by the post-load check above, usually well before.
  //     A deadline rather than a flag, so a load event that never comes
  //     (a page that never finishes loading) can't leave it on.
  settleBy?: number;
  // The scripts that matched when the document was first seen. Only
  // these are checked for never starting: one that matched only a later
  // pushState URL, or was installed after the document committed, was
  // never going to be injected into it. Absent on records from before
  // the field existed, which check every match.
  loadMatchIds?: string[];
  // The URL the document loaded at, which `url` leaves behind after an
  // in-place change (pushState). The popup asks it whether a script
  // not in `loadMatchIds` was enabled since, or matches only the new
  // URL. Absent on records from before the field existed.
  loadUrl?: string;
  // Scripts that logged a warning from this tab while this document
  // was current (a failed GM_download, a style the page's CSP blocked,
  // ...). The popup shows them as Warning and the tooltip counts them.
  warnedIds?: string[];
  // Manual scripts (`@run-at context-menu`) asked to run on this
  // document, with how many times each was. They're never in `matches`,
  // since nothing expects them to run, so this is what keeps their
  // reports from reading as UNEXPECTED. See docs/manual-scripts.md.
  manualRuns?: Record<string, number>;
  // Set on a document that was already open when this copy of the
  // extension started (installed, updated or reloaded): nothing saw it
  // load, so whether its scripts run is unknown. Any copy still running
  // is the old extension's, cut off from it.
  loadedBefore?: boolean;
  // Runs in the page's iframes: script id → frame document id → run.
  // Kept apart from `actual`, which is the top frame's alone: what runs
  // in frames is never in `matches`, so it can't be MISSING or
  // UNEXPECTED. Runs go when their frame's document does
  // (`pruneFrameRuns`). See docs/frames.md.
  frameRuns?: Record<string, Record<string, FrameRun>>;
}

export type RowStatus =
  | 'OK' | 'ERROR' | 'REJECTED' | 'MISSING' | 'UNEXPECTED' | 'RELOAD' | 'NOT_LOADED' | 'UNTRACKED';

export interface BadgeRow {
  id: string;
  name: string;
  status: RowStatus;
  message?: string;
  // Runs only in the page's iframes: neither matched nor ran in the
  // top frame.
  framesOnly?: boolean;
}

export interface BadgeView {
  count: number;          // size of the union — what the badge shows
  rows: BadgeRow[];       // sorted by name for stable display
}

// Tampermonkey-ish orange (the "things differ" state).
export const BADGE_ORANGE = '#f57c00';
// Green = expected and actual agree, no errors.
export const BADGE_GREEN = '#2e7d32';
// Red = at least one script reported an error.
export const BADGE_RED = '#d32f2f';
// Purple = a reload would change what runs: a running script changed
// on disk, or a script was enabled, disabled or removed since the page
// loaded, or the page loaded before the extension started. Loses to
// RED (errors still matter most) but wins over ORANGE. Picked bright
// (≈ Material purple-A400) so the badge reads as a vivid "something
// changed" signal, not a muted/inactive color.
export const BADGE_PURPLE = '#d500f9';
// Grey = the user reloaded this page with no userscripts, so nothing
// ran on purpose. Loses to every other color: an UNEXPECTED report on a
// skipped document is still a disagreement worth orange.
export const BADGE_GREY = '#757575';
// Which color wins is decided in src/extension/toolbar-summary.ts.
// The note a tab an sm-dev run controls carries, in the badge tooltip
// and as the popup's banner.
export const SM_DEV_CONTROL_LABEL = 'Page under sm-dev control';

// Material cyan-600: the corner marker drawn on the icon in a tab an
// sm-dev run controls. Used for nothing else, so it can't be read as a
// status.
export const SM_DEV_MARKER_CYAN = '#00acc1';

// Pure: derive each script's status from a tab's combined expected +
// actual.
//
// Rules:
//   - Per script, status is one of:
//       OK         — expected AND actually started (no error reported)
//       ERROR      — actual reported `error` (regardless of expected),
//                    including a script that got no run decision
//       REJECTED   — expected, never started, and Chrome is refusing to
//                    register it (so it never will) — see
//                    src/extension/script-rejection.ts
//       NOT_LOADED — expected, never started, on a document the user
//                    loaded with "Reload page with no userscripts"
//       UNTRACKED  — expected, never reported, on a document that
//                    loaded before this copy of the extension started
//       MISSING    — expected but no `actual` entry yet
//       UNEXPECTED — actual `started` but not in our expected set
//       RELOAD     — a script that's started here, but its on-disk
//                    content has changed since (would be OK otherwise)
//   - The count is the size of the union of expected ∪ actual IDs,
//     with the scripts running in frames.
//   - A script running in frames takes the worst of its runs' statuses
//     (`STATUS_RANK`); one running only in frames is `framesOnly`.
//
// REJECTED is a refinement of MISSING, not a new axis: both mean
// "expected here, never reported". MISSING is provisional — the wrapper
// may still be on its way, or the user may have loaded the page before
// installing the script — so it earns amber. A rejected registration is
// settled: Chrome refused it, so nothing is coming, and red says so.
// It reads the same word as the collections page and the viewer.
//
// `rejected` is passed in rather than stored on TabMatchState because
// it's global (one refusal applies to every tab) while the state is
// per-document. Persisting a copy per tab would need a fan-out to keep
// them all honest.
export function computeBadge(
  state: TabMatchState,
  rejected: ReadonlySet<string> = new Set(),
): BadgeView {
  const expectedById = new Map<string, MatchedScript>();
  for (const m of state.matches) expectedById.set(m.id, m);

  const stale = new Set<string>(state.staleScriptIds ?? []);

  const frameRuns = state.frameRuns ?? {};
  const allIds = new Set<string>([
    ...expectedById.keys(),
    ...Object.keys(state.actual),
    ...Object.keys(frameRuns),
  ]);

  const rows: BadgeRow[] = [];
  for (const id of allIds) {
    const expected = expectedById.get(id);
    const actual = state.actual[id];
    // Prefer the actual-side name (most recently reported by the
    // wrapper); fall back to the match-index name; finally the id.
    const runs = Object.values(frameRuns[id] ?? {});
    const name = actual?.name ?? expected?.name ?? runs[0]?.name ?? id;
    if (!expected && !actual) {
      rows.push({ id, name, ...frameStatus(runs), framesOnly: true });
      continue;
    }
    let status: RowStatus;
    let message: string | undefined;
    // A manual script runs its current copy each time it's asked, so
    // it's never stale, and it's expected once it has run.
    const manual = state.manualRuns?.[id] !== undefined;
    if (actual && stale.has(id) && !manual) {
      // Whether the wrapper reported started or errored, that report
      // came from the OLD content. RELOAD/purple is more actionable
      // than ERROR/red here — the on-disk fix may already address the
      // failure, and we'd rather nudge the user to reload than to
      // keep showing an outdated error.
      status = 'RELOAD';
    } else if (actual?.state === 'error') {
      status = 'ERROR';
      message = actual.message;
    } else if (expected && !actual && skippedOnDocument(state, id)) {
      // Settled too, but by the user: the SW told every wrapper on this
      // document to skip, so "never reported" is the intended outcome.
      // Checked ahead of REJECTED — a refused registration didn't get
      // to matter on a document where nothing was going to run.
      status = 'NOT_LOADED';
    } else if (expected && !actual && rejected.has(id)) {
      // Settled, not provisional: Chrome refused the registration, so
      // no wrapper is coming. Red, like an error.
      status = 'REJECTED';
    } else if (expected && !actual && state.loadedBefore) {
      // Not provisional like MISSING: no report is coming, and none
      // would have reached this copy of the extension anyway.
      status = 'UNTRACKED';
    } else if (expected && !actual) {
      status = 'MISSING';
    } else if (!expected && actual && !manual) {
      status = 'UNEXPECTED';
    } else {
      status = 'OK';
    }
    if (runs.length > 0) {
      const inFrames = frameStatus(runs);
      if (STATUS_RANK[inFrames.status] > STATUS_RANK[status]) ({ status, message } = inFrames);
    }
    rows.push({ id, name, status, message });
  }
  rows.sort((a, b) => compareScriptNames(a.name, b.name));

  const count = [...allIds].filter((id) => countsOnBadge(state, id)).length;
  return { count, rows };
}

// Worst first: a row with runs in several documents shows the worst.
// Errors outrank everything; a run of outdated code (RELOAD) outranks
// what a reload would also settle (MISSING, UNEXPECTED).
const STATUS_RANK: Record<RowStatus, number> = {
  ERROR: 7, REJECTED: 7, RELOAD: 5, MISSING: 4, UNEXPECTED: 3, UNTRACKED: 2, NOT_LOADED: 1, OK: 0,
};

// A script's status from its runs in frames: outdated code first, as
// for the top frame's run, then an error, else running.
function frameStatus(runs: readonly FrameRun[]): { status: RowStatus; message?: string } {
  if (runs.some((r) => r.stale)) return { status: 'RELOAD' };
  const error = runs.find((r) => r.state === 'error');
  return error ? { status: 'ERROR', message: error.message } : { status: 'OK' };
}

/** Whether `id` has reported running in this document or any of its frames. */
export function runsHere(state: TabMatchState, id: string): boolean {
  return state.actual[id] != null || state.frameRuns?.[id] != null;
}

/**
 * Whether the badge counts `id`. In a tab an sm-dev run controls, the
 * count is of the scripts its claim let run: the rest were kept out,
 * not left out by a problem.
 */
export function countsOnBadge(state: TabMatchState, id: string): boolean {
  if (state.smDevAllow === undefined || state.scriptsSkipped) return true;
  return !skippedOnDocument(state, id) || runsHere(state, id);
}

/**
 * Whether the worker told `id` to skip this document: a reload with no
 * userscripts, with only another script, or without this one; or a tab
 * an sm-dev run controls that doesn't allow it.
 */
export function skippedOnDocument(state: TabMatchState, id: string): boolean {
  if (state.scriptsSkipped) return true;
  if (state.skipOnly !== undefined && state.skipOnly !== id) return true;
  if (state.skipWithout === id) return true;
  return state.smDevAllow !== undefined && !(state.smDevAllow?.includes(id) ?? false);
}

/** Whether the page is still settling (`settleBy`) at `now`. */
export function isSettling(state: TabMatchState, now: number): boolean {
  return state.settleBy !== undefined && now < state.settleBy;
}

// ---------- Per-tab document history ----------
//
// chrome.userScripts injects once per document. bfcache restores
// reuse the original `documentId`, so to recognise "this is the same
// page you had loaded a moment ago" we have to remember each tab's
// recent documents — not just the current one. Otherwise navigating
// A → B → back to A throws away A's expected/actual state, then
// onCommitted for A lands with no prior state and we incorrectly
// reset, painting every still-running script as MISSING.
//
// Cap kept small (covers normal back/forward chains) so the session-
// storage value per tab stays cheap and a runaway tab can't bloat
// indefinitely. LRU order: oldest first; the current doc is always
// the rightmost entry.

export const MAX_DOCS_PER_TAB = 5;

export interface TabRecord {
  currentDocId: string;
  docOrder: string[];                                // LRU, oldest → newest
  byDoc: Record<string, TabMatchState>;
}

export function getDocState(record: TabRecord | null, documentId: string): TabMatchState | null {
  if (!record || !documentId) return null;
  return record.byDoc[documentId] ?? null;
}

export function getCurrentState(record: TabRecord | null): TabMatchState | null {
  if (!record) return null;
  return record.byDoc[record.currentDocId] ?? null;
}

function trimLru(record: TabRecord): TabRecord {
  if (record.docOrder.length <= MAX_DOCS_PER_TAB) return record;
  const docOrder = record.docOrder.slice();
  const byDoc = { ...record.byDoc };
  while (docOrder.length > MAX_DOCS_PER_TAB) {
    const evicted = docOrder.shift()!;
    // Don't evict the current doc even if it's somehow at the head —
    // promote it back to the most-recent slot.
    if (evicted === record.currentDocId) {
      docOrder.push(evicted);
      continue;
    }
    delete byDoc[evicted];
  }
  return { currentDocId: record.currentDocId, docOrder, byDoc };
}

// Pure: write `state` for `documentId` and mark this doc as the one
// the badge should display. Used by navigation events
// (onCommitted / onHistoryStateUpdated) and by message-handler
// bootstrap when there's no prior record at all.
export function setCurrentDoc(
  record: TabRecord | null,
  documentId: string,
  state: TabMatchState,
): TabRecord {
  const docOrder = (record?.docOrder ?? []).filter((d) => d !== documentId);
  docOrder.push(documentId);
  const byDoc = { ...(record?.byDoc ?? {}), [documentId]: state };
  return trimLru({ currentDocId: documentId, docOrder, byDoc });
}

// Pure: write `state` for `documentId` WITHOUT promoting it to current.
// Used by the sm:* message handler: a wrapper firing from a doc that
// isn't currently displayed (e.g. teardown of the doc we just
// navigated away from) should still update that doc's recorded state,
// but the badge stays on whatever the navigation handler set.
export function writeDocState(
  record: TabRecord | null,
  documentId: string,
  state: TabMatchState,
): TabRecord {
  if (!record) {
    return { currentDocId: documentId, docOrder: [documentId], byDoc: { [documentId]: state } };
  }
  const docOrder = record.docOrder.filter((d) => d !== documentId);
  docOrder.push(documentId);
  const byDoc = { ...record.byDoc, [documentId]: state };
  return trimLru({ currentDocId: record.currentDocId, docOrder, byDoc });
}

// Pure: union two expected-match lists by script id. Used when a SPA
// navigation within the same document brings in matches for a new URL —
// we accumulate rather than replace, so a script that matched only the
// initial URL still surfaces as MISSING if its `sm:start` never came.
// Sorted by name for stable downstream display.
export function mergeMatches(
  existing: MatchedScript[],
  incoming: MatchedScript[],
): MatchedScript[] {
  const byId = new Map<string, MatchedScript>();
  for (const m of existing) byId.set(m.id, m);
  // Incoming wins on name updates (the cache is fresher).
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => compareScriptNames(a.name, b.name));
}

// Pure: flag `scriptId` as stale. No-op when the wrapper hasn't
// reported anything for this script — the SW listener uses the
// identity-return to skip storage writes for non-running tabs.
//
// Its runs in frames are marked each (`FrameRun.stale`), so a frame
// that loads again afterwards, with the new code, isn't.
export function markScriptStale(state: TabMatchState, scriptId: string): TabMatchState {
  let next = state;
  const runs = state.frameRuns?.[scriptId];
  if (runs && Object.values(runs).some((r) => !r.stale)) {
    const marked = Object.fromEntries(Object.entries(runs).map(([doc, r]) => [doc, { ...r, stale: true as const }]));
    next = { ...next, frameRuns: { ...next.frameRuns, [scriptId]: marked } };
  }
  const existing = next.staleScriptIds ?? [];
  if (!state.actual[scriptId] || existing.includes(scriptId)) return next;
  return { ...next, staleScriptIds: [...existing, scriptId] };
}

// Pure: clear the stale flag for `scriptId`. Used after a sm:swapped
// report — the wrapper just ran the latest content, so any prior
// staleness marker for this id no longer reflects reality.
export function clearScriptStale(state: TabMatchState, scriptId: string): TabMatchState {
  const existing = state.staleScriptIds;
  if (!existing || !existing.includes(scriptId)) return state;
  const next = existing.filter((id) => id !== scriptId);
  if (next.length === 0) {
    const { staleScriptIds: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, staleScriptIds: next };
}

// Pure: note that `scriptId` logged a warning from this document.
// Identity-returns when it already had one, so the caller can skip a
// storage write.
export function noteScriptWarning(state: TabMatchState, scriptId: string): TabMatchState {
  const existing = state.warnedIds ?? [];
  if (existing.includes(scriptId)) return state;
  return { ...state, warnedIds: [...existing, scriptId] };
}

// Pure: merge an incoming wrapper report into the tab's `actual` map.
// Returns a new state object (callers re-write storage with it).
//
// Guard: an existing `error` entry is sticky for the same id — a later
// sm:start (e.g. on retry / re-evaluation) shouldn't silently flip it
// back to OK and hide the failure.
//
// Except for a manual script's `sm:start` (`manual`): each one is a new
// run the person asked for, so it replaces the last run's outcome.
export function applyScriptReport(
  state: TabMatchState,
  id: string,
  report: ActualStatus,
  manual = false,
): TabMatchState {
  if (!manual && report.state === 'started' && state.actual[id]?.state === 'error') {
    return state;
  }
  return {
    ...state,
    actual: { ...state.actual, [id]: report },
  };
}

// Pure: count a request to run manual script `id` on this document.
// Recorded before the run is injected, so its reports find it there.
export function noteManualRun(state: TabMatchState, id: string): TabMatchState {
  const runs = state.manualRuns ?? {};
  return { ...state, manualRuns: { ...runs, [id]: (runs[id] ?? 0) + 1 } };
}

// Pure: note that a wrapper in `world` reported from this document, and
// whether it saw an opaque origin. Identity-returns when nothing is new,
// so the caller can skip a storage write.
export function notePageReport(
  state: TabMatchState,
  world: InjectionWorld,
  opaqueOrigin: boolean,
): TabMatchState {
  const worlds = state.reportedWorlds ?? [];
  const newWorld = !worlds.includes(world);
  const newOpaque = opaqueOrigin && !state.opaqueOrigin;
  if (!newWorld && !newOpaque) return state;
  return {
    ...state,
    ...(newWorld ? { reportedWorlds: [...worlds, world] } : {}),
    ...(newOpaque ? { opaqueOrigin: true } : {}),
  };
}

// Pure: merge a report from a script in one of the page's iframes, the
// same way `applyScriptReport` does for the top frame: an error stays
// for that frame's document.
export function applyFrameReport(
  state: TabMatchState,
  id: string,
  frameDocId: string,
  run: FrameRun,
): TabMatchState {
  const runs = state.frameRuns?.[id] ?? {};
  if (run.state === 'started' && runs[frameDocId]?.state === 'error') return state;
  return {
    ...state,
    frameRuns: { ...state.frameRuns, [id]: { ...runs, [frameDocId]: run } },
  };
}

// Pure: drop the frame runs whose document isn't in `liveDocIds` (the
// tab's frames now): the frame navigated or was removed. Identity-
// returns when nothing went, so the caller can skip a storage write.
export function pruneFrameRuns(state: TabMatchState, liveDocIds: ReadonlySet<string>): TabMatchState {
  if (!state.frameRuns) return state;
  let changed = false;
  const kept: Record<string, Record<string, FrameRun>> = {};
  for (const [id, runs] of Object.entries(state.frameRuns)) {
    const live = Object.entries(runs).filter(([docId]) => liveDocIds.has(docId));
    if (live.length !== Object.keys(runs).length) changed = true;
    if (live.length > 0) kept[id] = Object.fromEntries(live);
  }
  if (!changed) return state;
  if (Object.keys(kept).length > 0) return { ...state, frameRuns: kept };
  const { frameRuns: _drop, ...rest } = state;
  return rest;
}
