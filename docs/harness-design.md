# Userscript development harness: design

The harness is what a userscript repo installs to develop and test its
scripts in the real SourceMonkey: the `sourcemonkey` package, with
`sm-dev`, the `sourcemonkey/harness` Playwright fixture, and the Node
checks behind `validate` and `match`.

- User-facing side: [harness-guide.md](harness-guide.md).
- The `sm-dev` command-line tool's internals, and how the extension
  serves a run: [sm-dev-design.md](sm-dev-design.md).

## The problem

- Most userscript testing is **interactive**: an agent (or a person)
  probes a site, runs the script as it exists so far, watches what
  happens, edits, and tries again. Fast iteration matters more than a
  green suite.
- A typical homemade harness strips the metadata block and runs the
  raw body in the page's own world.
  - Nothing a manager does exists there: no `GM_*`, no `@match`, no
    `@run-at`, no isolation.
  - A hand-written stub file fakes a few `GM_*` calls.
- Running a script in an installed manager is faithful but needs
  coordination: a collection registered in a profile, a refresh when
  headers change, other scripts in the same profile adding noise.
- The harness runs the scripts in the real extension without that
  coordination:
  - It pushes script text straight into the extension, with no
    persistent state.
  - It claims the tabs it works in, so only its own scripts run there.

## Terms

Harness-specific terms, and the browser plumbing it leans on. For the
extension's own pieces, see [architecture.md](architecture.md#components)
and [injection.md](injection.md).

| Term | Meaning |
| --- | --- |
| CDP | Chrome DevTools Protocol: the JSON-over-WebSocket protocol DevTools and Playwright use to drive Chrome. The harness uses it directly where Playwright has no API. |
| SW | The extension's service worker (its background script). |
| Test surface | `self.SourceMonkey`, functions the SW exposes to code evaluated inside it (Playwright's `worker.evaluate`, or CDP). |
| Run | A background `sm-dev` process that owns a browser connection and its tabs (see [sm-dev-design.md](sm-dev-design.md)). |
| Test collection | A collection of scratch scripts belonging to one run (or one spec test), removed when it ends. |
| Claim | A run's hold on a tab: only that run's scripts run there while it lasts (see [sm-dev-design.md](sm-dev-design.md#tab-claims)). |
| Host | `host.ts`: the run's record of what its scripts reported and did. |
| Attachment | A `PageAttachment` (`page-watch.ts`): one Playwright page the run or fixture watches. |

## How it fits together

- Scripts come in as **text or a file path**, never a collection.
- Node checks each one first with the real install pipeline
  (`prepare.ts`), so a broken header or syntax error is reported with
  the extension's wording before anything is pushed.
- The text, and any local `@require` / `@resource` files, are pushed
  into the extension as **scratch scripts** in the run's test
  collection.
- The run claims its tabs, so the extension runs only that run's
  scripts there.
- The SW streams events back (starts, errors, Log entries, menus,
  values, requests, downloads, notifications, opened tabs). The run's
  host records them, and its commands and waits read the record.
- The fixture does the same per test.

## Extension code the harness reuses under Node

These checks run without a browser, for `validate`, `match`, and the
up-front check before a push:

| Piece | Where | Chrome-free? |
| --- | --- | --- |
| Header split + parse | `src/userscript-header.ts` | Yes |
| Header validation, status, diagnostics, `@require` loading | `validateHeader`, `buildScriptFromText`, `applyFiles` in `src/script-build.ts` | Yes, given a `fetch` |
| `@match` / `@include` / `@exclude` evaluator | `src/url-match.ts` | Yes |
| `@grant` catalog and resolution | `src/gm-api-catalog.ts` | Yes |
| `@require` / `@resource` resolution and fetch | `src/external-files.ts`, `src/file-loader.ts`, `src/local-file-overrides.ts` | Yes, given a `fetch` |
| Injection world (`@grant none`, `@inject-into`) | `src/script-world.ts` | Yes |
| Compile-only parse check | `src/harness/parse-check-node.ts` | Yes |
| Stored-value codec | `src/extension/gm-values.ts` | With a storage stub |

## Package and distribution

### The package

- The package is `sourcemonkey`, built by `tsconfig.lib.json` into
  `lib/` with declarations; `dist/` is the extension. See
  [architecture.md](architecture.md#two-outputs-dist-and-lib).
- Both ship: `dist/` is the extension `--temp-browser` and the fixture
  load into the browsers they launch.
- `package.json` carries:
  - `exports`: `./harness` for the harness entry, and `./*` mapping to
    `lib/*.js` so pure modules such as `url-match` and
    `userscript-header` are importable too.
    - Only the modules the harness imports are in `lib/`, so only those
      are importable.
  - `files` for the built outputs and `skills` (the agent skill ships
    beside the code), and `bin: { "sm-dev": ... }`.
  - A `prepare` script that runs the build, so a git install produces
    `lib/` and `dist/`.
  - `@playwright/test` as an optional peer dependency, used only by the
    harness entry.
  - `private: true`. It only blocks `npm publish`; a git install works
    without publishing.
- Consumers pin a git tag. Publishing to npm later would not change the
  import paths.

### How a userscript repo uses it

Details are in the guide; the shape is:

- It installs `github:jshute96/SourceMonkey#<tag>` as a dev dependency.
  - `sourcemonkey` is allowlisted under `allowBuilds` in
    `pnpm-workspace.yaml`, so the `prepare` build runs.
  - While developing both, it uses `file:../SourceMonkey` with
    `dependenciesMeta.injected`.
- Its own fixture file keeps any browser-connection logic (a repo
  policy, not a harness concern) and re-exports `test` / `expect` from
  `sourcemonkey/harness`.
- Its specs are ES modules (`.mjs`, or `"type": "module"`), since
  SourceMonkey is written as ESM.
- Its agent instructions: run `sm-dev start` while iterating, and write
  a spec on the harness fixture once the script is confirmed.

## Components

The modules in `src/harness/`, compiled to `lib/harness/`. They run in
Node.

### `prepare.ts`: script in, injectable script out

- Runs the real install pipeline:
  - `buildScriptFromText`, then `applyFiles` for `@require` and
    `@resource`.
  - Fetches with Node's `fetch`, plus SourceMonkey's local-override
    rules, so a `@require` pointing at a raw GitHub URL reads the local
    `lib/` copy, exactly as the extension would.
- Runs the parse check, composing the program with
  `buildParseCheckSource` (`src/composed-source.ts`).
- Doesn't build the code the extension registers: the extension builds
  that from the pushed text.
- Returns a `PreparedScript`: the stored row, its id, world, matching
  rules, startup logs, and the diagnostic when the script is invalid.
  - An `invalid` script is returned with its diagnostics, not thrown,
    so a tool can print the same message the viewer shows.
  - The files it read from disk are what a push sends with the text
    (`pushedFiles`).
- The script's id is derived from its source URL.
  - Re-preparing the same file keeps its id.
  - Two files sharing a basename stay distinct.
- Calls are serialized: the local-roots setting the override resolver
  reads is process-wide, and so is the state behind the `fetch`
  override and the parse-check note below.
- A `fetch` option answers every dependency fetch in place of the
  network and disk. The corpus validator uses it to serve `@require`s
  from its downloaded tree ([corpus-validation.md](corpus-validation.md)).
- A syntax check that couldn't decide (V8 threw something other than a
  `SyntaxError`) leaves the script `ok`, as in the extension. It is
  returned as `parseCheckNote`, and `validate` reports the script as
  `UNCHECKED`.
- Where Node differs from the extension:
  - The compile is Node's V8, not Chrome's (`parse-check-node.ts`). A
    very new syntax feature, or a `SyntaxError`'s wording, can differ.
  - On a line over ~1020 characters (any minified file) the column
    falls back to 1: V8 clips the frame it renders in `err.stack`. The
    line is still exact.

### `extension-link.ts`: the connection to the extension

- Reaches the SW through Playwright, which lists an extension's service
  worker on a CDP-connected browser as well as a launched one, and
  calls its test surface with `worker.evaluate`.
- The SW's URL is known up front, since the manifest's fixed `key`
  fixes the extension id. An idle SW is woken by opening the
  collections page.
- Pushes scripts, claims tabs, and holds a lease on them, renewed while
  the run lasts and released at its end.
- Subscribes to the SW's event stream, and subscribes again when Chrome
  restarts an idle SW; the run says events in between may be missing.
- Compares its protocol version with the extension's, and refuses one
  whose major differs, naming the fix
  ([version skew](sm-dev-design.md#version-skew)).
- The extension's side, and the claims, are in
  [sm-dev-design.md](sm-dev-design.md).

### `host.ts` and `extension-host.ts`: the records

- `host.ts` (`HarnessHost`) is the record a run or a test reads:
  - the start / error / skipped reports, with `pageOf(record)` naming
    the page each came from (kept in a `WeakMap`, so records stay plain
    data a test can compare);
  - a copy of each script's stored values, kept current from the
    events, for reads that can't wait on a round trip;
  - menu commands, per page document;
  - the recorded requests, downloads, notifications and opened tabs;
  - the waits on these (`untilReported` and friends).
- `ExtensionHost` (`extension-host.ts`) fills it from the extension's
  events, and answers commands (`set`, menu clicks, notification
  clicks) by calling into the extension.
  - It maps the run's script ids to the extension's, and tabs by their
    `chrome.tabs` id.
  - An event from a document the attachment hasn't seen begin yet waits
    for it, since the SW's events and the page's navigations come over
    separate connections.
  - Events from tabs that aren't the run's are left out.

### `page-watch.ts`: watching a page

A `PageAttachment` watches one tab the extension runs scripts in, and
adds nothing the page or its scripts can see:

- Tracks the page's documents and when each began, for the waits and
  for ordering the extension's events against navigations.
- Records which scripts the tab runs, for the host's skip reports and
  the waits.
- Reads what `wait` needs (DOM activity, requests in flight) from a
  CDP-made world of its own.
- Evaluates `eval` inside one script, through the eval hook the
  extension gives a test collection's scripts (see
  [injection.md](injection.md#sm-devs-eval-hook)); or in the page's
  world (`--page`, or no script selected).

### `fixture.ts`: the Playwright fixture

- The `@playwright/test` extension consumers import. Runs the scripts
  in the real extension, as an `sm-dev` run does:
  - a browser per worker from `extension-launch.ts`, unless the repo
    overrides `browser` / `context` / `page` (that browser then needs
    SourceMonkey loaded);
  - per test, an `ExtensionLink` claiming the page and an
    `ExtensionHost` filled from the extension's events;
  - `loadUserscript` prepares the file (validation, `url` check,
    pushed files) and pushes it into the test's collection.
- Request fakes (`interceptRequests`, `failHosts`) pause the worker's
  own requests with CDP's Fetch domain in its target, attached over a
  browser-level session. Playwright's `context.route` sees the worker's
  requests too, but not the hop after a redirect, which a response with
  another `finalUrl` needs.
- Wraps these into `loadUserscript`, `gm`, `reports`, and
  `serveHtml` / `saveHtml`.
  - `serveHtml` routes a saved HTML file at its original URL so
    `@match` and relative URLs still hold (see
    [sm-dev-design.md](sm-dev-design.md#saved-pages) for the serving).
  - HAR replay is left to Playwright's own `routeFromHAR`.
- `tests/harness/fixture.spec.ts` drives it from `lib/` the way a
  consumer would.

### `extension-launch.ts`: a browser with SourceMonkey

- Launches Playwright's Chromium with the package's `dist/` loaded, in
  a throwaway profile with "Allow User Scripts" granted up front.
- One launcher serves `sm-dev --temp-browser`, the fixture, and the
  repo's own e2e suites.
- Details in [sm-dev-design.md](sm-dev-design.md#--temp-browser-extension-launchts).

## Service-worker additions for scratch scripts

Test-surface calls write **scratch scripts**, whose only copy is their
text in storage (see [storage.md](storage.md#container-collections)
for the rows):

- `writeRunScript({ run, text, name?, files? })` installs the text into
  run `run`'s **test collection**, made by its first push.
  - Returns the row's id, status, and diagnostics, after registration
    has completed. (The wrapper names the changed rows to the sync
    itself rather than waiting for the storage event to.)
  - The name is the identity: the one the caller gives, else the
    `@name`. `sm-dev` passes the file's path as it was given, relative
    or absolute, kept whole in the location.
  - Rewriting a name replaces the text in place, keeping the row's id
    and GM values, so the next reload runs the new version.
  - Names that differ only in punctuation collapse into one identity.
  - `files` carries the local `@require` / `@resource` files read from
    disk, which the loaders use in place of resolving or fetching.
- `releaseRun(run)` ends the run's claims and removes its test
  collection, with the rows' `GM_*` values. The SW also removes a
  crashed run's after a grace period (see
  [sm-dev-design.md](sm-dev-design.md#test-collections)).
- For a throwaway profile, `resetAllState()` wipes everything.
- A test collection is a normal `scripts` collection, so the
  collections page and viewer show it like any other and the Log tab
  works unchanged.
- A scratch script runs only in the tabs of the run that pushed it (see
  [sm-dev-design.md](sm-dev-design.md#how-the-extension-honours-a-claim)).
- No new message transport into the extension: Playwright's worker
  handle serves both a launched and a CDP-connected browser.

## Tests

- The `sm-dev` project in `playwright.config.ts` runs `tests/harness/`,
  sm-dev's and the fixture's own specs (`pnpm run test:sm-dev`).
- The examples suite (`tests/examples/`) runs under the real managers
  only; the fixture runs scripts in the real extension, which the
  `sourcemonkey` project already covers.

## Platform behavior the design relies on

- **pnpm builds a git dependency's `prepare` script**, but only when
  the consumer allowlists it under `allowBuilds` in
  `pnpm-workspace.yaml`.
  - The key is matched against `<name>@git+https://…#<sha>`, so a bare
    name does not match. The full key does, and so does the glob
    `sourcemonkey@git+https*`.
  - The build runs in pnpm's clone, with the package's dev dependencies
    installed there.
- **Playwright lists an extension's service worker on a
  `connectOverCDP` connection** (`context.serviceWorkers()`), so the
  same `worker.evaluate` works for a launched and a connected browser.
- **Google Chrome (137+) ignores `--load-extension`**, so a launched
  browser with SourceMonkey is Playwright's Chromium, and a Chrome the
  person uses needs the unpacked extension loaded by hand once.

## Open questions

- Whether the package should be published to npm, which would remove
  the consumer's `injected` workaround and the build allowlist.
