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
| `scripts/make_manifest.sh` | Scan the current dir for `*.user.js` and emit a VibeMonkey HTTP-manifest JSON array to stdout |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | MV3 extension manifest |
| `src/background.ts` | Service worker entrypoint; per-tab badge wiring, vm:* listener (incl. reload-fast-path check-pending handler), injector + match-index bootstrap |
| `src/options.html` | Options page markup: path-entry form, file-access banner slot, directory list |
| `src/options.ts` | Options page controller — initial render, banners, in-place updates with per-control busy spinners, Refresh All + ?refresh trigger + change-row highlights |
| `src/userscript.html` | Userscript viewer markup: title, controls row, details panel, highlighted code box |
| `src/userscript.ts` | Userscript viewer controller — hydrates from the store, renders controls + details dl (header fields + filename/copy/size/status) and highlighted body |
| `src/directories.ts` | Source I/O: file:// + http(s) fetch (conditional GETs), listing parser, recursive scanner, JSON manifest parser, URL helpers |
| `src/script-store.ts` | Persistent userscript store (chrome.storage.local) plus the load/refresh/validate pipeline (incl. size+mtime skip and refreshAllSources) |
| `src/script-updater.ts` | Single entry point for refresh; rate-limits and de-dupes opportunistic background checks while letting manual clicks pass through |
| `src/script-display.ts` | Pure display helpers shared by the options page + viewer: `formatBytes`, `formatScriptSize`, `formatScriptStatusLabel` |
| `src/userscript-header.ts` | Parser for the `// ==UserScript== … // ==/UserScript==` metadata block + header/body splitter |
| `src/url-match.ts` | Pure URL-matching predicate for `@match` / `@include` / `@exclude` patterns |
| `src/match-index.ts` | In-memory cache of `ok` scripts' matching info, kept in sync with `chrome.storage.local` |
| `src/injector.ts` | Syncs the enabled-`ok` script set into `chrome.userScripts` and wraps each body with an activation/error shim |
| `src/tab-status.ts` | Pure helpers for per-tab badge view (expected ∪ actual classification, color) and per-tab document LRU (bfcache restore) |
| `src/debug-log.ts` | Debug-logging gate for verbose lifecycle messages; off by default, toggled via `chrome.storage.local.vmDebugLogging` |
| `src/script-log-id.ts` | Computes a per-script "log ID" (basename, with `#N` suffix on dupes) used in every log line + the options/viewer UI |
| `src/wrapper-head.js` | Wrapper prelude (IIFE, vars, send helper, vm:check-pending await + run/run-new/skip dispatch, matcher slot, try-open) — minified to one line |
| `src/wrapper-tail.js` | Wrapper postlude (catch, vm:error send, decision-callback close, IIFE close) — minified to one line by the build |
| `src/wrapper-matcher.js` | Optional matcher block (urlMatchesScript port) inserted into the head when a script uses `/regex/` patterns |
| `src/wrapper-bridge.js` | USER_SCRIPT-world bridge that forwards `window.postMessage` vm:* events from MAIN-world wrappers to the SW |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (placeholder) |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: launches Chromium with the extension, exposes SW handle, HTTP fixture server, and the `vm` SW-api proxy |
| `tests/fixtures/extension-id.ts` | Computes Chrome's deterministic unpacked-extension ID from an absolute path |
| `tests/fixtures/scripts-dir.ts` | Tmp-dir helper that writes real `*.user.js` files on disk for the production scan/fetch pipeline to ingest |
| `tests/fixtures/sw-api.ts` | Typed wrapper over the `self.VibeMonkey` SW test surface plus a generic `waitFor` polling helper |
| `tests/fixtures/pages/blank.html` | Minimal fixture page served by the in-test HTTP server |
| `tests/fixtures/pages/target.html` | Fixture page with a known `#target` element for injection assertions |
| `tests/fixtures/pages/other.html` | Fixture page used to verify scripts skip non-matching URLs |
| `tests/e2e/smoke.spec.ts` | Smoke test: SW loads, options page renders, fixture server responds |
| `tests/e2e/injection.spec.ts` | End-to-end userscript injection: matching, non-matching, and multiple-script cases |
| `tests/e2e/badge.spec.ts` | Per-tab badge classifications: green/red/orange/purple plus MISSING and post-update RELOAD |
| `tests/e2e/reload-fast-path.spec.ts` | Reload triggers vm:check-pending → swap to fresh body on this reload; non-reload navs don't swap |
| `tests/e2e/sources.spec.ts` | Source lifecycle (add/refresh/remove) via the real file:// scan pipeline |
| `tests/e2e/manifest.spec.ts` | Manifest source refresh: vanished-entry deletion, unreadable-manifest preservation |
| `tests/e2e/options.spec.ts` | Options-page UI flows: add-directory form, Remove button, per-script toggle |
| `tests/unit/sample.test.mjs` | Placeholder Node `--test` unit test |
| `tests/unit/directories.test.mjs` | Unit tests for the `file://` listing parser and path/URL helpers |
| `tests/unit/userscript-header.test.mjs` | Unit tests for the metadata-block parser + header/body splitter |
| `tests/unit/script-store.test.mjs` | Unit tests for the pure helpers in the script store (merge, validate, build) |
| `tests/unit/script-updater.test.mjs` | Unit tests for the updater's rate-limit / concurrency gate |
| `tests/unit/script-display.test.mjs` | Unit tests for the size/status display helpers (incl. MISSING label) |
| `tests/unit/script-log-id.test.mjs` | Unit tests for `basenameOf` + `computeLogIds` (bare basename when unique, `#N` suffixes when dupes share a basename) |
| `tests/unit/url-match.test.mjs` | Unit tests for `@match` / `@include` / `@exclude` URL matching |
| `tests/unit/injector.test.mjs` | Unit tests for the pure injector helpers (run-at mapping, spec build, active-spec collection) |
| `tests/unit/tab-status.test.mjs` | Unit tests for the per-tab badge classification + report-merge helpers |

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
| `docs/supported-headers.md` | Inventory of `@tag` metadata fields — which ones VibeMonkey honors, which are parsed-only, and which are ignored |
| `docs/logging.md` | SW console-message catalog: log IDs (basename + `#N` dupes), the debug-logging gate, and which lines it gates |
| `docs/industry-research.md` | Survey of existing userscript managers and AI-assisted "vibe-coding" tools in the same space |
| `docs/testing.md` | Unit + e2e test harness layout, the SW test surface, and the Chrome-flags workaround for headless user-scripts |
