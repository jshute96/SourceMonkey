// Lets external pages (anywhere on the web) "navigate into" the
// extension. Plain web pages can't link to chrome-extension:// URLs,
// so we publish a stub docs/redirect-page.md on GitHub, watch for
// navigations to it, and rewrite the tab to the requested extension
// page.
//
// Source URL:
//   https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md
//     ?page=<allowed>&<other-params>
// Target URL:
//   chrome-extension://<id>/<page>?<other-params>
//
// `page` is allowlisted. Anything else short-circuits and leaves the
// GitHub page alone — the doc itself explains how to install the
// extension, so a non-redirect outcome is the "no extension" fallback.
//
// chrome.runtime.getURL() builds the full chrome-extension:// URL at
// runtime, so this works whether the extension was loaded unpacked
// (ID pinned via manifest "key") or installed from the Web Store
// (different ID).

const REDIRECT_URL = 'https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md';

const ALLOWED_PAGES = new Set(['collections.html', 'options.html', 'userscript.html']);

// Pure: maps a source URL to its rewrite target, or null when the URL
// is not a deep link we should act on. Exported for unit tests.
export function buildDeepLinkTarget(srcUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(srcUrl);
  } catch {
    return null;
  }
  // Reject userinfo (user:pass@host) for defence in depth — origin
  // strips it, so the equality check would otherwise accept it.
  if (u.username !== '' || u.password !== '') return null;
  if (`${u.origin}${u.pathname}` !== REDIRECT_URL) return null;
  const page = u.searchParams.get('page');
  if (!page || !ALLOWED_PAGES.has(page)) return null;
  const passthrough = new URLSearchParams(u.searchParams);
  passthrough.delete('page');
  // Note: passthrough.toString() uses application/x-www-form-urlencoded
  // encoding (spaces → `+`, literal `+` → `%2B`). End-to-end loss-less
  // for consumers that decode via URLSearchParams; consumers that
  // hand-parse the query should be aware of this round-trip.
  const qs = passthrough.toString();
  return chrome.runtime.getURL(page) + (qs ? `?${qs}` : '');
}

export function installDeepLinkRedirect(): void {
  const wn = chrome.webNavigation;
  if (!wn) {
    console.info('[SourceMonkey] chrome.webNavigation not available; deep-link redirect disabled');
    return;
  }
  wn.onBeforeNavigate.addListener(
    (d) => {
      if (d.frameId !== 0) return;
      const target = buildDeepLinkTarget(d.url);
      if (!target) return;
      // Tab may have closed between the event firing and our update
      // landing; ignore the resulting rejection.
      chrome.tabs.update(d.tabId, { url: target }).catch(() => {});
    },
    // Cheap pre-filter so we don't run on every navigation. The
    // listener does the authoritative check; this just narrows the
    // event volume.
    { url: [{ urlPrefix: REDIRECT_URL }] },
  );
}
