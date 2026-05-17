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
| `src/background.ts` | Service worker entrypoint; exposes `self.VibeMonkey` for tests |
| `src/options.html` | Options page markup: "Add directory" button + directory list container |
| `src/options.ts` | Options page controller — picker, render, click-intercept prefetch into session storage |
| `src/userscript.html` | Userscript viewer markup: filename, status, scrollable highlighted code box |
| `src/userscript.ts` | Userscript viewer controller — loads from session storage or falls back to handle read |
| `src/directories.ts` | Directory store (chrome.storage + IndexedDB handles), scanner, and file reader |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (placeholder) |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: launches Chromium with the extension, exposes SW handle and an HTTP fixture server |
| `tests/fixtures/pages/blank.html` | Minimal fixture page served by the in-test HTTP server |
| `tests/e2e/smoke.spec.ts` | Smoke test: SW loads, options page renders, fixture server responds |
| `tests/unit/sample.test.mjs` | Placeholder Node `--test` unit test |

## Docs (`docs/`)

| File | Description |
|------|-------------|
| `docs/file-index.md` | This file |
| `docs/architecture.md` | High-level architecture and data-flow overview |
