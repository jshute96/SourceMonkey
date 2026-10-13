# Architecture

SourceMonkey is a Manifest V3 Chrome extension that manages and injects
userscripts. This doc is the **high-level map only** — component
details live in the topic-specific docs linked below.

> **Status:** Matching + injection wired end-to-end; the `@require`
> pipeline prefetches and prepends required bodies; the `GM_*` /
> `GM.*` API surface covers storage (with cross-tab broadcast +
> value-change listeners), DOM injection (`GM_addStyle` /
> `GM_addElement`), clipboard, `GM_xmlhttpRequest` (text + binary,
> with `@connect` URL gating and the surgery that lets a script set
> forbidden request headers like `Sec-Fetch-*`), `GM_download`,
> `GM_notification`, `GM_openInTab`, `GM_log`, and
> `GM_registerMenuCommand` / `GM_unregisterMenuCommand` (listed
> under each script in the toolbar popup). Deferred: `GM_cookie` (bindings stubbed). See
> [GM-APIs.md](GM-APIs.md) and [TODO.md](../TODO.md).

## Components

```
+------------------+        +-----------------------+        +---------------+
| Collections page UI  |  -->   | background service    |  -->   | chrome.storage
| (collections.html)   |        | worker (background.ts)|        |  .local       |
+------------------+        +-----------------------+        +---------------+
                                      |
                                      v
                            +-----------------------+
                            | chrome.userScripts    |
                            | (Chrome owns matching |
                            |  + injection at nav)  |
                            +-----------------------+
```

- **Service worker** (`src/extension/background.ts`) — central event handler.
  Opens the toolbar popup on a click and the collections page on a
  double click, watches tab navigation, and surfaces per-tab match
  counts via the action badge. See [matching.md](matching.md).
  - **The only writer**: every storage write and registration runs
    here. Extension pages read storage to paint, and ask the worker to
    change anything (`worker-client.ts`, `worker-ops.ts`); it keeps the
    rows in memory as it writes them. See [worker-writes.md](worker-writes.md).
- **Toolbar popup** (`src/popup.html` + `src/extension/popup.ts`, view
  built by `src/extension/popup-view.ts`) — "Active scripts": the
  scripts that match the current tab, by collection, with toggles,
  statuses, menu commands and selective reloads. It also runs manual
  scripts (`@run-at context-menu`; see [manual-scripts.md](manual-scripts.md)).
  See [status-popup.md](status-popup.md).
- **Collections page** (`src/collections.html` + `src/extension/collections.ts`) — manage
  collections (directory, manifest, github-dir, or a "scripts"
  collection holding individually installed scripts — user-created, or
  one of the built-in per-scheme defaults) and inspect per-script
  status. Collections are created and edited through the shared
  **collection dialog** (`src/extension/collection-dialog.ts`). See
  [storage.md](storage.md).
- **Options page** (`src/options.html` + `src/extension/options.ts`) — small
  settings page: `.user.js` link-capture toggle, debug-logging toggle,
  local-file-override search roots, Downloads folder, GitHub auth token
  entry, and a read-only table of storage used, by kind, against Chrome's quota.
  Reached via the Options link at the top of the collections page.
- **Debug icons page** (`src/debug/icons.html` + `src/extension/debug/icons.ts`) —
  inspects the cached site icons in `chrome.storage.local`, with per-row
  refresh / delete. Linked from the Options page's storage section. See
  [site-icons.md](site-icons.md#debug-page).
- **Debug storage page** (`src/debug/storage.html` + `src/extension/debug/storage.ts`) —
  where `chrome.storage.local` goes: by script, by stored file (with
  shared copies), and GM values per script. Linked from the Options
  page's storage section. See
  [storage.md](storage.md#storage-debug-page).
- **Install capture** (`src/extension/install-capture.ts`) — turns a navigation
  to a `.user.js` URL (`http(s)://` or `file://`) into the userscript
  viewer's preview mode
  (`userscript.html?preview=<url>`), which fetches, describes,
  asks which scripts collection to put it in, and — on confirmation —
  `installScript`s it. Its "View raw source" button navigates a new
  tab to the file itself. See
  [install-capture.md](install-capture.md).
- **Script store** (`src/extension/script-store.ts`) — persistence layer + the
  load / refresh pipeline. Owns the chrome.storage.local schema. See
  [storage.md](storage.md).
  - Building one script row from its text (header, matching,
    `@require` loading, parse check) is in `src/script-build.ts`, which
    touches no storage, so the harness runs it under Node.
  - Script bodies are stored apart from the rows, in shared
    `blob:<sha256>` rows (`src/extension/script-blobs.ts`; see
    [storage.md](storage.md#content-blobs)). Readers that need only
    the rows (`ScriptMeta`) don't read them.
- **Script updater** (`src/extension/script-updater.ts`) — the single entry
  point every refresh path goes through. Manual Refresh buttons call
  it synchronously; the background SW calls it opportunistically when
  a tab uses some scripts. Also runs the post-refresh update probe.
  See [storage.md](storage.md#updater) and [updates.md](updates.md).
- **Update probes** (`src/version-probe.ts` + its `-fetch` half, with
  `src/version-compare.ts`) — read the `@version` a script's
  `@updateURL` / `@downloadURL` declares and compare it with the copy
  we run. Reporting only: the install source stays the update channel.
  See [updates.md](updates.md).
- **Collection I/O** (`src/extension/directories.ts` + `src/extension/github-provider.ts`):
  - recursive `*.user.js` scanner, `http(s)://` fetcher, JSON manifest
    parser
  - the `file://` fetcher, directory-listing parser and location
    helpers, in `src/file-locations.ts`
  - the GitHub provider (URL parsing, blob→raw rewrite, Contents-API
    scanner), in its own module, dispatched to from `directories.ts`
  - See [file-access.md](file-access.md) and
    [http-collections.md](http-collections.md).
- **File-access permission UI** (`src/extension/file-access.ts`) — the
  "Allow access to file URLs" probe plus the shared banner every page
  raises when the toggle is what blocked a local read. See
  [file-access.md](file-access.md).
- **GitHub auth** (`src/github-auth.ts`) — persisted PAT cache +
  `githubAuthHeaders(url)` host-gated helper. Spread into every
  fetch site that talks to `api.github.com` or
  `raw.githubusercontent.com`; never attached to any other host
  (including `github.com/<o>/<r>/raw/`, which 302s to raw and the
  Fetch spec strips Authorization on cross-origin redirects). See
  the GitHub-authentication section of
  [http-collections.md](http-collections.md).
- **File loader** (`src/file-loader.ts`) — resolves header references
  (`@icon`, `@require`, `@resource`) into absolute URLs against the
  script's own URL (a local script's refs stay inside its folder;
  a remote one's may climb, as in Violentmonkey), and
  exposes scheme-aware bounded byte + text fetchers used by the icon,
  require, and resource pipelines.
- **External files** (`src/external-files.ts`) — `@require` +
  `@resource` orchestrator on top of `file-loader`.
  - Extracts refs from the metadata block, resolves them, fetches +
    dedups within and across scripts (and across kinds) in one
    refresh pass.
  - Attaches typed entries to each StoredScript.
  - `@require` bodies are prepended at registration; `@resource`
    bytes are baked into the wrapper for `GM_getResource*`.
  - A file declared by absolute URL can be served from a local copy on
    disk instead, for local development of a published library
    (`src/local-file-overrides.ts`).
  - See [requires.md](requires.md), [resources.md](resources.md), and
    [local-file-overrides.md](local-file-overrides.md).
- **Header parser** (`src/userscript-header.ts`) — splits a
  `.user.js` file into header + body and parses the metadata block.
  See [script-viewer.md](script-viewer.md). For which `@tag` fields
  actually change behavior, see
  [supported-headers.md](supported-headers.md).
- **URL matcher** (`src/url-match.ts`) — pure
  `@match`/`@include`/`@exclude` evaluator. What the rules mean:
  [match-rules.md](match-rules.md); how they're matched:
  [matching.md](matching.md).
- **Match index** (`src/extension/match-index.ts`) — in-memory cache of every
  `ok` script's matching info, kept in sync with storage; lets the SW
  find matches without per-navigation storage reads. See
  [matching.md](matching.md).
- **Injector** (`src/extension/injector.ts`) — keeps `chrome.userScripts`'s
  registration set in sync with the enabled-`ok` script set, and wraps
  every body with an activation/error shim. Specs Chrome refuses are
  recorded in `src/extension/script-rejection.ts`, which is what the UI renders
  as REJECTED. See [injection.md](injection.md).
- **Userscript viewer** (`src/userscript.html` + `src/extension/userscript.ts`)
  — per-script page with two modes: an installed script rendered from
  the store, and a preview of one that isn't installed yet (the landing
  spot for install capture and a single-script Add). Its details
  panel (`src/extension/script-details.ts`), tabbed code view
  (`src/extension/code-tabs.ts`), and code linkifier (`src/extension/code-links.ts`) are
  separate modules so both modes render identically. See
  [script-viewer.md](script-viewer.md).
- **Compare page** (`src/compare.html` + `src/extension/compare.ts`) — two
  copies of one script side by side: header fields in one table, a
  diff per file (`src/extension/line-diff.ts`). Linked from the viewer's versions
  panel. See [compare.md](compare.md).
- **Log IDs** (`src/extension/script-log-id.ts`) — assigns each script a short
  label, its basename and script number (`foo.user.js#E4`), used in
  every SW log line and stack trace and shown in the viewer, so users
  can correlate console output with a script. The number is sm-dev's
  `E4` (`src/extension/sticky-numbers.ts`). See
  [logging.md](logging.md).
- **Display names** (`src/script-display.ts`) — one place decides how
  a stored URL or path is rendered for humans: percent-decoded for
  display, left encoded for anything functional. See
  [names-and-paths.md](names-and-paths.md).
- **Debug logging** (`src/debug-log.ts`) — gates the noisier
  navigation/refresh log lines behind a storage-backed flag
  (`smDebugLogging`), toggled via a checkbox on the Options page
  (linked from the top of the collections page).
- **Per-script event log** (`src/extension/script-log.ts`) — structured per-
  script log of refresh outcomes and wrapper reports, stored in
  `chrome.storage.session` and surfaced through the viewer's Log
  tab. `src/extension/log-format.ts` renders it — the tab's cells and the CSV
  its Save / Copy buttons hand out. See
  [script-log.md](script-log.md).
- **GM_* catalog** (`src/gm-api-catalog.ts`) — data-only inventory
  of every supported `GM_*` / `GM.*` API: name, alias, sync/async
  kind, subsystem, optional `requires` (e.g. `@connect`).
  `resolveGrants` canonicalizes a script's `@grant` lines into the
  set we'll emit bindings for. See [GM-APIs.md](GM-APIs.md).
- **GM_* binding emitter** (`src/extension/gm-bindings.ts`) — pure compiler.
  Given a script's resolved grants + parsed header, returns the JS
  source spliced into the main-body wrap function at register time.
  Emits real bodies for every catalog entry; `unsafeWindow` is a
  `window` alias rather than a call (what makes it the page's window
  is the execution world — see
  [injection.md](injection.md#unsafewindow-is-the-pages-window)). The
  `notImplemented` stub remains only as a fall-through for future
  catalog additions whose bodies haven't landed yet.
- **GM_* page-side runtime** (`src/wrapper-gm-runtime.js`) —
  helper registered once per page **per execution world** that needs
  it. Puts itself in the world's registry (`reg.gm`, reached with the
  channel key; see [injection.md](injection.md#the-channel-key)) with
  per-subsystem helpers: storage
  cache + batched writes, DOM injection, clipboard, XHR start/abort
  with terminal-event dispatch, value-change listener registry.
  Captures a small shim cache of native references at init time so
  sibling userscripts that monkey-patch builtins can't subvert GM
  calls. In MAIN world (where scripts that ask for `unsafeWindow` run) its
  service-worker traffic rides `src/wrapper-bridge.js` in both
  directions.
- **GM_* SW storage** (`src/extension/gm-values.ts`) — persistent
  `gmval:<scriptId>:<key>` rows in `chrome.storage.local`, with
  batched apply (last-write-wins) and a per-script wipe helper.
- **GM_* SW XHR runner** (`src/extension/gm-xhr.ts`) — `fetch` driver with
  `AbortController` + timeout, text / JSON / binary response shapes
  (binary serialized to base64 for the page-side wire). See the
  XHR section of [GM-APIs.md](GM-APIs.md).
- **XHR header surgery** (`src/extension/gm-xhr-headers.ts`) — lets a script set
  request headers the browser forbids, by compiling them into a
  short-lived `declarativeNetRequest` session rule around the fetch.
  See [xhr-header-surgery.md](xhr-header-surgery.md).
- **@connect URL gating** (`src/gm-connect.ts`) — parses `@connect`
  lines into rules (`*`, `self`, host-and-subdomains), resolves `self`
  against the script's `@match`/`@include` hosts and the page, and
  gates `GM_xmlhttpRequest` URLs before fetch. The page's own origin is
  always allowed.
- **Connection prompt** (`src/extension/connect-prompt.ts`,
  `connect-grants.ts`, `connect-prompt.html`) — asks the user, in a
  popup window, about a host no rule covers, and keeps the answer per
  script. See [connect-permissions.md](connect-permissions.md).
- **GM_openInTab dispatcher** (`src/extension/gm-tab.ts`) — opens new tabs via
  `chrome.tabs.create` on behalf of userscripts; tracks the per-request
  (page-generated id ↔ assigned chrome tab id ↔ originator tab) mapping
  so `chrome.tabs.onRemoved` can route close events back to the
  originating tab's `onclose` callback.
- **GM_download dispatcher** (`src/extension/gm-download.ts`) — drives
  `chrome.downloads` on behalf of userscripts for `http(s)` URLs
  (`blob:` / `data:` downloads stay in the page); tracks the
  per-request mapping so completion, interrupt, timeout, and polled
  progress events route back to the originating tab.
- **GM_notification dispatcher** (`src/extension/gm-notification.ts`) — wraps
  `chrome.notifications.create` and maps the chrome-assigned
  notification id back to the originating tab + request id so
  `onClicked` / `onClosed` events route to the userscript's
  `onclick` / `ondone` callbacks.
- **window.onurlchange driver** (`src/extension/gm-url-change.ts`) — forwards
  `chrome.webNavigation`'s same-document navigation events to the
  frame that changed, which is the only way an isolated-world script
  can observe the page's own `pushState`. See the
  `window.onurlchange` section of [GM-APIs.md](GM-APIs.md).
- **window.close / window.focus driver** (`src/extension/gm-window-control.ts`)
  — re-issues a granted `window.close()` / `window.focus()` as
  `chrome.tabs.remove` / `chrome.tabs.update` + `chrome.windows.update`
  on the calling tab,
  which is what makes them work where the page's own calls are
  refused.

## Page names

- Every user-visible extension page is named
  `SourceMonkey | <what this page is>` in its `<title>`, and in its
  `<h1>` where it has one.
  - Collections → `SourceMonkey | Collections`; Options →
    `SourceMonkey | Options`.
  - The viewer names a script, so it puts the script first — that way
    the name survives a narrow tab strip. See
    [script-viewer.md](script-viewer.md#heading-and-page-title).
  - The compare page does the same once it has a script to name:
    `Compare: <script> | SourceMonkey`, with the heading
    `SourceMonkey | Compare | <script>`.
  - `offscreen.html` and `parse-sandbox.html` are exempt: no user ever
    sees them.
- `|`, not an em dash: it reads as a separator at a glance in a crowded
  tab strip, where an em dash reads as punctuation inside a sentence.

## Cross-page navigation

How one extension page opens another — the rules live in
`src/extension/page-links.ts`, which every surface below goes through.

- **Named tabs.** Collections and Options get at most one tab each. A
  link to either focuses the open one rather than opening a second.
  - Reuse prefers a tab in the current window; failing that it takes
    whichever other window's tab Chrome reports first.
  - A reused tab is told where to scroll: the linked collection's
    section, or the top for a link to the page as a whole. Options has
    no anchors, so every link to it means the top.
  - The toolbar button's double click is the exception: it activates a reused tab
    without moving it, because "show me SourceMonkey" should not cost
    the user their place.
- **Links to a named page open a new tab, never the current one.**
  Leaving the viewer to look at a collection used to lose the viewer.
  - The Options button on Collections, and the Collections button on
    Options.
  - The viewer's Collection row and every "Other versions" row's
    collection name.
  - The header bar's icon and product name, on every page but
    Collections itself (`a.page-home`, wired by one delegated listener
    so it survives the viewer's heading repaints).
- **The install preview opens in a new tab too**, from the Add field and
  from the collection dialog's "this is a single script" action — the
  page the user was adding from stays put. The preview is *not* a named
  tab: it is per-file, and several at once is normal.
- **Every one of these is a real anchor with a real `href`.** A
  Ctrl/Cmd/Shift/middle click is left to the browser, and the URL is
  copyable. Only a plain left click is reinterpreted as "the named tab".
  - The `href` is also the behaviour before the page's scripts have run.

## Extension-page styling

### The page header bar

- **Every user-facing page opens with the same bar** (`.page-header` in
  `src/styles.css`): the extension icon, the
  `SourceMonkey | <page>` heading, and that page's cross-page
  navigation pushed to the right edge.
  - Collections carries Options and Refresh All; Options carries
    Collections; the toolbar popup carries Open and a ⋯ menu; the
    viewer carries none.
  - The icon and the product name are a link home to the collections
    page on every page but Collections itself — see "Cross-page
    navigation" above.
  - `offscreen.html` and `parse-sandbox.html` have no bar — no user
    ever sees them.
- **The heading is the page's `<h1>`, moved into the bar** rather than a
  second copy of the title. On the viewer that is the live
  `#filename` heading, script name and favicon included.
  - The product half wears `.brand` and takes the brown; the rest of
    the heading stays near-black. The viewer's `.heading-prefix`
    carries both classes.
- **Brown.** The bar sits directly above the
  viewer's green "Other versions" card and the amber warning-banner
  slot. A tint from either family reads as the top of that card
  instead of as page chrome; brown is where the icon's own colours
  live and is far enough off both.
- **The bar is full-bleed; its contents are not.** `.page-header` paints
  the background edge to edge, and `.page-header-inner` centres the row
  on `--page-width` — the same column `.page-body` centres, so the
  heading starts directly above the page's own first line.
  - Every page's content inset is 16px, the bar's included, so the two
    edges line up on the full-bleed pages too.
  - Collections and Options set `--page-width: 720px`. The viewer
    leaves it unset and runs full width.
- **The viewer keeps its flex column**, moved down one level into
  `.page-main` (`flex: 1 1 auto; min-height: 0`) so the code box still
  takes the leftover height under the bar.

#### Naming the bar before the page loads

The bar is the one thing on the page that says what the page *is*, so it
must not be the last thing to arrive. What gets it there, in the order it
takes effect:

- **The brand run is in the markup.** `userscript.html` ships the
  `SourceMonkey |` spans inside its `<h1>`, so the bar is never an icon
  beside an empty line. It is byte-for-byte what
  `headingPrefixEl(INSTALLED_HEADING)` builds, so nothing moves when the
  real heading replaces it.
- **A module with no static imports paints the rest.**
  `src/extension/page-heading.ts` is loaded ahead of `userscript.js` and imports
  nothing at all, because a module does not evaluate until everything it
  imports has been fetched — one small import would be enough to put its
  first line back after the first paint.
  - The **prefix** goes on synchronously: which of the two pages this is
    can be read off the query string, no storage needed. This is what
    puts `Install | ` on the install page's first paint.
  - The **name** needs the one `script:<id>` row plus the label helpers,
    which arrive by dynamic `import()` — after the prefix is on screen.
    Until then the heading is the prefix and nothing else, which fills
    in rather than being replaced.
  - `userscript.ts` imports the module too. A module runs once, so the
    early paint happens once and the heading constants have a single
    home rather than a copy per entry point.
- **Prism is deferred.** Its `<script>` tags blocked parsing, and
  everything deferred waits for parsing to finish. Deferred scripts still
  run in document order, so Prism is defined before `userscript.js`.
  - They also carry `data-manual`, which stands Prism's automatic
    `highlightAll()` down. Nothing wanted it — `code-tabs.ts` highlights
    the code box itself — and deferring would otherwise have moved that
    pass to a frame after `DOMContentLoaded`, where it could rebuild the
    block and drop the links `code-links.ts` puts in.
- **The install preview is the exception.** Its script's `@name` is inside
  a file that hasn't been fetched.
  - So it paints `SourceMonkey | Install | ` early and lets the name land
    with the rest.
  - Naming it from the URL would only move the flash: the location it
    would show is usually not what the finished heading says.

### Buttons

- **Every button in the extension shares one surface**, defined once in
  `src/styles.css` as a `:where(button)` baseline: one height
  (`--icon-btn-size`), one background/border (`--btn-*`), and a
  rest → hover → press progression that always gets *darker*.
- Why a baseline at all: Chrome paints no hover or press state on a
  native button, and stops painting one entirely once any author
  background is set. Without this, whether a button visibly reacted to
  a click depended on whether some page had happened to style it.
- Why `:where()`: zero specificity, so it is a baseline rather than an
  override. Any class rule beats it — but only for what that rule
  actually declares. A control that sets a background and no height
  gets its own background and the shared height.
- **Opting out is explicit.** Controls that are not part of a button
  row pin their own height: the code tabs, the panel's fold triangle,
  the dialog's inline error action, the copy button, the bulk toggle.
  A dense table can shrink the whole pair by redefining
  `--icon-btn-size` / `--icon-btn-glyph` on an ancestor — the script
  table does, so a row's trash can fits inside its line box instead of
  making that row taller than its neighbours.
- **Icon buttons** add `.icon-btn` (put on by the code that paints the
  glyph, so a glyph can't arrive without its box): a square minimum, a
  centred glyph, and roomier padding when the button also shows a word.

### Whole-pixel metrics

- **Vertical metrics are whole pixels** wherever a checkbox column sits:
  the collections page, Options, and the viewer's "Other versions" panel
  (plus their shared ancestors — the banner, the collection bubble).
  They are written in `px`, not `em`.
- Why: an em value at the 14px base font (`0.3em` = 4.2px) puts every
  row and card at a different fractional offset.
  - A 13px checkbox then rasterizes a device pixel larger or smaller
    depending on which row it landed in.
  - That reads as a column of not-quite-equal checkboxes, and as rows
    shifting whenever something above them resizes.
- The rest of the viewer is still em-derived, so its panel settles on a
  shared *fractional* offset. Uniform is what matters — every checkbox
  in one column rasterizing alike — not whole-pixel specifically.
- `tests/e2e/layout-metrics.spec.ts` measures each checkbox column and
  fails if one stops agreeing with itself.

## Cross-cutting docs

- [storage.md](storage.md) — `chrome.storage.local` schema, status
  model, load/refresh pipeline, collections-page table rendering.
- [file-access.md](file-access.md) — `file://` permissions, why we
  chose paths over the File System Access API, directory-listing
  enumeration, format caveats.
- [http-collections.md](http-collections.md) — `http(s)://` URL formats,
  scheme-agnostic manifest schema (works for local paths and
  file:// URLs too), conditional-GET update detection.
- [updates.md](updates.md) — how a script updates from its install
  source, `@updateURL` / `@downloadURL` probing, `@version` ordering,
  the OUTDATED status.
- [script-viewer.md](script-viewer.md) — userscript viewer page, header parsing,
  syntax highlighting.
- [match-rules.md](match-rules.md) — what `@match`/`@include`/`@exclude`
  rules mean, compared with Chrome, Tampermonkey and Violentmonkey.
- [matching.md](matching.md) — how rules are matched and registered,
  in-memory match index, per-tab badge + tooltip.
- [injection.md](injection.md) — `chrome.userScripts` registration
  lifecycle, the activation/error wrapper, opt-in requirements,
  unsupported pattern forms.
- [frames.md](frames.md) — scripts in a page's iframes: `@noframes`,
  one status per script across frames, menu commands and value
  broadcasts per frame.
- [injection-modes.md](injection-modes.md) — the three possible
  arrangements of a script's `js[]` entries (concat vs separate
  entries vs eval-per-require); why we ship the concatenated user
  program, and what the alternatives bought or would cost.
- [parse-check.md](parse-check.md) — compiling a script's source
  without running it, at install time, so a syntax error shows up next
  to the script instead of at injection time; why it needs a sandboxed
  page, why it fails open, and how the error is traced back to a line
  of the `@require` or body it was written in.
- [diagnostics.md](diagnostics.md) — the shared shape every
  content-derived verdict carries (header problems, bad `@require`s,
  syntax errors): which file and line it names, who produces one, and
  how each surface turns it into a click through to the code.
- [corpus-validation.md](corpus-validation.md) — the install-time
  checks over the GreasyFork corpus: the offline dependency root, and
  what the report groups. Findings over the GreasyFork corpus are in
  [corpus-validation-results.md](corpus-validation-results.md).
- [harness-design.md](harness-design.md) — the development and testing
  harness other repos install: `sm-dev` and the Playwright fixture,
  which push scripts into the real extension and record what they do.
  User-facing side in [harness-guide.md](harness-guide.md).
- [sm-dev-design.md](sm-dev-design.md) — internals of the harness's
  `sm-dev` command-line tool: runs and clients, tabs, page commands,
  tab claims, test collections, the extension's event stream.
- [logging.md](logging.md) — SW console-message catalog, log IDs
  (basename + `#E<number>`), and the debug-logging gate.
- [names-and-paths.md](names-and-paths.md) — the decode-for-display
  rule for names and URLs, and where it must not be applied.
- [script-log.md](script-log.md) — per-script structured event log
  shown in the viewer's Log tab.
- [site-icons.md](site-icons.md) — origin extraction from `@match`,
  favicon fetch + cache, icon slot in the collections/viewer UI.
- [GM-APIs.md](GM-APIs.md) — `GM_*` / `GM.*` implementation: the
  catalog, page-side runtime, SW-side storage / XHR, and the per-API
  surface SourceMonkey ships.
- [connect-permissions.md](connect-permissions.md) — which sites a
  script's `GM_xmlhttpRequest` may reach: `@connect` rules, the page's
  own origin, and the connection prompt with its stored answers.
- [supported-GM-APIs.md](supported-GM-APIs.md) — user-facing
  inventory of which `GM_*` names work, which are stubbed, and how
  they map to TM / VM / GM4 behavior.
- [deep-link.md](deep-link.md) — external "front door" that rewrites a
  GitHub-hosted markdown URL to the matching `chrome-extension://...`
  page, so web pages can link into the extension without knowing its
  ID.
- [install-capture.md](install-capture.md) — capturing `.user.js`
  navigations (web links and local files) into the viewer's preview
  mode, and the Chrome-version quirks that make it necessary.

## Build pipeline

`scripts/build.mjs` is dependency-free:

- Builds into a temporary `.build-<pid>/` (named by the build's
  process id), then renames each finished output over `dist/` and `lib/`.
  - A running harness or test sees the old output until the swap, and
    the folder is missing only for an instant during it.
  - A process that keeps running across a swap can load old and new
    modules together.
  - A failed build leaves the old output in place, and the temporary
    folder is removed however the build ends.
- Under `--watch`, builds only `dist/`, so `lib/` stays as it was.
- Copies `src/icons/`, `src/manifest.json`, every top-level
  `src/*.html`, and `node_modules/prismjs/*` into `dist/`, and the
  manifest into `lib/` too (the harness reads the extension key from it).
- Inlines `src/glyph-sprite.svg` into each page as it is copied, at the
  page's `#include glyph-sprite` marker comment (see below).
- Invokes `tsc` to compile `src/**/*.ts` → `dist/**/*.js`, keeping
  the folders (see [Source layout](#source-layout)). With `--watch`, a
  `tsc --watch` then keeps rebuilding `dist/` in place.
- Unless watching, runs a second `tsc` pass for `lib/` (below), and
  copies `src/generated-wrappers.d.ts` into `lib/`, since that one is
  hand-written.

No bundler. Each TypeScript module compiles to its own `dist/**/*.js`
and Chrome loads them directly as ES modules.

### Source layout

`src/` is split by who loads each module:

- **`src/extension/`**: modules only the extension loads (the service
  worker, the pages' scripts, storage, the injector). They build into
  `dist/extension/`.
- **`src/harness/`**: the Node-only development harness. Built into
  `lib/harness/`, never into `dist/`.
- **`src/` itself**: modules both use (header parsing, matching, the
  script build pipeline, `@require` loading). They build into both.
- The pages, CSS, icons and manifest stay directly in `src/`, so
  `dist/` keeps them at its root and the extension's URLs
  (`chrome-extension://<id>/collections.html`) don't name a folder.
  - Each page's `<script src>` points into `extension/`, and so does
    the manifest's service worker.
  - The worker runs from `extension/`, so a relative path it hands
    Chrome resolves there. It passes absolute URLs from
    `chrome.runtime.getURL` instead.

`tests/unit/source-layout.test.mjs` asks tsc which files each build
compiles, type-only imports included, and fails when:

- `lib/` reaches anything in `src/extension/` (a shared or harness
  module imports an extension-only one);
- `dist/` reaches anything in `src/harness/`;
- a module directly in `src/` isn't one the harness uses, so it belongs
  in `src/extension/`.

### Two outputs: `dist/` and `lib/`

One set of sources, compiled twice:

- **`dist/`** is the unpacked extension and nothing else. Chrome loads
  it, `scripts/zip_extension.sh` packs all of it, and
  `tsconfig.json` builds it with `src/harness/**` excluded.
- **`lib/`** is the `sourcemonkey` package's code (`package.json`'s
  `exports` point there).
  - `tsconfig.lib.json` compiles the development harness and the
    shared modules it imports, with a `.d.ts` beside each one for a
    TypeScript consumer.
  - The package ships `dist/` beside it, which `sm-dev` and the fixture
    load into the browsers they launch.

Why two builds of the same modules rather than one directory serving
both:

- The harness is a library built on dozens of the extension's own
  modules (the shared ones directly in `src/`), so the two sets of
  files overlap. Where they land doesn't have to.
- Keeping `dist/` to exactly what Chrome loads means the unpacked
  directory, the zip, and the extension are the same thing.
- The package can carry what it needs without that showing up in the
  browser.

The cost is one extra `tsc` pass on a full build, a few seconds.
`pnpm run watch` skips it: a developer watching `dist/` is iterating on
the extension, and `pnpm run build` is what produces the package.

### Glyph sprite

- Every inline SVG icon (the favicon placeholder, the two removal
  glyphs, refresh and the options gear, the copy button's pair) is
  defined once in `src/glyph-sprite.svg` and referenced by
  `<use href="#id">`.
- `src/extension/glyph.ts` paints them into buttons: glyph, optional label, and
  the matching `title` / `aria-label`. An icon-only button has no text
  to fall back on, so neither is optional.
- **The button box is set, not inferred.** Painting a glyph also puts
  `.icon-btn` on the button, which fixes its height and the glyph's
  size (`--icon-btn-size` / `--icon-btn-glyph` in `styles.css`).
  - Letting each button size itself off its content is what gave five
    identically-sized icons five different widths — three padding
    values, a text arrow measuring differently from an SVG, and one
    button on `align-self: stretch`.
  - A fixed box also satisfies the whole-pixel rule below for free:
    no `em` anywhere in an icon button.
  - A page rule that outranks `.icon-btn` on specificity (`.meta-row
    button`) has to exclude it with `:not(.icon-btn)`, or the box goes
    back to being inferred.
- A button whose action takes a while spins its own glyph
  (`setGlyphButtonBusy`) rather than swapping its label to
  "Refreshing…" — an icon-only button has no label to swap, and
  spinning in place doesn't shift the buttons beside it.
- It has to be *inlined per page*: a `<use>` pointing at another
  document doesn't inherit `currentColor`, and would be a second fetch.
  Keeping one copy in the source tree is what stops two pages from
  drifting into different glyphs.
- Only `--watch`ed TypeScript rebuilds automatically, so editing the
  sprite (like any HTML/CSS asset) needs a fresh `pnpm run build`.

## Testing

- Unit tests use the Node `--test` runner against compiled
  `dist/**/*.js`.
- E2E tests use Playwright. The fixture in
  `tests/fixtures/extension.ts` launches headless Chromium with the
  unpacked extension loaded from `dist/` and exposes the MV3 service
  worker so tests can drive the extension via
  `serviceWorker.evaluate(...)` — the toolbar action can't be clicked
  from Playwright in MV3.
