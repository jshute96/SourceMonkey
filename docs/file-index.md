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
| `scripts/make_manifest.sh` | Scan the current dir for `*.user.js` and emit a SourceMonkey HTTP-manifest JSON array to stdout |
| `scripts/open-test-browser-with-SourceMonkey.sh` | Launch Chromium with the unpacked SM extension + CDP port 9222 for cross-manager Playwright runs |
| `scripts/open-test-browser-with-TamperMonkey.sh` | Launch Chromium with a persistent profile (TM installed manually) + CDP port 9223 for the TM Playwright project |
| `scripts/sync-tm-scripts.mjs` | Standalone CLI that connects to the running TM browser via CDP and installs/updates every `*.user.js` under `tests/examples/` |
| `scripts/e2e-tm-preflight.mjs` | Pretest gate for `test:e2e:tm` / `:headed` — checks CDP 9223 and either launches the TM browser or asks the user to close it |
| `scripts/inspect-tm-dashboard.mjs` | Diagnostic: dumps every visible row on the TM dashboard with cell classes — use when listInstalled selectors stop working |
| `scripts/inspect-tm-install.mjs` | Diagnostic: drives one TM install and dumps the confirmation-page buttons — use when the Install-button selector stops working |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | MV3 extension manifest |
| `src/background.ts` | Service worker entrypoint; per-tab badge + action menu wiring, sm:* listener, injector + match-index bootstrap |
| `src/options.html` | Options page markup: path-entry form, file-access banner slot, directory list |
| `src/options.ts` | Options page controller — initial render, banners, in-place updates with per-control busy spinners, Refresh All + ?refresh trigger + change-row highlights |
| `src/userscript.html` | Userscript viewer markup: title, controls row, details panel, tab strip, highlighted code box, log pane |
| `src/userscript.ts` | Userscript viewer controller — hydrates from the store, renders controls + details dl + tabbed code view (main script + one tab per `@require` + Log tab) |
| `src/directories.ts` | Source I/O: file:// + http(s) fetch (conditional GETs), listing parser, recursive scanner, JSON manifest parser, URL helpers |
| `src/script-store.ts` | Persistent userscript store (chrome.storage.local) plus the load/refresh/validate pipeline (incl. size+mtime skip and refreshAllSources) |
| `src/script-updater.ts` | Single entry point for refresh; rate-limits and de-dupes opportunistic background checks while letting manual clicks pass through |
| `src/script-display.ts` | Pure display helpers shared by the options page + viewer: `formatBytes`, `formatScriptSize`, `formatScriptStatusLabel` |
| `src/script-links.ts` | Pure helpers for the viewer's link rendering: URL/text tokenizer, header-tag classifier sets, `// @tag value` line parser |
| `src/userscript-header.ts` | Parser for the `// ==UserScript== … // ==/UserScript==` metadata block + header/body splitter |
| `src/url-match.ts` | Pure URL-matching predicate for `@match` / `@include` / `@exclude` patterns |
| `src/match-index.ts` | In-memory cache of injectable scripts' matching info, kept in sync with `chrome.storage.local` |
| `src/injector.ts` | Syncs the enabled script set into `chrome.userScripts` and wraps each body with an activation/error shim |
| `src/tab-status.ts` | Pure helpers for per-tab badge view (expected ∪ actual classification, color, row-label formatter) and per-tab document LRU (bfcache restore) |
| `src/debug-log.ts` | Debug-logging gate for verbose lifecycle messages; off by default, toggled via `chrome.storage.local.smDebugLogging` |
| `src/script-log-id.ts` | Computes a per-script "log ID" (basename, with `#N` suffix on dupes) used in every log line + the options/viewer UI |
| `src/script-log.ts` | Per-script event log store: chrome.storage.session keyed by script ID, serialized appends with a fixed cap |
| `src/match-targets.ts` | Pure `@match` pattern → `{origin, linkUrl}` extractor; shared by site-icon and the viewer linkifier |
| `src/site-icon.ts` | Site-favicon discovery, `@icon`-header override, and the slot renderer used by both options page and viewer |
| `src/file-loader.ts` | Resolves header refs (`@icon`, `@require`, `@resource`) against the script's parent dir with traversal rejection; scheme-aware byte + text fetcher; `.js` suffix gate |
| `src/external-files.ts` | `@require` + `@resource` orchestrator: resolve, fetch, dedup (cross-script + cross-kind), attach typed entries |
| `src/wrapper-head.js` | Wrapper prelude (IIFE, vars, send helper, sm:check-pending await, @run-at gate on DCL/load, matcher slot, try-open) — minified to one line |
| `src/wrapper-tail.js` | Wrapper postlude (catch, sm:error send, runAt + decision callback closes, IIFE close) — minified to one line by the build |
| `src/wrapper-matcher.js` | Optional matcher block (urlMatchesScript port) inserted into the head when a script uses `/regex/` patterns |
| `src/wrapper-bridge.js` | USER_SCRIPT-world bridge that forwards `window.postMessage` sm:* events from MAIN-world wrappers to the SW |
| `src/gm-api-catalog.ts` | Catalog of supported `GM_*` / `GM.*` APIs: name, async/sync kind, subsystem; helpers for resolving `@grant` lines |
| `src/gm-bindings.ts` | Per-script `GM_*` / `GM.*` binding emitter — generates compile-in `const GM_X = ...` source spliced into the wrapper |
| `src/wrapper-gm-runtime.js` | USER_SCRIPT-world shared runtime — installs `window.__SM_GM__` (shim cache, async sendMessage helper, storage cache + batched writes) |
| `src/gm-values.ts` | SW-side persistent storage for `GM_*` values — `gmval:<scriptId>:<key>` rows in `chrome.storage.local`, batched writes |
| `src/gm-xhr.ts` | SW-side `GM_xmlhttpRequest` runner — fetch + AbortController, text/json/blob/arraybuffer/document, timeout |
| `src/gm-connect.ts` | `@connect` URL-gating helpers — parse rules, extract self hosts from `@match`/`@include`, check URL |
| `src/gm-tab.ts` | SW-side `GM_openInTab` dispatcher (`chrome.tabs.create` + per-request mapping for close-event routing) |
| `src/gm-notification.ts` | SW-side `GM_notification` dispatcher (`chrome.notifications.create` + per-request mapping for click/close routing) |
| `src/gm-menu.ts` | SW-side `GM_registerMenuCommand` per-(tab, script) command registry feeding the action menu |
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
| `tests/fixtures/scripts-dir.ts` | Tmp-dir helper that writes real `*.user.js` files on disk for the production scan/fetch pipeline to ingest |
| `tests/fixtures/userscript-server.ts` | Per-test HTTP server with mutable userscript / manifest routes and conditional-GET handling |
| `tests/fixtures/sw-api.ts` | Typed wrapper over the `self.SourceMonkey` SW test surface plus a generic `waitFor` polling helper |
| `tests/fixtures/pages/blank.html` | Minimal fixture page served by the in-test HTTP server |
| `tests/fixtures/pages/target.html` | Fixture page with a known `#target` element for injection assertions |
| `tests/fixtures/pages/other.html` | Fixture page used to verify scripts skip non-matching URLs |
| `tests/fixtures/pages/run-at.html` | Fixture page with a slow-blocker script + `#log` list used by the @run-at ordering test |
| `tests/e2e/smoke.spec.ts` | Smoke test: SW loads, options page renders, fixture server responds |
| `tests/e2e/injection.spec.ts` | End-to-end userscript injection: matching, non-matching, and multiple-script cases |
| `tests/e2e/badge.spec.ts` | Per-tab badge classifications: green/red/orange/purple plus MISSING and post-update RELOAD |
| `tests/e2e/reload-fast-path.spec.ts` | Reload triggers sm:check-pending → swap to fresh body on this reload; non-reload navs don't swap |
| `tests/e2e/sources.spec.ts` | Source lifecycle (add/refresh/remove) via the real file:// scan pipeline |
| `tests/e2e/manifest.spec.ts` | Manifest source refresh: vanished-entry deletion, unreadable-manifest preservation |
| `tests/e2e/options.spec.ts` | Options-page UI flows: add-directory form, Remove button, per-script toggle |
| `tests/e2e/site-icons.spec.ts` | E2E tests for the favicon slot: DOM contract, `@icon` header override, relative-path resolution, two-tier (path vs origin) cache |
| `tests/e2e/missing-trash.spec.ts` | Per-row trash button on missing scripts: removes only the clicked row, leaves siblings + the OK row intact |
| `tests/e2e/change-detection.spec.ts` | Unified change-detection: each source/scheme combo preserves loadedAt on identical content and bumps it on edits |
| `tests/unit/sample.test.mjs` | Placeholder Node `--test` unit test |
| `tests/unit/directories.test.mjs` | Unit tests for the `file://` listing parser and path/URL helpers |
| `tests/unit/userscript-header.test.mjs` | Unit tests for the metadata-block parser + header/body splitter |
| `tests/unit/script-store.test.mjs` | Unit tests for the pure helpers in the script store (merge, validate, build) |
| `tests/unit/script-updater.test.mjs` | Unit tests for the updater's rate-limit / concurrency gate |
| `tests/unit/script-display.test.mjs` | Unit tests for the size/status display helpers (incl. MISSING label) |
| `tests/unit/script-links.test.mjs` | Unit tests for the viewer link helpers: URL/text tokenizer + `// @tag value` line parser + header-marker detectors |
| `tests/e2e/script-viewer-links.spec.ts` | E2E tests for the viewer's link rendering: Match-row anchors, Location anchor, body header `@match` / URL linkification |
| `tests/unit/script-log-id.test.mjs` | Unit tests for `basenameOf` + `computeLogIds` (bare basename when unique, `#N` suffixes when dupes share a basename) |
| `tests/unit/script-log.test.mjs` | Unit tests for the per-script log store: append/get/clear, concurrent appends, LOG_CAP rotation |
| `tests/unit/url-match.test.mjs` | Unit tests for `@match` / `@include` / `@exclude` URL matching |
| `tests/unit/match-targets.test.mjs` | Unit tests for `@match` pattern parsing: origin / linkUrl extraction and the wildcard-trim path rule |
| `tests/unit/site-icon.test.mjs` | Unit tests for the icon-specific helpers: `@icon`-header extraction, `<link rel="icon">` parsing + scoring, cache TTLs |
| `tests/unit/file-loader.test.mjs` | Unit tests for `resolveScriptResource` — accepted schemes, relative-path resolution, and traversal rejection |
| `tests/unit/external-files.test.mjs` | Unit tests for `distillRequires`/`distillResources` + `attachFiles` (cache hits, preserve, dedup, UTF-8, cross-kind) |
| `tests/e2e/requires.spec.ts` | End-to-end `@require` coverage: file:// / HTTP relative path prefetch, `.js` suffix + traversal rejection, cross-script dedup, manual-vs-opportunistic refresh policy |
| `tests/unit/injector.test.mjs` | Unit tests for the pure injector helpers (run-at normalization, spec build, active-spec collection) |
| `tests/unit/gm-api-catalog.test.mjs` | Unit tests for the GM_* / GM.* catalog: lookup, alias resolution, `@grant` canonicalization, `none` precedence |
| `tests/unit/gm-bindings.test.mjs` | Unit tests for the per-script GM_* / GM.* binding emitter — granted output, sync stub routing, async sendMessage envelope, GM4 alias shape |
| `tests/unit/gm-values.test.mjs` | Unit tests for the SW-side `gmval:` storage helpers — key composition, batch apply with last-write-wins, sentinel deletes, namespace isolation |
| `tests/e2e/gm-grants.spec.ts` | E2E tests: `@grant` gating, ungranted APIs return undefined, GM_info shape, `GM.` alias namespace, `GM.setValue` granted form |
| `tests/e2e/gm-storage.spec.ts` | E2E tests for `GM_setValue`/`GM_getValue`/`GM_deleteValue`/`GM_listValues` round-trip, persistence across reloads, per-script namespace isolation, `GM.` promised forms |
| `tests/e2e/gm-dom.spec.ts` | E2E tests for `GM_addStyle` / `GM_addElement` — CSS application, tag-aware default parent (head/body), explicit-parent form, GM4 alias, permission gating |
| `tests/e2e/gm-clipboard.spec.ts` | E2E tests for `GM_setClipboard` via `navigator.clipboard.writeText` — text round-trip, GM4 alias, permission gating |
| `tests/e2e/gm-broadcast.spec.ts` | E2E tests for cross-tab `GM_setValue` broadcast — write in tab A is visible in tab B; originator doesn't echo |
| `tests/e2e/gm-value-listeners.spec.ts` | E2E tests for `GM_addValueChangeListener` / `GM_removeValueChangeListener` — local fire with remote=false, delete fire, remove-by-id, cross-tab remote=true, permission gating |
| `tests/e2e/gm-xhr.spec.ts` | E2E tests for `GM_xmlhttpRequest` text path — GET text, JSON, POST body, HTTP errors firing onload, network failure → onerror, abort, permission gating |
| `tests/e2e/gm-xhr-binary.spec.ts` | E2E tests for `GM_xmlhttpRequest` binary path — arraybuffer/blob/document via base64 wire reconstruction |
| `tests/e2e/gm-connect.spec.ts` | E2E tests for `@connect` gating — no-connect blocked, matching exact allowed, `*` wildcard, subdomain match, mismatched host blocked |
| `tests/unit/gm-connect.test.mjs` | Unit tests for `@connect` parsing/matching — wildcard, self, exact, subdomain, scheme-prefixed normalization, malformed entries |
| `tests/unit/gm-tab.test.mjs` | Unit tests for the `GM_openInTab` SW dispatcher (mapping, close routing, originator cleanup) |
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
| `tests/examples/xmlhttp-denied/` | Negative cases for `@connect`: scripts with no `@connect`, mismatched host, and explicit allow show blocked-vs-allowed outcomes |
| `tests/bad-examples/` | Deliberately malformed `*.user.js` files for the SM-only spec; lives outside `tests/examples/` so the TM loader doesn't see them |
| `tests/e2e/bad-scripts.spec.ts` | SM-only e2e: each bad script gets the expected status and the viewer renders it byte-for-byte |

## Docs (`docs/`)

| File | Description |
|------|-------------|
| `docs/file-index.md` | This file |
| `docs/architecture.md` | High-level component map and pointers to topic-specific docs |
| `docs/storage.md` | `chrome.storage.local` schema, status model, load/refresh pipeline, options-page render |
| `docs/file-access.md` | `file://` access, FSA rationale, directory enumeration, listing-format caveat |
| `docs/http-sources.md` | `http(s)://` single-script sources + scheme-agnostic JSON manifests (local + URL), conditional GETs |
| `docs/script-viewer.md` | Userscript viewer page + header parser (`splitHeaderBody`, `parseHeader`, …) |
| `docs/matching.md` | `@match`/`@include`/`@exclude` semantics, in-memory match index, per-tab badge |
| `docs/injection.md` | `chrome.userScripts` registration lifecycle, activation/error wrapper, opt-in requirements |
| `docs/supported-headers.md` | Inventory of `@tag` metadata fields — which ones SourceMonkey honors, which are parsed-only, and which are ignored |
| `docs/logging.md` | SW console-message catalog: log IDs (basename + `#N` dupes), the debug-logging gate, and which lines it gates |
| `docs/script-log.md` | Per-script event log: schema, storage layout, what gets logged, viewer Log tab behavior |
| `docs/site-icons.md` | Favicon fetch+cache + the icon slot rendered beside each script filename; URL extraction lives in `match-targets.ts` |
| `docs/requires.md` | `@require` pipeline: resolution, storage, refresh policy, cross-script dedup, failure handling, injection composition |
| `docs/resources.md` | `@resource` pipeline + GM_getResourceText / GM_getResourceURL plumbing: prefetch, base64 storage, blob URL minting, shared infra with @require |
| `docs/industry-research.md` | Survey of existing userscript managers and AI-assisted "vibe-coding" tools in the same space |
| `docs/GM-API-strategy.md` | Decision doc comparing VM-embed vs own-impl for `GM_*` APIs; recommends own-impl with VM as reference |
| `docs/GM-APIs.md` | `GM_*` / `GM.*` implementation status: catalog, bindings emitter, world gating, `@grant` resolution, GM4 alias namespace |
| `docs/supported-GM-APIs.md` | User-facing per-API inventory: which `GM_*` names work, which are stubbed, and how they map to TM / VM / GM4 |
| `docs/testing.md` | Unit + e2e test harness layout, the SW test surface, and the Chrome-flags workaround for headless user-scripts |
| `docs/cross-manager-testing.md` | How the examples-suite-against-Tampermonkey framework works: persistent profile, CDP attach, dashboard-driven script install, fragile bits |
| `docs/cross-manager-test-results.md` | Snapshot of what passes / skips / fails under Tampermonkey today, with triage notes for each divergence |
