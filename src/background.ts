// SourceMonkey MV3 service worker.
//
// Today the SW does these real jobs:
//   - Opens the collections page on toolbar click (no popup configured).
//   - Watches every tab navigation, finds matching userscripts via the
//     in-memory match index, listens to sm:start / sm:error reports
//     from injected wrappers, and surfaces the combined state as a
//     per-tab badge + tooltip. Per-tab state is persisted to
//     chrome.storage.session so it survives SW restarts but is dropped
//     when Chrome shuts down.
//   - Mirrors the badge's per-script status lines into the toolbar
//     icon's right-click menu (chrome.contextMenus, action context),
//     so users can jump to a script's viewer page without going
//     through the collections page first.
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
import { startPhaseTimer, resetPhaseTotals, reportPhaseTotals } from './phase-timing.js';
import {
  installGithubAuthListener,
  ensureGithubAuthTokenLoaded,
} from './github-auth.js';
import {
  LOCAL_ROOTS_KEY,
  _setLocalRootsForTests,
  installLocalRootsListener,
  loadLocalRootsSetting,
  rootsFromText,
} from './local-file-overrides.js';
import { installDeepLinkRedirect } from './deep-link.js';
import { REJECTIONS_KEY, readRejections, type RejectionMap } from './script-rejection.js';
import { readRefreshErrors, type RefreshErrorMap } from './refresh-error.js';
import { installUserJsCapture } from './install-capture.js';
import {
  HTTP_READ_MESSAGE,
  handleHttpReadRequest,
  type HttpReadRequest,
} from './http-read.js';
import { checkParses, resetParseCheckFailures } from './parse-check.js';
import { buildParseCheckSource } from './injector.js';
import { attachParseLocation } from './parse-location.js';
import {
  isParseCheckDisabled,
  setParseCheckDisabled,
  type ParseVerdict,
} from './parse-check-protocol.js';
import type { ParseChecker } from './script-store.js';
import {
  ensureLogIdsLoaded,
  getScriptLogLabel,
  installScriptLogIdListener,
} from './script-log-id.js';
import {
  buildSwapEvalBody,
  resolveWorld,
  forgetRegistrationState,
  isUserScriptsAvailable,
  lastSyncKindForTests,
  resetRejectionRetryGate,
  syncRegistrations,
  unregisterAllRegistrations,
  SM_ABANDONED_MSG,
  SM_CHECK_PENDING_MSG,
  SM_ERROR_MSG,
  SM_GM_LOG_MSG,
  SM_START_MSG,
  SM_SWAPPED_MSG,
  type SyncScope,
} from './injector.js';
import {
  applyScriptReport,
  BADGE_PURPLE,
  BADGE_RED,
  clearScriptStale,
  computeBadge,
  formatRowLabel,
  getCurrentState,
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
  replayScriptLogsAtBoot,
  requestOpportunisticScriptChecks,
  updateAllCollections,
  updateScript,
  updateCollection,
} from './script-updater.js';
import type { ProbePolicy } from './version-probe.js';
import {
  getDirectoryListingFetches,
  resetDirectoryListingFetches,
} from './directories.js';
import {
  addCollection,
  createRefreshBatch,
  getCollectionRowReads,
  resetCollectionRowReads,
  type RefreshBatch,
  getScript,
  getCollections,
  getCollectionWithScripts,
  isFirstRunComplete,
  resetCollectionKeyMigrationForTests,
  _setCollectionWriteFailureForTests,
  markFirstRunComplete,
  removeCollection,
  setScriptEnabled,
  setCollectionEnabled,
  setCollectionLocalFiles,
  describeError,
  type AddCollectionResult,
  type StoredScript,
  type StoredCollection,
  setParseChecker,
} from './script-store.js';
import {
  appendScriptLog,
  clearScriptLog,
  getScriptLog,
  logScriptEvent,
  _flushScriptLogQueueForTests,
  type AppendLogInput,
  type LogEntry,
} from './script-log.js';
import {
  applyBatchValues,
  DELETED_SENTINEL,
  isDeletionSentinel,
  loadAllValues,
  type ValueWrite,
} from './gm-values.js';
import {
  abortXhr,
  abortXhrsForTab,
  runXhr,
  type GmXhrRequestPayload,
} from './gm-xhr.js';
import { clearStaleHeaderRules } from './gm-xhr-headers.js';
import {
  connectBlockedMessage,
  extractSelfHosts,
  gmXhrError,
  isUrlConnectAllowed,
  parseConnectRules,
} from './gm-connect.js';
import {
  closeGmTab,
  dropOriginator as dropOriginatorTabs,
  openGmTab,
  takeRequestForClosedTab,
  type GmTabOpenPayload,
} from './gm-tab.js';
import {
  dropOriginator as dropOriginatorNotifications,
  NOTIFICATIONS_UNAVAILABLE,
  showGmNotification,
  takeForClicked as takeNotificationForClicked,
  takeForClosed as takeNotificationForClosed,
  type GmNotificationShowPayload,
} from './gm-notification.js';
import {
  abortGmDownload,
  dropOriginator as dropOriginatorDownloads,
  handleDownloadChanged,
  startGmDownload,
  type GmDownloadEvent,
  type GmDownloadStartPayload,
} from './gm-download.js';
import {
  clearTab as clearMenuCommandsForTab,
  findMenuCommand,
  getMenuCommandsForTab,
  registerMenuCommand,
  unregisterMenuCommand,
  type MenuCommandEntry,
} from './gm-menu.js';
import { installUrlChangeWatch } from './gm-url-change.js';
import {
  closeGmWindow,
  focusGmWindow,
  SM_WINDOW_CLOSE_MSG,
  SM_WINDOW_FOCUS_MSG,
  type WindowControlResult,
} from './gm-window-control.js';
import {
  ACTION_MENU_MORE_LABEL,
  planActionMenu,
  type ActionMenuPlan,
  type ActionMenuScript,
} from './action-menu.js';

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
  // tests would have to navigate to the collections page for every
  // state transition, which is both slow and couples tests to the
  // page's DOM. All of them delegate straight to the production
  // functions — they are not test-only logic, just convenience
  // accessors.
  //
  // Production exposure: the manifest has no `externally_connectable`
  // entry, so neither web pages nor other extensions can reach the SW
  // to call these. Practically callable only from DevTools on an
  // extension page or from Playwright's `serviceWorker.evaluate`.
  addCollection: (path: string) => Promise<AddCollectionResult>;
  removeCollection: (id: string) => Promise<void>;
  getCollections: () => Promise<StoredCollection[]>;
  getCollectionWithScripts: (id: string) => Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null>;
  setCollectionEnabled: (id: string, enabled: boolean) => Promise<StoredCollection | null>;
  setCollectionLocalFiles: (id: string, localFiles: boolean) => Promise<StoredCollection | null>;
  setLocalRoots: (paths: string[]) => Promise<void>;
  setScriptEnabled: (id: string, enabled: boolean) => Promise<StoredScript | null>;
  updateCollection: (id: string, mode: 'manual' | 'opportunistic') => Promise<unknown>;
  // `probe` mirrors the production signature: `'force'` is what a real
  // Refresh click passes, and several behaviors key off it (upstream
  // version probes, and retrying a refused registration immediately
  // rather than under the rate limit). Tests modelling a click have to
  // be able to say so.
  updateScript: (
    id: string,
    mode: 'manual' | 'opportunistic',
    probe?: ProbePolicy,
  ) => Promise<unknown>;
  updateAllCollections: (mode: 'manual' | 'opportunistic') => Promise<unknown>;
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
  // debounce in scheduleSync(). Tests use this after addCollection /
  // updateScript / setCollectionEnabled so the navigation that follows
  // can't out-race the debounced registration.
  syncNow: () => Promise<{ registered: { id: string }[]; kind: 'full' | 'incremental' | null }>;
  // Re-run the SW-boot startup-log replay. Tests use this after
  // seeding a script with diagnostics to verify the Log-tab population
  // path without having to actually restart the SW.
  replayScriptLogsAtBoot: () => Promise<void>;
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
  // Registrations chrome.userScripts refused on the last sync, keyed by
  // script id — the state the UI renders as REJECTED. Empty unless
  // something is broken, which is what most tests assert.
  getRejections: () => Promise<RejectionMap>;
  // Collections whose last refresh was read but could not be saved,
  // keyed by collection id (src/refresh-error.ts). Empty unless a
  // storage write failed, which is what most tests assert.
  getRefreshErrors: () => Promise<RefreshErrorMap>;
  // Make every collection-refresh write fail, so a test can drive the
  // out-of-quota path without having to actually fill 10 MB. Stays armed
  // until cleared with null, matching a real exhausted quota — which
  // fails every collection, not just the next one.
  failCollectionWrites: (message: string | null) => Promise<void>;
  // Compile-only parse check (src/parse-check.ts). Null means the
  // check could not run, which callers must not read as failure.
  checkParses: (sources: string[]) => Promise<ParseVerdict[] | null>;
  // Turn the install-time parse check off, so a test can drive a
  // script that fails to parse all the way to injection and exercise
  // the run-time sentinel backstop. Covers the checkers in extension
  // pages too, and resets itself with the session storage
  // `resetAllState` clears.
  setParseCheckEnabled: (enabled: boolean) => Promise<void>;
  // How many source compiles have run this session. Lets a test tell
  // a cached verdict from a fresh one.
  getParseCheckRuns: () => number;
  clearScriptLog: (scriptId: string) => Promise<void>;
  // Every PERSISTED GM value for a script, excluding the in-flight
  // overlay. Tests wait on this for the wrapper's batched write to land
  // rather than pausing — the batch fires 150ms after the last write and
  // its timing moves with machine load.
  getGmValues: (scriptId: string) => Promise<Record<string, unknown>>;
  // Dedup-aware log label (`foo.user.js`, `foo.user.js#2`). Which
  // script in a dupe group gets which `#N` is decided by UUID sort, so
  // a test that needs the label cannot predict it — it has to ask.
  getScriptLogLabel: (scriptId: string) => Promise<string>;
  // GM_registerMenuCommand test surface. Playwright can't click the
  // real Chrome action context menu, so tests need a way to (a) read
  // back what we would have rendered for a tab and (b) synthesize the
  // chrome.contextMenus.onClicked dispatch.
  getActionContextMenu: (tabId: number) => Promise<{
    scriptId: string;
    commands: MenuCommandEntry[];
  }[]>;
  // Inspect the planned action context menu for `tabId`, including the
  // overflow split into a "More" submenu. Tests use this to verify the
  // 6-item-limit packing without driving the real Chrome menu UI.
  // Reads the planner inputs directly — does NOT go through the
  // serialized rebuild coalescer, so a value here reflects intent, not
  // the chrome.contextMenus state mid-rebuild. Tests that race a
  // register with this call should poll via `waitFor`. Also: the plan
  // is computed for the given tab regardless of whether it's the
  // currently-active one (production rendering only happens for the
  // active tab — see `rebuildActionContextMenu`).
  getActionContextMenuPlan: (tabId: number) => Promise<ActionMenuPlan>;
  fireActionContextMenuItem: (
    tabId: number,
    scriptId: string,
    commandId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  // Test-only fault injection: when true, the check-pending handler's
  // snapshot read throws, mimicking the "SW snapshot unavailable"
  // failure mode. Used by tests/e2e/gm-storage-freshness.spec.ts to
  // verify the wrapper hard-aborts cleanly rather than running with
  // empty storage. No production caller flips this.
  setDebugForceSnapshotFailure: (value: boolean) => void;
  // Test-only: drop the in-memory GM_* openers table and un-latch its
  // hydration, which is exactly the state a freshly-started service
  // worker is in. Lets a test reproduce the "worker was evicted between
  // the tabs loading and the write" case without killing the worker
  // (which would also kill the test's handle on it).
  dropGmOpenersForTests: () => Promise<void>;
  // Test-only fault injection: when true, `broadcastValueUpdate` sends
  // nothing, standing in for a broadcast that never reached the other
  // tab. Drives the resync-recovery test. No production caller flips it.
  setDebugSuppressGmBroadcast: (value: boolean) => void;
  // Fires the same all-tabs resync nudge the worker sends on startup.
  // Tests can't restart the worker without losing their handle on it.
  nudgeGmResync: () => Promise<void>;
  // How many `file://` directory listings THIS WORKER has fetched
  // successfully since the last reset. Cache hits don't count, so a test
  // can assert that a page matching several scripts in one folder listed
  // it once rather than once per script (see `RefreshBatch`).
  //
  // Counts every listing the worker does — recursive collection scans
  // included, not just the batched per-script stats — so a test has to
  // reset around the window it cares about. Listings done in an
  // extension page (where user-initiated single-script checks run) never
  // reach this number.
  getDirectoryListingFetches: () => number;
  resetDirectoryListingFetches: () => void;
  // The other half of what a batch shares: collection rows
  // `refreshScript` actually read from storage, batch hits excluded.
  // Same scoping caveats as the listing counter above.
  getCollectionRowReads: () => number;
  resetCollectionRowReads: () => void;
}

const api: SourceMonkeyApi = {
  version: chrome.runtime.getManifest().version,
  ping: (value = 'pong') => value,
  matchesFor: async (url) => {
    await ensureLoaded();
    return findMatchesForUrl(url);
  },
  addCollection,
  removeCollection,
  getCollections,
  getCollectionWithScripts,
  setCollectionEnabled,
  setCollectionLocalFiles,
  // Write the real setting so the production read path is what's under
  // test, AND push it into the module cache directly: `storage.onChanged`
  // delivery isn't ordered against the call that follows, and a test
  // that adds a collection on the next line must not race it.
  setLocalRoots: async (paths: string[]) => {
    // Through the same text→array parse the options page's Save runs,
    // so what's stored is exactly what a real save would store.
    const roots = rootsFromText(paths.join('\n')) ?? [];
    await chrome.storage.local.set({ [LOCAL_ROOTS_KEY]: roots });
    _setLocalRootsForTests(roots);
  },
  setScriptEnabled,
  updateCollection,
  updateScript,
  updateAllCollections,
  getTabState: async (tabId: number) => {
    const [badgeText, badgeColor, title, record] = await Promise.all([
      chrome.action.getBadgeText({ tabId }),
      chrome.action.getBadgeBackgroundColor({ tabId }),
      chrome.action.getTitle({ tabId }),
      getTabRecord(tabId),
    ]);
    return { badgeText, badgeColor, title, record };
  },
  // Drains this script's in-flight appends before reading. Production
  // log writes go through `logScriptEvent`, which is deliberately
  // fire-and-forget — a refresh must not wait on its own transcript —
  // so `updateCollection()` can resolve before the entry it just
  // produced has landed. A test that reads straight after would be
  // asserting on a log that is still being written.
  getScriptLog: async (scriptId: string) => {
    await _flushScriptLogQueueForTests(scriptId);
    return getScriptLog(scriptId);
  },
  appendScriptLog,
  getRejections: readRejections,
  getRefreshErrors: readRefreshErrors,
  failCollectionWrites: async (message: string | null) => {
    _setCollectionWriteFailureForTests(message);
  },
  clearScriptLog,
  getGmValues: loadAllValues,
  // `scriptLogLabel`, not `getScriptLogLabel` — the awaited form, so a
  // test never races the id table and gets a UUID prefix back.
  getScriptLogLabel: scriptLogLabel,
  checkParses,
  setParseCheckEnabled: async (enabled: boolean) => {
    await setParseCheckDisabled(!enabled);
    // Anything registered while the checker was off was never gated by
    // it, and an incremental sync only revisits the rows that moved —
    // so drop the record and let the next sync reconcile fully. See
    // `forgetRegistrationState`.
    forgetRegistrationState();
  },
  getParseCheckRuns: () => parseCheckRuns,
  getActionContextMenu: async (tabId: number) => {
    const cmdsByScript = getMenuCommandsForTab(tabId);
    const out: { scriptId: string; commands: MenuCommandEntry[] }[] = [];
    for (const [scriptId, commands] of cmdsByScript) {
      out.push({ scriptId, commands: commands.slice() });
    }
    return out;
  },
  getActionContextMenuPlan: async (tabId: number) => {
    const record = await getTabRecord(tabId);
    const state = getCurrentState(record);
    return buildActionMenuPlan(state, tabId, await rejectedScriptIds());
  },
  fireActionContextMenuItem: async (tabId, scriptId, commandId) => {
    // Goes through the same dispatchActionMenuCommand helper the real
    // click handler uses — same validation, same message shape. Test
    // assertions can rely on the result instead of polling page state.
    return await dispatchActionMenuCommand(tabId, scriptId, commandId);
  },
  debugMatchIndex: async (url: string) => {
    await ensureLoaded();
    return {
      matches: findMatchesForUrl(url).map((m) => ({ id: m.id, name: m.name })),
      cache: debugDumpCache(),
    };
  },
  setDebugForceSnapshotFailure,
  dropGmOpenersForTests: resetGmOpenersState,
  setDebugSuppressGmBroadcast: (value: boolean) => { __debugSuppressGmBroadcast = !!value; },
  // The unthrottled sweep: a test drives it on demand, where the
  // once-a-minute rate limit on the startup path would just make the
  // call silently do nothing.
  nudgeGmResync,
  getDirectoryListingFetches,
  resetDirectoryListingFetches,
  getCollectionRowReads,
  resetCollectionRowReads,
  syncNow: async () => {
    // Cancel any pending debounced sync first — otherwise its work
    // would fire just after we return, and a test that does
    // addCollection → syncNow → page.goto could see the registration
    // briefly disappear mid-navigation. Tests rely on syncNow being the
    // LAST sync until the next mutation.
    if (syncTimer != null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    // Mirror scheduleSync's full work — both the chrome.userScripts
    // re-registration AND the open-tab badge recompute — so callers
    // don't need to know which side effect they care about. Including
    // its scope: this flushes the debounced sync rather than replacing
    // it with a different one, so tests exercise the same incremental
    // path production takes.
    await Promise.all([syncRegistrations(takePendingScope()), refreshAllOpenTabs()]);
    // `kind` says which path that sync took. The two leave the same
    // registration set behind — which is the point — so a test meaning
    // to pin the incremental path has no other way to say it took it.
    const kind = lastSyncKindForTests();
    if (!isUserScriptsAvailable()) return { registered: [], kind };
    const list = await chrome.userScripts.getScripts();
    return { registered: list.map((s) => ({ id: s.id })), kind };
  },
  replayScriptLogsAtBoot,
  resetAllState: async () => {
    // The parse check re-enables itself: its off-switch lives in the
    // session storage cleared below, precisely so no context has to
    // remember to restore it. The circuit breaker does have to be
    // reset by hand — it's a module variable in the worker, so a case
    // that deliberately wedges the sandbox would otherwise leave the
    // check off for every later test in this worker.
    parseCheckRuns = 0;
    resetParseCheckFailures();
    // Same reason: a retry from the previous test would otherwise
    // rate-limit the next one's out of existence.
    resetRejectionRetryGate();
    // Also a module variable in the worker, so a test that armed the
    // write failure would otherwise break every refresh after it. (The
    // recorded errors themselves live in the session storage cleared
    // below, so they need no separate reset.)
    _setCollectionWriteFailureForTests(null);
    // Same: a test that suppressed cross-tab value broadcasts would
    // otherwise leave every later test's broadcast dropped.
    __debugSuppressGmBroadcast = false;
    // Same again: a counter, so a test that reads it without resetting
    // would otherwise inherit the previous test's listings and assert
    // against the wrong baseline.
    resetDirectoryListingFetches();
    resetCollectionRowReads();
    // Cancel any pending debounced sync first — clear() below will
    // schedule another one via onCacheChanged, so leaving the old
    // timer armed risks two syncs firing back-to-back and racing the
    // next test's setup.
    if (syncTimer != null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    // Before the clears below, so a mirror write that was still queued
    // lands first and gets wiped with everything else rather than
    // re-seeding `sm:gm-openers` just after.
    await resetGmOpenersState();
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    // The legacy-key migration memo describes the profile we just
    // wiped, so drop it — otherwise a test that seeds pre-rename rows
    // would find nothing willing to move them.
    resetCollectionKeyMigrationForTests();
    // The clear above fires `storage.onChanged`, which would reset the
    // cached roots — but not necessarily before the next test's first
    // call. Drop them synchronously so a reset is a clean slate the
    // moment it returns.
    _setLocalRootsForTests([]);
    // Mark first-run seeding as already done so a later SW restart
    // doesn't repopulate the deliberately-emptied store with the default
    // collections. A reset is meant to leave a clean slate, and re-seeding
    // would contradict that. (This stops future seed runs from starting;
    // a seed already in flight from the boot before this reset isn't
    // cancelled — the in-loop flag re-check narrows but can't fully
    // close that window.) Tests that want the defaults seed explicitly.
    await markFirstRunComplete();
    // Tear down whatever Chrome currently has registered so the next
    // test doesn't inherit injections from the previous one. The
    // storage.onChanged listener will also fire syncRegistrations() in
    // response to the clear, but that races test setup — doing it
    // ourselves here is deterministic.
    //
    // Through the injector so the teardown queues behind any sync
    // that's already running rather than wiping the set out from under
    // it (and then having that sync re-register everything we just
    // dropped).
    try {
      await unregisterAllRegistrations();
    } catch {
      /* ignore */
    }
    // Cancel the post-clear scheduled sync that the onChanged listener
    // just armed. Without this it would fire ~50 ms into the next
    // test, potentially mid-addCollection.
    if (syncTimer != null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    // And drop the ids the clear just queued: the injector has
    // forgotten what it registered, so the next sync is a full
    // reconcile and a scope naming the wiped rows would only confuse
    // the next test's.
    takePendingScope();
  },
};

(self as unknown as { SourceMonkey: SourceMonkeyApi }).SourceMonkey = api;

// Clicking the toolbar icon opens the collections page (the extension's
// declared `options_ui.page`). We have no popup configured, so
// onClicked fires on every action click; openOptionsPage honors
// `options_ui.open_in_tab` (true) and focuses an existing tab if one
// is already open.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// First run: open the collections page so the user lands somewhere
// useful instead of an empty toolbar, and so the page can seed the
// default collections through the normal add → Refresh flow (see
// `seedDefaultCollectionsViaUi` in collections.ts). The `?first_run`
// param is the seeding trigger — only this auto-opened page carries it,
// so an ordinary collections-page visit never re-seeds. Gated by the
// persisted flag (not just the install reason) because
// unpacked-extension reloads re-fire onInstalled with reason 'install';
// without the flag check every dev reload would reopen the tab.
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[SourceMonkey] onInstalled (reason=${details.reason})`);
  if (details.reason !== 'install') return;
  void (async () => {
    if (await isFirstRunComplete()) {
      console.log(
        '[SourceMonkey] first run already complete (firstRunComplete=true); ' +
        'not opening the collections page. Clear that storage key to re-seed.',
      );
      return;
    }
    console.log(
      '[SourceMonkey] first run detected — opening collections.html?first_run=1 ' +
      'so the page can seed the default collections',
    );
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('collections.html?first_run=1'),
      });
    } catch (err) {
      console.info('[SourceMonkey] failed to open first-run collections page:', err);
    }
  })();
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
  // The commit's shared refresh batch, passed by the `onCommitted`
  // listener. The SAME object the reload fast path got, when that
  // commit was a reload: two batches for one commit would halve the
  // duplication rather than remove it. Omitted by the other callers
  // (`onHistoryStateUpdated`, the `chrome.tabs.onUpdated` fallback,
  // `refreshAllOpenTabs`), in which case the opportunistic fan-out
  // makes its own — so none of them runs unbatched.
  batch?: RefreshBatch,
): Promise<void> {
  // Above the non-injectable early return: leaving the flashing
  // document for a `chrome://` page is still leaving it. No repaint of
  // its own — both paths below end in renderBadge, which paints
  // whatever the flash state is by then.
  clearReloadFlashForOtherDoc(tabId, documentId ?? '');
  if (!url || !INJECTABLE_SCHEME.test(url)) {
    // Drop menu commands BEFORE renderBadge: the rebuild that
    // renderBadge schedules reads getMenuCommandsForTab() at flush
    // time, so clearing first guarantees the same flush sees an empty
    // mirror. The renderBadge rebuild with state=null produces zero
    // script rows (and therefore zero indented command rows) anyway,
    // but the order keeps the SW's `getMenuCommandsForTab(tabId)`
    // test-surface read consistent with what the menu shows.
    clearMenuCommandsForTab(tabId);
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
  // Menu-command mirror: the one invariant is that it holds commands
  // for the document the tab is on NOW. The wrapper's callbacks live
  // in that document, so a mirror pointing anywhere else renders rows
  // that can never fire.
  //
  // One rule covers every case, keyed on the document being entered:
  //   - fresh document → the old document's commands go, and the new
  //     wrapper re-registers from scratch;
  //   - bfcache restore back to an EARLIER document → the later
  //     document's commands go too, which `restored` alone would have
  //     kept (they'd render as dead rows);
  //   - SPA pushState within the same document → mirror matches, kept,
  //     which is the page-side "callbacks survive" lifecycle.
  //
  // Scoped to "anything that isn't this document" rather than an
  // unconditional wipe because we got here after several awaits: a
  // document-end wrapper in the new document can beat us to
  // registering, and dropping those registrations would leave the tab
  // with no menu commands until the next navigation — nothing resends
  // them.
  //
  // Gated on `trigger`, not on whether we know the documentId — those
  // are different questions:
  //   - 'refresh' (`refreshAllOpenTabs` after a script-set change) is
  //     not a navigation at all. The document didn't change, so the
  //     mirror is still correct and must be left alone.
  //   - 'navigation' with no documentId is the `chrome.tabs.onUpdated`
  //     fallback for a Chrome without `webNavigation`. A navigation
  //     DID happen and we can't say to what, so `''` falls through to
  //     the unconditional clear — stale commands must not outlive the
  //     document that registered them.
  if (trigger === 'navigation') {
    clearMenuCommandsForTab(tabId, documentId ?? '');
    // The new document's wrapper will resend sm:gm-menu-register from
    // scratch; until then the active tab's menu should reflect the
    // cleared mirror. renderBadge at the end of this function takes
    // care of the rebuild when tabId is the active one — we don't
    // need a separate refresh here.
  }
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
    requestOpportunisticScriptChecks(incoming.map((m) => m.id), batch);
  }
  await renderBadge(tabId, state);
}

// The scripts Chrome is currently refusing to register, as a set for
// the badge. Read per paint rather than cached: it changes rarely and
// a stale copy would keep painting REJECTED after a fix landed.
async function rejectedScriptIds(): Promise<ReadonlySet<string>> {
  return new Set(Object.keys(await readRejections()));
}

async function renderBadge(tabId: number, state: TabMatchState | null): Promise<void> {
  // Each setX call can reject if the tab closed between our query and
  // here; swallow that rather than spamming the SW console.
  try {
    if (!state || (state.matches.length === 0 && Object.keys(state.actual).length === 0)) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'SourceMonkey' });
    } else {
      const view = computeBadge(state, await rejectedScriptIds());
      // The reload flash is a paint-time override, not part of the
      // computed view: it says "an update is landing right now", which
      // is a property of the swap in flight rather than of the tab's
      // expected/actual sets. RED still wins — an error the user has
      // to act on outranks a transient progress signal.
      const color = view.color !== BADGE_RED && isReloadFlashing(tabId)
        ? BADGE_PURPLE : view.color;
      await chrome.action.setBadgeText({ tabId, text: String(view.count) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
      await chrome.action.setTitle({ tabId, title: view.title });
    }
  } catch {
    /* tab probably closed; nothing useful to do */
  }
  // Action context-menu items are a global property of the action, not
  // per-tab — so we only rebuild them when this tab is the one the user
  // is currently looking at. Out-of-band updates (background tabs
  // reporting sm:start, refresh fan-outs) skip the rebuild.
  if (tabId === activeTabId) {
    rebuildActionContextMenu(state);
  }
}

// ---------- Action context-menu (per active tab) ----------
//
// Right-clicking the SourceMonkey toolbar icon should list the scripts
// that apply to the current tab, mirroring the badge tooltip's
// "{name} | {status}" lines. Clicking one opens that script's viewer
// page in a new tab.
//
// chrome.contextMenus items with `contexts: ['action']` are global —
// they apply to whatever tab is active when the user right-clicks. So
// we keep them in sync with the active tab: rebuild on tab activation,
// window focus change, and any renderBadge() for the active tab.

let activeTabId: number | null = null;
const ACTION_MENU_PREFIX = 'sm-script:';
const ACTION_MENU_CMD_PREFIX = 'sm-menucmd:';
// chrome.contextMenus.create id for the overflow parent. Fixed (rather
// than generated per rebuild) so `createScriptGroupMenuItems` can
// reference it as `parentId` without threading a value through.
const ACTION_MENU_MORE_ID = 'sm-more';
// Indent + glyph for nested menu-command rows. Chrome preserves the
// leading whitespace in context-menu titles; four spaces + ↳ reads as
// "indented under the row above" at typical zoom rather than as a
// top-level entry. Applied at every level (top + inside More) because
// the submenu nesting only shows "this lives under More" — it does
// NOT visually distinguish a script row from its command rows, so the
// ↳ prefix is what tells the user which commands belong to which
// script inside the submenu too.
const ACTION_MENU_CMD_INDENT = '    ↳ ';

function viewerUrlForScript(scriptId: string, tab?: 'log'): string {
  const url = new URL(chrome.runtime.getURL('userscript.html'));
  url.searchParams.set('script', scriptId);
  // `#Log` is parsed by src/script-url-hash.ts and lands the viewer on
  // the Log pane. Used when the user clicks a context-menu row that's
  // currently reporting a per-tab injection ERROR so they go straight
  // to the failure details.
  if (tab === 'log') url.hash = 'Log';
  return url.toString();
}

// Maps a menu item's id (which is what chrome.contextMenus.onClicked
// hands us) back to the (scriptId, commandId) it was created for. We
// can't stash that on the menu item itself — chrome.contextMenus has
// no custom-data field — so we keep our own mapping and refresh it
// every rebuild.
const menuItemToCommand = new Map<string, { scriptId: string; commandId: string }>();

// Script IDs whose action-menu row was rendered with the per-tab
// injection ERROR status (per `formatRowLabel`/`computeBadge`). When
// the user clicks one of these the dispatcher routes them to the
// viewer's Log tab instead of the main script tab so the failure
// reason is immediately on screen. Rebuilt on every menu rebuild so
// stale entries can't outlive their row.
const erroredScriptRows = new Set<string>();

// Rebuilds are serialized AND coalesced. Two concurrent rebuilds would
// race: removeAll/create is async-via-callback, and once both callbacks
// are queued, the second `create` loop can collide with the first
// rebuild's same-ID items (chrome.contextMenus.create reports
// duplicate-id via runtime.lastError, silently). Bursts (Ctrl-Tab spam,
// rapid sm:* fan-out) collapse to one trailing rebuild — only the
// most-recently-requested state is applied after the in-flight one
// finishes.
let menuRebuildRunning = false;
let menuRebuildPending: { state: TabMatchState | null; tabId: number | null } | null = null;

function rebuildActionContextMenu(state: TabMatchState | null): void {
  // Snapshot the active tab at request time. The rebuild reads
  // per-tab menu commands from gm-menu.ts, so it has to know which
  // tab the state belongs to — using a fresh `activeTabId` at flush
  // time could pull commands from a tab that's no longer current.
  menuRebuildPending = { state, tabId: activeTabId };
  if (menuRebuildRunning) return;
  void runMenuRebuildLoop();
}

async function runMenuRebuildLoop(): Promise<void> {
  menuRebuildRunning = true;
  try {
    while (menuRebuildPending) {
      const target = menuRebuildPending;
      menuRebuildPending = null;
      await doRebuildActionContextMenu(target.state, target.tabId);
    }
  } finally {
    menuRebuildRunning = false;
  }
}

// Build the planned action menu for `state` + `tabId`. Pure aside
// from the gm-menu lookup; shared by the live rebuild path and the
// `getActionContextMenuPlan` test surface so both see the same packing.
function buildActionMenuPlan(
  state: TabMatchState | null,
  tabId: number | null,
  rejected: ReadonlySet<string>,
): ActionMenuPlan {
  const rows = state ? computeBadge(state, rejected).rows : [];
  const cmdsByScript: ReadonlyMap<string, readonly MenuCommandEntry[]> =
    tabId != null ? getMenuCommandsForTab(tabId) : new Map();
  const groups: ActionMenuScript[] = rows.map((row) => ({
    scriptId: row.id,
    title: formatRowLabel(row),
    errored: row.status === 'ERROR',
    commands: (cmdsByScript.get(row.id) ?? []).map((cmd) => ({
      commandId: cmd.commandId,
      title: cmd.name,
    })),
  }));
  return planActionMenu(groups);
}

async function doRebuildActionContextMenu(
  state: TabMatchState | null,
  tabId: number | null,
): Promise<void> {
  if (!chrome.contextMenus) return;
  const plan = buildActionMenuPlan(state, tabId, await rejectedScriptIds());
  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => resolve()));
  menuItemToCommand.clear();
  erroredScriptRows.clear();
  // Top-level script groups. Each script row is followed by its
  // indented menu-command rows in registration order.
  for (const group of plan.top) {
    createScriptGroupMenuItems(group, undefined);
  }
  // Overflow: a single "More" parent, then every overflowed group
  // nested beneath it. Commands keep the same "↳" indent inside the
  // submenu — the submenu nesting only shows "lives under More," not
  // which commands belong to which script row.
  if (plan.more.length > 0) {
    chrome.contextMenus.create({
      id: ACTION_MENU_MORE_ID,
      title: ACTION_MENU_MORE_LABEL,
      contexts: ['action'],
    });
    for (const group of plan.more) {
      createScriptGroupMenuItems(group, ACTION_MENU_MORE_ID);
    }
  }
}

function createScriptGroupMenuItems(
  group: ActionMenuScript,
  parentId: string | undefined,
): void {
  const scriptItem: chrome.contextMenus.CreateProperties = {
    id: ACTION_MENU_PREFIX + group.scriptId,
    title: group.title,
    contexts: ['action'],
  };
  if (parentId) scriptItem.parentId = parentId;
  chrome.contextMenus.create(scriptItem);
  if (group.errored) erroredScriptRows.add(group.scriptId);
  for (const cmd of group.commands) {
    const menuItemId = `${ACTION_MENU_CMD_PREFIX}${group.scriptId}:${cmd.commandId}`;
    menuItemToCommand.set(menuItemId, { scriptId: group.scriptId, commandId: cmd.commandId });
    const cmdItem: chrome.contextMenus.CreateProperties = {
      id: menuItemId,
      title: ACTION_MENU_CMD_INDENT + cmd.title,
      contexts: ['action'],
    };
    if (parentId) cmdItem.parentId = parentId;
    chrome.contextMenus.create(cmdItem);
  }
}

async function refreshActiveTabMenu(): Promise<void> {
  if (activeTabId == null) {
    rebuildActionContextMenu(null);
    return;
  }
  const record = await getTabRecord(activeTabId);
  rebuildActionContextMenu(getCurrentState(record));
}

function installActionContextMenu(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.onClicked.addListener((info) => {
    const id = typeof info.menuItemId === 'string' ? info.menuItemId : '';
    if (id.startsWith(ACTION_MENU_CMD_PREFIX)) {
      handleActionMenuCommandClick(id);
      return;
    }
    if (id.startsWith(ACTION_MENU_PREFIX)) {
      const scriptId = id.slice(ACTION_MENU_PREFIX.length);
      // Rows currently reporting per-tab injection ERROR land on the
      // Log tab so the user sees why; everything else opens on the
      // default (main script) view.
      const tab = erroredScriptRows.has(scriptId) ? 'log' : undefined;
      // Caught rather than dropped: an unhandled rejection in the SW
      // lands in chrome://extensions/?errors the same as one in a page.
      // The target is our own viewer page, so a failure here is not
      // something the user can act on — hence info, not a surface.
      chrome.tabs.create({ url: viewerUrlForScript(scriptId, tab) })
        .catch((err) => console.info('[SourceMonkey] could not open the viewer:', describeError(err)));
      return;
    }
  });
  chrome.tabs.onActivated.addListener((info) => {
    activeTabId = info.tabId;
    void refreshActiveTabMenu();
  });
  if (chrome.windows && chrome.windows.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        activeTabId = tab?.id ?? null;
      } catch {
        activeTabId = null;
      }
      void refreshActiveTabMenu();
    });
  }
  // Seed the active-tab id on SW startup so the very first right-click
  // (before any tab event fires) gets the right menu.
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      activeTabId = tab?.id ?? null;
    } catch {
      activeTabId = null;
    }
    void refreshActiveTabMenu();
  })();
}

// User clicked a "↳ <name>" sub-entry. Resolve which (scriptId,
// commandId) it belongs to and route through the shared
// dispatchActionMenuCommand so the real-click path and the test
// surface (`fireActionContextMenuItem`) validate and message
// identically.
function handleActionMenuCommandClick(menuItemId: string): void {
  const mapping = menuItemToCommand.get(menuItemId);
  if (!mapping) return;
  const tabId = activeTabId;
  if (tabId == null) return;
  void dispatchActionMenuCommand(tabId, mapping.scriptId, mapping.commandId);
}

// Single source of truth for "fire this menu command on this tab".
// Validates the entry is still registered (script may have called
// unregister between the menu showing and the click firing) and sends
// the wrapper-side sm:gm-menu-fire message. Both the real-click path
// and the test surface call this — divergence between them would let
// tests claim coverage they don't actually have.
async function dispatchActionMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!findMenuCommand(tabId, scriptId, commandId)) {
    // Not user-facing today, so not recased: the real click path
    // (`dispatchActionMenuCommand` in the context-menu handler) discards
    // this reply, and only the test surface reads it. If it ever reaches
    // a person, it takes a capital like any other message.
    return { ok: false, error: 'this menu command is no longer registered' };
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'sm:gm-menu-fire',
      scriptId,
      commandId,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
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
  // `@grant window.onurlchange` feeds off the same-document navigation
  // events too, but needs `onReferenceFragmentUpdated` as well and
  // targets the exact frame that changed rather than filtering to the
  // main one — so it owns its own subscriptions rather than sharing
  // the tab-status listener below. Called before the no-webNavigation
  // early return so it reports its own unavailability. See
  // src/gm-url-change.ts.
  installUrlChangeWatch();
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
    // ONE batch for this commit, shared by both fan-outs it starts. The
    // reload fast path and the opportunistic sweep check the same
    // script set from the same navigation, so a batch each would leave
    // the page listing its folder twice — better than once per script,
    // but not the intent. Created here, referenced only by these two
    // calls, so it dies with the navigation. See `RefreshBatch`.
    const batch = createRefreshBatch();
    // Reload fast-path: when the user explicitly reloads (Ctrl-R, toolbar
    // reload, location.reload) Chrome sets
    // transitionType to "reload". We use that to opportunistically check
    // for updated userscripts in time for THIS navigation's injection,
    // rather than waiting for the next reload. Setup is fire-and-forget
    // so the listener stays cheap; the wrapper's sm:check-pending
    // round-trip is what actually waits on the result.
    if (d.transitionType === 'reload' && d.documentId) {
      setupReloadFastPath(d.tabId, d.documentId, d.url, batch);
    }
    enqueueTabWork(
      d.tabId,
      () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation', batch),
    );
  });
  wn.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation'));
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabWork(tabId, () => clearTabState(tabId));
  // GM_registerMenuCommand: the page-side callbacks are gone with the
  // document, so the SW-side mapping is dead weight after close. Drop
  // before the menu rebuild below so a stale list can't reappear.
  clearMenuCommandsForTab(tabId);
  // Drop the active-tab reference if it was this one. chrome.tabs.onActivated
  // normally fires immediately for the new active tab and overwrites this,
  // but during window-close paths Chrome can remove a tab without a paired
  // activation event; null'ing here keeps the next right-click from
  // resolving against a dead tabId.
  if (tabId === activeTabId) {
    activeTabId = null;
    void refreshActiveTabMenu();
  }
  // GM_* cross-tab broadcast: drop this tab from every scriptId's
  // openers set so future writes don't try to deliver to a closed
  // tab (broadcast() catches the "Receiving end does not exist"
  // rejection but the lookup work is wasted).
  clearTabFromGmOpeners(tabId);
  // GM_openInTab / GM_notification: drop any per-originator state
  // pointing at this tab. The tabs we opened on its behalf stay
  // open (matches TM/VM); we just lose the ability to route close
  // notifications back to a tab that no longer exists.
  dropOriginatorTabs(tabId);
  dropOriginatorNotifications(tabId);
  // GM_download: stop tracking this tab's transfers. They keep running
  // (a download the user started is theirs to keep) — we just have
  // nowhere left to route progress / completion events.
  dropOriginatorDownloads(tabId);
  // GM_xmlhttpRequest: cancel this tab's in-flight requests. Unlike a
  // download, nobody benefits from one finishing — the page that asked
  // is gone, so the response has nowhere to go — and letting it run on
  // would hold its request-header rule live and its URL's gate shut
  // against other scripts until the server answered.
  abortXhrsForTab(tabId);
  // GM_openInTab close-event routing: if this tabId was a tab we
  // opened on behalf of a userscript, dispatch sm:gm-tab-closed to
  // the originating tab so its onclose fires. Folded into this
  // listener (rather than a second onRemoved.addListener) so we
  // don't depend on cross-listener dispatch order.
  const taken = takeRequestForClosedTab(tabId);
  if (taken) {
    void chrome.tabs.sendMessage(taken.originatorTabId, {
      type: 'sm:gm-tab-closed',
      requestId: taken.requestId,
    }).catch(() => undefined);
  }
  // Drop the reload flash: there's no badge left to repaint, and its
  // backstop timer would keep the SW alive for nothing.
  dropReloadFlash(tabId);
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
// callers) collapses into a single sync — and, since the sync is
// scoped to the rows that moved, into a single scope covering all of
// them.
onCacheChanged((change) => {
  for (const id of change.scriptIds) pendingScriptIds.add(id);
  for (const id of change.collectionIds) pendingCollectionIds.add(id);
  scheduleSync();
});

// Repaint open tabs when the set of refused registrations changes, so a
// REJECTED badge clears the moment a retry places the script (and
// appears the moment one stops registering). Without this the badge
// would keep its old label until the next navigation, contradicting the
// collections page beside it.
//
// Session area only: this is the injector's rejection map, and script
// content changes come through `onCacheChanged` above.
if (chrome.storage.session.onChanged) {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (REJECTIONS_KEY in changes) void refreshAllOpenTabs();
  });
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
// Rows that have moved since the last sync ran. Handed to
// `syncRegistrations` so it re-registers only those scripts; anything
// still registered and unmentioned is left strictly alone.
const pendingScriptIds = new Set<string>();
const pendingCollectionIds = new Set<string>();

// Drain the accumulated scope.
//
// An EMPTY scope when nothing is pending, never `undefined`. Those are
// not the same request: `undefined` asks for a full reconcile, which
// rebuilds and re-offers every spec — and re-offering a spec Chrome
// already refused writes another identical row into that script's Log,
// because every refused attempt is reported (see `logRejection`).
//
// Nothing pending means nothing has changed since the last sync, so the
// honest answer is "no rows to reconsider", which does no work and
// touches nothing. `syncNow` reaches here after the debounced sync has
// already drained the scope, and that is exactly when the duplicate
// used to appear.
//
// An empty scope is still a full reconcile when the injector has no
// record of what it last registered — that decision lives there, and
// depends on knowledge this side doesn't have.
function takePendingScope(): SyncScope {
  const scope = {
    scriptIds: [...pendingScriptIds],
    collectionIds: [...pendingCollectionIds],
  };
  pendingScriptIds.clear();
  pendingCollectionIds.clear();
  return scope;
}

function scheduleSync(): void {
  if (syncTimer != null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void refreshAllOpenTabs();
    void syncRegistrations(takePendingScope());
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

function setupReloadFastPath(
  tabId: number,
  documentId: string,
  url: string,
  // This commit's shared batch — see the `onCommitted` listener. Passed
  // in rather than created here so the opportunistic sweep queued off
  // the same event shares it.
  batch: RefreshBatch,
): void {
  if (!INJECTABLE_SCHEME.test(url)) return;
  // Capture commit-time wall clock BEFORE awaiting anything; we want
  // the 500ms window to track real elapsed time since the user hit
  // reload, not "time since ensureLoaded resolved."
  const startedAt = Date.now();
  // Setup eats the front of the 500 ms window, and on a cold worker —
  // which this very navigation may have woken — `ensureLoaded` is a
  // full match-index read competing with the startup registration
  // sync. That share of the budget is invisible without this.
  const timer = startPhaseTimer('reload fast-path setup');
  void (async () => {
    try {
      await ensureLoaded();
      timer.mark('ensure-loaded');
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
      // Cumulative buckets for the batch. `script check`'s `rebuild`
      // phase is a fan-out — dependency fetches, hashing, the parse
      // check — and on this path a single slow one decides whether the
      // window is met, so "which of them was it" is the question. Reset
      // once for the batch and report when the last check settles: the
      // three scripts run concurrently, so a per-check reset would have
      // them clobbering each other's bucket.
      resetPhaseTotals();
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
        // It is benign for the shared work too, now that both calls
        // carry the SAME `batch`: whichever of them wins the gate, the
        // page's checks read the collection row once and list the
        // folder once.
        // `parseCheck: 'defer'` — the check is a diagnostic, and it was
        // most of this path's measured cost (a compile in the offscreen
        // document, plus opening that document on the first check of a
        // session). It still runs, right after the refresh's own write;
        // what changes is that the wrapper is answered without it. See
        // docs/injection.md#reload-fast-path.
        entry.promise = updateScript(m.id, 'manual', 'if-stale', 'defer', batch).then(
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
      // Reported off the end of the batch rather than at the decision:
      // the check that misses the window keeps running, and its cost is
      // exactly what we want in the line.
      void Promise.allSettled([...scripts.values()].map((s) => s.promise))
        .then(() => reportPhaseTotals('reload fast-path'));
      const cleanupTimer = setTimeout(() => {
        fastPathByDoc.delete(key);
      }, RELOAD_FAST_PATH_TTL_MS);
      fastPathByDoc.set(key, {
        startedAt,
        scripts,
        consumed: new Set(),
        cleanupTimer,
      });
      timer.mark('start-checks');
      timer.note(`${matches.length} script(s), tab=${tabId}`);
      timer.done();
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
  // True when the wrapper @grants a storage API; computed at register
  // time. The SW uses this to skip the per-script storage snapshot
  // read for scripts that don't use GM_setValue, keeping check-pending
  // fast on multi-script pages. See `needsGmValues` in injector.ts.
  needsValues?: boolean;
  // Set by wrapper-bridge.js (USER_SCRIPT world) on every message it
  // relays for a MAIN-world wrapper's window.postMessage. A hostile
  // page can post a forged sm:check-pending into the bridge, so a
  // request carrying this flag is potentially page-forged. The page
  // cannot call chrome.runtime.sendMessage itself, so the only way it
  // reaches us is through the bridge — meaning a request WITHOUT this
  // flag came over a USER_SCRIPT-world script's own direct channel and
  // is trustworthy. We use it to refuse handing back another script's
  // gmValues snapshot (the read-leak fix). storage-granting scripts
  // are always USER_SCRIPT world and always use the direct path, so
  // legitimate value reads never carry it.
  __viaBridge?: boolean;
}

// `gmValues` is attached by the check-pending message handler (not
// by handleCheckPending itself, which only decides the reload-
// fast-path action). It carries the script's current GM_setValue
// state — the SW-authoritative snapshot, including in-flight writes
// from `gmValueOverlay` that haven't been confirmed persisted yet.
// The wrapper's prelude uses this as the SOLE source for its
// initial cache; if it's missing the prelude hard-aborts (sm:error
// + return) and the user body doesn't run.
//
// `seedValues` on a `run-new` reply is an instruction, not a request
// like the payload's `needsValues`: it says the SWAPPED body grants a
// storage API, so the wrapper must seed the runtime's cache from
// `gmValues` before evaluating it — the emitted `storage.init` lives
// in the gm prelude, which the swap path doesn't run. It describes
// the new row, so it can be true even when the wrapper asked for no
// snapshot (the refresh added the grant).
type CheckPendingReply =
  | { action: 'run'; gmValues?: Record<string, unknown> }
  | {
      action: 'run-new';
      body: string;
      loadedAt: number;
      seedValues?: boolean;
      gmValues?: Record<string, unknown>;
    }
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
  // Every outcome line carries this. It splits the budget into the two
  // halves that have different fixes: time spent before the wrapper
  // even asked (Chrome's injection + our setup) versus time the
  // refresh itself took while the wrapper waited.
  const askedAt = Date.now() - entry.startedAt;
  const sinceCommit = (): number => Date.now() - entry.startedAt;
  let refreshed: StoredScript | null = null;
  if (scriptEntry.settled) {
    // updateScript already finished while we were waiting on Chrome to
    // inject the wrapper — no race needed.
    refreshed = scriptEntry.result;
  } else {
    const remaining = RELOAD_FAST_PATH_WINDOW_MS - askedAt;
    if (remaining <= 0) {
      console.log(
        `[SourceMonkey] reload fast-path: ${payload.name ?? payload.id} window already elapsed (asked at ${askedAt}ms); running prior version`,
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
        `[SourceMonkey] reload fast-path: ${payload.name ?? payload.id} update not detected within ${RELOAD_FAST_PATH_WINDOW_MS}ms ` +
        `(asked at ${askedAt}ms, waited ${remaining}ms); running prior version`,
      );
      return { action: 'run' };
    }
    refreshed = winner;
  }
  if (!refreshed) return { action: 'run' };
  // `status` is the refresh's verdict on everything it waited for —
  // the fetch, the header, the `@require`s. It does NOT include the
  // parse check, which this path defers (see setupReloadFastPath), so
  // an edit that just introduced a syntax error reads as `ok` here and
  // IS swapped in. That is deliberate: the check has always been
  // allowed to fail open, and a developer who just typed the error
  // wants to see it rather than watch the previous version run.
  //
  // It is not silent either. The seal entry is NOT what reports it —
  // the seal rides on the REGISTERED program, which here is the
  // previous, parsing body — so what reports it is the try/catch around
  // the swap eval in `userscript-prelude.js`, which sends `sm:error`
  // and turns the badge red. The deferred verdict then lands and flips
  // the row to `invalid`, so the script is unregistered for the next
  // navigation.
  if (refreshed.status !== 'ok') return { action: 'run' };
  if (refreshed.loadedAt <= wrapperLoadedAt) return { action: 'run' };
  // A refresh can move a script between worlds in either direction:
  // adding its first real `@grant` takes it MAIN → USER_SCRIPT,
  // dropping the last one (or adding `@inject-into page`) takes it
  // back. The running wrapper is stuck in the world Chrome injected
  // it into, so a swap across that line runs the new body in the
  // wrong one — USER_SCRIPT bindings dereference `window.__SM_GM__`,
  // which MAIN doesn't have, and a body that expects page context
  // silently can't see the page's globals from the isolated world.
  // Defer to the next reload, which re-registers into the right one.
  //
  // `__viaBridge` is what tells the two apart: MAIN wrappers have no
  // `chrome.runtime`, so `wrapper-bridge.js` is their only route in,
  // and a request without the flag came over a USER_SCRIPT world's
  // own direct channel.
  //
  // Checked BEFORE building the swap body: the build composes the
  // requires and generates a source map (see injection-modes.md on
  // what that costs for a require-heavy script), and a page can forge
  // bridge requests. Nothing here needs the built body.
  const wrapperWorld = payload.__viaBridge === true ? 'MAIN' : 'USER_SCRIPT';
  if (wrapperWorld !== resolveWorld(refreshed.header)) {
    console.log(
      `[SourceMonkey] reload swap deferred: ${payload.name ?? payload.id} changed injection world (next reload will pick it up)`,
    );
    return { action: 'run' };
  }
  // buildSwapEvalBody prepends the script's GM bindings to the
  // composed (requires + main) body so the indirect eval sees
  // `GM_info` and the rest. Without this, a script that references
  // `GM_info` (now implicit, so almost every script) would
  // ReferenceError on the swapped body — the bindings spliced into
  // the registered main-body wrap function aren't visible at
  // runMain's scope.
  const handlerVersion = chrome.runtime.getManifest().version;
  const swap = await buildSwapEvalBody(
    refreshed,
    handlerVersion,
    // Same dedup-aware label the registration path uses, so the
    // swapped body's source map names the same devtools files.
    // Awaited, not assumed: `getScriptLogLabel` falls back to a UUID
    // prefix before the id table has loaded, and a cold SW is woken BY
    // this very navigation — so an un-awaited read would stash the
    // swapped sources under a stray `SourceMonkey/<uuid8>/` folder.
    // The table is loaded once and memoised, so this resolves
    // immediately on every call but the first.
    await scriptLogLabel(refreshed.id),
  );
  // Storage-granting bodies need `__SM_GM__.storage.init` to have run
  // before their first GM_getValue, and the emitted call for that is
  // in the gm `prelude`, which the swap path never runs (it evals the
  // body instead of calling the main-body wrap function). The wrapper
  // runs the equivalent itself when we set `seedValues` — but it can
  // only do that with a snapshot.
  //
  // `swap.needsValues` describes the NEW row, `payload.needsValues`
  // the registered one. They differ exactly when the refresh changed
  // the grant set:
  //   - grant added   — the wrapper didn't request a snapshot, so the
  //                     message handler isn't loading one. We do it
  //                     here rather than ship a body whose
  //                     GM_getValue would read an empty cache.
  //   - grant removed — nothing to init; the new body has no storage
  //                     bindings to mis-serve.
  // When they agree the handler is already reading the same rows
  // concurrently, and its copy wins the merge — so loading a second
  // one here would be latency on the document-start critical path for
  // a value that gets discarded.
  //
  // The `__viaBridge` refusal is the same read-leak guard the message
  // handler applies: a swap reply carrying `gmValues` is a value read
  // like any other, and a bridge-relayed request may be a page forging
  // another script's id. It can't fire in practice — a storage grant
  // resolves to USER_SCRIPT world, so the world check above turned
  // every bridge request away already — but the guard belongs where
  // the values are handed out, not two screens up in a check that
  // exists for another reason.
  const handlerWillAttach = payload.needsValues === true && payload.__viaBridge !== true;
  let gmValues: Record<string, unknown> | undefined;
  if (swap.needsValues && !handlerWillAttach && payload.__viaBridge !== true) {
    try {
      gmValues = await loadSnapshotForCheckPending(refreshed.id);
    } catch (err) {
      // Same reasoning as the hard-abort in the emitted prelude:
      // running a storage script against values we couldn't read
      // risks a read-modify-write clobbering the user's real data.
      // Falling back to `run` keeps the registered body, which has
      // its own snapshot path and its own abort.
      console.info(
        `[SourceMonkey] reload swap deferred: ${payload.name ?? payload.id} storage snapshot unavailable:`,
        err,
      );
      return { action: 'run' };
    }
  }
  console.log(
    `[SourceMonkey] reload swap: ${payload.name ?? payload.id} loadedAt ${wrapperLoadedAt} -> ${refreshed.loadedAt} ` +
    `(asked at ${askedAt}ms, decided at ${sinceCommit()}ms of ${RELOAD_FAST_PATH_WINDOW_MS})`,
  );
  // Purple goes up here, at the decision — the wrapper hasn't run the
  // new body yet, but from now until it reports back there IS an
  // update landing on this page, which is what the flash announces.
  startReloadFlash(tabId, documentId, payload.id);
  return {
    action: 'run-new',
    body: swap.body,
    loadedAt: refreshed.loadedAt,
    seedValues: swap.needsValues,
    // Only set on the grant-added path; otherwise the message
    // handler's enrichment supplies the same field from its own
    // concurrent read.
    ...(gmValues !== undefined ? { gmValues } : {}),
  };
}

// Dedup-aware log label, waiting for the id table if it hasn't loaded
// yet. `getScriptLogLabel` is the sync accessor and answers with a
// UUID prefix until `ensureLogIdsLoaded` resolves; callers that bake
// the label into something durable (devtools URLs, source maps) need
// the real one.
async function scriptLogLabel(id: string): Promise<string> {
  await ensureLogIdsLoaded();
  return getScriptLogLabel(id);
}

// ---------- Reload flash ----------
//
// A fast-path swap that WORKS is invisible: the new body runs at
// document-start and the badge goes straight to green, so the user
// can't tell whether their edit landed on this reload or is still
// waiting for the next one. The only purple they ever see is the
// failure case — the swap missed its window, the old body ran, and
// the RELOAD badge asks for a second reload.
//
// So we flash purple on the way through. Purple goes up the moment a
// swap is decided and comes down once every swapped wrapper has
// reported back, which makes the two outcomes read differently:
//
//   - a brief purple blink → an update just landed on this page
//   - purple that stays up → reload again to pick the update up
//
// State is in-memory only. It describes a swap in flight, and an SW
// restart means no wrapper is waiting on us any more.

// Floor on how long purple stays up. The swap → sm:swapped round trip
// is a few milliseconds, which would paint and unpaint inside a single
// frame; this makes the blink something a user actually sees.
const RELOAD_FLASH_MIN_MS = 1200;
// Backstop for a wrapper that never reports (page torn down mid-swap,
// tab navigated away). Purple must not stick around looking like the
// RELOAD state it deliberately mimics.
const RELOAD_FLASH_MAX_MS = 5_000;

interface ReloadFlash {
  // The document being swapped into. A commit for a DIFFERENT document
  // in this tab ends the flash: it belongs to the page that was
  // reloading, and carrying it onto the next page would paint purple
  // over something it says nothing about.
  documentId: string;
  // Scripts we told to swap and haven't heard back from yet.
  pending: Set<string>;
  // Earliest wall-clock time the flash may come down.
  until: number;
  timer: ReturnType<typeof setTimeout>;
}

const reloadFlashByTab = new Map<number, ReloadFlash>();

function isReloadFlashing(tabId: number): boolean {
  return reloadFlashByTab.has(tabId);
}

// Called from handleCheckPending as it hands back a `run-new` body.
// Doesn't await the repaint: the wrapper is blocked on that reply, so
// nothing on this path may add storage reads to the critical section.
function startReloadFlash(tabId: number, documentId: string, scriptId: string): void {
  const existing = reloadFlashByTab.get(tabId);
  // A flash still up from the PREVIOUS document doesn't get joined —
  // it gets replaced. `handleCheckPending` answers straight off the
  // message listener while the new commit's `updateTabMatches` is
  // still queued, so on a fast second reload this can run before the
  // navigation handler has dropped the old flash. Joining it would
  // file this swap under the old documentId, where its own report
  // can't drain it and the queued commit deletes it outright.
  if (existing && existing.documentId !== documentId) dropReloadFlash(tabId);
  const flash = reloadFlashByTab.get(tabId);
  if (flash) {
    // Second (or third) script swapping on the same reload joins the
    // flash already up rather than restarting it — the signal is
    // "this page is updating", not "this script is".
    //
    // Unless the set had already drained: a document-end wrapper asks
    // later than a document-start one, so by now the earlier swaps may
    // have reported and left a timer aimed at the old floor. Re-arm
    // both, or this swap's blink gets whatever is left of someone
    // else's.
    if (flash.pending.size === 0) {
      flash.until = Date.now() + RELOAD_FLASH_MIN_MS;
      clearTimeout(flash.timer);
      flash.timer = setTimeout(() => endReloadFlash(tabId), RELOAD_FLASH_MAX_MS);
    }
    flash.pending.add(scriptId);
    return;
  }
  reloadFlashByTab.set(tabId, {
    documentId,
    pending: new Set([scriptId]),
    until: Date.now() + RELOAD_FLASH_MIN_MS,
    timer: setTimeout(() => endReloadFlash(tabId), RELOAD_FLASH_MAX_MS),
  });
  repaintTabBadge(tabId);
}

// Called for every sm:* report. A swapped wrapper sends sm:swapped,
// one that fell back to its baked-in body (CSP refused the eval, no
// GM values) sends sm:start, and either can be followed by sm:error —
// so keying off the id alone, not the message type, is what guarantees
// the pending set drains.
//
// The document is checked, though: a late report from the document we
// just navigated away from can carry the same script id, and letting
// it drain the pending set would end the flash for a swap that hasn't
// landed yet.
function noteReloadFlashReport(tabId: number, documentId: string, scriptId: string): void {
  const flash = reloadFlashByTab.get(tabId);
  if (!flash || flash.documentId !== documentId) return;
  if (!flash.pending.delete(scriptId)) return;
  if (flash.pending.size > 0) return;
  const remaining = flash.until - Date.now();
  if (remaining <= 0) {
    endReloadFlash(tabId);
    return;
  }
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => endReloadFlash(tabId), remaining);
}

function endReloadFlash(tabId: number): void {
  if (!dropReloadFlash(tabId)) return;
  repaintTabBadge(tabId);
}

// Forget the flash without repainting. Separate from endReloadFlash
// for tab removal, where there's no badge left to paint. Returns
// whether there was anything to drop.
function dropReloadFlash(tabId: number): boolean {
  const flash = reloadFlashByTab.get(tabId);
  if (!flash) return false;
  clearTimeout(flash.timer);
  reloadFlashByTab.delete(tabId);
  return true;
}

// End a flash left over from a previous document. Keyed on the
// document rather than on "any navigation" because the flash starts
// AFTER the commit it belongs to — the wrapper asks at document-start,
// which is a moment later — so this tab's own commit handler can run
// with the flash already up for the document it is handling.
function clearReloadFlashForOtherDoc(tabId: number, documentId: string): void {
  if (!documentId) return;
  const flash = reloadFlashByTab.get(tabId);
  if (!flash || flash.documentId === documentId) return;
  dropReloadFlash(tabId);
}

// Repaint from whatever the tab's current state is. Queued through
// enqueueTabWork so it orders behind the navigation update that wrote
// this document's state — a repaint that overtook it would read the
// previous document's record (or none at all, clearing the badge).
function repaintTabBadge(tabId: number): void {
  enqueueTabWork(tabId, async () => {
    const record = await getTabRecord(tabId);
    await renderBadge(tabId, getCurrentState(record));
  });
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
  const policy = await loadConnectPolicy(payload.scriptId);
  if ('reason' in policy) {
    // Not `connectBlockedMessage`: we never got as far as reading the
    // script's rules, so blaming them would be wrong.
    await sendXhrError(tabId, payload.id, gmXhrError(policy.reason));
    return;
  }
  const initial = policy.check(payload.request.url);
  if (!initial.allowed) {
    // `denied` separates "the header forbids this host" from "that URL
    // never parsed" — only the first is the script's rules refusing.
    await sendXhrError(
      tabId,
      payload.id,
      initial.denied ? connectBlockedMessage(initial.reason) : gmXhrError(initial.reason),
    );
    return;
  }
  // Run the fetch and ship the result back to the sender's tab. Other
  // tabs do not get a copy — XHR is per-call, not broadcast. The same
  // policy predicate re-checks the post-redirect URL inside runXhr.
  const event = await runXhr(
    payload.id,
    payload.request,
    (finalUrl) => policy.check(finalUrl).allowed,
    tabId,
  );
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

// Ship a synthesized XHR error event back to the originating tab. Used
// for @connect denials, which the userscript's onerror handles just
// like a network failure.
async function sendXhrError(tabId: number, id: string, message: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'sm:gm-xhr-event',
      id,
      event: { kind: 'error', message },
    });
  } catch { /* tab gone */ }
}

// Load a script's `@connect` policy once and return a reusable
// predicate. The predicate is evaluated against both the initial URL
// and (inside runXhr) the post-redirect URL, so a single header read
// covers every hop. Returns `{reason}` when the policy can't be
// resolved (script gone, no header, parse error) — that's a hard deny.
async function loadConnectPolicy(scriptId: string): Promise<
  | { reason: string }
  | { check: (url: string) => { allowed: true } | { allowed: false; denied: boolean; reason: string } }
> {
  try {
    const script = await getScript(scriptId);
    // Two different failures, and only the second is ours. A script
    // removed while a page it was running on is still open is a real
    // race the user can act on, so it says what happened and how to
    // recover rather than hiding behind `internal error:`.
    if (!script) {
      return { reason: 'this script is no longer installed — reload the page' };
    }
    if (!script.header) {
      return { reason: 'internal error: this script\'s header is not available, so @connect could not be checked' };
    }
    const rules = parseConnectRules(script.header);
    const selfHosts = extractSelfHosts(script.header);
    return { check: (url: string) => isUrlConnectAllowed(url, rules, selfHosts) };
  } catch (err) {
    return {
      reason: `internal error: could not check this script's @connect rules: ${
        err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Shared by the GM handlers that reply with an error when the calling
// tab can't be identified. `handleXhrStart` has the same guard but
// returns silently — see the TODO.md note.
//
// "could not identify", not "no longer known": the guard is
// `sender.tab?.id == null`, so we never had an id — claiming we lost
// one would be a guess. The userscript surfaces this to its own
// author, so it describes the situation rather than naming our field.
const NO_ORIGINATOR_TAB =
  'internal error: could not identify the tab this call came from';

// ---------- GM_openInTab dispatch ----------

async function handleTabOpen(
  sender: chrome.runtime.MessageSender,
  payload: GmTabOpenPayload,
): Promise<{ ok: boolean; tabId?: number; error?: string }> {
  const originatorTabId = sender.tab?.id;
  if (originatorTabId == null) {
    return { ok: false, error: NO_ORIGINATOR_TAB };
  }
  return openGmTab(payload, originatorTabId);
}

// GM_openInTab close-event routing happens inside the main
// chrome.tabs.onRemoved listener above so we don't depend on cross-
// listener dispatch order.

// ---------- GM_notification dispatch ----------

async function handleNotificationShow(
  sender: chrome.runtime.MessageSender,
  payload: GmNotificationShowPayload,
): Promise<{ ok: boolean; notificationId?: string; error?: string }> {
  const originatorTabId = sender.tab?.id;
  if (originatorTabId == null) {
    return { ok: false, error: NO_ORIGINATOR_TAB };
  }
  if (!chrome.notifications) {
    return { ok: false, error: NOTIFICATIONS_UNAVAILABLE };
  }
  return showGmNotification(payload, originatorTabId);
}

function installNotificationListeners(): void {
  if (!chrome.notifications) {
    console.info('[SourceMonkey] chrome.notifications not available; GM_notification will throw if called');
    return;
  }
  chrome.notifications.onClicked.addListener((chromeId) => {
    const taken = takeNotificationForClicked(chromeId);
    if (!taken) return;
    void chrome.tabs.sendMessage(taken.originatorTabId, {
      type: 'sm:gm-notification-event',
      requestId: taken.requestId,
      event: 'clicked',
    }).catch(() => undefined);
  });
  chrome.notifications.onClosed.addListener((chromeId) => {
    const taken = takeNotificationForClosed(chromeId);
    if (!taken) return;
    void chrome.tabs.sendMessage(taken.originatorTabId, {
      type: 'sm:gm-notification-event',
      requestId: taken.requestId,
      event: 'closed',
    }).catch(() => undefined);
  });
}

// ---------- window.close / window.focus dispatch ----------

// Both grants act on the sender's own tab, so the payload names no
// target and there is nothing to validate beyond "do we know which tab
// asked". Failures are mirrored onto the script's Log tab: the page
// console gets the same line from the runtime, but a `window.close()`
// that worked takes the console with it, and the one that didn't is
// exactly the case someone goes looking for later.
async function handleWindowControl(
  msg: { scriptId?: unknown; __viaBridge?: unknown },
  sender: chrome.runtime.MessageSender,
  which: 'close' | 'focus',
): Promise<WindowControlResult> {
  // Refuse a bridge-relayed request, as `handleGmResync` does: closing
  // the user's tab is the most destructive thing a GM handler can be
  // asked to do, and the bridge's allowlist not carrying these types
  // today shouldn't be the only thing standing in front of it. See
  // wrapper-bridge.js.
  if (msg.__viaBridge === true) return { ok: false, error: NO_ORIGINATOR_TAB };
  const scriptId = msg.scriptId;
  const tabId = sender.tab?.id;
  if (tabId == null) {
    return { ok: false, error: NO_ORIGINATOR_TAB };
  }
  // Only the focus path needs the window; a close with a tab id but no
  // window id would otherwise be refused for no reason.
  const windowId = sender.tab?.windowId;
  if (which === 'focus' && windowId == null) {
    return { ok: false, error: NO_ORIGINATOR_TAB };
  }
  const result = which === 'close'
    ? await closeGmWindow(tabId)
    : await focusGmWindow(tabId, windowId as number);
  if (!result.ok && typeof scriptId === 'string') {
    logScriptEvent(scriptId, {
      // `warning`, not `error`, for the same reason GM_download uses
      // it: a refused close/focus is an outcome of the browser's own
      // rules, not a SourceMonkey malfunction.
      level: 'warning',
      source: 'gm-window',
      tabId,
      message: `window.${which} — ${result.error}`,
    });
  }
  return result;
}

// ---------- GM_download dispatch ----------

// Ship one download event to the tab that asked for it, and mirror
// failures onto the script's Log tab so a user who sees "nothing
// downloaded" has somewhere to look. Successful downloads are NOT
// logged: a batch downloader fires hundreds of them and would push
// every other entry out of the capped log.
function sendDownloadEvent(
  tabId: number,
  scriptId: string,
  requestId: string,
  url: string,
  event: GmDownloadEvent,
): void {
  if (event.kind === 'error' || event.kind === 'timeout') {
    const reason = event.kind === 'timeout'
      ? 'timed out'
      : `${event.error}${event.details.current ? ` (${event.details.current})` : ''}${event.details.message ? `: ${event.details.message}` : ''}`;
    logScriptEvent(scriptId, {
      // `warning`, not `error`: a refused or interrupted download is a
      // script/page-level outcome the script can handle (and often
      // retries), not a SourceMonkey malfunction. `error` would also
      // be misleading — it doesn't drive the toolbar icon red, so it
      // only raises the noise floor.
      level: 'warning',
      source: 'gm-download',
      tabId,
      message: `GM_download ${reason} — ${url}`,
    });
  }
  void chrome.tabs.sendMessage(tabId, {
    type: 'sm:gm-download-event',
    requestId,
    event,
  }).catch(() => undefined);
}

async function handleDownloadStart(
  sender: chrome.runtime.MessageSender,
  payload: GmDownloadStartPayload,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) {
    console.info('[SourceMonkey] gm-download-start without tab id; ignoring');
    return;
  }
  const emit = (event: GmDownloadEvent): void => {
    sendDownloadEvent(tabId, payload.scriptId, payload.requestId, payload.url, event);
  };
  const result = await startGmDownload(payload, tabId, emit);
  if (result.ok) return;
  // A download that never started still owes the script a terminal
  // event. `download_canceled` here means the page aborted before the
  // download manager had an id — the page already settled its own
  // callbacks, so there's nothing to deliver.
  if (result.error === 'download_canceled') return;
  emit({
    kind: 'error',
    error: result.error ?? 'not_succeeded',
    details: result.details ?? {},
  });
}

function installDownloadListeners(): void {
  if (!chrome.downloads) {
    console.info('[SourceMonkey] chrome.downloads not available; GM_download will report not_permitted');
    return;
  }
  // Note this listener sees EVERY download in the browser, not just
  // ours — the API has no per-extension filter. `handleDownloadChanged`
  // ignores ids it didn't start, and we never read or store anything
  // about a download a userscript didn't ask for.
  chrome.downloads.onChanged.addListener((delta) => {
    handleDownloadChanged(delta);
  });
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

// Openers table: scriptId -> set of tabIds that currently have a
// wrapper for this script running. Updated on sm:start / sm:swapped
// (recordScriptReport, below), on a resync request, and on tab close.
// We don't track per-frame because chrome.tabs.sendMessage broadcasts
// to every frame in a tab — frame-level filtering can land later if
// it's worth it.
//
// Mirrored into chrome.storage.session so it survives a service-worker
// restart. It has to: the table is only filled at document start, an
// MV3 worker is evicted after ~30s idle, and a write that arrives on
// the next wake would otherwise find an empty table and drop every
// cross-tab broadcast silently — permanently desyncing the other tab,
// because a page-side GM_getValue never round-trips to the SW. See
// docs/GM-APIs-storage.md and issue #19.
//
// The mirror is dropped when Chrome shuts down, which is also when
// every tab in it dies, so a stale row can only outlive its tab within
// one Chrome session (tab closed while the worker was asleep and
// onRemoved never ran). `hydrateGmOpeners` prunes those against the
// live tab list on the first read after each worker start.
const GM_OPENERS_KEY = 'sm:gm-openers';
const gmOpeners = new Map<string, Set<number>>();

// Latched on first use per worker lifetime. Everything that reads or
// mutates the table goes through it, so no path can act on a table
// that hasn't been restored yet.
let gmOpenersHydration: Promise<void> | null = null;

function hydrateGmOpeners(): Promise<void> {
  if (gmOpenersHydration) return gmOpenersHydration;
  // The body can't be allowed to reject: the latch is permanent, and
  // everything downstream (including handleBatchWrite, via
  // broadcastValueUpdate) awaits it. A restore failure has to degrade
  // to "empty table", not to "every write from now on fails".
  gmOpenersHydration = restoreGmOpeners().catch((err) => {
    console.info('[SourceMonkey] could not restore the GM openers table:', err);
  });
  return gmOpenersHydration;
}

async function restoreGmOpeners(): Promise<void> {
  const got = await chrome.storage.session.get(GM_OPENERS_KEY);
  const raw = got[GM_OPENERS_KEY];
  if (!raw || typeof raw !== 'object') return;
  const restored = raw as Record<string, unknown>;
  // A row whose tab is gone (closed while the worker was asleep, so
  // onRemoved never ran) is dropped on the way in. Without a tab list
  // we keep every row instead — a send to a dead tab just rejects,
  // which is the cheaper mistake.
  let liveTabIds: Set<number> | null = null;
  try {
    liveTabIds = new Set(
      (await chrome.tabs.query({}))
        .map((t) => t.id)
        .filter((id): id is number => typeof id === 'number'),
    );
  } catch {
    liveTabIds = null;
  }
  let pruned = false;
  for (const [scriptId, ids] of Object.entries(restored)) {
    if (!Array.isArray(ids)) continue;
    for (const tabId of ids) {
      if (typeof tabId !== 'number') continue;
      if (liveTabIds && !liveTabIds.has(tabId)) { pruned = true; continue; }
      // Merge, don't replace: a sm:start that landed while this read
      // was in flight already added its pair to the in-memory map.
      addOpenerToMap(scriptId, tabId);
    }
  }
  if (pruned) await writeGmOpeners();
}

function addOpenerToMap(scriptId: string, tabId: number): boolean {
  let s = gmOpeners.get(scriptId);
  if (!s) { s = new Set(); gmOpeners.set(scriptId, s); }
  if (s.has(tabId)) return false;
  s.add(tabId);
  return true;
}

async function writeGmOpeners(): Promise<void> {
  const row: Record<string, number[]> = {};
  for (const [scriptId, set] of gmOpeners) row[scriptId] = [...set];
  try {
    await chrome.storage.session.set({ [GM_OPENERS_KEY]: row });
  } catch (err) {
    console.info('[SourceMonkey] could not persist the GM openers table:', err);
  }
}

// Coalesce the mirror writes: a page load registers one opener per
// granting script, and each would otherwise be its own session write.
// The whole table goes out on every write, so a coalesced write says
// the same thing the skipped ones would have.
let gmOpenersPersist: Promise<void> | null = null;
function persistGmOpeners(): void {
  if (gmOpenersPersist) return;
  // Wait for hydration first — writing the in-memory table before the
  // stored one has been merged in would drop the rows we haven't read
  // back yet.
  const p = hydrateGmOpeners()
    .then(writeGmOpeners)
    .catch(() => undefined)
    .finally(() => { if (gmOpenersPersist === p) gmOpenersPersist = null; });
  gmOpenersPersist = p;
}

// Resolve once no mirror write is outstanding. Loops because settling
// one can leave the next already queued.
async function settleGmOpeners(): Promise<void> {
  while (gmOpenersPersist) await gmOpenersPersist;
}

// Return the worker to the state it starts in: no table in memory, no
// restore done yet, so the next read re-reads the mirror. Lets the
// tests drive an idle eviction (`dropGmOpenersForTests`) and keeps
// `resetAllState` from leaving the two halves disagreeing. Settles any
// queued mirror write first — otherwise it would land after the clear
// and write the emptied table over the rows we mean to keep.
async function resetGmOpenersState(): Promise<void> {
  await hydrateGmOpeners();
  await settleGmOpeners();
  gmOpeners.clear();
  gmOpenersHydration = null;
}

function registerOpener(scriptId: string, tabId: number): void {
  if (addOpenerToMap(scriptId, tabId)) persistGmOpeners();
}

function clearTabFromGmOpeners(tabId: number): void {
  // Deferred behind hydration: the rows for this tab may still be in
  // session storage rather than the map, and clearing before the merge
  // would leave them to be restored right back.
  void hydrateGmOpeners().then(() => {
    let changed = false;
    for (const [scriptId, set] of gmOpeners) {
      if (set.delete(tabId)) {
        changed = true;
        if (set.size === 0) gmOpeners.delete(scriptId);
      }
    }
    if (changed) return writeGmOpeners();
  }).catch(() => undefined);
}

// ---------- In-flight value-write overlay ----------
//
// Per-script in-memory record of writes that have been received via
// `sm:gm-batch-write` but whose `chrome.storage.local.set` hasn't
// resolved yet. Used by `loadSnapshotForCheckPending` to merge the
// authoritative SW view (overlay + persisted rows) into the snapshot
// we ship back on the check-pending reply, so a new document that
// starts loading WHILE its predecessor's pagehide flush is still
// hitting the disk still sees the latest values.
//
// Eviction: each call to `handleBatchWrite` writes its tuples into
// the bucket, awaits the persistence call, then evicts only the
// entries whose value reference is still the one IT installed. If a
// later write overwrote the key, the new value stays in the overlay
// until ITS own persistence resolves. This avoids the otherwise
// possible "evict races a fresher write" hazard without needing
// generation tokens.
//
// We mark deletions with `GMVAL_DELETED` (a local symbol) rather than
// the `DELETED_SENTINEL` exported by gm-values, because that sentinel
// only lives long enough to flow through `applyBatchValues` — there's
// nothing wrong with using a second sentinel here that's local to
// the overlay layer.
const GMVAL_DELETED: unique symbol = Symbol('sm:overlay-deleted');
type OverlayValue = unknown | typeof GMVAL_DELETED;
const gmValueOverlay = new Map<string, Map<string, OverlayValue>>();

function overlayInstallWrites(
  scriptId: string,
  writes: readonly ValueWrite[],
): Map<string, OverlayValue> {
  let bucket = gmValueOverlay.get(scriptId);
  if (!bucket) {
    bucket = new Map();
    gmValueOverlay.set(scriptId, bucket);
  }
  const installed = new Map<string, OverlayValue>();
  for (const w of writes) {
    const v: OverlayValue = isDeletionSentinel(w.value) ? GMVAL_DELETED : w.value;
    bucket.set(w.key, v);
    installed.set(w.key, v);
  }
  return installed;
}

function overlayEvictIfUnchanged(
  scriptId: string,
  installed: Map<string, OverlayValue>,
): void {
  const bucket = gmValueOverlay.get(scriptId);
  if (!bucket) return;
  for (const [k, v] of installed) {
    // Identity compare: only drop the entry if the value we wrote is
    // still there. A subsequent write has its own (newer) install
    // that will evict itself when its own persistence resolves.
    //
    // Correctness assumption: chrome.storage.local serializes set /
    // remove calls FIFO per area. Two parallel `handleBatchWrite`
    // calls for the same key therefore land in `chrome.storage.local`
    // in their start order — the overlay tracks what's in flight, not
    // what's persistence-ordered. If chrome were ever to reorder
    // writes internally, the persisted state could disagree with the
    // overlay's last-installed value and this scheme would need
    // revisiting.
    if (bucket.get(k) === v) bucket.delete(k);
  }
  if (bucket.size === 0) gmValueOverlay.delete(scriptId);
}

// Test-only knob — when set, `loadSnapshotForCheckPending` throws,
// which makes the check-pending handler reply without `gmValues`,
// which makes the wrapper's prelude hard-abort. Drives the
// "SW snapshot unavailable → script doesn't run" e2e test. Lives
// here rather than in a separate test-support module because flipping
// it from a Playwright test is one less indirection.
let __debugForceSnapshotFailure = false;
function setDebugForceSnapshotFailure(value: boolean): void {
  __debugForceSnapshotFailure = !!value;
}

// Read the full snapshot for one script: chrome.storage.local rows
// merged with the in-flight overlay. The overlay wins on conflict
// (a write that hasn't persisted is still authoritative — the
// persisted row, if any, is older).
//
// Caller is responsible for only invoking this when the script
// actually grants a storage API (via the `needsValues` flag the
// wrapper passes on sm:check-pending). The read lists this script's
// `gmval:` keys and reads those rows — narrow, but not free, and it
// happens inside the reload fast path's window. It used to scan the
// whole namespace, which cost 155 ms of that window; see
// docs/GM-APIs-storage.md#why-the-read-must-stay-narrow.
async function loadSnapshotForCheckPending(scriptId: string): Promise<Record<string, unknown>> {
  if (__debugForceSnapshotFailure) {
    throw new Error('[SourceMonkey] debug: forced snapshot failure');
  }
  const persisted = await loadAllValues(scriptId);
  const bucket = gmValueOverlay.get(scriptId);
  if (!bucket || bucket.size === 0) return persisted;
  const out: Record<string, unknown> = { ...persisted };
  for (const [k, v] of bucket) {
    if (v === GMVAL_DELETED) delete out[k];
    else out[k] = v;
  }
  return out;
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
  // Park the writes in the overlay BEFORE awaiting persistence: a
  // concurrent check-pending that races us to the snapshot read
  // must see these writes too.
  const installed = overlayInstallWrites(payload.scriptId, internal);
  try {
    await applyBatchValues(payload.scriptId, internal);
  } finally {
    overlayEvictIfUnchanged(payload.scriptId, installed);
  }
  // Broadcast the delta to every OTHER tab running this script.
  // The originating tab already has the writes applied in its
  // page-side cache (it issued the writes); broadcasting back would
  // be redundant and could feed back through value-change listeners.
  const senderTabId = sender.tab?.id;
  await broadcastValueUpdate(payload.scriptId, payload.writes, senderTabId);
  return { ok: true };
}

// Test-only knob — see `setDebugSuppressGmBroadcast` on the test
// surface. Models a broadcast that never arrives, which is what the
// resync path exists to recover from.
let __debugSuppressGmBroadcast = false;

async function broadcastValueUpdate(
  scriptId: string,
  writes: readonly BatchWriteEntry[],
  excludeTabId: number | undefined,
): Promise<void> {
  if (__debugSuppressGmBroadcast) return;
  await hydrateGmOpeners();
  const targets = gmOpeners.get(scriptId);
  let sent = 0;
  // Fire-and-forget per tab. chrome.tabs.sendMessage delivers to
  // every frame on the tab and each frame's runtime listener
  // dispatches by scriptId locally. "Receiving end does not exist"
  // rejections are normal (tab closed mid-send, frame torn down)
  // and silently dropped.
  if (targets) {
    for (const tabId of targets) {
      if (tabId === excludeTabId) continue;
      sent++;
      void chrome.tabs.sendMessage(tabId, {
        type: 'sm:gm-value-update',
        scriptId,
        writes,
      }).catch(() => undefined);
    }
  }
  // A write with nowhere to go is the normal single-tab case, so this
  // is debug-only — but it is the line that tells you whether a
  // cross-tab listener never fired because the value never left the
  // worker. Nothing else on either side reports it. Name WHY nothing
  // was sent: "we only know about the tab that wrote" and "we know
  // about no tabs at all" look identical in a bare count, and only the
  // second one is a symptom.
  const openers = targets ? targets.size : 0;
  const why = sent > 0 ? '' : openers === 0
    ? ' — no tabs registered for this script'
    : ' — the only registered tab is the one that wrote';
  dlog(
    `[SourceMonkey] gm-value broadcast for ${scriptId}: ${writes.length} write(s) ` +
    `to ${sent} of ${openers} registered tab(s)${why}`,
  );
}

// Full-snapshot resync for one script in one document.
//
// The broadcast above is the only thing that keeps a live document's
// cache fresh, and a lost broadcast is otherwise unrecoverable: the
// page-side GM_getValue reads the cache and never asks the worker
// again, so the document stays stale until it navigates. This gives
// the runtime a way back — it asks for the authoritative map and
// diffs it against its cache, firing value-change listeners for
// whatever moved.
//
// Requests also re-register the sender as an opener, which repairs
// the table for a document whose sm:start predates a worker restart.
// That trusts the sender's `scriptId` the same way `sm:start` does —
// a sibling userscript in the same world can subscribe its own tab to
// another script's broadcasts. Same trust boundary, no new exposure.
async function handleGmResync(
  payload: { scriptId?: unknown; __viaBridge?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; values?: Record<string, unknown> }> {
  // Refuse a bridge-relayed request, exactly as the check-pending
  // value read does: this hands back another script's whole value map,
  // and a MAIN-world page can forge the scriptId on anything it gets
  // the bridge to forward. The bridge's allowlist doesn't carry
  // `sm:gm-resync` today — this keeps that from being the only thing
  // standing between a page and the values. See wrapper-bridge.js.
  if (payload.__viaBridge === true) return { ok: false };
  const scriptId = payload.scriptId;
  if (typeof scriptId !== 'string' || !scriptId) return { ok: false };
  const tabId = sender.tab?.id;
  if (tabId != null) registerOpener(scriptId, tabId);
  const values = await loadSnapshotForCheckPending(scriptId);
  return { ok: true, values };
}

// Nudge every open tab to resync.
//
// A worker start is the one moment where our delivery state can be
// wrong (rows pruned for a tab that was reported dead, a document that
// never re-reported), so it's also the right moment to let documents
// re-check. It deliberately sweeps ALL tabs rather than the openers we
// just restored — a tab missing from the table is exactly the case
// worth repairing, and it can't ask on its own behalf.
//
// Only documents with a live value-change listener answer: the nudge
// is a no-op message everywhere else, and answering costs a storage
// snapshot read.
async function nudgeGmResync(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      void chrome.tabs.sendMessage(t.id, { type: 'sm:gm-resync-hint' }).catch(() => undefined);
    }
  } catch (err) {
    dlog('[SourceMonkey] gm resync nudge failed:', err);
  }
}

// A worker starts on every wake, which for an active user is many
// times an hour, and the sweep above costs a message per open tab. Rate
// limit it against a session-storage stamp so a burst of wakes nudges
// once. Long enough to stay cheap, short enough that a tab desynced by
// a lost broadcast heals in about a minute rather than never.
const GM_NUDGE_STAMP_KEY = 'sm:gm-nudged-at';
const GM_NUDGE_MIN_INTERVAL_MS = 60_000;

async function nudgeGmResyncAfterWorkerStart(): Promise<void> {
  try {
    const got = await chrome.storage.session.get(GM_NUDGE_STAMP_KEY);
    const last = got[GM_NUDGE_STAMP_KEY];
    const now = Date.now();
    if (typeof last === 'number' && now - last < GM_NUDGE_MIN_INTERVAL_MS) return;
    await chrome.storage.session.set({ [GM_NUDGE_STAMP_KEY]: now });
  } catch {
    // No stamp means we can't rate limit; nudging is still the useful
    // direction, so fall through rather than skipping the sweep.
  }
  await nudgeGmResync();
}

// Shared async-reply plumbing for the onUserScriptMessage handlers that
// dispatch a promise and reply with its result. Sends the resolved
// value, or an `{ok:false,error}` envelope on throw, swallowing the
// "receiving end is gone" rejection that's normal when the sender's tab
// navigated away mid-request. Returns `true` so the caller keeps the
// message channel open for the async reply.
function respondAsync(
  label: string,
  work: Promise<unknown>,
  sendResponse: (reply: unknown) => void,
): true {
  work.then(
    (reply) => { try { sendResponse(reply); } catch { /* receiver gone */ } },
    (err) => {
      console.info(`[SourceMonkey] ${label} handler threw:`, err);
      try { sendResponse({ ok: false, error: String((err as { message?: unknown })?.message ?? err) }); }
      catch { /* receiver gone */ }
    },
  );
  return true;
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
      //
      // Race `handleCheckPending` (reload-fast-path decision) with
      // `loadSnapshotForCheckPending` (storage snapshot, only when
      // the wrapper opted in via `needsValues`). See CheckPendingReply
      // above for the snapshot's role.
      const payload = msg as CheckPendingPayload;
      const decisionP = handleCheckPending(sender, payload);
      // Only attach the GM_setValue snapshot for a DIRECT request — one
      // that did NOT come through the page-facing bridge. A bridge-
      // relayed request (`__viaBridge`) may be a hostile page forging
      // another script's id to read its values back through the reply;
      // refuse it. Legit storage scripts are USER_SCRIPT world and use
      // the direct path, so this never withholds values they're owed.
      // No log on the refused branch on purpose: a legit script never
      // reaches it (it's only hit by forged/misused bridge requests),
      // and a page can spam forged requests — logging each would be a
      // page-triggerable console flood with no diagnostic value.
      const valueReadAllowed = payload.needsValues && payload.__viaBridge !== true;
      const snapshotP: Promise<Record<string, unknown> | undefined> =
        valueReadAllowed
          ? loadSnapshotForCheckPending(payload.id)
          : Promise.resolve(undefined);
      Promise.all([decisionP, snapshotP]).then(
        ([reply, gmValues]) => {
          const enriched: CheckPendingReply =
            gmValues !== undefined && reply.action !== 'skip'
              ? { ...reply, gmValues }
              : reply;
          try { sendResponse(enriched); } catch { /* gone */ }
        },
        (err) => {
          console.info('[SourceMonkey] check-pending handler threw:', err);
          try { sendResponse({ action: 'run' }); } catch { /* gone */ }
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
      // Synchronous ack — no async reply follows, so return false to
      // let Chrome close the message channel immediately.
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
    }
    if (type === 'sm:gm-tab-open') {
      // Async dispatch — page side awaits the reply (need the assigned
      // chrome tab id back to populate the control object).
      return respondAsync('gm-tab-open', handleTabOpen(sender, msg as GmTabOpenPayload), sendResponse);
    }
    if (type === 'sm:gm-tab-close') {
      const payload = msg as { requestId?: string };
      if (typeof payload.requestId === 'string') {
        void closeGmTab(payload.requestId);
      }
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
    }
    if (type === SM_WINDOW_CLOSE_MSG || type === SM_WINDOW_FOCUS_MSG) {
      // Async dispatch — the page side doesn't block on the reply, but
      // it does log a failure, so the channel stays open for one.
      const which = type === SM_WINDOW_CLOSE_MSG ? 'close' : 'focus';
      return respondAsync(
        `gm-window-${which}`,
        handleWindowControl(msg as { scriptId?: unknown; __viaBridge?: unknown }, sender, which),
        sendResponse,
      );
    }
    if (type === 'sm:gm-download-start') {
      // Ack immediately — the transfer can run for minutes and the
      // message channel shouldn't stay pinned open for it. Terminal +
      // progress events arrive later via chrome.tabs.sendMessage, the
      // same shape as GM_xmlhttpRequest.
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      void handleDownloadStart(sender, msg as GmDownloadStartPayload).catch((err) => {
        console.info('[SourceMonkey] gm-download-start handler threw:', err);
      });
      return false;
    }
    if (type === 'sm:gm-download-abort') {
      const payload = msg as { requestId?: string };
      if (typeof payload.requestId === 'string') void abortGmDownload(payload.requestId);
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
    }
    if (type === 'sm:gm-notification-show') {
      return respondAsync(
        'gm-notification-show',
        handleNotificationShow(sender, msg as GmNotificationShowPayload),
        sendResponse,
      );
    }
    if (type === 'sm:gm-batch-write') {
      // Batched storage flush from the page-side cache. The wrapper
      // doesn't actually await the reply today (fire-and-forget), but
      // returning a real {ok} keeps the channel honest for future error
      // surfacing.
      return respondAsync('gm-batch-write', handleBatchWrite(msg as BatchWritePayload, sender), sendResponse);
    }
    if (type === 'sm:gm-resync') {
      // Recovery path for a document that missed a value broadcast.
      // See handleGmResync.
      return respondAsync(
        'gm-resync',
        handleGmResync(msg as { scriptId?: unknown }, sender),
        sendResponse,
      );
    }
    // Which document the menu message came from. The registry is keyed
    // by it, so both the register and unregister branches below need it.
    const menuDocId = (sender as { documentId?: string }).documentId ?? '';
    if (type === 'sm:gm-menu-register') {
      // Page side has stashed the callback locally; we just track the
      // (commandId, name) so the action context menu can render it.
      //
      // Lifecycle window: a register queued just before chrome.tabs.onRemoved
      // fires can land here AFTER clearMenuCommandsForTab(tabId) has
      // already wiped state for this tab, re-leaking one entry that
      // never sees a clearTab event. Same shape as gm-tab/gm-notification
      // dropOriginator races — left as-is for symmetry. Worst case
      // is a small in-memory leak until the SW restarts.
      //
      // The same window against a *navigation* is not survivable that
      // way (nothing would re-register the lost command), so the
      // registry is keyed by document: we pass the sender's documentId
      // and the navigation clear only drops another document's state.
      const payload = msg as { scriptId?: unknown; commandId?: unknown; name?: unknown };
      if (
        typeof payload.scriptId === 'string' &&
        typeof payload.commandId === 'string' &&
        typeof payload.name === 'string'
      ) {
        const changed = registerMenuCommand(tabId, menuDocId, payload.scriptId, payload.commandId, payload.name);
        if (changed && tabId === activeTabId) void refreshActiveTabMenu();
      }
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
    }
    if (type === 'sm:gm-menu-unregister') {
      const payload = msg as { scriptId?: unknown; commandId?: unknown };
      if (typeof payload.scriptId === 'string' && typeof payload.commandId === 'string') {
        const changed = unregisterMenuCommand(tabId, menuDocId, payload.scriptId, payload.commandId);
        // Unknown ids (silent no-op contract) don't change visible
        // state; skip the rebuild so a noisy unregister loop doesn't
        // churn chrome.contextMenus.
        if (changed && tabId === activeTabId) void refreshActiveTabMenu();
      }
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
    }
    if (type === SM_GM_LOG_MSG) {
      // Fan-out from the page-side GM_log helper. Fire-and-forget; the
      // wrapper doesn't await this. We still ack so the message channel
      // doesn't stay pinned open.
      const payload = msg as { scriptId?: unknown; message?: unknown };
      if (typeof payload.scriptId === 'string' && typeof payload.message === 'string') {
        logScriptEvent(payload.scriptId, {
          level: 'info',
          source: 'gm-log',
          tabId,
          message: payload.message,
        });
      }
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
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

// Read an http(s) URL on behalf of an extension PAGE, because a page
// that fetches for itself acts on the response's `Link: rel=preload`
// headers and lands an uncatchable CSP refusal in the Errors panel.
// The reasoning, and the reply shape, live in src/http-read.ts.
//
// Sender check, not decoration: the extension holds `<all_urls>`, so
// answering anyone would make this an open fetch proxy. Userscript
// worlds are on a different event (`onUserScriptMessage`) and could
// never reach this listener, but the guard is what keeps that true
// after some future context gains `chrome.runtime.sendMessage`.
function installPageFetchListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as { type?: unknown } | null;
    if (!msg || msg.type !== HTTP_READ_MESSAGE) return undefined;
    if (sender.id !== chrome.runtime.id) return undefined;
    const origin = `chrome-extension://${chrome.runtime.id}`;
    if (!sender.url || !sender.url.startsWith(`${origin}/`)) return undefined;
    void handleHttpReadRequest(msg as HttpReadRequest).then(
      (reply) => { try { sendResponse(reply); } catch { /* page gone */ } },
      (err) => {
        // An unexpected throw is not a verdict about the URL, so don't
        // dress it up as one: answering with nothing sends the page to
        // its own fallback fetch, which at worst leaks one preload hint.
        console.info('[SourceMonkey] page http-read handler threw:', describeError(err));
        try { sendResponse(undefined); } catch { /* page gone */ }
      },
    );
    // Keep the message channel open for the async reply.
    return true;
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
  if (!st) return msg || 'Unknown runtime error';
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
      source: 'script-wrapper',
      tabId,
      message: `Started at ${senderUrl}`,
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
      source: 'script-wrapper',
      tabId,
      // The two `loadedAt` values stay on the console line above: they
      // are epoch milliseconds, which identify a content version when
      // reading a transcript but say nothing to someone reading the Log.
      message: 'Page reloaded — swapped in the newer copy of this script',
    });
  } else if (type === SM_ABANDONED_MSG) {
    // SW told the wrapper to skip. Warning, not error — a script that
    // was asked not to run is worth surfacing, but nothing failed.
    console.log(
      `[SourceMonkey] abandoned ${label}${tabPart} ${senderUrl} (reason=${payload.reason ?? '?'})`,
    );
    logScriptEvent(id, {
      level: 'warning',
      source: 'script-wrapper',
      tabId,
      // `reason` is a token from the skip decision, not a sentence, so
      // it goes in parentheses as a detail rather than being read as
      // the explanation. Today the wrapper's own fallback (`skip`) is
      // the only value that gets here — see the `{action: 'skip'}`
      // note on `CheckPendingReply`.
      message: `Did not run on this page (${payload.reason ?? 'no reason given'})`,
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
      source: 'script-wrapper',
      tabId,
      message: composeWrapperErrorMessage(payload.message, payload.stack),
    });
  }

  // Any report from a script we're flashing for means its swap has
  // resolved, one way or another. sm:abandoned counts too — that
  // wrapper is done and nothing further is coming from it — so this
  // sits above the early return below.
  noteReloadFlashReport(tabId, senderDocId, id);

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
// Give the store a way to compile-check a script's source before
// storing it. Installed here rather than imported by the store, so the
// store keeps no runtime dependency on the injector — see
// `setParseChecker` in script-store.ts.
// Count of compiles actually performed, so a test can tell a cache hit
// from a re-check. Asserting only that the row carries a fingerprint
// can't: both paths leave one.
let parseCheckRuns = 0;

// Counts only THIS context's compiles. Extension pages run their own
// (`parse-check-client.ts`), and the tests that read this counter
// drive service-worker refreshes.
const compileParseChecker: ParseChecker = async (script) => {
  if (await isParseCheckDisabled()) return null;
  parseCheckRuns++;
  const source = await buildParseCheckSource(script, chrome.runtime.getManifest().version);
  const verdicts = await checkParses([source.text]);
  // Same resolution the page checker does, through the same helper —
  // the two routes differ only in transport, and a verdict that named
  // a different file depending on which context ran the check would be
  // a bug nobody would think to look for.
  return verdicts ? attachParseLocation(verdicts[0], source) : null;
};
setParseChecker(compileParseChecker);

void ensureLogIdsLoaded();
installStorageListener();
installStaleScriptListener();
installNavigationListeners();
installDeepLinkRedirect();
installUserJsCapture();
// Sweep header rules stranded by a worker that died mid-request. The
// event that woke this worker may itself be an XHR, so the sweep isn't
// alone here — `installHeaderRule` waits on it rather than racing it.
void clearStaleHeaderRules();
installScriptMessageListener();
installPageFetchListener();
installDebugLoggingListener();
installLocalRootsListener();
installGithubAuthListener();
installNotificationListeners();
installDownloadListeners();
installActionContextMenu();
// Kick off the initial cache load so the very first navigation doesn't
// pay the read-everything cost on the critical path. The injector sync
// runs in parallel so registrations are in place ASAP after SW startup.
void ensureLoaded();
void syncRegistrations();
void loadDebugLoggingFlag();
// Kicked off here so the read is already in flight by the time the
// first refresh awaits `localRootsReady()`.
void loadLocalRootsSetting();
void ensureGithubAuthTokenLoaded();
// Refill each script's Log tab from persisted state (current load
// failures + parse-time diagnostics) the first time the SW boots in a
// Chrome session — session storage, and so the log, was wiped on
// Chrome shutdown while the state that explains it wasn't. Gated by a
// session-storage sentinel so SW restarts within the session bail out
// immediately. See `replayScriptLogsAtBoot` in script-updater.ts.
void replayScriptLogsAtBoot();
// Restore the GM_* openers table (chrome.storage.session) so a write
// arriving on this wake still reaches the other tabs, and let live
// documents re-check their caches now that we know our delivery state
// was just rebuilt from disk.
void hydrateGmOpeners().then(nudgeGmResyncAfterWorkerStart);

// background.ts is compiled as an ES module (declared via
// `"type": "module"` in manifest.json's service_worker entry). The
// explicit empty export keeps tsc treating this file as a module
// even if every real import/export is removed later.
export {};
