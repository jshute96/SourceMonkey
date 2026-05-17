// VibeMonkey MV3 service worker.
//
// Today the SW does two real jobs:
//   - Opens the options page on toolbar click (no popup configured).
//   - Watches every tab navigation, finds matching userscripts via the
//     in-memory match index, and surfaces the count as a per-tab badge
//     plus a per-tab tooltip. Per-tab match state is persisted to
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
  installMessageListener as installInjectorMessageListener,
  syncRegistrations,
} from './injector.js';

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

// ---------- Per-tab badge + tooltip for matching scripts ----------

// Match Tampermonkey's orange-ish badge color so the visual is familiar.
const BADGE_COLOR = '#f57c00';

// Only attempt matching for URLs we could conceivably inject into. This
// skips chrome://, about:, view-source:, etc. without forcing every
// pattern in every script to filter them out.
const INJECTABLE_SCHEME = /^(https?|file|ftp):/i;

const tabKey = (tabId: number) => `tab:${tabId}`;

interface TabMatchState {
  url: string;
  matches: MatchedScript[];
}

async function updateTabMatches(tabId: number, url: string | undefined): Promise<void> {
  if (!url || !INJECTABLE_SCHEME.test(url)) {
    await setBadge(tabId, []);
    await clearTabState(tabId);
    return;
  }
  await ensureLoaded();
  const matches = findMatchesForUrl(url);
  // Per the user's spec: log the matches we found.
  if (matches.length > 0) {
    console.log(
      `[VibeMonkey] ${matches.length} matching script(s) for ${url}:`,
      matches.map((m) => m.name),
    );
  }
  await setBadge(tabId, matches);
  await chrome.storage.session.set({
    [tabKey(tabId)]: { url, matches } satisfies TabMatchState,
  });
}

async function setBadge(tabId: number, matches: MatchedScript[]): Promise<void> {
  const text = matches.length > 0 ? String(matches.length) : '';
  // Each setX call can reject if the tab closed between our query and
  // here; swallow that rather than spamming the SW console.
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    }
    const title = ['VibeMonkey', ...matches.map((m) => m.name)].join('\n');
    await chrome.action.setTitle({ tabId, title });
  } catch {
    /* tab probably closed; nothing useful to do */
  }
}

async function clearTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(tabKey(tabId));
}

// tabs.onUpdated fires for many reasons; we only care when the URL
// actually changed (full navigation) or, as a backup, when the tab
// enters the 'loading' state with a URL we hadn't seen yet.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    void updateTabMatches(tabId, changeInfo.url);
  } else if (changeInfo.status === 'loading' && tab.url) {
    void updateTabMatches(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabState(tabId);
});

// When the script set itself changes (user clicked Refresh, added a
// directory, etc.) the matches for every open tab may have shifted —
// recompute and re-badge them all, and re-sync chrome.userScripts so
// Chrome's injection set reflects the new state.
onCacheChanged(() => {
  void refreshAllOpenTabs();
  void syncRegistrations();
});

async function refreshAllOpenTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) => (tab.id !== undefined ? updateTabMatches(tab.id, tab.url) : Promise.resolve())),
  );
}

installStorageListener();
installInjectorMessageListener();
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
