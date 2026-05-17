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

Users register absolute paths to local directories that contain
`*.user.js` userscripts. The options page lists every script it finds
in each directory (up to two subdirectory levels deep) and links each
finding to the userscript viewer.

### Storage

- **chrome.storage.local** holds `{id, path}` per directory.
  - `path` is an absolute filesystem path the user typed in.
  - `id` is a generated UUID, used only as a removal key.
- No `FileSystemDirectoryHandle`, no IndexedDB. We chose paths over
  the File System Access API so that no per-session permission
  re-grant is required.

### Why paths + `file://` instead of FSA

The File System Access API gives clean enumeration and writable
handles, but Chrome **does not persist permission grants across
browser sessions** — the user must click "Grant access" each time the
browser restarts, and there is no API to remember it.

The `chrome://extensions` → "Allow access to file URLs" toggle, by
contrast, is persistent. Once enabled, the extension can read any
`file://` URL with no further prompts, for the life of the install.
Tampermonkey's `@require file://…` feature uses this same mechanism.

### Requirements

For scanning to work the user must:

- Enable **"Allow access to file URLs"** for VibeMonkey on
  `chrome://extensions` (one-time, persistent).
- (Already handled in the manifest) `"file:///*"` is in
  `host_permissions`.

When the toggle is off, `chrome.extension.isAllowedFileSchemeAccess()`
returns false and the options page renders a prominent banner with
the extension's settings URL and instructions.

### Enumeration

Chrome renders `file://` directory URLs as an HTML listing page that
contains a sequence of `addRow(name, url, isdir, ...)` script calls.
`parseListing()` extracts those calls with a tolerant regex.

We use `XMLHttpRequest` (not `fetch`) to read those listings. `fetch`
treats `chrome-extension:// → file://` as cross-origin and returns an
opaque response (status 0, unreadable body); XHR doesn't apply that
restriction. For `file://` XHRs, `status` is 0 even on success, so we
treat any non-empty `responseText` as success.

### Render flow

1. Load the directory list from `chrome.storage.local`.
2. For each entry, fetch the `file://` URL via XHR, parse the
   listing, and recurse into subdirectories up to `MAX_SCAN_DEPTH`
   (= 2).
3. Sort by relative path; render one section per directory with a
   "Remove" button and a list of links into the userscript viewer.

### Userscript viewer

Each script link points to
`userscript.html?src=<file-url>&name=<rel>`. The viewer XHRs `src`
directly each time it's opened — no session-storage hop, no
permission re-prompt. The toggle that enables scanning also enables
the viewer.

### Syntax highlighting

The viewer uses **Prism.js** (vendored from `node_modules/prismjs` by
`scripts/build.mjs` into `dist/vendor/prism/`). Content is set via
`textContent` and then handed to `Prism.highlightElement` so file
content can't be interpreted as HTML markup. The default Prism theme
is shipped as `prism.css`.

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
