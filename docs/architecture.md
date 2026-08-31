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
> `GM_registerMenuCommand` / `GM_unregisterMenuCommand` (rendered as
> indented entries under each script in the toolbar action's
> right-click menu). Deferred: `GM_cookie` (bindings stubbed). See
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

- **Service worker** (`src/background.ts`) — central event handler.
  Opens the collections page on toolbar click, watches tab navigation,
  and surfaces per-tab match counts via the action badge. See
  [matching.md](matching.md).
- **Collections page** (`src/collections.html` + `src/collections.ts`) — manage
  collections (directory, manifest, github-dir, or a "scripts"
  collection holding individually installed scripts — user-created, or
  one of the built-in per-scheme defaults) and inspect per-script
  status. Collections are created and edited through the shared
  **collection dialog** (`src/collection-dialog.ts`). See
  [storage.md](storage.md).
- **Options page** (`src/options.html` + `src/options.ts`) — small
  settings page: `.user.js` link-capture toggle, debug-logging toggle,
  local-file-override search roots, and GitHub auth token entry.
  Reached via the Options link at the top of the collections page.
- **Install capture** (`src/install-capture.ts`) — turns a navigation
  to a `.user.js` URL (`http(s)://` or `file://`) into the userscript
  viewer's preview mode
  (`userscript.html?preview=<url>`), which fetches, describes,
  asks which scripts collection to put it in, and — on confirmation —
  `installScript`s it. Its "View raw
  source" tab is a separate page (`src/raw.html` + `src/raw.ts`) fed
  through `src/raw-view.ts`. See
  [install-capture.md](install-capture.md).
- **Script store** (`src/script-store.ts`) — persistence layer + the
  load / refresh pipeline. Owns the chrome.storage.local schema. See
  [storage.md](storage.md).
- **Script updater** (`src/script-updater.ts`) — the single entry
  point every refresh path goes through. Manual Refresh buttons call
  it synchronously; the background SW calls it opportunistically when
  a tab uses some scripts. Also runs the post-refresh update probe.
  See [storage.md](storage.md#updater) and [updates.md](updates.md).
- **Update probes** (`src/version-probe.ts` + its `-fetch` half, with
  `src/version-compare.ts`) — read the `@version` a script's
  `@updateURL` / `@downloadURL` declares and compare it with the copy
  we run. Reporting only: the install source stays the update channel.
  See [updates.md](updates.md).
- **Collection I/O** (`src/directories.ts` + `src/github-provider.ts`) —
  `file://` fetcher, directory-listing parser, recursive `*.user.js`
  scanner, `http(s)://` fetcher, JSON manifest parser, and the GitHub
  provider (URL parsing, blob→raw rewrite, Contents-API scanner) which
  lives in its own module and is dispatched to from `directories.ts`.
  See [file-access.md](file-access.md) and
  [http-collections.md](http-collections.md).
- **File-access permission UI** (`src/file-access.ts`) — the
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
  `@match`/`@include`/`@exclude` evaluator. See
  [matching.md](matching.md).
- **Match index** (`src/match-index.ts`) — in-memory cache of every
  `ok` script's matching info, kept in sync with storage; lets the SW
  find matches without per-navigation storage reads. See
  [matching.md](matching.md).
- **Injector** (`src/injector.ts`) — keeps `chrome.userScripts`'s
  registration set in sync with the enabled-`ok` script set, and wraps
  every body with an activation/error shim. Specs Chrome refuses are
  recorded in `src/script-rejection.ts`, which is what the UI renders
  as REJECTED. See [injection.md](injection.md).
- **Userscript viewer** (`src/userscript.html` + `src/userscript.ts`)
  — per-script page with two modes: an installed script rendered from
  the store, and a preview of one that isn't installed yet (the landing
  spot for install capture and a single-script Add). Its details
  panel (`src/script-details.ts`), tabbed code view
  (`src/code-tabs.ts`), and code linkifier (`src/code-links.ts`) are
  separate modules so both modes render identically. See
  [script-viewer.md](script-viewer.md).
- **Log IDs** (`src/script-log-id.ts`) — assigns each script a short
  file-derived label (basename, with `#N` suffix on dupes) used in
  every SW log line and shown in the collections/viewer UI so users can
  correlate console output with the rows on the collections page. See
  [logging.md](logging.md).
- **Display names** (`src/script-display.ts`) — one place decides how
  a stored URL or path is rendered for humans: percent-decoded for
  display, left encoded for anything functional. See
  [names-and-paths.md](names-and-paths.md).
- **Debug logging** (`src/debug-log.ts`) — gates the noisier
  navigation/refresh log lines behind a storage-backed flag
  (`smDebugLogging`), toggled via a checkbox on the Options page
  (linked from the top of the collections page).
- **Per-script event log** (`src/script-log.ts`) — structured per-
  script log of refresh outcomes and wrapper reports, stored in
  `chrome.storage.session` and surfaced through the viewer's Log
  tab. `src/log-format.ts` renders it — the tab's cells and the CSV
  its Save / Copy buttons hand out. See
  [script-log.md](script-log.md).
- **GM_* catalog** (`src/gm-api-catalog.ts`) — data-only inventory
  of every supported `GM_*` / `GM.*` API: name, alias, sync/async
  kind, subsystem, optional `requires` (e.g. `@connect`).
  `resolveGrants` canonicalizes a script's `@grant` lines into the
  set we'll emit bindings for. See [GM-APIs.md](GM-APIs.md).
- **GM_* binding emitter** (`src/gm-bindings.ts`) — pure compiler.
  Given a script's resolved grants + parsed header, returns the JS
  source spliced into the main-body wrap function at register time.
  Emits real bodies for every catalog entry except `unsafeWindow`
  (a passthrough binding); the `notImplemented` stub remains only
  as a fall-through for future catalog additions whose bodies
  haven't landed yet.
- **GM_* page-side runtime** (`src/wrapper-gm-runtime.js`) —
  USER_SCRIPT-world helper registered once per page (alongside the
  MAIN-world bridge). Installs `window.__SM_GM__` with per-subsystem
  helpers: storage cache + batched writes, DOM injection, clipboard,
  XHR start/abort with terminal-event dispatch, value-change
  listener registry. Captures a small shim cache of native
  references at init time so sibling userscripts that monkey-patch
  builtins can't subvert GM calls.
- **GM_* SW storage** (`src/gm-values.ts`) — persistent
  `gmval:<scriptId>:<key>` rows in `chrome.storage.local`, with
  batched apply (last-write-wins) and a per-script wipe helper.
- **GM_* SW XHR runner** (`src/gm-xhr.ts`) — `fetch` driver with
  `AbortController` + timeout, text / JSON / binary response shapes
  (binary serialized to base64 for the page-side wire). See the
  XHR section of [GM-APIs.md](GM-APIs.md).
- **XHR header surgery** (`src/gm-xhr-headers.ts`) — lets a script set
  request headers the browser forbids, by compiling them into a
  short-lived `declarativeNetRequest` session rule around the fetch.
  See [xhr-header-surgery.md](xhr-header-surgery.md).
- **@connect URL gating** (`src/gm-connect.ts`) — parses `@connect`
  lines into rules (`*`, `self`, exact, subdomain), resolves `self`
  against the script's `@match`/`@include` hosts, and gates
  `GM_xmlhttpRequest` URLs before fetch.
- **GM_openInTab dispatcher** (`src/gm-tab.ts`) — opens new tabs via
  `chrome.tabs.create` on behalf of userscripts; tracks the per-request
  (page-generated id ↔ assigned chrome tab id ↔ originator tab) mapping
  so `chrome.tabs.onRemoved` can route close events back to the
  originating tab's `onclose` callback.
- **GM_download dispatcher** (`src/gm-download.ts`) — drives
  `chrome.downloads` on behalf of userscripts for `http(s)` URLs
  (`blob:` / `data:` downloads stay in the page); tracks the
  per-request mapping so completion, interrupt, timeout, and polled
  progress events route back to the originating tab.
- **GM_notification dispatcher** (`src/gm-notification.ts`) — wraps
  `chrome.notifications.create` and maps the chrome-assigned
  notification id back to the originating tab + request id so
  `onClicked` / `onClosed` events route to the userscript's
  `onclick` / `ondone` callbacks.
- **window.onurlchange driver** (`src/gm-url-change.ts`) — forwards
  `chrome.webNavigation`'s same-document navigation events to the
  frame that changed, which is the only way an isolated-world script
  can observe the page's own `pushState`. See the
  `window.onurlchange` section of [GM-APIs.md](GM-APIs.md).
- **window.close / window.focus driver** (`src/gm-window-control.ts`)
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
  - Pages naming a script put the script first, so it survives a narrow
    tab strip: the raw-source tab is `<basename> | SourceMonkey`, and
    the viewer pivots the same way — see
    [script-viewer.md](script-viewer.md#heading-and-page-title).
  - `offscreen.html` and `parse-sandbox.html` are exempt: no user ever
    sees them.
- `|`, not an em dash: it reads as a separator at a glance in a crowded
  tab strip, where an em dash reads as punctuation inside a sentence.

## Extension-page styling

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
- [matching.md](matching.md) — `@match`/`@include`/`@exclude`
  semantics, in-memory match index, per-tab badge + tooltip.
- [injection.md](injection.md) — `chrome.userScripts` registration
  lifecycle, the activation/error wrapper, opt-in requirements,
  unsupported pattern forms.
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
- [offline-validation.md](offline-validation.md) — the install-time
  checks as a command-line tool: how it runs the production pipeline
  outside a browser, the offline dependency root, and what the report
  groups. Findings over the GreasyFork corpus are in
  [corpus-validation-results.md](corpus-validation-results.md).
- [logging.md](logging.md) — SW console-message catalog, log IDs
  (basename + `#N` dupes), and the debug-logging gate.
- [names-and-paths.md](names-and-paths.md) — the decode-for-display
  rule for names and URLs, and where it must not be applied.
- [script-log.md](script-log.md) — per-script structured event log
  shown in the viewer's Log tab.
- [site-icons.md](site-icons.md) — origin extraction from `@match`,
  favicon fetch + cache, icon slot in the collections/viewer UI.
- [GM-APIs.md](GM-APIs.md) — `GM_*` / `GM.*` implementation: the
  catalog, page-side runtime, SW-side storage / XHR, `@connect`
  gating, and the per-API surface SourceMonkey ships.
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

- Wipes `dist/`.
- Copies `src/icons/`, `src/manifest.json`, every top-level
  `src/*.html`, and `node_modules/prismjs/*` into `dist/`.
- Inlines `src/glyph-sprite.svg` into each page as it is copied, at the
  page's `#include glyph-sprite` marker comment (see below).
- Invokes `tsc` (optionally with `--watch`) to compile
  `src/*.ts` → `dist/*.js`.

No bundler. Each TypeScript module compiles to its own `dist/*.js`
and Chrome loads them directly as ES modules.

### Glyph sprite

- Every inline SVG icon (the favicon placeholder, the two removal
  glyphs, the copy button's pair) is defined once in
  `src/glyph-sprite.svg` and referenced by `<use href="#id">`.
- It has to be *inlined per page*: a `<use>` pointing at another
  document doesn't inherit `currentColor`, and would be a second fetch.
  Keeping one copy in the source tree is what stops two pages from
  drifting into different glyphs.
- Only `--watch`ed TypeScript rebuilds automatically, so editing the
  sprite (like any HTML/CSS asset) needs a fresh `pnpm run build`.

## Testing

- Unit tests use the Node `--test` runner against compiled
  `dist/*.js`.
- E2E tests use Playwright. The fixture in
  `tests/fixtures/extension.ts` launches headless Chromium with the
  unpacked extension loaded from `dist/` and exposes the MV3 service
  worker so tests can drive the extension via
  `serviceWorker.evaluate(...)` — the toolbar action can't be clicked
  from Playwright in MV3.
