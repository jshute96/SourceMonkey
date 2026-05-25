// SW-side `GM_registerMenuCommand` / `GM_unregisterMenuCommand` state.
//
// Per-tab, per-script registry of menu commands a userscript has asked
// us to expose. The wrapper holds the actual callback locally (callbacks
// aren't serializable across worlds); we only track enough to render
// the action context menu and route a click event back to the right tab.
//
// Lifecycle:
//   - Registered by the wrapper after `sm:start` via `sm:gm-menu-register`.
//   - Cleared per-tab on a fresh-document navigation (the new wrapper's
//     `sm:start` will re-register from scratch) and on tab close.
//   - SW restart wipes this state. The wrapper's per-document callbacks
//     also vanish on document teardown, so the symmetric drop is
//     correct: the SW would have no way to route a fire event back to a
//     callback that no longer exists.
//
// Storage is in-memory only — same shape as `gm-tab.ts` / `gm-notification.ts`.

export interface MenuCommandEntry {
  commandId: string;
  // The visible label, taken verbatim from `GM_registerMenuCommand(name, ...)`.
  name: string;
}

// tabId → scriptId → ordered list of commands. Insertion order matches
// the order GM_registerMenuCommand calls came in, so the menu renders
// commands in the order the script declared them.
const byTab = new Map<number, Map<string, MenuCommandEntry[]>>();

function ensureTab(tabId: number): Map<string, MenuCommandEntry[]> {
  let scripts = byTab.get(tabId);
  if (!scripts) {
    scripts = new Map();
    byTab.set(tabId, scripts);
  }
  return scripts;
}

// Register or update a menu command. TM/VM both treat `GM_registerMenuCommand`
// with an existing `id` (passed via the options object) as an update, so
// we mirror that by overwriting any entry with the same commandId.
//
// Returns true iff the visible state changed (new entry, or an update
// that changed `name`). Callers gate menu rebuilds on this so a noisy
// no-op register doesn't drive a chrome.contextMenus rebuild.
export function registerMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
  name: string,
): boolean {
  const scripts = ensureTab(tabId);
  const list = scripts.get(scriptId);
  if (!list) {
    scripts.set(scriptId, [{ commandId, name }]);
    return true;
  }
  const existing = list.findIndex((c) => c.commandId === commandId);
  if (existing >= 0) {
    if (list[existing]!.name === name) return false;
    list[existing] = { commandId, name };
    return true;
  }
  list.push({ commandId, name });
  return true;
}

// Remove a menu command. No-op if it isn't registered (matches TM —
// `GM_unregisterMenuCommand(<unknown id>)` is silent). Returns true
// iff the visible state changed, so callers can skip a wasted rebuild
// on unknown ids.
export function unregisterMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
): boolean {
  const scripts = byTab.get(tabId);
  if (!scripts) return false;
  const list = scripts.get(scriptId);
  if (!list) return false;
  if (!list.some((c) => c.commandId === commandId)) return false;
  const next = list.filter((c) => c.commandId !== commandId);
  if (next.length === 0) {
    scripts.delete(scriptId);
    if (scripts.size === 0) byTab.delete(tabId);
  } else {
    scripts.set(scriptId, next);
  }
  return true;
}

// All registered commands for a tab, keyed by scriptId. Returns an
// empty map when nothing is registered (callers iterate it either way).
export function getMenuCommandsForTab(
  tabId: number,
): ReadonlyMap<string, readonly MenuCommandEntry[]> {
  return byTab.get(tabId) ?? new Map();
}

// Look up a single command — used by the action-menu click handler to
// resolve a clicked menuItemId back to the originating script.
export function findMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
): MenuCommandEntry | null {
  const list = byTab.get(tabId)?.get(scriptId);
  if (!list) return null;
  return list.find((c) => c.commandId === commandId) ?? null;
}

// Drop every command for a tab. Called on `chrome.tabs.onRemoved` and
// on fresh-document navigation (when `updateTabMatches` resets `actual`
// to `{}`). The next document's wrapper will re-register.
export function clearTab(tabId: number): void {
  byTab.delete(tabId);
}
