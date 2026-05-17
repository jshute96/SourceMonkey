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
  UI for managing installed scripts and source directories.
- **Directory store** (`src/directories.ts`): list of local source
  directories that the options page scans for `*.user.js` files. See
  the section below.
- **chrome.storage.local**: persistent storage for installed
  userscripts and per-script settings.
- **chrome.scripting**: API used to inject userscripts into target
  pages.

## Local directory sources

Users can register local directories that contain `*.user.js`
userscripts. The options page lists every script it finds in each
directory (up to two subdirectory levels deep), and each finding
links to the userscript viewer.

### Storage

Two stores, because no single one does both jobs:

- **chrome.storage.local** holds `{id, name}` per directory — the
  user-visible list for rendering and removal. `name` is the leaf
  directory name from `handle.name`.
- **IndexedDB** (`vibemonkey` db, `directoryHandles` store) holds the
  `FileSystemDirectoryHandle` keyed by `id`. Handles aren't valid in
  `chrome.storage` but are structured-cloneable into IndexedDB.

### Add / scan flow

- "Add directory" calls `showDirectoryPicker({ mode: 'read' })`. The
  picker is also what grants Chrome the read permission we'll use to
  enumerate and read files — no `chrome://extensions` toggle needed.
- Render loads the handle, calls `queryPermission` / `requestPermission`
  to re-acquire read access, then walks the directory (depth ≤ 2)
  collecting `*.user.js` files.

### Userscript viewer

Each script link points to `userscript.html?dir=<id>&path=<rel>`.

Permission is scoped per browsing context, so a fresh tab opened on
`userscript.html` does **not** inherit the options page's grant. To
avoid a second permission prompt on every click, the options page
intercepts left-clicks:

1. Read the file's contents on the options page (where the handle's
   permission is already granted).
2. Stash `{name, content}` in `chrome.storage.session` under a random
   key, and append `&key=<key>` to the viewer URL.
3. `window.open(...)` the viewer in a new tab.

The viewer:

- If `key` is present, fetches `{name, content}` from session storage,
  clears it (one-shot), and renders.
- Otherwise (middle-click, "open in new tab", manual reload) falls
  back to loading the handle from IndexedDB and either reads on the
  spot (if permission already granted) or shows a "Grant access and
  load" button that triggers `requestPermission` from a user gesture.

### Syntax highlighting

The viewer uses **Prism.js** (vendored from `node_modules/prismjs` by
`scripts/build.mjs` into `dist/vendor/prism/`). Content is set via
`textContent` and then handed to `Prism.highlightElement` so file
content can't be interpreted as HTML markup. The default Prism theme
is shipped as `prism.css`.

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
