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
  // Auto-close timer set when details.timeout > 0. Cleared on closed
  // event so we don't fire chrome.notifications.clear on an already-
  // gone notification.
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

const byChromeId = new Map<string, NotificationEntry>();

// Pick the icon URL chrome.notifications wants. The user-supplied
// image is preferred; we fall back to the extension's own icon so
// chrome.notifications doesn't reject the create call (iconUrl is
// required by the API). Extension-relative URLs work via
// chrome.runtime.getURL.
function pickIconUrl(image: string): string {
  if (image) return image;
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
    return { ok: false, error: 'chrome.notifications unavailable' };
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
} | null {
  const entry = byChromeId.get(chromeId);
  if (!entry) return null;
  // Don't delete the entry on click — TM's `onclick` is NOT terminal.
  // The user may click then the notification auto-closes (or stays
  // open until they dismiss); we still want to deliver ondone later.
  return { originatorTabId: entry.originatorTabId, requestId: entry.requestId };
}

// Called by the SW's chrome.notifications.onClosed listener.
// Terminal — we free the entry.
export function takeForClosed(chromeId: string): {
  originatorTabId: number;
  requestId: string;
} | null {
  const entry = byChromeId.get(chromeId);
  if (!entry) return null;
  if (entry.timeoutTimer != null) clearTimeout(entry.timeoutTimer);
  byChromeId.delete(chromeId);
  return { originatorTabId: entry.originatorTabId, requestId: entry.requestId };
}

// Drop every entry whose originator tab just closed. Best-effort
// matches GM_openInTab's dropOriginator. The chrome notifications
// themselves stay on screen — chrome.notifications survive tab close
// (they're per-extension, not per-tab) — but with the originator
// gone we have nobody to route the eventual events to.
export function dropOriginator(originatorTabId: number): string[] {
  const dropped: string[] = [];
  for (const [chromeId, entry] of byChromeId) {
    if (entry.originatorTabId !== originatorTabId) continue;
    if (entry.timeoutTimer != null) clearTimeout(entry.timeoutTimer);
    byChromeId.delete(chromeId);
    dropped.push(chromeId);
  }
  return dropped;
}
