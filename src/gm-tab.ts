// SW-side `GM_openInTab` dispatcher.
//
// Owns the (requestId ↔ chrome tab id ↔ originator tab id) mapping
// so we can route close events back to the page that opened the tab.
// Per-call state is small; we keep two maps for O(1) lookup either
// way:
//
//   requestState: requestId -> { tabId?, originatorTabId, scriptId }
//   tabIdToRequest: chromeTabId -> requestId
//
// The maps live in memory only. On SW restart the mapping is lost —
// userscripts that hold a control handle from before the restart
// stop receiving close notifications. That's the same boat as XHR
// requests in flight; acceptable for v1.

import { dropEntriesForOriginator } from './gm-originator-map.js';
import { hasAllowedScheme, WEB_SCHEMES } from './gm-url-scheme.js';

interface RequestEntry {
  originatorTabId: number;
  // Assigned once chrome.tabs.create resolves. Until then the
  // request is "creating".
  tabId: number | null;
  // Set when closeGmTab fires before chrome.tabs.create has
  // resolved. The create callback checks this and immediately
  // removes the freshly-opened tab, so a fast-then-close caller
  // doesn't leak an unwanted tab.
  closeRequested: boolean;
}

const requestState = new Map<string, RequestEntry>();
const tabIdToRequest = new Map<number, string>();

export interface GmTabOpenPayload {
  scriptId: string;
  requestId: string;
  url: string;
  active: boolean;
  // TM's `insert: true` → place the new tab right after the opener.
  // chrome.tabs.create takes an `openerTabId` (which biases Chrome to
  // put the tab next to the opener) — we use that as a best-effort
  // proxy. Exact-positional `insert` (with `index`) would require
  // querying the opener tab's index first; not worth the round-trip
  // for v1.
  insert: boolean;
}

export interface GmTabOpenResult {
  ok: boolean;
  tabId?: number;
  error?: string;
}

// Only http(s) targets are allowed. The URL comes straight from
// page-supplied message payload, so without this gate a script could
// ask the privileged SW to open `file://`, `chrome://`, or
// `chrome-extension://` tabs (local-file disclosure, settings pages,
// other extensions' pages). TM/VM's GM_openInTab is web-oriented;
// restricting to http/https matches the realistic use and closes the
// scheme-smuggling hole.
function isAllowedTabUrl(url: string): boolean {
  return hasAllowedScheme(url, WEB_SCHEMES);
}

// Open a new tab on behalf of a script. Returns the assigned chrome
// tab id (or an error) and stores the originator mapping so close
// events can be routed back.
export async function openGmTab(
  payload: GmTabOpenPayload,
  originatorTabId: number,
): Promise<GmTabOpenResult> {
  if (!isAllowedTabUrl(payload.url)) {
    return { ok: false, error: `GM_openInTab: refusing non-http(s) URL ${payload.url}` };
  }
  // Stash the entry first so a close event arriving between
  // chrome.tabs.create resolving and the page receiving the reply
  // can still find the request. The originator can't have called
  // close() yet because it doesn't have the tabId yet, but the user
  // could theoretically close the new tab manually that fast.
  requestState.set(payload.requestId, {
    originatorTabId,
    tabId: null,
    closeRequested: false,
  });
  try {
    const created = await chrome.tabs.create({
      url: payload.url,
      active: payload.active,
      // Bias positioning: when `insert` is true, hint Chrome to place
      // the new tab next to the originator.
      ...(payload.insert ? { openerTabId: originatorTabId } : {}),
    });
    if (created.id == null) {
      requestState.delete(payload.requestId);
      return { ok: false, error: 'internal error: the tab opened but Chrome reported no id for it' };
    }
    const entry = requestState.get(payload.requestId);
    if (!entry) {
      // Request was already aborted; close the tab we just opened so
      // we don't leak it.
      try { await chrome.tabs.remove(created.id); } catch { /* gone */ }
      return {
        ok: false,
        error: 'internal error: the tab request was dropped before the tab opened',
      };
    }
    entry.tabId = created.id;
    tabIdToRequest.set(created.id, payload.requestId);
    if (entry.closeRequested) {
      // The page called close() before create resolved. Close
      // immediately — the onRemoved listener will then clear the
      // mapping and route the close event back to the originator.
      try { await chrome.tabs.remove(created.id); } catch { /* gone */ }
    }
    return { ok: true, tabId: created.id };
  } catch (err) {
    requestState.delete(payload.requestId);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Close a tab by requestId. Idempotent — close on a tab that's
// already gone is a no-op.
export async function closeGmTab(requestId: string): Promise<void> {
  const entry = requestState.get(requestId);
  if (!entry) return;
  if (entry.tabId == null) {
    // chrome.tabs.create hasn't resolved yet. Flag the entry; the
    // openGmTab path checks closeRequested after create resolves and
    // closes the just-opened tab. Avoids a "open-then-leak" when
    // close() fires faster than create.
    entry.closeRequested = true;
    return;
  }
  const tabId = entry.tabId;
  try { await chrome.tabs.remove(tabId); }
  catch { /* tab already gone; the onRemoved listener handles cleanup */ }
}

// Called by the SW's chrome.tabs.onRemoved listener. Returns the
// originator that needs notifying (or null if this wasn't a
// GM_openInTab-created tab). The caller is responsible for the
// actual sendMessage so this module stays independent of the broader
// message-routing surface.
export function takeRequestForClosedTab(tabId: number): {
  originatorTabId: number;
  requestId: string;
} | null {
  const requestId = tabIdToRequest.get(tabId);
  if (!requestId) return null;
  tabIdToRequest.delete(tabId);
  const entry = requestState.get(requestId);
  if (!entry) return null;
  requestState.delete(requestId);
  return { originatorTabId: entry.originatorTabId, requestId };
}

// Drop every entry pointing at this originator tab — used when a tab
// containing a userscript that opened other tabs is itself closed.
// The opened tabs stay open (matches TM/VM), but we can't route close
// notifications anywhere useful, so we shed the mapping. Returns the
// dropped requestIds for logging.
export function dropOriginator(originatorTabId: number): string[] {
  return dropEntriesForOriginator(requestState, originatorTabId, (entry) => {
    if (entry.tabId != null) tabIdToRequest.delete(entry.tabId);
  });
}
