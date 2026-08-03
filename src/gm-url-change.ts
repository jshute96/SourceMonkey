// SW-side driver for `@grant window.onurlchange`.
//
// Why the service worker is involved at all: a USER_SCRIPT-world
// script does NOT share `window.history` with the page. Patching
// `history.pushState` from the isolated world produces a patched
// function only isolated-world code ever calls — the page's own SPA
// router keeps calling the real one, unobserved. The isolated world
// does receive `popstate` / `hashchange`, but those cover only part of
// the surface and overlap the events below, so this module is the
// single source rather than one of two.
//
// `chrome.webNavigation` reports the whole surface:
//
//   - `onHistoryStateUpdated`      — pushState / replaceState and
//                                    same-document traversals
//   - `onReferenceFragmentUpdated` — fragment-only changes
//
// These two are *also* what Tampermonkey feeds its own `urlchange`
// from (verified in TM 5.5.0's `background.js`), which is why our
// firing rules match theirs for free: nothing on initial load,
// nothing on a cross-document navigation, one event per reported
// history update — including a same-URL `replaceState`, which TM does
// not suppress. The `webNavigation` permission is already in the
// manifest and `background.ts` already subscribes to
// `onHistoryStateUpdated` for tab status, so this costs no new
// privilege.
//
// The alternative — registering a MAIN-world helper that patches the
// page's `history` and postMessages across — was rejected: it
// pollutes every page's globals with a wrapper the page can see,
// unpatch, or use to forge events, for a signal Chrome already hands
// us for free.
//
// Wire protocol:
//   SW → page: `{ type: 'sm:url-change', url }` via
//   `chrome.tabs.sendMessage(tabId, msg, { frameId })`. The URL is
//   replayed verbatim to the userscript, so a burst of history
//   updates produces one event each rather than a coalesced one.
//
// No gating: we notify on every reported update rather than tracking
// which tabs have a granting script. A stateful gate would have to
// survive SW restarts (chrome.userScripts registrations do; SW memory
// doesn't), and getting that wrong fails silently. The message is
// cheap — the SW is already awake handling this exact event for tab
// status — and a frame with no SourceMonkey runtime just rejects the
// send, which we swallow.

export const SM_URL_CHANGE_MSG = 'sm:url-change';

// The subset of `chrome.webNavigation.onHistoryStateUpdated` details
// we need. Declared structurally so unit tests can drive it without
// building a full chrome.webNavigation event object.
export interface UrlChangeDetails {
  tabId: number;
  frameId: number;
  url: string;
}

// Pure: should this history update be forwarded to a frame?
//
// Chrome reports events for pre-render / devtools targets with a
// negative `tabId`, which `chrome.tabs.sendMessage` can't address. A
// URL-less event has nothing worth reporting. Everything else — every
// scheme, every frame depth — is forwarded; SourceMonkey injects into
// `file://` pages too, and iframes get their own runtime instance.
export function shouldNotifyUrlChange(details: UrlChangeDetails): boolean {
  if (typeof details.tabId !== 'number' || details.tabId < 0) return false;
  if (typeof details.frameId !== 'number' || details.frameId < 0) return false;
  return typeof details.url === 'string' && details.url !== '';
}

// Fire-and-forget notification to the frame that changed. Rejections
// are expected and swallowed: pages with no active SourceMonkey script
// have no `__SM_GM__` runtime registered, so there is no receiving end.
export function notifyUrlChange(details: UrlChangeDetails): void {
  if (!shouldNotifyUrlChange(details)) return;
  void chrome.tabs
    .sendMessage(
      details.tabId,
      { type: SM_URL_CHANGE_MSG, url: details.url },
      { frameId: details.frameId },
    )
    .catch(() => undefined);
}

// Subscribe to both same-document navigation events. Called once from
// `installNavigationListeners` in background.ts.
//
// This registers its own listeners rather than piggy-backing on the
// tab-status `onHistoryStateUpdated` listener already in background.ts:
// that one filters to the main frame, and a userscript inside an
// iframe wants its own frame's navigations too.
export function installUrlChangeWatch(): void {
  const wn = chrome.webNavigation;
  if (!wn?.onHistoryStateUpdated || !wn?.onReferenceFragmentUpdated) {
    // Matches what TM logs in the same situation. `console.info`, not
    // `.warn` — see the logging policy in CLAUDE.md.
    console.info(
      '[SourceMonkey] chrome.webNavigation same-document events unavailable; window.onurlchange will not fire',
    );
    return;
  }
  wn.onHistoryStateUpdated.addListener((d) => notifyUrlChange(d));
  wn.onReferenceFragmentUpdated.addListener((d) => notifyUrlChange(d));
}
