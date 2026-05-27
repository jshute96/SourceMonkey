# SourceMonkey Deep-Link Redirect

This page is the public "front door" that lets external sites link into
the SourceMonkey extension. Browsers do not let regular web pages link
directly to `chrome-extension://...` URLs, so SourceMonkey watches for
navigations to **this exact file** and rewrites the tab to the
extension page named in the `page` query parameter.

## How it works

- A link points at:
  `https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md?page=<extension-page>&<other-params>`
- If SourceMonkey is installed and enabled, the service worker
  intercepts the navigation and replaces the tab URL with:
  `chrome-extension://<id>/<extension-page>?<other-params>`
- The `page` parameter is stripped; every other parameter is passed
  through verbatim.
- If SourceMonkey is **not** installed, the browser just shows this
  document — which is the "install me" fallback.

## Allowed `page` values

| `page=` | Lands on | Useful params |
|---------|----------|---------------|
| `sources.html` | Sources page | `refresh`; `add_source=<url-or-path>` |
| `options.html` | Options page | — |
| `userscript.html` | Script viewer | `script=<id>` |

Anything else is ignored — the redirect simply does not fire, and the
user sees this page.

## Example links

- Open the sources page:
  `…/redirect-page.md?page=sources.html`
- Open the sources page and trigger a refresh-all:
  `…/redirect-page.md?page=sources.html&refresh`
- Add a userscript source (path or URL) to the sources page; the
  page validates the input, jumps to the new section on success, or
  jumps to the existing section if the source is already registered:
  `…/redirect-page.md?page=sources.html&add_source=https://example.com/foo.user.js`
- Open the options (settings) page:
  `…/redirect-page.md?page=options.html`
- View a specific script:
  `…/redirect-page.md?page=userscript.html&script=<id>`

## Privacy note for link authors

Anything you put in the query string is visible to GitHub when the
visitor does not have SourceMonkey installed — the markdown page
loads normally and the full URL (including `add_source=…`) appears
in GitHub's request logs.

## Installing SourceMonkey

If you landed here without the extension installed, see the
[project README](https://github.com/jshute96/SourceMonkey#readme)
for install instructions, then revisit the original link.
