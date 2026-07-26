# Installing From the Web (`.user.js` Link Capture)

Clicking a `.user.js` link on GreasyFork, GitHub, or anywhere else
should open a SourceMonkey install prompt. Chrome never does that on
its own, so the extension intercepts the navigation.

Implementation: [`src/install-capture.ts`](../src/install-capture.ts)
(service worker) + `src/install.html` / `src/install.ts` (the prompt).

## What Chrome does with a `.user.js` URL

- **Chrome ≤ 151** — the suffix is special-cased
  (`UserScript::IsURLUserScript`, "get downloaded instead of viewed").
  The navigation is forced into a download, and the download is handed
  to the extension installer, which converts it to an MV2 extension —
  a path that always fails now that MV2 is gone. The user sees a
  broken download plus an install error.
- **Chrome ≥ 152** — the special case was removed
  ([crrev 38b617ca](https://chromiumdash.appspot.com/commit/38b617ca5ade59243d01170a8f4a744692983f19),
  landed 2026-06-30). A `.user.js` URL becomes an ordinary resource:
  a `text/javascript` response renders as source text; an `attachment`
  response downloads as a plain file.

Neither version offers to install anything, so capture is needed
permanently — the Chrome 152 change only makes the *non-captured*
outcome benign instead of alarming.

## The capture

- `webNavigation.onBeforeNavigate`, filtered with
  `{ pathSuffix: '.user.js' }`, fires before the request goes out.
- Top-level navigations only (`frameId === 0`).
- The handler rewrites the tab with
  `chrome.tabs.update(tabId, { url: install.html?url=<clicked URL> })`.
- Scope is deliberately narrow — see `isUserJsUrl`:
  - http(s) only. `file://` scripts belong to the sources page, and
    capturing them would hijack a local dev file opened for reading.
  - the suffix must be on the *path*, so a page whose query string
    mentions a `.user.js` URL isn't captured.
  - the match is case-sensitive.

### Every matcher has to agree

One URL is examined by several separate mechanisms, and a disagreement
between them is a bug, not a nuance:

| Where | What it decides |
|-------|-----------------|
| `webNavigation` pre-filter `{ pathSuffix: '.user.js' }` | whether the SW is woken at all |
| `isUserJsUrl` | whether the tab is redirected to the prompt |
| DNR `regexFilter` | whether the response is rewritten |
| `isSingleFileInput` (`directories.ts`) | post-install: one script, or a directory to scan |

- All are **case-sensitive** and **path-anchored**. Chrome's own legacy
  check is case-*insensitive*, which is the temptation to match it —
  but a `FOO.USER.JS` that captured would then fail
  `isSingleFileInput` and register as a *directory source*.
- The DNR rule needs `isUrlFilterCaseSensitive: true` explicitly (DNR
  defaults to insensitive) and `^[^?]*` to keep the suffix on the path
  (`regexFilter` matches the whole URL).

### Why not a `declarativeNetRequest` redirect

- A DNR `redirect` to an extension page requires that page in
  `web_accessible_resources`, which exposes the extension ID to every
  site for fingerprinting.
- An extension-initiated navigation (`chrome.tabs.update`) has no such
  requirement, and the ID never leaves the extension.

## The download workaround (Chrome < 152 only)

- The service worker may be cold-starting when the navigation begins,
  so the response can beat our `tabs.update`. On Chrome ≤ 151 that
  means the legacy download path fires and the user gets the bogus
  install error.
- A DNR **session** rule rewrites the response `Content-Type` to
  `text/html` for main-frame `GET`s of `.user.js` URLs that answer
  with `*/javascript*` or `text/plain*`.
- `text/html` is exactly the MIME the legacy check exempted, so Chrome
  renders the response instead of downloading it.
- **Not registered on Chrome ≥ 152**: there the rule would turn a
  clean plain-text source view into garbled HTML.
- The rule is a safety net, never the mechanism. The capture works
  with the rule absent.

### Cost of the rewrite

- A rewritten response that actually reaches the renderer is
  HTML-parsed: whitespace collapses onto one run-on line,
  angle-bracketed text disappears, and an inline `<script>` in the
  file would run on the file's host origin.
- That only happens when the capture loses the cold-start race, which
  is the case the rule exists to keep from being *worse* (a failed
  download plus an install error).
- The install page's **View raw source** deliberately does not
  navigate into a rewritten response on these versions whenever it has
  a fetched copy to show instead — see below.
- The whole rule disappears on its own once Chrome 152 is the floor.
- Requires the `declarativeNetRequestWithHostAccess` permission. It
  adds no new install warning — the redirect-free variant rides on the
  `<all_urls>` host access the extension already holds.

## The install prompt (`install.html`)

- Fetches the script itself (`fetchHttpText`, so GitHub auth applies)
  and never executes it — the body is rendered as text through Prism.
- `normalizeSourceInput` runs first, so a `github.com/.../blob/...`
  URL is fetched and stored in its raw form.
- Shows name, version, description, author, namespace, homepage, size,
  and the source URL (percent-decoded for reading — see
  [names-and-paths.md](names-and-paths.md) — while every link and
  fetch keeps the encoded form), plus the headers that decide reach:
  **Runs on** (`@match` / `@include`), **Except on** (`@exclude`),
  **Permissions** (`@grant`), **Network access** (`@connect`),
  **Loads libraries** (`@require`), **Loads resources** (`@resource`).
- Actions:
  - **Install** → `addSource(url)`, then jumps to the new script's
    viewer. A web install is not a special kind of script: it lands in
    the http / github container source and picks up normal refresh and
    update behavior.
  - **Open script** / **Update now** replace Install when the URL is
    already installed (matched on the stored `relativePath`). The
    banner names both versions when they differ.
  - **View raw source** opens the unprocessed file in a **new tab**,
    leaving the prompt open behind it.
  - **Continue to page** appears instead of Install when the fetched
    file has no usable metadata block — see below.
  - **Cancel** goes back, or closes the tab (via `chrome.tabs.remove`,
    since Chrome refuses `window.close()` for a tab it didn't open by
    script) when the prompt was opened into a fresh one.

### When the URL isn't a script

- A file with no (or an unterminated) metadata block can't be
  installed: the prompt says so and hides Install, rather than letting
  `addSource` create an `invalid` row.
- Usually that means the URL is an ordinary **web page** whose path
  happens to end in `.user.js` — a forge's blob view, say. The capture
  runs before any response exists, so it can't apply the
  `mime != text/html` half of Chrome's own test the way the DNR rule
  can.
- **Continue to page** is the way out: it sets a bypass and loads the
  URL, so the capture doesn't pull the tab straight back. Without it
  the only escape would be turning the whole option off.
- GitHub blob URLs never reach this state — `normalizeSourceInput`
  rewrites them to their raw counterpart, so the prompt describes the
  real script. The flip side is that a captured GitHub blob URL can no
  longer be used to reach GitHub's own file page.

### How the raw view stays readable

The right way to show the file depends on what the browser would do
with the response:

- **Chrome ≥ 152** — a real navigation to the URL, with a one-shot
  capture bypass. The browser renders it as source text and the
  address bar keeps the true URL.
- **Chrome ≤ 151** — the copy the prompt already fetched, rendered on
  `raw.html`. Navigating for real would land on a response the
  download workaround has rewritten to `text/html`, which HTML-parses
  the script into a single unreadable line.
- **Fetch failed / still in flight** — navigate regardless of
  version. There's no copy to render locally, and a real navigation
  carries the cookies the extension's own fetch doesn't, so it doubles
  as the retry for an auth-gated URL. On Chrome ≤ 151 the browser then
  does whatever it does with the (possibly rewritten) response — the
  one case where the raw view can't promise a readable result.

### `raw.html` and the hand-off

- A one-`<pre>` page (`src/raw.html` + `src/raw.ts`) that sets its
  content with `textContent` — nothing in a fetched script is ever
  parsed as markup.
- Titled with the script's filename, so the tab is identifiable. That
  title is the reason this is a page and not a `text/plain` blob:
  a blob tab is labelled with its opaque `blob:` URL, and giving it a
  title would mean assembling HTML out of fetched script text on the
  extension's own origin.
- The script text travels in a `chrome.storage.session` row
  (`rawview:<uuid>`, see `src/raw-view.ts`) — far too big for a query
  param. `raw.html` reads it by `?key=`, and rejects any key that
  isn't one we minted, so a hand-edited URL can't dump an arbitrary
  session row into the page.
- The row is dropped when the prompt page goes away. The raw tab has
  rendered its copy by then; only a reload of that tab would notice,
  and it says so rather than showing a blank page.
- The tab is opened with `chrome.tabs.create`, **not** `window.open`:
  an extension page opened via `window.open` comes up without the
  `chrome.*` APIs, so `raw.html` would have no way to read its text.
## The bypass

- `chrome.storage.session` row `installBypass:<url>`, holding an
  expiry timestamp, TTL 30s. Used by the raw view whenever it
  navigates to the real URL.
- Written by the install page (extension pages are trusted contexts),
  read-and-cleared by the service worker — session storage rather than
  an in-memory set because the SW can restart in between.
- One-shot: a later visit to the same URL is captured normally again.
- Also used by **Continue to page**.
- A row written for a navigation that never happens (tab closed first)
  is only cleaned up by the next read of that same URL, so it can sit
  in session storage until the browser closes. It's one small row and
  session-scoped; there's no reaper.

## The option

- Options page: **Capture `.user.js` links**, on by default
  (`smCaptureUserJsLinks` in `chrome.storage.local`; absent means on).
- Turning it off removes the DNR rule too — the user asked for stock
  browser behavior, and on Chrome ≤ 151 that includes the download.
- The service worker keeps an in-memory mirror of the flag, refreshed
  by a `storage.onChanged` listener, so the navigation handler never
  awaits storage on its sync fast path.
- The mirror starts at the default (on). An MV3 worker is woken *by*
  the navigation event, so the first navigation after a wake can beat
  the initial read — the handler awaits the settled flag on its async
  side and re-checks before redirecting, rather than capturing for a
  user who turned capture off.

## Relationship to the deep link

- [`docs/deep-link.md`](deep-link.md) covers the other direction: a
  page that *wants* to hand SourceMonkey a URL links to the GitHub
  redirect stub with `?page=sources.html&add_source=…`.
- Capture needs no cooperation from the page at all, so the
  [GreasyFork installer userscript](../userscripts/installers/greasyfork-installer.md)
  is no longer required to install from GreasyFork. It remains useful
  for what capture can't do — starting from the script's *listing*
  page rather than its `.user.js` URL.

## Limitations / future work

- **`file://` URLs aren't captured.** Opening a local `.user.js`
  offers no install prompt; add it through the sources page.
- **Mixed-case suffixes are ignored** everywhere, by design — see
  "Every matcher has to agree" above.
- **A script installed as part of a directory / repo source isn't
  recognised as already installed.** The already-installed check
  matches on `relativePath`, which is repo-relative for those sources,
  so installing the same script by URL creates a second copy. That's
  the pre-existing shape of container dedup, not new here.
- **`Content-Disposition: attachment` responses** still download on
  every Chrome version when the capture loses the startup race; the
  DNR rule only rewrites `Content-Type`.
- **No `@version` comparison logic** beyond displaying both values on
  the already-installed banner — "Update now" always refetches.
- **Delete the DNR rule** once Chrome 152 is the supported floor
  (`needsDownloadWorkaround` and its unit tests go with it).
