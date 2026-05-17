# Architecture

VibeMonkey is a Manifest V3 Chrome extension that manages and injects
userscripts. This doc is a high-level overview of components and data
flow; topic-specific design notes will live in companion docs as the
project grows.

> **Status:** Skeleton. The pieces below describe the intended shape;
> most of them aren't implemented yet.

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

- **Service worker** (`src/background.ts`): central event handler and
  storage owner. Today it just exposes `self.VibeMonkey` so e2e tests
  have something to call.
- **Options page** (`src/options.html` + `src/options.ts`): user-facing
  UI for managing installed scripts.
- **chrome.storage.local**: persistent storage for installed
  userscripts and per-script settings.
- **chrome.scripting**: API used to inject userscripts into target
  pages.

## Build pipeline

`scripts/build.mjs` is dependency-free:

- Wipes `dist/`.
- Copies `src/icons/`, `src/manifest.json`, and every top-level
  `src/*.html` into `dist/`.
- Invokes `tsc` (optionally with `--watch`) to compile `src/*.ts` →
  `dist/*.js`.

There is no bundler. Each TypeScript module compiles to its own
`dist/*.js` and Chrome loads them directly as ES modules.

## Testing

- Unit tests use the Node `--test` runner against compiled `dist/*.js`.
- E2E tests use Playwright. The fixture in
  `tests/fixtures/extension.ts` launches headless Chromium with the
  unpacked extension loaded from `dist/`, then exposes the MV3 service
  worker so tests can drive the extension via
  `serviceWorker.evaluate(...)` — the toolbar action can't be clicked
  from Playwright in MV3.
