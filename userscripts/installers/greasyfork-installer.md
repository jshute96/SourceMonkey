# GreasyFork: Install in SourceMonkey

> **Note:** SourceMonkey now captures `.user.js` link clicks directly
> (see [docs/install-capture.md](../../docs/install-capture.md)), so
> GreasyFork's own install button already lands on the install prompt.
> This userscript remains useful for starting from the script's listing
> page — the button is on the page, not on the `.user.js` URL.

## Summary

Adds an "Install in SourceMonkey" button next to GreasyFork's normal
"Install this script" button. Clicking it opens a SourceMonkey-hosted
redirect page with the script's `.user.js` URL as a query parameter;
the redirector forwards into the extension's sources page, which
auto-fills and submits its add-source form.

The userscript only handles the GreasyFork side. The redirector page
and the auto-fill behavior on `sources.html` both live inside the
SourceMonkey project.

## Visible changes

- A new green button labelled **Install in SourceMonkey** appears
  immediately to the right of GreasyFork's existing install button
  and its `?` help link.
- Clicking it opens a new tab at
  `https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md?page=sources.html&add_source=<encoded .user.js URL>`.

## Implementation

- The install button is `<a class="install-link" href="…Name.user.js">Install this script</a>`,
  followed by `<a class="install-help-link">?</a>`. We find
  `a.install-link`, take its `href` as the install URL, and insert a
  sibling `<a>` with the same `className` so it inherits GreasyFork's
  green-button styling.
- Our button is marked with `id="jshute-install-in-sourcemonkey"`
  so the MutationObserver detects existing insertion and skips
  duplicates.
- On click we open the SourceMonkey redirector via `window.open`.
  We can't navigate web pages directly to `chrome-extension://` URLs
  (Chrome blocks it even from a user gesture), so SourceMonkey hosts
  a redirect page that does the chrome-extension navigation from a
  page it controls.

### What we assume stays stable

- GreasyFork install button selector: `a.install-link` with the
  `.user.js` URL in its `href`.
- GreasyFork help-link sibling: `a.install-help-link` (optional —
  the button still inserts cleanly without it).
- SourceMonkey redirector URL and query-parameter contract:
  `…/redirect-page.md?page=<extension page>&add_source=<encoded URL>`.
  If SourceMonkey moves the redirector or renames the params,
  update `REDIRECT_URL` and the query-string construction in the
  script.
