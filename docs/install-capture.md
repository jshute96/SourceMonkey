# Installing From a `.user.js` URL (Link Capture)

Opening a `.user.js` URL should land on a SourceMonkey preview of the
script, with an Install button — whether it came from GreasyFork,
GitHub, or a file on the user's own disk. Chrome never does that on its
own, so the extension intercepts the navigation.

Implementation:

- [`src/install-capture.ts`](../src/install-capture.ts) (service
  worker) hands the URL to the userscript viewer's **preview mode** —
  the prompt is not a separate page.
- See [script-viewer.md → Preview mode](script-viewer.md#preview-mode)
  for what it renders and which buttons appear when.

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

Both behaviors are scheme-independent: a `file://…/foo.user.js` opened
in a tab downloads on Chrome ≤ 151 too (verified on Chrome 148).

## The capture

- `webNavigation.onBeforeNavigate`, filtered with
  `{ pathSuffix: '.user.js' }`, fires before the request goes out.
- Top-level navigations only (`frameId === 0`).
- The handler rewrites the tab with
  `chrome.tabs.update(tabId, { url: userscript.html?preview=<clicked URL> })`.
- Scope is deliberately narrow — see `isUserJsUrl`:
  - `http:`, `https:`, and `file:` only. Other schemes aren't shapes
    `addCollection` can register, so a preview would have nothing to
    offer.
  - the suffix must be on the *path*, so a page whose query string
    mentions a `.user.js` URL isn't captured.
  - the match is case-sensitive.
  - known forge **page views** are excluded — see below.

### Forge page views are not captured

`https://github.com/<o>/<r>/blob/<ref>/foo.user.js` ends in the suffix
but serves an HTML page: GitHub's file browser, with highlighting and
navigation. Capturing it hijacks a page the user opened to *read*.

- Excluded hosts + path shapes (`CODE_HOST_PAGE_VIEWS`): github.com
  `/<o>/<r>/blob/`, gitlab.com `/-/blob/`, bitbucket.org and
  codeberg.org `/<o>/<r>/src/`. `www.` is stripped first.
- The **raw** URL for each of those (`raw.githubusercontent.com`,
  `/-/raw/`, `/raw/`) is still captured — that one really is the script,
  and really does dead-end in the browser.
- So is a blob URL carrying GitHub's own `?raw=true` switch. It 302s to
  the raw host, and `onBeforeNavigate` doesn't fire again for a server
  redirect, so skipping it would lose the capture rather than defer it.
  (`?plain=1` is not that switch — it's still the page.)
- Chrome renders these pages fine on its own, so unlike a raw
  `.user.js` there is no broken download to rescue. Not capturing is
  also what makes the behavior consistent: clicking a link *inside*
  GitHub is a same-page SPA navigation that never fires
  `onBeforeNavigate`, so it was never captured — only pasting the URL
  into the address bar was.
- Not a completeness claim, and it doesn't need to be. An unlisted
  forge's blob view is still captured, but the response then gives it
  away and the preview continues to the page by itself — see
  [below](#when-the-url-turns-out-to-be-a-web-page). The list only
  saves the round trip for the hosts worth knowing in advance.
- Installing from a blob URL still works: paste it into the collections
  page's Add field, which rewrites it to the raw URL
  (`normalizeCollectionInput`).

### Local files

- A `file://…/foo.user.js` navigation is captured exactly like a web
  one: same preview, same Install button.
- Adding one through the collections page previews it too — the Add
  field routes any single script to the same page.
- It depends on the per-extension **Allow access to file URLs** toggle.
  `webNavigation` delivery is gated on host access, so with the toggle
  off the event is expected never to arrive; if one somehow did, the
  preview's fetch would fail and say so. Either way the feature is
  absent rather than broken, and nothing tests for the toggle.
- The toggle-off case is **not** covered automatically: Chrome grants
  file access unconditionally to `--load-extension` builds (writing
  `allow_file_access: false` into Preferences does not override it), so
  the e2e suite only ever reaches the toggle-on case.

#### The cost, and what pays for it

- A local `.user.js` opened *to read* gets hijacked into a preview.
  That is a real regression for a script author editing their own file,
  and it is accepted rather than avoided.
- **Continue to file** (on the not-a-userscript banner) and **View raw
  source** both reach the file itself, through the same one-shot bypass
  the http path uses.
- The whole capture — local files included — is behind the
  `smCaptureUserJsLinks` option.

#### One file, one installed row

- The same file on disk has two spellings: the bare
  `/home/me/foo.user.js` the collections page's path field takes, and the
  `file:///home/me/foo.user.js` a capture arrives as. Left alone they
  would produce two installed rows.
- `canonicalCollectionInput` (`directories.ts`) picks the bare path as the
  one true spelling. It runs inside **`addCollection`**, so every entry
  point converges — the capture, the preview's Install, the collections
  page's field, and the `?add=` deep link.
- Reads canonicalize the *stored* value too (the preview's
  already-installed check, the container's duplicate check), so rows
  written before this existed still match.
- The preview's already-installed check compares the **absolute**
  location, so a copy inside a directory / repo collection counts too —
  see [script-identity.md](script-identity.md). Install is still
  offered in that case: a copy in someone else's collection is not a
  copy of your own.
- **Not applied** to Windows drive-letter (`file:///C:/…`) or UNC
  (`file://server/…`) URLs: the bare-path conversion drops the host and
  turns the drive letter into a path segment. Those keep the URL
  spelling. The rest of the path handling is POSIX-only anyway.
- The captured URL still travels verbatim in `?preview=` — a bypass has
  to be keyed on the URL the browser will actually navigate to.

### Every matcher has to agree

One URL is examined by several separate mechanisms, and a disagreement
between them is a bug, not a nuance:

| Where | What it decides |
|-------|-----------------|
| `webNavigation` pre-filter `{ pathSuffix: '.user.js' }` | whether the SW is woken at all |
| `isUserJsUrl` | whether the tab is redirected to the preview |
| DNR `regexFilter` | whether the response is rewritten |
| `isSingleFileInput` (`directories.ts`) | post-install: one script, or a directory to scan |

- All are **case-sensitive** and **path-anchored**. Chrome's own legacy
  check is case-*insensitive*, which is the temptation to match it —
  but a `FOO.USER.JS` that captured would then fail
  `isSingleFileInput` and register as a *directory collection*.
- The DNR rule needs `isUrlFilterCaseSensitive: true` explicitly (DNR
  defaults to insensitive) and `^[^?]*` to keep the suffix on the path
  (`regexFilter` matches the whole URL).
- The forge page-view exclusion needs no DNR clause: those URLs answer
  `text/html`, which the rule's content-type condition already skips.

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
- **Nothing to do for `file://`**: DNR only sees network requests, and
  a local file has no response headers to rewrite. A `file://` capture
  that loses the cold-start race just gets Chrome's own handling (a
  download, below 152).
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
- The preview's **View raw source** deliberately does not navigate
  into a rewritten response on these versions whenever it has a fetched
  copy to show instead — see below.
- The whole rule disappears on its own once Chrome 152 is the floor.
- Requires the `declarativeNetRequestWithHostAccess` permission. It
  adds no new install warning — the redirect-free variant rides on the
  `<all_urls>` host access the extension already holds.

## Where the capture lands

- The tab ends up on `userscript.html?preview=<clicked URL>` — the
  same viewer an installed script opens in, in preview mode.
- What it renders, and which of Install / Update / Continue appears
  when, is documented in
  [script-viewer.md → Preview mode](script-viewer.md#preview-mode).

Capture-specific points:

- The **clicked** URL is what travels in `?preview=`, not the
  normalized one — a bypass has to be keyed on the URL the browser
  will actually navigate to.
- **Cancel** goes back to the referring page. The captured navigation
  never committed, so the previous history entry is still that page.
- A tab opened straight into the preview (a site's `target=_blank`
  install button) has no history to go back to, so Cancel closes it.
- **The preview fetches the script's `@require` / `@resource` files.**
  It compiles the script to catch syntax errors before the install (see
  [parse-check.md](parse-check.md)), and that needs the composed
  program.
  - So a captured click — including opening a local `.user.js` you only
    meant to read — issues requests to every host those tags name,
    before the user has decided anything.
  - Those requests carry the stored GitHub token when the URL is a
    GitHub one (`githubAuthHeaders`, `file-loader.ts`), same as an
    installed script's fetches do.
  - Nothing is stored, and nothing runs.

### When the URL turns out to be a web page

The host list above is a guess made *before* the request. Once the
response is in hand there is a real answer, and it costs nothing:

- The script fetchers reject a markup response outright —
  `Content-Type: text/html`, or a body that starts with `<`. See
  [requires.md → Markup gate](requires.md#markup-gate) for the two
  tests and why the body one keys on position.
- For a **captured** navigation the preview then continues to the page
  on its own: bypass, navigate, no banner. The capture was our guess
  that the URL was a script; being wrong means getting out of the way,
  not opening a dialog about it.
- A preview the **user** asked for (the collections page's Add field)
  never navigates itself. That is a question we owe an answer to, so it
  reports the problem and offers **Continue to page** instead.
- This is what covers a forge that isn't on the host list: one wasted
  fetch, then the user lands where they were going.

#### The `captured=1` marker

The preview page is reached two ways, and once you are on it they look
the same:

```
you clicked a .user.js link, and we redirected the tab
  → userscript.html?preview=https://x.test/a.user.js&captured=1

you typed that URL into the collections page's Add field
  → userscript.html?preview=https://x.test/a.user.js
```

Only the first has `captured=1`. It means *the extension opened this
preview on its own initiative* — nothing about the script.

That one bit decides what happens when the fetch comes back as a web
page rather than a script:

- **With it**, the page navigates the tab to the URL and disappears. We
  interrupted a navigation that turned out to be fine; the repair is to
  stop interrupting it.
- **Without it**, the page stays and says what it found. The user
  pointed us at this URL deliberately, and vanishing is not an answer.

Where the marker comes from and goes:

- Only `buildPreviewPageUrl` (`install-capture.ts`) adds it, and the
  capture is the only thing that calls it.
- The collections page builds its own preview URL and does not add it.
- `deep-link.ts` — the redirect that lets a web page link into the
  extension, forwarding its query string — deletes this parameter from
  whatever it forwards.
- `userscript.ts` reads it once, into `previewWasCaptured`, for the
  decision above. Nothing else looks at it.

That third point is the security-relevant one. Acting on the marker
means navigating the user's tab and writing a capture bypass for the
target URL, so a web page must not be able to set it. Web pages cannot
open `chrome-extension://` URLs at all, which leaves the deep-link
redirect as the only way a parameter could cross from the web onto an
extension page — hence the strip.

### When the URL isn't a script

- A file with no (or an unterminated) metadata block can't be
  installed: the preview says so and hides Install, rather than letting
  `addCollection` create an `invalid` row.
- Usually that means the URL is an ordinary **web page** whose path
  happens to end in `.user.js` — the blob view of a forge not in
  `CODE_HOST_PAGE_VIEWS`, say. The capture runs before any response
  exists, so it can't apply the `mime != text/html` half of Chrome's
  own test the way the DNR rule can; the host list is the stand-in for
  the hosts worth knowing about in advance.
- **Continue to page** is the way out: it sets a bypass and loads the
  URL, so the capture doesn't pull the tab straight back. Without it
  the only escape would be turning the whole option off.
- What reaches this banner is the *non-markup* remainder: a `.txt`, a
  truncated file, a script whose metadata block never closed. A web
  page has already continued on its own (above).
- For a local file the same button reads **Continue to file** and
  targets the `file://` form — the bare path the preview may have been
  opened with would resolve against the extension's own origin.
- A GitHub blob URL that *is* previewed — reached through the Add
  field, not a capture — describes the real script:
  `normalizeCollectionInput` rewrites it to its raw counterpart first.

### How the raw view stays readable

The right way to show the file depends on what the browser would do
with the response:

- **http(s) on Chrome ≥ 152** — a real navigation to the URL, with a
  one-shot capture bypass. The browser renders it as source text and
  the address bar keeps the true URL.
- **Everything else** — the copy the preview already fetched, rendered
  on `raw.html`. Navigating for real would land on a response the
  download workaround has rewritten to `text/html` (http ≤ 151), or on
  the legacy download path (`file://` ≤ 151).
- `file://` takes the `raw.html` branch on **every** version:
  a titled, guaranteed-readable tab is already the better answer, and
  it costs no navigation to get wrong.
- **Fetch failed / still in flight** — navigate regardless of
  version. There's no copy to render locally, and a real navigation
  carries the cookies the extension's own fetch doesn't, so it doubles
  as the retry for an auth-gated URL. On Chrome ≤ 151 the browser then
  does whatever it does with the (possibly rewritten) response — the
  one case where the raw view can't promise a readable result.

Every real navigation out of the preview sets a bypass first, `file://`
included — otherwise the raw view would be captured straight back into
the preview it was opened from. The bypass is keyed on the URL the
browser will request, not on `?preview=`: for a local file opened by
path those differ.

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
- The row is dropped when the preview page goes away. The raw tab has
  rendered its copy by then; only a reload of that tab would notice,
  and it says so rather than showing a blank page.
- The tab is opened with `chrome.tabs.create`, **not** `window.open`:
  an extension page opened via `window.open` comes up without the
  `chrome.*` APIs, so `raw.html` would have no way to read its text.
## The bypass

- `chrome.storage.session` row `installBypass:<url>`, holding an
  expiry timestamp, TTL 30s. Used by the raw view whenever it
  navigates to the real URL.
- Written by the preview page (extension pages are trusted contexts),
  read-and-cleared by the service worker — session storage rather than
  an in-memory set because the SW can restart in between.
- One-shot: a later visit to the same URL is captured normally again.
- Also used by **Continue to page** / **Continue to file**.
- Scheme-agnostic: the key is whatever URL the tab is about to load,
  `file://` included.
- A row written for a navigation that never happens (tab closed first)
  is only cleaned up by the next read of that same URL, so it can sit
  in session storage until the browser closes. It's one small row and
  session-scoped; there's no reaper.

## The option

- Options page: **Capture `.user.js` links**, on by default
  (`smCaptureUserJsLinks` in `chrome.storage.local`; absent means on).
- Turning it off removes the DNR rule too — the user asked for stock
  browser behavior, and on Chrome ≤ 151 that includes the download.
- It is the one switch that also turns off `file://` capture, for
  anyone who would rather their local scripts just open.
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
  redirect stub with `?page=collections.html&add=…`.
- Capture needs no cooperation from the page at all, but only works
  from a `.user.js` URL. Starting from a script's *listing* page needs
  the deep link, which the page has to opt into.

## Limitations / future work

- **`file://` capture needs the file-access toggle**, and there is
  still no way to tell the user so: with the toggle off nothing fires,
  which is indistinguishable from the capture option being off. The
  banner added in
  [script-viewer.md](script-viewer.md#when-a-local-file-wont-read)
  only covers a preview the user reached some other way — it needs a
  failed read to hang off, and a capture that never fires produces
  none. A hint on the options page would close the gap.
- **Mixed-case suffixes are ignored** everywhere, by design — see
  "Every matcher has to agree" above.
- **`Content-Disposition: attachment` responses** still download on
  every Chrome version when the capture loses the startup race; the
  DNR rule only rewrites `Content-Type`.
- **No `@version` comparison logic** beyond the Version column of the
  Existing versions table — Update always refetches, and nothing says
  which copy is newer or whether they differ at all. A comparison +
  diff view is planned; see TODO.md.
- **Delete the DNR rule** once Chrome 152 is the supported floor
  (`needsDownloadWorkaround` and its unit tests go with it).
