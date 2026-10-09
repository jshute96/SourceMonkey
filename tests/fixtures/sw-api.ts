// Typed wrappers around the `self.SourceMonkey` SW test surface so each
// test file doesn't repeat the same `serviceWorker.evaluate(...)`
// boilerplate. Every call re-resolves the SW handle via
// getServiceWorker — MV3 workers idle out aggressively and a cached
// handle can go stale partway through a test.

import type { Worker } from '@playwright/test';

type Mode = 'manual' | 'opportunistic';

export interface SmApi {
  // Returns the resulting collection row (existing container or new
  // collection); the proxy unwraps the `AddCollectionResult` discriminant so
  // tests can keep using `result?.id` and `result?.path` directly.
  // Returns null on a duplicate.
  addCollection(path: string): Promise<{ id: string; path: string } | null>;
  // The collection dialog's entry points. `createCollection` makes a
  // named scripts collection or a location collection; `installScript`
  // puts one `.user.js` into a specific container (or the built-in
  // default for its scheme). Same unwrapping as `addCollection`.
  createCollection(
    spec:
      | { kind: 'scripts'; name: string; localFiles?: boolean }
      | { kind: 'location'; path: string; name?: string; localFiles?: boolean },
  ): Promise<{ id: string; path: string } | null>;
  installScript(
    location: string,
    target: { collectionId: string } | { schemeDefault: true },
  ): Promise<{ id: string; path: string } | null>;
  // An sm-dev run's scripts, in its test collection: text in,
  // registered before the promise settles. See docs/sm-dev-design.md.
  writeRunScript(args: { run: string; text: string; name?: string; files?: Record<string, { url: string; localUrl?: string; bytesBase64: string; contentType: string }> }): Promise<{
    scriptId: string;
    collectionId: string;
    status: 'ok' | 'invalid';
    errorMessage?: string;
    errorLocation?: { file: string; line?: number; column?: number };
    replaced: boolean;
  }>;
  // sm-dev's tab claims (src/extension/sm-dev-link.ts).
  claimTab(tabId: number, runId: string, ttlMs: number): Promise<void>;
  isSmDevMarked(tabId: number): Promise<boolean>;
  renewRun(runId: string, ttlMs: number, tabs?: { tabId: number; scriptsOff?: boolean }[]): Promise<number>;
  releaseRun(runId: string): Promise<void>;
  sweepRunCollections(now: number): Promise<void>;
  setTabScriptsOff(tabId: number, off: boolean): Promise<void>;
  getStackLayout(scriptId: string): Promise<import('../../src/composed-source.js').StackLayout | null>;
  // Move an installed script from one scripts collection to another.
  // Resolves to the moved row, or null when the destination already
  // has it. Not unwrapped — it returns a script row, not a collection.
  moveScript(
    scriptId: string,
    target: { collectionId: string } | { schemeDefault: true },
  ): Promise<StoredScriptLike | null>;
  // Remove one installed script row, as the viewer's trash can does.
  removeScript(scriptId: string): Promise<void>;
  // Make every collection's `scriptIds` agree with the `collectionId`
  // on each script row. Resolves to how many listings it corrected.
  reconcileScriptMembership(): Promise<number>;
  setCollectionOptions(
    id: string,
    options: { displayName?: string; localFiles?: boolean },
  ): Promise<unknown>;
  removeCollection(id: string): Promise<void>;
  getCollections(): Promise<{
    id: string; path: string; enabled: boolean; scriptIds: string[];
    displayName?: string; manifestSize?: number; manifestMtime?: number;
  }[]>;
  getCollectionWithScripts(id: string): Promise<{
    collection: { id: string; path: string; enabled: boolean; scriptIds: string[]; scanError?: string };
    scripts: StoredScriptLike[];
  } | null>;
  setCollectionEnabled(id: string, enabled: boolean): Promise<unknown>;
  setCollectionLocalFiles(id: string, localFiles: boolean): Promise<unknown>;
  // The global search-root setting: absolute directory paths, in
  // search order, as the options page would save them.
  setLocalRoots(paths: string[]): Promise<void>;
  setScriptEnabled(id: string, enabled: boolean): Promise<unknown>;
  // When each script last became active / went inactive (script-enablement.md).
  getEnablementTimes(): Promise<Record<string, { activeSince?: number; inactiveSince?: number }>>;
  // Write rows straight into storage, under the store's write lock.
  seedStorage(items: Record<string, unknown>): Promise<void>;
  backfillUsesUnsafeWindow(): Promise<number>;
  setScriptEnabledExclusive(id: string, enabled: boolean): Promise<void>;
  getAllScriptMetas(): Promise<StoredScriptLike[]>;
  rowCacheLoads(): Promise<number>;
  updateCollection(id: string, mode: Mode): Promise<unknown>;
  // `probe: 'force'` is what a genuine Refresh click passes. Pass it
  // when a test is modelling a click rather than a background check —
  // it is what bypasses the refused-registration retry rate limit.
  updateScript(id: string, mode: Mode, probe?: 'force' | 'if-stale'): Promise<unknown>;
  updateAllCollections(mode: Mode): Promise<unknown>;
  getTabState(tabId: number): Promise<TabStateSnapshot>;
  // The SW's live view of the `.user.js` capture toggle. A test that
  // flips the option polls this before navigating: the storage write
  // resolving is not the same as the SW's `storage.onChanged` listener
  // having run.
  isCaptureEnabled(): Promise<boolean>;
  // As after an extension reload: forget every tab's record, then
  // mark the open pages as loaded before the extension started.
  simulateExtensionStart(): Promise<void>;
  resetAllState(): Promise<void>;
  // Run the storage format migration again, as a worker start would.
  rerunStoreMigration(): Promise<void>;
  // As a worker just started: the next write runs it.
  forgetStoreMigration(): Promise<void>;
  // One unused-blob check.
  sweepUnusedBlobs(): Promise<{ checked: number; removed: number }>;
  // As a fresh worker: the next sync is a full one.
  forgetRegistrationState(): Promise<void>;
  // Forget when each script was last checked, so the next
  // opportunistic check isn't skipped by `UPDATE_MIN_INTERVAL_MS`.
  // Needed by tests that drive two checks of the same script inside
  // that window.
  clearUpdateRateLimit(): Promise<void>;
  // `kind` says which path the sync took — see
  // docs/injection.md#the-sync-is-incremental. Both leave the same
  // registration set behind, so it is the only way a test can pin one.
  syncNow(): Promise<{ registered: { id: string }[]; kind: 'full' | 'incremental' | null }>;
  replayScriptLogsAtBoot(): Promise<void>;
  getScriptLog(scriptId: string): Promise<{
    timestamp: number;
    level: 'info' | 'warning' | 'error';
    state?: LoadStateLike;
    resetsLogLevel?: boolean;
    source: string;
    tabId?: number;
    message: string;
    location?: DiagnosticLocationLike;
  }[]>;
  clearScriptLog(scriptId: string): Promise<void>;
  // The `loglevel:` sentinel behind WARNING / ERROR — only
  // script-originated entries move it (see docs/script-log.md).
  getMaxLogLevel(scriptId: string): Promise<'info' | 'warning' | 'error' | undefined>;
  // Every PERSISTED GM value for a script, excluding the SW's in-flight
  // overlay. The wrapper's write is batched, so this is what a test
  // waits on instead of pausing.
  getGmValues(scriptId: string): Promise<Record<string, unknown>>;
  // Write values (wire form) as another tab of the script would.
  writeGmValues(scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]): Promise<void>;
  // Seeds an entry directly. For tests that need a specific message,
  // level or timestamp without staging the event that would produce it.
  appendScriptLog(scriptId: string, input: {
    level: 'info' | 'warning' | 'error';
    state?: LoadStateLike;
    source: string;
    message: string;
    tabId?: number;
    location?: DiagnosticLocationLike;
    timestamp?: number;
  }): Promise<void>;
  // Compile-only parse check. `null` means the check could not run,
  // which callers must not read as failure. Mirrors `ParseVerdict`
  // (src/parse-check-protocol.ts).
  checkParses(sources: string[]): Promise<ParseVerdictLike[] | null>;
  // Turns the install-time parse check off so a test can drive an
  // unparseable script all the way to injection.
  setParseCheckEnabled(enabled: boolean): Promise<void>;
  // How many collection compiles have run this session — lets a test tell a
  // cached verdict from a fresh one.
  getParseCheckRuns(): Promise<number>;
  // {scriptId → why chrome.userScripts refused its registration} for
  // the last sync — what the UI renders as REJECTED. Empty when
  // everything registered.
  getRejections(): Promise<Record<string, string>>;
  // {collectionId → why its last refresh could not be saved}. Empty
  // when every refresh stored cleanly.
  getRefreshErrors(): Promise<Record<string, string>>;
  // Make every collection-refresh write throw, standing in for an
  // exhausted `chrome.storage.local` quota without having to fill it.
  // Stays armed until cleared with null; also cleared by `resetAllState`.
  failCollectionWrites(message: string | null): Promise<void>;
  debugMatchIndex(url: string): Promise<{
    matches: { id: string; name: string }[];
    cache: { entries: unknown[]; disabledCollections: string[] };
  }>;
  // The stored script numbers, by script id, after numbering new scripts.
  scriptNumbers(): Promise<Record<string, number>>;
  // The stored collection numbers, by collection id, after numbering new collections.
  collectionNumbers(): Promise<Record<string, number>>;
  // The script's log label (`foo.user.js#E4`). Its number is the
  // service worker's to assign, so a test that needs the label has to
  // ask rather than predict it.
  getScriptLogLabel(scriptId: string): Promise<string>;
  // GM_registerMenuCommand test surface.
  getActionContextMenu(tabId: number): Promise<{
    scriptId: string;
    commands: { commandId: string; name: string }[];
  }[]>;
  // The toolbar popup's view of the tab: what popup.html renders.
  getPopupView(tabId: number): Promise<PopupViewLike>;
  fireActionContextMenuItem(
    tabId: number,
    scriptId: string,
    commandId: string,
  ): Promise<{ ok: boolean; error?: string }>;
  // Answers a connection prompt by the id it was shown with. False when
  // it isn't waiting.
  answerConnectPrompt(promptId: string, choice: 'once' | 'cancel' | 'allow' | 'allow-all' | 'deny'): Promise<boolean>;
  // The connection prompts waiting for an answer.
  pendingConnectPrompts(): Promise<{ promptId: string; scriptId: string; tabId: number; host: string }[]>;
  // Stands in for a popup "Run this script" click: runs a manual
  // script (`@run-at context-menu`) on the tab now.
  runManualScript(tabId: number, scriptId: string): Promise<{ ok: boolean; error?: string }>;
  // Stands in for a click on the popup's "Reload page with no
  // userscripts": reloads the tab with every wrapper told to skip.
  reloadWithoutScripts(tabId: number): Promise<void>;
  // Stands in for a toolbar-icon click in the given window (Playwright
  // can't click chrome.action). Pass null for the "no gesture window"
  // fallback path.
  openCollectionsPage(windowId: number | null): Promise<void>;
  // Stands in for a toolbar-icon click on `tabId`: two inside the
  // double-click window open the collections page, one opens the popup.
  clickAction(tabId: number, windowId: number): Promise<void>;
  closePopup(tabId: number): Promise<number>;
  // Fault-injection knob used by gm-storage-freshness.spec.ts to
  // verify the wrapper hard-aborts when the SW can't supply a
  // gmValues snapshot.
  setDebugForceSnapshotFailure(value: boolean): Promise<void>;
  // Drops the SW's in-memory GM_* openers table, leaving the worker in
  // the state it wakes up in after an idle eviction. Lets a test drive
  // the cross-tab broadcast across a simulated worker restart without
  // killing the worker the test is talking to.
  dropGmOpenersForTests(): Promise<void>;
  // The worker's "should I run?" decision for a request from a document
  // with no tab (the sender has only its URL). Gives `action` and, for a
  // skip, `reason`.
  checkPendingWithoutTabForTests(id: string, url: string, tld: boolean): Promise<{ action: string; reason?: string }>;
  // Makes the SW drop every cross-tab value broadcast, standing in for
  // one that never arrives. Stays armed until cleared with false.
  setDebugSuppressGmBroadcast(value: boolean): Promise<void>;
  // Sends the all-tabs "re-check your cache" nudge the SW fires when it
  // starts up.
  nudgeGmResync(): Promise<void>;
  // How many `file://` directory listings the SERVICE WORKER has
  // fetched successfully since the last reset — cache hits excluded,
  // and listings done in an extension page not counted at all. A
  // navigation's checks share one listing across the page's scripts
  // (see `RefreshBatch` in src/extension/script-store.ts), and this is what makes
  // that visible.
  //
  // Counts collection scans too, so reset around the window under test
  // rather than assuming a navigation is the only thing listing.
  getDirectoryListingFetches(): Promise<number>;
  resetDirectoryListingFetches(): Promise<void>;
  // The other half of what a batch shares: collection rows
  // `refreshScript` read from storage, batch hits excluded. Same
  // scoping caveats as the listing counter.
  getCollectionRowReads(): Promise<number>;
  resetCollectionRowReads(): Promise<void>;
}

// The parts of `PopupView` (src/extension/popup-view.ts) tests read.
export interface PopupViewLike {
  injectable: boolean;
  smDev: boolean;
  banner: string | null;
  perScriptReload: boolean;
  enabled: PopupGroupLike[];
  manual: PopupGroupLike[];
  disabled: PopupGroupLike[];
}

export interface PopupGroupLike {
  collection: { id: string; name: string; enabled: boolean };
  rows: {
    id: string; name: string; checked: boolean; active: boolean;
    status: string | null; tooltip: string | null; versionLine: string | null;
    commands: { commandId: string; name: string }[];
    runnable?: boolean;
  }[];
}

// Mirrors the fields of `StoredScript` (src/extension/script-store.ts) that specs
// read back. Deliberately a subset — it only has to be accurate about
// what it declares, and it crosses `evaluate()` as plain JSON.
export interface StoredScriptLike {
  id: string;
  collectionId: string;
  relativePath: string;
  // Where the script was fetched from — a `file://` URL for a
  // directory collection, the raw URL for the http kinds.
  fileUrl: string;
  status: 'ok' | 'invalid';
  errorMessage?: string;
  errorLocation?: DiagnosticLocationLike;
  refreshError?: string;
  // Whether the body uses `unsafeWindow` without granting it.
  usesUnsafeWindow?: boolean;
  size: number | null;
  fsMtime?: number;
  loadedAt: number;
  parseCheckedHash?: string;
  enabled: boolean;
  headerText: string;
  bodyText: string;
  startupLogs?: readonly {
    level: 'info' | 'warning' | 'error';
    message: string;
    location?: DiagnosticLocationLike;
  }[];
  requires?: {
    ref: string;
    url: string;
    source: string;
    size: number;
    contentHash?: string;
    loadedAt: number;
    // Set when a local file stood in for `url` — see
    // docs/local-file-overrides.md.
    localUrl?: string;
    fsMtime?: number;
    // Validators for the next refresh's conditional GET (http(s) only).
    httpEtag?: string;
    httpLastModified?: string;
  }[];
  resources?: {
    name: string;
    ref: string;
    url: string;
    bytesBase64: string;
    size: number;
    contentType: string;
    contentHash?: string;
    loadedAt: number;
    localUrl?: string;
    fsMtime?: number;
    httpEtag?: string;
    httpLastModified?: string;
  }[];
  versionProbes?: {
    kinds: string[];
    url: string;
    version?: string;
    error?: string;
    checkedAt: number;
  }[];
}

// `DiagnosticLocation` from src/diagnostic-location.ts, restated here so
// the fixtures don't import extension collection into the test build.
export interface DiagnosticLocationLike {
  file: string;
  line?: number;
  column?: number;
}

// `LoadState` from src/script-display.ts, same reasoning.
export type LoadStateLike = 'ok' | 'invalid' | 'rejected' | 'refresh-failed' | 'outdated';

// `ParseVerdict` from src/parse-check-protocol.ts, same reasoning.
export interface ParseVerdictLike {
  status: 'ok' | 'syntax-error' | 'unknown';
  message?: string;
  probes?: { raw?: ParseProbeResultLike; wrapped?: ParseProbeResultLike };
  location?: { file: string; line: number; column: number };
}

export interface ParseProbeResultLike {
  message: string;
  line?: number;
  column?: number;
}

export interface TabStateSnapshot {
  badgeText: string;
  badgeColor: unknown;     // RGBA tuple from chrome.action.getBadgeBackgroundColor
  title: string;
  // The popup's rows with a status, as `Name | STATUS` (`Hello | OK`).
  rows: string[];
  record: TabRecordLike | null;
}

export interface TabRecordLike {
  currentDocId: string;
  docOrder: string[];
  byDoc: Record<string, {
    documentId: string;
    url: string;
    matches: { id: string; name: string }[];
    actual: Record<string, { state: 'started' | 'error'; name: string; message?: string }>;
    staleScriptIds?: string[];
  }>;
}

// Build a `swApi` object from a getServiceWorker fixture function. Each
// method re-resolves the worker before evaluating so a torn-down handle
// from a prior call doesn't fail the test with a confusing error.
export function makeSwApi(getServiceWorker: () => Promise<Worker>): SmApi {
  const call = async <T>(method: keyof SmApi, args: unknown[]): Promise<T> => {
    const sw = await getServiceWorker();
    return sw.evaluate(
      async ({ method, args }) => {
        const api = (self as unknown as { SourceMonkey: Record<string, (...a: unknown[]) => unknown> }).SourceMonkey;
        const fn = api[method];
        if (typeof fn !== 'function') throw new Error(`SourceMonkey.${method} is not a function`);
        return await fn(...args);
      },
      { method: method as string, args },
    ) as Promise<T>;
  };
  return new Proxy({} as SmApi, {
    get: (_t, prop) => {
      // The real SW addCollection returns a discriminated
      // `AddCollectionResult` (covers the container-create vs
      // container-reuse vs new-collection distinction). Tests just want
      // the resulting collection row; unwrap here so the SmApi contract
      // stays a thin pass-through.
      if (prop === 'addCollection' || prop === 'createCollection' || prop === 'installScript') {
        return async (...args: unknown[]) => {
          const result = await call<{
            kind: string;
            collection: { id: string; path: string };
          } | null>(prop, args);
          return result?.collection ?? null;
        };
      }
      return (...args: unknown[]) => call(prop as keyof SmApi, args);
    },
  });
}

// Poll a SW-side query until the predicate returns true or `timeoutMs`
// elapses. Helpful for tests that wait on async side-effects of a
// storage write (badge re-render, message ingestion, etc.).
//
// Throws with the most recent observed value embedded in the message
// so failures are debuggable without a re-run.
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor(${options.label ?? 'predicate'}) timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`,
  );
}

// Wait until the single registered script's persisted GM values satisfy
// `predicate`. `GM_setValue` batches its write 150ms after the last one,
// so "the page reported the value" is not "storage has it" — a test that
// needs it durable waits for this rather than pausing.
//
// Reads persisted rows only, deliberately excluding the SW's in-flight
// `gmValueOverlay`: a predicate that passes here has passed against what
// actually survives, which is stronger than what production needs to
// answer a check-pending.
export async function waitForGmValues(
  api: SmApi,
  predicate: (values: Record<string, unknown>) => boolean,
  label = 'GM values',
): Promise<Record<string, unknown>> {
  const scriptIds = (await api.getCollections()).flatMap((s) => s.scriptIds);
  // Guarded rather than indexed blindly: with no script registered,
  // `loadAllValues(undefined)` returns {} quite happily and the caller
  // burns the full timeout reporting a storage problem, when the real
  // failure was that nothing registered at all.
  if (scriptIds.length !== 1) {
    throw new Error(
      `waitForGmValues expects exactly one registered script, saw ${scriptIds.length}`,
    );
  }
  return waitFor(() => api.getGmValues(scriptIds[0]), predicate, { label });
}

// Convenience: wait until a tab's badge state matches `predicate`.
// The active tab's numeric `chrome.tabs.Tab.id` — the same ID the
// action APIs take as `tabId`. Playwright doesn't expose it on Page,
// so every badge-watching spec asks the SW right after opening a page.
export async function activeTabId(
  getServiceWorker: () => Promise<Worker>,
): Promise<number> {
  const sw = await getServiceWorker();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab');
    return tab.id;
  });
}

// Does the snapshot's badge carry this `#rrggbb`?
// `chrome.action.getBadgeBackgroundColor` returns [r, g, b, a].
export function hasBadgeColor(snapshot: TabStateSnapshot, hex: string): boolean {
  if (!Array.isArray(snapshot.badgeColor)) return false;
  const [r, g, b] = snapshot.badgeColor as number[];
  return (
    r === parseInt(hex.slice(1, 3), 16) &&
    g === parseInt(hex.slice(3, 5), 16) &&
    b === parseInt(hex.slice(5, 7), 16)
  );
}

// Every stored script, across every collection, in collection order.
// The SW test surface exposes collections and their scripts, not a flat
// list, so every test that wants "the row for a.user.js" walks the same
// two calls.
export async function allScripts(api: SmApi): Promise<StoredScriptLike[]> {
  const out: StoredScriptLike[] = [];
  for (const collection of await api.getCollections()) {
    const withScripts = await api.getCollectionWithScripts(collection.id);
    out.push(...(withScripts?.scripts ?? []));
  }
  return out;
}

export async function waitForTabState(
  api: SmApi,
  tabId: number,
  predicate: (snapshot: TabStateSnapshot) => boolean,
  label = 'tab state',
): Promise<TabStateSnapshot> {
  return waitFor(() => api.getTabState(tabId), predicate, { label });
}
