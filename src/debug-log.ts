// Debug-only console logging gate.
//
// Several lifecycle messages (per-navigation match list, per-refresh
// "update check" / "no change") are useful when diagnosing matcher or
// updater behavior but far too noisy for normal use — they fire on
// every click. They're off by default and gated through `dlog` /
// `dwarn`. Flip on by setting `chrome.storage.local`'s
// `smDebugLogging` key to `true` (e.g. from the SW DevTools console:
// `chrome.storage.local.set({ smDebugLogging: true })`).

export const DEBUG_LOGGING_KEY = 'smDebugLogging';

let enabled = false;

export function isDebugLoggingEnabled(): boolean {
  return enabled;
}

// Test/debug hook. Production callers should toggle the storage key
// instead so the change persists and is observed via onChanged.
export function _setDebugLoggingForTests(value: boolean): void {
  enabled = value;
}

// Settles once the setting has been read in this context.
let loading: Promise<void> | null = null;
let loaded = false;

export function loadDebugLoggingFlag(): Promise<void> {
  loading = (async () => {
    try {
      const got = await chrome.storage.local.get(DEBUG_LOGGING_KEY);
      enabled = got[DEBUG_LOGGING_KEY] === true;
    } catch {
      enabled = false;
    }
    loaded = true;
  })();
  return loading;
}

// Whether the setting is still being read: a line about work done before
// then can wait for `debugLoggingSettled` rather than be dropped.
export function debugLoggingPending(): boolean {
  return loading !== null && !loaded;
}

// Whether debug logging is on, once the setting has been read (at once
// in a context that never reads it).
export async function debugLoggingSettled(): Promise<boolean> {
  await loading;
  return enabled;
}

// Idempotent, matching `match-index.ts`'s storage listener. Several
// contexts install this (the worker and the extension pages), and a
// context that called twice would double every flag update.
let listenerInstalled = false;

export function installDebugLoggingListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[DEBUG_LOGGING_KEY];
    if (!change) return;
    enabled = change.newValue === true;
  });
}

export function dlog(...args: unknown[]): void {
  if (enabled) console.log(...args);
}

export function dwarn(...args: unknown[]): void {
  // console.info (not console.warn / .error) — see background.ts sm:error
  // handler for the rationale: Chrome surfaces SW warn+error into the
  // chrome://extensions/?errors panel, which should be reserved for
  // actual extension bugs, not SourceMonkey's own diagnostic chatter.
  if (enabled) console.info(...args);
}
