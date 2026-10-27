// How one extension page opens another.
//
// Two of our pages are *named tabs*: Collections and Options each have
// at most one tab by default, and every link to them reuses it rather
// than stacking up copies. A viewer tab is not named — it is per-script,
// and having several open at once is the point.
//
// The rules this module exists to keep in one place:
//   - A link to a named page opens in a NEW tab, never in the tab the
//     user is reading. Leaving the viewer to look at a collection and
//     losing the viewer is the behaviour this replaces.
//   - "New tab" means the named one where there already is one: focus
//     it and tell it where to scroll, instead of opening a second.
//   - A modified click (Ctrl/Cmd/Shift/middle) is the user overriding
//     us, and is left to the browser — which is why every one of these
//     links is a real anchor with a real `href`. The header bar's
//     buttons can't leave it to the browser, so `wireOpenButton` does
//     what the browser would.
//
// Usable from an extension page and from the service worker: both can
// call `chrome.tabs` and `chrome.runtime.getContexts`, and the worker
// passes the window it wants explicitly (see `openCollectionsPage` in
// src/extension/background.ts).

// What the header bar's Help button opens: the README, on the repo's
// GitHub page, which scrolls to it with no file tree beside it.
export const HELP_URL = 'https://github.com/jshute96/SourceMonkey#readme';

// The pages that get at most one tab.
export type NamedPage = 'collections' | 'options';

const PAGE_FILES: Record<NamedPage, string> = {
  collections: 'collections.html',
  options: 'options.html',
};

// Sent to a named tab that was reused rather than opened. A tab that is
// already loaded does not act on a fragment we write into its URL, so
// the scroll has to be asked for directly.
export const NAMED_TAB_FOCUS_MESSAGE = 'sm:named-tab-focus';

export interface NamedTabFocusMessage {
  type: typeof NAMED_TAB_FOCUS_MESSAGE;
  page: NamedPage;
  // The fragment to land on, WITHOUT the leading `#`. Empty means the
  // top of the page.
  hash: string;
}

export interface OpenNamedTabOptions {
  // Fragment to land on, without the leading `#`.
  hash?: string;
  // Which window to prefer and, failing that, to open in. Omit on a
  // page to use the page's own window; the worker passes the window the
  // click came from.
  windowId?: number | null;
  // Refuse to reuse a tab in another window, opening a new one instead.
  // The toolbar button wants this: focusing a window on another virtual
  // desktop can look like the click did nothing (see background.ts).
  sameWindowOnly?: boolean;
  // Leave a reused tab scrolled where the user left it. For a gesture
  // that means "show me that window" rather than "take me to this" —
  // the toolbar button — yanking the page back to the top would lose
  // the place they were reading. Ignored when `hash` is set: a link to
  // a collection is asking to be taken there.
  preserveScroll?: boolean;
}

// The page-relative URL of a named page, for an anchor's `href`. Every
// extension page lives at the extension root, so the browser resolves
// it against the current page and the `chrome-extension://<id>/` prefix
// stays out of the markup.
export function namedPageUrl(page: NamedPage, hash?: string): string {
  return hash ? `${PAGE_FILES[page]}#${hash}` : PAGE_FILES[page];
}

// Focus the named tab for `page` — reusing the open one where there is
// one — and land it on `hash`.
export async function openNamedTab(page: NamedPage, opts: OpenNamedTabOptions = {}): Promise<void> {
  const hash = opts.hash ?? '';
  const url = chrome.runtime.getURL(namedPageUrl(page, hash));
  const windowId = opts.windowId !== undefined ? opts.windowId : await currentWindowId();
  const existing = await findNamedTab(page, windowId, opts.sameWindowOnly === true);
  if (!existing) {
    await chrome.tabs.create(windowId == null ? { url } : { url, windowId });
    return;
  }
  await chrome.tabs.update(existing.tabId, { active: true });
  // Only when it is somewhere else: the current window is already
  // focused, and asking again is a no-op at best.
  if (existing.windowId != null && existing.windowId !== windowId) {
    try {
      await chrome.windows.update(existing.windowId, { focused: true });
    } catch {
      // A window that closed between the lookup and here. The tab
      // activation above is the part that mattered.
    }
  }
  if (hash || !opts.preserveScroll) await notifyNamedTabFocus(page, hash);
}

interface FoundTab {
  tabId: number;
  windowId: number | undefined;
}

// The open tab showing `page`, preferring one in `windowId`.
//
// getContexts, not tabs.query({url}): filtering a query by URL needs
// permission for that URL, and `<all_urls>` does not cover the
// `chrome-extension:` scheme — the query comes back empty for our own
// pages and we'd open a duplicate tab every time. getContexts needs no
// permission and reports tabId/windowId directly. It only sees loaded
// contexts, so a named tab still navigating is missed; the cost of that
// is one extra tab.
async function findNamedTab(
  page: NamedPage,
  windowId: number | null,
  sameWindowOnly: boolean,
): Promise<FoundTab | null> {
  const base = chrome.runtime.getURL(PAGE_FILES[page]);
  let contexts: chrome.runtime.ExtensionContext[];
  try {
    contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
  } catch {
    // Nothing to reuse that we can prove; opening a tab is the safe
    // failure.
    return null;
  }
  const matches = contexts.filter((ctx) => (
    ctx.tabId != null && ctx.tabId >= 0
    && typeof ctx.documentUrl === 'string' && isPageUrl(ctx.documentUrl, base)
  ));
  const here = windowId == null ? undefined : matches.find((ctx) => ctx.windowId === windowId);
  const pick = here ?? (sameWindowOnly ? undefined : matches[0]);
  return pick ? { tabId: pick.tabId, windowId: pick.windowId } : null;
}

// Whether a document URL is this page, with or without a query string
// and a fragment — `?first_run=1` and `#collection-…` variants are the
// same tab. The delimiter check is what keeps a prefix match from
// claiming a future `collections-archive.html`.
function isPageUrl(documentUrl: string, base: string): boolean {
  if (!documentUrl.startsWith(base)) return false;
  const rest = documentUrl.slice(base.length);
  return rest === '' || rest.startsWith('?') || rest.startsWith('#');
}

// This page's window, so a link prefers the named tab the user can
// already see. Null in the worker, and on any page Chrome won't name a
// tab for.
async function currentWindowId(): Promise<number | null> {
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab?.windowId ?? null;
  } catch {
    return null;
  }
}

// Tell the reused tab where to go. Broadcast rather than addressed at
// the tab: a page cannot name itself as a message target, and the only
// listeners are the named pages themselves — where a second Collections
// tab exists, both scrolling to the same collection is the harmless
// answer.
async function notifyNamedTabFocus(page: NamedPage, hash: string): Promise<void> {
  const message: NamedTabFocusMessage = { type: NAMED_TAB_FOCUS_MESSAGE, page, hash };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No listener answered — the tab is mid-load and will read the
    // fragment out of its own URL instead. Not worth reporting.
  }
}

// Register a named page's handler for "you were reused; go here". The
// argument is the fragment without its `#`, empty for the top.
export function onNamedTabFocus(page: NamedPage, handler: (hash: string) => void): void {
  chrome.runtime.onMessage.addListener((message) => {
    const msg = message as Partial<NamedTabFocusMessage> | null;
    if (!msg || msg.type !== NAMED_TAB_FOCUS_MESSAGE || msg.page !== page) return undefined;
    handler(typeof msg.hash === 'string' ? msg.hash : '');
    // No reply, and no `true`: holding the channel open for an answer
    // we never send makes the sender wait for the timeout.
    return undefined;
  });
}

// Turn an anchor into a link to a named page: a real href (so the
// browser's own open-in-new-tab gestures work and the URL is
// copyable), and a plain left click routed through `openNamedTab`.
export function wireNamedTabLink(a: HTMLAnchorElement, page: NamedPage, hash?: string): void {
  a.href = namedPageUrl(page, hash);
  // The href alone would open a new tab; the handler below is what
  // makes it the NAMED one. `target` is what a modified click and a
  // pre-script click both fall back to.
  a.target = '_blank';
  a.rel = 'noopener';
  a.addEventListener('click', (ev) => {
    if (!isPlainClick(ev)) return;
    ev.preventDefault();
    void openNamedTab(page, { hash });
  });
}

// The header bar's product name and icon, on every page that is not the
// collections page, are a link home. One delegated listener rather than
// per-element wiring: the viewer repaints its heading (and the link
// inside it) on every in-place navigation.
export function installHomeLinkHandler(): void {
  document.addEventListener('click', (ev) => {
    if (!isPlainClick(ev)) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('a.page-home')) return;
    ev.preventDefault();
    void openNamedTab('collections');
  });
}

// A click we are allowed to reinterpret: primary button, no modifier.
// Anything else is the user asking the browser for a new tab, a new
// window, or a download, and the anchor's own href serves that.
function isPlainClick(ev: MouseEvent): boolean {
  return !ev.defaultPrevented && ev.button === 0
    && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
}

// Open an extension page in a plain new tab — no reuse, because the
// destination is per-script (a viewer or an install preview) and two of
// them is a normal thing to want.
//
// Returns the promise rather than dropping it: an unhandled rejection
// in an extension page is reported into chrome://extensions/?errors,
// where it reads as SourceMonkey being broken.
export function openExtensionTab(url: string): Promise<void> {
  return chrome.tabs.create({ url }).then(() => undefined);
}

// Open an extension page in a new background tab, as a middle click or
// Ctrl/Cmd-click on a link does.
export function openBackgroundTab(url: string): Promise<void> {
  return chrome.tabs.create({ url, active: false }).then(() => undefined);
}

// Open an extension page in a new window, as a Shift-click on a link
// does.
export function openExtensionWindow(url: string): Promise<void> {
  return chrome.windows.create({ url }).then(() => undefined);
}

// How a click asks for a page to open, after the browser's gestures for
// a link:
// - plain: a left click with no modifier;
// - background: a middle or Ctrl/Cmd click, for a background tab;
// - tab: Shift with either of those, for a new tab in front;
// - window: Shift alone, for a new window.
// Alt, and any other button, are left to the browser (null).
export type OpenHow = 'plain' | 'background' | 'tab' | 'window';

export function openHow(ev: MouseEvent): OpenHow | null {
  if (ev.altKey) return null;
  if (ev.button === 1 || (ev.button === 0 && (ev.ctrlKey || ev.metaKey))) {
    return ev.shiftKey ? 'tab' : 'background';
  }
  if (ev.button !== 0) return null;
  return ev.shiftKey ? 'window' : 'plain';
}

// Wire a header button that opens a page to the link gestures above: a
// plain click runs `openPlain`, a new tab opens right of this page's
// tab, as a link's would, and Shift opens a new window. The middle
// button fires `auxclick`, not `click`. For extension pages only:
// `chrome.tabs.getCurrent` has no tab to give the worker.
export function wireOpenButton(btn: HTMLElement, url: string, openPlain: () => Promise<unknown>): void {
  const handle = (ev: MouseEvent): void => {
    const how = openHow(ev);
    if (!how) return;
    ev.preventDefault();
    const opening = how === 'plain' ? openPlain()
      : how === 'window' ? openExtensionWindow(url)
      : openTabBeside(url, how === 'tab');
    // Caught: see `openExtensionTab`.
    opening.catch((err) => console.info('[SourceMonkey] could not open', url, err));
  };
  btn.addEventListener('click', handle);
  btn.addEventListener('auxclick', handle);
  // Where middle-click autoscroll is on (Windows), it starts on the
  // press, too early for the `auxclick` above to stop it.
  btn.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
}

// Open `url` in a new tab right after this page's tab, where Chrome
// puts a tab opened from a link. `chrome.tabs.create` alone would put
// it at the end of the window.
export async function openTabBeside(url: string, active = true): Promise<void> {
  const here = await chrome.tabs.getCurrent();
  await chrome.tabs.create(here
    ? { url, active, windowId: here.windowId, index: here.index + 1, openerTabId: here.id }
    : { url, active });
}
