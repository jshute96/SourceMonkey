// SW-side `GM_registerMenuCommand` / `GM_unregisterMenuCommand` state.
//
// Per-tab, per-script registry of menu commands a userscript has asked
// us to expose. The wrapper holds the actual callback locally (callbacks
// aren't serializable across worlds); we only track enough to render
// the toolbar popup's command rows and route a click back to the right tab.
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
//
// PRECONDITION: one document per tab. A tab holds commands for exactly
// one `documentId` (see `byTab` below), which is sound only because
// scripts run in the top frame only — we never set `allFrames`. If
// that changes, subframe and top-frame wrappers will name different
// documents and replace each other's commands here; this needs to be
// re-keyed by (tabId, documentId) first, with the popup merging
// across a tab's live documents.



export interface MenuCommandEntry {
  commandId: string;
  // The visible label, taken verbatim from `GM_registerMenuCommand(name, ...)`.
  name: string;
}

// tabId → { the document those commands belong to, scriptId → ordered
// list of commands }. Insertion order matches the order
// GM_registerMenuCommand calls came in, so the menu renders commands in
// the order the script declared them.
//
// The `docId` is what makes the fresh-document clear race-free: the
// navigation handler that clears is async, so a `document-end` wrapper
// in the NEW document can register before the clear for that same
// navigation runs. Tagging the state with its document lets the clear
// say "drop the old document's commands" instead of "drop whatever is
// here", so an early registration survives instead of being wiped with
// nothing left to re-register it.
interface TabMenuState {
  docId: string;
  scripts: Map<string, MenuCommandEntry[]>;
}

const byTab = new Map<number, TabMenuState>();

// Commands are per-document, so a register for a different document
// than the one we're holding replaces the state rather than adding to
// it — whichever of the register and the navigation clear arrives
// first, the loser is a no-op.
//
// Known window, same accepted class as the `chrome.tabs.onRemoved` one
// noted at the register call site: a message from a document that has
// already been torn down can in principle land after its successor has
// registered, and would replace the live document's commands. Nothing
// local can tell that apart from the ordinary case (both are "a
// different document"), and it needs a message to outlive a whole
// navigation plus the next document's `document-end`.
function ensureTab(tabId: number, docId: string): Map<string, MenuCommandEntry[]> {
  const existing = byTab.get(tabId);
  if (existing && existing.docId === docId) return existing.scripts;
  const state: TabMenuState = { docId, scripts: new Map() };
  byTab.set(tabId, state);
  return state.scripts;
}

// Register or update a menu command. TM/VM both treat `GM_registerMenuCommand`
// with an existing `id` (passed via the options object) as an update, so
// we mirror that by overwriting any entry with the same commandId.
//
// Returns true iff the visible state changed (new entry, or an update
// that changed `name`). Callers gate menu rebuilds on this so a noisy
// no-op register doesn't send an open popup a redraw.
export function registerMenuCommand(
  tabId: number,
  docId: string,
  scriptId: string,
  commandId: string,
  name: string,
): boolean {
  const scripts = ensureTab(tabId, docId);
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
  docId: string,
  scriptId: string,
  commandId: string,
): boolean {
  const state = byTab.get(tabId);
  if (!state) return false;
  // Scoped like the register side: an unregister from a document we're
  // no longer holding commands for must not reach into the current
  // document's entries. Reachable with an explicit `{id: '...'}`, where
  // the same commandId legitimately exists in both documents.
  if (state.docId !== docId) return false;
  const { scripts } = state;
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
  return byTab.get(tabId)?.scripts ?? new Map();
}

// Look up a single command — used by the popup's command handler to
// resolve a clicked menuItemId back to the originating script.
export function findMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
): MenuCommandEntry | null {
  const list = byTab.get(tabId)?.scripts.get(scriptId);
  if (!list) return null;
  return list.find((c) => c.commandId === commandId) ?? null;
}

// Drop every command for a tab. Called on `chrome.tabs.onRemoved`, on
// navigation to a page we don't inject into, and on fresh-document
// navigation (when `updateTabMatches` resets `actual` to `{}`). The
// next document's wrapper will re-register.
//
// `keepDocumentId` is for the navigation caller: it runs after several
// awaits, by which time the new document's wrapper may already have
// registered. Passing the document being navigated TO makes the clear
// drop only state left over from an earlier document, so a wrapper
// that registered early keeps its commands. Omit it to drop the tab's
// state unconditionally.
//
// It does NOT make the clear safe in general: leaving a document drops
// that document's commands, and a bfcache restore back to it does not
// re-register them (Chrome doesn't re-inject). See the known gap in
// GM-APIs.md.
//
// An empty `keepDocumentId` means the caller doesn't know which
// document it is navigating to, and an unknown document must not
// protect state: fall back to the unconditional clear rather than
// keeping commands we can't tie to anything.
//
// Mirror of the late-register window above: a clear naming an
// intermediate document can still delete a newer document's
// registrations if two navigations land inside one await window.
// Neither side can order documents from local state alone.
export function clearTab(tabId: number, keepDocumentId?: string): void {
  if (keepDocumentId && byTab.get(tabId)?.docId === keepDocumentId) return;
  byTab.delete(tabId);
}
