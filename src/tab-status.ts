// Per-tab script-status model + badge computation.
//
// For each tab we track two views of the world:
//   - `matches` (expected) — what the in-memory match index says should
//     be running on this URL. Computed on navigation by background.ts.
//   - `actual` — what injected wrappers have actually reported via
//     sm:start / sm:error. Driven by chrome.runtime.onUserScriptMessage.
//
// The toolbar badge surfaces the union of those two sets, colored by
// what's gone wrong (if anything), and the tooltip itemises each
// script's status. Keeping the computation here (pure) makes it easy
// to unit test without the chrome.* surface.

import { ACTION_MENU_SM_DEV_LABEL } from './action-menu.js';
import type { MatchedScript } from './match-index.js';
import type { InjectionWorld } from './script-world.js';

export type ScriptRunState = 'started' | 'error';

export interface ActualStatus {
  state: ScriptRunState;
  // @name as reported by the wrapper (we want this even for scripts
  // that aren't in our `matches` list — see UNEXPECTED below).
  name: string;
  // Populated only for state === 'error'.
  message?: string;
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
  // True when this document was loaded via the action menu's "Reload
  // page with no userscripts": the SW answered every wrapper's
  // check-pending with `skip`, so no `actual` report is coming. The
  // badge shows the expected scripts as NOT LOADED (grey) instead of
  // MISSING (orange) — nothing is wrong, the user asked for this.
  // Dies with the document like everything else on this state.
  scriptsSkipped?: boolean;
  // Set when an sm-dev run controlled the tab as this document loaded
  // (sm-dev-link.ts): the script ids it let run, or null for none. The
  // rest were told to skip, so they show as NOT LOADED too.
  smDevAllow?: string[] | null;
  // And the run that claimed it, whose own scripts the badge lists.
  smDevRun?: string;
  // What our wrappers' own reports say about this document, for
  // explaining a script that never started (src/missing-scripts.ts):
  //   - `reportedWorlds`: the worlds a wrapper reported from. A world
  //     listed here is one Chrome did inject into.
  //   - `opaqueOrigin`: some wrapper saw `self.origin === 'null'`, which
  //     on an http(s) page means a CSP `sandbox` header.
  reportedWorlds?: InjectionWorld[];
  opaqueOrigin?: boolean;
  // Set once the post-load check for scripts that never started has
  // run, so it logs at most once per document.
  missingChecked?: boolean;
  // The scripts that matched when the document was first seen. Only
  // these are checked for never starting: one that matched only a later
  // pushState URL, or was installed after the document committed, was
  // never going to be injected into it. Absent on records from before
  // the field existed, which check every match.
  loadMatchIds?: string[];
}

export type RowStatus =
  | 'OK' | 'ERROR' | 'REJECTED' | 'MISSING' | 'UNEXPECTED' | 'RELOAD' | 'NOT_LOADED';

export interface BadgeRow {
  id: string;
  name: string;
  status: RowStatus;
  message?: string;
}

export interface BadgeView {
  count: number;          // size of the union — what the badge shows
  color: string;          // background color for the badge
  title: string;          // multi-line tooltip
  rows: BadgeRow[];       // sorted by name for stable display
}

// Tampermonkey-ish orange (the "things differ" state).
export const BADGE_ORANGE = '#f57c00';
// Green = expected and actual agree, no errors.
export const BADGE_GREEN = '#2e7d32';
// Red = at least one script reported an error.
export const BADGE_RED = '#d32f2f';
// Purple = at least one running script's collection on disk has changed
// and a reload would pick up the new version. Loses to RED (errors
// still matter most) but wins over ORANGE. Picked bright (≈ Material
// purple-A400) so the badge reads as a vivid "something changed"
// signal, not a muted/inactive color.
export const BADGE_PURPLE = '#d500f9';
// Grey = the user reloaded this page with no userscripts, so nothing
// ran on purpose. Loses to every other color: an UNEXPECTED report on a
// skipped document is still a disagreement worth orange.
export const BADGE_GREY = '#757575';
// Material cyan-600: the corner marker drawn on the icon in a tab an
// sm-dev run controls. Used for nothing else, so it can't be read as a
// status.
export const SM_DEV_MARKER_CYAN = '#00acc1';

// Tooltip status string for RELOAD rows. Kept verbose because the
// tooltip is the only place the user is told *what to do*.
const RELOAD_LABEL = 'Reload to update';
// Tooltip status string for NOT_LOADED rows — the enum's underscore
// is not for display.
const NOT_LOADED_LABEL = 'NOT LOADED';

// Pure: derive the badge view from a tab's combined expected + actual.
//
// Rules:
//   - Per script, status is one of:
//       OK         — expected AND actually started (no error reported)
//       ERROR      — actual reported `error` (regardless of expected)
//       REJECTED   — expected, never started, and Chrome is refusing to
//                    register it (so it never will) — see
//                    src/script-rejection.ts
//       NOT_LOADED — expected, never started, on a document the user
//                    loaded with "Reload page with no userscripts"
//       MISSING    — expected but no `actual` entry yet
//       UNEXPECTED — actual `started` but not in our expected set
//       RELOAD     — a script that's started here, but its on-disk
//                    content has changed since (would be OK otherwise)
//   - Badge color:
//       RED    if any script reported ERROR or is REJECTED
//       PURPLE else, if any RELOAD row
//       ORANGE else, if any MISSING or UNEXPECTED
//       GREY   else, if any NOT_LOADED row
//       GREEN  otherwise
//   - Badge text is the size of the union of expected ∪ actual IDs.
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

  const allIds = new Set<string>([
    ...expectedById.keys(),
    ...Object.keys(state.actual),
  ]);

  let anyError = false;
  let anyMismatch = false;
  let anyReload = false;
  let anySkipped = false;
  const rows: BadgeRow[] = [];
  for (const id of allIds) {
    const expected = expectedById.get(id);
    const actual = state.actual[id];
    // Prefer the actual-side name (most recently reported by the
    // wrapper); fall back to the match-index name; finally the id.
    const name = actual?.name ?? expected?.name ?? id;
    let status: RowStatus;
    let message: string | undefined;
    if (actual && stale.has(id)) {
      // Whether the wrapper reported started or errored, that report
      // came from the OLD content. RELOAD/purple is more actionable
      // than ERROR/red here — the on-disk fix may already address the
      // failure, and we'd rather nudge the user to reload than to
      // keep showing an outdated error.
      status = 'RELOAD';
      anyReload = true;
    } else if (actual?.state === 'error') {
      status = 'ERROR';
      message = actual.message;
      anyError = true;
    } else if (expected && !actual && skippedOnDocument(state, id)) {
      // Settled too, but by the user: the SW told every wrapper on this
      // document to skip, so "never reported" is the intended outcome.
      // Checked ahead of REJECTED — a refused registration didn't get
      // to matter on a document where nothing was going to run.
      status = 'NOT_LOADED';
      anySkipped = true;
    } else if (expected && !actual && rejected.has(id)) {
      // Settled, not provisional: Chrome refused the registration, so
      // no wrapper is coming. Red, like an error.
      status = 'REJECTED';
      anyError = true;
    } else if (expected && !actual) {
      status = 'MISSING';
      anyMismatch = true;
    } else if (!expected && actual) {
      status = 'UNEXPECTED';
      anyMismatch = true;
    } else {
      status = 'OK';
    }
    rows.push({ id, name, status, message });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  let color = BADGE_GREEN;
  if (anyError) color = BADGE_RED;
  else if (anyReload) color = BADGE_PURPLE;
  else if (anyMismatch) color = BADGE_ORANGE;
  // Grey says nothing ran: not for a tab where some scripts were kept
  // out (an sm-dev claim) and the rest ran.
  else if (anySkipped && !rows.some((r) => r.status === 'OK')) color = BADGE_GREY;

  const title = [titleHead(state), ...rows.map((r) => formatRowLabel(r))].join('\n');

  // In a tab an sm-dev run controls, the count is of the scripts its
  // claim let run: the rest were kept out, not left out by a problem.
  const count = state.smDevAllow === undefined || state.scriptsSkipped
    ? allIds.size
    : [...allIds].filter((id) => !skippedOnDocument(state, id) || state.actual[id]).length;
  return { count, color, title, rows };
}

/**
 * The tooltip's first lines: the extension's name, and in a tab an
 * sm-dev run controls, the same note the action menu opens with.
 */
export function titleHead(state: TabMatchState | null): string {
  return state?.smDevAllow === undefined ? 'SourceMonkey' : `SourceMonkey\n${ACTION_MENU_SM_DEV_LABEL}`;
}

/**
 * Whether the worker told `id` to skip this document: a reload with no
 * userscripts, or a tab an sm-dev run controls that doesn't allow it.
 */
export function skippedOnDocument(state: TabMatchState, id: string): boolean {
  if (state.scriptsSkipped) return true;
  return state.smDevAllow !== undefined && !(state.smDevAllow?.includes(id) ?? false);
}

// Shared "{name} | {status}" formatter — same text the badge tooltip
// uses, so the action context menu can mirror it byte-for-byte.
export function formatRowLabel(row: BadgeRow): string {
  return `${row.name} | ${formatStatus(row.status)}`;
}

function formatStatus(s: RowStatus): string {
  if (s === 'RELOAD') return RELOAD_LABEL;
  if (s === 'NOT_LOADED') return NOT_LOADED_LABEL;
  return s;
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
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Pure: flag `scriptId` as stale. No-op when the wrapper hasn't
// reported anything for this script — the SW listener uses the
// identity-return to skip storage writes for non-running tabs.
export function markScriptStale(state: TabMatchState, scriptId: string): TabMatchState {
  if (!state.actual[scriptId]) return state;
  const existing = state.staleScriptIds ?? [];
  if (existing.includes(scriptId)) return state;
  return { ...state, staleScriptIds: [...existing, scriptId] };
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

// Pure: merge an incoming wrapper report into the tab's `actual` map.
// Returns a new state object (callers re-write storage with it).
//
// Guard: an existing `error` entry is sticky for the same id — a later
// sm:start (e.g. on retry / re-evaluation) shouldn't silently flip it
// back to OK and hide the failure.
export function applyScriptReport(
  state: TabMatchState,
  id: string,
  report: ActualStatus,
): TabMatchState {
  if (report.state === 'started' && state.actual[id]?.state === 'error') {
    return state;
  }
  return {
    ...state,
    actual: { ...state.actual, [id]: report },
  };
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
