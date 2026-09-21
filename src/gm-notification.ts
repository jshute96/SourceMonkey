// SW-side `GM_notification` dispatcher.
//
// chrome.notifications wrapping. The page sends a details object
// describing the notification; we call chrome.notifications.create
// and remember the (chromeNotificationId ↔ originator + requestId)
// mapping so onClicked / onClosed can be routed back.
//
// chrome.notifications has its own assigned-id mechanism (we can
// pass an explicit notificationId or "" to have Chrome assign one).
// We always let Chrome assign — keeps our requestId space cleanly
// page-side and avoids collisions between userscripts.

import { dropEntriesForOriginator } from './gm-originator-map.js';
import { hasAllowedScheme, WEB_SCHEMES } from './gm-url-scheme.js';

export interface GmNotificationDetails {
  text: string;
  title: string;
  image: string;
  timeout: number;
  silent: boolean;
  tag: string;
}

export interface GmNotificationShowPayload {
  scriptId: string;
  requestId: string;
  details: GmNotificationDetails;
}

export interface GmNotificationShowResult {
  ok: boolean;
  notificationId?: string;
  error?: string;
}

interface NotificationEntry {
  originatorTabId: number;
  requestId: string;
  // Which userscript called GM_notification. Kept so the SW can stamp
  // click / close events with that script's execution world — see
  // `pushWorld` in background.ts.
  scriptId: string;
  // Auto-close timer set when details.timeout > 0. Cleared on closed
  // event so we don't fire chrome.notifications.clear on an already-
  // gone notification.
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

const byChromeId = new Map<string, NotificationEntry>();

// One string for the two guards that check the same thing: this one and
// `handleNotificationShow` in `background.ts`, which rejects before it
// ever calls in here. Names the browser permission the reader would go
// looking for rather than the API object we happened to test.
export const NOTIFICATIONS_UNAVAILABLE =
  'this browser will not show notifications to SourceMonkey — check the extension\'s notification permission';

// Page-supplied notification image. Chrome fetches `iconUrl` from the
// privileged extension context, so we only honor http(s) / data: URLs.
// A `file://` or `chrome-extension://` image would let a script probe
// local files / packaged resources through the extension; reject those
// and fall back to the default icon.
function isAllowedIconUrl(image: string): boolean {
  return hasAllowedScheme(image, [...WEB_SCHEMES, 'data:']);
}

// Pick the icon URL chrome.notifications wants. The user-supplied
// image is preferred when it's an allowed scheme; otherwise we fall
// back to the extension's own icon so chrome.notifications doesn't
// reject the create call (iconUrl is required by the API).
function pickIconUrl(image: string): string {
  if (image && isAllowedIconUrl(image)) return image;
  try { return chrome.runtime.getURL('icons/icon-128.png'); }
  catch { return ''; }
}

export async function showGmNotification(
  payload: GmNotificationShowPayload,
  originatorTabId: number,
): Promise<GmNotificationShowResult> {
  // Defense in depth — handleNotificationShow already guards this,
  // but a future direct caller (test surface, retry path) shouldn't
  // crash if the API is missing.
  if (!chrome.notifications) {
    return { ok: false, error: NOTIFICATIONS_UNAVAILABLE };
  }
  const d = payload.details;
  const options: chrome.notifications.NotificationOptions<true> = {
    type: 'basic',
    iconUrl: pickIconUrl(d.image),
    title: d.title || 'SourceMonkey',
    message: d.text,
    silent: d.silent,
  };
  try {
    // The installed @types/chrome declares the callback form only,
    // but chrome.notifications.create is Promise-returning in MV3.
    // Wrap to avoid the type mismatch and stay forward-compatible.
    const chromeId = await new Promise<string>((res, rej) => {
      try {
        chrome.notifications.create('', options, (id) => {
          if (chrome.runtime.lastError) {
            rej(new Error(chrome.runtime.lastError.message ?? 'notifications.create failed'));
            return;
          }
          res(id);
        });
      } catch (e) { rej(e); }
    });
    const entry: NotificationEntry = {
      originatorTabId,
      requestId: payload.requestId,
      scriptId: payload.scriptId,
      timeoutTimer: null,
    };
    if (d.timeout > 0) {
      entry.timeoutTimer = setTimeout(() => {
        // chrome.notifications.clear fires its callback synchronously
        // for our purposes; the onClosed listener will then dispatch
        // the page-side ondone via the normal path.
        try { chrome.notifications.clear(chromeId); } catch { /* gone */ }
      }, d.timeout);
    }
    byChromeId.set(chromeId, entry);
    return { ok: true, notificationId: chromeId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Called by the SW's chrome.notifications.onClicked listener.
export function takeForClicked(chromeId: string): {
  originatorTabId: number;
  requestId: string;
  // See takeRequestForClosedTab in gm-tab.ts — the SW stamps the
  // event with the owning script's execution world.
  scriptId: string;
} | null {
  const entry = byChromeId.get(chromeId);
  if (!entry) return null;
  // Don't delete the entry on click — TM's `onclick` is NOT terminal.
  // The user may click then the notification auto-closes (or stays
  // open until they dismiss); we still want to deliver ondone later.
  return {
    originatorTabId: entry.originatorTabId,
    requestId: entry.requestId,
    scriptId: entry.scriptId,
  };
}

// Called by the SW's chrome.notifications.onClosed listener.
// Terminal — we free the entry.
export function takeForClosed(chromeId: string): {
  originatorTabId: number;
  requestId: string;
  scriptId: string;
} | null {
  const entry = byChromeId.get(chromeId);
  if (!entry) return null;
  if (entry.timeoutTimer != null) clearTimeout(entry.timeoutTimer);
  byChromeId.delete(chromeId);
  return {
    originatorTabId: entry.originatorTabId,
    requestId: entry.requestId,
    scriptId: entry.scriptId,
  };
}

// Drop every entry whose originator tab just closed. Best-effort
// matches GM_openInTab's dropOriginator. The chrome notifications
// themselves stay on screen — chrome.notifications survive tab close
// (they're per-extension, not per-tab) — but with the originator
// gone we have nobody to route the eventual events to.
export function dropOriginator(originatorTabId: number): string[] {
  return dropEntriesForOriginator(byChromeId, originatorTabId, (entry) => {
    if (entry.timeoutTimer != null) clearTimeout(entry.timeoutTimer);
  });
}
