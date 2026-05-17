# Architecture

VibeMonkey is a Manifest V3 Chrome extension that manages and injects
userscripts. This doc is the **high-level map only** — component
details live in the topic-specific docs linked below.

> **Status:** Skeleton. Components below describe the intended shape;
> injection is not implemented yet.

## Components

```
+------------------+        +-----------------------+        +---------------+
| Options page UI  |  -->   | background service    |  -->   | chrome.storage
| (options.html)   |        | worker (background.ts)|        |  .local       |
+------------------+        +-----------------------+        +---------------+
                                      |
                                      v
                            +-----------------------+
                            | chrome.scripting      |
                            | injects userscripts   |
                            | into matching pages   |
                            +-----------------------+
```

- **Service worker** (`src/background.ts`) — central event handler.
  Today exposes `self.VibeMonkey` for tests and opens the options
  page on toolbar click.
- **Options page** (`src/options.html` + `src/options.ts`) — manage
  source directories and inspect per-script status. See
  [storage.md](storage.md).
- **Script store** (`src/script-store.ts`) — persistence layer + the
  load / refresh pipeline. Owns the chrome.storage.local schema. See
  [storage.md](storage.md).
- **Directory I/O** (`src/directories.ts`) — `file://` fetcher,
  directory-listing parser, and recursive `*.user.js` scanner. See
  [file-access.md](file-access.md).
- **Header parser** (`src/userscript-header.ts`) — splits a
  `.user.js` file into header + body and parses the metadata block.
  See [script-viewer.md](script-viewer.md).
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
