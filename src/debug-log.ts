// Debug-only console logging gate.
//
// Several lifecycle messages (per-navigation match list, per-refresh
// "update check" / "no change") are useful when diagnosing matcher or
// updater behavior but far too noisy for normal use — they fire on
// every click. They're off by default and gated through `dlog` /
// `dwarn`. Flip on by setting `chrome.storage.local`'s
// `vmDebugLogging` key to `true` (e.g. from the SW DevTools console:
// `chrome.storage.local.set({ vmDebugLogging: true })`).

export const DEBUG_LOGGING_KEY = 'vmDebugLogging';

let enabled = false;

export function isDebugLoggingEnabled(): boolean {
  return enabled;
}

// Test/debug hook. Production callers should toggle the storage key
// instead so the change persists and is observed via onChanged.
export function _setDebugLoggingForTests(value: boolean): void {
  enabled = value;
}

export async function loadDebugLoggingFlag(): Promise<void> {
  try {
    const got = await chrome.storage.local.get(DEBUG_LOGGING_KEY);
    enabled = got[DEBUG_LOGGING_KEY] === true;
  } catch {
    enabled = false;
  }
}

export function installDebugLoggingListener(): void {
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
  // console.info (not console.warn / .error) — see background.ts vm:error
  // handler for the rationale: Chrome surfaces SW warn+error into the
  // chrome://extensions/?errors panel, which should be reserved for
  // actual extension bugs, not VibeMonkey's own diagnostic chatter.
  if (enabled) console.info(...args);
}
