// SourceMonkey MV3 service worker.
//
// Today the SW does two real jobs:
//   - Opens the options page on toolbar click (no popup configured).
//   - Watches every tab navigation, finds matching userscripts via the
//     in-memory match index, listens to sm:start / sm:error reports
//     from injected wrappers, and surfaces the combined state as a
//     per-tab badge + tooltip. Per-tab state is persisted to
//     chrome.storage.session so it survives SW restarts but is dropped
//     when Chrome shuts down.
//
// The `self.SourceMonkey` surface exists so e2e tests can drive the
// extension via `serviceWorker.evaluate(...)` — MV3 service workers
// can't be triggered from a Playwright toolbar click.

import {
  debugDumpCache,
  ensureLoaded,
  findMatchesForUrl,
  installStorageListener,
  onCacheChanged,
  type MatchedScript,
} from './match-index.js';
import {
  dlog,
  installDebugLoggingListener,
  loadDebugLoggingFlag,
} from './debug-log.js';
import {
  ensureLogIdsLoaded,
  getScriptLogLabel,
  installScriptLogIdListener,
} from './script-log-id.js';
import {
  composeRequiredBody,
  isUserScriptsAvailable,
  syncRegistrations,
  SM_ABANDONED_MSG,
  SM_CHECK_PENDING_MSG,
  SM_ERROR_MSG,
  SM_START_MSG,
  SM_SWAPPED_MSG,
} from './injector.js';
import {
  applyScriptReport,
  clearScriptStale,
  computeBadge,
  getDocState,
  markScriptStale,
  mergeMatches,
  setCurrentDoc,
  writeDocState,
  type ActualStatus,
  type TabMatchState,
  type TabRecord,
} from './tab-status.js';
import {
  requestOpportunisticScriptChecks,
  updateAllSources,
  updateScript,
  updateSource,
} from './script-updater.js';
import {
  addSource,
  getScript,
  getSources,
  getSourceWithScripts,
  removeSource,
  setScriptEnabled,
  setSourceEnabled,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import {
  appendScriptLog,
  clearScriptLog,
  getScriptLog,
  logScriptEvent,
  type AppendLogInput,
  type LogEntry,
} from './script-log.js';
import {
  applyBatchValues,
  DELETED_SENTINEL,
  type ValueWrite,
} from './gm-values.js';
import {
  abortXhr,
  runXhr,
  type GmXhrRequestPayload,
} from './gm-xhr.js';
import {
  extractSelfHosts,
  isUrlConnectAllowed,
  parseConnectRules,
} from './gm-connect.js';

interface SourceMonkeyApi {
  version: string;
  // Round-trip echo used by the smoke test to confirm the SW is alive
  // and `self.SourceMonkey` is reachable from `serviceWorker.evaluate`.
  ping: (value?: string) => string;
  // Test/debug hook: force a tab badge refresh against an arbitrary URL.
  matchesFor: (url: string) => Promise<MatchedScript[]>;
  // ---- E2E test surface ----
  //
  // These methods exist so Playwright tests can drive the extension via
  // `serviceWorker.evaluate(...)`. MV3 service workers can't be poked
  // from a Playwright UI action (no toolbar click); without these the
  // tests would have to navigate to the options page for every state
  // transition, which is both slow and couples tests to the page's DOM.
  // All of them delegate straight to the production functions — they
  // are not test-only logic, just convenience accessors.
  //
  // Production exposure: the manifest has no `externally_connectable`
  // entry, so neither web pages nor other extensions can reach the SW
  // to call these. Practically callable only from DevTools on an
  // extension page or from Playwright's `serviceWorker.evaluate`.
  addSource: (path: string) => Promise<StoredSource | null>;
  removeSource: (id: string) => Promise<void>;
  getSources: () => Promise<StoredSource[]>;
  getSourceWithScripts: (id: string) => Promise<{ source: StoredSource; scripts: StoredScript[] } | null>;
  setSourceEnabled: (id: string, enabled: boolean) => Promise<StoredSource | null>;
  setScriptEnabled: (id: string, enabled: boolean) => Promise<StoredScript | null>;
  updateSource: (id: string, mode: 'manual' | 'opportunistic') => Promise<unknown>;
  updateScript: (id: string, mode: 'manual' | 'opportunistic') => Promise<unknown>;
  updateAllSources: (mode: 'manual' | 'opportunistic') => Promise<unknown>;
  // Inspect the per-tab badge state Chrome would render. We pull
  // text/title back from chrome.action and the structured TabRecord
  // from session storage so a single round-trip gives a test
  // everything it needs to assert on.
  getTabState: (tabId: number) => Promise<{
    badgeText: string;
    badgeColor: chrome.action.ColorArray;
    title: string;
    record: TabRecord | null;
  }>;
  // Wipe local + session storage and unregister every userscript so
  // each test starts clean.
  resetAllState: () => Promise<void>;
  // Force an immediate chrome.userScripts re-sync, bypassing the 50ms
  // debounce in scheduleSync(). Tests use this after addSource /
  // updateScript / setSourceEnabled so the navigation that follows
  // can't out-race the debounced registration.
  syncNow: () => Promise<{ registered: { id: string }[] }>;
  // Diagnostic: the match-index's current view of the world. Tests use
  // this when a badge classification looks wrong to distinguish between
  // "matcher cache stale" and "wrapper never reported". Returns the
  // matches for the URL plus the full cache dump for context.
  debugMatchIndex: (url: string) => Promise<{
    matches: { id: string; name: string }[];
    cache: ReturnType<typeof debugDumpCache>;
  }>;
  // Per-script event log. Tests use these to assert that refresh
  // failures and wrapper errors are surfaced through the log pane.
  getScriptLog: (scriptId: string) => Promise<LogEntry[]>;
  appendScriptLog: (scriptId: string, input: AppendLogInput) => Promise<void>;
  clearScriptLog: (scriptId: string) => Promise<void>;
}

const api: SourceMonkeyApi = {
  version: chrome.runtime.getManifest().version,
  ping: (value = 'pong') => value,
  matchesFor: async (url) => {
    await ensureLoaded();
    return findMatchesForUrl(url);
  },
  addSource,
  removeSource,
  getSources,
  getSourceWithScripts,
  setSourceEnabled,
  setScriptEnabled,
  updateSource,
  updateScript,
  updateAllSources,
  getTabState: async (tabId: number) => {
    const [badgeText, badgeColor, title, record] = await Promise.all([
      chrome.action.getBadgeText({ tabId }),
      chrome.action.getBadgeBackgroundColor({ tabId }),
      chrome.action.getTitle({ tabId }),
      getTabRecord(tabId),
    ]);
    return { badgeText, badgeColor, title, record };
  },
  getScriptLog,
  appendScriptLog,
  clearScriptLog,
  debugMatchIndex: async (url: string) => {
    await ensureLoaded();
    return {
      matches: findMatchesForUrl(url).map((m) => ({ id: m.id, name: m.name })),
      cache: debugDumpCache(),
    };
  },
  syncNow: async () => {
    // Cancel any pending debounced sync first — otherwise its work
    // would fire just after we return, and a test that does addSource
    // → syncNow → page.goto could see the registration briefly
    // disappear mid-navigation. Tests rely on syncNow being the LAST
    // sync until the next mutation.
    if (syncTimer != null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    // Mirror scheduleSync's full work — both the chrome.userScripts
    // re-registration AND the open-tab badge recompute — so callers
    // don't need to know which side effect they care about.
    await Promise.all([syncRegistrations(), refreshAllOpenTabs()]);
    if (!isUserScriptsAvailable()) return { registered: [] };
    const list = await chrome.userScripts.getScripts();
    return { registered: list.map((s) => ({ id: s.id })) };
  },
  resetAllState: async () => {
    // Cancel any pending debounced sync first — clear() below will
    // schedule another one via onCacheChanged, so leaving the old
    // timer armed risks two syncs firing back-to-back and racing the
    // next test's setup.
    if (syncTimer != null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    // Tear down whatever Chrome currently has registered so the next
    // test doesn't inherit injections from the previous one. The
    // storage.onChanged listener will also fire syncRegistrations() in
    // response to the clear, but that races test setup — doing it
    // ourselves here is deterministic.
    if (chrome.userScripts) {
      try {
        const existing = await chrome.userScripts.getScripts();
        if (existing.length > 0) {
          await chrome.userScripts.unregister({ ids: existing.map((e) => e.id) });
        }
      } catch {
        /* ignore */
      }
    }
    // Cancel the post-clear scheduled sync that the onChanged listener
    // just armed. Without this it would fire ~50 ms into the next
    // test, potentially mid-addSource.
    if (syncTimer != null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  },
};

(self as unknown as { SourceMonkey: SourceMonkeyApi }).SourceMonkey = api;

// Clicking the toolbar icon opens the options page. We have no popup
// configured, so onClicked fires on every action click; openOptionsPage
// honors `options_ui.open_in_tab` (true) and focuses an existing tab
// if one is already open.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ---------- Per-tab badge + tooltip ----------

// Only attempt matching for URLs we could conceivably inject into. This
// skips chrome://, about:, view-source:, etc. without forcing every
// pattern in every script to filter them out.
const INJECTABLE_SCHEME = /^(https?|file|ftp):/i;

const tabKey = (tabId: number) => `tab:${tabId}`;

// Per-tab serialization. All state mutations for a given tab (navigation
// updates, sm:* reports, removals) go through enqueueTabWork so they
// run strictly in order. Without this, two sm:start messages that
// arrive in the same event-loop turn each do their own get/modify/set
// against chrome.storage.session and the second write loses the first
// update — the symptom is one script showing OK and another MISSING
// when both wrappers actually ran.
const tabQueues = new Map<number, Promise<unknown>>();
function enqueueTabWork(tabId: number, task: () => Promise<void>): void {
  const prev = tabQueues.get(tabId) ?? Promise.resolve();
  // Use .then(task, task) so a failure on one task doesn't poison the
  // queue — every queued task still runs.
  const next = prev.then(task, task);
  tabQueues.set(tabId, next);
  void next.finally(() => {
    // Drop the entry once the chain is fully drained so the map
    // doesn't grow without bound across long sessions.
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  });
}

async function getTabRecord(tabId: number): Promise<TabRecord | null> {
  const key = tabKey(tabId);
  const got = await chrome.storage.session.get(key);
  const raw = got[key];
  if (!raw || typeof raw !== 'object') return null;
  // Defensive: if a previous extension build wrote the old single-state
  // shape, ignore it. Session storage clears on Chrome restart, so this
  // only matters across hot reloads — the next nav will repopulate.
  if (!('byDoc' in (raw as Record<string, unknown>))) return null;
  return raw as TabRecord;
}

async function setTabRecord(tabId: number, record: TabRecord): Promise<void> {
  await chrome.storage.session.set({ [tabKey(tabId)]: record });
}

async function clearTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(tabKey(tabId));
}

// Apply a navigation event (or an injector-driven recompute) to a tab.
// Lifecycle keyed by documentId:
//   - same documentId → SPA navigation OR bfcache restore. Accumulate
//     the new URL's matches into the existing expected set and keep
//     `actual` (the wrappers from the original document are still
//     alive; Chrome does NOT re-inject in this case).
//   - new documentId  → fresh document. Reset `actual` to {} and
//     start a new expected set from this URL's matches.
//   - null documentId → caller doesn't know (e.g. refreshAllOpenTabs
//     after a script-set change). Treat as "same document if we have
//     a prior state for this tab" — we want to update expected for
//     the current URL without wiping running-script reports.
// `trigger` distinguishes a real user navigation (where opportunistic
// auto-update is desired — the user just interacted with a page that
// uses these scripts) from a script-set-driven re-evaluation (where it
// is NOT — `refreshAllOpenTabs` walks every open tab whenever the
// match index changes, and we don't want to ping the filesystem for
// every script on every other tab just because one of them got
// updated).
async function updateTabMatches(
  tabId: number,
  url: string | undefined,
  documentId: string | null,
  trigger: 'navigation' | 'refresh',
): Promise<void> {
  if (!url || !INJECTABLE_SCHEME.test(url)) {
    await renderBadge(tabId, null);
    await clearTabState(tabId);
    return;
  }
  await ensureLoaded();
  const incoming = findMatchesForUrl(url);
  const record = await getTabRecord(tabId);
  const docId = documentId ?? record?.currentDocId ?? '';
  // Look up whether we've already tracked this document. If yes:
  //   - normal in-doc URL change (script-set refresh, SPA pushState)
  //   - bfcache restore (back/forward returned to a doc we still have)
  // In both cases keep `actual` and accumulate `matches`.
  const prev = getDocState(record, docId);
  const restored = prev != null;
  const matches = restored ? mergeMatches(prev.matches, incoming) : incoming;
  const actual = restored ? prev.actual : {};
  // A refresh-driven re-evaluation must NOT silently drop staleScriptIds —
  // those are kept across navigation events anyway, but extra-explicit
  // here because we're rebuilding the state object from scratch.
  const staleScriptIds = restored && prev?.staleScriptIds ? prev.staleScriptIds : undefined;
  const state: TabMatchState = staleScriptIds
    ? { documentId: docId, url, matches, actual, staleScriptIds }
    : { documentId: docId, url, matches, actual };
  const nextRecord = setCurrentDoc(record, docId, state);
  await setTabRecord(tabId, nextRecord);
  if (incoming.length > 0 && trigger === 'navigation') {
    // Logged only on the navigation path. Refresh-triggered
    // re-evaluations (driven by `onCacheChanged` after a script-set
    // change) walk every open tab to update their badges; logging the
    // match list on every tab on every script change is noisy and
    // misleadingly suggests we're doing per-tab I/O when we're not.
    const tag = restored ? ' restored' : '';
    dlog(
      `[SourceMonkey] ${incoming.length} matching script(s) for ${url} (doc=${docId || '?'}${tag}):`,
      incoming.map((m) => getScriptLogLabel(m.id)),
    );
    // Opportunistic auto-update: while the user is interacting with a
    // page that uses these scripts, ask the updater (in the background,
    // rate-limited) whether their source files on disk have changed.
    // Skipped for the refresh trigger so a single user edit doesn't fan
    // out into a filesystem check on every other open tab's scripts.
    requestOpportunisticScriptChecks(incoming.map((m) => m.id));
  }
  await renderBadge(tabId, state);
}

async function renderBadge(tabId: number, state: TabMatchState | null): Promise<void> {
  // Each setX call can reject if the tab closed between our query and
  // here; swallow that rather than spamming the SW console.
  try {
    if (!state || (state.matches.length === 0 && Object.keys(state.actual).length === 0)) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'SourceMonkey' });
      return;
    }
    const view = computeBadge(state);
    await chrome.action.setBadgeText({ tabId, text: String(view.count) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: view.color });
    await chrome.action.setTitle({ tabId, title: view.title });
  } catch {
    /* tab probably closed; nothing useful to do */
  }
}

// chrome.webNavigation gives us the documentId we need to distinguish
// fresh document loads from SPA pushState / bfcache restores. Both
// onCommitted and onHistoryStateUpdated carry a `documentId` that
// stays stable for the life of a document — Chrome reuses it across
// bfcache restores and across pushState URL changes, and mints a new
// one for every actual document load. That's exactly the lifecycle
// chrome.userScripts uses for injection, so keying state on it keeps
// our expected/actual model honest.
//
// We only care about the main frame (frameId === 0). Sub-frame events
// would add noise we don't currently render.
function installNavigationListeners(): void {
  const wn = chrome.webNavigation;
  if (!wn) {
    console.info('[SourceMonkey] chrome.webNavigation not available; falling back to chrome.tabs.onUpdated');
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url) {
        enqueueTabWork(tabId, () => updateTabMatches(tabId, changeInfo.url, null, 'navigation'));
      } else if (changeInfo.status === 'loading' && tab.url) {
        enqueueTabWork(tabId, () => updateTabMatches(tabId, tab.url, null, 'navigation'));
      }
    });
    return;
  }
  wn.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    // Reload fast-path: when the user explicitly reloads (Ctrl-R, toolbar
    // reload, location.reload) Chrome sets
    // transitionType to "reload". We use that to opportunistically check
    // for updated userscripts in time for THIS navigation's injection,
    // rather than waiting for the next reload. Setup is fire-and-forget
    // so the listener stays cheap; the wrapper's sm:check-pending
    // round-trip is what actually waits on the result.
    if (d.transitionType === 'reload' && d.documentId) {
      setupReloadFastPath(d.tabId, d.documentId, d.url);
    }
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation'));
  });
  wn.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation'));
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabWork(tabId, () => clearTabState(tabId));
  // GM_* cross-tab broadcast: drop this tab from every scriptId's
  // openers set so future writes don't try to deliver to a closed
  // tab (broadcast() catches the "Receiving end does not exist"
  // rejection but the lookup work is wasted).
  clearTabFromGmOpeners(tabId);
  // Drop any reload-fast-path entries for this tab so a slow refresh
  // doesn't hold a stale closure indefinitely. Keys are `${tabId}:`
  // prefixed, so a string prefix match is enough.
  const prefix = `${tabId}:`;
  for (const [key, entry] of fastPathByDoc) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(entry.cleanupTimer);
    fastPathByDoc.delete(key);
  }
});

// When the script set itself changes (user clicked Refresh, added a
// directory, etc.) the matches for every open tab may have shifted —
// recompute and re-badge them all, and re-sync chrome.userScripts so
// Chrome's injection set reflects the new state.
//
// Coalesce bursts of changes so that flipping N rows in quick
// succession (e.g. a chrome.storage.local.set that updates N script:*
// keys → one onChanged event, OR several writes from independent
// callers) collapses into a single sync. syncRegistrations is O(total
// scripts) on the SW side AND issues an unregister-all/register-all
// against chrome.userScripts, so coalescing is a meaningful win.
onCacheChanged(() => {
  scheduleSync();
});

let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync(): void {
  if (syncTimer != null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void refreshAllOpenTabs();
    void syncRegistrations();
  }, 50);
}

async function refreshAllOpenTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  // Queue per tab so a script-set change interleaves correctly with
  // any in-flight sm:* report processing for the same tab.
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      const tabId = tab.id;
      const url = tab.url;
      // Pass null documentId — updateTabMatches will reuse the prior
      // state's documentId, which is what we want for a script-set
      // change (the document hasn't navigated). Trigger is 'refresh'
      // so this doesn't fan out into opportunistic filesystem checks
      // for every script on every open tab.
      enqueueTabWork(tabId, () => updateTabMatches(tabId, url, null, 'refresh'));
    }
  }
}

// ---------- Stale-script propagation ----------
// See docs/matching.md#stale-tab-notification for design.
const SCRIPT_PREFIX = 'script:';
function installStaleScriptListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const changedIds: string[] = [];
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(SCRIPT_PREFIX)) continue;
      const before = change.oldValue as StoredScript | undefined;
      const after = change.newValue as StoredScript | undefined;
      // Skip brand-new rows and deletions: nothing to flag stale.
      if (!before || !after) continue;
      // Compare loadedAt (not bodyText): it bumps iff fresh content was
      // actually fetched, so the unchanged-skip path doesn't flap.
      if (before.loadedAt === after.loadedAt) continue;
      changedIds.push(key.slice(SCRIPT_PREFIX.length));
    }
    if (changedIds.length === 0) return;
    void propagateStaleScripts(changedIds);
  });
}

// Per-tab enqueue keeps stale marking ordered with concurrent
// navigation / sm:* updates for the same tab.
async function propagateStaleScripts(scriptIds: string[]): Promise<void> {
  const all = await chrome.storage.session.get(null);
  let affectedTabs = 0;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('tab:')) continue;
    const tabIdStr = key.slice(4);
    const tabId = Number(tabIdStr);
    if (!Number.isFinite(tabId)) continue;
    const record = value as TabRecord | undefined;
    if (!record || !('byDoc' in record)) continue;
    // Check the current doc only — a sm:start from an older doc is rare
    // and that doc is already invisible to the user. Keeps the loop
    // cheap and avoids painting offscreen badges.
    const current = record.byDoc[record.currentDocId];
    if (!current) continue;
    // Mark whether the wrapper reported started OR error — both ran the
    // OLD content, and reloading would pick up the new version. Pages
    // showing only an outdated MISSING row are intentionally NOT
    // promoted; without an actual report there's no "running code" to
    // be stale against, and a reload won't change what the badge shows.
    const relevant = scriptIds.filter((id) => current.actual[id] != null);
    if (relevant.length === 0) continue;
    affectedTabs++;
    enqueueTabWork(tabId, () => applyStaleToTab(tabId, relevant));
  }
  console.log(
    `[SourceMonkey] stale-script change for ${scriptIds.length} script(s); ` +
    `${affectedTabs} tab(s) flagged for reload`,
  );
}

async function applyStaleToTab(tabId: number, scriptIds: string[]): Promise<void> {
  const record = await getTabRecord(tabId);
  if (!record) return;
  const current = record.byDoc[record.currentDocId];
  if (!current) return;
  let next = current;
  for (const id of scriptIds) next = markScriptStale(next, id);
  if (next === current) return;
  const nextRecord: TabRecord = {
    ...record,
    byDoc: { ...record.byDoc, [record.currentDocId]: next },
  };
  await setTabRecord(tabId, nextRecord);
  await renderBadge(tabId, next);
}

// ---------- Reload fast-path ----------
//
// See docs/injection.md#reload-fast-path. When the user explicitly
// reloads a tab, we want updated userscripts to take effect on THIS
// reload rather than the next one. The mechanism:
//
//   1. onCommitted fires with transitionType === 'reload'. We kick off
//      manual updateScript() for every matched userscript on this URL
//      and stash the in-flight promises in `fastPathByDoc[tabId:docId]`.
//      Setup is async (it awaits ensureLoaded + findMatchesForUrl) but
//      doesn't block the listener.
//   2. The wrapper, after Chrome injects it, sends sm:check-pending
//      and awaits the SW's reply. handleCheckPending looks up the
//      fast-path entry, races the matching updateScript promise
//      against RELOAD_FAST_PATH_WINDOW_MS, and replies:
//        - {action: 'run'}             — no fast-path, refresh timed
//                                        out, or refresh saw no change.
//        - {action: 'run-new', body,
//           loadedAt}                  — newer body in storage; wrapper
//                                        evals this instead of its
//                                        baked-in body.
//        - {action: 'skip', reason}    — refresh-driven decision to not
//                                        run (currently unused; held
//                                        for future "file removed"
//                                        semantics).
//
// We deliberately don't await chrome.userScripts re-registration here.
// The storage write inside updateScript already triggers scheduleSync()
// via the storage onChanged listener; that path handles FUTURE
// navigations. For THIS navigation, we just hand the new bodyText
// straight to the wrapper.

const RELOAD_FAST_PATH_WINDOW_MS = 500;
// Conservative TTL for fast-path entries that nobody consumes (script
// got unregistered, wrapper never fired because the URL became
// non-matching after redirect, etc.). 15s is well past any plausible
// runAt window even on document_idle for a slow page.
const RELOAD_FAST_PATH_TTL_MS = 15_000;

interface FastPathScriptEntry {
  promise: Promise<StoredScript | null>;
  settled: boolean;
  result: StoredScript | null;
}

interface FastPathEntry {
  // Reload-commit wall-clock time, NOT setup-completed time. The 500ms
  // window is measured from when the user clicked reload, so a slow
  // ensureLoaded() doesn't extend the budget past what's useful — the
  // wrapper has been waiting since reload commit, not since setup.
  startedAt: number;
  scripts: Map<string, FastPathScriptEntry>;
  // Per-script "has the wrapper already consumed this entry?" guard.
  // A wrapper that calls sm:check-pending twice (eg. after an internal
  // retry) gets {action:'run'} the second time so we don't double-swap.
  consumed: Set<string>;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

const fastPathByDoc = new Map<string, FastPathEntry>();
const fastPathKey = (tabId: number, documentId: string) => `${tabId}:${documentId}`;

function setupReloadFastPath(tabId: number, documentId: string, url: string): void {
  if (!INJECTABLE_SCHEME.test(url)) return;
  // Capture commit-time wall clock BEFORE awaiting anything; we want
  // the 500ms window to track real elapsed time since the user hit
  // reload, not "time since ensureLoaded resolved."
  const startedAt = Date.now();
  void (async () => {
    try {
      await ensureLoaded();
      const matches = findMatchesForUrl(url);
      if (matches.length === 0) return;
      const key = fastPathKey(tabId, documentId);
      // If an entry for this exact (tab, document) somehow already
      // exists (rare — e.g. two onCommitted events for the same doc),
      // leave the FIRST one in place. Wrappers from the first reload
      // are already paired with its updateScript promises; replacing
      // the entry would lose those promises and reset the consumed
      // guard, causing inconsistent decisions across scripts.
      if (fastPathByDoc.has(key)) return;
      const scripts = new Map<string, FastPathScriptEntry>();
      for (const m of matches) {
        const entry: FastPathScriptEntry = {
          // promise gets reassigned on the next line; placeholder keeps
          // the field non-undefined for the type.
          promise: Promise.resolve(null),
          settled: false,
          result: null,
        };
        // .then on the existing promise so we can both expose it to
        // handleCheckPending and observe its result here. Swallow
        // rejections — updateScript already logs failures internally
        // and a refresh error should fall back to "run old body", not
        // surface to the wrapper.
        //
        // Coalescing note: if updateTabMatches' opportunistic check
        // (also queued by this onCommitted) reaches gate() first, its
        // result depends on the cooldown — either it short-circuits
        // (returns null without starting work, so our manual call
        // proceeds fresh) or it's in-flight (and our manual call
        // coalesces onto the same promise). Either way our `entry`
        // observes the real refresh result; the ordering is benign.
        entry.promise = updateScript(m.id, 'manual').then(
          (r) => {
            entry.settled = true;
            entry.result = r;
            return r;
          },
          () => {
            entry.settled = true;
            entry.result = null;
            return null;
          },
        );
        scripts.set(m.id, entry);
      }
      const cleanupTimer = setTimeout(() => {
        fastPathByDoc.delete(key);
      }, RELOAD_FAST_PATH_TTL_MS);
      fastPathByDoc.set(key, {
        startedAt,
        scripts,
        consumed: new Set(),
        cleanupTimer,
      });
      console.log(
        `[SourceMonkey] reload fast-path: checking ${matches.length} script(s) for tab=${tabId} doc=${documentId.slice(0, 8)}`,
      );
    } catch (err) {
      console.info('[SourceMonkey] reload fast-path setup failed:', err);
    }
  })();
}

interface CheckPendingPayload {
  id: string;
  name?: string;
  loadedAt?: number;
  url?: string;
}

type CheckPendingReply =
  | { action: 'run' }
  | { action: 'run-new'; body: string; loadedAt: number }
  | { action: 'skip'; reason: string };

async function handleCheckPending(
  sender: chrome.runtime.MessageSender,
  payload: CheckPendingPayload,
): Promise<CheckPendingReply> {
  const tabId = sender.tab?.id;
  const documentId = (sender as { documentId?: string }).documentId ?? '';
  if (tabId == null || !documentId) return { action: 'run' };
  const key = fastPathKey(tabId, documentId);
  const entry = fastPathByDoc.get(key);
  if (!entry) return { action: 'run' };
  const scriptEntry = entry.scripts.get(payload.id);
  if (!scriptEntry) return { action: 'run' };
  if (entry.consumed.has(payload.id)) return { action: 'run' };
  entry.consumed.add(payload.id);
  // If every matched script has now consumed its entry, clear the
  // record proactively so a follow-up wrapper from a different document
  // doesn't accidentally hit our consumed-set guard. The TTL is the
  // backstop for the case where one wrapper never fires.
  if (entry.consumed.size >= entry.scripts.size) {
    clearTimeout(entry.cleanupTimer);
    fastPathByDoc.delete(key);
  }
  const wrapperLoadedAt = typeof payload.loadedAt === 'number' ? payload.loadedAt : 0;
  let refreshed: StoredScript | null = null;
  if (scriptEntry.settled) {
    // updateScript already finished while we were waiting on Chrome to
    // inject the wrapper — no race needed.
    refreshed = scriptEntry.result;
  } else {
    const elapsed = Date.now() - entry.startedAt;
    const remaining = RELOAD_FAST_PATH_WINDOW_MS - elapsed;
    if (remaining <= 0) {
      console.log(
        `[SourceMonkey] reload fast-path: ${payload.name ?? payload.id} window already elapsed (${elapsed}ms); running prior version`,
      );
      return { action: 'run' };
    }
    let timedOut = false;
    const winner = await Promise.race<StoredScript | null | 'timeout'>([
      scriptEntry.promise,
      new Promise<'timeout'>((res) => setTimeout(() => {
        timedOut = true;
        res('timeout');
      }, remaining)),
    ]);
    if (timedOut || winner === 'timeout') {
      // Important: the updateScript promise keeps running. If it later
      // finds a new version, storage.onChanged → scheduleSync still
      // fires, so the NEXT reload will pick it up. We just give up
      // waiting on it for THIS navigation.
      console.log(
        `[SourceMonkey] reload fast-path: ${payload.name ?? payload.id} update not detected within ${RELOAD_FAST_PATH_WINDOW_MS}ms; running prior version`,
      );
      return { action: 'run' };
    }
    refreshed = winner;
  }
  if (!refreshed) return { action: 'run' };
  if (refreshed.status !== 'ok') return { action: 'run' };
  if (refreshed.loadedAt <= wrapperLoadedAt) return { action: 'run' };
  console.log(
    `[SourceMonkey] reload swap: ${payload.name ?? payload.id} loadedAt ${wrapperLoadedAt} -> ${refreshed.loadedAt}`,
  );
  return {
    action: 'run-new',
    // Send the same composed body the injector would have registered:
    // any `@require` bodies prepended before the main script body.
    // Sending only `bodyText` here means the eval'd swap can't see
    // globals the requires set up, and any reference to them throws
    // ReferenceError — the script then "works" only on the next
    // reload because by then the registered code includes the new
    // body via syncRegistrations.
    body: composeRequiredBody(refreshed),
    loadedAt: refreshed.loadedAt,
  };
}

// ---------- GM_xmlhttpRequest dispatch ----------

interface XhrStartPayload {
  id: string;
  scriptId: string;
  request: GmXhrRequestPayload;
}

async function handleXhrStart(
  sender: chrome.runtime.MessageSender,
  payload: XhrStartPayload,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) {
    console.info('[SourceMonkey] gm-xhr-start without tab id; ignoring');
    return;
  }
  // @connect URL gating. Pull the script's stored header so we know
  // which hosts it's allowed to talk to. A script that hasn't
  // declared @connect is blocked from every cross-origin host —
  // matches VM policy. The error event we ship back is the
  // same shape as a network failure, so the userscript's onerror
  // catches it.
  const denyReason = await checkConnectPolicy(payload.scriptId, payload.request.url);
  if (denyReason) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'sm:gm-xhr-event',
        id: payload.id,
        event: { kind: 'error', message: `[SourceMonkey] blocked by @connect policy: ${denyReason}` },
      });
    } catch { /* tab gone */ }
    return;
  }
  // Run the fetch and ship the result back to the sender's tab. Other
  // tabs do not get a copy — XHR is per-call, not broadcast.
  const event = await runXhr(payload.id, payload.request);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'sm:gm-xhr-event',
      id: payload.id,
      event,
    });
  } catch {
    // Sender tab closed or otherwise unreachable. Drop quietly —
    // there's nobody to deliver to.
  }
}

// Returns null when allowed, or a human-readable reason when denied.
async function checkConnectPolicy(scriptId: string, url: string): Promise<string | null> {
  try {
    const script = await getScript(scriptId);
    if (!script || !script.header) {
      return 'script not found or has no parsed header';
    }
    const rules = parseConnectRules(script.header);
    const selfHosts = extractSelfHosts(script.header);
    const decision = isUrlConnectAllowed(url, rules, selfHosts);
    if (decision.allowed) return null;
    return decision.reason;
  } catch (err) {
    return `policy check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------- GM_* storage batched writes + cross-tab broadcast ----------

interface BatchWriteEntry {
  key: string;
  value?: unknown;
  deleted?: boolean;
}

interface BatchWritePayload {
  scriptId: string;
  writes: BatchWriteEntry[];
}

// In-memory openers table: scriptId -> set of tabIds that currently
// have a wrapper for this script running. Updated on sm:start
// (recordScriptReport, below) and on tab close. We don't track per-
// frame because chrome.tabs.sendMessage broadcasts to every frame in
// a tab — frame-level filtering can land later if it's worth it.
//
// State is in-memory only. On SW restart the table starts empty;
// the table re-fills as sm:start reports arrive from existing
// documents (Chrome resumes userscripts on resumes). A short window
// after a write-burst-then-SW-restart may miss broadcasts to other
// tabs — acceptable; reads still see the value at next register.
const gmOpeners = new Map<string, Set<number>>();

function registerOpener(scriptId: string, tabId: number): void {
  let s = gmOpeners.get(scriptId);
  if (!s) { s = new Set(); gmOpeners.set(scriptId, s); }
  s.add(tabId);
}

function clearTabFromGmOpeners(tabId: number): void {
  for (const [scriptId, set] of gmOpeners) {
    if (set.delete(tabId) && set.size === 0) gmOpeners.delete(scriptId);
  }
}

async function handleBatchWrite(
  payload: BatchWritePayload,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true }> {
  // Translate the wire format ({key, value | deleted: true}) into the
  // SW-internal `ValueWrite` shape that uses a sentinel-by-reference
  // for deletes. We hand-roll the translation here so the gm-values
  // module stays wire-format-agnostic.
  const internal: ValueWrite[] = payload.writes.map((w) => ({
    key: w.key,
    value: w.deleted ? DELETED_SENTINEL : w.value,
  }));
  await applyBatchValues(payload.scriptId, internal);
  // Broadcast the delta to every OTHER tab running this script.
  // The originating tab already has the writes applied in its
  // page-side cache (it issued the writes); broadcasting back would
  // be redundant and could feed back through value-change listeners.
  const senderTabId = sender.tab?.id;
  broadcastValueUpdate(payload.scriptId, payload.writes, senderTabId);
  return { ok: true };
}

function broadcastValueUpdate(
  scriptId: string,
  writes: readonly BatchWriteEntry[],
  excludeTabId: number | undefined,
): void {
  const targets = gmOpeners.get(scriptId);
  if (!targets || targets.size === 0) return;
  // Fire-and-forget per tab. chrome.tabs.sendMessage delivers to
  // every frame on the tab and each frame's runtime listener
  // dispatches by scriptId locally. "Receiving end does not exist"
  // rejections are normal (tab closed mid-send, frame torn down)
  // and silently dropped.
  for (const tabId of targets) {
    if (tabId === excludeTabId) continue;
    void chrome.tabs.sendMessage(tabId, {
      type: 'sm:gm-value-update',
      scriptId,
      writes,
    }).catch(() => undefined);
  }
}

// ---------- sm:start / sm:error from injected wrappers ----------
//
// Messages from the USER_SCRIPT world arrive on the dedicated
// `onUserScriptMessage` event — NOT on `chrome.runtime.onMessage`.
// Listening on the wrong event manifests as "Receiving end does not
// exist" on every wrapper send. The event surface only exists once
// the "userScripts" permission is active; guard so SW startup survives
// older Chromes / permission-revoked states without blowing up the
// rest of the bootstrap.
function installScriptMessageListener(): void {
  const ev = chrome.runtime.onUserScriptMessage as
    | chrome.runtime.ExtensionMessageEvent | undefined;
  if (!ev || typeof ev.addListener !== 'function') {
    console.info('[SourceMonkey] chrome.runtime.onUserScriptMessage not available; skipping listener install');
    return;
  }
  ev.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const type = (msg as { type?: unknown }).type;
    if (type === SM_CHECK_PENDING_MSG) {
      // Async reply path. Return true keeps the message channel open
      // until sendResponse fires. Swallow any send failures — they
      // typically mean the tab navigated away or the wrapper's
      // document was torn down, in which case nobody is listening
      // for the reply anyway.
      const payload = msg as CheckPendingPayload;
      handleCheckPending(sender, payload).then(
        (reply) => { try { sendResponse(reply); } catch { /* receiver gone */ } },
        (err) => {
          console.info('[SourceMonkey] check-pending handler threw:', err);
          try { sendResponse({ action: 'run' }); } catch { /* receiver gone */ }
        },
      );
      return true;
    }
    if (type === 'sm:gm-xhr-start') {
      // GM_xmlhttpRequest dispatch. Ack the start synchronously so
      // the message channel doesn't stay pinned open for the entire
      // request (a long XHR would otherwise hold the port for
      // minutes). The actual load/error/abort event arrives later
      // via chrome.tabs.sendMessage. Fire-and-forget the SW work.
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      void handleXhrStart(sender, msg as XhrStartPayload).catch((err) => {
        console.info('[SourceMonkey] gm-xhr-start handler threw:', err);
      });
      return false;
    }
    if (type === 'sm:gm-xhr-abort') {
      const payload = msg as { id?: string };
      if (typeof payload.id === 'string') abortXhr(payload.id);
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return true;
    }
    if (type === 'sm:gm-batch-write') {
      // Batched storage flush from the page-side cache. Same
      // return-true keep-channel-open pattern as check-pending —
      // the wrapper doesn't actually await the reply today
      // (fire-and-forget), but returning a real {ok} keeps the
      // channel honest for future error surfacing.
      handleBatchWrite(msg as BatchWritePayload, sender).then(
        (reply) => { try { sendResponse(reply); } catch { /* receiver gone */ } },
        (err) => {
          console.info('[SourceMonkey] gm-batch-write handler threw:', err);
          try { sendResponse({ ok: false, error: String(err?.message ?? err) }); } catch { /* receiver gone */ }
        },
      );
      return true;
    }
    if (
      type !== SM_START_MSG &&
      type !== SM_ERROR_MSG &&
      type !== SM_SWAPPED_MSG &&
      type !== SM_ABANDONED_MSG
    ) return;
    // Keep the inline cast in sync with `recordScriptReport`'s param
    // type so a rename of the wrapper field is caught at compile time
    // rather than silently dropping through the unknown-typed cast.
    const payload = msg as {
      id: string;
      name?: string;
      url?: string;
      message?: string;
      stack?: string;
      loadedAt?: number;
      fromLoadedAt?: number;
      reason?: string;
    };
    enqueueTabWork(tabId, () => recordScriptReport(tabId, sender, type, payload));
  });
}

// Combine the wrapper's message + stack into the multiline string that
// goes into the per-script log. V8/SpiderMonkey both prepend the
// message to the stack ("Error: foo\n    at …"), so the stack is the
// most-complete view. We dedup the case where the stack DOESN'T begin
// with the message (Safari historically; user-thrown non-Error values
// that synthesized a stack) by prepending the message when missing.
// First-line-only check is deliberately tighter than `stack.includes`:
// a very short message ("in", "ok") would otherwise substring-match
// somewhere deep in the stack and we'd drop the prepend, losing the
// throw payload from the log.
function composeWrapperErrorMessage(
  message: string | undefined,
  stack: string | undefined,
): string {
  const msg = message ?? '';
  const st = stack ?? '';
  if (!st) return msg || 'unknown runtime error';
  const firstLine = st.split('\n', 1)[0];
  if (msg && !firstLine.includes(msg)) return `${msg}\n${st}`;
  return st;
}

async function recordScriptReport(
  tabId: number,
  sender: chrome.runtime.MessageSender,
  type:
    | typeof SM_START_MSG
    | typeof SM_ERROR_MSG
    | typeof SM_SWAPPED_MSG
    | typeof SM_ABANDONED_MSG,
  payload: {
    id: string;
    name?: string;
    url?: string;
    message?: string;
    stack?: string;
    loadedAt?: number;
    fromLoadedAt?: number;
    reason?: string;
  },
): Promise<void> {
  const id = payload.id;
  if (!id) return;
  const name = String(payload.name ?? id);
  // sender.url is the document URL where the wrapper sent from; prefer
  // it over payload.url because Chrome sets it.
  const senderUrl = sender.url ?? payload.url ?? '';
  // sender.documentId is set on chrome.runtime messages (incl.
  // onUserScriptMessage) as of Chrome 106+. It's the same ID that
  // chrome.webNavigation reports, so we can use it to tell which
  // document the wrapper belongs to.
  const senderDocId = (sender as { documentId?: string }).documentId ?? '';

  const tabPart = ` tab=${tabId}`;
  const label = getScriptLogLabel(id);
  // GM_* cross-tab broadcast openers table: register the
  // (scriptId, tabId) pair on EITHER sm:start or sm:swapped. The
  // swap path is a wrapper that just took control of a document
  // and needs the same pairing so future writes can fan out to it.
  if (type === SM_START_MSG || type === SM_SWAPPED_MSG) {
    registerOpener(id, tabId);
  }
  if (type === SM_START_MSG) {
    console.log(`[SourceMonkey] start ${label}${tabPart} ${senderUrl}`);
    logScriptEvent(id, {
      level: 'info',
      source: 'wrapper',
      tabId,
      message: `started at ${senderUrl}`,
    });
  } else if (type === SM_SWAPPED_MSG) {
    // The reload swap path. Log alongside sm:start so the SW console
    // tells the full story when reading a transcript.
    console.log(
      `[SourceMonkey] swapped ${label}${tabPart} ${senderUrl} ` +
      `(loadedAt ${payload.fromLoadedAt ?? '?'} -> ${payload.loadedAt ?? '?'})`,
    );
    logScriptEvent(id, {
      level: 'info',
      source: 'wrapper',
      tabId,
      message: `reload-swap from loadedAt ${payload.fromLoadedAt ?? '?'} to ${payload.loadedAt ?? '?'}`,
    });
  } else if (type === SM_ABANDONED_MSG) {
    // SW told the wrapper to skip. Surface at info-level — this is rare
    // and worth knowing about, but it isn't an error.
    console.log(
      `[SourceMonkey] abandoned ${label}${tabPart} ${senderUrl} (reason=${payload.reason ?? '?'})`,
    );
    logScriptEvent(id, {
      level: 'warning',
      source: 'wrapper',
      tabId,
      message: `abandoned (reason=${payload.reason ?? '?'})`,
    });
  } else {
    // console.info (not console.warn / .error) so a userscript runtime
    // failure — which is a bug in user-supplied code we're relaying —
    // doesn't bubble up to chrome://extensions/?errors as if SourceMonkey
    // itself had thrown. Chrome surfaces both .warn and .error from the
    // SW into the Errors panel; only .info / .log stay out of it. The
    // badge already surfaces the failure to the user; the Errors panel
    // should be reserved for actual extension bugs.
    console.info(`[SourceMonkey] error ${label}${tabPart} ${senderUrl}: ${payload.message ?? ''}`);
    // The stack (when present) typically starts with a line that already
    // contains the message (e.g. "Error: foo\n    at HTMLBtn..."), so
    // we prefer it as-is. Fall back to message-only when the engine
    // didn't give us a stack — older browsers / errors thrown from
    // primitive values won't carry one.
    logScriptEvent(id, {
      level: 'error',
      source: 'wrapper',
      tabId,
      message: composeWrapperErrorMessage(payload.message, payload.stack),
    });
  }

  // sm:abandoned is logging-only — there's no "actual" report to merge
  // and no badge change. Returning here keeps the rest of the function
  // focused on the run / error / swapped reports.
  if (type === SM_ABANDONED_MSG) return;

  // Closes the race where storage updates land BEFORE sm:start arrives.
  // See docs/matching.md#closing-the-report-after-change-race.
  // Guard against falsy loadedAt (0 / NaN) — every production write
  // bumps loadedAt to Date.now(), so a non-positive value means an old
  // wrapper that predates this field or a test fixture, neither of
  // which we want to compare against.
  const wrapperLoadedAt = typeof payload.loadedAt === 'number' && payload.loadedAt > 0
    ? payload.loadedAt : null;
  let isStale = false;
  // sm:swapped means the wrapper just ran the freshest content, so a
  // stored.loadedAt that matches the payload.loadedAt is expected and
  // does NOT make this report stale. Skip the check for that branch.
  if (wrapperLoadedAt != null && type !== SM_SWAPPED_MSG) {
    const stored = await getScript(id);
    if (stored && stored.loadedAt > wrapperLoadedAt) {
      isStale = true;
      console.log(
        `[SourceMonkey] sm:${type === SM_START_MSG ? 'start' : 'error'} is from outdated content for ${name} ` +
        `(wrapper=${wrapperLoadedAt} stored=${stored.loadedAt}); flagging tab=${tabId} as needing reload`,
      );
    }
  }

  const record = await getTabRecord(tabId);
  let state = getDocState(record, senderDocId);
  if (!state) {
    // Bootstrap: sm:start arrived before webNavigation.onCommitted
    // landed (SW cold start, or simple ordering race), or the
    // wrapper's document was evicted from the per-tab LRU. Synthesise
    // a state from the sender; if onCommitted later fires for this
    // same documentId, it'll see the entry via getDocState and merge
    // matches / preserve actual.
    if (!senderUrl || !INJECTABLE_SCHEME.test(senderUrl)) return;
    await ensureLoaded();
    state = {
      documentId: senderDocId,
      url: senderUrl,
      matches: findMatchesForUrl(senderUrl),
      actual: {},
    };
  }
  const report: ActualStatus = type === SM_ERROR_MSG
    ? { state: 'error', name, message: String(payload.message ?? '') }
    : { state: 'started', name };
  let next = applyScriptReport(state, id, report);
  if (type === SM_SWAPPED_MSG) {
    // The swap landed the latest body, so any prior stale marker for
    // this id (e.g. from an earlier sm:start on this same documentId)
    // no longer reflects reality.
    next = clearScriptStale(next, id);
  } else if (isStale) {
    next = markScriptStale(next, id);
  }
  // writeDocState (not setCurrentDoc) — a late sm:* from a doc we've
  // already navigated away from updates its stored state but doesn't
  // steal the badge from the doc currently on screen.
  const nextRecord = writeDocState(record, senderDocId, next);
  await setTabRecord(tabId, nextRecord);
  if (nextRecord.currentDocId === senderDocId) {
    await renderBadge(tabId, next);
  }
}

// Log-ID listener and its initial load come first so subsequent
// startup paths (sm:start arriving from a pre-existing wrapper, the
// first navigation-driven log line) can hit the populated map. The
// fallback in getScriptLogLabel makes this best-effort, not required
// for correctness.
installScriptLogIdListener();
void ensureLogIdsLoaded();
installStorageListener();
installStaleScriptListener();
installNavigationListeners();
installScriptMessageListener();
installDebugLoggingListener();
// Kick off the initial cache load so the very first navigation doesn't
// pay the read-everything cost on the critical path. The injector sync
// runs in parallel so registrations are in place ASAP after SW startup.
void ensureLoaded();
void syncRegistrations();
void loadDebugLoggingFlag();

// background.ts is compiled as an ES module (declared via
// `"type": "module"` in manifest.json's service_worker entry). The
// explicit empty export keeps tsc treating this file as a module
// even if every real import/export is removed later.
export {};
