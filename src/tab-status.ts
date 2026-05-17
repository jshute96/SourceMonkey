// Per-tab script-status model + badge computation.
//
// For each tab we track two views of the world:
//   - `matches` (expected) — what the in-memory match index says should
//     be running on this URL. Computed on navigation by background.ts.
//   - `actual` — what injected wrappers have actually reported via
//     vm:start / vm:error. Driven by chrome.runtime.onUserScriptMessage.
//
// The toolbar badge surfaces the union of those two sets, colored by
// what's gone wrong (if anything), and the tooltip itemises each
// script's status. Keeping the computation here (pure) makes it easy
// to unit test without the chrome.* surface.

import type { MatchedScript } from './match-index.js';

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
}

export type RowStatus = 'OK' | 'ERROR' | 'MISSING' | 'UNEXPECTED' | 'RELOAD';

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
// Purple = at least one running script's source on disk has changed and
// a reload would pick up the new version. Loses to RED (errors still
// matter most) but wins over ORANGE. Picked bright (≈ Material
// purple-A400) so the badge reads as a vivid "something changed"
// signal, not a muted/inactive color.
export const BADGE_PURPLE = '#d500f9';

// Tooltip status string for RELOAD rows. Kept verbose because the
// tooltip is the only place the user is told *what to do*.
const RELOAD_LABEL = 'Reload to update';

// Pure: derive the badge view from a tab's combined expected + actual.
//
// Rules:
//   - Per script, status is one of:
//       OK         — expected AND actually started (no error reported)
//       ERROR      — actual reported `error` (regardless of expected)
//       MISSING    — expected but no `actual` entry yet
//       UNEXPECTED — actual `started` but not in our expected set
//       RELOAD     — a script that's started here, but its on-disk
//                    content has changed since (would be OK otherwise)
//   - Badge color:
//       RED    if any script reported ERROR
//       PURPLE else, if any RELOAD row
//       ORANGE else, if any MISSING or UNEXPECTED
//       GREEN  otherwise
//   - Badge text is the size of the union of expected ∪ actual IDs.
export function computeBadge(state: TabMatchState): BadgeView {
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

  const title = ['VibeMonkey', ...rows.map((r) => `${r.name} | ${formatStatus(r.status)}`)].join('\n');

  return { count: allIds.size, color, title, rows };
}

function formatStatus(s: RowStatus): string {
  return s === 'RELOAD' ? RELOAD_LABEL : s;
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
// Used by the vm:* message handler: a wrapper firing from a doc that
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
// initial URL still surfaces as MISSING if its `vm:start` never came.
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

// Pure: merge an incoming wrapper report into the tab's `actual` map.
// Returns a new state object (callers re-write storage with it).
//
// Guard: an existing `error` entry is sticky for the same id — a later
// vm:start (e.g. on retry / re-evaluation) shouldn't silently flip it
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
