// Shared URL-scheme gate for the SW-side `GM_*` dispatchers.
//
// Every dispatcher that hands a page-supplied URL to a privileged
// Chrome API (`chrome.tabs.create`, `chrome.notifications.create`,
// `chrome.downloads.download`) has to answer the same question first:
// is this a scheme we're willing to act on? Without the gate a
// userscript could ask the extension to open, fetch, or save
// `file:///…`, `chrome://…`, or `chrome-extension://<id>/…` — reaching
// past what the page itself could do.
//
// The allowed set differs per API (tabs and downloads take http(s);
// notification icons also take `data:`), so the caller passes it in.
// Only the parse-and-compare is shared — that's the part that was
// previously copied three times and could drift.

// True iff `url` parses and its scheme is one of `allowed`.
// `allowed` entries include the trailing colon (`'http:'`), matching
// `URL.protocol`. Anything unparseable is refused.
export function hasAllowedScheme(url: string, allowed: readonly string[]): boolean {
  try {
    return allowed.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

// The common case: plain web URLs.
export const WEB_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:']);
