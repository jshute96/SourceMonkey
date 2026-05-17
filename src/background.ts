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
  ensureLoaded,
  findMatchesForUrl,
  installStorageListener,
  onCacheChanged,
  type MatchedScript,
} from './match-index.js';
import {
  syncRegistrations,
  VM_ERROR_MSG,
  VM_START_MSG,
} from './injector.js';
import {
  applyScriptReport,
  computeBadge,
  getDocState,
  mergeMatches,
  setCurrentDoc,
  writeDocState,
  type ActualStatus,
  type TabMatchState,
  type TabRecord,
} from './tab-status.js';

interface VibeMonkeyApi {
  version: string;
  // Round-trip echo used by the smoke test to confirm the SW is alive
  // and `self.VibeMonkey` is reachable from `serviceWorker.evaluate`.
  ping: (value?: string) => string;
  // Test/debug hook: force a tab badge refresh against an arbitrary URL.
  matchesFor: (url: string) => Promise<MatchedScript[]>;
}

const api: VibeMonkeyApi = {
  version: chrome.runtime.getManifest().version,
  ping: (value = 'pong') => value,
  matchesFor: async (url) => {
    await ensureLoaded();
    return findMatchesForUrl(url);
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
async function updateTabMatches(
  tabId: number,
  url: string | undefined,
  documentId: string | null,
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
  const state: TabMatchState = { documentId: docId, url, matches, actual };
  const nextRecord = setCurrentDoc(record, docId, state);
  await setTabRecord(tabId, nextRecord);
  if (incoming.length > 0) {
    const tag = restored ? ' restored' : '';
    console.log(
      `[VibeMonkey] ${incoming.length} matching script(s) for ${url} (doc=${docId || '?'}${tag}):`,
      incoming.map((m) => m.name),
    );
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
        enqueueTabWork(tabId, () => updateTabMatches(tabId, changeInfo.url, null));
      } else if (changeInfo.status === 'loading' && tab.url) {
        enqueueTabWork(tabId, () => updateTabMatches(tabId, tab.url, null));
      }
    });
    return;
  }
  wn.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null));
  });
  wn.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null));
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
      // change (the document hasn't navigated).
      enqueueTabWork(tabId, () => updateTabMatches(tabId, url, null));
    }
  }
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
    const payload = msg as { id: string; name?: string; url?: string; message?: string };
    enqueueTabWork(tabId, () => recordScriptReport(tabId, sender, type, payload));
  });
}

async function recordScriptReport(
  tabId: number,
  sender: chrome.runtime.MessageSender,
  type: typeof VM_START_MSG | typeof VM_ERROR_MSG,
  payload: { id: string; name?: string; url?: string; message?: string },
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
    console.error(`[VibeMonkey] error id=${id}${tabPart} ${senderUrl}: ${payload.message ?? ''}`);
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
  const next = applyScriptReport(state, id, report);
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
