// Typed wrappers around the `self.SourceMonkey` SW test surface so each
// test file doesn't repeat the same `serviceWorker.evaluate(...)`
// boilerplate. Every call re-resolves the SW handle via
// getServiceWorker — MV3 workers idle out aggressively and a cached
// handle can go stale partway through a test.

import type { Worker } from '@playwright/test';

type Mode = 'manual' | 'opportunistic';

interface SmApi {
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
  updateScript(id: string, mode: Mode): Promise<unknown>;
  updateAllSources(mode: Mode): Promise<unknown>;
  getTabState(tabId: number): Promise<TabStateSnapshot>;
  resetAllState(): Promise<void>;
  syncNow(): Promise<{ registered: { id: string }[] }>;
  debugMatchIndex(url: string): Promise<{
    matches: { id: string; name: string }[];
    cache: { entries: unknown[]; disabledSources: string[] };
  }>;
}

export interface StoredScriptLike {
  id: string;
  sourceId: string;
  relativePath: string;
  status: 'ok' | 'error' | 'missing';
  errorMessage?: string;
  size: number | null;
  loadedAt: number;
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
    get: (_t, prop) => (...args: unknown[]) => call(prop as keyof SmApi, args),
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
