// Typed wrappers around the `self.SourceMonkey` SW test surface so each
// test file doesn't repeat the same `serviceWorker.evaluate(...)`
// boilerplate. Every call re-resolves the SW handle via
// getServiceWorker — MV3 workers idle out aggressively and a cached
// handle can go stale partway through a test.

import type { Worker } from '@playwright/test';

type Mode = 'manual' | 'opportunistic';

export interface SmApi {
  // Returns the resulting source row (existing container or new
  // source); the proxy unwraps the `AddSourceResult` discriminant so
  // tests can keep using `result?.id` and `result?.path` directly.
  // Returns null on a duplicate.
  addSource(path: string): Promise<{ id: string; path: string } | null>;
  removeSource(id: string): Promise<void>;
  getSources(): Promise<{ id: string; path: string; enabled: boolean; scriptIds: string[] }[]>;
  getSourceWithScripts(id: string): Promise<{
    source: { id: string; path: string; enabled: boolean; scriptIds: string[]; scanError?: string };
    scripts: StoredScriptLike[];
  } | null>;
  setSourceEnabled(id: string, enabled: boolean): Promise<unknown>;
  setScriptEnabled(id: string, enabled: boolean): Promise<unknown>;
  updateSource(id: string, mode: Mode): Promise<unknown>;
  // `probe: 'force'` is what a genuine Refresh click passes. Pass it
  // when a test is modelling a click rather than a background check —
  // it is what bypasses the refused-registration retry rate limit.
  updateScript(id: string, mode: Mode, probe?: 'force' | 'if-stale'): Promise<unknown>;
  updateAllSources(mode: Mode): Promise<unknown>;
  getTabState(tabId: number): Promise<TabStateSnapshot>;
  resetAllState(): Promise<void>;
  syncNow(): Promise<{ registered: { id: string }[] }>;
  replayScriptLogsAtBoot(): Promise<void>;
  getScriptLog(scriptId: string): Promise<{
    timestamp: number;
    level: 'info' | 'warning' | 'error';
    source: string;
    tabId?: number;
    message: string;
  }[]>;
  clearScriptLog(scriptId: string): Promise<void>;
  // {scriptId → why chrome.userScripts refused its registration} for
  // the last sync — what the UI renders as REJECTED. Empty when
  // everything registered.
  getRejections(): Promise<Record<string, string>>;
  debugMatchIndex(url: string): Promise<{
    matches: { id: string; name: string }[];
    cache: { entries: unknown[]; disabledSources: string[] };
  }>;
  // Dedup-aware log label (`foo.user.js`, `foo.user.js#2`). Which
  // member of a dupe group gets which `#N` is decided by UUID sort, so
  // a test that needs the label has to ask rather than predict it.
  getScriptLogLabel(scriptId: string): Promise<string>;
  // GM_registerMenuCommand test surface.
  getActionContextMenu(tabId: number): Promise<{
    scriptId: string;
    commands: { commandId: string; name: string }[];
  }[]>;
  // Returns the planned action context-menu layout for the tab,
  // including the 6-item-cap overflow split into a "More" submenu.
  getActionContextMenuPlan(tabId: number): Promise<ActionMenuPlanLike>;
  fireActionContextMenuItem(
    tabId: number,
    scriptId: string,
    commandId: string,
  ): Promise<{ ok: boolean; error?: string }>;
  // Fault-injection knob used by gm-storage-freshness.spec.ts to
  // verify the wrapper hard-aborts when the SW can't supply a
  // gmValues snapshot.
  setDebugForceSnapshotFailure(value: boolean): Promise<void>;
}

export interface ActionMenuPlanLike {
  top: ActionMenuScriptLike[];
  more: ActionMenuScriptLike[];
}

export interface ActionMenuScriptLike {
  scriptId: string;
  title: string;
  commands: { commandId: string; title: string }[];
}

export interface StoredScriptLike {
  id: string;
  sourceId: string;
  relativePath: string;
  status: 'ok' | 'invalid' | 'missing';
  errorMessage?: string;
  refreshError?: string;
  size: number | null;
  loadedAt: number;
  parseCheckedHash?: string;
  enabled: boolean;
  bodyText: string;
}

export interface TabStateSnapshot {
  badgeText: string;
  badgeColor: unknown;     // RGBA tuple from chrome.action.getBadgeBackgroundColor
  title: string;
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
      // The real SW addSource returns a discriminated `AddSourceResult`
      // (covers the container-create vs container-reuse vs new-source
      // distinction). Tests just want the resulting source row; unwrap
      // here so the SmApi contract stays a thin pass-through.
      if (prop === 'addSource') {
        return async (...args: unknown[]) => {
          const result = await call<{
            kind: string;
            source: { id: string; path: string };
          } | null>('addSource', args);
          return result?.source ?? null;
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

// Convenience: wait until a tab's badge state matches `predicate`.
export async function waitForTabState(
  api: SmApi,
  tabId: number,
  predicate: (snapshot: TabStateSnapshot) => boolean,
  label = 'tab state',
): Promise<TabStateSnapshot> {
  return waitFor(() => api.getTabState(tabId), predicate, { label });
}
