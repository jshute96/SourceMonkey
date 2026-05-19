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
  **Add source**. The directory is scanned (up to two subdirectory
  levels deep) and every `*.user.js` is loaded into the extension's
  storage immediately. You can also point directly at a single
  `.user.js` file — it's treated as a one-script source and shows up
  the same way (heading + a one-row table).
- Each directory section shows a table with a per-script enable
  toggle plus **Filename**, **Size**, and **Status** (`OK` or
  `ERROR`). The directory itself has an enable toggle to the left of
  its path; disabling a directory greys out (and effectively
  disables) every script under it without losing each script's own
  choice. The table header has a small **+** / **−** button that
  bulk-enables or bulk-disables every script under the directory.
  A script reports `ERROR` when its metadata block is missing or
  malformed, or when required fields (`@name` plus `@match`/
  `@include`) aren't present — hover the status cell to see the
  reason. If a file was loaded before but has disappeared from disk,
  the size column shows `MISSING`.
- **Refresh** rescans the directory and reloads every script.
  **Remove** drops the directory (and its scripts) from storage. The
  page-level **Refresh All** button at the top runs Refresh across
  every registered directory. Refresh is incremental — files whose
  size and modification time match the stored copy are skipped
  without re-reading or re-parsing. After a refresh, any row that
  actually changed is highlighted: light green when it updated
  successfully, light red when it errored or vanished. The color
  stays on the row until the next refresh. A vanished
  file is automatically disabled so it stops being injected; the
  row stays in storage and the user can re-enable it if the file
  comes back.
- External tools can trigger a refresh-all by opening the options
  page with `?refresh` in the query string, e.g.
  `google-chrome chrome-extension://<extension-id>/options.html?refresh`
  after writing new userscripts to disk.
- Clicking a script name opens a viewer in a new tab showing the
  file's name, size, status, an enable toggle (greyed out when the
  parent directory is disabled), a parsed-header summary (Name /
  Description / Match / Exclude), and the highlighted source. The
  viewer reads from storage; its own **Refresh** button re-reads the
  one file from disk.
- As you browse, the VibeMonkey toolbar icon shows a per-tab badge
  with the number of scripts involved on the current page (expected
  by the matcher OR actually started by the injected wrapper). The
  badge color signals health:
  - **green** — everything matches up.
  - **orange** — some scripts are missing or unexpected.
  - **purple** — a running script's source on disk has changed; a
    reload would pick up the new version.
  - **red** — at least one script reported an error.

  Hovering the icon shows one line per script as
  `"<name> | <STATUS>"` (`OK` / `ERROR` / `MISSING` / `UNEXPECTED` /
  `Reload to update`). The state updates on navigation and re-counts
  immediately when you flip an enable toggle on the options page.
- **Auto-update.** While you browse a page that uses your scripts,
  VibeMonkey checks (in the background, rate-limited, never blocking
  navigation) whether their source files on disk have changed. Any
  change is loaded into storage and the affected tabs flip purple
  with a "Reload to update" tooltip — same signal you'd see after a
  manual Refresh.
- **Reload picks up edits on the same click.** When you explicitly
  reload a tab whose scripts you just edited, VibeMonkey races a
  filesystem re-check against the page load (≤500ms). If the new
  version is ready in time, the updated body runs on that reload
  instead of the old one. If the new script isn't ready in time,
  falls back to the currently loaded script. The next reload will
  get the newer version.

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

Each script's body runs in either the page's own world (`MAIN`) or
Chrome's isolated `USER_SCRIPT` world. The choice is per-script,
following Violentmonkey's `@inject-into` and Tampermonkey's
`@grant none` default:

- `@inject-into page` → MAIN. `@inject-into content` → USER_SCRIPT.
- Unset / `auto` → MAIN when `@grant` is absent or only `none`,
  otherwise USER_SCRIPT. So a `@grant none` script can read the
  page's own globals (`window.jQuery`, `window.map`, …) like in
  Tampermonkey.

The wrapper around every body:

- Logs `[VibeMonkey] script "<name>" running on <url>` to the page
  console on activation.
- Catches synchronous throws from the body and logs them as
  `[VibeMonkey] script "<name>" threw: <message>`, also forwarding
  to the service worker.
- Installs filtered `window` `error` / `unhandledrejection` listeners
  so async failures from handlers the script installs (timers, event
  listeners, promise chains) are attributed back to the right script
  via a per-script `# sourceURL=` marker and reported the same way.

MAIN-world scripts can't reach the SW directly, so the wrapper falls
back to `window.postMessage` and a tiny USER_SCRIPT-world bridge
forwards those events to the service worker. The badge stays accurate
for `@grant none` / page-world scripts.

For the full per-tag inventory — which header fields VibeMonkey
honors, which are parsed but not acted on, and which are ignored —
see [docs/supported-headers.md](docs/supported-headers.md).

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
