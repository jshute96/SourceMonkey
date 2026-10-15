// SW-side `GM_registerMenuCommand` / `GM_unregisterMenuCommand` state.
//
// Per-tab, per-document, per-script registry of menu commands a
// userscript has asked us to expose. The wrapper holds the actual
// callback locally (callbacks aren't serializable across worlds); we
// only track enough to render the toolbar popup's command rows and
// route a click back to the document that registered it.
//
// Lifecycle:
//   - Registered by the wrapper after `sm:start` via `sm:gm-menu-register`.
//   - Cleared per-tab on a fresh-document navigation of the top frame
//     (the new wrappers re-register from scratch) and on tab close.
//   - A frame's commands go with its document (`pruneDocuments`).
//   - SW restart wipes this state. The wrapper's per-document callbacks
//     also vanish on document teardown, so the symmetric drop is
//     correct: the SW would have no way to route a fire event back to a
//     callback that no longer exists.
//
// Every registration is kept. A script's caption shows once per tab, and
// picking it runs all its registrations (`visibleCommands`,
// `menuCommandGroup`).
//
// Storage is in-memory only — same shape as `gm-tab.ts` / `gm-notification.ts`.
//
// A tab holds commands from several documents when scripts run in its
// iframes: the top frame's and each frame's. The popup merges them per
// script (docs/frames.md).

import { visibleCommands } from '../menu-captions.js';

export interface MenuCommandEntry {
  commandId: string;
  // The visible label, taken verbatim from `GM_registerMenuCommand(name, ...)`.
  name: string;
  // The document that registered it, where a click fires it. Two
  // frames can register the same commandId (an explicit `{id}`).
  documentId: string;
}

// One document's commands: scriptId → ordered list of commands.
// Insertion order matches the order GM_registerMenuCommand calls came
// in, so the menu renders commands in the order the script declared
// them.
//
// `topDocId` is the tab's top document when this document registered
// (its own id, for the top frame). It's what makes the fresh-document
// clear race-free: the navigation handler that clears is async, so a
// `document-end` wrapper in the NEW page (top frame or one of its
// frames) can register before the clear for that same navigation
// runs. Tagging each document with its page lets the clear say "drop
// the old page's commands" instead of "drop whatever is here", so an
// early registration survives instead of being wiped with nothing left
// to re-register it.
interface DocMenuState {
  topDocId: string;
  scripts: Map<string, MenuCommandEntry[]>;
}

// tabId → documentId → its commands, top frame first.
const byTab = new Map<number, Map<string, DocMenuState>>();

// Commands are per-page, so a register under a different top document
// than the one we're holding replaces the tab's state rather than
// adding to it — whichever of the register and the navigation clear
// arrives first, the loser is a no-op.
//
// Known window, same accepted class as the `chrome.tabs.onRemoved` one
// noted at the register call site: a message from a document that has
// already been torn down can in principle land after its successor has
// registered, and would replace the live page's commands. Nothing
// local can tell that apart from the ordinary case (both are "a
// different page"), and it needs a message to outlive a whole
// navigation plus the next document's `document-end`.
function ensureDoc(tabId: number, docId: string, topDocId: string): Map<string, MenuCommandEntry[]> {
  let docs = byTab.get(tabId);
  if (docs && [...docs.values()].some((d) => d.topDocId !== topDocId)) docs = undefined;
  if (!docs) {
    docs = new Map();
    byTab.set(tabId, docs);
  }
  let doc = docs.get(docId);
  if (!doc) {
    doc = { topDocId, scripts: new Map() };
    // The top frame's commands list first.
    if (docId === topDocId) byTab.set(tabId, new Map([[docId, doc], ...docs]));
    else docs.set(docId, doc);
  }
  return doc.scripts;
}

// Register or update a menu command. TM/VM both treat `GM_registerMenuCommand`
// with an existing `id` (passed via the options object) as an update, so
// we mirror that by overwriting any entry with the same commandId.
//
// `topDocId` is the tab's top document; omitted, `docId` is the top
// frame's own.
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
  topDocId: string = docId,
): boolean {
  const scripts = ensureDoc(tabId, docId, topDocId);
  const entry = { commandId, name, documentId: docId };
  const list = scripts.get(scriptId);
  if (!list) {
    scripts.set(scriptId, [entry]);
    return true;
  }
  const existing = list.findIndex((c) => c.commandId === commandId);
  if (existing >= 0) {
    if (list[existing]!.name === name) return false;
    list[existing] = entry;
    return true;
  }
  list.push(entry);
  return true;
}

// Remove a menu command. No-op if it isn't registered (matches TM —
// `GM_unregisterMenuCommand(<unknown id>)` is silent). Returns true
// iff a registration was removed, so callers can skip a wasted rebuild
// on unknown ids. (Removing a hidden older registration of a repeated
// caption also returns true: a redraw that changes nothing.)
//
// Scoped like the register side: an unregister reaches only its own
// document's entries. The same commandId can legitimately exist in two
// documents (an explicit `{id: '...'}`).
export function unregisterMenuCommand(
  tabId: number,
  docId: string,
  scriptId: string,
  commandId: string,
): boolean {
  const docs = byTab.get(tabId);
  const scripts = docs?.get(docId)?.scripts;
  if (!docs || !scripts) return false;
  const list = scripts.get(scriptId);
  if (!list) return false;
  if (!list.some((c) => c.commandId === commandId)) return false;
  const next = list.filter((c) => c.commandId !== commandId);
  if (next.length === 0) {
    scripts.delete(scriptId);
    if (scripts.size === 0) docs.delete(docId);
    if (docs.size === 0) byTab.delete(tabId);
  } else {
    scripts.set(scriptId, next);
  }
  return true;
}

// Every registration in a tab, keyed by scriptId, in registration
// order: the top frame's first, then each frame's.
function allCommandsForTab(tabId: number): Map<string, MenuCommandEntry[]> {
  const merged = new Map<string, MenuCommandEntry[]>();
  for (const doc of byTab.get(tabId)?.values() ?? []) {
    for (const [scriptId, list] of doc.scripts) {
      const into = merged.get(scriptId);
      if (into) into.push(...list); else merged.set(scriptId, [...list]);
    }
  }
  return merged;
}

// The commands a tab shows, keyed by scriptId: one per caption across
// all the tab's documents (see `visibleCommands`). Returns an empty map
// when nothing is registered (callers iterate it either way).
export function getMenuCommandsForTab(
  tabId: number,
): ReadonlyMap<string, readonly MenuCommandEntry[]> {
  const shown = new Map<string, MenuCommandEntry[]>();
  for (const [scriptId, list] of allCommandsForTab(tabId)) {
    shown.set(scriptId, visibleCommands(list, (c) => c.name));
  }
  return shown;
}

// The registrations picking `entry` runs: all of the script's commands
// in the tab with its caption, in any document, in registration order.
export function menuCommandGroup(
  tabId: number,
  scriptId: string,
  entry: MenuCommandEntry,
): MenuCommandEntry[] {
  return (allCommandsForTab(tabId).get(scriptId) ?? []).filter((c) => c.name === entry.name);
}

// Look up a single command — used by the popup's command handler to
// resolve a clicked item back to the originating document. Without
// `documentId`, the first document holding it, top frame first.
export function findMenuCommand(
  tabId: number,
  scriptId: string,
  commandId: string,
  documentId?: string,
): MenuCommandEntry | null {
  for (const [docId, doc] of byTab.get(tabId) ?? []) {
    if (documentId !== undefined && docId !== documentId) continue;
    const found = doc.scripts.get(scriptId)?.find((c) => c.commandId === commandId);
    if (found) return found;
  }
  return null;
}

// Drop every command for a tab. Called on `chrome.tabs.onRemoved`, on
// navigation to a page we don't inject into, and on fresh-document
// navigation (when `updateTabMatches` resets `actual` to `{}`). The
// next document's wrappers will re-register.
//
// `keepDocumentId` is for the navigation caller: it runs after several
// awaits, by which time the new page's wrappers may already have
// registered. Passing the top document being navigated TO makes the
// clear drop only state left over from an earlier page, so a wrapper
// that registered early (in the top frame or a frame of it) keeps its
// commands. Omit it to drop the tab's state unconditionally.
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
  const docs = byTab.get(tabId);
  if (keepDocumentId && docs && [...docs.values()].every((d) => d.topDocId === keepDocumentId)) return;
  byTab.delete(tabId);
}

// Drop the commands of a tab's frame documents that aren't in
// `liveDocIds` (the tab's frames now): the frame navigated or was
// removed. The top frame's are left to `clearTab`. Returns true iff
// something went.
export function pruneDocuments(tabId: number, liveDocIds: ReadonlySet<string>): boolean {
  const docs = byTab.get(tabId);
  if (!docs) return false;
  let changed = false;
  for (const [docId, doc] of docs) {
    if (docId === doc.topDocId || liveDocIds.has(docId)) continue;
    docs.delete(docId);
    changed = true;
  }
  if (docs.size === 0) byTab.delete(tabId);
  return changed;
}

// The top document the tab's commands belong to, or undefined when it
// holds none.
export function topDocument(tabId: number): string | undefined {
  return byTab.get(tabId)?.values().next().value?.topDocId;
}

// Whether the tab holds commands from any frame's document (as opposed
// to only the top frame's): `pruneDocuments` has something to check.
export function hasFrameDocuments(tabId: number): boolean {
  for (const [docId, doc] of byTab.get(tabId) ?? []) if (docId !== doc.topDocId) return true;
  return false;
}
