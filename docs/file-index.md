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

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | MV3 extension manifest |
| `src/background.ts` | Service worker entrypoint; per-tab badge wiring, vm:start/vm:error listener, injector + match-index bootstrap |
| `src/options.html` | Options page markup: path-entry form, file-access banner slot, directory list |
| `src/options.ts` | Options page controller — initial render, banners, in-place updates with per-control busy spinners, Refresh All + ?refresh trigger + change-row highlights |
| `src/userscript.html` | Userscript viewer markup: filename, status, scrollable highlighted code box |
| `src/userscript.ts` | Userscript viewer controller — fetches the `file://` URL via XHR and highlights it |
| `src/directories.ts` | Directory I/O: `file://` fetch, listing parser, recursive `*.user.js` scanner, path/URL helpers |
| `src/script-store.ts` | Persistent userscript store (chrome.storage.local) plus the load/refresh/validate pipeline (incl. size+mtime skip and refreshAllSources) |
| `src/script-display.ts` | Pure display helpers shared by the options page + viewer: `formatBytes`, `formatScriptSize`, `formatScriptStatusLabel` |
| `src/userscript-header.ts` | Parser for the `// ==UserScript== … // ==/UserScript==` metadata block + header/body splitter |
| `src/url-match.ts` | Pure URL-matching predicate for `@match` / `@include` / `@exclude` patterns |
| `src/match-index.ts` | In-memory cache of `ok` scripts' matching info, kept in sync with `chrome.storage.local` |
| `src/injector.ts` | Syncs the enabled-`ok` script set into `chrome.userScripts` and wraps each body with an activation/error shim |
| `src/tab-status.ts` | Pure helpers for per-tab badge view (expected ∪ actual classification, color) and per-tab document LRU (bfcache restore) |
| `src/wrapper-head.js` | Wrapper prelude (IIFE open, vars, sendMessage helper, matcher slot, vm:start, try-open) — minified to one line by the build |
| `src/wrapper-tail.js` | Wrapper postlude (catch, vm:error send, IIFE close) — minified to one line by the build |
| `src/wrapper-matcher.js` | Optional matcher block (urlMatchesScript port) inserted into the head when a script uses `/regex/` patterns |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (placeholder) |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: launches Chromium with the extension, exposes SW handle and an HTTP fixture server |
| `tests/fixtures/pages/blank.html` | Minimal fixture page served by the in-test HTTP server |
| `tests/e2e/smoke.spec.ts` | Smoke test: SW loads, options page renders, fixture server responds |
| `tests/unit/sample.test.mjs` | Placeholder Node `--test` unit test |
| `tests/unit/directories.test.mjs` | Unit tests for the `file://` listing parser and path/URL helpers |
| `tests/unit/userscript-header.test.mjs` | Unit tests for the metadata-block parser + header/body splitter |
| `tests/unit/script-store.test.mjs` | Unit tests for the pure helpers in the script store (merge, validate, build) |
| `tests/unit/script-display.test.mjs` | Unit tests for the size/status display helpers (incl. MISSING label) |
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
| `docs/script-viewer.md` | Userscript viewer page + header parser (`splitHeaderBody`, `parseHeader`, …) |
| `docs/matching.md` | `@match`/`@include`/`@exclude` semantics, in-memory match index, per-tab badge |
| `docs/injection.md` | `chrome.userScripts` registration lifecycle, activation/error wrapper, opt-in requirements |
