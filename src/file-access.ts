// The "Allow access to file URLs" probe and the banner that explains a
// failed `file://` read, shared by every extension page that can hit
// one (collections page, script viewer / install preview).
//
// The toggle lives on `chrome://extensions` and is invisible from a
// fetch's point of view: with it off, reading a local file fails with
// the same opaque error a missing file produces (see
// [docs/file-access.md]). So a page that couldn't read a local file
// asks here whether the toggle is the reason, and shows a banner that
// names it and links to the page that fixes it.
//
// Page-only — `chrome.extension` is not exposed to the service worker.

// Whether the per-extension file-access toggle is on. Callback-style
// API, so it gets a promise wrapper.
//
// Never rejects. Callers use this to decide whether to *explain* a
// failure, and an explanation is not worth taking a page down for — a
// probe that throws (API renamed, unexpected context) reports "allowed"
// so the banner stays away and everything else renders as usual.
export function isFileSchemeAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed));
    } catch {
      resolve(true);
    }
  });
}

// The banner itself. `retry` completes "…turn it on, <retry>:" — what
// the user has to do to make the read actually happen again, which
// differs by caller: a page that reads on load wants a reload, while
// the viewer renders a stored row and doesn't re-read until Refresh.
export function renderFileAccessBanner(retry = 'then reload this page'): HTMLElement {
  const div = document.createElement('div');
  div.className = 'banner';

  const heading = document.createElement('strong');
  heading.textContent = 'File access is disabled.';
  div.appendChild(heading);

  const explain = document.createElement('p');
  explain.textContent =
    'SourceMonkey can\'t read local files until you enable ' +
    '"Allow access to file URLs". Open the extension\'s details page, ' +
    `turn it on, ${retry}:`;
  div.appendChild(explain);

  div.appendChild(extensionDetailsLink());

  return div;
}

// chrome:// URLs are blocked from <a href> navigation, so we use a
// click handler that calls chrome.tabs.create — that path is allowed
// from extension pages. Rendered as an <a> so it looks/behaves like
// any other link.
//
// Exported because the collections page's "Allow User Scripts" banner
// points at the same details page.
export function extensionDetailsLink(): HTMLElement {
  const url = `chrome://extensions/?id=${chrome.runtime.id}`;
  const a = document.createElement('a');
  a.href = url;
  a.textContent = url;
  a.className = 'chrome-link';
  a.addEventListener('click', (event) => {
    event.preventDefault();
    // Caught, not dropped: an unhandled rejection in an extension page
    // is filed under chrome://extensions/?errors, which is the panel
    // this banner is trying to send the user to — arriving there to
    // find SourceMonkey's own error would be its own kind of confusing.
    // A `chrome://` target has no realistic failure, so there is
    // nothing to say beyond leaving the link inert.
    chrome.tabs.create({ url }).catch(() => { /* nothing to fall back to */ });
  });
  return a;
}
