# Architecture

VibeMonkey is a Manifest V3 Chrome extension that manages and injects
userscripts. This doc is the **high-level map only** — component
details live in the topic-specific docs linked below.

> **Status:** Skeleton. The matching + injection pipeline is wired up
> end-to-end (badge counts matches; `chrome.userScripts` runs them).
> `@grant` / `@require` / `@resource` support is not implemented yet.

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
- **Directory I/O** (`src/directories.ts`) — `file://` fetcher,
  directory-listing parser, and recursive `*.user.js` scanner. See
  [file-access.md](file-access.md).
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

## Cross-cutting docs

- [storage.md](storage.md) — `chrome.storage.local` schema, status
  model, load/refresh pipeline, options-page table rendering.
- [file-access.md](file-access.md) — `file://` permissions, why we
  chose paths over the File System Access API, directory-listing
  enumeration, format caveats.
- [script-viewer.md](script-viewer.md) — userscript viewer page, header parsing,
  syntax highlighting.
- [matching.md](matching.md) — `@match`/`@include`/`@exclude`
  semantics, in-memory match index, per-tab badge + tooltip.
- [injection.md](injection.md) — `chrome.userScripts` registration
  lifecycle, the activation/error wrapper, opt-in requirements,
  unsupported pattern forms.

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
