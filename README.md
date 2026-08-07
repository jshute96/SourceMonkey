# SourceMonkey - Userscript manager Chrome extension

Userscripts are JavaScript patch scripts that modify specific web
pages. They're like lightweight Chrome extensions that are easy to
write, update and share. A userscript manager handles your registered
scripts.

SourceMonkey is a userscript manager that treats userscripts like source code,
built and managed with real coding tools.

During development, userscripts live on local disk, where you can work
on them with standard software engineering tools (editors, IDEs,
debuggers) and vibe-coding or agentic coding tools (like Claude Code).
You can write tests and use source control (like GitHub) easily.
SourceMonkey picks up the newest version from disk and installs it in
Chrome automatically.

Userscripts can also be loaded from the web, including from GitHub repos, and
from sites like [Greasy Fork](https://greasyfork.org/).

SourceMonkey is generally compatible with
[TamperMonkey](https://www.tampermonkey.net/) and other common
userscript managers.

### Example userscripts

[`tests/examples`](tests/examples/README.md) includes example scripts
that interactively demonstrate supported `GM` APIs and other
functionality.

These also function as a **compliance test suite** for userscript managers,
with tests that compare behavior between SourceMonkey and TamperMonkey.

### Status

SourceMonkey works end-to-end for script development, and loading
scripts that use common features. Most `GM*` APIs are wired up, and
common headers including `@require` and `@resource` are supported. See
[docs/supported-GM-APIs.md](docs/supported-GM-APIs.md) and
[docs/supported-headers.md](docs/supported-headers.md) for details.

There's no released version yet, so you have to [build from
source](#development).

## Getting started

1. Build and load the extension — see [Development](#development).
2. On `chrome://extensions`, for SourceMonkey enable:
   - **Pin to toolbar**, so the SourceMonkey icon is visible.
   - **"Allow User Scripts"** (on Chrome 120–137, the page-wide
     Developer mode toggle instead). Without it Chrome refuses to
     inject anything.
   - **"Allow access to file URLs"**, if you want to load scripts from
     local disk.

   The permission toggles persist across browser restarts, and
   SourceMonkey shows a banner with a link to the toggle whenever one is
   missing.
3. Click the SourceMonkey toolbar icon to open the **sources page**.
   On first run it seeds a few default sources so the page isn't empty;
   remove them like any other source.

## Using SourceMonkey

### The sources page

The sources page is where scripts are registered and managed. Each
source has a section listing its scripts, with enable toggles (per
source and per script), reorder buttons, and **Refresh** / **Remove**.
**Refresh All** re-checks everything at once.

Each script row shows a status, linking to that script's log, where there
are usually more details:

| Status | Meaning |
| --- | --- |
| `OK` | Loaded and registered |
| `INVALID` | The script can't run: bad or missing headers, a `@require` that wouldn't load, or a syntax error |
| `REJECTED` | The script is fine, but Chrome refused to register it |
| `MISSING` | The file is gone from its source (deleted on disk, dropped from a manifest) |
| `REFRESH FAILED` | Still running its last good copy, but the newest update attempt failed |
| `OUTDATED` | Running and current with its own source, but the script's `@updateURL` / `@downloadURL` advertises a newer version |
| `ERROR` / `WARNING` | Loaded fine, but some errors or warnings have been logged |

Clicking a script name opens the **script viewer**, which shows the script's
headers, content (including the `@require` files it loads), status, and a
**Log** tab showing errors and other log messages.

When the same script is installed more than once — the same URL under two
sources, or the same `@name` and `@namespace` from two different places — the
viewer lists the copies in an **Other versions** panel, where each one can be
enabled, updated, or opened.

The **Options** link at the top-left covers `.user.js` link capture,
debug logging, and a GitHub token (for private repos and a higher API
rate limit).

Details: [docs/storage.md](docs/storage.md) (status model),
[docs/script-viewer.md](docs/script-viewer.md),
[docs/script-identity.md](docs/script-identity.md),
[docs/script-log.md](docs/script-log.md),
[docs/diagnostics.md](docs/diagnostics.md).

### Registering sources

Type a path or URL into the Add Source field and click **Add source**.
A source can be:

- An **absolute path or `file://` URL to a directory** of userscripts.
  Scanned recursively; every `*.user.js` becomes a row.
- A **single `.user.js`**, by local path or `http(s)://` URL. This
  opens a preview first (see below).
- A **manifest** (`script_manifest.json`) — a list of userscripts to
  load. See [Manifest files](#manifest-files-script_manifestjson).
- A **GitHub URL**, pasted straight from the browser. A repo, a
  `/tree/…` directory, or a `/blob/…` file all work; directories are
  scanned via the GitHub API.

Single scripts are grouped into one of three container sources, created
on demand — `Scripts from local disk`, `Scripts from web`,
`Scripts from GitHub`.

Details: [docs/file-access.md](docs/file-access.md),
[docs/http-sources.md](docs/http-sources.md).

### Installing scripts from a `.user.js` link

Click a `.user.js` link anywhere — Greasy Fork, GitHub, a file on your
own disk, etc. — and SourceMonkey previews it instead of letting Chrome
download the file.

The preview shows the script's source code and some summary information,
and validates the script and its `@require` libraries, reporting errors for
invalid scripts.  **Install** loads the script, the same as adding its
URL on the sources page.

If the script is already registered, the preview allows updating the
existing copy. A script that arrives via a collection source you already
subscribe to can still be installed as a copy of your own — the preview
lists both and lets you pick.

Link capture can be turned off on the Options page if you want Chrome's
defaults or have another userscript manager handling links.

Details: [docs/install-capture.md](docs/install-capture.md),
[docs/parse-check.md](docs/parse-check.md).

### Manifest files (`script_manifest.json`)

SourceMonkey allows adding a directory as a source, and then
automatically loading all userscripts under that directory.

For local directories, and supported web sources like GitHub,
SourceMonkey can list files to find the userscripts. Other file hosting
sites may not support listing files. Manifest files allow loading
multi-userscript collections from these sites too.

A manifest file is a JSON file containing a list of userscripts to
load, typically using relative paths starting from the manifest file's
location.

The manifest body is JSON in one of two shapes — a bare array, or an
object with a `scripts` key:

```json
["foo.user.js", "sub/bar.user.js", "https://elsewhere/baz.user.js"]
```

```json
{ "scripts": ["foo.user.js", "sub/bar.user.js"] }
```

Each entry is a URL string:

- **Relative** entries resolve against the manifest's own location, so
  the same manifest works unchanged whether it's served over HTTP or
  read from a local directory.
- **Absolute** URLs (`https://…`, `file:///…`) are used verbatim, and
  can point anywhere.

To generate a manifest from a directory of userscripts, run
`scripts/make_manifest.sh` inside that directory and redirect stdout to
`script_manifest.json`.

### Keeping scripts up to date

- **While you browse**, SourceMonkey checks in the background whether
  the source files of the scripts running on the page have changed. Any
  change is loaded immediately, and the toolbar badge turns purple with
  a "Reload to update" tooltip.
- **Reloading a tab picks up edits on the same click** — SourceMonkey
  races a quick re-check against the page load, so a script you just
  saved usually runs on that very reload.
- **Refresh** (per source, or **Refresh All**) checks for updates manually.
  External tools can trigger it by opening
  `chrome-extension://<extension-id>/sources.html?refresh`.
- Re-fetches are cheap: HTTP sources use conditional GETs, local files
  compare size + mtime, and unchanged content is detected by hash.
- Every script updates from the place you installed it. A declared
  `@updateURL` / `@downloadURL` is read for its `@version` and reported
  as `OUTDATED`, but never fetched from — so a script can't quietly
  move its own update channel to a site you didn't approve.

Details: [docs/updates.md](docs/updates.md).

### The toolbar icon

As you browse, the toolbar icon shows how many scripts apply to the
current page, colored by health: **green** all good, **orange**
scripts missing or unexpected, **purple** a newer version is available
(reload the page to update), **red** a script errored or Chrome refused to
register it.

Hovering the icon lists each script and its status.  Right-clicking also lists
scripts and statuses.  Click one to open it in the viewer — or straight to
its log, if it errored.

When scripts register context menu commands (`GM_registerMenuCommand`),
those also appear on the icon's right-click menu.

Chrome only shows six top-level entries in that menu.  Anything past
that goes under a `More` submenu.

### Supported `GM_*` / `GM.*` APIs and headers

SourceMonkey supports the standard header fields and `GM` APIs common to
other userscript managers.

A script gets the APIs it asks for with `@grant`, in either the classic
`GM_setValue` spelling or the newer `GM.setValue` one. Anything it
didn't ask for isn't there. `@require`d libraries see the same APIs
their script does.

For exactly which names work and how they compare to Tampermonkey,
Violentmonkey, and Greasemonkey 4, see
[docs/supported-GM-APIs.md](docs/supported-GM-APIs.md).

For the header tags SourceMonkey honors, see
[docs/supported-headers.md](docs/supported-headers.md).

### How scripts run

Scripts run either in the page's own JavaScript world or in an isolated
one, chosen the same way Tampermonkey and Violentmonkey choose: a
script with no `@grant` (or `@grant none`) shares the page's world and
can read its globals, like `window.jQuery`; anything else is isolated.
Set `@inject-into page` or `@inject-into content` to pick explicitly.

Whatever a script throws is caught and reported against that script —
including failures that happen later, from timers, event listeners, and
promises. They show up in the script's **Log** tab with a clickable
stack trace that lands on the offending line, in the `@require`d
library file when that's where it came from.

Details: [docs/injection.md](docs/injection.md),
[docs/injection-modes.md](docs/injection-modes.md).

## Development

### Setup

Requires Node.js 22 or newer.

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
directory, then enable the toggles listed under [Getting
started](#getting-started).

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

See [docs/testing.md](docs/testing.md) for the harness layout,
[docs/cross-manager-testing.md](docs/cross-manager-testing.md) for the
one-time TM profile setup, and
[docs/cross-manager-test-results.md](docs/cross-manager-test-results.md)
for known TM-specific divergences.

### Validate userscripts from the command line

The install-time checks — header validation, `@require` / `@resource`
loading, and the compile-only syntax check — also run as a CLI, over
files on disk and with no browser involved:

```sh
npm run validate -- path/to/scripts/          # a directory, or single files
npm run validate -- --offline-root DIR PATH   # dependencies from a local tree
npm run validate -- --json out.json PATH      # per-script results
```

It reports each script as `ok` or `invalid` with the same message the
extension would show, grouped by failure type. `--offline-root` serves
every `@require` / `@resource` URL out of a downloaded tree instead of
the network, which is how the GreasyFork corpus
(`tests/greasyfork-examples/`) gets checked in bulk. See
[docs/offline-validation.md](docs/offline-validation.md).

### Code layout

- `src/` — extension source (TypeScript + manifest + HTML).
- `scripts/build.mjs` — bundler-free build script.
- `scripts/validate-userscripts.mjs` — offline validator CLI (above).
- `tests/unit/` — Node `--test` unit tests.
- `tests/e2e/` — Playwright tests that load the unpacked extension.
- `tests/examples/` — interactive GM API example pages with paired
  userscripts; double as a cross-manager compliance reference. See
  [tests/examples/README.md](tests/examples/README.md).
- `docs/` — design docs. Start with
  [docs/architecture.md](docs/architecture.md) for the component map,
  and [docs/file-index.md](docs/file-index.md) for a one-line
  description of every file.

## License

MIT. See `LICENSE`.
