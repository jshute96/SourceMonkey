# Installing From a `.user.js` URL (Link Capture)

Opening a `.user.js` URL should land on a SourceMonkey preview of the
script, with an Install button — whether it came from GreasyFork,
GitHub, or a file on the user's own disk. Chrome never does that on its
own, so the extension intercepts the navigation.

Implementation:

- [`src/extension/install-capture.ts`](../src/extension/install-capture.ts) (service
  worker) hands the URL to the userscript viewer's **preview mode** —
  the prompt is not a separate page.
- See [script-viewer.md → Preview mode](script-viewer.md#preview-mode)
  for what it renders and which buttons appear when.

## What Chrome does with a `.user.js` URL

- It is an ordinary resource: a `text/javascript` response renders as
  source text, an `attachment` response downloads as a plain file, and
  a local `.user.js` opens as text.
- Chrome never offers to install anything, so the capture is needed
  permanently. It just means the *non-captured* outcome is benign.

### The Chrome 152 floor

- Chrome ≤ 151 special-cased the suffix
  (`UserScript::IsURLUserScript`, "get downloaded instead of viewed"):
  the navigation was forced into a download, handed to the extension
  installer, and converted to an MV2 extension — a path that always
  fails now that MV2 is gone.
- [crrev 38b617ca](https://chromiumdash.appspot.com/commit/38b617ca5ade59243d01170a8f4a744692983f19)
  (landed 2026-06-30) removed it in Chrome 152.
- `minimum_chrome_version: "152"` in the manifest is the floor, so
  nothing here works around the legacy path any more. Chrome refuses
  to load the extension below it.

## The capture

- `webNavigation.onBeforeNavigate`, filtered with
  `{ pathSuffix: '.user.js' }`, fires before the request goes out.
- Top-level navigations only (`frameId === 0`).
- The preview is `userscript.html?preview=<clicked URL>`. Where it
  opens is covered in [Which tab the preview opens in](#which-tab-the-preview-opens-in).
- Each capture logs one line in the service worker's console, with
  how long each step took: from the navigation starting to the listener
  running, then reading the setting, the bypass check, the tab lookup
  and opening the preview's tab. The raw script shows in the original
  tab for that long, so the line says where a slow capture spent it.
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
  `/-/raw/`, `/raw/`) is still captured — that one really is the
  script, and the browser offers no way to install it.
- So is a blob URL carrying GitHub's own `?raw=true` switch. It 302s to
  the raw host, and `onBeforeNavigate` doesn't fire again for a server
  redirect, so skipping it would lose the capture rather than defer it.
  (`?plain=1` is not that switch — it's still the page.)
- These pages are already what the user wanted to see, so there is
  nothing for the capture to improve. Not capturing is
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
| `isUserJsUrl` | whether a preview opens, and whether a watched tab's commit counts as the script |
| `isSingleFileInput` (`directories.ts`) | post-install: one script, or a directory to scan |

- All are **case-sensitive** and **path-anchored**. Chrome's own legacy
  check is case-*insensitive*, which is the temptation to match it —
  but a `FOO.USER.JS` that captured would then fail
  `isSingleFileInput` and register as a *directory collection*.

### Why not a `declarativeNetRequest` redirect

- A DNR `redirect` to an extension page requires that page in
  `web_accessible_resources`, which exposes the extension ID to every
  site for fingerprinting.
- An extension-initiated navigation (`chrome.tabs.update` or
  `create`) has no such requirement, and the ID never leaves the
  extension.

## Which tab the preview opens in

- The preview opens in a **new tab** beside the one navigating
  (`chrome.tabs.create` with `openerTabId`), so closing the preview
  gets back to where the person was.
- Focused only if the original tab was. A middle-clicked background
  tab, or a script navigating one, doesn't pull the preview forward.
- If Chrome refuses the new tab (an app or popup window), the preview
  replaces the original tab instead.
- The original navigation is **not** cancelled, so other script
  managers can still catch it (see
  [When other script managers are installed](#when-other-script-managers-are-installed)).
- The cleanup depends on how that navigation ends (see
  [The watch](#the-watch)):
  - **Commits to the script** (no other manager took it): after a
    second, the tab goes back (`chrome.tabs.goBack`).
    - It closes instead when going back would land on nothing worth
      keeping: no page (a middle-clicked tab), a blank page, or the
      new-tab page (a URL entered in a new tab or window).
    - The page behind it is read with `webNavigation.getFrame` when the
      capture's listener runs, since `chrome.tabs` hides `chrome://` and
      `about:` URLs without the `tabs` permission.
    - If the script had already committed by then (a worker started by
      the navigation, or a fast `file://` load), that reads as the
      script itself. The tab then goes back, and closes if that landed
      on a blank page.
    - It's left alone when the preview's tab is already gone: the
      preview closed itself for a web page, and this tab is all that's
      left.
    - Going back restores the page from Chrome's back/forward cache, so
      its own timers keep running. GreasyFork's 2s redirect to its
      post-install page still happens, for example.
  - **Commits to a web page** (an HTML document, or text starting with
    `<`): the tab stays there, and the preview closes itself (see
    [When the URL turns out to be a web page](#when-the-url-turns-out-to-be-a-web-page)).
  - **Becomes a download** (`Content-Disposition: attachment`): the
    download is cancelled, and the tab stays on its page.
  - **Fails** (a missing file, a server that's down): the tab stays on
    Chrome's error page, which says what went wrong, beside the
    preview's own report of its fetch.
  - **Commits to anything else** (another manager's page, a different
    navigation): left alone.

### The watch

`watchedTabs` follows each captured navigation, keyed by tab, until it
ends.

- **Set as the navigation starts**, before anything is awaited, so a
  fast response can't get past it.
- **While the capture is still opening the preview**, a commit or a
  download is only recorded on the watch. The capture acts on it once
  the preview's tab is open.
- **Going back waits a second** (`LEAVE_DELAY_MS`) after the script
  commits. Another manager may be about to rewrite the tab, and going
  back would cancel that. A commit in the meantime ends the watch.
- **A navigation that fails or is stopped** (Esc, a 204, a network
  error) ends its watch a second later, or a second after the preview
  opens if the capture was still opening it. A navigation that becomes
  a download fails too, and the second leaves time for its download to
  be reported.
- **A download is cancelled only once the navigation is known to be
  captured.** A navigation behind a bypass, such as View raw source,
  is the person's own, and its download stays.
  - A small file can finish before the cancel lands, so a complete file
    is removed from disk before its entry is erased.
- **It ends** at the tab's next commit (or a second after the script
  commits), a second after the navigation fails, when its download is
  cancelled, or when the tab closes.
- **A second captured navigation in the same tab** (a second click
  while the first is still loading) replaces the watch. Chrome starts
  only one navigation for a double-click on a link, so this takes
  clicks further apart.
  - The first capture stops if it hasn't asked for its preview's tab
    yet. If it has, the second waits for that tab and uses it rather
    than opening another. Only one preview opens.
  - The first navigation's abort, reported to the tab next, is expected
    and doesn't end the second's watch.
- **In memory only.** A worker restart loses it, which at worst leaves
  raw source showing or a file downloaded.

## When other script managers are installed

- **The goal:** with multiple managers installed, clicking a script
  opens each one's install page in its own tab.
- TM and VM mostly cooperate with each other already, though that's
  theirs to control (see below).
- SourceMonkey works with what both of them do, so with all three
  installed, one click opens all three install pages.

### What Tampermonkey and Violentmonkey do

Observed behavior, in their Chrome builds:

- **Tampermonkey (TM)**
  - Redirects the request to a page on its own site
    (`tampermonkey.net/script_installation.php#url=…`).
  - Once that page loads, opens its install page in a new tab, then
    sends the original tab back, or closes it when it has no history.
  - Catches `file://` URLs only with "Allow access to file URLs".
- **Violentmonkey (VM)**
  - Fetches the script itself, then replaces the tab with its confirm
    page. For some known hosts it also stops the page's navigation
    first.
  - For a `file://` URL without "Allow access to file URLs", replaces
    the tab with a help page on installing local files instead, or does
    nothing with that help turned off.
- **TM and VM together:** depending on timing, VM's rewrite of the tab
  can cancel TM's page on its site before it loads, and then TM's
  install page never opens. That happens without SourceMonkey too.

### How SourceMonkey stays out of the way

- **Its preview gets a tab of its own.** Rewriting the original tab
  would compete with VM's rewrite there, and Chrome silently cancels
  whichever navigation started first.
- **The original navigation runs on.** TM's redirect and VM's fetch
  both depend on it.
- **It goes back only from the raw script**, and only after a second:
  the tab still showing the script a second later means nobody took
  it. Going back sooner could cancel a VM rewrite already on its way.
- **Any other commit in the tab** is left alone: it's another manager's
  page.

### Testing it

- `pnpm run test:all-managers` loads SourceMonkey beside TM, beside VM,
  and beside both, and opens scripts from the address bar, by a click
  and by a middle-click, from http at different server speeds and from
  `file://`.
- With one other manager, both install pages must show. With all three,
  SourceMonkey's must, and the others are recorded.
- Chrome grants file access to every extension a test loads, so VM's
  "file access off" modes run a copy of VM patched to behave as it does
  without it.

## Where the capture lands

- The preview is `userscript.html?preview=<clicked URL>`: the same
  viewer an installed script opens in, in preview mode.
- What it renders, and which of Install / Update / Continue appears
  when, is documented in
  [script-viewer.md → Preview mode](script-viewer.md#preview-mode).

Capture-specific points:

- The **clicked** URL is what travels in `?preview=`, not the
  normalized one — a bypass has to be keyed on the URL the browser
  will actually navigate to.
- **Cancel** closes the preview's tab, which has no history. Chrome
  then returns to the tab the click came from.
- Where Chrome refused that tab and the preview replaced the original,
  Cancel goes back instead.
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
- For a **captured** navigation the preview then gets out of the way
  on its own, with no banner. The tab that navigated has gone on to the
  page itself, so the preview closes its own tab. The capture was our guess
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
you clicked a .user.js link, and we opened a preview beside it
  → userscript.html?preview=https://x.test/a.user.js&captured=1&beside=1

you typed that URL into the collections page's Add field
  → userscript.html?preview=https://x.test/a.user.js
```

Only the first has `captured=1`. It means *the extension opened this
preview on its own initiative* — nothing about the script.

That one bit decides what happens when the fetch comes back as a web
page rather than a script:

- **With it**, the preview closes its own tab, opened beside the one
  that went on to the page. A second marker, `beside=1`, says it has a
  tab of its own; without it (Chrome refused that tab, and the preview
  replaced the original) it navigates to the URL instead.
  - Forging `beside=1` could only make a preview close its own tab.
  - Either way, the repair for a navigation we guessed wrong about is to
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
  exists, so it can't look at the response's MIME type at all; the
  host list is the stand-in for the hosts worth knowing about in
  advance.
- **Continue to page** is the way out: it sets a bypass and loads the
  URL, so the capture doesn't open another preview. Without it
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

### View raw source

**One behavior on every scheme: a real navigation to the file itself.**
Chrome renders a `.user.js` as source text whether it came over http or
off local disk, so the tab shows the actual file at its actual address.

**Which address depends on whether the location could be read:**

- **Read** → the canonical location, not what the user typed. A GitHub
  blob URL is rewritten to its raw counterpart before the fetch, and
  the raw file is the source the preview describes; the blob URL would
  open GitHub's file browser instead.
- **Not read** → the user's own input, when it is navigable. That is
  the form that can carry site cookies our fetch doesn't, so the
  failed-fetch case doubles as the retry. It matters for exactly one
  host today: a private repo's blob page renders for a logged-in user,
  where its `raw.githubusercontent.com` counterpart 404s without a
  token (a personal access token is still the supported route — see
  [http-collections.md](http-collections.md#github-authentication)).
- The two agree except where canonicalization rewrote the URL.
- **Nothing local is being rendered**, so the button never waits on the
  fetch. Only a location `normalizeCollectionInput` refused outright
  has no address to offer, and that reports instead of navigating.
- **The `file://` tab is labelled with the path**, not the filename.
  A bespoke extension page rendering the fetched copy used to buy a
  `<basename> | SourceMonkey` tab title; one behavior on both schemes
  is worth more than the nicer label.
- **A `file://` navigation can be refused** when "Allow access to file
  URLs" is off — but so can the fetch, for the same reason, so the
  button is no worse off than the page it sits on. `withBypass` reports
  the refusal through the file-access banner rather than leaving the
  button inert.

Every real navigation out of the preview sets a bypass first, `file://`
included — otherwise View raw source would be captured straight back
into the preview it was opened from. The bypass is keyed on the URL the
browser will request, not on `?preview=`: for a local file opened by
path those differ.

## The bypass

- `chrome.storage.session` row `installBypass:<url>`, holding an
  expiry timestamp, TTL 30s. Used by View raw source whenever it
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
- Turning it off leaves the URL to Chrome, which renders it as source
  text.
- It is the one switch that also turns off `file://` capture, for
  anyone who would rather their local scripts just open.
- The service worker keeps an in-memory mirror of the flag, refreshed
  by a `storage.onChanged` listener, so the navigation handler never
  awaits storage on its sync fast path.
- The mirror starts at the default (on). An MV3 worker is woken *by*
  the navigation event, so the first navigation after a wake can beat
  the initial read — the handler awaits the settled flag on its async
  side and re-checks before opening the preview, rather than capturing
  for a user who turned capture off.

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
- **Forward to a raw script captures it again.** After the tab goes
  back, pressing Forward loads the script, which opens another preview.
- **A site that navigates with `location.replace`** to the script
  replaces the page's history entry, so going back skips past the
  page, or closes the tab when there is nothing before it.
- **Mixed-case suffixes are ignored** everywhere, by design — see
  "Every matcher has to agree" above.
- **No `@version` comparison logic** beyond the Version column of the
  versions table — Update always refetches, and nothing says which copy
  is newer. The Compare column says whether a copy differs from the
  download, and its DIFF button opens the compare page
  ([compare.md](compare.md)) with the download as the base.
