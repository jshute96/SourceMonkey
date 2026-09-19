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
[Tampermonkey](https://www.tampermonkey.net/) and other common
userscript managers.

### Example userscripts

[`tests/examples`](tests/examples/README.md) includes example scripts
that interactively demonstrate supported `GM` APIs and other
functionality.

These also function as a **compliance test suite** for userscript managers,
with tests that compare behavior between SourceMonkey, Tampermonkey,
and Violentmonkey.

### Status

SourceMonkey works end-to-end for script development, and loading
scripts that use common features. Most `GM*` APIs are wired up, and
common headers including `@require` and `@resource` are supported. See
[docs/supported-GM-APIs.md](docs/supported-GM-APIs.md) and
[docs/supported-headers.md](docs/supported-headers.md) for details.

SourceMonkey isn't in the Chrome Web Store — install it from a release
zip or [build from source](#development). It requires **Chrome 152 or
newer**; the manifest declares that floor, so older Chrome refuses to
load it.

## Getting started

1. Get an extension directory, either way:
   - **From a release zip:** download `SourceMonkey-vX.Y.Z.zip` from the
     [Releases page](https://github.com/jshute96/VibeMonkey/releases)
     and unzip it.
   - **From source:** build it — see [Development](#development) — which
     writes `dist/`.

   Then in Chrome open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select that directory.
2. On `chrome://extensions`, for SourceMonkey enable:
   - **Pin to toolbar**, so the SourceMonkey icon is visible.
   - **"Allow User Scripts"**. Without it Chrome refuses to inject
     anything.
   - **"Allow access to file URLs"**, if you want to load scripts from
     local disk.

   The permission toggles persist across browser restarts, and
   SourceMonkey shows a banner with a link to the toggle whenever one is
   missing.
3. Click the SourceMonkey toolbar icon to open the **collections page**.
   On first run it seeds a few default collections so the page isn't empty;
   remove them like any other collection.

## Using SourceMonkey

### The collections page

The collections page is where scripts are registered and managed. Each
collection has a section listing its scripts, with enable toggles (per
collection and per script), reorder buttons, a trash can that removes
the collection, a gear that opens its rename/options dialog, and a
circular arrow that refreshes it. **Refresh All**, in the header bar at
the top of the page, re-checks everything at once.

Each script row shows a status, linking to that script's log, where there
are usually more details:

| Status | Meaning |
| --- | --- |
| `OK` | Loaded and registered |
| `INVALID` | The script can't run: bad or missing headers, a `@require` that wouldn't load, or a syntax error |
| `REJECTED` | The script is fine, but Chrome refused to register it |
| `MISSING` | The file is gone from its collection (deleted on disk, dropped from a manifest) |
| `REFRESH FAILED` | Still running its last good copy, but the newest update attempt failed |
| `OUTDATED` | Running and current with its own source, but the script's `@updateURL` / `@downloadURL` advertises a newer version |
| `ERROR` / `WARNING` | Loaded fine, but this script has produced errors or warnings this session |

Clicking a script name opens the **script viewer**, which shows the script's
headers, content (including the `@require` files it loads), status, and a
**Log** tab showing errors and other log messages.

A script that lives in a scripts collection can be moved to another one
from the viewer's **Collection** row, keeping its log and its stored
`GM_setValue` data.

**Local copy…** on the same row writes an editable copy of any installed
script into `SourceMonkey/` under the browser's Downloads folder, which
becomes the **Scripts copied in Downloads** collection. The copy takes
over as the running version, and edits made to it in any editor are
picked up by Refresh. The dialog lets you rename the file, adjust the
version (`-local` by default) and description, and optionally copy the
script's `@require` / `@resource` files beside it.

The badged trash can beside it — a can with a small disk, the glyph
reserved for deleting a file rather than just a record — deletes such a
copy: the file on disk and its record in SourceMonkey, after a
confirmation naming the path and every dependency file the copy loads,
saying which of them go with it. Copies are the one thing SourceMonkey
can delete from disk, since the browser downloaded them.

When the same script is installed more than once — the same URL under two
collections, or the same `@name` and `@namespace` from two different places — the
viewer lists the copies in an **Other versions** panel at the top of the page,
where each one can be enabled, updated, opened, or removed. Clicking another
copy's row switches the page to it in place, leaving the panel as it is. Enabling one
copy disables the others, since two enabled copies of a script both run —
ctrl-click a checkbox (cmd-click on a Mac) to override that.

The **Options** link at the top, beside Refresh All, covers `.user.js` link capture,
debug logging, local file override directories, the Downloads folder
local copies land in, and a GitHub token (for private repos and a
higher API rate limit).

Details: [docs/storage.md](docs/storage.md) (status model),
[docs/script-viewer.md](docs/script-viewer.md),
[docs/script-identity.md](docs/script-identity.md),
[docs/local-copy.md](docs/local-copy.md),
[docs/local-delete.md](docs/local-delete.md),
[docs/script-log.md](docs/script-log.md),
[docs/diagnostics.md](docs/diagnostics.md).

### Registering collections

Type a path or URL into the Add field and click **Add**. What you type
can be:

- An **absolute path or `file://` URL to a directory** of userscripts.
  Scanned recursively; every `*.user.js` becomes a row.
- A **single `.user.js`**, by local path or `http(s)://` URL. This
  opens a preview in a new tab first (see below).
- A **manifest** (`script_manifest.json`) — a list of userscripts to
  load. See [Manifest files](#manifest-files-script_manifestjson).
- A **GitHub URL**, pasted straight from the browser. A repo, a
  `/tree/…` directory, or a `/blob/…` file all work; directories are
  scanned via the GitHub API.
- A **name**, or nothing at all, to make an empty collection for
  scripts you install one at a time.

A directory, manifest, or name opens a small dialog first, where you can
give the collection a name and set its options; it checks that the
location can be read before creating anything.

Single scripts go into **scripts collections** — folders you create
and name, or the defaults created on demand (`Scripts from local disk`,
`Scripts from web`, `Scripts from GitHub`). One scripts collection can
mix local, web, and GitHub scripts.

Details: [docs/file-access.md](docs/file-access.md),
[docs/http-collections.md](docs/http-collections.md).

### Installing scripts from a `.user.js` link

Click a `.user.js` raw file link anywhere — Greasy Fork, GitHub, a file on your
own disk, etc. — and SourceMonkey previews it instead of letting Chrome show
the bare source.

The preview shows the script's source code and some summary information,
and validates the script and its `@require` libraries, reporting errors for
invalid scripts. Pick which collection to put it in — or make a new
one — and **Install** loads the script, the same as adding its URL on
the collections page.

If the script is already registered, the preview lists every copy and
lets you open or update each one, or install another copy elsewhere.
A script that arrives via a collection you already subscribe to can
still be installed as a copy of your own.

Link capture can be turned off on the Options page if you want Chrome's
defaults or have another userscript manager handling links.

Details: [docs/install-capture.md](docs/install-capture.md),
[docs/parse-check.md](docs/parse-check.md).

### Local development vs deployed scripts

Scripts can reference and load other files with `@require`, `@resource` and `@icon` headers.
Tampermonkey and Greasemonkey require absolute paths.

To make local development on disk easier, SourceMonkey also allows relative
paths, resolved against the script's own location. A script loaded over
http(s) may point anywhere it could already name with an absolute URL
(`../lib/util.js`, `//cdn.example.com/util.js`), matching Violentmonkey;
a script loaded from disk is confined to its own directory.
Tampermonkey resolves neither, so relative paths still cost portability.

Therefore, when publishing a script, absolute http paths are preferred.

SourceMonkey enables local development on these scripts by **reading local files
in place of http references**. For scripts run from local files, if there's
a file under the script's directory — or under the directory of the collection
it came from — matching any suffix of the requested host and path, the local
file will be read instead. So a shared `lib/` at the top of a scripts
directory is reachable from a script nested inside it.

Additional local directories can be added to the search path on the Options page.

This allows local development of the script and its resource files, without
adjusting the file paths.

See [docs/local-file-overrides.md](docs/local-file-overrides.md).

### Manifest files (`script_manifest.json`)

SourceMonkey allows adding a directory as a collection, and then
automatically loading all userscripts under that directory.

For local directories, and supported web hosts like GitHub,
SourceMonkey can list files to find the userscripts. Other file hosting
sites may not support listing files. Manifest files allow loading
multi-userscript collections from these sites too.

A manifest file is a JSON file containing a list of userscripts to
load, typically using relative paths starting from the manifest file's
location.

The manifest body is JSON in one of two shapes — a bare array, or an
object with a `scripts` key. Each entry is a URL string, or an object
with a `path` field holding that string; other fields are ignored:

```json
["foo.user.js", "sub/bar.user.js", "https://elsewhere/baz.user.js"]
```

```json
{ "scripts": ["foo.user.js", "sub/bar.user.js"] }
```

```json
{
  "scripts": [
    { "path": "foo.user.js", "note": "my fork of upstream" },
    { "path": "sub/bar.user.js", "note": "another script" }
  ]
}
```

Entry paths resolve like this:

- **Relative** entries resolve against the manifest's own location, so
  the same manifest works unchanged whether it's served over HTTP or
  read from a local directory.
- **Absolute** URLs (`https://…`, `file:///…`) are used verbatim, and
  can point anywhere.

To generate a manifest from a directory of userscripts, run
`scripts/make_manifest.sh` inside that directory and redirect stdout to
`script_manifest.json`.

### Keeping scripts up to date

Nothing polls on a timer. A script's source is re-checked at these
moments, and any change is loaded immediately — the toolbar badge then
turns purple with a "Reload to update" tooltip.

- **Loading a page** re-checks the scripts that run on it.
- **Switching to a tab** re-checks the scripts on it that came from
  local disk. So editing a script in your editor and switching back to
  the browser turns the badge purple before you reload, and that reload
  runs the new version. Scripts installed from the web are left alone
  here, to avoid a request to their site every time you change tabs.
- **Reloading a tab picks up edits on the same click** — SourceMonkey
  races a quick re-check against the page load, so a script you just
  saved usually runs on that very reload.
- The same script is re-checked at most once every 10 seconds, so two
  edits in quick succession may need a moment before the second is
  noticed.
- **Refresh** (per collection, or **Refresh All**) checks for updates manually.
  External tools can trigger a refresh by opening the collections page with
  one of these, where `<id>` is the extension's ID:
  - `chrome-extension://<id>/collections.html?refresh` — every collection.
  - `chrome-extension://<id>/collections.html?refresh_local` — only the
    collections that live on local disk, skipping the web ones.
  - `chrome-extension://<id>/collections.html?refresh_file=<path>` — only
    what covers that file or directory, including the collections that
    scan it, so a file you added, renamed, or deleted is noticed too.
- Re-fetches are cheap: HTTP collections use conditional GETs, local files
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

The menu's last row, **Reload page with no userscripts**, reloads the
page once with every script skipped — handy for checking whether a
script is what's breaking a page.  The next ordinary reload runs them
again.  Skipped scripts show as **NOT LOADED** with a **grey** badge.

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
A script that grants `unsafeWindow` runs in the page's world too, since
`unsafeWindow` is the page's window, and its other `GM_*` APIs still
work there. Set `@inject-into page` or `@inject-into content` to pick
explicitly.

Whatever a script throws is caught and reported against that script —
including failures that happen later, from timers, event listeners, and
promises. They show up in the script's **Log** tab with a clickable
stack trace that lands on the offending line, in the `@require`d
library file when that's where it came from.

Details: [docs/injection.md](docs/injection.md),
[docs/injection-modes.md](docs/injection-modes.md).

## Development

### Setup

Requires Node.js 22 or newer and [pnpm](https://pnpm.io) (the package
manager this repo uses; `corepack enable pnpm` installs it from a Node
checkout).

```sh
pnpm install
pnpm exec playwright install chromium
```

### Build

```sh
pnpm run build       # one-shot build into dist/
pnpm run watch       # rebuild on TS changes
```

The built extension is written to `dist/`. Load it into Chrome via
`chrome://extensions` → "Load unpacked" → select the `dist/`
directory, then enable the toggles listed under [Getting
started](#getting-started).

### Test

```sh
pnpm test            # unit + e2e
pnpm run test:unit   # node --test, fast
pnpm run test:e2e    # Playwright with the extension loaded
pnpm run test:headed # e2e with a visible browser
```

To narrow a run to one file:

```sh
node --test tests/unit/header-parser.test.mjs    # For one unit test
pnpm run test:e2e tests/e2e/injection.spec.ts    # For one e2e test
```

The examples suite (`tests/examples/`) can also run against
Tampermonkey or Violentmonkey for cross-manager compliance checks:

```sh
# One-off: install/update every example userscript into the running manager
node scripts/sync-manager-scripts.mjs --manager tampermonkey

# Run the examples suite against a manager, headless.
# Its headed browser must be closed.
pnpm run test:e2e:tm
pnpm run test:e2e:vm

# Or, headed: connects via CDP to that manager's browser — the script's
# preflight step launches it if it isn't already running.
pnpm run test:e2e:tm:headed
pnpm run test:e2e:vm:headed
```

The headed variants connect over CDP to the browser opened by
`scripts/open-test-browser.sh <manager>`. The headless variants launch
their own Chromium against the same persistent profile (so the same
manager installation), but can't run while the headed browser is open
against that profile.

See [docs/testing.md](docs/testing.md) for the harness layout,
[docs/cross-manager-testing.md](docs/cross-manager-testing.md) for the
one-time profile setup each manager needs, and
[docs/cross-manager-test-results.md](docs/cross-manager-test-results.md)
for known per-manager divergences.

### Validate userscripts from the command line

The install-time checks — header validation, `@require` / `@resource`
loading, and the compile-only syntax check — also run as a CLI, over
files on disk and with no browser involved:

```sh
pnpm run validate path/to/scripts/          # a directory, or single files
pnpm run validate --offline-root DIR PATH   # dependencies from a local tree
pnpm run validate --json out.json PATH      # per-script results
```

It reports each script as `ok` or `invalid` with the same message the
extension would show, grouped by failure type. `--offline-root` serves
every `@require` / `@resource` URL out of a downloaded tree instead of
the network, which is how the GreasyFork corpus
(`tests/greasyfork-examples/`) gets checked in bulk. See
[docs/offline-validation.md](docs/offline-validation.md).

### Releasing

Cut a GitHub release with `scripts/release-extension.sh` (tag `vX.Y.Z`).

1. Bump the version in **both** `package.json` and `src/manifest.json`
   to the same value, and commit.
2. From a clean `main`, run:
   ```sh
   scripts/release-extension.sh             # draft (default)
   scripts/release-extension.sh --publish   # publish immediately
   ```

The script verifies the versions match, `main` is clean and in sync with
`origin/main`, and the tag is unused; then builds + zips the extension as
`/tmp/SourceMonkey-vX.Y.Z.zip`, creates and pushes an annotated tag, and
calls `gh release create` (the [GitHub CLI](https://cli.github.com/)) with
auto-generated notes and the zip attached. The default is a draft so you can
review and publish from the GitHub UI.

To build a distributable zip without releasing:

```sh
scripts/zip_extension.sh   # writes /tmp/SourceMonkey.zip
```

### Code layout

- `src/` — extension source (TypeScript + manifest + HTML).
- `scripts/build.mjs` — bundler-free build script.
- `scripts/validate-userscripts.mjs` — offline validator CLI (above).
- `scripts/zip_extension.sh` — builds and zips `dist/` for distribution.
- `scripts/release-extension.sh` — cuts a tagged GitHub release with the
  zip attached.
- `tests/unit/` — Node `--test` unit tests.
- `tests/e2e/` — Playwright tests that load the unpacked extension.
- `tests/examples/` — interactive userscript example pages with paired
  userscripts; double as a cross-manager compliance reference. See
  [tests/examples/README.md](tests/examples/README.md).
- `docs/` — design docs. Start with
  [docs/architecture.md](docs/architecture.md) for the component map,
  and [docs/file-index.md](docs/file-index.md) for a one-line
  description of every file.

## License

MIT. See `LICENSE`.
