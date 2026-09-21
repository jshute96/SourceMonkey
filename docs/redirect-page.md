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
| `collections.html` | Collections page | `refresh`; `refresh_local`; `refresh_file=<path>`; `add=<url-or-path>` |
| `options.html` | Options page | — |
| `userscript.html` | Script viewer | `script=<id>`, `preview=<url>` |

Anything else is ignored — the redirect simply does not fire, and the
user sees this page.

## Example links

- Open the collections page:
  `…/redirect-page.md?page=collections.html`
- Open the collections page and trigger a refresh-all:
  `…/redirect-page.md?page=collections.html&refresh`
- Refresh only what lives on local disk — every local collection, or just
  the collections and scripts covering one file or directory:
  `…/redirect-page.md?page=collections.html&refresh_local`
  `…/redirect-page.md?page=collections.html&refresh_file=/home/me/scripts/a.user.js`
- Add a userscript or a collection (path or URL) on the collections page; the
  page validates the input, jumps to the new section on success, or
  jumps to the existing section if the collection is already registered:
  `…/redirect-page.md?page=collections.html&add=https://example.com/foo.user.js`
- Open the options (settings) page:
  `…/redirect-page.md?page=options.html`
- View a specific script:
  `…/redirect-page.md?page=userscript.html&script=<id>`

## Privacy note for link authors

Anything you put in the query string is visible to GitHub when the
visitor does not have SourceMonkey installed — the markdown page
loads normally and the full URL (including `add=…`) appears
in GitHub's request logs.

## Installing SourceMonkey

If you landed here without the extension installed, see the
[project README](https://github.com/jshute96/SourceMonkey#readme)
for install instructions, then revisit the original link.
