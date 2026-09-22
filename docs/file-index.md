# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `TODO.md` | Backlog of candidate follow-ups and enhancements, with the trade-off behind each — not a list of obligations |
| `LICENSE` | MIT license text |
| `package.json` | Node project manifest, scripts, devDependencies |
| `pnpm-lock.yaml` | pnpm dependency lockfile |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `tsconfig.tests.json` | Typecheck-only config extending the build one to cover `tests/` (`pnpm run typecheck`) |
| `playwright.config.ts` | Playwright test runner config (e2e suite) |
| `.gitignore` | Git ignore rules |

## Local Claude Config (`.claude/`)

| File | Description |
|------|-------------|
| `.claude/settings.json` | Local dev settings — Bash permissions for `pnpm` commands |
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — `/codereview` then commit + push if clean |

## Build Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Clean `dist/`, copy icons + manifest + HTML + vendor (Prism), run `tsc` (optional `--watch`) |
| `scripts/zip_extension.sh` | Build and zip `dist/` for distribution — `/tmp/SourceMonkey.zip`, or `-vVERSION` with `--release` |
| `scripts/release-extension.sh` | Cut a `vX.Y.Z` GitHub release: version/branch/tag checks, zip, push tag, `gh release create` (draft by default) |
| `scripts/serve-examples.mjs` | Local HTTP server for `tests/examples/`, including the `/__slow/?ms=N` delay route the `headers-run-at` demo needs |
| `scripts/make_manifest.sh` | Scan the current dir for `*.user.js` and emit a SourceMonkey HTTP-manifest JSON array to stdout (redirect to `script_manifest.json`) |
| `scripts/open-test-browser-with-SourceMonkey.sh` | Launch Chromium with the unpacked SM extension + CDP port 9222 for cross-manager Playwright runs |
| `scripts/open-test-browser.sh` | Launch Chromium with a named manager's persistent profile (TM or VM, installed manually) + its CDP port for that Playwright project |
| `scripts/sync-manager-scripts.mjs` | Standalone CLI that connects to the running TM or VM browser via CDP and installs/updates every `*.user.js` under `tests/examples/` |
| `scripts/clean-stale-test-profiles.mjs` | Sweep, run before the e2e suite, of `/tmp/sourcemonkey-test-*` profiles left by e2e runs that died before teardown |
| `scripts/e2e-manager-preflight.mjs` | Gate before `test:e2e:tm` / `:vm`: probes the manager's CDP port, pre-grants TM's `downloads`, opens or asks to close the browser |
| `scripts/inspect-tm-dashboard.mjs` | Diagnostic: dumps every visible row on the TM dashboard with cell classes — use when listInstalled selectors stop working |
| `scripts/inspect-tm-install.mjs` | Diagnostic: drives one TM install and dumps the confirmation-page buttons — use when the Install-button selector stops working |
| `scripts/validate-userscripts.mjs` | CLI that runs the install-time checks (header, `@require`/`@resource`, parse) over files on disk, with an offline dependency root |

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
| `src/background.ts` | Service worker entrypoint; per-tab badge + action menu wiring, sm:* listener, focus-triggered local refresh, the pages' http-read and log-write relays, injector + match-index bootstrap, first-run collections-page open |
| `src/deep-link.ts` | `webNavigation` listener: rewrites the GitHub `redirect-page.md` URL to the matching `chrome-extension://…` page |
| `src/install-capture.ts` | Captures http(s) + file:// navigations to `*.user.js` and redirects them to the viewer's preview mode |
| `src/collections.html` | Collections page markup: header bar with Options / Refresh All, Add field, file-access banner slot, collection list |
| `src/collections.ts` | Collections page controller — Add-field routing into the dialog, options gear, render, membership repair, in-place updates, refresh highlights + dropped-row ghosts, repaint-from-storage on change, `?refresh`/`?refresh_local`/`?refresh_file`/`?add`/`?first_run` triggers |
| `src/collection-dialog.ts` | The create / edit collection dialog shared by the collections page and the install page: name / location / local-overrides fields, an inferred Type row, live validation, pre-create readability probe, create/install/move wording |
| `src/refresh-targets.ts` | Picks the collections/scripts a `?refresh_local` or `?refresh_file=<path>` trigger should refresh |
| `src/options.html` | Options page markup: header bar with the Collections link, settings list (link-capture toggle, debug-logging toggle), local search-roots box + file-access banner slot, Downloads-folder field, GitHub auth token |
| `src/options.ts` | Options page controller — boolean setting checkboxes, local search-roots box (parse + existence checks, refresh on save), Downloads-folder field, GitHub-token controls |
| `src/page-heading.ts` | Import-free module holding the viewer heading's vocabulary and DOM, and the early paint that names the header bar before the page's first paint |
| `src/page-links.ts` | Cross-page links between extension pages: the named Collections / Options tabs and the header bar's home link |
| `src/userscript.html` | Userscript viewer markup: header bar, status box (banner + versions panel), controls row, install callout + preview actions, details panel, tab strip, code box, log pane |
| `src/userscript.ts` | Userscript viewer controller — installed mode (`?script=`), preview mode (`?preview=`), in-page switching between copies, the Collection row's Move button, the controls row's Local copy / delete-copy buttons, live `storage` watchers, log pane |
| `src/compare.html` | Compare page markup: header bar, the fields table slot, view controls, tab strip, diff box |
| `src/compare.ts` | Compare page controller — loads two copies (stored, or a preview's download), the fields table with its swap, per-file tabs, unified / side-by-side diff rendering, change-block arrows |
| `src/debug/icons.html` | Debug icons page markup: common header bar with Delete All action and cached-icons inspection table |
| `src/debug/icons.ts` | Debug icons controller — lists all cached icons with scope, expiry, per-row refresh/delete, and Delete All |
| `src/select-all.ts` | The Ctrl/Cmd-A that selects a page's content rather than the page, given what each page wants selected |
| `src/line-diff.ts` | Pure line diff (Myers) plus hunk folding and change counts, behind the compare page |
| `src/move-dialog.ts` | The move-script dialog opened from the viewer's Collection row: destination dropdown, live refusals, runs the move itself |
| `src/copy-dialog.ts` | The local-copy dialog opened from the viewer's controls row: filename, header fields, dependency checkbox, existing-file checks, runs the copy |
| `src/delete-icon.ts` | Paints the two removal glyphs: plain trash can for a record, trash can + disk badge for a file delete |
| `src/delete-dialog.ts` | The delete-local-script-file confirmation: the file and its path, the dependency lists, an on-disk watch, runs the deletion |
| `src/file-changes.ts` | Paint-time "deleted" / "modified" chips and the per-collection "refresh pending" chip: listing-based probe, new-file scan, tagging, tooltips |
| `src/local-delete.ts` | Deleting a local copy from disk: which scripts qualify, what goes with them, download-history lookup and removal |
| `src/local-copy.ts` | Local copies of a script: the Downloads collection + setting, name rules, header rewriting, dependency layout, the `chrome.downloads` write |
| `src/script-details.ts` | Builds the viewer's curated details `<dl>` — chosen header fields, the resolved provenance rows, and the Collection row's trailing slot — for both modes; lends the compare page its Collection cell |
| `src/details-tooltips.ts` | The one table of tooltip text for the details panel's row labels, plus the mode/site-name lookups |
| `src/copy-button.ts` | The square copy-to-clipboard button beside a path (viewer rows, delete dialog): sprite glyphs, per-button "Copied" flash, text read at click time |
| `src/script-identity.ts` | Finds other installed copies of a script — match by absolute `fileUrl`, and by `@namespace`+`@name`; the content fingerprint behind the panel's Compare column; the exclusive-enable rule; the install / move target options |
| `src/select-open-guard.ts` | Opens a `<select>`'s list on the mouse release, so the click that opens it can't also pick from it |
| `src/related-versions.ts` | Renders the "Other versions" panel: a section per relationship, per-copy controls, the preview's install-offer section, the fold toggle, and the collection dropdown Install and Move share |
| `src/code-tabs.ts` | Tabbed code view: tab strip with per-tab URL tooltip + chip, Prism pane, lazy tab bodies, line highlight, gutter clicks, `#file:line:col` hash sync |
| `src/code-links.ts` | Linkifies a Prism-highlighted code block (header-tag values + bare URLs) and builds the shared open-in-new-tab anchor |
| `src/prism-userscript.ts` | Side-effect module: teaches Prism the `// ==UserScript== …` metadata block so it renders as a tinted band |
| `src/directories.ts` | Collection I/O + classifiers (single-file / manifest / github-dir / container, plus the read-it-first `classifyLocation`), input canonicalizer, file:// + http(s) fetch, listing parser, recursive scanner, manifest parser, URL helpers |
| `src/file-access.ts` | "Allow access to file URLs" probe plus the shared "File access is disabled." banner and its chrome://extensions link |
| `src/github-provider.ts` | GitHub-only provider integration: URL parsing, default-branch resolution, blob→raw rewrite, Contents-API recursive dir scanner, per-script raw/display URL builders |
| `src/github-auth.ts` | Persisted GitHub PAT cache + `githubAuthHeaders(url)` host-gated helper for attaching `Authorization: Bearer …` to api/raw/github.com-raw fetches |
| `src/markup-response.ts` | Detects an HTML page served where JavaScript was expected (Content-Type + leading `<`), and words the failure |
| `src/collection-scan.ts` | Cycle-neutral scan primitives shared by `directories.ts` and `github-provider.ts` |
| `src/script-store.ts` | Persistent userscript store (chrome.storage.local) plus load/refresh pipeline, addCollection / createCollection / installScript / moveScript / setCollectionOptions / probeCollectionLocation, parse-time diagnostics, refreshAllCollections, membership reconcile, first-run flag + DEFAULT_COLLECTIONS, legacy `source:*` key migration |
| `src/script-updater.ts` | Single entry point for refresh; rate-limits opportunistic background checks, and mirrors every load/refresh outcome into the per-script Log |
| `src/script-display.ts` | Pure display helpers: size/status formatting, the shared status view + viewer / preview / compare URLs, the script label and full source, slash-aware wrapping, name/path decoding, SRI-fragment strip, enable-toggle tooltip |
| `src/version-compare.ts` | Pure `@version` ordering (dotted segments, numeric-aware, prerelease tails) + the newer/older/same/edited verdict and the `-local` suffix |
| `src/version-probe.ts` | Pure probe logic: pick the `@updateURL`/`@downloadURL` targets we don't load from, judge staleness + outdated verdict |
| `src/version-probe-fetch.ts` | Fetching half of update probes — reads a probe URL's `@version`, with bounded size, timeout, and fan-out |
| `src/collection-display.ts` | Collection-display helpers: bubble key (kind + scheme) and its tooltip, per-row scheme chip, display-name inference, name-in-use + reserved-name checks, manifest flag, anchor id, disabled-collection tooltip |
| `src/glyph.ts` | Renders a sprite glyph into a button, with the label/tooltip pair and the in-flight spin state |
| `src/glyph-sprite.svg` | The one copy of every inline SVG glyph, inlined into each page at `<!--#include glyph-sprite-->` by the build |
| `src/styles.css` | Cross-page shared stylesheet linked by every extension page: the header bar and page column, the button surface, collection bubble + scheme chip, display-name, warning banner, modal dialog shell, install-target select, tab strip, site favicons |
| `src/script-sites.ts` | Rewrites a script's URL into the hosting site's listing page (Greasy Fork, Sleazy Fork, OpenUserJS, gists) and decides the viewer's row |
| `src/script-links.ts` | Pure helpers for the viewer's link rendering: URL/text tokenizer, header-tag classifier sets, `// @tag value` line parser |
| `src/stack-link.ts` | Pure stack-ref helpers: `parseStackRefs` splits a log message into text + `{url, line, col}` runs; `displayRefText` decodes our own URLs for reading |
| `src/script-source-url.ts` | Canonical `sourcemonkey://SourceMonkey/…` URL builders for every `{code}` entry — main, config, prelude, require, plus page-wide bridge / GM runtime |
| `src/script-url-hash.ts` | Pure `parseHash` / `buildHash` for the viewer's `#<filename>[:<line>[:<col>]]` / `#Log` URL fragment |
| `src/userscript-header.ts` | Parser for the `// ==UserScript== … // ==/UserScript==` metadata block + header/body splitter, with per-tag line numbers |
| `src/url-match.ts` | Pure URL-matching predicate for `@match` / `@include` / `@exclude` patterns, plus the `@match` grammar check and its lenient rewrites |
| `src/match-index.ts` | In-memory cache of injectable scripts' matching info, execution world, and which load from disk, kept in sync with `chrome.storage.local`; reports which rows moved, skipping probe-only writes |
| `src/injector.ts` | Incrementally syncs the enabled script set into `chrome.userScripts`, re-checking unverified rows first, and wraps each body with an activation/error shim |
| `src/unsafe-window-use.ts` | Text scan for an ungranted `unsafeWindow` reference (and for a source that declares the name itself) |
| `src/composed-source.ts` | Concatenates `@require` bodies ahead of the script body; owns the injected entry's line layout for both run paths |
| `src/tab-status.ts` | Pure helpers for per-tab badge view (expected ∪ actual classification incl. NOT LOADED, color, row-label formatter) and per-tab document LRU |
| `src/debug-log.ts` | Debug-logging gate for verbose lifecycle messages; off by default, toggled via `chrome.storage.local.smDebugLogging` |
| `src/phase-timing.ts` | Debug-gated timers behind the refresh / registration paths: per-sequence phases plus cumulative fan-out totals |
| `src/storage-scan.ts` | Wrapper for every full-namespace `storage.local.get(null)`, naming each scan and its cost under debug logging |
| `src/concurrency.ts` | Bounded fan-out helper plus the nested per-collection / per-script, probe, and directory-scan limits |
| `src/bytes.ts` | Shared byte helpers: `sha256Hex` (content/file hashes) plus chunked `bytesToBase64` / `base64ToBytes` for message-hop and `@resource` transport |
| `src/refresh-error.ts` | Session-storage map of collections whose last refresh was read but could not be saved, plus its shared message |
| `src/sw-teardown.ts` | Marks `No SW` rejections (chrome.* calls cut off by service-worker shutdown) handled so they stay out of the Errors panel |
| `src/script-log-id.ts` | Computes a per-script "log ID" (basename, with `#N` suffix on dupes) used in every log line + the collections/viewer UI |
| `src/script-log.ts` | Per-script event log store: chrome.storage.session keyed by script ID, serialized appends with a fixed cap, a sibling `loglevel:` sentinel, and the page→worker write relay |
| `src/log-format.ts` | Log cell formatting (time, status/level, source, message) shared by the viewer's table and its CSV export, plus the export's filename |
| `src/script-rejection.ts` | Session-storage record of registrations `chrome.userScripts` refused, plus the one sentence every surface reports it with |
| `src/match-targets.ts` | Pure `@match` pattern → `{origin, linkUrl}` extractor, the first-few-distinct-sites list behind multi-icon rows, and the same-directory fallback for site-less patterns |
| `src/site-icon.ts` | Site-favicon discovery, `@icon`-header override (incl. local file stand-ins), and the one-icon-per-site slot renderer for collections page + viewer |
| `src/file-loader.ts` | Resolves header refs (`@icon`, `@require`, `@resource`) against the script's own URL, containing a local script to its folder; scheme-aware byte + text fetcher reporting why it failed; `.js` suffix gate |
| `src/run-context.ts` | The page-vs-service-worker test (`isPageContext`) the modules shared by both branch on |
| `src/http-read.ts` | One http(s) read, made in the service worker when a page asks — a document fetch acts on the response's `Link: rel=preload` headers |
| `src/external-files.ts` | `@require` + `@resource` orchestrator: resolve, fetch, dedup (cross-script + cross-kind), attach typed entries, word the failures |
| `src/local-file-overrides.ts` | Local stand-ins for `@require` / `@resource` / `@icon` declared by absolute URL: search roots (script folder, collection root, configured), host/path suffix candidates, listing-gated probing, containment |
| `src/userscript-prelude.js` | Static per-world prelude (matcher, check-pending round-trip, @run-at gate, async-error listeners, focus signal); minified to WRAPPER_PRELUDE and spliced into each script's js[] as a `{code}` entry |
| `src/wrapper-bridge.js` | USER_SCRIPT-world bridge relaying sm:* + GM_* traffic between MAIN-world wrappers and the SW, both directions |
| `src/gm-api-catalog.ts` | Catalog of supported `GM_*` / `GM.*` APIs: name, async/sync kind, subsystem; helpers for resolving `@grant` lines |
| `src/gm-bindings.ts` | Per-script `GM_*` / `GM.*` binding emitter — generates compile-in `const GM_X = ...` source spliced into the wrapper |
| `src/source-map.ts` | Source Map v3 generator for the concatenated injection entry, plus the reverse lookup the Log tab maps stack refs with |
| `src/wrapper-gm-runtime.js` | Shared per-world `GM_*` runtime — installs `window.__SM_GM__` (shim cache, dual transport, storage cache + stored-value codec + batched writes) |
| `src/gm-values.ts` | SW-side persistent storage for `GM_*` values — `gmval:<scriptId>:<key>` rows in `chrome.storage.local`, batched writes |
| `src/gm-xhr.ts` | SW-side `GM_xmlhttpRequest` runner — fetch + AbortController, text/json/blob/arraybuffer/document, cookies, timeout |
| `src/gm-xhr-headers.ts` | Forbidden-request-header surgery for `GM_xmlhttpRequest` — classify, tag the URL, compile to a DNR session rule, stale-rule sweep |
| `src/gm-connect.ts` | `@connect` URL-gating helpers — parse rules, extract self hosts from `@match`/`@include`, check URL, phrase `GM_xmlhttpRequest`'s errors |
| `src/gm-tab.ts` | SW-side `GM_openInTab` dispatcher (`chrome.tabs.create` + per-request mapping for close-event routing) |
| `src/gm-download.ts` | SW-side `GM_download` dispatcher (`chrome.downloads` for http(s) + per-request mapping for progress/terminal routing) |
| `src/gm-notification.ts` | SW-side `GM_notification` dispatcher (`chrome.notifications.create` + per-request mapping for click/close routing) |
| `src/gm-url-scheme.ts` | Shared URL-scheme gate for the SW-side GM_* dispatchers (parse + allowlist check for tabs / notifications / downloads) |
| `src/gm-originator-map.ts` | Shared shed-on-tab-close helper for the gm-tab / gm-notification / gm-download per-request maps (drop entries by originator tab) |
| `src/gm-menu.ts` | SW-side `GM_registerMenuCommand` per-(tab, document, script) command registry feeding the action menu |
| `src/gm-url-change.ts` | SW-side `window.onurlchange` driver — forwards `webNavigation.onHistoryStateUpdated` to the changed document as `sm:url-change` |
| `src/gm-window-control.ts` | SW-side `window.close` / `window.focus` driver — closes or fronts the sender's own tab via `chrome.tabs` / `chrome.windows` |
| `src/action-menu.ts` | Action context-menu planner — packs script + command groups and the fixed reload row into Chrome's 6-item cap with a "More" overflow submenu |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (placeholder) |

### Development harness (`src/harness/`)

Node-side code, compiled with the rest of `src/` into `dist/harness/`
and published as the `sourcemonkey/harness` entry and the `sm-dev`
command. See `docs/harness-design.md`.

| File | Description |
|------|-------------|
| `src/harness/index.ts` | Public entry of the harness package: re-exports `prepareScript`, `explainMatch`, and the Node parse checker |
| `src/harness/prepare.ts` | Runs the real install pipeline over a file or text under Node and returns the registrable entries, world, matching, and diagnostics |
| `src/harness/parse-check-node.ts` | Node counterpart of the sandboxed parse check: `new Function` verdict plus `vm.Script` location probes |
| `src/harness/host.ts` | The stand-in service worker: answers the injected code's bridge messages under Node and records what scripts report |
| `src/harness/inject.ts` | Attaches prepared scripts to a Playwright page over CDP, in the right world, with the bridge forwarded to the host |
| `src/harness/run.ts` | `sm-dev run`: connect or launch a browser, inject scripts, stream reports and console lines, re-inject on file changes |
| `src/harness/cli.ts` | The `sm-dev` command: `validate`, `match`, and `run` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: launches Chromium with the extension, exposes SW handle, HTTP fixture server, and the `sm` SW-api proxy; `testWithBrowserDownloads` variant leaves downloads to Chrome |
| `tests/fixtures/harness.ts` | Fixtures for the `harness` project: plain Chromium, fixture server, a host and page attachment per test, `loadScript` |
| `tests/fixtures/manager.ts` | Manager-agnostic Playwright fixture for the examples suite — picks SM (unpacked build) or TM/VM (persistent CWS profile) per project metadata |
| `tests/fixtures/managers.mjs` | Per-manager table (profile dir, CDP port, Web Store ID, env vars) shared by the fixture, preflight, and CLIs |
| `tests/fixtures/userscript-files.mjs` | Finds `*.user.js` files on disk and reads their `@name`/`@version`, shared by both manager drivers and the sync CLI |
| `tests/fixtures/sourcemonkey-launch.ts` | Shared Chromium-launch / SW-handle / HTTP-fixture-server helpers used by both `extension.ts` and `manager.ts`; optional Chrome-managed downloads dir |
| `tests/fixtures/slow-route.mjs` | `/__slow/?ms=N` delay route, static content-types, and the shared static-file server used by the fixture server and the example/sync CLIs |
| `tests/fixtures/tampermonkey-driver.mjs` | TM dashboard driver: lists installed scripts, installs/updates via import-from-file, auto-OKs TM permission prompts |
| `tests/fixtures/violentmonkey-driver.mjs` | VM driver: lists and installs scripts through VM's own background commands, installing from a fixture-server URL |
| `tests/fixtures/viewer-selectors.ts` | Userscript-viewer selectors shared by several specs, where the right element isn't the obvious one |
| `tests/fixtures/extension-id.ts` | Computes Chrome's deterministic unpacked-extension ID from an absolute path |
| `tests/fixtures/bad-script-cases.mjs` | Expected status / message / error line for every `tests/bad-examples/` file, shared by the e2e spec and the CLI test |
| `tests/fixtures/scripts-dir.ts` | Tmp-dir helper that writes real `*.user.js` files on disk for the production scan/fetch pipeline to ingest |
| `tests/fixtures/userscript-server.ts` | Per-test HTTP server with mutable userscript / manifest routes, conditional-GET handling, and a request-arrival wait |
| `tests/fixtures/sw-api.ts` | Typed wrapper over the `self.SourceMonkey` SW test surface plus the shared `waitFor` / tab-id / badge-colour / all-scripts helpers |
| `tests/fixtures/capture-nav.ts` | Shared `.user.js` capture waits: start the aborted navigation, then wait for the preview |
| `tests/fixtures/pages/blank.html` | Minimal fixture page served by the in-test HTTP server |
| `tests/fixtures/pages/target.html` | Fixture page with a known `#target` element for injection assertions |
| `tests/fixtures/pages/other.html` | Fixture page used to verify scripts skip non-matching URLs |
| `tests/fixtures/pages/run-at.html` | Fixture page with a slow-blocker script + `#log` list used by the @run-at readyState-window test |
| `tests/fixtures/pages/slow-dcl.html` | Fixture page held at readyState=loading for ~1s, so DOMContentLoaded lands well after the reload fast-path window |
| `tests/fixtures/pages/page-globals.html` | Fixture page defining page-realm globals, so MAIN-vs-isolated world access can be asserted |
| `tests/fixtures/pages/strict-csp.html` | Fixture page with `style-src 'none'`, for the MAIN-world CSP-blocked-style report |
| `tests/e2e/smoke.spec.ts` | Smoke test: SW loads, collections page renders, fixture server responds |
| `tests/e2e/exclude-globs.spec.ts` | E2E for `@exclude`: excluded pages stay untouched, a later-added `@exclude` takes effect, plus a Chrome `update`-vs-globs probe |
| `tests/e2e/include-only.spec.ts` | E2E for `@match`-less scripts: a glob-only `@include` injects and stays in its glob, plus a Chrome `includeGlobs` semantics probe |
| `tests/e2e/injection.spec.ts` | End-to-end userscript injection: matching, non-matching, lenient-`@match`, and multiple-script cases |
| `tests/e2e/sync-window.spec.ts` | A navigation racing a registration sync still gets injected, and the set never empties mid-sync |
| `tests/e2e/badge.spec.ts` | Per-tab badge classifications: green/red/orange/purple plus MISSING and post-update RELOAD |
| `tests/e2e/reload-without-scripts.spec.ts` | "Reload page with no userscripts": one-shot skip, grey NOT LOADED badge, info Log entry, row presence |
| `tests/e2e/focus-refresh.spec.ts` | Focus-triggered refresh: a tab switch or a page's own focus report picks up a local edit; http scripts stay unfetched |
| `tests/e2e/reload-fast-path.spec.ts` | Reload triggers sm:check-pending → swap to fresh body on this reload; non-reload navs, world changes, and a newly-needed runtime don't |
| `tests/e2e/reload-fast-path-parse-check.spec.ts` | The reload swap doesn't wait for the parse verdict, and the verdict still lands on the row afterwards |
| `tests/e2e/reload-fast-path-sharing.spec.ts` | Navigation-triggered checks share one folder listing across the page's scripts, and still catch a per-script edit |
| `tests/e2e/collections.spec.ts` | Collection lifecycle (add/refresh/remove/vanished files) via the real file:// scan pipeline |
| `tests/e2e/layout-metrics.spec.ts` | Guards the whole-pixel vertical metrics behind uniform checkbox rendering on collections, viewer, and Options |
| `tests/e2e/live-updates.spec.ts` | Live watchers: collections page + viewer follow `storage.local` writes from another origin without a reload (issue #10) |
| `tests/e2e/refresh-highlights.spec.ts` | After a refresh: new vs updated rows, red over either when broken, and the inert ghost a dropped script leaves |
| `tests/e2e/container-collections.spec.ts` | Container-collection lifecycle: auto-create / reuse on add, duplicate rejection, refresh refetches every child |
| `tests/e2e/collection-dialog.spec.ts` | The collection dialog from the collections page: Add-field routing, inferred type / name, readability probe, live refusals, Edit rename and options, scheme chips |
| `tests/e2e/install-target.spec.ts` | The install page's "Install into" dropdown: groups and order, renamed / missing default, install into a chosen or new collection, second copy of one URL |
| `tests/e2e/move-script.spec.ts` | The move-script dialog from the viewer's Collection row: destination list, id preserved, stacked create dialog, disabled destination, button placement |
| `tests/e2e/file-changes.spec.ts` | The deleted / modified chips on the viewer's rows, the versions table and the collections page, the "refresh pending" chip, and their removal on refresh |
| `tests/e2e/local-delete.spec.ts` | Deleting a local copy: own dependencies go, shared ones are kept, an untracked file blocks until deleted by hand, files gone from disk, from every trash can that offers it, control placement |
| `tests/e2e/local-copy.spec.ts` | Local copies: first copy creates the Downloads collection and takes over, Replace for files and installed scripts, name rules, dependency files, cleanup after a refused write, a copy refusing its own name |
| `tests/e2e/script-log-relay.spec.ts` | The page→worker Log-write relay end to end: the viewer's Clear log is performed by the worker |
| `tests/e2e/membership.spec.ts` | Collection membership vs. the script rows: moves and removals that land mid-refresh, and the repair sweep |
| `tests/e2e/manifest.spec.ts` | Manifest collection refresh: vanished-entry deletion, unreadable-manifest preservation |
| `tests/e2e/options.spec.ts` | Options-page UI flows: add-directory form, collection removal, per-script toggle |
| `tests/e2e/page-links.spec.ts` | E2E for cross-page links: new-tab-ness, named-tab reuse, and the header bar's home link |
| `tests/e2e/site-icons.spec.ts` | E2E tests for the favicon slot: DOM contract, one icon per site + collapse + column fit, `@icon` override, relative paths, two-tier cache, blob-URL de-dup, cross-host redirect rejection, schema self-heal, Chrome `_favicon` DB |
| `tests/e2e/debug-icons.spec.ts` | E2E test for `/debug/icons.html`: header bar, cached-icon rows, per-row refresh + delete, and Delete All |
| `tests/e2e/viewer-layout.spec.ts` | E2E tests for the viewer's height: the code box / Log pane fill the viewport, keep a 20-line minimum, and let the page scroll past a tall details panel |
| `tests/e2e/viewer-select-all.spec.ts` | E2E for the viewer's Ctrl-A: selects exactly the file text from anywhere on the page, or the Log table without its toolbar |
| `tests/e2e/details-list-fold.spec.ts` | E2E test for the details panel's long-list fold: first items + `(N more)` toggle, expand and fold back |
| `tests/e2e/change-detection.spec.ts` | Unified change-detection: each collection/scheme combo preserves loadedAt on identical content and bumps it on edits, and only changed rows are written |
| `tests/e2e/rejected-registration.spec.ts` | REJECTED state end to end: a `@match` Chrome refuses stays `ok` but never runs, and every retry re-reports until it's fixed |
| `tests/e2e/log-level-reset.spec.ts` | A refresh that loads new content resets the WARNING / ERROR badge, keeps the log, and lets the new version's parse diagnostics re-badge it |
| `tests/e2e/refresh-failed.spec.ts` | Refresh failures (markup response, soft 200-not-a-script, hard 404) keep the prior good copy running with `refreshError`, and land in the script's Log once |
| `tests/e2e/install-capture.spec.ts` | E2E for the `.user.js` capture: redirect to the preview, Install registers the collection, already-installed + non-userscript cases, web-page auto-continue, View raw source, option off |
| `tests/e2e/install-capture-file.spec.ts` | E2E for the `file://` half of the capture: preview takeover, bare-path install + refresh, dedup, bypass paths |
| `tests/e2e/refresh-triggers.spec.ts` | The collections page's `?refresh_local` / `?refresh_file=<path>` triggers, incl. the no-match and bad-shape messages |
| `tests/e2e/refresh-error.spec.ts` | A refresh that reads fine but can't be saved: the recorded reason, untouched scripts, the rolled-back install, and the page's message + banner |
| `tests/e2e/file-access-banner.spec.ts` | "File access is disabled." banner with the toggle probe stubbed off: where it appears, where it must not, and that a good Refresh clears it |
| `tests/e2e/script-details.spec.ts` | E2E for which rows the details panel shows, and for the row-label tooltips |
| `tests/e2e/script-preview.spec.ts` | E2E for the viewer's preview mode: Add install, Update, invalid-header refusal, a web page reported rather than followed, `@require` tabs |
| `tests/unit/prelude-gates.test.mjs` | Drives the minified prelude in a `node:vm` DOM stub to pin the decision / @run-at join at max(decision, run-at) |
| `tests/unit/sample.test.mjs` | Placeholder Node `--test` unit test |
| `tests/unit/refresh-targets.test.mjs` | Unit tests for targeted-refresh selection: local-only, path overlap, manifest dirs, container rows |
| `tests/unit/directories.test.mjs` | Unit tests for the `file://` listing parser and path/URL helpers |
| `tests/unit/github-provider.test.mjs` | Unit tests for the GitHub provider: URL parsing, blob→raw rewrite, default-branch resolution, Contents-API directory scanner |
| `tests/unit/github-auth.test.mjs` | Unit tests for the GitHub auth helper: host-gated `Authorization` header, no token → no header, never leaks to non-GitHub hosts |
| `tests/unit/userscript-header.test.mjs` | Unit tests for the metadata-block parser + header/body splitter |
| `tests/unit/script-store.test.mjs` | Unit tests for the pure helpers in the script store (merge, validate, build, compare) |
| `tests/unit/script-updater.test.mjs` | Unit tests for the updater's rate-limit / concurrency gate, its Log-tab outcome entries, and the startup replay |
| `tests/unit/script-display.test.mjs` | Unit tests for the size/status display helpers + the name/path decode helpers |
| `tests/unit/version-compare.test.mjs` | Unit tests for `@version` ordering: numeric segments, missing tails, prereleases, empty input, the `-local` edit verdict |
| `tests/unit/local-delete.test.mjs` | Unit tests for deleting local copies: which files qualify, the own / shared dependency split |
| `tests/unit/local-copy.test.mjs` | Unit tests for local copies: name validation and defaults, the copy-of-itself check, header rewriting, mirror layout, file plan, setting parsing, collection lookup |
| `tests/unit/version-probe.test.mjs` | Unit tests for probe target selection, the outdated verdict, and the staleness gate |
| `tests/e2e/version-probe.spec.ts` | E2E for update probes: newer/older upstream, unreachable probe, own-URL skip, OUTDATED status + viewer rows |
| `tests/unit/collection-display.test.mjs` | Unit tests for collection-display helpers: type classification, manifest flag, short-name inference, effective display name |
| `tests/unit/script-sites.test.mjs` | Unit tests for the hosting-site page rewrites, the cross-spelling identity key, and the row's suppression rules |
| `tests/unit/script-links.test.mjs` | Unit tests for the viewer link helpers: URL/text tokenizer + `// @tag value` line parser + header-marker detectors |
| `tests/unit/stack-link.test.mjs` | Unit tests for `parseStackRefs` (URL + line/col extraction, query strings, ports) and `displayRefText` (which URLs decode) |
| `tests/unit/script-source-url.test.mjs` | Unit tests for the canonical `sourcemonkey://SourceMonkey/…` URL builders — every URL shape, plus label encoding (dedup `#N`, spaces, emoji) |
| `tests/unit/bytes.test.mjs` | Base64 round-trip for the byte helpers, including the empty body and past the 32 KiB chunk boundary |
| `tests/unit/script-url-hash.test.mjs` | Unit tests for `parseHash` / `buildHash`: filename/line/col forms, percent encoding, round-trip, and invalid-input fallbacks |
| `tests/unit/code-tabs.test.mjs` | Unit tests for `expandToVisualColumn`: tab-stop expansion of a V8 stack column, and out-of-range clamping |
| `tests/e2e/script-viewer-links.spec.ts` | E2E tests for the viewer's link rendering: Match-row anchors, Location anchor, body header `@match` / URL linkification |
| `tests/unit/sw-teardown.test.mjs` | Unit tests for the `No SW` recognizer and the unhandledrejection handler that marks it handled |
| `tests/unit/script-log-id.test.mjs` | Unit tests for `computeLogIds` (bare basename when unique, `#N` suffixes when dupes share a basename) |
| `tests/unit/script-log.test.mjs` | Unit tests for the per-script log store: append/get/clear, concurrent appends, LOG_CAP rotation |
| `tests/unit/match-index.test.mjs` | `onlyProbesChanged` — which `script:*` writes may skip a re-registration, and the many that may not |
| `tests/unit/log-format.test.mjs` | Unit tests for the log cell strings, the CSV rendering (quoting, order), and the export filename |
| `tests/unit/url-match.test.mjs` | Unit tests for `@match` / `@include` / `@exclude` URL matching |
| `tests/unit/match-targets.test.mjs` | Unit tests for `@match` pattern parsing: origin / linkUrl extraction, distinct-site de-dup, wildcard-trim path rule, same-dir fallback |
| `tests/unit/site-icon.test.mjs` | Unit tests for the icon-specific helpers: `@icon`-header extraction, `<link rel="icon">` parsing + scoring, cache-hit rules, `data:`→Blob decode |
| `tests/unit/parse-sandbox-host.test.mjs` | Unit tests for `isParseVerdict` — only the three real statuses pass, so an odd reply can't read as `invalid` |
| `tests/unit/parse-location.test.mjs` | Unit tests for probe selection and line mapping, driven by positions Chromium really reported |
| `tests/unit/harness-prepare.test.mjs` | `prepareScript` over real tmp files: entries and world, invalid header, syntax error location, local `@require` overrides, `explainMatch` |
| `tests/unit/parse-check-node.test.mjs` | Unit tests for the Node parse checker: verdict, both probes' positions, and the two probe-selection routes |
| `tests/unit/validate-userscripts.test.mjs` | Drives the validator CLI as a subprocess over the example suites plus a hand-built offline tree |
| `tests/unit/diagnostic-location.test.mjs` | Unit tests for the diagnostic label + validator, especially what they do with a partial location |
| `tests/unit/file-loader.test.mjs` | Unit tests for ref resolution (schemes, relative paths, traversal) and for the reason each resolve/fetch failure reports |
| `tests/unit/refresh-error.test.mjs` | Unit tests for the refresh-error message wording and the storage-value coercion |
| `tests/unit/concurrency.test.mjs` | Unit tests for `mapWithConcurrency`: result ordering, the in-flight cap, edge limits, and what a rejection does to the rest |
| `tests/unit/external-files.test.mjs` | Unit tests for `distillRequires`/`distillResources` + `attachFiles` (cache hits, preserve, dedup, UTF-8, cross-kind) and the failure wording |
| `tests/unit/local-file-overrides.test.mjs` | Unit tests for local stand-in search roots, host/path-suffix candidates, containment, and the `attachFiles` `localRoots` leg |
| `tests/e2e/parse-check.spec.ts` | The parse-check mechanism: compiles without executing, judges as a function body, catches join-only conflicts |
| `tests/e2e/parse-check-install.spec.ts` | Install/refresh-time parse failures surface as `invalid`, healthy scripts stay `ok`, and an unverified row is caught before it registers |
| `tests/e2e/parse-check-pages.spec.ts` | The parse check holds on page-driven paths: the install preview's warning, Install, Refresh, Refresh All |
| `tests/e2e/preload-hints.spec.ts` | A fetched response's `Link: rel=preload` header reaches no extension page — both page-side readers hop to the service worker |
| `tests/e2e/local-file-overrides.spec.ts` | End-to-end local stand-ins across `@require` / `@resource` / `@icon`: suffix matching, live re-read, fallback, opt-out, traversal, configured roots |
| `tests/e2e/options-local-roots.spec.ts` | Options-page local-file-override roots box: hydration, saving, format complaints, missing-directory warnings |
| `tests/e2e/requires.spec.ts` | End-to-end `@require` coverage: file:// / HTTP relative path prefetch, `.js` suffix + traversal rejection, cross-script dedup, manual-vs-opportunistic refresh policy |
| `tests/e2e/log-stack-mapping.spec.ts` | Log tab maps `err.stack` lines back to the `@require`/body they came from; clicks and the CSV export follow that mapping |
| `tests/e2e/log-export.spec.ts` | Log tab's Save / Copy buttons: save dialog, cancel + write-failure reporting, download fallback, clipboard text, empty-log disable |
| `tests/unit/injector.test.mjs` | Unit tests for the injector: spec build, active-spec collection, refusal logging, retry limits, sync serialization and scoping |
| `tests/unit/generated-wrappers.test.mjs` | Guard test: each minified wrapper (`WRAPPER_*`) is a single line of valid JS with load-bearing tokens intact |
| `tests/unit/source-map.test.mjs` | Unit tests for VLQ encoding, line-level mappings, and inline-map encoding |
| `tests/unit/gm-api-catalog.test.mjs` | Unit tests for the GM_* / GM.* catalog: lookup, alias resolution, `@grant` canonicalization, `none` precedence |
| `tests/unit/gm-bindings.test.mjs` | Unit tests for the per-script GM_* / GM.* binding emitter — granted output, sync stub routing, async sendMessage envelope, GM4 alias shape |
| `tests/unit/unsafe-window.test.mjs` | Unit tests for `unsafeWindow` — world resolution (granted and ungranted), per-world GM runtime need, isolated-world warning, bridge wire markers |
| `tests/unit/unsafe-window-use.test.mjs` | Unit tests for the ungranted-`unsafeWindow` source scan: comments, strings, templates, declarations, limits |
| `tests/unit/gm-value-codec.test.mjs` | Unit tests for the page-side stored-value codec — type fidelity, raw storage of JSON-clean values, legacy-row decoding |
| `tests/unit/gm-runtime-transport.test.mjs` | Unit tests for the runtime's transport choice — direct channel only with `chrome.runtime.id`, bridge on an `externally_connectable` page |
| `tests/unit/gm-values.test.mjs` | Unit tests for the SW-side `gmval:` storage helpers — key composition, batch apply with last-write-wins, sentinel deletes, namespace isolation |
| `tests/unit/line-diff.test.mjs` | Unit tests for the line diff: round-trip, shortest script, hunk boundaries, the large-edit fallback |
| `tests/unit/script-identity.test.mjs` | Unit tests for the related-versions lookup — identity key rules, absolute-URL matching, list disjointness, install / move target cases |
| `tests/e2e/gm-grants.spec.ts` | E2E tests: `@grant` gating, ungranted APIs return undefined, GM_info shape, `GM.` alias namespace, `GM.setValue` granted form |
| `tests/e2e/gm-storage.spec.ts` | E2E tests for `GM_setValue`/`GM_getValue`/`GM_deleteValue`/`GM_listValues` round-trip, persistence across reloads, per-script namespace isolation, `GM.` promised forms |
| `tests/e2e/versions-navigation.spec.ts` | E2E for the panel's place on the page, its keyboard walk, and selecting copies from it in place: click / Enter / Space / new-tab, where focus lands, sticky sections, Back, the preview's merged box |
| `tests/e2e/compare.spec.ts` | E2E tests for the compare page: fields table, per-file tabs and chips, view controls, swap, preview side, missing copy |
| `tests/e2e/other-versions.spec.ts` | E2E tests for the other-versions panel: absolute-URL matching across collection kinds, per-row toggle, Refresh all, removing the copy on screen, the preview's callout / banner / install-offer section, the heading fold |
| `tests/e2e/gm-dom.spec.ts` | E2E tests for `GM_addStyle` / `GM_addElement` — CSS application, tag-aware default parent (head/body), explicit-parent form, GM4 alias, permission gating, the MAIN-world CSP-blocked report |
| `tests/e2e/gm-clipboard.spec.ts` | E2E tests for `GM_setClipboard` via `navigator.clipboard.writeText` — text round-trip, GM4 alias, permission gating |
| `tests/e2e/gm-broadcast.spec.ts` | E2E tests for cross-tab `GM_setValue` broadcast — tab B sees tab A's write, survives an SW restart, re-syncs after a missed write or delete |
| `tests/e2e/gm-storage-types.spec.ts` | E2E: `Date`/`Map`/`Set`/`NaN`/binary/`Error` survive a reload, plain values stay untagged, pre-codec rows still read |
| `tests/e2e/gm-storage-freshness.spec.ts` | E2E: fresh documents see the latest `GM_setValue` (same-tab nav, fresh tab, write-then-navigate race) |
| `tests/e2e/gm-storage-teardown-main.spec.ts` | E2E: a MAIN-world `GM_setValue` right before a script-driven navigation or a tab close still reaches the next document |
| `tests/e2e/gm-storage-read-leak.spec.ts` | E2E: a page-forged bridge `sm:check-pending` can't read another script's `GM_setValue` snapshot (`__viaBridge` gate) |
| `tests/e2e/gm-main-world-surface.spec.ts` | E2E: the GM_* surfaces that only ran isolated before — `window.onurlchange`, `window.close`/`focus`, value-change listeners, menu fires, `GM_openInTab` onclose — working from MAIN world |
| `tests/e2e/gm-unsafe-window.spec.ts` | E2E: `@grant unsafeWindow` reaches real page globals, GM_* works over the MAIN-world bridge (also for `@inject-into page`), and forged bridge calls are refused per world and per grant |
| `tests/e2e/gm-unsafe-window-implicit.spec.ts` | E2E: `unsafeWindow` used without granting it — MAIN world, binding, startup log, and the cases we leave alone |
| `tests/e2e/gm-value-listeners.spec.ts` | E2E tests for `GM_addValueChangeListener` / `GM_removeValueChangeListener` — local fire with remote=false, delete fire, remove-by-id, cross-tab remote=true, permission gating |
| `tests/e2e/gm-xhr.spec.ts` | E2E tests for `GM_xmlhttpRequest` text path — GET text, JSON, POST body, HTTP errors firing onload, network failure → onerror, abort, permission gating |
| `tests/e2e/gm-xhr-credentials.spec.ts` | E2E tests for `GM_xmlhttpRequest` cookies — credentialed by default, withheld by a truthy `anonymous` |
| `tests/e2e/gm-xhr-headers.spec.ts` | E2E tests for `GM_xmlhttpRequest` header surgery — overrides reach the wire, URL tag stays inside the browser, rule torn down after |
| `tests/e2e/gm-xhr-binary.spec.ts` | E2E tests for `GM_xmlhttpRequest` binary path — arraybuffer/blob/document via base64 wire reconstruction |
| `tests/e2e/gm-connect.spec.ts` | E2E tests for `@connect` gating — no-connect blocked, matching exact allowed, `*` wildcard, subdomain match, mismatched host blocked |
| `tests/unit/gm-connect.test.mjs` | Unit tests for `@connect` parsing/matching — wildcard, self, exact, subdomain, scheme-prefixed normalization, malformed entries |
| `tests/unit/gm-download.test.mjs` | Unit tests for the `GM_download` SW dispatcher (URL/name validation, terminal events, timeout, abort, progress polling) |
| `tests/unit/gm-xhr-headers.test.mjs` | Unit tests for XHR header classification, DNR rule building, and per-request URL tagging |
| `tests/unit/gm-tab.test.mjs` | Unit tests for the `GM_openInTab` SW dispatcher (mapping, close routing, originator cleanup) |
| `tests/unit/gm-menu.test.mjs` | Unit tests for the `GM_registerMenuCommand` registry (declaration order, in-place update, per-document scoping of clear/unregister) |
| `tests/unit/deep-link.test.mjs` | Unit tests for `buildDeepLinkTarget` — URL prefix match, allowlist, passthrough params, null on bad input |
| `tests/unit/markup-response.test.mjs` | Unit tests for the markup guard: content-type families, leading-`<` body test, message wording |
| `tests/unit/install-capture.test.mjs` | Unit tests for the `.user.js` capture helpers: URL predicate, forge page-view exclusion, install-page URL, one-shot bypass |
| `tests/unit/action-menu.test.mjs` | Unit tests for the action context-menu planner: 6-item cap, reload row, More-submenu overflow, group cohesion, order preservation |
| `tests/unit/gm-notification.test.mjs` | Unit tests for the `GM_notification` SW dispatcher (mapping, click/close terminality, timeout auto-clear) |
| `tests/e2e/gm-log.spec.ts` | E2E tests for `GM_log` (per-script prefix, GM4 alias, gating) |
| `tests/e2e/gm-open-in-tab.spec.ts` | E2E tests for `GM_openInTab` (URL, call shapes, onclose, gating) |
| `tests/e2e/gm-download.spec.ts` | E2E tests for `GM_download` (http(s) transfer, in-page blob/data path, refusals + transfer failure + Log entry, abort, no `@connect` gating) |
| `tests/e2e/gm-notification.spec.ts` | E2E tests for `GM_notification` (call shapes, Promise return, empty-text rejection, gating) |
| `tests/e2e/toolbar-click.spec.ts` | Toolbar-click open of the collections page: a repeat click reuses the window's existing tab |
| `tests/e2e/gm-menu.spec.ts` | SM-only E2E for `GM_registerMenuCommand` via the SW test surface, incl. the per-document clear rules |
| `tests/unit/window-onurlchange.test.mjs` | Unit tests for the SW-side `window.onurlchange` driver (document targeting, message shape, no-receiver rejection) |
| `tests/e2e/window-onurlchange.spec.ts` | E2E for `@grant window.onurlchange` — pushState / replaceState / fragment / back delivery, payload shape, gating, assignment form |
| `tests/unit/gm-window-control.test.mjs` | Unit tests for the SW-side `window.close` / `window.focus` driver (tab close, tab select + window raise, minimized restore, failures) |
| `tests/e2e/window-close-focus.spec.ts` | E2E for `@grant window.close` / `window.focus` — the tab really closes and re-selects, overrides are per-grant, the page's own methods stay native, and the per-document grant leak is pinned |
| `tests/unit/tab-status.test.mjs` | Unit tests for the per-tab badge classification + report-merge helpers |
| `tests/examples/README.md` | Overview of the interactive userscript example pages; how to serve and use as a cross-manager compliance reference |
| `tests/examples/index.html` | Index page linking the per-example subdirs |
| `tests/examples/examples.css` | Shared styling for all example pages |
| `tests/examples/<api>/` | Each example dir holds `<api>.html`, `<api>.user.js`, and `<api>.spec.ts` — the page, the userscript that drives it, and its Playwright e2e |
| `tests/examples/gm-info/` | `GM_info` example: a header-heavy script hands its `GM_info` to the page, which renders a cross-manager comparison table |
| `tests/examples/gm-log/` | `GM_log` per-script-prefix demo |
| `tests/examples/gm-storage/` | `GM_setValue`/`getValue`/`deleteValue`/`listValues` examples (form-driven) |
| `tests/examples/gm-value-listeners/` | `GM_addValueChangeListener` / `GM_removeValueChangeListener` examples |
| `tests/examples/gm-dom/` | `GM_addStyle` and `GM_addElement` DOM-injection examples |
| `tests/examples/gm-clipboard/` | `GM_setClipboard` round-trip example |
| `tests/examples/gm-xmlhttp/` | `GM_xmlhttpRequest` form-driven example (method, body, responseType, anonymous, headers, abort) plus a cross-manager wire-header report |
| `tests/examples/gm-open-in-tab/` | `GM_openInTab` call-shape examples (active, background, positional, onclose) |
| `tests/examples/gm-notification/` | `GM_notification` call-shape examples (button-driven) |
| `tests/examples/gm-download/` | `GM_download` call-shape examples (relative + absolute http(s), `data:`, `blob:`, abort, 404, refused cases) |
| `tests/examples/gm-menu/` | `GM_registerMenuCommand` / `GM_unregisterMenuCommand` button-driven examples |
| `tests/examples/gm-resource/` | `GM_getResourceText` / `GM_getResourceURL` examples reading prefetched CSS, JSON, and SVG `@resource` files |
| `tests/examples/window-onurlchange/` | `@grant window.onurlchange` example — page-wired pushState / replaceState / hash / back buttons with a urlchange log |
| `tests/examples/window-close-focus/` | `@grant window.close` / `window.focus` example — buttons that close this tab and raise the browser window |
| `tests/examples/headers-run-at/` | `@run-at` header example with one userscript per value (`document-start`/`-end`/`-idle`) on a shared page |
| `tests/examples/headers-inject-into/` | `@inject-into` header example: MAIN-world (`page`) vs USER_SCRIPT-world (`content`) userscripts showing window-isolation |
| `tests/examples/unsafe-window/` | `unsafeWindow` example: reading/calling/writing page globals, the isolated-world variant where it can't work, and the ungranted-reference variant |
| `tests/examples/require-scope/` | `@require` scope example: a shared lib's top-level class/const/function reaching both injection worlds |
| `tests/examples/xmlhttp-denied/` | Negative cases for `@connect`: scripts with no `@connect`, mismatched host, and explicit allow show blocked-vs-allowed outcomes |
| `tests/bad-examples/` | Deliberately broken `*.user.js` files (plus the `@require` libraries some of them need, and the ones that merely warn) for the SM-only spec; outside `tests/examples/` so the TM loader doesn't see them |
| `tests/e2e/bad-scripts.spec.ts` | SM-only e2e: each bad script gets the expected status, error location, and byte-for-byte viewer render |
| `tests/e2e/diagnostic-links.spec.ts` | Clicking a diagnostic's location jumps to the file and line, in the installed viewer and the install preview |

### Harness suite (`tests/harness/`)

Runs under the `harness` Playwright project: a plain Chromium with no
extension, driven by the Node host in `src/harness/`.

| File | Description |
|------|-------------|
| `tests/harness/inject.spec.ts` | Injection end to end: start and error reports, URL misses, world choice, storage seeding and writes, cross-page broadcast, remove and re-inject |

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
| `docs/storage.md` | `chrome.storage.local` schema, status model, load/refresh pipeline, collections-page render |
| `docs/updates.md` | How scripts update from their install source, the focus-triggered local check, and why `@updateURL`/`@downloadURL` are probed but never followed |
| `docs/file-access.md` | `file://` access, FSA rationale, directory enumeration, listing-format caveat |
| `docs/http-collections.md` | `http(s)://` script and manifest collections, container routing, GitHub handling, conditional GETs |
| `docs/script-viewer.md` | Userscript viewer page + header parser (`splitHeaderBody`, `parseHeader`, …) |
| `docs/matching.md` | `@match`/`@include`/`@exclude` semantics, in-memory match index, per-tab badge |
| `docs/injection.md` | `chrome.userScripts` registration lifecycle, activation/error wrapper, opt-in requirements |
| `docs/injection-modes.md` | Three possible per-script `js[]` arrangements (separate entries vs concat vs eval-per-require); why we ship separate entries |
| `docs/supported-headers.md` | Inventory of `@tag` metadata fields — which ones SourceMonkey honors, which are parsed-only, and which are ignored |
| `docs/logging.md` | SW console-message catalog: log IDs (basename + `#N` dupes), the debug-logging gate, and which lines it gates |
| `docs/names-and-paths.md` | Decode-for-display rule for names/URLs: what gets percent-decoded, what stays encoded, and why |
| `docs/script-log.md` | Per-script event log: schema, storage layout, what gets logged, viewer Log tab behavior |
| `docs/diagnostics.md` | The shared location every content-derived verdict carries, who produces one, and how surfaces make it clickable |
| `docs/site-icons.md` | Favicon fetch+cache + the icon slot rendered beside each script name; URL extraction lives in `match-targets.ts` |
| `docs/requires.md` | `@require` pipeline: resolution, storage, refresh policy, cross-script dedup, failure handling, injection composition |
| `docs/local-file-overrides.md` | Loading `@require` / `@resource` / `@icon` from local disk instead of the declared URL: suffix rule, safety gate, refresh + cache policy, UI |
| `docs/resources.md` | `@resource` pipeline + GM_getResourceText / GM_getResourceURL plumbing: prefetch, base64 storage, blob URL minting, shared infra with @require |
| `docs/industry-research.md` | Survey of existing userscript managers and AI-assisted "vibe-coding" tools in the same space |
| `docs/GM-API-strategy.md` | Decision doc comparing VM-embed vs own-impl for `GM_*` APIs; recommends own-impl with VM as reference |
| `docs/GM-APIs.md` | `GM_*` / `GM.*` implementation status: catalog, bindings emitter, world gating, `@grant` resolution, GM4 alias namespace |
| `docs/xhr-header-surgery.md` | How `GM_xmlhttpRequest` sets forbidden request headers via short-lived DNR rules — URL-tag targeting, defaults, blind spots |
| `docs/GM-APIs-storage.md` | Storage subsystem in depth: why values live in-document, how the cache is seeded, freshness mechanisms after `GM_setValue`, wire format |
| `docs/supported-GM-APIs.md` | User-facing per-API inventory: which `GM_*` names work, which are stubbed, and how they map to TM / VM / GM4 |
| `docs/offline-validation.md` | The install-time checks as a CLI: what it shares with production, the two pieces it can't, offline dependency roots |
| `docs/corpus-validation-results.md` | Snapshot of the validator's findings over the example suites and the GreasyFork top-2000 |
| `docs/testing.md` | Unit + e2e test harness layout, the SW test surface, and the Chrome-flags workaround for headless user-scripts |
| `docs/cross-manager-testing.md` | How the examples suite runs against Tampermonkey and Violentmonkey: persistent profiles, CDP attach, the two install mechanisms, fragile bits |
| `docs/cross-manager-test-results.md` | Snapshot of what passes / skips / fails under Tampermonkey and Violentmonkey today, with triage notes for each divergence |
| `docs/redirect-page.md` | Canonical GitHub-hosted "front door" the extension watches for; deep-link target that rewrites to `chrome-extension://...` |
| `docs/deep-link.md` | Design of the external-page → extension-page redirect (GitHub URL + `webNavigation` + allowlisted `page` param) |
| `docs/install-capture.md` | How `.user.js` link clicks become installs: what Chrome does on its own, the capture, the prompt, the bypass |
| `docs/script-identity.md` | How two rows are recognised as the same script, and the "Other versions" panel built on it |
| `docs/file-changes.md` | Files changed behind SourceMonkey's back: the drop-on-refresh rule per collection kind, the paint-time chips, the collection's "refresh pending" chip |
| `docs/local-delete.md` | Deleting a local copy: what can be deleted and why, the dialog, dependency files, order and failure |
| `docs/local-copy.md` | Local copies of a script: the Downloads collection, why `chrome.downloads`, the dialog, header rewriting, dependency layout, what's next |
| `docs/harness-design.md` | Proposal: packaging SourceMonkey's pipeline and injected code as a harness for other repos, the push and extension backends, `sm-dev` |
| `docs/harness-guide.md` | Proposal, user-facing: what a userscript repo installs, the `sm-dev` commands, the Playwright fixture API, what is and isn't faithful |
