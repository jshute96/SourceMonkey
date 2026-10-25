# Cross-manager testing

The examples Playwright suite (`tests/examples/`) can run against
SourceMonkey, Tampermonkey, or Violentmonkey. This lets us treat the
example pages as a compliance reference and surface divergences between
managers.

- **`sourcemonkey` project** (default) — runs the e2e suite and the
  examples suite against an unpacked-extension build of SourceMonkey.
- **`tampermonkey` project** — runs only the examples suite, in a new
  browser with Tampermonkey (TM) loaded.
- **`violentmonkey` project** — the same, for Violentmonkey (VM).

"TM" and "VM" below are those two extensions; both are third-party
userscript managers from the Chrome Web Store rather than built from
this repo.

## Running the suite

- `pnpm run test:e2e` — SM project only (`pnpm test` runs it, then
  the `sm-dev` project).
- `pnpm run test:e2e:tm` / `pnpm run test:e2e:vm` — TM / VM project,
  headless, with Playwright's worker count from `playwright.config.ts`
  (half the cores), as for the SM project.
- `pnpm run test:e2e:tm:headed` / `pnpm run test:e2e:vm:headed` — the
  same, with the browser windows shown and one worker, to watch a run
  or debug it.
- `pnpm exec playwright test --project=<name>` works directly too.

Each Playwright project carries `metadata.manager` and the manager
fixture (`tests/fixtures/manager.ts`) reads it. No env var needed for
manager selection — `--project=<name>` picks the backend on its own.

Env vars used by the TM / VM paths:

- `TM_HEADED=1` / `VM_HEADED=1` — show the browser windows. Set by the
  `:headed` package scripts.
- `TM_EXTENSION_ID` / `VM_EXTENSION_ID` — for the sync CLI, override
  the extension ID it looks the manager up by (e.g. a beta channel
  installed in the opener's profile). The tests use the ID of the copy
  they load.
- `SM_MANAGER` — fallback for direct
  `pnpm exec playwright test path/to/spec.ts` runs that bypass
  `--project`. If `SM_MANAGER` and project metadata are set and
  disagree, the fixture throws.

Those defaults are rows in `tests/fixtures/managers.mjs`, which the
fixture, the sync CLI and the browser-opener script all read.

## The test browser

`tests/fixtures/manager-launch.ts` gives each worker a new browser
with the manager loaded, in a new temporary profile. Nothing needs
setting up by hand.

- It launches through `sm-dev`'s own launcher (`launchExtensionBrowser`
  in `src/harness/extension-launch.ts`), as the SM project does, so
  the browser is set up the way an `sm-dev --manager tm|vm` run's is.
  That includes turning off TM's "installed" tab, which TM otherwise
  opens a moment after each start.

- **The manager** is the unpacked copy `sm-dev` keeps in its cache
  (`~/.cache/sm-dev/managers/<name>`), the same one
  `sm-dev --manager tm|vm` loads.
  - The fixture fetches it from the Chrome Web Store when the cache
    has none, with one worker downloading while the others wait. After
    that, runs keep using that copy, so results only change when you
    update it:
    `scripts/sm-dev --manager tm manager fetch` (or `vm`).
  - The fetched manifest keeps the store's `key`, so the manager has
    its Web Store extension ID.
- **Nothing carries over between runs.** Each worker starts with an
  empty manager, so stale or renamed copies of the examples can't
  build up and run twice.
- **What a person would click is written into the profile's
  `Preferences`** before the browser starts, using the keys Chrome
  writes for those clicks:
  - "Allow User Scripts", which Chrome requires before
    `chrome.userScripts` works.
  - "Allow access to file URLs", for the specs that load example pages
    over `file://` (see gm-info). VM still won't inject into `file://`
    pages; that case is skipped under VM (see
    [cross-manager-test-results.md](cross-manager-test-results.md)).
  - For TM only, Chrome's `downloads` permission, which `GM_download`
    needs. It's optional in TM's manifest, and TM asks for it through
    Chrome's grant bubble, which a headless browser can't show. VM
    needs no equivalent: it only uses `chrome.downloads` when the
    permission is already granted, and falls back to an anchor
    download otherwise. `preGrantDownloads` in `managers.mjs` is the
    switch.
- **TM's own permission prompts** (`ask.html`) are auto-OK'd by the
  driver.

## How script-install works

Each manager has a driver exposing the same shape — `listInstalled`,
`getInstalledMap`, `installFromFile` — over a very different mechanism.

### Tampermonkey: drive the dashboard

`tests/fixtures/tampermonkey-driver.mjs` uses TM's own UI, because TM
is closed-source and offers nothing else to talk to:

- **Listing**: opens the dashboard
  (`chrome-extension://<id>/options.html#nav=dashboard`) and reads
  every visible `tr.scripttr`, pulling `td.script_name` and
  `td.script_version` per row.
- **Installing**: opens the "Import from file" page
  (`#nav=utils`), `setInputFiles` on the file input, then clicks the
  Install / Reinstall / Update button on TM's confirmation page
  (`<input type="button" class="button install" value="…">`). TM
  auto-detects existing scripts by `@namespace`+`@name`.
  - Both pages ship an empty `<body>` and build their DOM from script,
    so the driver **waits** for each element rather than probing once
    after `domcontentloaded` — a one-shot check finds nothing on a
    perfectly healthy page.

### Violentmonkey: talk to the background

`tests/fixtures/violentmonkey-driver.mjs` skips the UI entirely. VM is
open source, so its background command API is readable and stable
enough to call directly:

- The driver opens one page on VM's own extension origin (its
  dashboard) and posts `{cmd, data}` messages from there with
  `chrome.runtime.sendMessage`. VM's background refuses commands whose
  sender origin isn't its own, so the message has to come from inside a
  VM page.
- **Listing** uses `GetData`, the same command VM's dashboard reads.
- **Installing** uses `ParseScript`, the same command VM's install
  confirmation page calls when you click Install.
- The send resolves with the command's raw return value and rejects
  with VM's own error text. (VM's source wraps responses as
  `[result, error]` for the channels its *own* pages use — they reach
  the service worker over `navigator.serviceWorker` postMessage, not
  `runtime.sendMessage` — but nothing wraps what comes back here. This
  was measured, not read off the source.)
- Commands and response shape verified against **VM 2.48.0**. A
  renamed command has nothing to answer it, so the port closes;
  `sendCommand` turns that into a message naming the command rather
  than failing downstream.

**VM installs from a URL, and that matters:**

- VM resolves a script's relative `@require` / `@resource` / `@icon`
  refs against the URL it was installed from, and records that URL as
  `lastInstallURL`.
- So the harness hands VM the fixture server's URL for the same file
  rather than its path on disk, and VM fetches the dependencies from
  there for real.
- Only `require-scope/relative/` relies on it now, since it uses
  relative paths on purpose. The other examples name their dependency
  files by GitHub Pages URL, which TM can fetch too (see
  [tests/examples/README.md](../tests/examples/README.md)).
- The server binds a fresh port per worker, so the install URL is
  computed per run.

### Sync policy (both managers)

`syncTampermonkeyScripts` / `syncViolentmonkeyScripts` walk every
`*.user.js` in the example directory, parse the local `@name`/`@version`
(`tests/fixtures/userscript-files.mjs`), and, using dotted-numeric
version comparison:

- **INSTALL** if no entry with that `@name` is installed.
- **UPDATE** if local `@version` > installed.
- **SKIP** if local == installed.
- **SKIP** if local < installed (annotated "would downgrade").
- The standalone CLI also supports `--allow-downgrade`, which
  reclassifies older-than-installed as **DOWNGRADE** and installs
  anyway. The Playwright fixture has no downgrade path — tests
  shouldn't roll a script back.

Idempotent: a sync with nothing to change is one script-list read with
no install churn.

## Standalone sync CLI

`scripts/sync-manager-scripts.mjs` runs the same sync logic outside the
Playwright harness, against a browser you opened yourself with
`scripts/open-test-browser.sh <tampermonkey|violentmonkey>`:

- That opener keeps a persistent profile per manager in the checkout
  (`.chrome-tampermonkey-profile/`, `.chrome-violentmonkey-profile/`,
  gitignored), with CDP on port 9223 for TM and 9224 for VM
  (`TM_CDP_PORT` / `VM_CDP_PORT` override them).
- The first time, install the manager in it from the Chrome Web Store
  link the opener prints. The tests don't use these profiles.

```sh
node scripts/sync-manager-scripts.mjs                       # TM, install/update everything
node scripts/sync-manager-scripts.mjs --manager violentmonkey
node scripts/sync-manager-scripts.mjs --dry-run             # report plan only
node scripts/sync-manager-scripts.mjs --dir <path>          # alternate root
node scripts/sync-manager-scripts.mjs --allow-downgrade     # also install older-than-installed
```

It prints a clear plan per script (`INSTALL` / `UPDATE` / `SKIP`)
before doing any work, and a final re-read for confirmation.

It's the easiest way to try every example by hand in a real TM or VM,
and to debug install issues when a manager's UI changes.

- It also lists installed examples that no local file is named for any
  more (`[STALE]`): ones renamed or deleted. It doesn't remove them;
  see [Removing stale copies](#removing-stale-copies).
- Under VM the CLI also starts a throwaway static server over the
  scripts directory, for the same install-URL reason described above.

## Removing stale copies

This applies to the opener's persistent profiles only; the tests start
from an empty manager each run.

Installed examples are matched by `@name`, so a renamed example
installs as a new script beside the old copy, and both run on the
example pages: everything shows twice. With the opener's browser
running, `sm-dev` can list and uninstall them:

1. List the installed scripts with their `E` IDs:
   `scripts/sm-dev --manager tm --browser 9223 script list`.
   Current examples' names start with their folder
   (`SourceMonkey example: gm-dom: ...`); a copy under any other name
   is stale.
2. Remove each stale one:
   `scripts/sm-dev --manager tm --browser 9223 script E46 uninstall --force`.
   `--force` is required, since it removes a real installed script.

For VM, use port 9224 and `--manager vm`.

## Diagnostic scripts

When TM updates change the DOM and `listInstalled` or the install
button click stops working:

- `scripts/inspect-tm-dashboard.mjs` — dumps every visible row on the
  dashboard with cell classes, so you can pick the right selector.
- `scripts/inspect-tm-install.mjs` — drives one install (defaults to
  `gm-info`), opens the confirmation page, and dumps every visible
  button-like element. Set `SCRIPT=<path>` to inspect with a
  different file.

There is no VM equivalent: the VM driver touches no selectors, so a VM
break shows up as a named command failure instead.

## Script-list state across tests

Under TM and VM, the installed scripts persist across the tests in one
worker, in that worker's browser. The sync helpers are idempotent, so
the per-test `setup.installScriptsFrom(__dirname)` call is cheap after
the first install (one list read, no install churn).

There is intentionally no per-test reset on the external-manager side —
that would push UI churn into every test, and the example userscripts
don't collide with each other (they all `@match` distinct paths under
`/<dir>/<dir>.html`).

## Results and divergences

What's passing, what's skipped, and what fails under each manager is
captured in
[`cross-manager-test-results.md`](cross-manager-test-results.md).
Update that doc when you (a) add a new skip, (b) triage a
previously-failing spec, or (c) discover a new divergence.

## Fragile bits

- **TM dashboard selectors**: the row table and Install button live
  inside TM's options page DOM, which shifts between minor versions.
  If `listInstalled` returns an empty array or `installFromFile`
  throws "Could not find an Install button", the selectors need an
  update in `tests/fixtures/tampermonkey-driver.mjs`.
- **VM background command names**: `GetData` and `ParseScript` are
  internal to VM, not a public API. A rename shows up as
  "Violentmonkey did not answer the '<cmd>' command"; the fix is to
  read the current `src/background/utils/db.js` in the VM tree and
  update `tests/fixtures/violentmonkey-driver.mjs`.
