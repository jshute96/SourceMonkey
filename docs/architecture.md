# Architecture

SourceMonkey is a Manifest V3 Chrome extension that manages and injects
userscripts. This doc is the **high-level map only** — component
details live in the topic-specific docs linked below.

> **Status:** Matching + injection wired end-to-end; the `@require`
> pipeline prefetches and prepends required bodies; the `GM_*` /
> `GM.*` API surface covers storage (with cross-tab broadcast +
> value-change listeners), DOM injection (`GM_addStyle` /
> `GM_addElement`), clipboard, `GM_xmlhttpRequest` (text + binary)
> with `@connect` URL gating, `GM_notification`, `GM_openInTab`,
> `GM_log`, and `GM_registerMenuCommand` /
> `GM_unregisterMenuCommand` (rendered as indented entries under
> each script in the toolbar action's right-click menu). Deferred:
> XHR header surgery, `GM_cookie` (bindings stubbed). See
> [GM-APIs.md](GM-APIs.md) and [TODO.md](../TODO.md).

## Components

```
+------------------+        +-----------------------+        +---------------+
| Options page UI  |  -->   | background service    |  -->   | chrome.storage
| (options.html)   |        | worker (background.ts)|        |  .local       |
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
  Opens the options page on toolbar click, watches tab navigation,
  and surfaces per-tab match counts via the action badge. See
  [matching.md](matching.md).
- **Options page** (`src/options.html` + `src/options.ts`) — manage
  source directories and inspect per-script status. See
  [storage.md](storage.md).
- **Script store** (`src/script-store.ts`) — persistence layer + the
  load / refresh pipeline. Owns the chrome.storage.local schema. See
  [storage.md](storage.md).
- **Script updater** (`src/script-updater.ts`) — the single entry
  point every refresh path goes through. Manual Refresh buttons call
  it synchronously; the background SW calls it opportunistically when
  a tab uses some scripts. See [storage.md](storage.md#updater).
- **Source I/O** (`src/directories.ts` + `src/github-source.ts`) —
  `file://` fetcher, directory-listing parser, recursive `*.user.js`
  scanner, `http(s)://` fetcher, JSON manifest parser, and the GitHub
  provider (URL parsing, blob→raw rewrite, Contents-API scanner) which
  lives in its own module and is dispatched to from `directories.ts`.
  See [file-access.md](file-access.md) and
  [http-sources.md](http-sources.md).
- **File loader** (`src/file-loader.ts`) — resolves header references
  (`@icon`, `@require`, `@resource`) into absolute URLs against the
  script's parent dir (rejecting `..` and host-absolute paths), and
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
  - See [requires.md](requires.md) and
    [resources.md](resources.md).
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
  every body with an activation/error shim. See
  [injection.md](injection.md).
- **Userscript viewer** (`src/userscript.html` + `src/userscript.ts`)
  — per-script viewer page rendering content from the store. See
  [script-viewer.md](script-viewer.md).
- **Log IDs** (`src/script-log-id.ts`) — assigns each script a short
  file-derived label (basename, with `#N` suffix on dupes) used in
  every SW log line and shown in the options/viewer UI so users can
  correlate console output with the rows on the options page. See
  [logging.md](logging.md).
- **Debug logging** (`src/debug-log.ts`) — gates the noisier
  navigation/refresh log lines behind a storage-backed flag
  (`smDebugLogging`), toggled via a checkbox on the options page.
- **Per-script event log** (`src/script-log.ts`) — structured per-
  script log of refresh outcomes and wrapper reports, stored in
  `chrome.storage.session` and surfaced through the viewer's Log
  tab. See [script-log.md](script-log.md).
- **GM_* catalog** (`src/gm-api-catalog.ts`) — data-only inventory
  of every supported `GM_*` / `GM.*` API: name, alias, sync/async
  kind, subsystem, optional `requires` (e.g. `@connect`).
  `resolveGrants` canonicalizes a script's `@grant` lines into the
  set we'll emit bindings for. See [GM-APIs.md](GM-APIs.md).
- **GM_* binding emitter** (`src/gm-bindings.ts`) — pure compiler.
  Given a script's resolved grants + parsed header, returns the JS
  source spliced into the wrapper at register time. Emits real
  bodies for every catalog entry except `unsafeWindow` (a passthrough
  binding); the `notImplemented` stub remains only as a fall-through
  for future catalog additions whose bodies haven't landed yet.
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
- **@connect URL gating** (`src/gm-connect.ts`) — parses `@connect`
  lines into rules (`*`, `self`, exact, subdomain), resolves `self`
  against the script's `@match`/`@include` hosts, and gates
  `GM_xmlhttpRequest` URLs before fetch.
- **GM_openInTab dispatcher** (`src/gm-tab.ts`) — opens new tabs via
  `chrome.tabs.create` on behalf of userscripts; tracks the per-request
  (page-generated id ↔ assigned chrome tab id ↔ originator tab) mapping
  so `chrome.tabs.onRemoved` can route close events back to the
  originating tab's `onclose` callback.
- **GM_notification dispatcher** (`src/gm-notification.ts`) — wraps
  `chrome.notifications.create` and maps the chrome-assigned
  notification id back to the originating tab + request id so
  `onClicked` / `onClosed` events route to the userscript's
  `onclick` / `ondone` callbacks.

## Cross-cutting docs

- [storage.md](storage.md) — `chrome.storage.local` schema, status
  model, load/refresh pipeline, options-page table rendering.
- [file-access.md](file-access.md) — `file://` permissions, why we
  chose paths over the File System Access API, directory-listing
  enumeration, format caveats.
- [http-sources.md](http-sources.md) — `http(s)://` URL formats,
  scheme-agnostic manifest schema (works for local paths and
  file:// URLs too), conditional-GET update detection.
- [script-viewer.md](script-viewer.md) — userscript viewer page, header parsing,
  syntax highlighting.
- [matching.md](matching.md) — `@match`/`@include`/`@exclude`
  semantics, in-memory match index, per-tab badge + tooltip.
- [injection.md](injection.md) — `chrome.userScripts` registration
  lifecycle, the activation/error wrapper, opt-in requirements,
  unsupported pattern forms.
- [logging.md](logging.md) — SW console-message catalog, log IDs
  (basename + `#N` dupes), and the debug-logging gate.
- [script-log.md](script-log.md) — per-script structured event log
  shown in the viewer's Log tab.
- [site-icons.md](site-icons.md) — origin extraction from `@match`,
  favicon fetch + cache, icon slot in the options/viewer UI.
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

## Build pipeline

`scripts/build.mjs` is dependency-free:

- Wipes `dist/`.
- Copies `src/icons/`, `src/manifest.json`, every top-level
  `src/*.html`, and `node_modules/prismjs/*` into `dist/`.
- Invokes `tsc` (optionally with `--watch`) to compile
  `src/*.ts` → `dist/*.js`.

No bundler. Each TypeScript module compiles to its own `dist/*.js`
and Chrome loads them directly as ES modules.

## Testing

- Unit tests use the Node `--test` runner against compiled
  `dist/*.js`.
- E2E tests use Playwright. The fixture in
  `tests/fixtures/extension.ts` launches headless Chromium with the
  unpacked extension loaded from `dist/` and exposes the MV3 service
  worker so tests can drive the extension via
  `serviceWorker.evaluate(...)` — the toolbar action can't be clicked
  from Playwright in MV3.
