# VibeMonkey

A userscript manager Chrome extension optimized for vibe-coding.

> **Status:** Early skeleton. The options page can register local
> directories, persistently load every `*.user.js` it finds, and
> open each in an in-extension viewer with syntax highlighting and a
> parsed-header summary. The toolbar badge shows how many of your
> scripts would match the current tab, and matching scripts are now
> actually injected via `chrome.userScripts` (no `@grant` /
> `@require` / `@resource` support yet — `@grant none` scripts only).

## Usage

Open the options page by clicking the VibeMonkey toolbar icon, or via
`chrome://extensions` → VibeMonkey → "Details" → "Extension options".

- Enter the absolute path of a folder containing userscripts and click
  **Add directory**. The directory is scanned (up to two subdirectory
  levels deep) and every `*.user.js` is loaded into the extension's
  storage immediately.
- Each directory section shows a table with a per-script enable
  toggle plus **Filename**, **Size**, and **Status** (`OK` or
  `ERROR`). The directory itself has an enable toggle next to its
  Refresh/Remove buttons; disabling a directory greys out (and
  effectively disables) every script under it without losing each
  script's own choice. A script reports `ERROR` when its metadata
  block is missing or malformed, or when required fields (`@name`
  plus `@match`/`@include`) aren't present — hover the status cell
  to see the reason. If a file was loaded before but has disappeared
  from disk, the size column shows `MISSING`.
- **Refresh** rescans the directory and reloads every script.
  **Remove** drops the directory (and its scripts) from storage.
- Clicking a script name opens a viewer in a new tab showing the
  file's name, size, status, an enable toggle (greyed out when the
  parent directory is disabled), a parsed-header summary (Name /
  Description / Match / Exclude), and the highlighted source. The
  viewer reads from storage; its own **Refresh** button re-reads the
  one file from disk.
- As you browse, the VibeMonkey toolbar icon shows an orange badge
  with the number of enabled scripts whose `@match` / `@include`
  patterns hit the current tab. Hovering the icon lists those scripts
  in the tooltip. The count is per-tab and updates on navigation, and
  re-counts immediately when you flip an enable toggle on the options
  page.

**One-time setup:** on `chrome://extensions`, for VibeMonkey enable:

- **"Allow access to file URLs"** — without it the extension can't
  read your local directories.
- **"Allow User Scripts"** (or, on Chrome 120–137, the page-wide
  Developer mode toggle) — without it Chrome will refuse to inject
  anything, though the badge will still count matches. The options
  page surfaces a banner with a copy-pasteable details URL when this
  toggle is off.

Both toggles are persistent — once on, they stay on across browser
restarts.

Each script's body runs in Chrome's isolated `USER_SCRIPT` world:

- Logs `[VibeMonkey] script "<name>" running on <url>` to the page
  console on activation.
- Catches **synchronous** throws from the body and logs them as
  `[VibeMonkey] script "<name>" threw: <message>` on the page console,
  also forwarding to the service worker log. Async failures (rejected
  Promises, `setTimeout` throws) are not currently captured.

## Installation

Not yet released. To run a local development build, see
[Development](#development) below.

## Development

Requires Node.js 22 or newer.

### Setup

```sh
npm install
npx playwright install chromium
```

### Build

```sh
npm run build       # one-shot build into dist/
npm run watch       # rebuild on TS changes
```

The built extension is written to `dist/`. Load it into Chrome via
`chrome://extensions` → "Load unpacked" → select the `dist/`
directory.

### Test

```sh
npm test            # unit + e2e
npm run test:unit   # node --test, fast
npm run test:e2e    # Playwright with the extension loaded
npm run test:headed # e2e with a visible browser
```

### Code layout

- `src/` — extension source (TypeScript + manifest + HTML).
- `scripts/build.mjs` — bundler-free build script.
- `tests/unit/` — Node `--test` unit tests.
- `tests/e2e/` — Playwright tests that load the unpacked extension.
- `docs/` — design docs and `file-index.md`.

## License

MIT. See `LICENSE`.
