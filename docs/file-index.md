# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `TODO.md` | Roadmap of pending features and pending docs |
| `LICENSE` | MIT license text |
| `package.json` | Node project manifest, scripts, devDependencies |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `playwright.config.ts` | Playwright test runner config (e2e suite) |
| `.gitignore` | Git ignore rules |

## Local Claude Config (`.claude/`)

| File | Description |
|------|-------------|
| `.claude/settings.json` | Local dev settings — Bash permissions for `npm` commands |
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — `/codereview` then commit + push if clean |

## Build Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Clean `dist/`, copy icons + manifest + HTML + vendor (Prism), run `tsc` (optional `--watch`) |
| `scripts/serve-examples.mjs` | Local HTTP server for `tests/examples/`, including the `/__slow/?ms=N` delay route the `headers-run-at` demo needs |
| `scripts/make_manifest.sh` | Scan the current dir for `*.user.js` and emit a SourceMonkey HTTP-manifest JSON array to stdout (redirect to `script_manifest.json`) |
| `scripts/open-test-browser-with-SourceMonkey.sh` | Launch Chromium with the unpacked SM extension + CDP port 9222 for cross-manager Playwright runs |
| `scripts/open-test-browser-with-TamperMonkey.sh` | Launch Chromium with a persistent profile (TM installed manually) + CDP port 9223 for the TM Playwright project |
| `scripts/sync-tm-scripts.mjs` | Standalone CLI that connects to the running TM browser via CDP and installs/updates every `*.user.js` under `tests/examples/` |
| `scripts/e2e-tm-preflight.mjs` | Pretest gate for `test:e2e:tm` / `:headed` — checks CDP 9223 and either launches the TM browser or asks the user to close it |
| `scripts/inspect-tm-dashboard.mjs` | Diagnostic: dumps every visible row on the TM dashboard with cell classes — use when listInstalled selectors stop working |
| `scripts/inspect-tm-install.mjs` | Diagnostic: drives one TM install and dumps the confirmation-page buttons — use when the Install-button selector stops working |
| `scripts/validate-userscripts.mjs` | CLI that runs the install-time checks (header, `@require`/`@resource`, parse) over files on disk, with an offline dependency root |
| `scripts/parse-check-node.mjs` | Node counterpart of the sandboxed parse check: `new Function` verdict plus `vm.Script` location probes |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | MV3 extension manifest |
| `src/parse-check.ts` | SW side of the compile-only parse check — offscreen lifecycle, batching, fails open when unavailable |
| `src/parse-check-protocol.ts` | Parse-check wire types plus the session-storage off-switch every checker reads |
| `src/parse-location.ts` | Picks between the sandbox's two location probes and maps the reported line back to the file it was written in |
| `src/diagnostic-location.ts` | Shared `{file, line?, column?}` shape every content-derived verdict carries, plus the one phrasing surfaces render it with |
| `src/parse-check-client.ts` | Page-side parse checker — embeds its own sandbox frame and compiles there, no service worker involved |
| `src/parse-sandbox-host.ts` | Drives a sandboxed parse frame over postMessage: readiness, timeouts, verdict validation, circuit breaker |
| `src/parse-sandbox.ts` | Sandboxed-page compile probe — `new Function` per source, plus the `<script>` probes that locate the error |
| `src/parse-sandbox.html` | Sandboxed page (manifest `sandbox.pages`) — the only context allowed `'unsafe-eval'` / `'unsafe-inline'` |
| `src/offscreen.ts` | Offscreen-document relay: the DOM the service worker lacks, hosting a sandboxed parse frame |
| `src/offscreen.html` | Offscreen document markup — hosts the sandboxed parse iframe |
| `src/background.ts` | Service worker entrypoint; per-tab badge + action menu wiring, sm:* listener, injector + match-index bootstrap, first-run sources-page open |
| `src/deep-link.ts` | `webNavigation` listener: rewrites the GitHub `redirect-page.md` URL to the matching `chrome-extension://…` page |
| `src/install-capture.ts` | Captures http(s) + file:// navigations to `*.user.js` and redirects them to the viewer's preview mode |
| `src/raw-view.ts` | Session-storage hand-off (`rawview:` rows) that carries a fetched script from the viewer's preview to its raw-source tab |
| `src/raw.html` | Raw-source page markup: a single `<pre>` styled monospace, titled with the script's filename once loaded |
| `src/raw.ts` | Raw-source controller — reads the handed-off text by `?key=`, sets the document title, renders via `textContent` |
| `src/sources.html` | Sources page markup: Options button, path-entry form, file-access banner slot, directory list |
| `src/sources.ts` | Sources page controller — render, in-place updates, repaint-from-storage on change, `?refresh`/`?add_source`/`?first_run` triggers |
| `src/options.html` | Options page markup: settings list (link-capture toggle, debug-logging toggle, GitHub auth token) plus a link back to the sources page |
| `src/options.ts` | Options page controller — binds the boolean setting checkboxes (link capture, debug logging) + GitHub-token controls (save / clear / reveal) |
| `src/userscript.html` | Userscript viewer markup: controls row, banner slot + preview actions, details panel, tab strip, code box, log pane |
| `src/userscript.ts` | Userscript viewer controller — installed mode (`?script=`), preview mode (`?preview=`), live `storage` watchers, log pane |
| `src/script-details.ts` | Builds the viewer's details `<dl>` (header fields, permissions, source/location/size/status) for both viewer modes |
| `src/code-tabs.ts` | Tabbed code view: tab strip, Prism pane, lazy tab bodies, line highlight, gutter clicks, `#file:line:col` hash sync |
| `src/code-links.ts` | Linkifies a Prism-highlighted code block (header-tag values + bare URLs) and builds the shared open-in-new-tab anchor |
| `src/prism-userscript.ts` | Side-effect module: teaches Prism the `// ==UserScript== …` metadata block so it renders as a tinted band |
| `src/directories.ts` | Source I/O + classifiers (single-file / manifest / github-dir / container), input canonicalizer, file:// + http(s) fetch, listing parser, recursive scanner, manifest parser, URL helpers |
| `src/file-access.ts` | "Allow access to file URLs" probe plus the shared "File access is disabled." banner and its chrome://extensions link |
| `src/github-source.ts` | GitHub-only provider integration: URL parsing, default-branch resolution, blob→raw rewrite, Contents-API recursive dir scanner, per-script raw/display URL builders |
| `src/github-auth.ts` | Persisted GitHub PAT cache + `githubAuthHeaders(url)` host-gated helper for attaching `Authorization: Bearer …` to api/raw/github.com-raw fetches |
| `src/source-scan.ts` | Cycle-neutral scan primitives shared by `directories.ts` and `github-source.ts` |
| `src/script-store.ts` | Persistent userscript store (chrome.storage.local) plus load/refresh pipeline, container-source dispatch in addSource, parse-time diagnostics, refreshAllSources, first-run flag + DEFAULT_SOURCES |
| `src/script-updater.ts` | Single entry point for refresh; rate-limits opportunistic background checks, and mirrors every load/refresh outcome into the per-script Log |
| `src/script-display.ts` | Pure display helpers: size/status formatting + the decode-for-display name/path helpers |
| `src/version-compare.ts` | Pure `@version` ordering (dotted segments, numeric-aware, prerelease tails) + the newer/older/same verdict |
| `src/version-probe.ts` | Pure probe logic: pick the `@updateURL`/`@downloadURL` targets we don't load from, judge staleness + outdated verdict |
| `src/version-probe-fetch.ts` | Fetching half of update probes — reads a probe URL's `@version`, bounded size/timeout/concurrency |
| `src/source-display.ts` | Source-display helpers: type classification (incl. container kinds), display-name inference, manifest flag, anchor id, plus the colored type-bubble builder |
| `src/styles.css` | Cross-page shared stylesheet linked by every extension page; today carries the source-type bubble, display-name, and warning-banner rules |
| `src/script-links.ts` | Pure helpers for the viewer's link rendering: URL/text tokenizer, header-tag classifier sets, `// @tag value` line parser |
| `src/stack-link.ts` | Pure stack-ref helpers: `parseStackRefs` splits a log message into text + `{url, line, col}` runs; `displayRefText` decodes our own URLs for reading |
| `src/script-source-url.ts` | Canonical `sourcemonkey://SourceMonkey/…` URL builders for every `{code}` entry — main, config, prelude, require, plus page-wide bridge / GM runtime |
| `src/script-url-hash.ts` | Pure `parseHash` / `buildHash` for the viewer's `#<filename>[:<line>[:<col>]]` / `#Log` URL fragment |
| `src/userscript-header.ts` | Parser for the `// ==UserScript== … // ==/UserScript==` metadata block + header/body splitter, with per-tag line numbers |
| `src/url-match.ts` | Pure URL-matching predicate for `@match` / `@include` / `@exclude` patterns, plus the `@match` grammar check and its lenient rewrites |
| `src/match-index.ts` | In-memory cache of injectable scripts' matching info, kept in sync with `chrome.storage.local` |
| `src/injector.ts` | Syncs the enabled script set into `chrome.userScripts` and wraps each body with an activation/error shim |
| `src/composed-source.ts` | Concatenates `@require` bodies ahead of the script body; owns the injected entry's line layout for both run paths |
| `src/tab-status.ts` | Pure helpers for per-tab badge view (expected ∪ actual classification, color, row-label formatter) and per-tab document LRU (bfcache restore) |
| `src/debug-log.ts` | Debug-logging gate for verbose lifecycle messages; off by default, toggled via `chrome.storage.local.smDebugLogging` |
| `src/bytes.ts` | Shared byte helpers: `sha256Hex` (content/file hashes) and chunked `bytesToBase64` (XHR + `@resource` transport) |
| `src/script-log-id.ts` | Computes a per-script "log ID" (basename, with `#N` suffix on dupes) used in every log line + the sources/viewer UI |
| `src/script-log.ts` | Per-script event log store: chrome.storage.session keyed by script ID, serialized appends with a fixed cap, plus a sibling `loglevel:` sentinel |
| `src/script-rejection.ts` | Session-storage record of registrations `chrome.userScripts` refused, plus the one sentence every surface reports it with |
| `src/match-targets.ts` | Pure `@match` pattern → `{origin, linkUrl}` extractor; shared by site-icon and the viewer linkifier |
| `src/site-icon.ts` | Site-favicon discovery, `@icon`-header override, and the slot renderer used by both sources page and viewer |
| `src/file-loader.ts` | Resolves header refs (`@icon`, `@require`, `@resource`) against the script's parent dir with traversal rejection; scheme-aware byte + text fetcher reporting why it failed; `.js` suffix gate |
| `src/external-files.ts` | `@require` + `@resource` orchestrator: resolve, fetch, dedup (cross-script + cross-kind), attach typed entries, word the failures |
| `src/userscript-prelude.js` | Static per-world prelude (matcher, check-pending round-trip, @run-at gate, async-error listeners); minified to WRAPPER_PRELUDE and spliced into each script's js[] as a `{code}` entry |
| `src/wrapper-bridge.js` | USER_SCRIPT-world bridge that forwards `window.postMessage` sm:* events from MAIN-world wrappers to the SW |
| `src/gm-api-catalog.ts` | Catalog of supported `GM_*` / `GM.*` APIs: name, async/sync kind, subsystem; helpers for resolving `@grant` lines |
| `src/gm-bindings.ts` | Per-script `GM_*` / `GM.*` binding emitter — generates compile-in `const GM_X = ...` source spliced into the wrapper |
| `src/source-map.ts` | Source Map v3 generator for the concatenated injection entry, plus the reverse lookup the Log tab maps stack refs with |
| `src/wrapper-gm-runtime.js` | USER_SCRIPT-world shared runtime — installs `window.__SM_GM__` (shim cache, async sendMessage helper, storage cache + batched writes) |
| `src/gm-values.ts` | SW-side persistent storage for `GM_*` values — `gmval:<scriptId>:<key>` rows in `chrome.storage.local`, batched writes |
| `src/gm-xhr.ts` | SW-side `GM_xmlhttpRequest` runner — fetch + AbortController, text/json/blob/arraybuffer/document, timeout |
| `src/gm-connect.ts` | `@connect` URL-gating helpers — parse rules, extract self hosts from `@match`/`@include`, check URL, phrase the denial |
| `src/gm-tab.ts` | SW-side `GM_openInTab` dispatcher (`chrome.tabs.create` + per-request mapping for close-event routing) |
| `src/gm-notification.ts` | SW-side `GM_notification` dispatcher (`chrome.notifications.create` + per-request mapping for click/close routing) |
| `src/gm-originator-map.ts` | Shared shed-on-tab-close helper for the gm-tab / gm-notification per-request maps (drop entries by originator tab) |
| `src/gm-menu.ts` | SW-side `GM_registerMenuCommand` per-(tab, script) command registry feeding the action menu |
| `src/action-menu.ts` | Action context-menu planner — packs script + command groups into Chrome's 6-item cap with a "More" overflow submenu |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (placeholder) |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: launches Chromium with the extension, exposes SW handle, HTTP fixture server, and the `sm` SW-api proxy |
| `tests/fixtures/manager.ts` | Manager-agnostic Playwright fixture for the examples suite — picks SM (launchPersistentContext) or TM (CDP attach) per project metadata |
| `tests/fixtures/sourcemonkey-launch.ts` | Shared Chromium-launch / SW-handle / HTTP-fixture-server helpers used by both `extension.ts` and `manager.ts` |
| `tests/fixtures/slow-route.mjs` | `/__slow/?ms=N` delay-route handler + static content-types, shared by the Playwright fixture server and `scripts/serve-examples.mjs` |
| `tests/fixtures/tampermonkey-driver.mjs` | TM dashboard driver: parses local `*.user.js` headers, lists installed scripts off the dashboard, installs/updates via the import-from-file flow |
| `tests/fixtures/extension-id.ts` | Computes Chrome's deterministic unpacked-extension ID from an absolute path |
| `tests/fixtures/bad-script-cases.mjs` | Expected status / message / error line for every `tests/bad-examples/` file, shared by the e2e spec and the CLI test |
| `tests/fixtures/scripts-dir.ts` | Tmp-dir helper that writes real `*.user.js` files on disk for the production scan/fetch pipeline to ingest |
| `tests/fixtures/userscript-server.ts` | Per-test HTTP server with mutable userscript / manifest routes and conditional-GET handling |
| `tests/fixtures/sw-api.ts` | Typed wrapper over the `self.SourceMonkey` SW test surface plus a generic `waitFor` polling helper |
| `tests/fixtures/pages/blank.html` | Minimal fixture page served by the in-test HTTP server |
| `tests/fixtures/pages/target.html` | Fixture page with a known `#target` element for injection assertions |
| `tests/fixtures/pages/other.html` | Fixture page used to verify scripts skip non-matching URLs |
| `tests/fixtures/pages/run-at.html` | Fixture page with a slow-blocker script + `#log` list used by the @run-at readyState-window test |
| `tests/e2e/smoke.spec.ts` | Smoke test: SW loads, sources page renders, fixture server responds |
| `tests/e2e/injection.spec.ts` | End-to-end userscript injection: matching, non-matching, lenient-`@match`, and multiple-script cases |
| `tests/e2e/badge.spec.ts` | Per-tab badge classifications: green/red/orange/purple plus MISSING and post-update RELOAD |
| `tests/e2e/reload-fast-path.spec.ts` | Reload triggers sm:check-pending → swap to fresh body on this reload; non-reload navs don't swap |
| `tests/e2e/sources.spec.ts` | Source lifecycle (add/refresh/remove) via the real file:// scan pipeline |
| `tests/e2e/live-updates.spec.ts` | Live watchers: sources page + viewer follow `storage.local` writes from another origin without a reload (issue #10) |
| `tests/e2e/container-sources.spec.ts` | Container-source lifecycle: auto-create / reuse on add, duplicate rejection, refresh refetches every child |
| `tests/e2e/manifest.spec.ts` | Manifest source refresh: vanished-entry deletion, unreadable-manifest preservation |
| `tests/e2e/options.spec.ts` | Options-page UI flows: add-directory form, Remove button, per-script toggle |
| `tests/e2e/site-icons.spec.ts` | E2E tests for the favicon slot: DOM contract, `@icon` override, relative-path resolution, two-tier cache, large-icon blob-URL de-dup |
| `tests/e2e/missing-trash.spec.ts` | Per-row trash button on missing scripts: removes only the clicked row, leaves siblings + the OK row intact |
| `tests/e2e/change-detection.spec.ts` | Unified change-detection: each source/scheme combo preserves loadedAt on identical content and bumps it on edits |
| `tests/e2e/rejected-registration.spec.ts` | REJECTED state end to end: a `@match` Chrome refuses stays `ok` but never runs, and every retry re-reports until it's fixed |
| `tests/e2e/refresh-failed.spec.ts` | Refresh failures (HTTP soft 200-not-a-script, hard 404) keep the prior good copy running with `refreshError`, and land in the script's Log once |
| `tests/e2e/install-capture.spec.ts` | E2E for the `.user.js` capture: redirect to the preview, Install registers the source, already-installed + non-userscript cases, raw view, option off |
| `tests/e2e/install-capture-file.spec.ts` | E2E for the `file://` half of the capture: preview takeover, bare-path install + refresh, dedup, bypass paths |
| `tests/e2e/file-access-banner.spec.ts` | "File access is disabled." banner with the toggle probe stubbed off: where it appears, where it must not, and that a good Refresh clears it |
| `tests/e2e/script-preview.spec.ts` | E2E for the viewer's preview mode: Add Source install, Update, invalid-header refusal, `@require` tabs |
| `tests/unit/sample.test.mjs` | Placeholder Node `--test` unit test |
| `tests/unit/directories.test.mjs` | Unit tests for the `file://` listing parser and path/URL helpers |
| `tests/unit/github-source.test.mjs` | Unit tests for the GitHub provider: URL parsing, blob→raw rewrite, default-branch resolution, Contents-API directory scanner |
| `tests/unit/github-auth.test.mjs` | Unit tests for the GitHub auth helper: host-gated `Authorization` header, no token → no header, never leaks to non-GitHub hosts |
| `tests/unit/userscript-header.test.mjs` | Unit tests for the metadata-block parser + header/body splitter |
| `tests/unit/script-store.test.mjs` | Unit tests for the pure helpers in the script store (merge, validate, build) |
| `tests/unit/script-updater.test.mjs` | Unit tests for the updater's rate-limit / concurrency gate, its Log-tab outcome entries, and the startup replay |
| `tests/unit/script-display.test.mjs` | Unit tests for the size/status display helpers (incl. MISSING label) + the name/path decode helpers |
| `tests/unit/version-compare.test.mjs` | Unit tests for `@version` ordering: numeric segments, missing tails, prereleases, empty input |
| `tests/unit/version-probe.test.mjs` | Unit tests for probe target selection, the outdated verdict, and the staleness gate |
| `tests/e2e/version-probe.spec.ts` | E2E for update probes: newer/older upstream, unreachable probe, own-URL skip, OUTDATED status + viewer rows |
| `tests/unit/source-display.test.mjs` | Unit tests for source-display helpers: type classification, manifest flag, short-name inference, effective display name |
| `tests/unit/script-links.test.mjs` | Unit tests for the viewer link helpers: URL/text tokenizer + `// @tag value` line parser + header-marker detectors |
| `tests/unit/stack-link.test.mjs` | Unit tests for `parseStackRefs` (URL + line/col extraction, query strings, ports) and `displayRefText` (which URLs decode) |
| `tests/unit/script-source-url.test.mjs` | Unit tests for the canonical `sourcemonkey://SourceMonkey/…` URL builders — every URL shape, plus label encoding (dedup `#N`, spaces, emoji) |
| `tests/unit/script-url-hash.test.mjs` | Unit tests for `parseHash` / `buildHash`: filename/line/col forms, percent encoding, round-trip, and invalid-input fallbacks |
| `tests/unit/code-tabs.test.mjs` | Unit tests for `expandToVisualColumn`: tab-stop expansion of a V8 stack column, and out-of-range clamping |
| `tests/e2e/script-viewer-links.spec.ts` | E2E tests for the viewer's link rendering: Match-row anchors, Location anchor, body header `@match` / URL linkification |
| `tests/unit/script-log-id.test.mjs` | Unit tests for `computeLogIds` (bare basename when unique, `#N` suffixes when dupes share a basename) |
| `tests/unit/script-log.test.mjs` | Unit tests for the per-script log store: append/get/clear, concurrent appends, LOG_CAP rotation |
| `tests/unit/url-match.test.mjs` | Unit tests for `@match` / `@include` / `@exclude` URL matching |
| `tests/unit/match-targets.test.mjs` | Unit tests for `@match` pattern parsing: origin / linkUrl extraction and the wildcard-trim path rule |
| `tests/unit/site-icon.test.mjs` | Unit tests for the icon-specific helpers: `@icon`-header extraction, `<link rel="icon">` parsing + scoring, cache-hit rules, `data:`→Blob decode |
| `tests/unit/parse-sandbox-host.test.mjs` | Unit tests for `isParseVerdict` — only the three real statuses pass, so an odd reply can't read as `invalid` |
| `tests/unit/parse-location.test.mjs` | Unit tests for probe selection and line mapping, driven by positions Chromium really reported |
| `tests/unit/parse-check-node.test.mjs` | Unit tests for the Node parse checker: verdict, both probes' positions, and the two probe-selection routes |
| `tests/unit/validate-userscripts.test.mjs` | Drives the validator CLI as a subprocess over the example suites plus a hand-built offline tree |
| `tests/unit/diagnostic-location.test.mjs` | Unit tests for the diagnostic label + validator, especially what they do with a partial location |
| `tests/unit/file-loader.test.mjs` | Unit tests for ref resolution (schemes, relative paths, traversal) and for the reason each resolve/fetch failure reports |
| `tests/unit/external-files.test.mjs` | Unit tests for `distillRequires`/`distillResources` + `attachFiles` (cache hits, preserve, dedup, UTF-8, cross-kind) and the failure wording |
| `tests/e2e/parse-check.spec.ts` | The parse-check mechanism: compiles without executing, judges as a function body, catches join-only conflicts |
| `tests/e2e/parse-check-install.spec.ts` | Install/refresh-time parse failures surface as `invalid`, and healthy scripts stay `ok` |
| `tests/e2e/parse-check-pages.spec.ts` | The parse check holds on page-driven paths: the install preview's warning, Install, Refresh, Refresh All |
| `tests/e2e/requires.spec.ts` | End-to-end `@require` coverage: file:// / HTTP relative path prefetch, `.js` suffix + traversal rejection, cross-script dedup, manual-vs-opportunistic refresh policy |
| `tests/e2e/log-stack-mapping.spec.ts` | Log tab maps `err.stack` lines back to the `@require`/body they came from, and clicks land on that line |
| `tests/unit/injector.test.mjs` | Unit tests for the injector: spec build, active-spec collection, refusal logging, retry limits, sync serialization |
| `tests/unit/generated-wrappers.test.mjs` | Guard test: each minified wrapper (`WRAPPER_*`) is a single line of valid JS with load-bearing tokens intact |
| `tests/unit/source-map.test.mjs` | Unit tests for VLQ encoding, line-level mappings, and inline-map encoding |
| `tests/unit/gm-api-catalog.test.mjs` | Unit tests for the GM_* / GM.* catalog: lookup, alias resolution, `@grant` canonicalization, `none` precedence |
| `tests/unit/gm-bindings.test.mjs` | Unit tests for the per-script GM_* / GM.* binding emitter — granted output, sync stub routing, async sendMessage envelope, GM4 alias shape |
| `tests/unit/gm-values.test.mjs` | Unit tests for the SW-side `gmval:` storage helpers — key composition, batch apply with last-write-wins, sentinel deletes, namespace isolation |
| `tests/e2e/gm-grants.spec.ts` | E2E tests: `@grant` gating, ungranted APIs return undefined, GM_info shape, `GM.` alias namespace, `GM.setValue` granted form |
| `tests/e2e/gm-storage.spec.ts` | E2E tests for `GM_setValue`/`GM_getValue`/`GM_deleteValue`/`GM_listValues` round-trip, persistence across reloads, per-script namespace isolation, `GM.` promised forms |
| `tests/e2e/gm-dom.spec.ts` | E2E tests for `GM_addStyle` / `GM_addElement` — CSS application, tag-aware default parent (head/body), explicit-parent form, GM4 alias, permission gating |
| `tests/e2e/gm-clipboard.spec.ts` | E2E tests for `GM_setClipboard` via `navigator.clipboard.writeText` — text round-trip, GM4 alias, permission gating |
| `tests/e2e/gm-broadcast.spec.ts` | E2E tests for cross-tab `GM_setValue` broadcast — write in tab A is visible in tab B; originator doesn't echo |
| `tests/e2e/gm-storage-freshness.spec.ts` | E2E: fresh documents see the latest `GM_setValue` (same-tab nav, fresh tab, write-then-navigate race) |
| `tests/e2e/gm-storage-read-leak.spec.ts` | E2E: a page-forged bridge `sm:check-pending` can't read another script's `GM_setValue` snapshot (`__viaBridge` gate) |
| `tests/e2e/gm-value-listeners.spec.ts` | E2E tests for `GM_addValueChangeListener` / `GM_removeValueChangeListener` — local fire with remote=false, delete fire, remove-by-id, cross-tab remote=true, permission gating |
| `tests/e2e/gm-xhr.spec.ts` | E2E tests for `GM_xmlhttpRequest` text path — GET text, JSON, POST body, HTTP errors firing onload, network failure → onerror, abort, permission gating |
| `tests/e2e/gm-xhr-binary.spec.ts` | E2E tests for `GM_xmlhttpRequest` binary path — arraybuffer/blob/document via base64 wire reconstruction |
| `tests/e2e/gm-connect.spec.ts` | E2E tests for `@connect` gating — no-connect blocked, matching exact allowed, `*` wildcard, subdomain match, mismatched host blocked |
| `tests/unit/gm-connect.test.mjs` | Unit tests for `@connect` parsing/matching — wildcard, self, exact, subdomain, scheme-prefixed normalization, malformed entries |
| `tests/unit/gm-tab.test.mjs` | Unit tests for the `GM_openInTab` SW dispatcher (mapping, close routing, originator cleanup) |
| `tests/unit/deep-link.test.mjs` | Unit tests for `buildDeepLinkTarget` — URL prefix match, allowlist, passthrough params, null on bad input |
| `tests/unit/install-capture.test.mjs` | Unit tests for the `.user.js` capture helpers: URL predicate, install-page URL, Chrome-version gate, one-shot bypass |
| `tests/unit/raw-view.test.mjs` | Unit tests for the raw-view hand-off: key shape, round-trip, drop, and rejection of keys we didn't mint |
| `tests/unit/action-menu.test.mjs` | Unit tests for the action context-menu planner: 6-item cap, More-submenu overflow, group cohesion, order preservation |
| `tests/unit/gm-notification.test.mjs` | Unit tests for the `GM_notification` SW dispatcher (mapping, click/close terminality, timeout auto-clear) |
| `tests/e2e/gm-log.spec.ts` | E2E tests for `GM_log` (per-script prefix, GM4 alias, gating) |
| `tests/e2e/gm-open-in-tab.spec.ts` | E2E tests for `GM_openInTab` (URL, call shapes, onclose, gating) |
| `tests/e2e/gm-notification.spec.ts` | E2E tests for `GM_notification` (call shapes, Promise return, empty-text rejection, gating) |
| `tests/e2e/gm-menu.spec.ts` | SM-only E2E for `GM_registerMenuCommand` via the SW test surface |
| `tests/unit/tab-status.test.mjs` | Unit tests for the per-tab badge classification + report-merge helpers |
| `tests/examples/README.md` | Overview of the interactive GM-API example pages; how to serve and use as a cross-manager compliance reference |
| `tests/examples/index.html` | Index page linking the per-API example subdirs |
| `tests/examples/examples.css` | Shared styling for all example pages |
| `tests/examples/<api>/` | Each example dir holds `<api>.html`, `<api>.user.js`, and `<api>.spec.ts` — the page, the userscript that drives it, and its Playwright e2e |
| `tests/examples/gm-info/` | `GM_info` dump example |
| `tests/examples/gm-log/` | `GM_log` per-script-prefix demo |
| `tests/examples/gm-storage/` | `GM_setValue`/`getValue`/`deleteValue`/`listValues` examples (form-driven) |
| `tests/examples/gm-value-listeners/` | `GM_addValueChangeListener` / `GM_removeValueChangeListener` examples |
| `tests/examples/gm-dom/` | `GM_addStyle` and `GM_addElement` DOM-injection examples |
| `tests/examples/gm-clipboard/` | `GM_setClipboard` round-trip example |
| `tests/examples/gm-xmlhttp/` | `GM_xmlhttpRequest` form-driven example (method, body, responseType, abort) |
| `tests/examples/gm-open-in-tab/` | `GM_openInTab` call-shape examples (active, background, positional, onclose) |
| `tests/examples/gm-notification/` | `GM_notification` call-shape examples (button-driven) |
| `tests/examples/gm-menu/` | `GM_registerMenuCommand` / `GM_unregisterMenuCommand` button-driven examples |
| `tests/examples/gm-resource/` | `GM_getResourceText` / `GM_getResourceURL` examples reading prefetched CSS, JSON, and SVG `@resource` files |
| `tests/examples/headers-run-at/` | `@run-at` header example with one userscript per value (`document-start`/`-end`/`-idle`) on a shared page |
| `tests/examples/headers-inject-into/` | `@inject-into` header example: MAIN-world (`page`) vs USER_SCRIPT-world (`content`) userscripts showing window-isolation |
| `tests/examples/require-scope/` | `@require` scope example: a shared lib's top-level class/const/function reaching both injection worlds |
| `tests/examples/xmlhttp-denied/` | Negative cases for `@connect`: scripts with no `@connect`, mismatched host, and explicit allow show blocked-vs-allowed outcomes |
| `tests/bad-examples/` | Deliberately broken `*.user.js` files (plus the `@require` libraries some of them need, and the ones that merely warn) for the SM-only spec; outside `tests/examples/` so the TM loader doesn't see them |
| `tests/e2e/bad-scripts.spec.ts` | SM-only e2e: each bad script gets the expected status, error location, and byte-for-byte viewer render |
| `tests/e2e/diagnostic-links.spec.ts` | Clicking a diagnostic's location jumps to the file and line, in the installed viewer and the install preview |

## GreasyFork Corpus Tooling (`tests/greasyfork-examples/`)

Standalone tooling, not a test suite — see `docs/testing.md`.

| File | Description |
|------|-------------|
| `tests/greasyfork-examples/README.md` | Full pipeline docs: saving the Cloudflare-gated listing pages, downloading, the database schema, and the reports |
| `tests/greasyfork-examples/greasyfork-dump/` | Hand-saved GreasyFork listing pages, the input to `fetch-top-scripts.mjs` (gitignored) |
| `tests/greasyfork-examples/fetch-top-scripts.mjs` | CLI that parses hand-saved GreasyFork listing pages into a top-scripts CSV (installs, ratings, dates, code URL) |
| `tests/greasyfork-examples/top-scripts.csv` | Extracted top 2000 GreasyFork scripts by total installs — the checked-in source of truth |
| `tests/greasyfork-examples/download-scripts.mjs` | CLI that downloads the CSV's userscripts plus their `@require` / `@resource` dependencies into a URL-shaped tree |
| `tests/greasyfork-examples/files/` | Downloaded userscripts, `@require` libraries, and `@resource` assets at `<host>/<url-path>` (gitignored) |
| `tests/greasyfork-examples/download-report.json` | Last download run's counts, dead links, and failed URLs (gitignored) |
| `tests/greasyfork-examples/corpus.mjs` | Shared corpus helpers: CSV parsing plus the URL↔on-disk-path mapping both tools use |
| `tests/greasyfork-examples/build-db.mjs` | Loads the CSV and downloaded files into `corpus.db` (scripts, headers, match patterns, deps) |
| `tests/greasyfork-examples/corpus.db` | SQLite database built from the corpus by `build-db.mjs` (gitignored) |
| `tests/greasyfork-examples/analysis.sql` | Annotated analysis queries over `corpus.db`, one `-- @report` block per table |
| `tests/greasyfork-examples/report.mjs` | Runs `analysis.sql` and renders the results as `analysis.html` |
| `tests/greasyfork-examples/analysis.html` | Generated HTML report of corpus statistics, rendered from `analysis.sql` |

## Docs (`docs/`)

| File | Description |
|------|-------------|
| `docs/file-index.md` | This file |
| `docs/architecture.md` | High-level component map and pointers to topic-specific docs |
| `docs/storage.md` | `chrome.storage.local` schema, status model, load/refresh pipeline, sources-page render |
| `docs/updates.md` | How scripts update from their install source, and why `@updateURL`/`@downloadURL` are probed but never followed |
| `docs/file-access.md` | `file://` access, FSA rationale, directory enumeration, listing-format caveat |
| `docs/http-sources.md` | `http(s)://` script and manifest sources, container routing, GitHub handling, conditional GETs |
| `docs/script-viewer.md` | Userscript viewer page + header parser (`splitHeaderBody`, `parseHeader`, …) |
| `docs/matching.md` | `@match`/`@include`/`@exclude` semantics, in-memory match index, per-tab badge |
| `docs/injection.md` | `chrome.userScripts` registration lifecycle, activation/error wrapper, opt-in requirements |
| `docs/injection-modes.md` | Three possible per-script `js[]` arrangements (separate entries vs concat vs eval-per-require); why we ship separate entries |
| `docs/supported-headers.md` | Inventory of `@tag` metadata fields — which ones SourceMonkey honors, which are parsed-only, and which are ignored |
| `docs/logging.md` | SW console-message catalog: log IDs (basename + `#N` dupes), the debug-logging gate, and which lines it gates |
| `docs/names-and-paths.md` | Decode-for-display rule for names/URLs: what gets percent-decoded, what stays encoded, and why |
| `docs/script-log.md` | Per-script event log: schema, storage layout, what gets logged, viewer Log tab behavior |
| `docs/diagnostics.md` | The shared location every content-derived verdict carries, who produces one, and how surfaces make it clickable |
| `docs/site-icons.md` | Favicon fetch+cache + the icon slot rendered beside each script filename; URL extraction lives in `match-targets.ts` |
| `docs/requires.md` | `@require` pipeline: resolution, storage, refresh policy, cross-script dedup, failure handling, injection composition |
| `docs/resources.md` | `@resource` pipeline + GM_getResourceText / GM_getResourceURL plumbing: prefetch, base64 storage, blob URL minting, shared infra with @require |
| `docs/industry-research.md` | Survey of existing userscript managers and AI-assisted "vibe-coding" tools in the same space |
| `docs/GM-API-strategy.md` | Decision doc comparing VM-embed vs own-impl for `GM_*` APIs; recommends own-impl with VM as reference |
| `docs/GM-APIs.md` | `GM_*` / `GM.*` implementation status: catalog, bindings emitter, world gating, `@grant` resolution, GM4 alias namespace |
| `docs/GM-APIs-storage.md` | Storage subsystem in depth: why values live in-document, how the cache is seeded, freshness mechanisms after `GM_setValue`, wire format |
| `docs/supported-GM-APIs.md` | User-facing per-API inventory: which `GM_*` names work, which are stubbed, and how they map to TM / VM / GM4 |
| `docs/offline-validation.md` | The install-time checks as a CLI: what it shares with production, the two pieces it can't, offline dependency roots |
| `docs/corpus-validation-results.md` | Snapshot of the validator's findings over the example suites and the GreasyFork top-2000 |
| `docs/testing.md` | Unit + e2e test harness layout, the SW test surface, and the Chrome-flags workaround for headless user-scripts |
| `docs/cross-manager-testing.md` | How the examples-suite-against-Tampermonkey framework works: persistent profile, CDP attach, dashboard-driven script install, fragile bits |
| `docs/cross-manager-test-results.md` | Snapshot of what passes / skips / fails under Tampermonkey today, with triage notes for each divergence |
| `docs/redirect-page.md` | Canonical GitHub-hosted "front door" the extension watches for; deep-link target that rewrites to `chrome-extension://...` |
| `docs/deep-link.md` | Design of the external-page → extension-page redirect (GitHub URL + `webNavigation` + allowlisted `page` param) |
| `docs/install-capture.md` | How `.user.js` link clicks become installs: Chrome's version-dependent handling, the capture, the prompt, the bypass |
