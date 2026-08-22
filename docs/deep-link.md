# Deep Linking Into the Extension

## Problem

- Web pages cannot link directly to `chrome-extension://<id>/...`
  URLs. Chrome blocks the scheme outside extension contexts.
- The extension's ID differs between unpacked installs and Web Store
  installs, so no fixed URL can be baked into external pages.
- We still want one-click flows from the web into specific extension
  pages — "open the collections page", "add this collection", "view this
  script".

## Not to be confused with `.user.js` link capture

- This doc covers pages that *cooperate* — they link at our redirect
  stub with the params we define.
- Clicking a plain `.user.js` link needs no cooperation and is handled
  separately, by intercepting the navigation. See
  [install-capture.md](install-capture.md).

## Approach

- Publish a stub markdown file in this repo:
  [`docs/redirect-page.md`](redirect-page.md).
- External links target that file's GitHub blob URL, with a `page`
  query parameter naming the extension page to open.
- The extension watches every navigation. When the URL matches the
  stub, the service worker rewrites the tab to the corresponding
  `chrome-extension://...` page.
- If the extension is not installed, the browser just renders the
  markdown — which doubles as the "install me" landing page.

## Why `chrome.webNavigation` (and not `declarativeNetRequest`)

- DNR's redirect actions are mutually exclusive: `extensionPath`
  avoids hardcoding the extension ID but drops the query string,
  while `regexSubstitution` / `transform` preserve everything but
  require the ID to be baked into the rule.
- We need both: no hardcoded ID *and* arbitrary passthrough params
  (e.g. `add=<url>`).
- `webNavigation.onBeforeNavigate` gives the service worker the full
  collection URL as a string, so it can parse the query in JS and call
  `chrome.tabs.update(tabId, { url: chrome.runtime.getURL(page) + '?' + rest })`.
- `onBeforeNavigate` fires *before* Chrome issues the network
  request, but the SW may be cold-starting in MV3, so a very fast
  response could theoretically commit first. For a markdown blob
  served by GitHub this is imperceptible in practice.

## URL contract

- Collection URL prefix:
  `https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md`
- Required query parameter: `page=<name>` where `<name>` is on the
  allowlist below.
- All other query parameters are forwarded verbatim to the extension
  page, with two stripped: `page` (consumed here) and `captured` (see
  below).
- Anything that fails the match (wrong URL, missing or disallowed
  `page`) short-circuits — the listener does nothing and the browser
  shows the GitHub doc as the fallback.

## Allowlist of `page` values

| `page=` | Target | Recognised forwarded params |
|---------|--------|-----------------------------|
| `collections.html` | Collections page | `refresh`, `refresh_local`, `refresh_file=<path>`, `add=<path-or-url>` (a single `.user.js` hands off to the viewer's preview — see [script-viewer.md](script-viewer.md#preview-mode)) |
| `options.html` | Options page | — |
| `userscript.html` | Script viewer | `script=<id>`, `preview=<url>` (`captured` is stripped — see Security) |

- Adding a new entrypoint means:
  - Add the page filename to `ALLOWED_PAGES` in `src/deep-link.ts`.
  - Document the new params in this file and in
    [`redirect-page.md`](redirect-page.md).

## Implementation

- All logic lives in `src/deep-link.ts`:
  - `buildDeepLinkTarget(srcUrl)` — pure URL→URL mapping, returns
    `null` when the URL is not a deep link. Unit-testable.
  - `installDeepLinkRedirect()` — wires the
    `webNavigation.onBeforeNavigate` listener (with a `urlPrefix`
    pre-filter for cheapness) and calls `chrome.tabs.update`.
- The install function is invoked from `src/background.ts` next to
  the other navigation listeners.
- `chrome.runtime.getURL(...)` builds the final target so the same
  code works for both unpacked (key-pinned) and Web Store IDs.

## Security notes

- The `page` allowlist is enforced in JS; the listener will never
  open an arbitrary path inside the extension just because a URL
  asked for it.
- Other query parameters pass through unfiltered. Each extension
  page is responsible for validating its own parameters (e.g. an
  eventual `add` handler must not blindly trust the value).
- **`captured` is the exception, and is stripped by name.** It tells
  the viewer that the `.user.js` capture opened the preview, which
  licenses the page to navigate the tab away on its own (and write a
  capture bypass) when the URL turns out to be a web page. That is the
  service worker's claim to make, and this redirect is the only place a
  web page could forge it. Full flow:
  [install-capture.md](install-capture.md#the-captured1-marker).
- The redirect only fires on top-level navigations (`frameId === 0`),
  so embedding the stub URL in an iframe will not trigger it.
- **A deep link can name a URL for the viewer to fetch and display.**
  `preview=<url>` makes the extension fetch that URL and render it —
  including a `file://` path, and including a github URL, where
  `fetchHttpText` attaches the user's stored PAT. Nothing is installed
  and the linking page can't read what came back, but a crafted link
  can put a private-repo file on screen. This is the same class of
  reach `add=` has always had (which went further and *added*
  the collection); routing single scripts through the preview means the
  user now sees and confirms what arrived.
- **Privacy: passthrough params reach GitHub when the extension is
  not installed.** A user clicking
  `…/redirect-page.md?page=collections.html&add=https://corp/internal.user.js`
  without SourceMonkey installed loads the URL on GitHub normally,
  and the full query string (including `add=…`) appears in
  GitHub's request logs and any `Referer` chain from there. Anyone
  authoring these links should treat passthrough params as
  potentially visible to GitHub.
