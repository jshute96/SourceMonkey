# SourceMonkey

A userscript manager Chrome extension that treats userscripts like source code, built and managed with real coding tools.

> **Status:** Works end-to-end for the common cases. The options
> page can register local directories or HTTP manifests, every
> `*.user.js` it finds is persistently loaded, matching scripts are
> injected via `chrome.userScripts`, and the most-used `GM_*` /
> `GM.*` APIs are wired up. `@require` prefetches and prepends
> required bodies; `@resource` prefetches arbitrary blobs surfaced via
> `GM_getResourceText` / `GM_getResourceURL`. Deferred: XHR header
> surgery and `GM_cookie`. See
> [docs/supported-GM-APIs.md](docs/supported-GM-APIs.md) for the
> per-API surface.

## Usage

Open the options page by clicking the SourceMonkey toolbar icon, or via
`chrome://extensions` → SourceMonkey → "Details" → "Extension options".

### Registering sources

Type a source into the Add Source field and click **Add source**. The
source is scanned immediately and every userscript it produces is
loaded into the extension's storage. A source can be any of:

- An **absolute path to a directory** of userscripts. Scanned
  recursively (up to two subdirectory levels deep); every
  `*.user.js` becomes a row.
- An **absolute path to a single `.user.js` file**. Shows up as a
  one-row source.
- A **`file://` URL** in either of the two forms above (anywhere a
  bare path works, the URL form works too).
- An **`http(s)://` URL ending in `.user.js`** — fetched as a single
  remote script.
- A **manifest**: anything whose pathname ends in `.json`. The
  manifest is fetched and the URLs it lists become individual scripts.
  Works at an http(s) URL, a `file://` URL, or a bare local path —
  the same manifest file can be tested locally and then served over
  HTTP unchanged.

Each source shows up as its own section on the options page with a
per-source enable toggle, per-script enable toggles, a **Refresh**
button (re-scans + re-fetches just that source), and a **Remove**
button. The page-level **Refresh All** does every source at once.

### Manifest format

The manifest body is JSON in one of two shapes:

```json
["foo.user.js", "sub/bar.user.js", "https://elsewhere/baz.user.js"]
```

```json
{ "scripts": ["foo.user.js", "sub/bar.user.js"] }
```

Each entry is a URL string. Resolution rules:

- **Absolute** URLs (`https://…`, `file:///…`) are used verbatim.
- **Relative** URLs resolve against the manifest URL's parent:
  `foo.user.js` listed in `https://example.com/scripts/manifest.json`
  becomes `https://example.com/scripts/foo.user.js`; the same entry
  in `/home/me/scripts/manifest.json` becomes
  `/home/me/scripts/foo.user.js`.
- Entries are trimmed; empty strings and duplicates are skipped.
- A non-string entry or a body that isn't one of the two supported
  shapes fails the whole source with a scan error.

To generate a manifest from a directory of userscripts, run
`scripts/make_manifest.sh` inside that directory and redirect stdout
to `manifest.json` — it scans recursively for `*.user.js` and emits
the bare-array shape.

### Refresh behaviour

HTTP entries (whether a top-level single-file source or reached via a
manifest) re-fetch with conditional GETs — SourceMonkey stores each
script's `ETag` / `Last-Modified` and sends them on the next refresh,
so an unchanged file answers `304` and no body is re-downloaded.
Local-directory sources skip refetches when the file's size +
modification time match the stored copy. For combinations where
neither pre-fetch shortcut applies (manifest entries, HTTP servers
that don't return validators), the fetched body's hash is compared
against the prior so identical content still counts as "no change."

### Per-source UI

- Each source section shows a table with a per-script enable toggle
  plus **Filename**, **Size**, and **Status** (`OK` or `ERROR`). The
  source itself has an enable toggle to the left of its path/URL;
  disabling a source greys out (and effectively disables) every
  script under it without losing each script's own choice. The table
  header has a small **+** / **−** button that bulk-enables or
  bulk-disables every script in that source.
- A script reports `ERROR` when its metadata block is missing or
  malformed, or when required fields (`@name` plus `@match`/
  `@include`) aren't present — hover the status cell to see the
  reason. A 0-byte file shows `0 B` in the size column (still an
  `ERROR` for the missing metadata block).
- If a script was loaded before but no longer appears in the scan
  (file deleted, manifest entry removed), its status becomes
  `MISSING`. The Size column keeps showing the cached body's byte
  count, and a small trash-can button next to the status lets you
  clear the record for files you don't expect to come back. Refresh
  alone won't re-add a missing row.
- Each script row shows the favicon of the site its `@match`
  patterns target, to the left of the filename. Icons are discovered
  by fetching the matched page's HTML and parsing
  `<link rel="icon">`, with `/favicon.ico` and Google's S2 favicon
  service as fallbacks; the result is cached for a week.
- After a refresh, any row that actually changed is highlighted:
  light green when it updated successfully, light red when it errored
  or vanished. The color stays on the row until the next refresh. A
  vanished script is automatically disabled so it stops being
  injected; the row stays in storage and the user can re-enable it
  if it comes back.
- External tools can trigger a refresh-all by opening the options
  page with `?refresh` in the query string, e.g.
  `google-chrome chrome-extension://<extension-id>/options.html?refresh`
  after writing new userscripts to disk.
- Clicking a script name opens a viewer in a new tab showing the
  file's name, size, status, an enable toggle (greyed out when the
  parent source is disabled), a parsed-header summary (Name /
  Description / Match / Exclude), and the highlighted source. The
  viewer reads from storage; its own **Refresh** button re-fetches
  just this one script (from disk for local sources, over HTTP for
  URL-backed ones). The **Location** row shows the absolute
  filesystem path for local sources and the resolved URL for
  URL-backed ones.
- As you browse, the SourceMonkey toolbar icon shows a per-tab badge
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
  SourceMonkey checks (in the background, rate-limited, never blocking
  navigation) whether their source files on disk have changed. Any
  change is loaded into storage and the affected tabs flip purple
  with a "Reload to update" tooltip — same signal you'd see after a
  manual Refresh.
- **Reload picks up edits on the same click.** When you explicitly
  reload a tab whose scripts you just edited, SourceMonkey races a
  filesystem re-check against the page load (≤500ms). If the new
  version is ready in time, the updated body runs on that reload
  instead of the old one. If the new script isn't ready in time,
  falls back to the currently loaded script. The next reload will
  get the newer version.

- **Debug logging.** Verbose lifecycle messages — per-navigation
  match lists and the per-script `update check (opportunistic)` /
  `no change` lines that fire on every navigation — are off by
  default to keep the service-worker console quiet. Manual Refresh
  clicks still log unconditionally. Enable the verbose lines via the
  "Enable debug logging" checkbox at the bottom of the options page.
- **Log IDs.** Every script gets a short, file-derived label used in
  every SW log line and shown on the script viewer page (as **Log
  ID**). The label is the script's basename (`foo.user.js`); if two
  scripts share a basename they're disambiguated as `foo.user.js#1`,
  `foo.user.js#2`, etc., and the same suffix is rendered next to the
  filename link on the options page so you can map a log entry back
  to its row.

**One-time setup:** on `chrome://extensions`, for SourceMonkey enable:

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

- Logs `[SourceMonkey] script "<name>" running on <url>` to the page
  console on activation.
- Catches synchronous throws from the body and logs them as
  `[SourceMonkey] script "<name>" threw: <message>`, also forwarding
  to the service worker.
- Installs filtered `window` `error` / `unhandledrejection` listeners
  so async failures from handlers the script installs (timers, event
  listeners, promise chains) are attributed back to the right script
  via a per-script `# sourceURL=` marker and reported the same way.

MAIN-world scripts can't reach the SW directly, so the wrapper falls
back to `window.postMessage` and a tiny USER_SCRIPT-world bridge
forwards those events to the service worker. The badge stays accurate
for `@grant none` / page-world scripts.

### `GM_*` / `GM.*` APIs

SourceMonkey emits per-script bindings at registration time for
every API declared in `@grant` (both legacy `GM_x` and GM4 `GM.x`
forms canonicalize to the same name). Ungranted APIs are
`undefined` in the script's scope.

- **Storage** — `GM_setValue`, `GM_getValue`, `GM_deleteValue`,
  `GM_listValues`, plus `GM_addValueChangeListener` /
  `GM_removeValueChangeListener`. Page-side cache + batched async
  writes; values broadcast live to other tabs running the same
  script.
- **DOM injection** — `GM_addStyle`, `GM_addElement`. CSP-exempt
  in USER_SCRIPT world.
- **Clipboard** — `GM_setClipboard` via `navigator.clipboard.writeText`.
- **XHR** — `GM_xmlhttpRequest` with `text` / `json` / `blob` /
  `arraybuffer` / `document` response types, abort, timeout, and
  `@connect` URL gating (strict-by-default: no `@connect` declared
  → blocked).
- **Logging** — `GM_log` forwards to `console.log` with a per-script
  prefix so multi-script pages stay greppable.
- **Tabs** — `GM_openInTab` opens a new tab via `chrome.tabs.create`
  and returns a `{close, closed, onclose}` control object.
- **Notifications** — `GM_notification` via `chrome.notifications`.
  Supports details-object and legacy positional call shapes; click /
  done callbacks dispatch cross-tab back to the originator.
- **Metadata** — `GM_info` (script metadata + grants list +
  `scriptHandler: "SourceMonkey"`).

For the full per-API inventory — which names work, which are
stubbed not-implemented, and how they map to TM / VM / GM4 — see
[docs/supported-GM-APIs.md](docs/supported-GM-APIs.md).

For the full per-tag inventory — which header fields SourceMonkey
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

To narrow a run to one file:

```sh
node --test tests/unit/header-parser.test.mjs    # For one unit test
npm run test:e2e -- tests/e2e/injection.spec.ts  # For one e2e test
```

The examples suite (`tests/examples/`) can also run against
Tampermonkey for cross-manager compliance checks:

```sh
# One-off: install/update every example userscript into the running TM
node scripts/sync-tm-scripts.mjs

# Run the examples suite against TM, headless. Headed browser must be closed.
npm run test:e2e:tm

# Or, headed: connects via CDP to the TM browser — pretest hook
# launches it if it isn't already running.
npm run test:e2e:tm:headed
```

The headed variant connects over CDP to the browser opened by
`scripts/open-test-browser-with-TamperMonkey.sh`. The headless
variant launches its own Chromium against the same persistent profile
(so the same TM installation), but can't run while the headed browser
is open against the profile.

See [docs/cross-manager-testing.md](docs/cross-manager-testing.md) for
the one-time TM profile setup and the diagnostic helpers, plus
[docs/cross-manager-test-results.md](docs/cross-manager-test-results.md)
for known TM-specific divergences.

### Code layout

- `src/` — extension source (TypeScript + manifest + HTML).
- `scripts/build.mjs` — bundler-free build script.
- `tests/unit/` — Node `--test` unit tests.
- `tests/e2e/` — Playwright tests that load the unpacked extension.
- `tests/examples/` — interactive GM API example pages with paired
  userscripts; double as a cross-manager compliance reference. See
  [tests/examples/README.md](tests/examples/README.md).
- `docs/` — design docs and `file-index.md`.

## License

MIT. See `LICENSE`.
