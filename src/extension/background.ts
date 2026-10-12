// SourceMonkey MV3 service worker.
//
// Today the SW does these real jobs:
//   - Opens the "Active scripts" popup on a toolbar click, and the
//     collections page on a double click.
//   - Watches every tab navigation, finds matching userscripts via the
//     in-memory match index, listens to sm:start / sm:error reports
//     from injected wrappers, and surfaces the combined state as a
//     per-tab badge + tooltip. Per-tab state is persisted to
//     chrome.storage.session so it survives SW restarts but is dropped
//     when Chrome shuts down.
//   - Builds the popup's view of a tab (src/extension/popup-view.ts)
//     and runs what the popup asks: menu commands, selective reloads.
//
// The `self.SourceMonkey` surface exists so e2e tests can drive the
// extension via `serviceWorker.evaluate(...)` — MV3 service workers
// can't be triggered from a Playwright toolbar click.

import { installRowCache, rowCacheLoadsForTests } from './row-cache.js';
import { installWorkerOps } from './worker-ops.js';
import { droppedBlobRefs, type SweepResult } from './script-blobs.js';
import { describeDiagnostic } from '../diagnostic-location.js';
import {
  debugDumpCache,
  ensureLoaded,
  findAllMatchingIds,
  findMatchesForUrl,
  isManualScriptId,
  hasLocalScripts,
  installStorageListener,
  localScriptIds,
  onCacheChanged,
  scriptGrantsSubsystem,
  scriptWorld,
  indexedScript,
  type MatchedScript,
} from './match-index.js';
import { BRIDGE_DENIED, STORAGE_SUBSYSTEMS, type ApiSubsystem } from '../gm-api-catalog.js';
import {
  dlog,
  installDebugLoggingListener,
  loadDebugLoggingFlag,
} from '../debug-log.js';
import { startPhaseTimer, resetPhaseTotals, reportPhaseTotals } from '../phase-timing.js';
import { urlMatchesScript } from '../url-match.js';
import {
  installGithubAuthListener,
  ensureGithubAuthTokenLoaded,
} from '../github-auth.js';
import {
  LOCAL_ROOTS_KEY,
  _setLocalRootsForTests,
  installLocalRootsListener,
  loadLocalRootsSetting,
  rootsFromText,
} from '../local-file-overrides.js';
import { installDeepLinkRedirect } from './deep-link.js';
import { REJECTIONS_KEY, readRejections, type RejectionMap } from './script-rejection.js';
import { readRefreshErrors, type RefreshErrorMap } from './refresh-error.js';
import { installUserJsCapture, isCaptureEnabled } from './install-capture.js';
import {
  HTTP_READ_MESSAGE,
  handleHttpReadRequest,
  type HttpReadRequest,
} from '../http-read.js';
import { checkParses, resetParseCheckFailures } from './parse-check.js';
import { buildParseCheckSource, stackLayout, type StackLayout } from '../composed-source.js';
import { attachParseLocation } from '../parse-location.js';
import {
  isParseCheckDisabled,
  setParseCheckDisabled,
  type ParseVerdict,
} from '../parse-check-protocol.js';
import { isManualScript, type ParseChecker } from '../script-build.js';
import {
  ensureLogIdsLoaded,
  getScriptLogLabel,
  noteScriptNumbers,
  installScriptLogIdListener,
} from './script-log-id.js';
import { installSwTeardownHandler } from './sw-teardown.js';
import { resolveScriptWorld, type InjectionWorld } from '../script-world.js';
import {
  buildManualRunInjections,
  buildIsolatedFallbackInjections,
  buildSwapEvalBody,
  executeManualRun,
  isManualRunCandidate,
  needsGmRuntime,
  forgetRegistrationState,
  isUserScriptsAvailable,
  lastSyncKindForTests,
  resetRejectionRetryGate,
  setBeforeSync,
  syncRegistrations,
  unregisterAllRegistrations,
  type SyncScope,
} from './injector.js';
import { documentKey, loadChannelKey, rekey } from './channel.js';
import { type AllNumbers, assignNumbers, numberMap, readNumbers } from './sticky-numbers.js';
import {
  SM_ABANDONED_MSG,
  SM_CHECK_PENDING_MSG,
  SM_ERROR_MSG,
  SM_FOCUS_MSG,
  SM_MAIN_BLOCKED_MSG,
  SM_GM_LOG_MSG,
  SM_GM_DOM_BLOCKED_MSG,
  SM_MANUAL_MSG,
  SM_START_MSG,
  SM_SWAPPED_MSG,
} from '../runtime-messages.js';
import {
  applyScriptReport,
  BADGE_PURPLE,
  BADGE_RED,
  SM_DEV_MARKER_CYAN,
  clearScriptStale,
  computeBadge,
  applyFrameReport,
  getCurrentState,
  getDocState,
  markScriptStale,
  mergeMatches,
  noteManualRun,
  notePageReport,
  noteScriptWarning,
  pruneFrameRuns,
  runsHere,
  setCurrentDoc,
  writeDocState,
  type ActualStatus,
  type TabMatchState,
  type TabRecord,
} from './tab-status.js';
import { describeMissingScript, findMissingScripts } from './missing-scripts.js';
import { summarizeToolbar } from './toolbar-summary.js';
import {
  _resetUpdaterStateForTests,
  replayScriptLogsAtBoot,
  requestOpportunisticScriptChecks,
  updateAllCollections,
  updateScript,
  updateCollection,
} from './script-updater.js';
import type { ProbePolicy } from '../version-probe.js';
import {
  getDirectoryListingFetches,
  isScratchUrl,
  scratchRunOf,
  scratchSourceKey,
  resetDirectoryListingFetches,
  type ScratchSource,
} from './directories.js';
import {
  addCollection,
  createRefreshBatch,
  getCollectionRowReads,
  resetCollectionRowReads,
  type RefreshBatch,
  getScript,
  getScriptMeta,
  getScriptMetas,
  getEnablementTimes,
  isScriptEnabled,
  isCollectionEnabled,
  getCollection,
  getAllScriptMetas,
  getCollections,
  getCollectionWithScripts,
  isFirstRunComplete,
  resetCollectionKeyMigrationForTests,
  markStoreFormatForTests,
  rerunStoreMigrationForTests,
  forgetStoreMigrationForTests,
  sweepUnusedBlobsLocked,
  checkScriptRowWrite,
  seedStorageForTests,
  storeFormatReady,
  _setCollectionWriteFailureForTests,
  markFirstRunComplete,
  removeCollection,
  setScriptEnabled,
  setCollectionEnabled,
  setCollectionLocalFiles,
  setCollectionOptions,
  createCollection,
  installScript,
  writeRunScript,
  removeSmDevCollection,
  smDevCollectionRuns,
  moveScript,
  removeScript,
  reconcileScriptMembership,
  describeError,
  type AddCollectionResult,
  type RunScriptArgs,
  type WriteRunScriptResult,
  type CollectionOptions,
  type InstallTarget,
  type NewCollectionSpec,
  backfillHeaderProblems,
  backfillStartupLogs,
  retiredHeaderProblemIds,
  verifyParseChecks,
  backfillUsesUnsafeWindow,
  type ScriptMeta,
  type StoredScript,
  type StoredCollection,
  setParseChecker,
} from './script-store.js';
import {
  appendScriptLog,
  clearScriptLog,
  getMaxLogLevel,
  getScriptLog,
  handleScriptLogWrite,
  SCRIPT_LOG_WRITE_MESSAGE,
  type ScriptLogWriteRequest,
  logScriptEvent,
  _flushScriptLogQueueForTests,
  onScriptLogEntry,
  type AppendLogInput,
  type LogLevel,
  type LogEntry,
} from './script-log.js';
import { effectiveDisplayName } from './collection-display.js';
import {
  activeClaim,
  claimAllows,
  claimsReady,
  type SmDevClaim,
  claimTab,
  dropClaim,
  namedTab,
  watchForNamingNavigation,
  emitSmDevEvent,
  inheritClaim,
  releaseRun,
  renewRun,
  resetSmDevLinkForTests,
  staleRuns,
  setTabScriptsOff,
} from './sm-dev-link.js';
import {
  MANUAL_RUN_COLLECTION_OFF, MANUAL_RUN_NOT_HERE, MANUAL_RUN_NOT_INSTALLED, MANUAL_RUN_NOT_MANUAL, MANUAL_RUN_PAGE,
  MANUAL_RUN_PAGE_CHANGED, MANUAL_RUN_SCRIPT_OFF, MANUAL_RUN_SM_DEV, MANUAL_RUN_TAB_GONE,
  SKIP_REASON_SM_DEV, SM_DEV_PROTOCOL, type ManagedCollection, type ManagedScript, type ProtocolVersion,
} from '../sm-dev-protocol.js';
import { managedChanges } from './managed-changes.js';
import { managedCollection, managedScripts } from './managed-items.js';
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
  releaseXhr,
  reserveXhr,
  runXhr,
} from './gm-xhr.js';
import type { GmXhrEvent, GmXhrRequestPayload, GmXhrStreamEvent } from '../gm-xhr-types.js';
import { clearStaleHeaderRules } from './gm-xhr-headers.js';
import {
  connectBlockedMessage,
  connectCancelledMessage,
  connectDeniedMessage,
  connectPromptFailedMessage,
  connectTooManyPromptsMessage,
  connectUnansweredMessage,
  decideConnect,
  extractSelfHosts,
  gmXhrError,
  parseConnectRules,
} from '../gm-connect.js';
import { getValue } from '../userscript-header.js';
import {
  answerConnect,
  answerConnectPrompt,
  askConnect,
  CONNECT_PROMPT_WAIT_MS,
  MAX_PROMPTS_PER_SCRIPT,
  onConnectPromptWindowRemoved,
  resetConnectPromptsForTests,
  pendingConnectPrompts,
} from './connect-prompt.js';
import {
  CONNECT_ANSWER_MESSAGE,
  CONNECT_PROMPT_ALIVE_MESSAGE,
  CONNECT_PROMPT_PAGE,
  type ConnectAnswerMessage,
  type ConnectChoice,
} from './connect-grants.js';
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
  hasFrameDocuments as hasFrameMenuDocuments,
  pruneDocuments as pruneMenuDocuments,
  topDocument as menuTopDocument,
  registerMenuCommand,
  unregisterMenuCommand,
  type MenuCommandEntry,
} from './gm-menu.js';
import { installUrlChangeWatch } from './gm-url-change.js';
import { frameInfo, type FrameInfo } from './frame-info.js';
import { openNamedTab } from './page-links.js';
import {
  closeGmWindow,
  focusGmWindow,
  SM_WINDOW_CLOSE_MSG,
  SM_WINDOW_FOCUS_MSG,
  type WindowControlResult,
} from './gm-window-control.js';
import {
  buildPopupView,
  POPUP_CHANGED_MESSAGE,
  POPUP_CLOSE_MESSAGE,
  POPUP_CLOSING_MESSAGE,
  POPUP_COMMAND_MESSAGE,
  POPUP_RUN_SCRIPT_MESSAGE,
  POPUP_PORT_PREFIX,
  POPUP_RELOAD_MESSAGE,
  POPUP_VIEW_MESSAGE,
  POPUP_SET_ENABLED_MESSAGE,
  RELOAD_NO_SCRIPTS_LABEL,
  type PopupChangedMessage,
  type PopupCloseMessage,
  type PopupClosingMessage,
  type PopupCommandRequest,
  type PopupRunScriptRequest,
  type PopupReloadRequest,
  type PopupScriptInput,
  type PopupSetEnabledRequest,
  type PopupView,
  type PopupViewRequest,
  type ReloadMode,
} from './popup-view.js';
import { identityKey } from './script-identity.js';
import { setCollectionEnabledExclusive, setScriptEnabledExclusive } from './script-enablement.js';
import { scriptDisplayName } from '../script-display.js';

interface SourceMonkeyApi {
  version: string;
  // What sm-dev checks as a run connects (sm-dev-protocol.ts).
  smDevProtocol: ProtocolVersion;
  // Round-trip echo used by the smoke test to confirm the SW is alive
  // and `self.SourceMonkey` is reachable from `serviceWorker.evaluate`.
  ping: (value?: string) => string;
  // Test/debug hook: force a tab badge refresh against an arbitrary URL.
  matchesFor: (url: string) => Promise<MatchedScript[]>;
  // sm-dev's `collection list` and `script list` (protocol 1.2), numbered
  // first so a collection or script added a moment ago has its number.
  managedCollections: () => Promise<ManagedCollection[]>;
  managedScripts: () => Promise<ManagedScript[]>;
  // sm-dev's changes to collections and installed scripts, and `script
  // show` / `script print` (protocol 1.5, managed-changes.ts).
  managed: ReturnType<typeof managedChanges>;
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
  createCollection: (spec: NewCollectionSpec) => Promise<AddCollectionResult>;
  installScript: (location: string, target: InstallTarget) => Promise<AddCollectionResult>;
  // An sm-dev run's scripts (docs/sm-dev-design.md): install text
  // into the run's test collection, registered before the promise
  // settles; a rewrite of the same name replaces it in place.
  writeRunScript: (args: RunScriptArgs) => Promise<WriteRunScriptResult>;
  // sm-dev's tab claims and event stream (sm-dev-link.ts): a run's tabs
  // run only its test collection's scripts. `renewRun` extends the run's
  // lease, claims and event subscription. `releaseRun` ends them and removes the run's
  // test collection, with the scripts' GM values.
  claimTab: (tabId: number, runId: string, ttlMs: number) => Promise<void>;
  // How sm-dev learns a tab's id: watch for a navigation to
  // `about:blank#<fragment>`, which it then makes, and ask which tab
  // made it (null if none did in time).
  watchForNamingNavigation: (fragment: string, timeoutMs: number) => void;
  namedTab: (fragment: string) => Promise<number | null>;
  renewRun: (runId: string, ttlMs: number, tabs?: { tabId: number; scriptsOff?: boolean }[]) => Promise<number>;
  releaseRun: (runId: string) => Promise<void>;
  // Removes the test collections of runs gone longer than the grace
  // period, as the worker does every minute, at `now`. Settles once the
  // registrations are synced.
  sweepRunCollections: (now: number) => Promise<void>;
  setTabScriptsOff: (tabId: number, off: boolean) => Promise<void>;
  // The scripts the toolbar badge lists for a tab's current document,
  // with their status, collection and script number (absent for one
  // not numbered yet): sm-dev's list of the extension's scripts on the
  // page, which it names by number (`E12`).
  scriptsOnTab: (tabId: number) => Promise<{ id: string; name: string; status: string; collection: string; number?: number }[]>;
  // The stored script numbers, by script id, after numbering any new
  // scripts. For tests.
  scriptNumbers: () => Promise<Record<string, number>>;
  // The stored collection numbers, by collection id, after numbering any
  // new collections. For tests.
  collectionNumbers: () => Promise<Record<string, number>>;
  // Clicks a shown notification (by the id `GM_notification` got), as
  // the person would: the script's `onclick` runs. False when it isn't
  // showing. sm-dev's fixture clicks one this way.
  clickNotification: (notificationId: string) => boolean;
  // Answers a connection prompt (by the id its `connect-prompt` event
  // carried), as the person would in its window. False when it isn't
  // waiting. sm-dev's `connect` command answers this way.
  answerConnectPrompt: (promptId: string, choice: ConnectChoice) => Promise<boolean>;
  // The connection prompts waiting for an answer.
  pendingConnectPrompts: () => { promptId: string; scriptId: string; tabId: number; host: string }[];
  // Which document a tab's top frame shows: its URL and
  // `performance.timeOrigin`, which sm-dev reads from its own pages to
  // tell which one a tab it heard of is. Null when the tab can't be
  // read (not loaded yet, or a page extensions can't script).
  tabDocument: (tabId: number) => Promise<{ url: string; timeOrigin: number } | null>;
  // Whether the tab's toolbar icon has the sm-dev marker drawn on it.
  // Chrome can't read an action's icon back, so tests ask this.
  isSmDevMarked: (tabId: number) => boolean;
  moveScript: (scriptId: string, target: InstallTarget) => Promise<ScriptMeta | null>;
  // Remove one installed script row (a container copy), as the viewer's
  // trash can does.
  removeScript: (scriptId: string) => Promise<void>;
  // Make every collection's `scriptIds` agree with the `collectionId`
  // on each script row; returns how many listings it corrected.
  reconcileScriptMembership: () => Promise<number>;
  setCollectionOptions: (id: string, options: CollectionOptions) => Promise<StoredCollection | null>;
  removeCollection: (id: string) => Promise<void>;
  getCollections: () => Promise<StoredCollection[]>;
  getCollectionWithScripts: (id: string) => Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null>;
  setCollectionEnabled: (id: string, enabled: boolean) => Promise<StoredCollection | null>;
  setCollectionLocalFiles: (id: string, localFiles: boolean) => Promise<StoredCollection | null>;
  setLocalRoots: (paths: string[]) => Promise<void>;
  setScriptEnabled: (id: string, enabled: boolean) => Promise<ScriptMeta | null>;
  getEnablementTimes: () => Promise<Record<string, { activeSince?: number; inactiveSince?: number }>>;
  // Every script row without bodies, from the worker's row cache once
  // it is loaded (row-cache.ts); loads it.
  getAllScriptMetas: () => Promise<ScriptMeta[]>;
  // How many times the row cache was read from storage.
  rowCacheLoads: () => number;
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
  // The SW's live view of the `.user.js` capture toggle, so a test
  // that flips the option can wait for the change to land before
  // navigating. Optimistically `true` until the startup read finishes,
  // so only a poll for `false` is meaningful.
  isCaptureEnabled: () => boolean;
  // As after an extension reload: forget every tab's record, then
  // mark the open pages as loaded before the extension started.
  simulateExtensionStart: () => Promise<void>;
  // Wipe local + session storage and unregister every userscript so
  // each test starts clean.
  resetAllState: () => Promise<void>;
  // Run the storage format migration again, as a worker start would,
  // for a test that seeded format 1 rows.
  rerunStoreMigration: () => Promise<void>;
  // As a worker just started: the next write runs the migration.
  forgetStoreMigration: () => Promise<void>;
  // One unused-blob check, as a change that drops a blob runs it.
  sweepUnusedBlobs: () => Promise<SweepResult>;
  // Write rows straight into storage, under the store's lock: script rows
  // written outside it are refused (`checkScriptRowWrite`).
  seedStorage: (items: Record<string, unknown>) => Promise<void>;
  // The extension-update backfill of `usesUnsafeWindow`; how many rows
  // it changed.
  backfillUsesUnsafeWindow: () => Promise<number>;
  // An enable click: turning a copy on turns its other active copies off.
  setScriptEnabledExclusive: (id: string, enabled: boolean) => Promise<void>;
  // Drop this worker's record of the registration set, as a fresh
  // worker has none: the next sync is a full one.
  forgetRegistrationState: () => void;
  // Forget when each script/collection was last checked, so the next
  // check isn't skipped by `UPDATE_MIN_INTERVAL_MS`. A test that drives
  // two opportunistic checks of the same script — a navigation and then
  // a focus switch, say — would otherwise have to sit out the interval.
  clearUpdateRateLimit: () => void;
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
  // The `loglevel:` sentinel behind the WARNING / ERROR badges; tests
  // assert a load-state entry leaves it alone.
  getMaxLogLevel: (scriptId: string) => Promise<LogLevel | undefined>;
  // Registrations chrome.userScripts refused on the last sync, keyed by
  // script id — the state the UI renders as REJECTED. Empty unless
  // something is broken, which is what most tests assert.
  getRejections: () => Promise<RejectionMap>;
  // Collections whose last refresh was read but could not be saved,
  // keyed by collection id (src/extension/refresh-error.ts). Empty unless a
  // storage write failed, which is what most tests assert.
  getRefreshErrors: () => Promise<RefreshErrorMap>;
  // Make every collection-refresh write fail, so a test can drive the
  // out-of-quota path without having to actually fill 10 MB. Stays armed
  // until cleared with null, matching a real exhausted quota — which
  // fails every collection, not just the next one.
  failCollectionWrites: (message: string | null) => Promise<void>;
  // Compile-only parse check (src/extension/parse-check.ts). Null means the
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
  // The channel key (channel.ts), for tests that play a page which has
  // it, to reach the SW-side gate behind it.
  channelKey: () => Promise<string>;
  // Write GM values (wire form, as a page sends them) as another tab of
  // the script would: stored, and pushed to every tab running it, so
  // its value-change listeners fire. sm-dev's `set`.
  writeGmValues: (scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]) => Promise<void>;
  // The script's log label (`foo.user.js#E4`). Its number is the
  // service worker's to assign, so a test that needs the label cannot
  // predict it: it has to ask.
  getScriptLogLabel: (scriptId: string) => Promise<string>;
  // How the script's injected entry maps back to its files, for
  // sm-dev to rewrite stack lines in the Log entries and
  // console lines it prints. Segment contents are left out: only the
  // line numbers are needed. Null for a script that isn't stored.
  getStackLayout: (scriptId: string) => Promise<StackLayout | null>;
  // GM_registerMenuCommand test surface: (a) read back the commands a
  // tab has registered, and (b) fire one the way the popup does. The
  // names predate the popup, from the context menu it replaced;
  // `fireActionContextMenuItem` is kept because sm-dev calls it (see
  // src/harness/extension-link.ts).
  getActionContextMenu: (tabId: number) => Promise<{
    scriptId: string;
    commands: MenuCommandEntry[];
  }[]>;
  // The popup's view of `tabId`: what popup.html would render for it.
  getPopupView: (tabId: number) => Promise<PopupView>;
  fireActionContextMenuItem: (
    tabId: number,
    scriptId: string,
    commandId: string,
    // The document that registered it, for a command in a frame.
    documentId?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  // Run a manual script (`@run-at context-menu`) on `tabId` now: the
  // popup's "Run this script", which sm-dev's `menu` fires too.
  runManualScript: (tabId: number, scriptId: string) => Promise<{ ok: boolean; error?: string }>;
  // Drives the popup's "Reload page with no userscripts" for `tabId`
  // — the same handler the real click runs.
  reloadWithoutScripts: (tabId: number) => Promise<void>;
  // Drives the toolbar-click handler for a click on `tabId`, which
  // Playwright can't click. Two calls inside the double-click window
  // are a double click.
  clickAction: (tabId: number, windowId: number) => void;
  // Asks the toolbar popups showing `tabId` to close, over their port.
  // They close as after an action, saying so first. Returns how many
  // were asked: none while a popup is still connecting.
  closePopup: (tabId: number) => number;
  // Drives the toolbar-click handler for the given window, which
  // Playwright can't click (chrome.action has no test hook). Tests use
  // it to verify a second click reuses the window's collections tab
  // instead of stacking up duplicates.
  openCollectionsPage: (windowId: number | null) => Promise<void>;
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
  // Test-only: the "should I run?" decision for a request from a
  // document Chrome gives no tab, whose sender carries only its URL.
  // No real page reliably makes one, so this is how the tab-less path
  // gets tested.
  checkPendingWithoutTabForTests: (id: string, url: string, tld: boolean) => Promise<CheckPendingReply>;
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

// The `syncNow` of the test surface, shared by the sm-dev run
// methods so they too settle only once the registration is in place.
async function syncNowForTests(): Promise<{ registered: { id: string }[]; kind: 'full' | 'incremental' | null }> {
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
}

const api: SourceMonkeyApi = {
  version: chrome.runtime.getManifest().version,
  smDevProtocol: SM_DEV_PROTOCOL,
  ping: (value = 'pong') => value,
  matchesFor: async (url) => {
    await ensureLoaded();
    return findMatchesForUrl(url);
  },
  managedCollections: async () => {
    const numbers = (await assignAllNumbers()).collections.byId;
    return (await getCollections()).map((c) => managedCollection(c, numbers[c.id]));
  },
  managedScripts: async () => {
    const numbers = (await assignAllNumbers()).scripts.byId;
    const scripts = await getAllScriptMetas();
    // Where each run's script came from, by its scratch URL.
    const scratch = scripts.map((s) => s.fileUrl).filter(isScratchUrl);
    const got = await chrome.storage.local.get(scratch.map(scratchSourceKey));
    const sources = Object.fromEntries(scratch.flatMap((url) => {
      const source = got[scratchSourceKey(url)] as ScratchSource | undefined;
      return source ? [[url, source]] : [];
    }));
    return managedScripts(await getCollections(), scripts, numbers, sources);
  },
  managed: managedChanges(async () => {
    const numbers = await assignAllNumbers();
    return { scripts: numbers.scripts.byId, collections: numbers.collections.byId };
  }),
  addCollection,
  createCollection,
  installScript,
  moveScript,
  removeScript,
  reconcileScriptMembership,
  setCollectionOptions,
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
  getEnablementTimes,
  getAllScriptMetas: () => getAllScriptMetas(),
  rowCacheLoads: rowCacheLoadsForTests,
  updateCollection,
  updateScript,
  updateAllCollections,
  getTabState: async (tabId: number) => {
    const [badgeText, badgeColor, title, record, view] = await Promise.all([
      chrome.action.getBadgeText({ tabId }),
      chrome.action.getBadgeBackgroundColor({ tabId }),
      chrome.action.getTitle({ tabId }),
      getTabRecord(tabId),
      popupViewForTab(tabId),
    ]);
    // The popup's rows, as `Name | STATUS`, for the ones with a status.
    const rows = [...view.enabled, ...view.frames, ...view.disabled]
      .flatMap((g) => g.rows)
      .filter((r) => r.status !== null)
      .map((r) => `${r.name} | ${r.status}`);
    return { badgeText, badgeColor, title, rows, record };
  },
  isCaptureEnabled,
  simulateExtensionStart: async () => {
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('tab:')));
    await markTabsLoadedBefore();
  },
  // Drains this script's in-flight appends before reading. Production
  // log writes go through `logScriptEvent`, which is deliberately
  // fire-and-forget — a refresh must not wait on its own transcript —
  // so `updateCollection()` can resolve before the entry it just
  // produced has landed. A test that reads straight after would be
  // asserting on a log that is still being written.
  // sm-dev reads it too, to catch up on entries made while the worker
  // restarted: part of what SM_DEV_PROTOCOL versions.
  getScriptLog: async (scriptId: string) => {
    await _flushScriptLogQueueForTests(scriptId);
    return getScriptLog(scriptId);
  },
  appendScriptLog,
  getMaxLogLevel: async (scriptId: string) => {
    await _flushScriptLogQueueForTests(scriptId);
    return getMaxLogLevel(scriptId);
  },
  getRejections: readRejections,
  getRefreshErrors: readRefreshErrors,
  failCollectionWrites: async (message: string | null) => {
    _setCollectionWriteFailureForTests(message);
  },
  clearScriptLog,
  getGmValues: loadAllValues,
  channelKey: loadChannelKey,
  writeGmValues: async (scriptId, writes) => {
    // No sender tab, so every tab running the script hears it.
    await handleBatchWrite({ scriptId, writes }, {});
  },
  // `scriptLogLabel`, not `getScriptLogLabel` — the awaited form, so a
  // test never races the id table and gets a UUID prefix back.
  getScriptLogLabel: scriptLogLabel,
  getStackLayout: async (scriptId: string) => {
    const script = await getScript(scriptId);
    if (!script) return null;
    const layout = stackLayout(script, await scriptLogLabel(scriptId));
    return { ...layout, segments: layout.segments.map((seg) => ({ ...seg, content: '' })) };
  },
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
  getPopupView: (tabId) => popupViewForTab(tabId),
  clickAction: (tabId, windowId) => handleActionClick({ id: tabId, windowId }),
  closePopup: (tabId) => {
    const ports = popupPorts.get(tabId) ?? new Set();
    for (const port of ports) postPopupClose(port);
    return ports.size;
  },
  openCollectionsPage: async (windowId) => {
    await openCollectionsPage(windowId);
  },
  fireActionContextMenuItem: async (tabId, scriptId, commandId, documentId) => {
    // Goes through the same dispatchMenuCommand helper the popup
    // click handler uses — same validation, same message shape. Test
    // assertions can rely on the result instead of polling page state.
    return await dispatchMenuCommand(tabId, scriptId, commandId, documentId);
  },
  runManualScript: (tabId, scriptId) => runManualScript(tabId, scriptId),
  reloadWithoutScripts: async (tabId) => {
    await reloadTabWithMode(tabId, { kind: 'none' });
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
  checkPendingWithoutTabForTests: (id, url, tld) => handleCheckPending({ url }, { id, url, tld }),
  setDebugSuppressGmBroadcast: (value: boolean) => { __debugSuppressGmBroadcast = !!value; },
  // The unthrottled sweep: a test drives it on demand, where the
  // once-a-minute rate limit on the startup path would just make the
  // call silently do nothing.
  nudgeGmResync,
  getDirectoryListingFetches,
  resetDirectoryListingFetches,
  getCollectionRowReads,
  resetCollectionRowReads,
  // The run-script calls name the rows they changed to the sync
  // themselves. `storage.onChanged` would add them to the pending scope
  // too, but that event arrives on its own schedule, and the promise
  // here must not settle before the registration is in place.
  writeRunScript: (args) => queueSmDevWork(async () => {
    const result = await writeRunScript(args);
    pendingScriptIds.add(result.scriptId);
    pendingCollectionIds.add(result.collectionId);
    await syncNowForTests();
    await startRunSweeps();
    return result;
  }),
  claimTab,
  watchForNamingNavigation,
  namedTab,
  renewRun,
  releaseRun: (runId) => queueSmDevWork(async () => {
    await releaseRun(runId);
    if (await dropSmDevCollection(runId)) await syncNowForTests();
  }),
  sweepRunCollections: async (now) => {
    realSweepsPaused = true;
    await sweepRunCollections(now);
    await syncNowForTests();
  },
  setTabScriptsOff,
  clickNotification: (notificationId) => deliverNotificationEvent(notificationId, 'clicked'),
  answerConnectPrompt,
  pendingConnectPrompts,
  scriptsOnTab: async (tabId) => {
    const state = getCurrentState(await getTabRecord(tabId));
    if (!state) return [];
    const view = computeBadge(state, await rejectedScriptIds());
    // Numbered first, so a script added a moment ago has its number.
    const numbers = (await assignAllNumbers()).scripts.byId;
    return Promise.all(view.rows.map(async (row) => {
      const script = await getScriptMeta(row.id);
      const collection = script ? await getCollection(script.collectionId) : undefined;
      const number = numbers[row.id];
      return {
        id: row.id, name: row.name, status: row.status, collection: collection ? effectiveDisplayName(collection) : '',
        ...(number !== undefined ? { number } : {}),
      };
    }));
  },
  scriptNumbers: async () => (await assignAllNumbers()).scripts.byId,
  collectionNumbers: async () => (await assignAllNumbers()).collections.byId,
  isSmDevMarked: (tabId) => markedTabs.has(tabId),
  tabDocument: async (tabId) => {
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: () => ({ url: location.href, timeOrigin: performance.timeOrigin }),
      });
      return (frame?.result as { url: string; timeOrigin: number } | undefined) ?? null;
    } catch {
      return null;
    }
  },
  syncNow: () => syncNowForTests(),
  replayScriptLogsAtBoot,
  clearUpdateRateLimit: () => { _resetUpdaterStateForTests(); },
  rerunStoreMigration: () => rerunStoreMigrationForTests(),
  forgetRegistrationState,
  forgetStoreMigration: () => forgetStoreMigrationForTests(),
  sweepUnusedBlobs: async () => (await sweepUnusedBlobsLocked())!,
  seedStorage: seedStorageForTests,
  backfillUsesUnsafeWindow,
  setScriptEnabledExclusive: async (id, enabled) => { await setScriptEnabledExclusive(id, enabled); },
  resetAllState: async () => {
    // The parse check re-enables itself: its off-switch lives in the
    // session storage cleared below, precisely so no context has to
    // remember to restore it. The circuit breaker does have to be
    // reset by hand — it's a module variable in the worker, so a case
    // that deliberately wedges the sandbox would otherwise leave the
    // check off for every later test in this worker.
    parseCheckRuns = 0;
    resetParseCheckFailures();
    popupScriptCache.clear();
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
    // And the update rate-limiter: it keyed the previous test's checks
    // by script id, and ids are per-test, but a collection-level or
    // all-collections entry would carry over and silently skip the next
    // test's first opportunistic check.
    _resetUpdaterStateForTests();
    // The connection prompts' module state: a prompt a test left open
    // would keep its window (and the worker) up into the next test.
    resetConnectPromptsForTests();
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
    // sm-dev's claims and run leases live in memory too, and a lease
    // left from a test minutes ago would have its run's collection swept
    // from under a later test that reuses the run id.
    resetSmDevLinkForTests();
    realSweepsPaused = false;
    await chrome.alarms.clear(RUN_SWEEP_ALARM);
    await chrome.alarms.clear(BLOB_SWEEP_ALARM);
    realBlobSweepsPaused = true;
    // The legacy-key migration memo describes the profile we just
    // wiped, so drop it — otherwise a test that seeds pre-rename rows
    // would find nothing willing to move them.
    resetCollectionKeyMigrationForTests();
    // The empty profile is format 2 (docs/storage.md#format-2-migration),
    // so a page opened next needn't ask this worker about it.
    await markStoreFormatForTests();
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

// sm-dev runs hear each Log entry as it is written (sm-dev-link.ts).
onScriptLogEntry((scriptId, entry, fromReport) => {
  emitSmDevEvent({ kind: 'log', scriptId, entry, ...(fromReport ? { fromReport } : {}) });
  // A warning from a tab marks the script Warning there. Not a
  // load-state entry, which is about the script rather than this page,
  // nor the wrapper's own (never started, skipped): those say it didn't
  // run, and can arrive after the tab moved on to another page.
  const tabId = entry.tabId;
  if (
    entry.level === 'warning' && tabId !== undefined && entry.state === undefined
    && entry.source !== 'script-wrapper'
  ) {
    enqueueTabWork(tabId, () => noteTabWarning(tabId, scriptId));
  }
});
// Loaded early, so the first check-pending after a restart waits less.
void claimsReady();

// ---------- sm-dev test collections ----------
//
// A run's test collection goes when the run ends (`releaseRun`), and
// otherwise once its lease has been out for a grace period: the run
// crashed, or lost its browser. Checked at start-up and by an alarm,
// which runs only while some run has a collection.

const RUN_SWEEP_ALARM = 'sm-dev-run-sweep';

// Removes run `runId`'s test collection, queueing its rows for the
// next sync. Whether there was one.
async function dropSmDevCollection(runId: string): Promise<boolean> {
  const removed = await removeSmDevCollection(runId);
  for (const id of removed.scriptIds) pendingScriptIds.add(id);
  if (removed.collectionId) pendingCollectionIds.add(removed.collectionId);
  return removed.collectionId !== null;
}

// Schedules the sweep alarm, unless it already is: making it again
// would push its next run back a minute.
async function startRunSweeps(): Promise<void> {
  try {
    if (!(await chrome.alarms.get(RUN_SWEEP_ALARM))) await chrome.alarms.create(RUN_SWEEP_ALARM, { periodInMinutes: 1 });
  } catch (err) {
    console.info('[SourceMonkey] could not schedule the sm-dev test collection cleanup:', err);
  }
}

// Pushes, releases and sweeps, one at a time: a sweep that finds no
// collection mustn't clear the alarm as a push makes one, nor a removal
// race a push into the same collection. The alarm that wakes the worker
// and its start-up sweep come together, too.
let smDevQueue: Promise<unknown> = Promise.resolve();
function queueSmDevWork<T>(work: () => Promise<T>): Promise<T> {
  const done = smDevQueue.then(work);
  smDevQueue = done.catch(() => undefined);
  return done;
}

// Set by the tests' sweeps at a simulated time, so a real one (at the
// real time) can't land between them. Cleared by `resetAllState`.
let realSweepsPaused = false;

// `now`: for tests, which can't wait out the grace period.
function sweepRunCollections(now = Date.now()): Promise<void> {
  return queueSmDevWork(() => sweepOnce(now));
}

function realSweep(): void {
  if (!realSweepsPaused) void sweepRunCollections();
}

async function sweepOnce(now: number): Promise<void> {
  try {
    const withCollections = await smDevCollectionRuns();
    // Also forgets long-gone runs without a collection.
    const stale = await staleRuns(withCollections, now);
    if (withCollections.length === stale.length) await chrome.alarms.clear(RUN_SWEEP_ALARM);
    else await startRunSweeps();
    let dropped = false;
    for (const runId of stale) {
      if (await dropSmDevCollection(runId)) dropped = true;
    }
    if (dropped) scheduleSync();
  } catch (err) {
    console.info('[SourceMonkey] could not clean up the sm-dev test collections:', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RUN_SWEEP_ALARM) realSweep();
});
realSweep();

// Clicking the toolbar icon opens the collections page (the extension's
// declared `options_ui.page`). We have no popup configured, so
// onClicked fires on every action click, and Chrome hands us the tab
// the click came from.
//
// We do NOT use chrome.runtime.openOptionsPage() when we know that
// window: it focuses an already-open collections tab wherever it lives.
// With several windows open — especially across virtual desktops, where
// the window manager may not deliver the focus changes Chrome expects —
// that can be a window the user isn't looking at, and the click appears
// to do nothing. The click is the one reliable statement of "this
// window", so reuse a collections tab only inside the clicked window,
// and otherwise open a new one there.
chrome.action.onClicked.addListener((tab) => handleActionClick(tab));

async function openCollectionsPage(windowId: number | null): Promise<void> {
  try {
    if (windowId == null) {
      // No gesture window to aim at (the SW console, tests): let Chrome
      // place it, which is the old behavior.
      await chrome.runtime.openOptionsPage();
      return;
    }
    // The same named-tab reuse every in-page link to the collections
    // page uses (src/extension/page-links.ts), narrowed to this window, and
    // leaving a reused tab scrolled where the user left it — the
    // toolbar means "show me SourceMonkey", not "take me to the top".
    await openNamedTab('collections', { windowId, sameWindowOnly: true, preserveScroll: true });
  } catch (err) {
    // Caught rather than dropped: an unhandled rejection in the SW lands
    // in chrome://extensions/?errors. Nothing the user can act on.
    console.info('[SourceMonkey] could not open the collections page:', describeError(err));
  }
}

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
  // Fill in a derived field older rows don't carry. Runs on update as
  // well as install (and before the first-run check below, which returns
  // early for every existing profile) because a stored row is only
  // rebuilt when a fetch happens: an unchanged script keeps whatever its
  // row said, so without this the ungranted-`unsafeWindow` handling
  // would never reach the scripts already installed. Re-syncs only when
  // something actually changed, since the flag decides a script's world.
  //
  // Then re-derive the rows' parse-time warnings (`startupLogs`), for
  // the same reason: a check added in an update would otherwise never
  // reach an unchanged script. They ride in the registration's config,
  // hence the re-sync.
  //
  // Then re-run the header checks, so a script a newer check refuses
  // stops running instead of keeping its old `ok` row.
  //
  // Last, refresh the rows an older build refused with a check that's
  // gone (`@run-at context-menu`), so they come back as manual scripts.
  void (async () => {
    try {
      const flagged = await backfillUsesUnsafeWindow();
      if (flagged > 0) console.log(`[SourceMonkey] backfilled usesUnsafeWindow on ${flagged} script row(s)`);
      const relogged = await backfillStartupLogs();
      if (relogged > 0) console.log(`[SourceMonkey] re-derived startup logs on ${relogged} script row(s)`);
      const refused = await backfillHeaderProblems();
      if (refused > 0) console.log(`[SourceMonkey] marked ${refused} script row(s) invalid by a newer header check`);
      if (flagged + relogged + refused > 0) await syncRegistrations();
      for (const id of await retiredHeaderProblemIds()) {
        console.log(`[SourceMonkey] rechecking ${id}, refused by a header check that's gone`);
        await updateScript(id, 'opportunistic');
      }
    } catch (err) {
      console.info('[SourceMonkey] script row backfill failed:', err);
    }
  })();
  if (details.reason === 'install' || details.reason === 'update') void markTabsLoadedBefore();
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
      '[SourceMonkey] first run detected: opening collections.html?first_run=1 ' +
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

// ---------- Pages open before the extension started ----------
//
// After an install, an update or a dev reload, every page already open
// loaded before this copy of the extension, and the per-tab records
// (chrome.storage.session) are gone. Whether a script runs in such a
// page is unknown: a copy from the old extension may still run, cut off
// from it, or none may. Each one gets a record
// saying so (`loadedBefore`), so the badge and popup ask for a reload
// (UNTRACKED) rather than staying blank. Not on browser startup
// (`onInstalled` doesn't fire then): restored tabs load afterwards.
async function markTabsLoadedBefore(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const done: Promise<void>[] = [];
  for (const tab of tabs) {
    const tabId = tab.id;
    // A discarded tab loads afresh when shown.
    if (tabId === undefined || !tab.url || !INJECTABLE_SCHEME.test(tab.url) || tab.discarded) continue;
    done.push(new Promise((resolve) => enqueueTabWork(tabId, () => markLoadedBefore(tabId).finally(resolve))));
  }
  await Promise.all(done);
}

async function markLoadedBefore(tabId: number): Promise<void> {
  if (await getTabRecord(tabId)) return;
  // The URL and the document from one call: the tab may have moved on
  // since the query, and a document that committed since is watched.
  let frame: { url: string; documentId?: string } | null = null;
  try {
    frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }) as { url: string; documentId?: string } | null;
  } catch {
    return;
  }
  const documentId = frame?.documentId;
  const url = frame?.url;
  if (!documentId || !url || !INJECTABLE_SCHEME.test(url)) return;
  await ensureLoaded();
  // Recorded even with nothing matching yet, so a script added later
  // shows as Reload to run: a sync's refresh skips a tab with no record.
  const matches = expectedMatches(findMatchesForUrl(url), undefined);
  const state: TabMatchState = {
    documentId,
    url,
    matches,
    actual: {},
    loadMatchIds: matches.map((m) => m.id),
    loadUrl: url,
    loadedBefore: true,
    // Nothing can report from it, so there's nothing to log as
    // never started.
    missingChecked: true,
  };
  await setTabRecord(tabId, setCurrentDoc(null, documentId, state));
  await renderBadge(tabId, state);
}

// ---------- Reload with no userscripts ----------
//
// The popup's "Reload page with no userscripts": a one-time reload
// during which every wrapper on the tab is told to skip. Its per-script
// "with only this script" and "without this script" are the same
// reload with a narrower skip (`ReloadMode`). The
// registrations themselves are untouched — other tabs on the same site
// keep running their scripts, and the tab's next ordinary navigation
// runs them again.
//
// Mechanism: every wrapper already asks the SW `sm:check-pending`
// before running its body (see the reload fast path), and `skip` is
// an answer the wrapper already honours. So a skip reload is just a
// per-tab marker the check-pending handler consults first.
//
// Lifecycle, keyed on main-frame commits:
//   - click          → tab is ARMED, then `chrome.tabs.reload`.
//   - reload commit  → armed becomes SKIPPING for the committed
//                      document. Wrappers in that tab (subframes
//                      included — their documentIds differ, so the
//                      check is per tab, not per document) get `skip`
//                      for as long as it lasts.
//   - next commit    → cleared: a fresh document runs scripts normally.
//   - tab closed     → cleared.
//
// Armed is consumed only by a *reload* commit, and only within a few
// seconds of the click: a reload the page cancels (`beforeunload`) or
// that never commits must not make the tab's next link click skip.
//
// In-memory rather than persisted. The marker normally lives for the
// milliseconds between the click and the commit; the rare reload whose
// first byte takes long enough for the SW to idle out in between just
// runs scripts as usual. A SW restart mid-document only affects
// subframes that inject afterwards. The persisted `scriptsSkipped`
// flag on the document's TabMatchState is what keeps the badge honest
// across a restart.

// Token the check-pending `skip` reply carries as its reason. Comes
// back verbatim on the wrapper's `sm:abandoned`, which is how the Log
// entry tells this (expected) skip from any other.
const SKIP_REASON_RELOAD_WITHOUT_SCRIPTS = 'reload with no userscripts';
// The same for the per-script reloads.
const SKIP_REASON_RELOAD_ONLY = 'reload with only another userscript';
const SKIP_REASON_RELOAD_WITHOUT_THIS = 'reload without this userscript';
// The skips a person asked for, which their Log records as information.
const ASKED_SKIP_REASONS = new Set([
  SKIP_REASON_RELOAD_WITHOUT_SCRIPTS, SKIP_REASON_RELOAD_ONLY, SKIP_REASON_RELOAD_WITHOUT_THIS,
]);
// The `skip` reason for a `.tld` script whose exact match failed. The
// prelude treats it as its own matcher saying no and reports nothing,
// so the literal there must stay the same.
const SKIP_REASON_NO_MATCH = 'no-match';
// The `skip` for a script whose decision couldn't be made: the wrapper's
// own, when no answer came (`awaitDecision` in userscript-prelude.js),
// and ours, when deciding threw. Its `detail` says why. The prelude
// names it too.
const SKIP_REASON_NO_DECISION = 'no-decision';

// What a script with no decision says, in its Log and on the badge.
// `detail` is the wrapper's why, which may carry Chrome's own message,
// ending in a period or not.
function noDecisionMessage(detail: string | undefined): string {
  const why = (detail ?? '').trim().replace(/\.+$/, '');
  return why ? `Did not run on this page. ${why}.` : 'Did not run on this page: SourceMonkey did not decide whether to run it';
}

// How long an armed tab waits for its reload to commit. Well past a
// live page's commit time, short enough that a cancelled reload can't
// poison a Ctrl-R the user makes later.
const SKIP_SCRIPTS_ARM_TTL_MS = 10_000;

// tabId → when it was armed, and for which reload.
const skipScriptsArmed = new Map<number, { at: number; mode: ReloadMode }>();
// tabId → the skip reload's document, and its mode.
const skipScriptsDocByTab = new Map<number, { documentId: string; mode: ReloadMode }>();

async function reloadTabWithMode(tabId: number, mode: ReloadMode): Promise<void> {
  skipScriptsArmed.set(tabId, { at: Date.now(), mode });
  try {
    await chrome.tabs.reload(tabId);
  } catch (err) {
    // The tab closed between the right-click and now, or is one Chrome
    // won't reload for us. Disarm so a later reload of a reused tab id
    // doesn't skip unasked.
    skipScriptsArmed.delete(tabId);
    console.info('[SourceMonkey] could not reload the tab:', describeError(err));
  }
}

// Called from the main-frame `onCommitted` listener, synchronously, so
// the marker is settled before the first wrapper can ask. Returns true
// when the committed document is the skip reload.
function noteCommitForSkipScripts(
  tabId: number,
  documentId: string,
  transitionType: string,
): boolean {
  const armed = skipScriptsArmed.get(tabId);
  // Any commit disarms; only a timely reload commit becomes a skip.
  skipScriptsArmed.delete(tabId);
  if (
    armed != null
    && transitionType === 'reload'
    && Date.now() - armed.at <= SKIP_SCRIPTS_ARM_TTL_MS
  ) {
    skipScriptsDocByTab.set(tabId, { documentId, mode: armed.mode });
    return true;
  }
  skipScriptsDocByTab.delete(tabId);
  return false;
}

// The skip reload's mode, when `documentId` is that reload's document.
function skipModeFor(tabId: number, documentId: string): ReloadMode | null {
  const entry = skipScriptsDocByTab.get(tabId);
  return entry && entry.documentId === documentId ? entry.mode : null;
}

// Whether a skip reload in `mode` keeps `scriptId` out, and the reason
// its `skip` reply carries.
function skipReasonFor(mode: ReloadMode, scriptId: string): string | null {
  if (mode.kind === 'none') return SKIP_REASON_RELOAD_WITHOUT_SCRIPTS;
  if (mode.kind === 'only') return scriptId === mode.scriptId ? null : SKIP_REASON_RELOAD_ONLY;
  return scriptId === mode.scriptId ? SKIP_REASON_RELOAD_WITHOUT_THIS : null;
}

function clearSkipScripts(tabId: number): void {
  skipScriptsArmed.delete(tabId);
  skipScriptsDocByTab.delete(tabId);
}

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
// What an sm-dev run's claim on the tab means for its badge, as the
// state fields: the run, and the ids of `matches` it lets run (null for
// none). Neither when the tab isn't claimed.
async function smDevClaimFields(tabId: number, matches: MatchedScript[]): Promise<Pick<TabMatchState, 'smDevRun' | 'smDevAllow'>> {
  await claimsReady();
  const claim = activeClaim(tabId);
  if (!claim) return {};
  const allowed = matches.filter((m) => claimAllows(claim, m.smDevRun ?? null)).map((m) => m.id);
  return { smDevRun: claim.runId, smDevAllow: allowed.length > 0 ? allowed : null };
}

// The matches a tab's badge expects. A scratch script runs only in its
// own run's tabs (see handleCheckPending), so elsewhere it gets no row
// at all. In its run's tabs it does, and shows NOT_LOADED when the tab
// has its scripts off.
function expectedMatches(matches: MatchedScript[], smDevRun: string | undefined): MatchedScript[] {
  return matches.filter((m) => m.smDevRun === undefined || m.smDevRun === smDevRun);
}

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
  // From `onCommitted`: a document load, with its load event to come.
  commit = false,
): Promise<void> {
  // Above the non-injectable early return: leaving the flashing
  // document for a `chrome://` page is still leaving it. No repaint of
  // its own — both paths below end in renderBadge, which paints
  // whatever the flash state is by then.
  clearReloadFlashForOtherDoc(tabId, documentId ?? '');
  if (!url || !INJECTABLE_SCHEME.test(url)) {
    // Drop menu commands BEFORE renderBadge, whose popup notice has
    // an open popup read them back.
    clearMenuCommandsForTab(tabId);
    await renderBadge(tabId, null);
    await clearTabState(tabId);
    return;
  }
  await ensureLoaded();
  const incoming = findMatchesForUrl(url);
  const record = await getTabRecord(tabId);
  // A refresh re-checks a document already tracked. One with no record
  // loaded unseen (before the extension started): making one here
  // would show all its scripts as missing, under no document id.
  if (trigger === 'refresh' && !record) return;
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
    // scratch. renderBadge at the end of this function tells an open
    // popup, which then shows the cleared list.
  }
  // A refresh-driven re-evaluation must NOT silently drop staleScriptIds —
  // those are kept across navigation events anyway, but extra-explicit
  // here because we're rebuilding the state object from scratch.
  const staleScriptIds = restored && prev?.staleScriptIds ? prev.staleScriptIds : undefined;
  const state: TabMatchState = staleScriptIds
    ? { documentId: docId, url, matches, actual, staleScriptIds }
    : { documentId: docId, url, matches, actual };
  // A restored document keeps whatever it had — a bfcache return to a
  // skipped document is still that document, with nothing running.
  // A fresh one asks the in-memory marker the commit listener set.
  if (restored) {
    if (prev.scriptsSkipped) state.scriptsSkipped = true;
    if (prev.skipOnly !== undefined) state.skipOnly = prev.skipOnly;
    if (prev.skipWithout !== undefined) state.skipWithout = prev.skipWithout;
  } else {
    const mode = skipModeFor(tabId, docId);
    if (mode?.kind === 'none') state.scriptsSkipped = true;
    if (mode?.kind === 'only') state.skipOnly = mode.scriptId;
    if (mode?.kind === 'without') state.skipWithout = mode.scriptId;
  }
  // Likewise what an sm-dev run's claim on the tab let run.
  if (restored) {
    if (prev.smDevAllow !== undefined) state.smDevAllow = prev.smDevAllow;
    if (prev.smDevRun !== undefined) state.smDevRun = prev.smDevRun;
  } else {
    Object.assign(state, await smDevClaimFields(tabId, state.matches));
  }
  state.matches = expectedMatches(state.matches, state.smDevRun);
  // What the document's reports said about it, and whether its
  // never-started check already ran, belong to the document too.
  if (restored) {
    if (prev.reportedWorlds) state.reportedWorlds = prev.reportedWorlds;
    if (prev.opaqueOrigin) state.opaqueOrigin = true;
    if (prev.missingChecked) state.missingChecked = true;
    if (prev.settleBy !== undefined) state.settleBy = prev.settleBy;
    if (prev.loadMatchIds) state.loadMatchIds = prev.loadMatchIds;
    if (prev.loadUrl) state.loadUrl = prev.loadUrl;
    if (prev.warnedIds) state.warnedIds = prev.warnedIds;
    if (prev.manualRuns) state.manualRuns = prev.manualRuns;
    if (prev.loadedBefore) state.loadedBefore = true;
    if (prev.frameRuns) state.frameRuns = prev.frameRuns;
  } else {
    state.loadMatchIds = incoming.map((m) => m.id);
    state.loadUrl = url;
  }
  // Restored too: a report can set up the document's state before its
  // commit gets here.
  if (commit && !state.missingChecked) state.settleBy = Date.now() + SETTLE_CAP_MS;
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
  if (trigger === 'navigation') {
    const manual = findMatchesForUrl(url, 'manual');
    // Their next run uses the current copy, so keep it current too.
    if (manual.length > 0) requestOpportunisticScriptChecks(manual.map((m) => m.id), batch);
    await reportManualScriptsWaiting(tabId, docId, url);
  }
  await renderBadge(tabId, state);
}

// Tell sm-dev which manual scripts can be run in a tab a run controls:
// they won't report starting, since they wait to be run, so this is
// their word from the document (`sm:manual`). Sent on every navigation,
// a back/forward restore and a pushState included: sm-dev forgets them
// when the page moves, and keeps one report per document. Only what
// the claim lets run, so not in a tab with its scripts off.
async function reportManualScriptsWaiting(tabId: number, documentId: string, url: string): Promise<void> {
  await claimsReady();
  if (!activeClaim(tabId)) return;
  for (const m of await runnableManualScripts(tabId, url)) {
    emitSmDevEvent({
      kind: 'report', type: SM_MANUAL_MSG, tabId, documentId, topFrame: true, scriptId: m.id, name: m.name, url,
    });
  }
}

// The scripts Chrome is currently refusing to register, as a set for
// the badge rows. Read per call rather than cached: it changes rarely and
// a stale copy would keep painting REJECTED after a fix landed.
async function rejectedScriptIds(): Promise<ReadonlySet<string>> {
  return new Set(Object.keys(await readRejections()));
}

async function renderBadge(tabId: number, state: TabMatchState | null): Promise<void> {
  // Each setX call can reject if the tab closed between our query and
  // here; swallow that rather than spamming the SW console.
  try {
    // Summed up from the popup's view, so the two can't disagree.
    const summary = summarizeToolbar(await buildTabView(tabId, state), state);
    await chrome.action.setTitle({ tabId, title: summary.title });
    if (summary.color === null) {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } else {
      // The reload flash is a paint-time override, not part of the
      // summary: it says "an update is landing right now", which
      // is a property of the swap in flight rather than of the tab's
      // expected/actual sets. RED still wins — an error the user has
      // to act on outranks a transient progress signal.
      const color = summary.color !== BADGE_RED && isReloadFlashing(tabId)
        ? BADGE_PURPLE : summary.color;
      await chrome.action.setBadgeText({ tabId, text: String(summary.count) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
    }
  } catch {
    /* tab probably closed; nothing useful to do */
  }
  await markSmDevTab(tabId, state?.smDevAllow !== undefined);
  notifyPopup(tabId);
}

// ---------- The sm-dev marker on the icon ----------
//
// A tab whose page loaded under an sm-dev run's claim (sm-dev-link.ts)
// gets the toolbar icon with a cyan "T" in its top-left corner, clear of
// the badge at the bottom right. Chrome gives a tab one badge, so the
// marker is drawn into a per-tab icon instead.

// Tabs given the marked icon, so only they are set back.
const markedTabs = new Set<number>();
// Tabs rendered since this worker started: a worker that restarted
// doesn't know which tabs an earlier one marked, so each tab's first
// render sets its icon back if it isn't marked.
const markCheckedTabs = new Set<number>();
let markedIcon: Promise<Record<string, ImageData>> | null = null;

// The default icon with the marker, at the sizes the toolbar uses.
function drawMarkedIcon(): Promise<Record<string, ImageData>> {
  markedIcon ??= (async () => {
    const out: Record<string, ImageData> = {};
    for (const [size, file] of [[16, 'icons/icon-16.png'], [32, 'icons/icon-48.png']] as const) {
      const blob = await (await fetch(chrome.runtime.getURL(file))).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(size, size);
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0, size, size);
      const box = Math.round(size * 0.5);
      g.fillStyle = SM_DEV_MARKER_CYAN;
      g.beginPath();
      g.roundRect(0, 0, box, box, Math.max(1, size / 16));
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = `bold ${Math.round(box * 0.85)}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('T', box / 2, box / 2 + size / 32);
      out[String(size)] = g.getImageData(0, 0, size, size);
    }
    return out;
  })();
  markedIcon.catch(() => { markedIcon = null; });
  return markedIcon;
}

// `chrome.action.setIcon`, rejecting when it fails. Its promise form
// resolves even for a tab that has closed, and Chrome then logs the
// error to chrome://extensions as an unchecked runtime.lastError. The
// callback form hands the error over, and reading it keeps it quiet.
function setActionIcon(details: chrome.action.TabIconDetails): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.action.setIcon(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'The icon could not be set'));
      else resolve();
    });
  });
}

async function markSmDevTab(tabId: number, on: boolean): Promise<void> {
  const firstCheck = !markCheckedTabs.has(tabId);
  markCheckedTabs.add(tabId);
  try {
    if (on) {
      await setActionIcon({ tabId, imageData: await drawMarkedIcon() });
      markedTabs.add(tabId);
    } else if (markedTabs.has(tabId) || firstCheck) {
      markedTabs.delete(tabId);
      const icons = chrome.runtime.getManifest().action?.default_icon;
      // Absolute: the manifest's paths are from the extension's root,
      // and this worker runs from extension/, not the root.
      if (icons) {
        const path = Object.fromEntries(Object.entries(icons as Record<string, string>)
          .map(([size, file]) => [size, chrome.runtime.getURL(file)]));
        await setActionIcon({ tabId, path });
      }
    }
  } catch (err) {
    // The tab closed meanwhile, or the icon couldn't be drawn.
    console.info('[SourceMonkey] could not set the sm-dev marker:', describeError(err));
  }
}

// ---------- Toolbar popup ("Active scripts") ----------
//
// A click on the toolbar icon opens the popup (popup.html); a double
// click opens the collections page. See docs/status-popup.md.
//
// Chrome can't report a second click while a popup is set: one set
// opens on the first click, and `action.onClicked` never fires. So none
// is set. A click sets the popup on its tab just long enough for
// `action.openPopup` to open it, then clears it so the next click
// reaches onClicked again.
//
// The popup opens on the first click, and a second within
// DOUBLE_CLICK_MS takes it back and opens the collections page. Chrome
// mostly takes that second click itself, so it is also read from what
// it does to the popup (`popupClosedEarly`).

const POPUP_PAGE = 'popup.html';
// How long after a click a second one counts as a double click. Nothing
// waits on it, so it can be as long as a desktop's usual double click.
// It needs the room: Chrome takes ~200ms to show a popup, and a second
// click shows up as the popup closing, often after 250ms.
const DOUBLE_CLICK_MS = 500;
// No second click comes sooner than this after the first.
const MIN_SECOND_CLICK_MS = 50;
// How long a popup's close is held before it counts as a second click,
// for Chrome to report the tab closing or being left (Ctrl+W right
// after the click closes the popup too).
const CLOSE_SETTLE_MS = 150;
// Per window: two quick clicks in different windows are two clicks.
interface PendingActionClick {
  timer: ReturnType<typeof setTimeout>;
  tabId: number | undefined;
  at: number;
  // Its tab closed or was left, so its popup's close is no second click.
  dropped?: boolean;
}
const pendingActionClicks = new Map<number, PendingActionClick>();

// Tabs whose popup a double click took back before it connected, by
// when. A popup still opening then connects late, and is told to close
// on arrival.
const cancelledPopups = new Map<number, number>();
const CANCELLED_POPUP_TTL_MS = 2000;

// Tabs whose popup closed without counting as a second click, by when.
// Chrome takes a click on the icon while the popup shows, closing it and
// reporting nothing, so that close may be the first click of a double
// click: a click within DOUBLE_CLICK_MS of it is the second.
const closedPopups = new Map<number, number>();

function noteClosedPopup(tabId: number): void {
  const now = Date.now();
  // Pruned here: a tab can close before its popup's port reports it,
  // leaving an entry nothing would remove.
  for (const [id, at] of closedPopups) {
    if (now - at >= DOUBLE_CLICK_MS) closedPopups.delete(id);
  }
  closedPopups.set(tabId, now);
}

function handleActionClick(tab: Pick<chrome.tabs.Tab, 'id' | 'windowId'> | undefined): void {
  const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_NONE;
  const pending = pendingActionClicks.get(windowId);
  if (pending !== undefined) {
    actionDoubleClick(windowId, pending, 'second click');
    return;
  }
  const tabId = tab?.id;
  const closedAt = tabId !== undefined ? closedPopups.get(tabId) : undefined;
  if (tabId !== undefined) closedPopups.delete(tabId);
  if (closedAt !== undefined && Date.now() - closedAt < DOUBLE_CLICK_MS) {
    dlog(`[SourceMonkey] toolbar double click, ${Date.now() - closedAt}ms after the popup closed`);
    void openCollectionsPage(windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId);
    return;
  }
  // A new popup, which an older double click must not close.
  if (tabId !== undefined) cancelledPopups.delete(tabId);
  pendingActionClicks.set(windowId, {
    tabId,
    at: Date.now(),
    timer: setTimeout(() => {
      pendingActionClicks.delete(windowId);
    }, DOUBLE_CLICK_MS),
  });
  void openActionPopup(tab);
}

// `how` says what showed the second click, for the debug log.
function actionDoubleClick(windowId: number, pending: PendingActionClick, how: string): void {
  dlog(`[SourceMonkey] toolbar double click, ${Date.now() - pending.at}ms apart (${how})`);
  clearTimeout(pending.timer);
  pendingActionClicks.delete(windowId);
  if (pending.tabId !== undefined) closeActionPopup(pending.tabId);
  void openCollectionsPage(windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId);
}

// Close the popup the first click of a double click opened, or is still
// opening.
function closeActionPopup(tabId: number): void {
  const ports = popupPorts.get(tabId);
  if (!ports?.size) {
    cancelledPopups.set(tabId, Date.now());
    return;
  }
  for (const port of ports) postPopupClose(port);
}

function postPopupClose(port: chrome.runtime.Port): void {
  const msg: PopupCloseMessage = { type: POPUP_CLOSE_MESSAGE };
  try {
    port.postMessage(msg);
  } catch {
    // Already closed.
  }
}

// The pending first click on `tabId`, if any.
function pendingClickOnTab(tabId: number): [number, PendingActionClick] | null {
  for (const entry of pendingActionClicks) {
    if (entry[1].tabId === tabId) return entry;
  }
  return null;
}

// A popup that closed, or failed to open, within the double-click
// time, without being told to. Chrome can take the second click itself
// when it lands on the icon with the popup showing or opening: it
// closes the popup, or drops the open, and never reports the click. So
// that stands for the click, unless the tab went away or out of view
// meanwhile, which closes the popup too.
//   - `notBeforeMs`: ignored this soon after the first click.
//   - `openedAt`: when the popup that closed connected. One from before
//     the click is an older popup, not this click's.
// True when it may count, decided after CLOSE_SETTLE_MS.
function popupClosedEarly(tabId: number, how: string, opts: { notBeforeMs?: number; openedAt?: number } = {}): boolean {
  const found = pendingClickOnTab(tabId);
  if (!found) return false;
  const [windowId, pending] = found;
  if (Date.now() - pending.at < (opts.notBeforeMs ?? 0)) return false;
  if (opts.openedAt !== undefined && opts.openedAt < pending.at) return false;
  // Held, so it stops the double-click timer from expiring meanwhile.
  clearTimeout(pending.timer);
  setTimeout(() => void settleEarlyClose(windowId, tabId, pending, how), CLOSE_SETTLE_MS);
  return true;
}

async function settleEarlyClose(windowId: number, tabId: number, pending: PendingActionClick, how: string): Promise<void> {
  if (pending.dropped || pendingActionClicks.get(windowId) !== pending) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (pending.dropped || pendingActionClicks.get(windowId) !== pending) return;
  if (!tab?.active) {
    pendingActionClicks.delete(windowId);
    return;
  }
  actionDoubleClick(windowId, pending, how);
}

// The tab a first click opened the popup on closed or was left: its
// popup closes with it, which is no second click.
function dropPendingClick(tabId: number): void {
  const found = pendingClickOnTab(tabId);
  if (!found) return;
  found[1].dropped = true;
  clearTimeout(found[1].timer);
  pendingActionClicks.delete(found[0]);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  dropPendingClick(tabId);
  closedPopups.delete(tabId);
});
// Another tab of the window came forward.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const pending = pendingActionClicks.get(windowId);
  if (pending?.tabId !== undefined && pending.tabId !== tabId) dropPendingClick(pending.tabId);
});

// The popup closed itself after an action (a link, a menu command):
// that close isn't a second click.
function popupClosingOnPurpose(tabId: number): void {
  dropPendingClick(tabId);
}

async function openActionPopup(tab: Pick<chrome.tabs.Tab, 'id' | 'windowId'> | undefined): Promise<void> {
  const tabId = tab?.id;
  if (tabId == null) return;
  try {
    // Asked alongside the open rather than before it, so the open isn't
    // held up. The new popup can't be listed before it is asked for.
    const beforeOpen = popupContextIds();
    await chrome.action.setPopup({ tabId, popup: POPUP_PAGE });
    // Cleared as soon as Chrome has the open request, not once the
    // popup shows: while one is set, a click on the icon goes to Chrome
    // rather than onClicked. The open still goes ahead. Even so the
    // clear lands only some 50-130ms after the click, and a second click
    // before then is Chrome's (see `popupClosedEarly`).
    const opening = chrome.action.openPopup(tab?.windowId != null ? { windowId: tab.windowId } : {});
    // Handled now: it can fail while the clear is still on its way, and
    // an unhandled rejection lands in chrome://extensions errors.
    opening.catch(() => { /* awaited below */ });
    await chrome.action.setPopup({ tabId, popup: '' }).catch(() => { /* tab closed */ });
    await opening;
    const before = await beforeOpen;
    if (tab?.windowId != null) void watchForEarlyClose(tab.windowId, tabId, before);
  } catch (err) {
    await chrome.action.setPopup({ tabId, popup: '' }).catch(() => { /* tab closed */ });
    // A second click while Chrome was still opening it: Chrome takes
    // that click itself, dropping the open, and reports nothing else.
    // Chrome's error doesn't say which cause it was, so this goes by
    // timing alone: a failure sooner than MIN_SECOND_CLICK_MS can't be
    // a second click, and a later one is taken for one.
    if (popupClosedEarly(tabId, 'the popup failed to open', { notBeforeMs: MIN_SECOND_CLICK_MS })) return;
    // Chrome refuses when the window lost focus, or the tab closed.
    // Nothing the user can act on.
    console.info('[SourceMonkey] could not open the popup:', describeError(err));
  }
}

// How often `watchForEarlyClose` looks.
const EARLY_CLOSE_POLL_MS = 15;

// Popup contexts open now, by id. Chrome reports a popup with no window
// or tab (both -1), so a popup is told apart only by its id.
async function popupContextIds(): Promise<Set<string> | null> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] });
    return new Set(contexts.map((c) => c.contextId));
  } catch {
    return null;
  }
}

// Watches the popup the first click opened until the double-click time
// is up, and counts its closing meanwhile as the second click
// (`popupClosedEarly`). The port's disconnect says the same, but a popup
// Chrome closes while it is still loading never connects. `before` is
// the popups open before this one, to tell which is new.
async function watchForEarlyClose(windowId: number, tabId: number, before: Set<string> | null): Promise<void> {
  const pending = pendingActionClicks.get(windowId);
  if (pending?.tabId !== tabId || before === null) return;
  const now = await popupContextIds();
  if (now === null) return;
  const ours = [...now].filter((id) => !before.has(id));
  // Not listed yet, or already gone: the port's disconnect still tells.
  // Contexts aren't per window, so a popup another window opened
  // meanwhile is counted as ours too; that can only hide a close, never
  // invent one.
  if (ours.length === 0) return;
  while (pendingActionClicks.get(windowId) === pending) {
    const open = await popupContextIds();
    if (open === null) return;
    if (!ours.some((id) => open.has(id))) {
      if (pendingActionClicks.get(windowId) === pending) popupClosedEarly(tabId, 'the popup closed');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, EARLY_CLOSE_POLL_MS));
  }
}

// What the popup shows for `tabId`. Gathers the inputs and leaves the
// rules to `buildPopupView`.
async function popupViewForTab(
  tabId: number,
  keepIds: readonly string[] = [],
  // The URL the popup placed `keepIds` for. On another URL they're a
  // previous page's rows, so they're dropped.
  keepUrl?: string,
): Promise<PopupView> {
  // Runs in frames that are gone, and their menu commands, don't show.
  await inTabQueue(tabId, () => pruneGoneFramesAndRepaint(tabId));
  return buildTabView(tabId, undefined, keepIds, keepUrl);
}

// Drop what the tab holds for frame documents it no longer has: their
// runs on the badge and their menu commands. A frame that navigated or
// was removed has no event of its own that says so. Returns whether
// anything went (and so a repaint is due). See docs/frames.md.
async function pruneGoneFrames(tabId: number): Promise<boolean> {
  const record = await getTabRecord(tabId);
  const current = getCurrentState(record);
  // Nothing held for frames: no need to ask Chrome. Most frame commits
  // (ads, trackers) land here.
  if (!current?.frameRuns && !hasFrameMenuDocuments(tabId)) return false;
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    return false;
  }
  if (!frames) return false;
  const live = new Set(frames.map((f) => (f as { documentId?: string }).documentId ?? ''));
  const menuChanged = pruneMenuDocuments(tabId, live);
  if (!record || !current) return menuChanged;
  const next = pruneFrameRuns(current, live);
  if (next === current) return menuChanged;
  await setTabRecord(tabId, writeDocState(record, record.currentDocId, next));
  return true;
}

// `pruneGoneFrames`, then repaint the badge (and an open popup) when
// anything went.
async function pruneGoneFramesAndRepaint(tabId: number): Promise<void> {
  if (await pruneGoneFrames(tabId)) await renderBadge(tabId, getCurrentState(await getTabRecord(tabId)));
}

// The popup's view of a tab. `stateIn` is the state a badge paint is for; undefined reads the
// tab's current one.
async function buildTabView(
  tabId: number,
  stateIn: TabMatchState | null | undefined,
  keepIds: readonly string[] = [],
  keepUrl?: string,
): Promise<PopupView> {
  await ensureLoaded();
  // A paint's state carries its document's URL. The tab's own can
  // already be the next page's, mid-navigation.
  let url = stateIn?.url ?? '';
  if (!stateIn) {
    try {
      url = (await chrome.tabs.get(tabId)).url ?? '';
    } catch {
      // The tab closed; shown as a page nothing runs on.
    }
  }
  const injectable = INJECTABLE_SCHEME.test(url);
  if (keepUrl !== url) keepIds = [];
  const recorded = !injectable ? null
    : stateIn !== undefined ? stateIn : getCurrentState(await getTabRecord(tabId));
  // A state for another URL is the previous page's, read before the new
  // one's commit was recorded (slow on a busy worker): its rows aren't
  // this page's. What matches the URL stands in until the state lands.
  const state = recorded && stateIn === undefined && recorded.url !== url ? null : recorded;
  const rejected = await readRejections();
  const badgeRows = state ? computeBadge(state, new Set(Object.keys(rejected))).rows : [];
  const matching = injectable ? findAllMatchingIds(url) : [];
  // After an in-place URL change (pushState), what matched the URL the
  // document loaded at tells "enabled since" from "matches only the new
  // URL" (`buildPopupView`).
  const loadUrl = state?.loadUrl;
  const loadUrlMatchingIds = loadUrl && loadUrl !== url ? new Set(findAllMatchingIds(loadUrl)) : undefined;
  const ids = [...new Set([...matching, ...badgeRows.map((r) => r.id), ...keepIds])];
  const runnable = injectable ? await runnableManualScripts(tabId, url) : [];
  const [stored, collections, times] = await Promise.all([popupScriptInputs(ids), getCollections(), getEnablementTimes()]);
  // A scratch script runs only in its own run's tabs, so elsewhere it
  // isn't listed, as on the badge (`expectedMatches`).
  const listed = stored.filter((s) => s.run === null || s.run === state?.smDevRun);
  const view = buildPopupView({
    url,
    injectable,
    state,
    badgeRows,
    rejected,
    matchingIds: new Set(matching),
    scripts: listed.map((s) => ({
      ...s.input,
      activeSince: times[s.input.id]?.activeSince,
      inactiveSince: times[s.input.id]?.inactiveSince,
    })),
    collections: collections.map((c) => ({
      id: c.id,
      name: effectiveDisplayName(c),
      path: c.path,
      enabled: isCollectionEnabled(c),
    })),
    menuCommands: getMenuCommandsForTab(tabId),
    manualRunnableIds: new Set(runnable.map((m) => m.id)),
    keepIds: new Set(keepIds),
    loadUrlMatchingIds,
    hiddenIds: new Set(stored.filter((s) => !listed.includes(s)).map((s) => s.input.id)),
  });
  return view;
}

// What the popup's view needs of each stored script, cached by id. A
// badge paint builds that view, and paints come with every script
// report, so reading whole rows (bodies included) each time would be a
// storage read per report. A write to a script's row drops its entry.
// The copy's active times live in their own storage key, so they're
// read per view rather than cached here.
interface CachedPopupScript {
  input: Omit<PopupScriptInput, 'activeSince' | 'inactiveSince'>;
  // The sm-dev run a scratch script belongs to, or null.
  run: string | null;
}
const popupScriptCache = new Map<string, CachedPopupScript>();
// Bumped on every drop, so a read that started before a write doesn't
// cache what it read: a deleted script would stay listed as stored.
let popupScriptGeneration = 0;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (!key.startsWith(SCRIPT_PREFIX)) continue;
    popupScriptCache.delete(key.slice(SCRIPT_PREFIX.length));
    popupScriptGeneration++;
  }
});

async function popupScriptInputs(ids: readonly string[]): Promise<CachedPopupScript[]> {
  const missing = ids.filter((id) => !popupScriptCache.has(id));
  const fresh = new Map<string, CachedPopupScript>();
  if (missing.length > 0) {
    const generation = popupScriptGeneration;
    for (const s of await getScriptMetas(missing)) {
      fresh.set(s.id, {
        input: {
          id: s.id,
          name: scriptDisplayName(s),
          collectionId: s.collectionId,
          enabled: isScriptEnabled(s),
          identity: identityKey(s.header ?? null),
          version: (s.header ? getValue(s.header, 'version')?.trim() : '') || null,
          headerWarnings: s.startupLogs?.some((l) => l.level === 'warn') ?? false,
          location: s.fileUrl,
          ...(s.status === 'invalid'
            ? { invalid: s.errorMessage ? describeDiagnostic(s.errorMessage, s.errorLocation) : '' }
            : {}),
          ...(isManualScript(s) ? { manual: true } : {}),
        },
        run: scratchRunOf(s.fileUrl),
      });
    }
    if (generation === popupScriptGeneration) for (const [id, entry] of fresh) popupScriptCache.set(id, entry);
  }
  return ids.flatMap((id) => {
    const entry = fresh.get(id) ?? popupScriptCache.get(id);
    return entry ? [entry] : [];
  });
}

// Open popups, by the tab they show. Each popup holds a port named for
// its tab (`POPUP_PORT_PREFIX` + id) while it's open, so a change is
// sent only where a popup is showing that tab, not broadcast to every
// extension page on every badge paint.
const popupPorts = new Map<number, Set<chrome.runtime.Port>>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(POPUP_PORT_PREFIX) || !port.sender || !fromExtensionPage(port.sender)) return;
  const tabId = Number(port.name.slice(POPUP_PORT_PREFIX.length));
  if (!Number.isInteger(tabId)) return;
  let ports = popupPorts.get(tabId);
  if (!ports) popupPorts.set(tabId, ports = new Set());
  ports.add(port);
  const connectedAt = Date.now();
  // popup.html open in an ordinary tab (tests) is no toolbar popup.
  const isToolbarPopup = port.sender.tab === undefined;
  let closingOnPurpose = false;
  port.onMessage.addListener((message) => {
    if ((message as Partial<PopupClosingMessage> | null)?.type !== POPUP_CLOSING_MESSAGE) return;
    closingOnPurpose = true;
    popupClosingOnPurpose(tabId);
  });
  // A double click took this popup back while it was still opening.
  const cancelledAt = cancelledPopups.get(tabId);
  if (cancelledAt !== undefined) {
    cancelledPopups.delete(tabId);
    if (Date.now() - cancelledAt < CANCELLED_POPUP_TTL_MS) postPopupClose(port);
  }
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (ports.size === 0) popupPorts.delete(tabId);
    if (isToolbarPopup && !closingOnPurpose
      && !popupClosedEarly(tabId, 'the popup disconnected', { openedAt: connectedAt })) {
      // Perhaps a click on the icon closed it (see `closedPopups`).
      noteClosedPopup(tabId);
    }
  });
});

// Tell an open popup that what it shows for `tabId` changed.
function notifyPopup(tabId: number): void {
  const ports = popupPorts.get(tabId);
  if (!ports) return;
  const msg: PopupChangedMessage = { type: POPUP_CHANGED_MESSAGE, tabId };
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      // Its popup just closed; the disconnect handler drops it.
    }
  }
}

// A popup request's fields, checked rather than trusted: only our own
// pages can send one, but a malformed `mode` would otherwise fall into
// the last branch of `skipReasonFor`.
function isReloadMode(value: unknown): value is ReloadMode {
  const m = value as Partial<{ kind: string; scriptId: unknown }> | null;
  if (!m || typeof m !== 'object') return false;
  if (m.kind === 'none') return true;
  return (m.kind === 'only' || m.kind === 'without') && typeof m.scriptId === 'string';
}

// ---------- The icon's right-click menu ----------
//
// - The double click's action, worded so it doubles as a hint that the
//   double click exists.
// - Reload with no userscripts, as in the popup's page menu: quicker
//   there when a script is breaking the page.
// The popup has everything else.
//
// Recreated every time the worker starts, not only on install: menu
// items persist with the extension, but not necessarily through it
// being disabled and re-enabled, which fires no `onInstalled`. Cheap.
// `removeAll` first, as a duplicate id fails.

const OPEN_COLLECTIONS_MENU_ID = 'sm-open-collections';
const OPEN_COLLECTIONS_MENU_TITLE = 'Open Collections page (double-click)';
const RELOAD_NO_SCRIPTS_MENU_ID = 'sm-reload-no-scripts';

function createActionMenu(): void {
  // Read so Chrome doesn't report an unchecked error.
  const checkCreated = (): void => {
    if (chrome.runtime.lastError) {
      console.info('[SourceMonkey] could not create the icon menu:', chrome.runtime.lastError.message);
    }
  };
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: OPEN_COLLECTIONS_MENU_ID,
      title: OPEN_COLLECTIONS_MENU_TITLE,
      contexts: ['action'],
    }, checkCreated);
    chrome.contextMenus.create({
      id: RELOAD_NO_SCRIPTS_MENU_ID,
      title: RELOAD_NO_SCRIPTS_LABEL,
      contexts: ['action'],
    }, checkCreated);
  });
}

createActionMenu();
// The window and tab the right-click came from: the active tab as the
// worker last saw it can be stale.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === OPEN_COLLECTIONS_MENU_ID) void openCollectionsPage(tab?.windowId ?? null);
  else if (info.menuItemId === RELOAD_NO_SCRIPTS_MENU_ID) void reloadNoScriptsFromMenu(tab?.id ?? null);
});

// The menu is the same on every tab, so the item shows on a tab an
// sm-dev run controls too, where the popup leaves it out: there the run
// chooses what runs, and skipping would drop its scripts as well.
async function reloadNoScriptsFromMenu(tabId: number | null): Promise<void> {
  if (tabId === null) {
    console.info('[SourceMonkey] could not reload with no userscripts: Chrome did not say which tab');
    return;
  }
  await claimsReady();
  if (activeClaim(tabId)) {
    console.info('[SourceMonkey] not reloading with no userscripts: an sm-dev run controls this tab');
    return;
  }
  await reloadTabWithMode(tabId, { kind: 'none' });
}

// ---------- Unused blob cleanup ----------
// See docs/storage.md#writing-and-cleanup. A change that leaves a blob
// unused runs a check at once, so a removal frees its space right away
// (which matters most near the storage quota). An alarm set at the same
// time is the backstop for a worker stopped before the check ran; a
// check that finishes clears it.
const BLOB_SWEEP_ALARM = 'sm-blob-sweep';
const BLOB_SWEEP_BACKSTOP_MINUTES = 0.5;

// Set by `resetAllState`: tests run the checks themselves
// (`sweepUnusedBlobs` on the test surface), and a real one running
// mid-test would delete blobs under them.
let realBlobSweepsPaused = false;

// A check queued and not yet started: a burst of changes needs one.
let blobSweepQueued = false;

function requestBlobSweep(): void {
  if (realBlobSweepsPaused || blobSweepQueued) return;
  blobSweepQueued = true;
  void chrome.alarms.create(BLOB_SWEEP_ALARM, { delayInMinutes: BLOB_SWEEP_BACKSTOP_MINUTES }).catch((err: unknown) => {
    console.info('[SourceMonkey] could not schedule removing unused stored files:', describeError(err));
  });
  runBlobSweep().catch((err: unknown) => {
    console.info('[SourceMonkey] could not remove unused stored files:', describeError(err));
  });
}

// A removal is always logged; the check itself only with debug logging on.
async function runBlobSweep(): Promise<void> {
  if (realBlobSweepsPaused) return;
  // Taken inside the lock, so a change that lands while this one waits
  // for it queues its own check, which then sees that change. Paused
  // checked again there: a test reset may have come in between.
  const result = await sweepUnusedBlobsLocked(() => {
    blobSweepQueued = false;
    return !realBlobSweepsPaused;
  });
  if (!result) return;
  const { checked, removed } = result;
  if (removed > 0) console.info(`[SourceMonkey] removed ${removed} stored file(s) no script uses`);
  dlog(`[SourceMonkey] unused stored files: checked ${checked}, removed ${removed}`);
  // Not while another check is queued: its backstop is the same alarm.
  if (!blobSweepQueued) await chrome.alarms.clear(BLOB_SWEEP_ALARM);
}

function installBlobSweep(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith(SCRIPT_PREFIX) && droppedBlobRefs(change.oldValue, change.newValue)) {
        requestBlobSweep();
        return;
      }
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== BLOB_SWEEP_ALARM) return;
    runBlobSweep().catch((err: unknown) => {
      console.info('[SourceMonkey] could not remove unused stored files:', describeError(err));
    });
  });
}

// The popup's requests. Only from our own pages, like the other page
// relays: a reload or a menu command is an action on a tab, and a
// toggle changes what runs everywhere.
function installPopupListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as { type?: unknown } | null;
    if (!msg || !fromExtensionPage(sender)) return undefined;
    if (msg.type === POPUP_SET_ENABLED_MESSAGE) {
      const req = msg as Partial<PopupSetEnabledRequest>;
      if (typeof req.id !== 'string' || typeof req.enabled !== 'boolean'
        || (req.target !== 'script' && req.target !== 'collection')) {
        sendResponse(null);
        return undefined;
      }
      // Exclusive, as every enable control is (docs/script-enablement.md).
      const solo = req.solo === true;
      const write = req.target === 'script'
        ? setScriptEnabledExclusive(req.id, req.enabled, solo)
        : setCollectionEnabledExclusive(req.id, req.enabled, solo);
      // `ok` tells the popup whether to put the box back.
      write.then(
        () => { try { sendResponse({ ok: true }); } catch { /* popup gone */ } },
        (err) => {
          console.info('[SourceMonkey] popup could not change a checkbox:', describeError(err));
          try { sendResponse({ ok: false }); } catch { /* popup gone */ }
        },
      );
      return true;
    }
    if (
      msg.type !== POPUP_VIEW_MESSAGE && msg.type !== POPUP_RELOAD_MESSAGE
      && msg.type !== POPUP_COMMAND_MESSAGE && msg.type !== POPUP_RUN_SCRIPT_MESSAGE
    ) {
      return undefined;
    }
    const tabId = (msg as { tabId?: unknown }).tabId;
    if (typeof tabId !== 'number') {
      sendResponse(null);
      return undefined;
    }
    let work: Promise<unknown>;
    if (msg.type === POPUP_VIEW_MESSAGE) {
      const req = msg as Partial<PopupViewRequest>;
      const keepIds = Array.isArray(req.keepIds) ? req.keepIds.filter((id): id is string => typeof id === 'string') : [];
      work = popupViewForTab(tabId, keepIds, typeof req.keepUrl === 'string' ? req.keepUrl : undefined);
    } else if (msg.type === POPUP_RELOAD_MESSAGE) {
      const req = msg as Partial<PopupReloadRequest>;
      if (!isReloadMode(req.mode)) {
        sendResponse(null);
        return undefined;
      }
      work = reloadTabWithMode(tabId, req.mode);
    } else if (msg.type === POPUP_RUN_SCRIPT_MESSAGE) {
      const req = msg as Partial<PopupRunScriptRequest>;
      if (typeof req.scriptId !== 'string') {
        sendResponse(null);
        return undefined;
      }
      // The popup offers Run only where it can run, so a refusal means
      // something changed meanwhile. Said in the script's Log, since
      // the popup shows nothing else for it. (A failure from Chrome is
      // logged, and on the row, already.)
      const scriptId = req.scriptId;
      work = runManualScript(tabId, scriptId).then((result) => {
        if (!result.ok && !result.logged) {
          logScriptEvent(scriptId, { level: 'info', source: 'manual-run', tabId, message: `Not run: ${result.error}` });
        }
        return result;
      });
    } else {
      const req = msg as PopupCommandRequest;
      if (typeof req.scriptId !== 'string' || typeof req.commandId !== 'string') {
        sendResponse(null);
        return undefined;
      }
      const documentId = typeof req.documentId === 'string' ? req.documentId : undefined;
      work = dispatchMenuCommand(req.tabId, req.scriptId, req.commandId, documentId).then((result) => {
        // The command was unregistered between the popup drawing it and
        // the click. The popup redraws without it.
        if (!result.ok) console.info(`[SourceMonkey] menu command ${req.commandId} did not fire on tab ${req.tabId}: ${result.error}`);
        return result;
      });
    }
    work.then(
      (reply) => { try { sendResponse(reply ?? null); } catch { /* popup gone */ } },
      (err) => {
        console.info('[SourceMonkey] popup request failed:', describeError(err));
        try { sendResponse(null); } catch { /* popup gone */ }
      },
    );
    // Keep the message channel open for the async reply.
    return true;
  });
}

// Single source of truth for "fire this menu command on this tab".
// Validates the entry is still registered (script may have called
// unregister between the popup showing and the click firing) and sends
// the wrapper-side sm:gm-menu-fire message. Both the popup and the
// test surface call this — divergence between them would let tests
// claim coverage they don't actually have.
async function dispatchMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
  documentId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = findMenuCommand(tabId, scriptId, commandId, documentId);
  if (!entry) {
    // Not user-facing today, so not recased: the popup discards this
    // reply, and only the test surface reads it. If it ever reaches a
    // person, it takes a capital like any other message.
    return { ok: false, error: 'this menu command is no longer registered' };
  }
  try {
    // To the document that registered it: with scripts in frames, a
    // tab-wide send would reach every frame, and an explicit `{id}` can
    // name a command in more than one of them.
    await chrome.tabs.sendMessage(tabId, {
      type: 'sm:gm-menu-fire',
      smWorld: pushWorld(scriptId), smScript: scriptId,
      scriptId,
      commandId,
    }, entry.documentId ? { documentId: entry.documentId } : {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

// Whether a tab's sm-dev claim lets manual script `match` run there:
// the rule for scripts that run on load (`handleCheckPending`). A
// scratch script only in its own run's tabs, and in a tab a run
// controls, only what that run allows.
function manualRunAllowed(claim: SmDevClaim | null, match: MatchedScript): boolean {
  return claim ? claimAllows(claim, match.smDevRun ?? null) : match.smDevRun === undefined;
}

// The manual scripts that could be run on `tabId`'s page at `url` now:
// the popup's Run items and sm-dev's `sm:manual` reports, by the same
// rules `runManualScript` applies.
async function runnableManualScripts(tabId: number, url: string): Promise<MatchedScript[]> {
  await claimsReady();
  const claim = activeClaim(tabId);
  return findMatchesForUrl(url, 'manual').filter((m) => manualRunAllowed(claim, m));
}

// Documents each manual script was run in (documentId → script ids),
// for `bridgeMayActAs`, which runs on every page-world GM call and so
// mustn't read storage when it can help it. The tab state's
// `manualRuns` backs it after a worker restart. Oldest dropped past
// the cap; that only costs a storage read.
const manualRunDocs = new Map<string, Set<string>>();
const MANUAL_RUN_DOCS_MAX = 200;

function noteManualRunDoc(documentId: string, scriptId: string): void {
  const ids = manualRunDocs.get(documentId) ?? new Set<string>();
  ids.add(scriptId);
  manualRunDocs.delete(documentId);
  manualRunDocs.set(documentId, ids);
  if (manualRunDocs.size > MANUAL_RUN_DOCS_MAX) manualRunDocs.delete(manualRunDocs.keys().next().value!);
}

// Whether manual script `scriptId` was run in the sender's document.
async function manualRanIn(sender: chrome.runtime.MessageSender, scriptId: string): Promise<boolean> {
  const documentId = (sender as { documentId?: string }).documentId;
  const tabId = sender.tab?.id;
  if (!documentId || tabId === undefined) return false;
  if (manualRunDocs.get(documentId)?.has(scriptId)) return true;
  return getDocState(await getTabRecord(tabId), documentId)?.manualRuns?.[scriptId] !== undefined;
}

// Documents given the sandboxed-page fallback, so a second ask while the
// worker runs (a page can't send one, but a USER_SCRIPT-world script
// could) runs nothing twice. Oldest dropped past the cap.
const mainFallbackDocs = new Set<string>();
const MAIN_FALLBACK_DOCS_MAX = 200;
// How long the fallback waits for a reload's refresh of a script, so a
// reload runs the edited copy. The fallback is late anyway.
const MAIN_FALLBACK_REFRESH_WAIT_MS = 5_000;

// The sandboxed-page fallback. A CSP `sandbox` directive (or an
// `<iframe sandbox>`) without `allow-scripts` turns off script in the
// document's own world and gives it an opaque origin, so Chrome
// injects no MAIN-world script there.
// The bridge, in USER_SCRIPT world, notices (an opaque origin, and no
// MAIN-world prelude started) and asks for this. Each MAIN-world script that matches the
// document is injected into it in USER_SCRIPT world instead, as
// Violentmonkey falls back to its content world. There is no page code
// to share globals with on such a page, so the isolated world costs it
// nothing. Each still asks check-pending whether to run, as a
// registered copy would. See docs/injection.md#csp-sandbox-pages.
async function runBlockedMainScripts(tabId: number, sender: chrome.runtime.MessageSender): Promise<void> {
  const documentId = (sender as { documentId?: string }).documentId;
  const url = sender.url;
  if (!documentId || !url || sender.origin !== 'null') return;
  if (mainFallbackDocs.has(documentId)) return;
  mainFallbackDocs.add(documentId);
  if (mainFallbackDocs.size > MAIN_FALLBACK_DOCS_MAX) mainFallbackDocs.delete(mainFallbackDocs.values().next().value!);
  await ensureLoaded();
  await claimsReady();
  const frameId = sender.frameId ?? 0;
  // Not one Chrome refused to register: it wasn't skipped by the page.
  const rejected = await rejectedScriptIds();
  const found = findMatchesForUrl(url).filter((m) => m.world === 'MAIN' && !rejected.has(m.id) && !(m.noframes && frameId !== 0));
  const version = chrome.runtime.getManifest().version;
  const reload = fastPathByDoc.get(fastPathKey(tabId, documentId));
  for (const m of expectedMatches(found, activeClaim(tabId)?.runId)) {
    // On a reload, build from the refreshed copy, so the edit runs (the
    // copy's check-pending then finds nothing newer to swap in).
    const refresh = reload?.scripts.get(m.id)?.promise;
    if (refresh) await Promise.race([refresh, new Promise((r) => setTimeout(r, MAIN_FALLBACK_REFRESH_WAIT_MS))]);
    const script = await getScript(m.id);
    if (!script || script.status !== 'ok') continue;
    const injections = await buildIsolatedFallbackInjections(script, version, getScriptLogLabel(m.id));
    if (!injections) continue;
    dlog(`[SourceMonkey] running ${getScriptLogLabel(m.id)} isolated on sandboxed document ${documentId}`);
    try {
      await executeManualRun(tabId, documentId, injections);
    } catch (err) {
      console.info(`[SourceMonkey] could not run ${getScriptLogLabel(m.id)} on a sandboxed page:`, err);
    }
  }
}

// Run `fn` in `tabId`'s work queue (`enqueueTabWork`) and hand back
// what it returns, or its throw.
function inTabQueue<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueueTabWork(tabId, () => fn().then(resolve, reject));
  });
}

// `logged`: the failure is in the script's Log already.
type ManualRunResult = { ok: true } | { ok: false; error: string; logged?: true };

// Run manual script `scriptId` (`@run-at context-menu`) on `tabId`'s
// top frame now: the popup's "Run this script", and sm-dev's. Each call
// is another run. Always answers, so a caller never waits on a run that
// failed part way. See docs/manual-scripts.md.
async function runManualScript(tabId: number, scriptId: string): Promise<ManualRunResult> {
  try {
    return await tryManualRun(tabId, scriptId);
  } catch (err) {
    console.info(`[SourceMonkey] manual run of ${getScriptLogLabel(scriptId)} on tab ${tabId} failed:`, err);
    return { ok: false, error: `Internal error: ${describeError(err)}` };
  }
}

// Why stored script `scriptId` can't be run as a manual script now,
// going by its row alone, or null when it can.
async function manualScriptRefusal(scriptId: string): Promise<string | null> {
  const script = await getScriptMeta(scriptId);
  if (!script) return MANUAL_RUN_NOT_INSTALLED;
  if (!isManualScript(script)) return MANUAL_RUN_NOT_MANUAL;
  if (script.status !== 'ok') {
    return describeDiagnostic(script.errorMessage ?? 'This script failed to load', script.errorLocation);
  }
  if (!isScriptEnabled(script)) return MANUAL_RUN_SCRIPT_OFF;
  const collections = new Map((await getCollections()).map((c) => [c.id, c]));
  if (!isManualRunCandidate(script, collections)) return MANUAL_RUN_COLLECTION_OFF;
  return null;
}

async function tryManualRun(tabId: number, scriptId: string): Promise<ManualRunResult> {
  await ensureLoaded();
  const refusal = await manualScriptRefusal(scriptId);
  if (refusal) return { ok: false, error: refusal };
  let script = (await getScript(scriptId))!;
  let url = '';
  try {
    url = (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    return { ok: false, error: MANUAL_RUN_TAB_GONE };
  }
  if (!INJECTABLE_SCHEME.test(url)) return { ok: false, error: MANUAL_RUN_PAGE };
  const match = findMatchesForUrl(url, 'manual').find((m) => m.id === scriptId);
  if (!match) return { ok: false, error: MANUAL_RUN_NOT_HERE };
  await claimsReady();
  if (!manualRunAllowed(activeClaim(tabId), match)) return { ok: false, error: MANUAL_RUN_SM_DEV };
  // Never registered, so the sync's parse check hasn't seen it.
  const checked = (await verifyParseChecks([script])).get(scriptId);
  if (checked) script = checked;
  if (script.status !== 'ok') {
    return { ok: false, error: describeDiagnostic(script.errorMessage ?? 'This script does not parse', script.errorLocation) };
  }
  const gmValues = scriptGrantsSubsystem(scriptId, STORAGE_SUBSYSTEMS)
    ? await loadSnapshotForCheckPending(scriptId)
    : undefined;
  const injections = await buildManualRunInjections(
    script, chrome.runtime.getManifest().version, getScriptLogLabel(scriptId), gmValues,
  );
  // validateHeader keeps a script with no usable pattern from being `ok`.
  if (!injections) return { ok: false, error: 'Internal error: This script has no page pattern Chrome can use' };
  const name = scriptDisplayName(script);

  // Count the run on the document it's for, in the tab's queue, before
  // injecting: its own sm:start, queued behind, then finds a manual run
  // rather than an unexpected script. The page may have moved on during
  // the awaits above, so the document is read, and checked, here.
  const counted = await inTabQueue(tabId, async (): Promise<{ documentId: string } | { error: string }> => {
    let frame: { url: string; documentId?: string } | null = null;
    try {
      frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }) as { url: string; documentId?: string } | null;
    } catch { /* closed */ }
    const documentId = frame?.documentId;
    if (!frame || !documentId) return { error: MANUAL_RUN_TAB_GONE };
    // Turned off, or edited, meanwhile: said as such.
    const changed = await manualScriptRefusal(scriptId);
    if (changed) return { error: changed };
    if (!findMatchesForUrl(frame.url, 'manual').some((m) => m.id === scriptId)) {
      return { error: frame.url === url ? MANUAL_RUN_NOT_HERE : MANUAL_RUN_PAGE_CHANGED };
    }
    const record = await getTabRecord(tabId);
    let state = getDocState(record, documentId);
    if (!state) {
      // The worker lost this document's state (a restart): start one,
      // as a report would (`recordScriptReport`).
      const found = findMatchesForUrl(frame.url);
      const claimFields = await smDevClaimFields(tabId, found);
      const matches = expectedMatches(found, claimFields.smDevRun);
      state = { documentId, url: frame.url, matches, actual: {}, loadMatchIds: matches.map((m) => m.id), ...claimFields };
    }
    state = noteManualRun(state, scriptId);
    noteManualRunDoc(documentId, scriptId);
    const next = writeDocState(record, documentId, state);
    await setTabRecord(tabId, next);
    if (next.currentDocId === documentId) await renderBadge(tabId, state);
    return { documentId };
  });
  if ('error' in counted) return { ok: false, error: counted.error };

  // Outside the queue: the run's own work (an alert() it opens, say)
  // mustn't hold up the tab's other bookkeeping. Aimed at the document
  // checked above, so Chrome refuses rather than run it on another page.
  try {
    // Under the document's own key, not the install's: see `documentKey`.
    const key = await documentKey(counted.documentId, scriptId);
    const rekeyed = injections.map((i) => ({ ...i, js: i.js.map((j) => ({ code: rekey(j.code, key) })) }));
    await executeManualRun(tabId, counted.documentId, rekeyed);
    return { ok: true };
  } catch (err) {
    // The page replaced since it was counted: an expected race, not
    // this page's error. Told apart by asking, not by Chrome's wording.
    let current: string | undefined;
    try {
      current = (await chrome.webNavigation.getFrame({ tabId, frameId: 0 }) as { documentId?: string } | null)?.documentId;
    } catch { /* closed */ }
    if (current !== counted.documentId) return { ok: false, error: MANUAL_RUN_PAGE_CHANGED };
    const error = `Chrome could not run this script on this page: ${describeError(err)}`;
    console.info(`[SourceMonkey] manual run of ${getScriptLogLabel(scriptId)} on tab ${tabId} failed: ${describeError(err)}`);
    logScriptEvent(scriptId, { level: 'error', source: 'manual-run', tabId, message: error });
    await inTabQueue(tabId, async () => {
      const record = await getTabRecord(tabId);
      const state = getDocState(record, counted.documentId);
      if (!state) return;
      const next = applyScriptReport(state, scriptId, { state: 'error', name, message: error }, true);
      const nextRecord = writeDocState(record, counted.documentId, next);
      await setTabRecord(tabId, nextRecord);
      if (nextRecord.currentDocId === counted.documentId) await renderBadge(tabId, next);
    });
    return { ok: false, error, logged: true };
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
// We track the main frame (frameId === 0). A sub-frame's commit only
// ends the runs of the document it replaced (docs/frames.md).
function installNavigationListeners(): void {
  // `@grant window.onurlchange` feeds off the same-document navigation
  // events too, but needs `onReferenceFragmentUpdated` as well and
  // targets the exact frame that changed rather than filtering to the
  // main one — so it owns its own subscriptions rather than sharing
  // the tab-status listener below. Called before the no-webNavigation
  // early return so it reports its own unavailability. See
  // src/extension/gm-url-change.ts.
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
  // A tab a claimed tab opens gets its claim (sm-dev-link.ts). This
  // comes before the new tab's first commit.
  wn.onCreatedNavigationTarget.addListener((d) => {
    void (async () => {
      await inheritClaim(d.sourceTabId, d.tabId);
      if (activeClaim(d.tabId)) emitSmDevEvent({ kind: 'tab-opened', sourceTabId: d.sourceTabId, tabId: d.tabId, url: d.url });
    })();
  });
  wn.onCommitted.addListener((d) => {
    if (d.frameId !== 0) {
      // A frame's new document ends the runs (and menu commands) of
      // the one it replaced. See docs/frames.md.
      if (d.frameId > 0) enqueueTabWork(d.tabId, () => pruneGoneFramesAndRepaint(d.tabId));
      return;
    }
    // Another page: its documents register afresh as they start.
    clearOpenerDocsForTab(d.tabId);
    // ONE batch for this commit, shared by both fan-outs it starts. The
    // reload fast path and the opportunistic sweep check the same
    // script set from the same navigation, so a batch each would read
    // the collection row twice — better than once per script, but not
    // the intent. Created here, referenced only by these two calls, so
    // it dies with the navigation. 'known': a page load's checks read
    // the files they already know rather than listing folders. See
    // `RefreshBatch`.
    const batch = createRefreshBatch('known');
    // Reload fast-path: when the user explicitly reloads (Ctrl-R, toolbar
    // reload, location.reload) Chrome sets
    // transitionType to "reload". We use that to opportunistically check
    // for updated userscripts in time for THIS navigation's injection,
    // rather than waiting for the next reload. Setup is fire-and-forget
    // so the listener stays cheap; the wrapper's sm:check-pending
    // round-trip is what actually waits on the result.
    // Settled before anything async: a document-start wrapper's
    // check-pending can arrive before the queued tab work runs. No
    // fast path for a skip reload — nothing is going to run the
    // refreshed body, and the ordinary sync still picks it up.
    const skipping = noteCommitForSkipScripts(d.tabId, d.documentId ?? '', d.transitionType);
    if (d.transitionType === 'reload' && d.documentId && !skipping) {
      setupReloadFastPath(d.tabId, d.documentId, d.url, batch);
    }
    enqueueTabWork(
      d.tabId,
      () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation', batch, !!d.documentId),
    );
  });
  wn.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    enqueueTabWork(d.tabId, () => updateTabMatches(d.tabId, d.url, d.documentId ?? null, 'navigation'));
  });
  // A grace period after the load, since a document-idle script may
  // start only at the load and then waits on its check-pending reply,
  // for up to the wrapper's decision timeout. Past that, it has either
  // run, been told to skip, or reported no decision (which the badge
  // and Log show as such, not as never started).
  wn.onCompleted.addListener((d) => {
    if (d.frameId !== 0 || !d.documentId) return;
    const documentId = d.documentId;
    setTimeout(() => {
      enqueueTabWork(d.tabId, () => logMissingScripts(d.tabId, documentId));
    }, MISSING_SCRIPT_GRACE_MS);
  });
}

// `DECISION_TIMEOUT_MS` in userscript-prelude.js: how long a wrapper
// waits for its check-pending reply before not running.
const WRAPPER_DECISION_TIMEOUT_MS = 10_000;
const MISSING_SCRIPT_GRACE_MS = WRAPPER_DECISION_TIMEOUT_MS + 1000;
// The longest a page counts as settling (`settleBy`), from its commit,
// should its load event, and so the check below, never come.
const SETTLE_CAP_MS = 20_000;

// Once per document: a Log warning for each script that matched it but
// never reported, with what the document's other reports suggest about
// why. The badge already shows these as MISSING; this says it where the
// script's own history is kept. See src/extension/missing-scripts.ts.
async function logMissingScripts(tabId: number, documentId: string): Promise<void> {
  const record = await getTabRecord(tabId);
  const state = getDocState(record, documentId);
  if (!state || state.missingChecked) return;
  for (const script of findMissingScripts(state, await rejectedScriptIds())) {
    console.log(`[SourceMonkey] never started ${getScriptLogLabel(script.id)} tab=${tabId} ${state.url}`);
    logScriptEvent(script.id, {
      level: 'warning',
      source: 'script-wrapper',
      tabId,
      message: describeMissingScript(script, state),
    });
  }
  const { settleBy, ...rest } = state;
  await setTabRecord(tabId, writeDocState(record, documentId, { ...rest, missingChecked: true }));
  // Settled: an open popup may now show the reload banner.
  if (settleBy !== undefined && record?.currentDocId === documentId) notifyPopup(tabId);
}

// A connection prompt closed without an answer is a denial.
chrome.windows.onRemoved.addListener((windowId) => onConnectPromptWindowRemoved(windowId));

chrome.tabs.onRemoved.addListener((tabId) => {
  markedTabs.delete(tabId);
  markCheckedTabs.delete(tabId);
  enqueueTabWork(tabId, () => clearTabState(tabId));
  clearSkipScripts(tabId);
  dropClaim(tabId);
  frameStartupLogsByTab.delete(tabId);
  // GM_registerMenuCommand: the page-side callbacks are gone with the
  // document, so the SW-side mapping is dead weight after close.
  clearMenuCommandsForTab(tabId);
  // GM_* cross-tab broadcast: drop this tab from every scriptId's
  // openers set so future writes don't try to deliver to a closed
  // tab (broadcast() catches the "Receiving end does not exist"
  // rejection but the lookup work is wasted).
  clearTabFromGmOpeners(tabId);
  clearOpenerDocsForTab(tabId);
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
    emitSmDevEvent({ kind: 'tab-closed', scriptId: taken.scriptId, requestId: taken.requestId });
    void chrome.tabs.sendMessage(taken.originatorTabId, {
      type: 'sm:gm-tab-closed',
      smWorld: pushWorld(taken.scriptId), smScript: taken.scriptId,
      requestId: taken.requestId,
    }).catch(() => undefined);
  }
  // Drop the reload flash: there's no badge left to repaint, and its
  // backstop timer would keep the SW alive for nothing.
  dropReloadFlash(tabId);
  // The focus-check guard releases itself in a `finally`, so this is
  // belt-and-braces against a future path that doesn't — cheap, and
  // the map is keyed by ids Chrome reuses.
  focusChecksInFlight.delete(tabId);
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

// ---------- Focus-triggered refresh ----------
//
// See docs/updates.md#focus-triggered-refresh. Bringing a tab to the
// front checks the local scripts running on it for edits, so the
// RELOAD badge is already up — and the new body already registered —
// before the user reaches for the reload key. Without it the first
// thing that notices an edit is the reload itself, which then has to
// win the 500 ms race in the reload fast path or ask for a second one.
//
// Three signals reach `refreshLocalScriptsOnTab`, because no one of
// them covers every way a page comes to the front:
//   - `tabs.onActivated`     — a different tab in this window came to
//                              the front. Doesn't fire when Chrome
//                              itself regains focus.
//   - `windows.onFocusChanged` — focus moved to a different Chrome
//                              window. Doesn't fire for a tab switch.
//   - `sm:focus` from the page (`installFocusSignal` in
//                              `userscript-prelude.js`, handled in
//                              `installScriptMessageListener`) — the
//                              document's own focus / visibilitychange.
// The page reports because the workflow this feature exists for —
// edit in an editor, alt-tab back to the browser — raises NEITHER
// chrome event on some platforms. Measured on Linux/X11: coming back
// from another application produced no chrome.* event at all. Whether
// it does is platform- and window-manager-dependent, so the page is
// the only signal that behaves the same everywhere.
//
// More than one can describe a single gesture; see the guard below.

// Local scripts only. An http(s) collection would mean a conditional
// GET to a third party on every alt-tab, for a script the user is
// unlikely to be editing; local reads are cheap and are the case this
// is for.
//
// Rate limiting is `updateScript`'s own `UPDATE_MIN_INTERVAL_MS` gate,
// which already skips a check for a script looked at inside the last
// 10s, and coalesces onto any check already in flight. The only thing
// kept here is a per-tab guard against signals that OVERLAP: without
// it each would pay for the same `storage.session` read. It is held
// only across the reads below, so two signals a few ms apart both get
// through — the updater's gate is what collapses their work, not this.
// A guard rather than a time debounce on purpose — a time window would
// also swallow a genuine second switch, and the interval that *should*
// decide whether to re-check lives in the updater, not here.
const focusChecksInFlight = new Set<number>();

function installFocusRefresh(): void {
  chrome.tabs.onActivated.addListener((info) => {
    dlog(`[SourceMonkey] tab ${info.tabId} activated`);
    void refreshLocalScriptsOnTab(info.tabId);
  });
  if (chrome.windows && chrome.windows.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      // Logged before the WINDOW_ID_NONE filter, and naming the id:
      // whether this event arrives AT ALL when the user comes back
      // from another application is platform- and window-manager-
      // dependent, so "no line here" and "a line we filtered out" are
      // different diagnoses and have to look different.
      dlog(`[SourceMonkey] window focus changed to ${windowId}`);
      // Chrome lost focus entirely — nothing came to the front.
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (tab?.id === undefined) {
          dlog(`[SourceMonkey] window ${windowId} has no active tab to check`);
          return;
        }
        await refreshLocalScriptsOnTab(tab.id);
      } catch (err) {
        // The window went away between the event and the query. Nothing
        // to check, and nothing the user could act on.
        dlog(`[SourceMonkey] could not resolve window ${windowId}: ${describeError(err)}`);
      }
    });
  }
}

// Kick off update checks for the local scripts running on one tab's
// current document.
//
// Fire-and-forget by design: whatever a check finds lands through the
// paths that already exist — a changed row re-registers via the
// injector, `installStaleScriptListener` paints the tab's badge purple,
// and an open viewer repaints from its own storage listener.
async function refreshLocalScriptsOnTab(tabId: number): Promise<void> {
  if (focusChecksInFlight.has(tabId)) return;
  focusChecksInFlight.add(tabId);
  try {
    // The cache is what tells local rows from remote ones, and on a cold
    // worker the focus event can land before the initial load — without
    // this every id would filter out and the check would silently skip.
    await ensureLoaded();
    // Before the session read, not after: every tab switch and window
    // focus change reaches this, and a profile with no local scripts
    // at all — every http collection — would otherwise pay for a
    // `storage.session` read per switch to learn the same nothing.
    if (!hasLocalScripts()) {
      dlog(`[SourceMonkey] focus check on tab ${tabId}: no local scripts installed`);
      return;
    }
    const record = await getTabRecord(tabId);
    // The current document only. An older document in the same tab is
    // no longer on screen, and the scripts we care about are the ones
    // whose code the user is looking at.
    const current = record?.byDoc[record.currentDocId];
    if (!current) {
      // Logged, because it is otherwise indistinguishable from the
      // signal never arriving — the confusion this logging exists to
      // prevent. A tab we hold no state for: never navigated to an
      // injectable URL, or its record aged out.
      dlog(`[SourceMonkey] focus check on tab ${tabId}: no state for its current document`);
      return;
    }
    const ids = localScriptIds(current.matches.map((m) => m.id));
    if (ids.length === 0) {
      dlog(`[SourceMonkey] focus check on tab ${tabId}: no local scripts on this page`);
      return;
    }
    dlog(`[SourceMonkey] focus check on tab ${tabId}: ${ids.length} local script(s)`);
    requestOpportunisticScriptChecks(ids);
  } finally {
    focusChecksInFlight.delete(tabId);
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
    const relevant = scriptIds.filter((id) => runsHere(current, id));
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
//        - {action: 'skip', reason}    — don't run. Today only the
//                                        "Reload page with no
//                                        userscripts" marker produces
//                                        it (checked ahead of the fast
//                                        path); held for future "file
//                                        removed" semantics too.
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
  // True when the script has a `.tld` rule: the wrapper read it loosely
  // and wants the exact reading, which needs the public suffix list
  // only this side has (see `.tld` hosts in url-match.ts).
  tld?: boolean;
  // Set by wrapper-bridge.js (USER_SCRIPT world) on every message it
  // relays for a MAIN-world wrapper's request event. A hostile page can
  // dispatch a forged sm:check-pending into the bridge, so a request
  // carrying this flag is potentially page-forged. The page
  // cannot call chrome.runtime.sendMessage itself, so the only way it
  // reaches us is through the bridge — meaning a request WITHOUT this
  // flag came over a USER_SCRIPT-world script's own direct channel and
  // is trustworthy. Flagged requests go through `bridgeMayActAs` before
  // we hand back a `gmValues` snapshot (the read-leak fix).
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
//
// `needsRuntime` says the swapped body grants some runtime-backed API,
// so it can only run where the GM runtime exists. The shared
// runtime is registered only where some active script grants one, so a
// refresh that adds the first such grant on a page produces a body
// with nothing to dereference until the next reload registers it. The
// wrapper checks at the moment the body is about to run — not here,
// and not at its own start: the runtime is a separate document_start
// registration that may sit after the wrapper in Chrome's order (an
// updated registration moves to the end), and by run time every
// document_start registration has executed.
type CheckPendingReply = (
  | { action: 'run'; gmValues?: Record<string, unknown> }
  | {
      action: 'run-new';
      body: string;
      loadedAt: number;
      seedValues?: boolean;
      needsRuntime?: boolean;
      gmValues?: Record<string, unknown>;
    }
  | { action: 'skip'; reason: string; detail?: string }
) & {
  // To a copy in one of the page's iframes: print the script's header
  // warnings, which no other copy on the page will (docs/frames.md).
  startupLogs?: true;
};

async function handleCheckPending(
  sender: chrome.runtime.MessageSender,
  payload: CheckPendingPayload,
): Promise<CheckPendingReply> {
  // Outside a tab (a document Chrome gives no tab), the same checks
  // run, less the tab's own: no claim, reload skip or reload swap can
  // apply there. Every other check still does.
  const tabId = sender.tab?.id;
  // A tab an sm-dev run controls runs only the scripts its claim
  // allows (sm-dev-link.ts). First, and for every frame, like the skip
  // reload below. Waits for the claims to load, so a worker that just
  // started can't let a script through.
  await claimsReady();
  const claim = tabId == null ? undefined : activeClaim(tabId);
  // - Only for the extension's own scripts: an id it doesn't know
  //   (a page's forgery over the bridge) runs nothing either way.
  // - A scratch script is sm-dev's: it runs only in the tabs of the run
  //   that pushed it. Nowhere else, a run's tabs or not.
  const script = await getScriptMeta(payload.id);
  const scriptRun = script ? scratchRunOf(script.fileUrl) : null;
  if (script && (claim ? !claimAllows(claim, scriptRun) : scriptRun !== null)) {
    return { action: 'skip', reason: SKIP_REASON_SM_DEV };
  }
  // "Reload page with no userscripts", and the per-script reloads —
  // decided per tab, ahead of the fast path, and for every frame: a
  // subframe's documentId is its own, so the tab-level marker is the
  // only thing that covers it.
  const skip = tabId == null ? undefined : skipScriptsDocByTab.get(tabId);
  const skipReason = skip ? skipReasonFor(skip.mode, payload.id) : null;
  if (skipReason) return { action: 'skip', reason: skipReason };
  // The frame's own URL (sender.url), not the one in the payload.
  if (payload.tld === true) {
    const script = await getScriptMeta(payload.id);
    const url = sender.url ?? payload.url ?? '';
    if (!script || !urlMatchesScript(url, script.matching)) {
      return { action: 'skip', reason: SKIP_REASON_NO_MATCH };
    }
  }
  const documentId = (sender as { documentId?: string }).documentId ?? '';
  if (!documentId || tabId == null) return { action: 'run' };
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
  // wrong one — a body that expects page context silently can't see
  // the page's globals from the isolated world, and one that expects
  // isolation gets a `window` the page can reach. The shared
  // GM runtime is registered per world too, so the new body's
  // GM_* calls may also land in a world that doesn't have it.
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
  if (wrapperWorld !== resolveScriptWorld(refreshed)) {
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
    // Same log label the registration path uses, so the
    // swapped body's source map names the same devtools files.
    // Awaited, not assumed: `getScriptLogLabel` falls back to a UUID
    // prefix before the id table has loaded, and a cold SW is woken BY
    // this very navigation — so an un-awaited read would stash the
    // swapped sources under a stray `SourceMonkey/<uuid8>/` folder.
    // The table is loaded once and memoised, so this resolves
    // immediately on every call but the first.
    await scriptLogLabel(refreshed.id),
  );
  // Storage-granting bodies need the runtime's `storage.init` to have run
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
  // The bridge gate is the same read-leak guard the message handler
  // applies: a swap reply carrying `gmValues` is a value read like any
  // other, and a bridge-relayed request may be a page forging another
  // script's id. It DOES fire in practice now — `@grant unsafeWindow`
  // puts a storage-granting script in MAIN world, whose only route in
  // is the bridge — so it asks `bridgeMayActAs` rather than refusing
  // outright. The guard belongs where the values are handed out, not
  // two screens up in a check that exists for another reason.
  // Only asked when a value read is actually in play: this handler is
  // on the document-start critical path of every MAIN-world script,
  // and the message handler asks the same question for its own
  // attachment.
  const bridgeValuesOk = payload.__viaBridge !== true
    || (!swap.needsValues && payload.needsValues !== true)
    || await bridgeMayActAs(payload.id, sender, STORAGE_SUBSYSTEMS);
  const handlerWillAttach = payload.needsValues === true && bridgeValuesOk;
  let gmValues: Record<string, unknown> | undefined;
  if (swap.needsValues && !handlerWillAttach && bridgeValuesOk) {
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
    // The wrapper decides at run time whether its world has the
    // runtime this body needs — see CheckPendingReply.
    ...(needsGmRuntime(refreshed.header) ? { needsRuntime: true } : {}),
    // Only set on the grant-added path; otherwise the message
    // handler's enrichment supplies the same field from its own
    // concurrent read.
    ...(gmValues !== undefined ? { gmValues } : {}),
  };
}

// The script's log label, waiting for the id table if it hasn't loaded
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

// Record a warning `scriptId` logged from this tab on its current
// document. A late one from the document before can land on the new
// one; the next navigation clears it.
async function noteTabWarning(tabId: number, scriptId: string): Promise<void> {
  const record = await getTabRecord(tabId);
  const current = record?.byDoc[record.currentDocId];
  if (!record || !current) return;
  const next = noteScriptWarning(current, scriptId);
  if (next === current) return;
  await setTabRecord(tabId, setCurrentDoc(record, record.currentDocId, next));
  await renderBadge(tabId, next);
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
  // For sm-dev (sm-dev-link.ts), which reports what a run's scripts
  // requested: once as it starts, and again with how it ended. The
  // sending document says which of the tab's frames asked.
  const documentId = (sender as { documentId?: string }).documentId;
  const requestEvent = (event?: GmXhrEvent): void => emitSmDevEvent({
    kind: 'request', scriptId: payload.scriptId, tabId, ...(documentId ? { documentId } : {}), id: payload.id,
    url: payload.request.url, method: (payload.request.method ?? 'GET').toUpperCase(),
    ...(event ? { outcome: event.kind } : {}),
    ...(event?.kind === 'load' ? { status: event.response.status } : {}),
    ...(event?.kind === 'error' ? { error: event.message } : {}),
  });
  requestEvent();
  // @connect URL gating: the script's own rules, the page's own origin,
  // and for any other http(s) host, the user's answer (asked for if
  // need be; see connect-prompt.ts). A refusal ships back as an error
  // event, the same shape as a network failure, so the userscript's
  // onerror catches it.
  const reserved = reserveXhr(payload.id, tabId);
  const method = (payload.request.method ?? 'GET').toUpperCase();
  let check: ConnectCheck | null = null;
  let refusal: string | null;
  // Caught here, not left to throw: the reserved entry must be released
  // on every path that doesn't reach `runXhr`.
  try {
    const policy = await loadConnectPolicy(payload.scriptId, sender, tabId);
    // Not `connectBlockedMessage` for a `reason`: we never got as far as
    // reading the script's rules, so blaming them would be wrong.
    if ('reason' in policy) {
      refusal = gmXhrError(policy.reason);
    } else {
      check = policy.check;
      refusal = await check(payload.request.url, method, reserved);
    }
  } catch (err) {
    refusal = gmXhrError(`Internal error: could not check this script's @connect rules: ${describeError(err)}`);
  }
  // Aborted while it waited on the prompt: the page has settled it.
  if (reserved.aborted) {
    releaseXhr(payload.id);
    requestEvent({ kind: 'abort' });
    return;
  }
  if (refusal !== null || !check) {
    releaseXhr(payload.id);
    const message = refusal ?? gmXhrError('Internal error: no @connect check');
    requestEvent({ kind: 'error', message });
    await sendXhrError(sender, tabId, payload.scriptId, payload.id, message);
    return;
  }
  const allowed = check;
  // Run the fetch and ship its events back to the sender's tab. Other
  // tabs do not get a copy — XHR is per-call, not broadcast. The same
  // policy predicate re-checks the post-redirect URL inside runXhr.
  //
  // Frame-scoped: the response body is the sensitive part of the API,
  // and `chrome.tabs.sendMessage` with no frameId hands it to every
  // frame in the tab, scripts in frames included (docs/frames.md). Only
  // the frame that asked needs it.
  const deliver = (event: GmXhrEvent | GmXhrStreamEvent): Promise<unknown> => chrome.tabs.sendMessage(tabId, {
    type: 'sm:gm-xhr-event',
    smWorld: pushWorld(payload.scriptId), smScript: payload.scriptId,
    id: payload.id,
    event,
  }, senderFrameOptions(sender));
  // A stream event that can't be delivered (the tab or its page is
  // gone) throws, which ends the request: nobody is left to read it.
  const event = await runXhr(
    payload.id,
    payload.request,
    async (streamEvent) => { await deliver(streamEvent); },
    (finalUrl, signal) => allowed(finalUrl, method, signal),
    tabId,
  );
  requestEvent(event);
  try {
    await deliver(event);
  } catch {
    // Sender tab closed or otherwise unreachable. Drop quietly —
    // there's nobody to deliver to.
  }
}

// Ship a synthesized XHR error event back to the originating tab. Used
// for @connect denials, which the userscript's onerror handles just
// like a network failure.
async function sendXhrError(
  sender: chrome.runtime.MessageSender,
  tabId: number,
  scriptId: string,
  id: string,
  message: string,
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'sm:gm-xhr-event',
      smWorld: pushWorld(scriptId), smScript: scriptId,
      id,
      event: { kind: 'error', message },
    }, senderFrameOptions(sender));
  } catch { /* tab gone */ }
}

// Address a reply at the exact document that sent the request, when
// Chrome told us which one that was. The documentId matters: a frame
// that has navigated since is another page, and a reply addressed by
// frameId alone would reach it. Addressed by document, the send fails
// instead, which ends a streaming request nobody is left to read.
// Older senders (no ids) fall back to the tab-wide send rather than
// dropping the message.
function senderFrameOptions(
  sender: chrome.runtime.MessageSender,
): { frameId?: number; documentId?: string } {
  return {
    ...(typeof sender.frameId === 'number' ? { frameId: sender.frameId } : {}),
    ...(typeof sender.documentId === 'string' ? { documentId: sender.documentId } : {}),
  };
}

// Whether a request may go: null, or the error message the script gets.
// `signal` ends a wait on the connection prompt.
type ConnectCheck = (url: string, method: string, signal?: AbortSignal) => Promise<string | null>;

// Load a script's `@connect` policy once and return a reusable check.
// The check is run against both the initial URL and (inside runXhr) the
// post-redirect URL, so a single header read covers every hop. It
// resolves to null when the request may go, else the error message the
// script gets. Returns `{reason}` when the policy can't be resolved
// (script gone, no header, parse error), which is a hard deny.
async function loadConnectPolicy(
  scriptId: string,
  sender: chrome.runtime.MessageSender,
  tabId: number,
): Promise<{ reason: string } | { check: ConnectCheck }> {
  try {
    const script = await getScriptMeta(scriptId);
    // Two different failures, and only the second is ours. A script
    // removed while a page it was running on is still open is a real
    // race the user can act on, so it says what happened and how to
    // recover rather than hiding behind `Internal error:`.
    if (!script) {
      return { reason: 'This script is no longer installed. Reload the page.' };
    }
    if (!script.header) {
      return { reason: 'Internal error: this script\'s header is not available, so @connect could not be checked' };
    }
    const header = script.header;
    const rules = parseConnectRules(header);
    const selfHosts = extractSelfHosts(header);
    // `origin` over `url`: an about:blank or srcdoc frame has the
    // origin of the page that made it, but no URL of its own.
    const pageOrigin = sender.origin ?? originOf(sender.url);
    const check: ConnectCheck = async (url, method, signal) => {
      const decision = decideConnect(url, rules, selfHosts, pageOrigin);
      switch (decision.verdict) {
        case 'allow':
          return null;
        case 'invalid':
          return gmXhrError(decision.reason);
        case 'deny':
          return connectBlockedMessage(decision.reason);
        case 'ask': {
          const outcome = await askConnect({
            scriptId,
            scriptName: getValue(header, 'name') ?? script.relativePath,
            host: decision.host,
            url,
            method,
            tabId,
            ...(sender.documentId ? { documentId: sender.documentId } : {}),
            ...(signal ? { signal } : {}),
          });
          if (outcome === 'allow') return null;
          if (outcome === 'deny') return connectDeniedMessage(decision.host);
          if (outcome === 'cancelled') return connectCancelledMessage(decision.host);
          if (outcome === 'unanswered') return connectUnansweredMessage(decision.host, CONNECT_PROMPT_WAIT_MS);
          // The caller sees the abort for itself and says nothing.
          if (outcome === 'aborted') return gmXhrError('The request was aborted');
          if (outcome === 'too-many') return connectTooManyPromptsMessage(decision.host, MAX_PROMPTS_PER_SCRIPT);
          return connectPromptFailedMessage(decision.host, outcome.failed);
        }
      }
    };
    return { check };
  } catch (err) {
    return {
      reason: `Internal error: could not check this script's @connect rules: ${
        err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
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

// A `window.close` request from a frame (docs/frames.md).
const FRAME_CLOSE_REFUSED = 'A script in a frame cannot close the tab';

// ---------- GM_openInTab dispatch ----------

async function handleTabOpen(
  sender: chrome.runtime.MessageSender,
  payload: GmTabOpenPayload,
): Promise<{ ok: boolean; tabId?: number; error?: string }> {
  const originatorTabId = sender.tab?.id;
  if (originatorTabId == null) {
    return { ok: false, error: NO_ORIGINATOR_TAB };
  }
  // From a tab an sm-dev run controls, the new tab is the run's too.
  await claimsReady();
  const claimed = activeClaim(originatorTabId) !== null;
  const result = await openGmTab(payload, originatorTabId, claimed ? (tabId) => inheritClaim(originatorTabId, tabId) : undefined);
  // Once its URL is loading, so the run can tell its page by that.
  if (claimed && result.ok && result.tabId != null) {
    emitSmDevEvent({
      kind: 'tab-opened', sourceTabId: originatorTabId, tabId: result.tabId, url: payload.url,
      scriptId: payload.scriptId, requestId: payload.requestId, active: payload.active,
    });
  }
  return result;
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
  const result = await showGmNotification(payload, originatorTabId);
  if (result.ok) {
    // Which of the tab's frames showed it, for sm-dev.
    const documentId = (sender as { documentId?: string }).documentId;
    emitSmDevEvent({
      kind: 'notification', op: 'shown', scriptId: payload.scriptId, tabId: originatorTabId, requestId: payload.requestId,
      ...(documentId ? { documentId } : {}),
      notificationId: result.notificationId, text: payload.details.text, title: payload.details.title,
    });
  }
  return result;
}

// A shown notification was clicked or closed: the script's `onclick`
// or `ondone` hears it, and so does sm-dev.
function deliverNotificationEvent(chromeId: string, event: 'clicked' | 'closed'): boolean {
  const taken = event === 'clicked' ? takeNotificationForClicked(chromeId) : takeNotificationForClosed(chromeId);
  if (!taken) return false;
  emitSmDevEvent({ kind: 'notification', op: event, scriptId: taken.scriptId, tabId: taken.originatorTabId, requestId: taken.requestId });
  void chrome.tabs.sendMessage(taken.originatorTabId, {
    type: 'sm:gm-notification-event',
    smWorld: pushWorld(taken.scriptId), smScript: taken.scriptId,
    requestId: taken.requestId,
    event,
  }).catch(() => undefined);
  return true;
}

function installNotificationListeners(): void {
  if (!chrome.notifications) {
    console.info('[SourceMonkey] chrome.notifications not available; GM_notification will throw if called');
    return;
  }
  chrome.notifications.onClicked.addListener((chromeId) => {
    deliverNotificationEvent(chromeId, 'clicked');
  });
  chrome.notifications.onClosed.addListener((chromeId) => {
    deliverNotificationEvent(chromeId, 'closed');
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
  const scriptId = msg.scriptId;
  // A bridge-relayed request goes through the same gate as every other
  // script-scoped one: only a script running in MAIN world on the
  // sending page may be acted for. The blast radius is bounded to that
  // page's own tab, and in MAIN world the override lives on the page's
  // own `window` — so the page could make this call through the script
  // regardless. See `bridgeMayActAs` and wrapper-bridge.js.
  if (viaBridge(msg) && !(await bridgeMayActAs(scriptId, sender, ['window-control']))) {
    return { ok: false, error: BRIDGE_DENIED };
  }
  const tabId = sender.tab?.id;
  if (tabId == null) {
    return { ok: false, error: NO_ORIGINATOR_TAB };
  }
  // A frame's runtime leaves `window.close` alone (as TM does), so a
  // close from one is forged: it would close the tab, which the frame's
  // own `close()` never does.
  if (which === 'close' && (await frameInfo(sender)).subframe) {
    return { ok: false, error: FRAME_CLOSE_REFUSED };
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
      message: `window.${which}: ${result.error}`,
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
      message: `GM_download ${reason} (${url})`,
    });
  }
  void chrome.tabs.sendMessage(tabId, {
    type: 'sm:gm-download-event',
    smWorld: pushWorld(scriptId), smScript: scriptId,
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
  // For sm-dev, as for requests: once as it starts, and again with how
  // it ended.
  const documentId = (sender as { documentId?: string }).documentId;
  const downloadEvent = (event?: GmDownloadEvent): void => emitSmDevEvent({
    kind: 'download', scriptId: payload.scriptId, tabId, ...(documentId ? { documentId } : {}), requestId: payload.requestId, url: payload.url, name: payload.name,
    ...(event ? { outcome: event.kind } : {}),
    ...(event?.kind === 'load' ? { filename: event.filename } : {}),
    ...(event?.kind === 'error' ? { error: event.details.message ?? event.error } : {}),
  });
  downloadEvent();
  const emit = (event: GmDownloadEvent): void => {
    if (event.kind !== 'progress') downloadEvent(event);
    sendDownloadEvent(tabId, payload.scriptId, payload.requestId, payload.url, event);
  };
  const result = await startGmDownload(payload, tabId, emit);
  if (result.ok) return;
  // A download that never started still owes the script a terminal
  // event. `download_canceled` here means the page aborted before the
  // download manager had an id — the page already settled its own
  // callbacks, so there's nothing to deliver. sm-dev still hears how
  // it ended.
  if (result.error === 'download_canceled') {
    emitSmDevEvent({ kind: 'download', scriptId: payload.scriptId, tabId, ...(documentId ? { documentId } : {}), requestId: payload.requestId, url: payload.url, name: payload.name, outcome: 'abort' });
    return;
  }
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
// to every frame in a tab; the writer's own tab is sent to frame by
// frame (`broadcastValueUpdate`).
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

// `documentId`: the document running it, for the writer's own tab
// (`openerDocs`).
function registerOpener(scriptId: string, tabId: number, documentId?: string): void {
  if (addOpenerToMap(scriptId, tabId)) persistGmOpeners();
  if (!documentId) return;
  let tabs = openerDocs.get(scriptId);
  if (!tabs) openerDocs.set(scriptId, tabs = new Map());
  let docs = tabs.get(tabId);
  if (!docs) tabs.set(tabId, docs = new Set());
  docs.add(documentId);
}

// Per script and tab, the documents running it: the page's and its
// frames'. A write reaches the writer's tab only through these, as one
// tab-wide send would reach the writer too. In memory only, and
// dropped per tab when its top frame loads another page: after a worker
// restart, a document is added again when it next writes or resyncs,
// and until then a sibling frame may miss an update (as a lost
// broadcast would, which the resync recovers). See docs/frames.md.
const openerDocs = new Map<string, Map<number, Set<string>>>();

function clearOpenerDocsForTab(tabId: number): void {
  for (const tabs of openerDocs.values()) tabs.delete(tabId);
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
  // Broadcast the delta to every OTHER document running this script:
  // other tabs, and the writer's tab's other frames. The writing
  // document already has the writes applied in its page-side cache (it
  // issued the writes); broadcasting back would be redundant and could
  // feed back through value-change listeners.
  const senderTabId = sender.tab?.id;
  const writerDocument = (sender as { documentId?: string }).documentId;
  // The writer runs the script, so its document is one an update from
  // another frame of its tab should reach (`openerDocs`).
  if (senderTabId != null) registerOpener(payload.scriptId, senderTabId, writerDocument);
  emitSmDevEvent({ kind: 'values', scriptId: payload.scriptId, tabId: senderTabId, ...(writerDocument ? { documentId: writerDocument } : {}), writes: payload.writes });
  await broadcastValueUpdate(payload.scriptId, payload.writes, senderTabId, writerDocument);
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
  excludeDocId?: string,
): Promise<void> {
  if (__debugSuppressGmBroadcast) return;
  await hydrateGmOpeners();
  const targets = gmOpeners.get(scriptId);
  const message = { type: 'sm:gm-value-update', smWorld: pushWorld(scriptId), smScript: scriptId, scriptId, writes };
  let sent = 0;
  // The writer's own tab: the other documents of it running the script
  // (its page and frames), each addressed by document, so one that
  // navigated meanwhile isn't sent the old page's update. Nothing when
  // the writer is the only one, the usual case.
  if (excludeTabId !== undefined && excludeDocId) {
    for (const documentId of openerDocs.get(scriptId)?.get(excludeTabId) ?? []) {
      if (documentId === excludeDocId) continue;
      void chrome.tabs.sendMessage(excludeTabId, message, { documentId }).catch(() => undefined);
    }
  }
  // Fire-and-forget per tab. chrome.tabs.sendMessage delivers to
  // every frame on the tab and each frame's runtime listener
  // dispatches by scriptId locally. "Receiving end does not exist"
  // rejections are normal (tab closed mid-send, frame torn down)
  // and silently dropped.
  if (targets) {
    for (const tabId of targets) {
      if (tabId === excludeTabId) continue;
      sent++;
      void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
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
    ? ': no tabs registered for this script'
    : ': the only registered tab is the one that wrote';
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
): Promise<{ ok: boolean; values?: Record<string, unknown>; error?: string }> {
  // A bridge-relayed request hands back a whole value map, and a
  // MAIN-world page can forge the scriptId on anything it gets the
  // bridge to forward — so it goes through the same gate every other
  // script-scoped bridge call does. `bridgeMayActAs` allows only a
  // script running in MAIN world on the sending page, whose values are
  // reachable from that page's own realm anyway. See wrapper-bridge.js.
  const scriptId = payload.scriptId;
  if (typeof scriptId !== 'string' || !scriptId) return { ok: false };
  if (viaBridge(payload) && !(await bridgeMayActAs(scriptId, sender, STORAGE_SUBSYSTEMS))) return { ok: false, error: BRIDGE_DENIED };
  const tabId = sender.tab?.id;
  if (tabId != null) registerOpener(scriptId, tabId, (sender as { documentId?: string }).documentId);
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

// ---------- bridge gate ----------
//
// `wrapper-bridge.js` stamps `__viaBridge: true` on everything it
// relays for a MAIN-world wrapper. MAIN world shares its realm with the
// page. The channel key keeps the page off the bridge (channel.ts), and
// this gate is the backstop should the key leak: a page that hooks the
// built-ins our MAIN-world code uses could see some traffic, and a
// manual run's document key is exposed by design (`documentKey`).
//
// The gate: a bridge-relayed, script-scoped request is honored only
// when that script actually runs in MAIN world on the sending frame's
// URL, the scripts whose realm the page shares. It refuses:
//
//   - every USER_SCRIPT-world script (isolated; page can't touch it),
//   - every MAIN-world script that doesn't match this page (a script
//     scoped to bank.example can't be driven from evil.example), and
//   - every API the script didn't grant. "Page-reachable anyway" only
//     holds for the bindings the script has; a `@grant none` script
//     with `@match *://*/*` has none, and must not become a handle the
//     page can open tabs, show notifications, or start downloads with.
//     `subsystems` names what the request exercises (in catalog terms);
//     any one of them granted is enough.
//
// Direct (non-bridge) requests skip the gate entirely — they can only
// come from USER_SCRIPT world, which the page cannot reach.
//
// Fails CLOSED: an unknown id, an unmatched URL, or a missing sender
// URL all deny.
async function bridgeMayActAs(
  scriptId: unknown,
  sender: chrome.runtime.MessageSender,
  subsystems: readonly ApiSubsystem[],
): Promise<boolean> {
  if (typeof scriptId !== 'string' || scriptId === '') return false;
  // `sender.url` is the URL of the frame that sent the message — the
  // page the bridge is running on, not the tab's top-level URL.
  const url = sender.url ?? sender.tab?.url;
  if (!url) return false;
  await ensureLoaded();
  // URL-based, so this answers "could this script run here?" rather
  // than "did it?".
  const match = findMatchesForUrl(url, 'any').find((m) => m.id === scriptId && m.world === 'MAIN');
  if (!match) return false;
  // Nor in a frame, for a script kept to the top frame.
  if (match.noframes && (await frameInfo(sender)).subframe) return false;
  // A manual script runs in a document only when asked, so the page
  // has its powers only where it was run.
  if (match.manual && !await manualRanIn(sender, scriptId)) return false;
  return scriptGrantsSubsystem(scriptId, subsystems);
}

// The Log line for a style the page's CSP refused. The runtime prints
// the same wording to the page console (`reportBlockedStyle`).
function cspBlockedStyleMessage(api: 'GM_addStyle' | 'GM_addElement'): string {
  return `The page's Content Security Policy blocked the style ${api} added, so its rules don't apply. ` +
    'SourceMonkey can\'t exempt a style added inside a closed shadow root or another frame\'s document. ' +
    'Add @inject-into content to run the script isolated from the page, where all its styles are exempt.';
}

// Which world an SW->page push is addressed to. Every `chrome.tabs
// .sendMessage` we aim at a userscript carries this as `smWorld`, and
// the script's id as `smScript` (a manual run's bridge relays only its
// own script's; see `documentKey` in channel.ts).
//
// It exists for `wrapper-bridge.js`, which re-sends pushes into MAIN
// world so the MAIN copy of the GM runtime can hear them. That relay
// puts the payload in the page's world, so it must fire only for
// pushes addressed to a MAIN-world script — a page could otherwise read
// an isolated script's stored values off a `sm:gm-value-update`, or its
// cross-origin response body off a `sm:gm-xhr-event`, just by also
// running any MAIN-world script on the same page.
//
// Unknown ids resolve to USER_SCRIPT so the bridge fails closed.
function pushWorld(scriptId: string): InjectionWorld {
  return scriptWorld(scriptId) ?? 'USER_SCRIPT';
}

function viaBridge(msg: unknown): boolean {
  return (msg as { __viaBridge?: unknown } | null)?.__viaBridge === true;
}

// Run `work` for a fire-and-forget message that may have come through
// the bridge, applying `bridgeMayActAs` first when it did. Keeps the
// common USER_SCRIPT-world path fully synchronous (no extra turn on the
// document-start critical path) while making the bridge path await the
// gate. Mirrors the sync-ack handlers' contract: returns false when the
// reply already went out, true when it will go out later.
//
// No log on the refused branch on purpose: a legitimate script never
// reaches it, and a page can spam forged requests — logging each would
// be a page-triggerable console flood with no diagnostic value.
function guardBridgeCall(
  msg: unknown,
  scriptId: unknown,
  subsystems: readonly ApiSubsystem[],
  sender: chrome.runtime.MessageSender,
  work: () => void,
  sendResponse: (reply: unknown) => void,
): boolean {
  if (!viaBridge(msg)) {
    work();
    try { sendResponse({ ok: true }); } catch { /* receiver gone */ }
    return false;
  }
  bridgeMayActAs(scriptId, sender, subsystems).then(
    (allowed) => {
      // `work` runs inside a promise here, so a throw would otherwise
      // be an unhandled rejection with the channel left open.
      let ok = allowed;
      if (allowed) {
        try { work(); } catch (err) {
          ok = false;
          console.info('[SourceMonkey] bridge call failed:', err);
        }
      }
      try {
        sendResponse(ok ? { ok: true } : { ok: false, error: BRIDGE_DENIED });
      } catch { /* receiver gone */ }
    },
    (err) => {
      // The gate itself failed (a chrome.storage read rejected). We
      // returned true, so the channel stays open until we answer —
      // answer, and don't run the work.
      console.info('[SourceMonkey] bridge gate threw:', err);
      try { sendResponse({ ok: false, error: BRIDGE_DENIED }); } catch { /* gone */ }
    },
  );
  return true;
}

// Same gate for the handlers whose reply carries real data (the
// assigned tab id, the notification id), so they can't just ack.
async function guardBridgeAsync<T>(
  msg: unknown,
  scriptId: unknown,
  subsystems: readonly ApiSubsystem[],
  sender: chrome.runtime.MessageSender,
  work: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  if (!viaBridge(msg)) return work();
  if (!(await bridgeMayActAs(scriptId, sender, subsystems))) return { ok: false, error: BRIDGE_DENIED };
  return work();
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

// Per tab, menu registrations and removals in the order they came. A
// frame's has to look up its page first (`frameInfo`), and a removal
// mustn't overtake the registration it removes.
const menuQueues = new Map<number, Promise<void>>();
function inMenuQueue(tabId: number, task: () => Promise<void>): void {
  const next = (menuQueues.get(tabId) ?? Promise.resolve()).then(task).catch((err) => {
    console.info('[SourceMonkey] menu command bookkeeping failed:', err);
  });
  menuQueues.set(tabId, next);
  void next.finally(() => { if (menuQueues.get(tabId) === next) menuQueues.delete(tabId); });
}

// Per tab, the page (top document) and the scripts whose header
// warnings a frame of it has printed to the page console.
const frameStartupLogsByTab = new Map<number, { topDocId: string; ids: Set<string> }>();

// Whether a copy of `scriptId` in one of the tab's frames prints the
// script's header warnings (its `startupLogs`): once per page, as all
// the page's frames share one DevTools console. Not when the script
// matches the page itself, whose copy prints them; then only the first
// frame's copy. Matched against the page's URL rather than the tab's
// state, which may not have recorded this page's commit yet. A page
// moved by pushState can make that answer wrong, a rare extra or
// missing print. See docs/frames.md.
async function frameShowsStartupLogs(
  tabId: number,
  scriptId: string,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  const where = await frameInfo(sender);
  if (!where.subframe) return false;
  let shown = frameStartupLogsByTab.get(tabId);
  if (!shown || shown.topDocId !== where.topDocId) {
    shown = { topDocId: where.topDocId, ids: new Set() };
    frameStartupLogsByTab.set(tabId, shown);
  }
  if (shown.ids.has(scriptId)) return false;
  shown.ids.add(scriptId);
  if (!where.topUrl) return true;
  await ensureLoaded();
  return !findMatchesForUrl(where.topUrl).some((m) => m.id === scriptId);
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
    const type = (msg as { type?: unknown }).type;
    // Answered even with no tab: unanswered, the wrapper doesn't run
    // (`handleCheckPending` decides what a tab-less one may do).
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
      // A DIRECT request (no `__viaBridge`) can only have come from
      // USER_SCRIPT world, which the page cannot reach — attach the
      // snapshot unconditionally. A bridge-relayed one may be a hostile
      // page forging another script's id to read its values back
      // through the reply, so it goes through the gate: values are
      // handed over only for a MAIN-world script that runs on this
      // page. See `bridgeMayActAs`.
      const valueReadAllowed: Promise<boolean> = payload.needsValues
        ? (payload.__viaBridge === true
            ? bridgeMayActAs(payload.id, sender, STORAGE_SUBSYSTEMS)
            : Promise.resolve(true))
        : Promise.resolve(false);
      // A snapshot that can't be read is no snapshot: the decision still
      // stands, and a storage script that would run aborts on its own,
      // saying so (the prelude's hard abort), rather than this turning
      // into a missing decision.
      const snapshotP: Promise<Record<string, unknown> | undefined> =
        valueReadAllowed.then((ok) => (ok ? loadSnapshotForCheckPending(payload.id) : undefined)).catch((err) => {
          console.info('[SourceMonkey] check-pending storage snapshot failed:', err);
          return undefined;
        });
      Promise.all([decisionP, snapshotP]).then(
        async ([reply, gmValues]) => {
          // A frame's copy prints the script's header warnings only when
          // nothing else on the page does (`frameShowsStartupLogs`), and
          // not where it doesn't run at all (`no-match`).
          const noMatch = reply.action === 'skip' && reply.reason === SKIP_REASON_NO_MATCH;
          const startupLogs = sender.frameId !== 0 && tabId != null && !noMatch
            && await frameShowsStartupLogs(tabId, payload.id, sender).catch(() => false);
          const enriched: CheckPendingReply = {
            ...(gmValues !== undefined && reply.action !== 'skip' ? { ...reply, gmValues } : reply),
            ...(startupLogs ? { startupLogs: true as const } : {}),
          };
          try { sendResponse(enriched); } catch { /* gone */ }
        },
        (err) => {
          // Not run: the decision is what keeps it out of an sm-dev
          // run's tabs and honours a skip; see SKIP_REASON_NO_DECISION.
          console.info('[SourceMonkey] check-pending handler threw:', err);
          const detail = 'Internal error: SourceMonkey failed while deciding whether to run it. The details are in its service worker console';
          try { sendResponse({ action: 'skip', reason: SKIP_REASON_NO_DECISION, detail }); } catch { /* gone */ }
        },
      );
      return true;
    }
    if (tabId == null) return;
    if (type === SM_FOCUS_MSG) {
      // The page saying it just came to the front — the third of the
      // signals `installFocusRefresh` describes, and the only one that
      // survives a return from another application on every platform.
      // Logged like the other two: this is the signal hardest to
      // confirm any other way.
      dlog(`[SourceMonkey] page on tab ${tabId} reported focus`);
      // No reply: the wrapper doesn't wait, and the work is the same
      // fire-and-forget check a focus event triggers.
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      void refreshLocalScriptsOnTab(tabId);
      return false;
    }
    if (type === SM_MAIN_BLOCKED_MSG) {
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      // The bridge's own message, which it never relays for the page.
      if (!viaBridge(msg)) {
        void runBlockedMainScripts(tabId, sender).catch((err) => {
          console.info('[SourceMonkey] sandboxed-page fallback failed:', err);
        });
      }
      return false;
    }
    if (type === 'sm:gm-xhr-start') {
      // GM_xmlhttpRequest dispatch. Ack the start without waiting for
      // the request so the message channel doesn't stay pinned open
      // for its whole lifetime (a long XHR would otherwise hold the
      // port for minutes). The actual load/error/abort event arrives
      // later via chrome.tabs.sendMessage. Fire-and-forget the SW work.
      const xhrPayload = msg as XhrStartPayload;
      return guardBridgeCall(msg, xhrPayload.scriptId, ['xhr'], sender, () => {
        void handleXhrStart(sender, xhrPayload).catch((err) => {
          console.info('[SourceMonkey] gm-xhr-start handler threw:', err);
        });
      }, sendResponse);
    }
    if (type === 'sm:gm-xhr-abort') {
      // Deliberately ungated: the payload names a request id, not a
      // script, and those ids are per-call random strings the SW never
      // publishes. A page would have to guess one to cancel a request,
      // and cancelling a request it can already observe (it shares the
      // realm with the script that made it) gains it nothing.
      // `sm:gm-tab-close` is ungated for the same reason.
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
      const tabPayload = msg as GmTabOpenPayload;
      return respondAsync(
        'gm-tab-open',
        guardBridgeAsync(msg, tabPayload.scriptId, ['tab'], sender, () => handleTabOpen(sender, tabPayload)),
        sendResponse,
      );
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
      // Ack without waiting for the transfer — it can run for minutes
      // and the message channel shouldn't stay pinned open for it.
      // Terminal + progress events arrive later via
      // chrome.tabs.sendMessage, the same shape as GM_xmlhttpRequest.
      // The bridge gate runs before the ack (a page can forge the
      // scriptId on anything it gets the bridge to forward, and the id
      // decides which Log tab a failed download is filed under), so a
      // refusal reaches the caller instead of leaving it waiting for
      // events that never come.
      const dlPayload = msg as GmDownloadStartPayload;
      return guardBridgeCall(msg, dlPayload.scriptId, ['download'], sender, () => {
        void handleDownloadStart(sender, dlPayload).catch((err) => {
          console.info('[SourceMonkey] gm-download-start handler threw:', err);
        });
      }, sendResponse);
    }
    if (type === 'sm:gm-download-abort') {
      const payload = msg as { requestId?: string };
      if (typeof payload.requestId === 'string') void abortGmDownload(payload.requestId);
      try { sendResponse({ ok: true }); } catch { /* gone */ }
      return false;
    }
    if (type === 'sm:gm-notification-show') {
      const notifPayload = msg as GmNotificationShowPayload;
      return respondAsync(
        'gm-notification-show',
        guardBridgeAsync(
          msg, notifPayload.scriptId, ['notification'], sender,
          () => handleNotificationShow(sender, notifPayload),
        ),
        sendResponse,
      );
    }
    if (type === 'sm:gm-batch-write') {
      // Batched storage flush from the page-side cache. The wrapper
      // doesn't actually await the reply today (fire-and-forget), but
      // returning a real {ok} keeps the channel honest for future error
      // surfacing.
      const writePayload = msg as BatchWritePayload;
      return respondAsync(
        'gm-batch-write',
        guardBridgeAsync(
          msg, writePayload.scriptId, STORAGE_SUBSYSTEMS, sender,
          () => handleBatchWrite(writePayload, sender),
        ),
        sendResponse,
      );
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
      // (commandId, name) so the toolbar popup can list it.
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
      return guardBridgeCall(msg, payload.scriptId, ['menu'], sender, () => {
        const { scriptId, commandId, name } = payload;
        if (typeof scriptId !== 'string' || typeof commandId !== 'string' || typeof name !== 'string') return;
        inMenuQueue(tabId, async () => {
          // A frame's commands belong to the page it's in. When that
          // can't be told, the page whose commands the tab holds.
          const where = await frameInfo(sender);
          const topDocId = !where.subframe ? menuDocId : where.topDocId || menuTopDocument(tabId) || menuDocId;
          const changed = registerMenuCommand(tabId, menuDocId, scriptId, commandId, name, topDocId);
          if (!changed) return;
          notifyPopup(tabId);
          emitSmDevEvent({
            kind: 'menu', op: 'add', tabId, documentId: menuDocId, topFrame: !where.subframe,
            scriptId, commandId, name,
          });
        });
      }, sendResponse);
    }
    if (type === 'sm:gm-menu-unregister') {
      const payload = msg as { scriptId?: unknown; commandId?: unknown };
      return guardBridgeCall(msg, payload.scriptId, ['menu'], sender, () => {
        const { scriptId, commandId } = payload;
        if (typeof scriptId !== 'string' || typeof commandId !== 'string') return;
        inMenuQueue(tabId, async () => {
          const changed = unregisterMenuCommand(tabId, menuDocId, scriptId, commandId);
          // Unknown ids (silent no-op contract) don't change visible
          // state, so an open popup isn't told.
          if (!changed) return;
          notifyPopup(tabId);
          emitSmDevEvent({
            kind: 'menu', op: 'remove', tabId, documentId: menuDocId,
            topFrame: !(await frameInfo(sender)).subframe, scriptId, commandId,
          });
        });
      }, sendResponse);
    }
    if (type === SM_GM_DOM_BLOCKED_MSG) {
      // The runtime's once-per-script CSP report (see
      // `reportBlockedStyle` in wrapper-gm-runtime.js). A warning, not
      // an error: the script ran, one of its styles didn't take. Worded
      // here, not on the page: the request can come over the bridge,
      // and a page-authored string in the Log would be a page-authored
      // Log line.
      const payload = msg as { scriptId?: unknown; api?: unknown };
      return guardBridgeCall(msg, payload.scriptId, ['dom'], sender, () => {
        if (typeof payload.scriptId === 'string' && typeof payload.api === 'string') {
          logScriptEvent(payload.scriptId, {
            level: 'warning',
            source: 'gm-dom',
            tabId,
            message: cspBlockedStyleMessage(payload.api === 'GM_addElement' ? 'GM_addElement' : 'GM_addStyle'),
          });
        }
      }, sendResponse);
    }
    if (type === SM_GM_LOG_MSG) {
      // Fan-out from the page-side GM_log helper. Fire-and-forget; the
      // wrapper doesn't await this. We still ack so the message channel
      // doesn't stay pinned open.
      const payload = msg as { scriptId?: unknown; message?: unknown };
      return guardBridgeCall(msg, payload.scriptId, ['log'], sender, () => {
        if (typeof payload.scriptId === 'string' && typeof payload.message === 'string') {
          logScriptEvent(payload.scriptId, {
            level: 'info',
            source: 'gm-log',
            tabId,
            message: payload.message,
          });
        }
      }, sendResponse);
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
      detail?: string;
      opaqueOrigin?: boolean;
      __viaBridge?: boolean;
    };
    enqueueTabWork(tabId, () => recordScriptReport(tabId, sender, type, payload));
  });
}

// Shared by the page relays below: is this message from one of OUR
// extension pages?
//
// Sender check, not decoration: the extension holds `<all_urls>`, so a
// relay that answered anyone would be doing that caller's work with our
// privileges. Userscript worlds are on a different event
// (`onUserScriptMessage`) and could never reach these listeners, but the
// guard is what keeps that true after some future context gains
// `chrome.runtime.sendMessage`.
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const origin = `chrome-extension://${chrome.runtime.id}`;
  return !!sender.url && sender.url.startsWith(`${origin}/`);
}

// Read an http(s) URL on behalf of an extension PAGE, because a page
// that fetches for itself acts on the response's `Link: rel=preload`
// headers and lands an uncatchable CSP refusal in the Errors panel.
// The reasoning, and the reply shape, live in src/http-read.ts.
function installPageFetchListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as { type?: unknown } | null;
    if (!msg || msg.type !== HTTP_READ_MESSAGE) return undefined;
    if (!fromExtensionPage(sender)) return undefined;
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

// Write a per-script Log entry on behalf of an extension PAGE, so the
// worker's per-script queue is the only one touching that key. A guard:
// no page code logs today, but the pages share `script-store` /
// `script-log` with the worker, and a page that logged through them
// would otherwise run its own read-modify-write chain on one
// `log:<id>` row and drop entries. See src/extension/script-log.ts.
//
// Same sender check as the fetch relay, for the same reason.
function installPageLogWriteListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as { type?: unknown } | null;
    if (!msg || msg.type !== SCRIPT_LOG_WRITE_MESSAGE) return undefined;
    if (!fromExtensionPage(sender)) return undefined;
    void handleScriptLogWrite(msg as unknown as ScriptLogWriteRequest).then(
      () => { try { sendResponse(true); } catch { /* page gone */ } },
      (err) => {
        // Anything but `true` tells the page the entry wasn't saved.
        console.info('[SourceMonkey] page log-write handler threw:', describeError(err));
        try { sendResponse(undefined); } catch { /* page gone */ }
      },
    );
    // Keep the message channel open for the async reply.
    return true;
  });
}

// The connection prompt's answer (connect-prompt.ts). Only from the
// prompt page itself: an answer is a grant of network reach, so nothing
// a script can reach (a content script relaying for a page) may send
// one.
function installConnectAnswerListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as (Omit<Partial<ConnectAnswerMessage>, 'type'> & { type?: unknown }) | null;
    if (!msg || (msg.type !== CONNECT_ANSWER_MESSAGE && msg.type !== CONNECT_PROMPT_ALIVE_MESSAGE)) return undefined;
    if (!fromExtensionPage(sender) || !sender.url?.startsWith(chrome.runtime.getURL(CONNECT_PROMPT_PAGE))) return undefined;
    // Receiving it was the point: see CONNECT_PROMPT_ALIVE_MESSAGE.
    if (msg.type === CONNECT_PROMPT_ALIVE_MESSAGE) {
      sendResponse(true);
      return undefined;
    }
    const { scriptId, host, choice } = msg;
    if (typeof scriptId !== 'string' || typeof host !== 'string' || !host
      || !['once', 'cancel', 'allow', 'allow-all', 'deny'].includes(choice as string)) {
      return undefined;
    }
    // A plain host name, as the prompt was opened with: it becomes a
    // storage value and part of a map key.
    let plainHost: string;
    try {
      plainHost = new URL(`https://${host}`).hostname;
    } catch {
      return undefined;
    }
    if (plainHost !== host.toLowerCase()) return undefined;
    void answerConnect(scriptId, plainHost, choice as ConnectChoice, 'prompt').then(
      () => { try { sendResponse(true); } catch { /* page gone */ } },
      (err) => {
        console.info('[SourceMonkey] connection prompt answer failed:', describeError(err));
        try { sendResponse(false); } catch { /* page gone */ }
      },
    );
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

// How a report from one of the page's iframes goes in the Log: one row
// per page for each kind of report (and error message), counting the
// frames' repeats, rather than a row each. A page full of matching ad
// frames would otherwise fill a script's Log in a few loads. The row
// says it's from an iframe, which one last, and on which page, which
// the frame's URL alone doesn't tell. See docs/frames.md.
//   - `first`: the row as the first report words it.
//   - `repeated(n)`: as `n` of them word it.
//   - The page is the frame's own (`where.topDocId`), not whichever the
//     tab shows now.
async function frameLogCollapse(
  tabId: number,
  where: FrameInfo,
  kind: string,
  first: (on: string) => string,
  repeated: (count: number, on: string) => string,
): Promise<NonNullable<AppendLogInput['collapse']>> {
  const pageUrl = getDocState(await getTabRecord(tabId), where.topDocId)?.url ?? where.topUrl;
  const on = pageUrl ? ` on ${pageUrl}` : '';
  return {
    key: `frame:${tabId}:${where.topDocId}:${kind}`,
    message: (count) => (count === 1 ? first(on) : repeated(count, on)),
  };
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
    detail?: string;
    opaqueOrigin?: boolean;
    __viaBridge?: boolean;
  },
): Promise<void> {
  const id = payload.id;
  if (!id) return;
  // Where it came from: the page itself, or one of its iframes, and
  // which page. A frame no longer in the tab sent it before going (an
  // async error from the previous page's frames, say), and it isn't
  // about the page the tab shows now: dropped (docs/frames.md).
  const where = await frameInfo(sender, true);
  if (where.subframe && !where.live) return;
  // The page-world bridge relays any report the page sends, including
  // one about a script the extension never registered (a forgery), or
  // one that can't be there: a USER_SCRIPT-world script (whose reports
  // never take the bridge), or a `@noframes` one in a frame. Those
  // aren't ours to show (they'd read as UNEXPECTED, or in frames) or to
  // log. Not a URL check: a page may have moved (pushState) since its
  // script started.
  if (payload.__viaBridge) {
    await ensureLoaded();
    const known = indexedScript(id);
    if (!known || known.world !== 'MAIN' || (known.noframes && where.subframe)) return;
  }
  const name = String(payload.name ?? id);
  // sender.url is the document URL where the wrapper sent from; prefer
  // it over payload.url because Chrome sets it.
  const senderUrl = sender.url ?? payload.url ?? '';
  // sender.documentId is set on chrome.runtime messages (incl.
  // onUserScriptMessage) as of Chrome 106+. It's the same ID that
  // chrome.webNavigation reports, so we can use it to tell which
  // document the wrapper belongs to.
  const senderDocId = (sender as { documentId?: string }).documentId ?? '';
  // From one of the page's iframes: its run is kept apart from the top
  // frame's (docs/frames.md).
  const inFrame = where.subframe;

  const tabPart = ` tab=${tabId}${inFrame ? ` frame=${sender.frameId}` : ''}`;
  const label = getScriptLogLabel(id);
  emitSmDevEvent({
    kind: 'report',
    type,
    tabId,
    documentId: senderDocId,
    topFrame: !inFrame,
    scriptId: id,
    name,
    url: senderUrl,
    ...(payload.message !== undefined ? { message: payload.message } : {}),
    ...(payload.stack !== undefined ? { stack: payload.stack } : {}),
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
  });
  // GM_* cross-tab broadcast openers table: register the
  // (scriptId, tabId) pair on EITHER sm:start or sm:swapped. The
  // swap path is a wrapper that just took control of a document
  // and needs the same pairing so future writes can fan out to it.
  if (type === SM_START_MSG || type === SM_SWAPPED_MSG) {
    registerOpener(id, tabId, senderDocId || undefined);
  }
  if (type === SM_START_MSG) {
    console.log(`[SourceMonkey] start ${label}${tabPart} ${senderUrl}`);
    logScriptEvent(id, {
      // The run hears this as a report, so not again as a Log entry.
      fromReport: true,
      level: 'info',
      source: 'script-wrapper',
      tabId,
      message: `Started at ${senderUrl}`,
      ...(inFrame ? {
        collapse: await frameLogCollapse(tabId, where, 'start',
          (on) => `Started in an iframe at ${senderUrl}${on}`,
          (n, on) => `Started ${n} times in iframes${on}, latest at ${senderUrl}`),
      } : {}),
    });
  } else if (type === SM_SWAPPED_MSG) {
    // The reload swap path. Log alongside sm:start so the SW console
    // tells the full story when reading a transcript.
    console.log(
      `[SourceMonkey] swapped ${label}${tabPart} ${senderUrl} ` +
      `(loadedAt ${payload.fromLoadedAt ?? '?'} -> ${payload.loadedAt ?? '?'})`,
    );
    logScriptEvent(id, {
      // The run hears this as a report, so not again as a Log entry.
      fromReport: true,
      level: 'info',
      source: 'script-wrapper',
      tabId,
      // The two `loadedAt` values stay on the console line above: they
      // are epoch milliseconds, which identify a content version when
      // reading a transcript but say nothing to someone reading the Log.
      message: 'Page reloaded and swapped in the newer copy of this script',
    });
  } else if (type === SM_ABANDONED_MSG) {
    // The wrapper didn't run: told to skip, or with no decision.
    console.log(
      `[SourceMonkey] abandoned ${label}${tabPart} ${senderUrl} (reason=${payload.reason ?? '?'})`,
    );
    // Not in the script's Log for a tab sm-dev controls: it happens on
    // every load there, to scripts the person didn't ask anything of.
    // - A skip the person asked for ("Reload page with no userscripts",
    //   or one of the per-script reloads) is information.
    // - No decision is an error: the script should have been decided,
    //   and wasn't, so it didn't run. Its message is a sentence, with
    //   why (`noDecisionMessage`).
    // - Any other reason (a token, from an older wrapper's bare `skip`)
    //   is a warning, the token in parentheses as a detail.
    if (payload.reason !== SKIP_REASON_SM_DEV) {
      const message = payload.reason === SKIP_REASON_NO_DECISION
        ? noDecisionMessage(payload.detail)
        : `Did not run ${inFrame ? 'in this iframe' : 'on this page'} (${payload.reason ?? 'no reason given'})`;
      logScriptEvent(id, {
        // The run hears this as a report, so not again as a Log entry.
        fromReport: true,
        level: payload.reason === SKIP_REASON_NO_DECISION ? 'error'
          : ASKED_SKIP_REASONS.has(payload.reason ?? '') ? 'info' : 'warning',
        source: 'script-wrapper',
        tabId,
        message,
        ...(inFrame ? {
          collapse: await frameLogCollapse(tabId, where, `abandoned:${message}`,
            (on) => `${message}\nIn an iframe at ${senderUrl}${on}`,
            (n, on) => `${message}\nIn iframes ${n} times${on}, latest at ${senderUrl}`),
        } : {}),
      });
    }
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
    const text = composeWrapperErrorMessage(payload.message, payload.stack);
    logScriptEvent(id, {
      // The run hears this as a report, so not again as a Log entry.
      fromReport: true,
      level: 'error',
      source: 'script-wrapper',
      tabId,
      message: text,
      // Folded by the error's message, not its stack: frames failing
      // alike make one row, failing differently one each. Two different
      // failures with the same message share a row, showing the latest
      // one's stack.
      ...(inFrame ? {
        collapse: await frameLogCollapse(tabId, where, `error:${payload.message ?? ''}`,
          (on) => `${text}\nIn an iframe at ${senderUrl}${on}`,
          (n, on) => `${text}\nIn iframes ${n} times${on}, latest at ${senderUrl}`),
      } : {}),
    });
  }

  // Any report from a script we're flashing for means its swap has
  // resolved, one way or another. sm:abandoned counts too — that
  // wrapper is done and nothing further is coming from it — so this
  // sits above the early return below.
  noteReloadFlashReport(tabId, senderDocId, id);

  // sm:abandoned is logging-only (no "actual" report to merge, no badge
  // change), except for no decision: that's a failure, shown on the
  // badge as an error, which also keeps it from being explained later
  // as a script that never started.
  const noDecision = type === SM_ABANDONED_MSG && payload.reason === SKIP_REASON_NO_DECISION;
  if (type === SM_ABANDONED_MSG && !noDecision) return;

  // Closes the race where storage updates land BEFORE sm:start arrives.
  // See docs/matching.md#closing-the-report-after-change-race.
  // Guard against falsy loadedAt (0 / NaN) — every production write
  // bumps loadedAt to Date.now(), so a non-positive value means an old
  // wrapper that predates this field or a test fixture, neither of
  // which we want to compare against.
  const wrapperLoadedAt = typeof payload.loadedAt === 'number' && payload.loadedAt > 0
    ? payload.loadedAt : null;
  let isStale = false;
  // A manual script runs its current copy each time, so it's never
  // stale (and a new run replaces the last one's outcome).
  await ensureLoaded();
  const manual = isManualScriptId(id);
  // sm:swapped means the wrapper just ran the freshest content, so a
  // stored.loadedAt that matches the payload.loadedAt is expected and
  // does NOT make this report stale. Skip the check for that branch.
  if (wrapperLoadedAt != null && type !== SM_SWAPPED_MSG && !manual) {
    const stored = await getScriptMeta(id);
    if (stored && stored.loadedAt > wrapperLoadedAt) {
      isStale = true;
      console.log(
        `[SourceMonkey] sm:${type === SM_START_MSG ? 'start' : 'error'} is from outdated content for ${name} ` +
        `(wrapper=${wrapperLoadedAt} stored=${stored.loadedAt}); flagging tab=${tabId} as needing reload`,
      );
    }
  }

  const report: ActualStatus = noDecision
    ? { state: 'error', name, message: noDecisionMessage(payload.detail) }
    : type === SM_ERROR_MSG
      ? { state: 'error', name, message: String(payload.message ?? '') }
      : { state: 'started', name };
  const record = await getTabRecord(tabId);
  if (inFrame) {
    // Filed under the page the frame is in. Reports wait behind the
    // page's commit in the tab queue, so its state is there; none means
    // a page we don't track, with nothing to show it on.
    const pageDocId = where.topDocId || record?.currentDocId || '';
    const page = getDocState(record, pageDocId);
    if (!record || !page) return;
    const next = applyFrameReport(page, id, senderDocId, {
      ...report, frameId: sender.frameId!, url: senderUrl, ...(isStale ? { stale: true as const } : {}),
    });
    if (next === page) return;
    await setTabRecord(tabId, writeDocState(record, pageDocId, next));
    if (record.currentDocId === pageDocId) await renderBadge(tabId, next);
    return;
  }
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
    const found = findMatchesForUrl(senderUrl);
    const claimFields = await smDevClaimFields(tabId, found);
    const matches = expectedMatches(found, claimFields.smDevRun);
    state = {
      documentId: senderDocId,
      url: senderUrl,
      matches,
      actual: {},
      loadMatchIds: matches.map((m) => m.id),
      ...claimFields,
    };
  }
  let next = applyScriptReport(state, id, report, manual);
  // What this report says about the document itself, for explaining
  // another script that never starts here (see missing-scripts.ts).
  next = notePageReport(
    next,
    payload.__viaBridge === true ? 'MAIN' : 'USER_SCRIPT',
    payload.opaqueOrigin === true,
  );
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

// First, so the startup reads below can't leak a teardown rejection
// into the Errors panel if the SW is killed while they're in flight.
installSwTeardownHandler();
// Before anything writes: the row cache sees this worker's writes by
// wrapping them (row-cache.ts), and the store checks each one writes
// script rows under its lock.
installRowCache(checkScriptRowWrite);
// The debug-logging setting, read before anything is timed: a read
// started before it is requested isn't timed at all
// (`timeStorageRead`).
void loadDebugLoggingFlag();
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
  const source = buildParseCheckSource(script);
  const verdicts = await checkParses([source.text]);
  // Same resolution the page checker does, through the same helper —
  // the two routes differ only in transport, and a verdict that named
  // a different file depending on which context ran the check would be
  // a bug nobody would think to look for.
  return verdicts ? attachParseLocation(verdicts[0], source) : null;
};
setParseChecker(compileParseChecker);

// Move format 1 script rows to blobs, once (docs/storage.md#format-2-migration).
// Writes wait for it.
void storeFormatReady();
installBlobSweep();
void ensureLogIdsLoaded();
// Number new scripts and collections before each registration sync
// registers them, and reconcile the numbers at startup (see
// sticky-numbers.ts). The log labels take the script numbers at once, so
// they match what was registered.
async function assignAllNumbers(): Promise<AllNumbers> {
  const numbers = await assignNumbers();
  if (numbers) noteScriptNumbers(numberMap(numbers.scripts));
  return numbers ?? await readNumbers();
}
setBeforeSync(async () => numberMap((await assignAllNumbers()).scripts));
void assignAllNumbers();
installStorageListener();
installStaleScriptListener();
installFocusRefresh();
installNavigationListeners();
installDeepLinkRedirect();
installUserJsCapture();
// Sweep header rules stranded by a worker that died mid-request. The
// event that woke this worker may itself be an XHR, so the sweep isn't
// alone here — `installHeaderRule` waits on it rather than racing it.
void clearStaleHeaderRules();
installScriptMessageListener();
installPageFetchListener();
installPageLogWriteListener();
installConnectAnswerListener();
installDebugLoggingListener();
installLocalRootsListener();
installGithubAuthListener();
installNotificationListeners();
installDownloadListeners();
installPopupListener();
installWorkerOps(fromExtensionPage);
// Kick off the initial cache load so the very first navigation doesn't
// pay the read-everything cost on the critical path. The injector sync
// runs in parallel so registrations are in place ASAP after SW startup.
void ensureLoaded();
// The first sync takes the last worker's registration record if it
// can (`restoreRecord` in injector.ts), and otherwise reconciles
// against Chrome's own list.
void syncRegistrations();
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
