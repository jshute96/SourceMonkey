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
directory (up to two subdirectory levels deep).

### Storage

- **chrome.storage.local** holds `{id, path}` per directory.
  - `path` is an absolute filesystem path the user typed in.
  - `id` is a generated UUID, used only as a removal key.
- No filesystem handles are persisted — we do not use the File System
  Access API. See "Enumeration" below for the trade-off.

### Enumeration

We don't use `showDirectoryPicker()` because it can't expose the
absolute path we need for `file://` URLs. Instead the scanner uses
plain `fetch()` against the `file://` URL of each directory:

- Chrome renders directory `file://` URLs as an HTML listing page.
- That page contains a sequence of `addRow(name, url, isdir, ...)`
  script calls — one per entry.
- `parseListing()` extracts those calls with a tolerant regex, pulling
  out the entry name and the `isdir` flag.

### Requirements

For scanning to work the user must:

- Enable **"Allow access to file URLs"** for VibeMonkey in
  `chrome://extensions`.
- (Already handled in the manifest) have `"file:///*"` in
  `host_permissions`.

When either is missing, `fetch` fails and the options page surfaces
the error inline.

### Render flow

1. Load the directory list from `chrome.storage.local`.
2. For each entry, `fetch` the `file://` URL, parse the listing, and
   recurse into subdirectories up to `MAX_SCAN_DEPTH` (= 2).
3. Sort by relative path; render one section per directory with a
   "Remove" button and a list of `<a href="file://…">` links.

### Listing-format caveat

Chrome's directory-listing HTML is an undocumented format. The
`parseListing` regex matches the `addRow` shape we currently observe
and tolerates both `0/1` and `true/false` for the `isdir` argument.
Unit tests in `tests/unit/directories.test.mjs` pin the expected
shape — if Chrome's format changes, those tests break loudly rather
than the scanner failing silently.

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
