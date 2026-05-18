// VibeMonkey MV3 service worker.
//
// Today the SW does two real jobs:
//   - Opens the options page on toolbar click (no popup configured).
//   - Watches every tab navigation, finds matching userscripts via the
//     in-memory match index, listens to vm:start / vm:error reports
//     from injected wrappers, and surfaces the combined state as a
//     per-tab badge + tooltip. Per-tab state is persisted to
//     chrome.storage.session so it survives SW restarts but is dropped
//     when Chrome shuts down.
//
// The `self.VibeMonkey` surface exists so e2e tests can drive the
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
  isUserScriptsAvailable,
  syncRegistrations,
  VM_ERROR_MSG,
  VM_START_MSG,
} from './injector.js';
import {
  applyScriptReport,
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

interface VibeMonkeyApi {
  version: string;
  // Round-trip echo used by the smoke test to confirm the SW is alive
  // and `self.VibeMonkey` is reachable from `serviceWorker.evaluate`.
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
}

const api: VibeMonkeyApi = {
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

(self as unknown as { VibeMonkey: VibeMonkeyApi }).VibeMonkey = api;

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
// updates, vm:* reports, removals) go through enqueueTabWork so they
// run strictly in order. Without this, two vm:start messages that
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
    console.log(
      `[VibeMonkey] ${incoming.length} matching script(s) for ${url} (doc=${docId || '?'}${tag}):`,
      incoming.map((m) => m.name),
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
      await chrome.action.setTitle({ tabId, title: 'VibeMonkey' });
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
    console.warn('[VibeMonkey] chrome.webNavigation not available; falling back to chrome.tabs.onUpdated');
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
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation'));
  });
  wn.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation'));
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabWork(tabId, () => clearTabState(tabId));
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
  // any in-flight vm:* report processing for the same tab.
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
// navigation / vm:* updates for the same tab.
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
    // Check the current doc only — a vm:start from an older doc is rare
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
    `[VibeMonkey] stale-script change for ${scriptIds.length} script(s); ` +
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

// ---------- vm:start / vm:error from injected wrappers ----------
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
    console.warn('[VibeMonkey] chrome.runtime.onUserScriptMessage not available; skipping listener install');
    return;
  }
  ev.addListener((msg, sender) => {
    if (!msg || typeof msg !== 'object') return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const type = (msg as { type?: unknown }).type;
    if (type !== VM_START_MSG && type !== VM_ERROR_MSG) return;
    // Keep the inline cast in sync with `recordScriptReport`'s param
    // type so a rename of the wrapper field is caught at compile time
    // rather than silently dropping through the unknown-typed cast.
    const payload = msg as { id: string; name?: string; url?: string; message?: string; loadedAt?: number };
    enqueueTabWork(tabId, () => recordScriptReport(tabId, sender, type, payload));
  });
}

async function recordScriptReport(
  tabId: number,
  sender: chrome.runtime.MessageSender,
  type: typeof VM_START_MSG | typeof VM_ERROR_MSG,
  payload: { id: string; name?: string; url?: string; message?: string; loadedAt?: number },
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
  if (type === VM_START_MSG) {
    console.log(`[VibeMonkey] start id=${id}${tabPart} ${senderUrl}`);
  } else {
    // console.warn (not console.error) so a userscript runtime failure
    // — which is a bug in user-supplied code we're relaying — doesn't
    // bubble up to chrome://extensions/?errors as if VibeMonkey itself
    // had thrown. The badge already surfaces the failure to the user;
    // the Errors panel should be reserved for actual extension bugs.
    console.warn(`[VibeMonkey] error id=${id}${tabPart} ${senderUrl}: ${payload.message ?? ''}`);
  }

  // Closes the race where storage updates land BEFORE vm:start arrives.
  // See docs/matching.md#closing-the-report-after-change-race.
  // Guard against falsy loadedAt (0 / NaN) — every production write
  // bumps loadedAt to Date.now(), so a non-positive value means an old
  // wrapper that predates this field or a test fixture, neither of
  // which we want to compare against.
  const wrapperLoadedAt = typeof payload.loadedAt === 'number' && payload.loadedAt > 0
    ? payload.loadedAt : null;
  let isStale = false;
  if (wrapperLoadedAt != null) {
    const stored = await getScript(id);
    if (stored && stored.loadedAt > wrapperLoadedAt) {
      isStale = true;
      console.log(
        `[VibeMonkey] vm:${type === VM_START_MSG ? 'start' : 'error'} is from outdated content for ${name} ` +
        `(wrapper=${wrapperLoadedAt} stored=${stored.loadedAt}); flagging tab=${tabId} as needing reload`,
      );
    }
  }

  const record = await getTabRecord(tabId);
  let state = getDocState(record, senderDocId);
  if (!state) {
    // Bootstrap: vm:start arrived before webNavigation.onCommitted
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
  const report: ActualStatus = type === VM_START_MSG
    ? { state: 'started', name }
    : { state: 'error', name, message: String(payload.message ?? '') };
  let next = applyScriptReport(state, id, report);
  if (isStale) next = markScriptStale(next, id);
  // writeDocState (not setCurrentDoc) — a late vm:* from a doc we've
  // already navigated away from updates its stored state but doesn't
  // steal the badge from the doc currently on screen.
  const nextRecord = writeDocState(record, senderDocId, next);
  await setTabRecord(tabId, nextRecord);
  if (nextRecord.currentDocId === senderDocId) {
    await renderBadge(tabId, next);
  }
}

installStorageListener();
installStaleScriptListener();
installNavigationListeners();
installScriptMessageListener();
// Kick off the initial cache load so the very first navigation doesn't
// pay the read-everything cost on the critical path. The injector sync
// runs in parallel so registrations are in place ASAP after SW startup.
void ensureLoaded();
void syncRegistrations();

// background.ts is compiled as an ES module (declared via
// `"type": "module"` in manifest.json's service_worker entry). The
// explicit empty export keeps tsc treating this file as a module
// even if every real import/export is removed later.
export {};
