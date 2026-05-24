# Cross-manager testing

The examples Playwright suite (`tests/examples/`) can run against either
SourceMonkey or Tampermonkey. This lets us treat the example pages as a
compliance reference and surface divergences between managers.

- **`sourcemonkey` project** (default) — runs the e2e suite and the
  examples suite against an unpacked-extension build of SourceMonkey.
- **`tampermonkey` project** — runs only the examples suite against the
  user's interactive Chromium with Tampermonkey installed.

## Running the suite

- `npm run test:e2e` — SM project only (default for `npm test` too).
- `npm run test:e2e:tm` — TM project, **headless**. Launches its own
  Chromium against the persistent TM profile. The headed browser
  (`open-test-browser-with-TamperMonkey.sh`) must **not** be open at
  the same time — Chromium can't share a profile between two
  processes.
- `npm run test:e2e:tm:headed` — TM project, **headed**. Sets
  `TM_HEADED=1` and connects via CDP to the browser opened by
  `scripts/open-test-browser-with-TamperMonkey.sh`. Use this when you
  want to watch the run or debug interactively.
- `npx playwright test --project=<name>` works directly too.

Each Playwright project carries `metadata.manager` and the manager
fixture (`tests/fixtures/manager.ts`) reads it. No env var needed for
manager selection — `--project=tampermonkey` picks the TM backend on
its own.

Env vars used by the TM path:

- `TM_HEADED=1` — connect to a CDP-attached browser instead of
  launching headless. Set automatically by `test:e2e:tm:headed`.
- `TM_CDP_PORT` — override the default CDP port (9223) for headed
  mode.
- `SM_MANAGER` — fallback for direct
  `npx playwright test path/to/spec.ts` runs that bypass `--project`.
  If `SM_MANAGER` and project metadata are set and disagree, the
  fixture throws.

## One-time Tampermonkey profile setup

The TM project connects via CDP (port 9223) to a persistent Chromium
profile that already has Tampermonkey installed. The profile lives at
`.chrome-tampermonkey-profile/` (gitignored).

Steps:

1. `scripts/open-test-browser-with-TamperMonkey.sh` — opens Playwright's
   bundled Chromium with the persistent profile and CDP enabled.
2. In that browser, install Tampermonkey from the Chrome Web Store:
   <https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo>
3. Open `chrome://extensions` and flip "Developer mode" on.
4. On the Tampermonkey card, click "Details" and enable
   "Allow access to file URLs". A handful of specs load example pages
   over `file://` (see gm-info), and TM blocks file URLs by default.
5. Leave the browser running — the suite will connect to it via CDP.

The profile persists across runs, so steps 2–4 only happen once.

## How TM script-install works

`tests/fixtures/tampermonkey-driver.mjs` drives the TM dashboard:

- **Listing**: opens the dashboard
  (`chrome-extension://<id>/options.html#nav=dashboard`) and reads
  every visible `tr.scripttr`, pulling `td.script_name` and
  `td.script_version` per row.
- **Installing**: opens the "Import from file" page
  (`#nav=utils`), `setInputFiles` on the file input, then clicks the
  Install / Reinstall / Update button on TM's confirmation page
  (`<input type="button" class="button install" value="…">`). TM
  auto-detects existing scripts by `@namespace`+`@name`.

`syncTampermonkeyScripts(driver, dir)` walks every `*.user.js` in the
example directory, parses the local `@name`/`@version`, and (using
dotted-numeric version comparison):

- **INSTALL** if no entry with that `@name` is in the dashboard.
- **UPDATE** if local `@version` > installed.
- **SKIP** if local == installed.
- **SKIP** if local < installed (annotated "would downgrade").
- The standalone CLI also supports `--allow-downgrade`, which
  reclassifies older-than-installed as **DOWNGRADE** and installs
  anyway. The Playwright fixture has no downgrade path — tests
  shouldn't roll a script back.

Idempotent across runs: a no-op run is one dashboard read with no UI
churn.

## Standalone sync CLI

`scripts/sync-tm-scripts.mjs` runs the same sync logic outside the
Playwright harness, against the same running TM browser:

```sh
node scripts/sync-tm-scripts.mjs                     # install/update everything
node scripts/sync-tm-scripts.mjs --dry-run           # report plan only
node scripts/sync-tm-scripts.mjs --dir <path>        # alternate root
node scripts/sync-tm-scripts.mjs --allow-downgrade   # also install older-than-installed
```

It prints a clear plan per script (`INSTALL` / `UPDATE` / `SKIP`)
before doing any work, and a final dashboard re-read for
confirmation. This is the easiest way to (a) prime a fresh TM profile
with every example script and (b) debug install issues when TM's UI
changes.

## Diagnostic scripts

When TM updates change the DOM and `listInstalled` or the install
button click stops working:

- `scripts/inspect-tm-dashboard.mjs` — dumps every visible row on the
  dashboard with cell classes, so you can pick the right selector.
- `scripts/inspect-tm-install.mjs` — drives one install (defaults to
  `gm-info`), opens the confirmation page, and dumps every visible
  button-like element. Set `SCRIPT=<path>` to inspect with a
  different file.

## Script-list state across tests

Under TM, the installed scripts persist *across* tests AND across runs.
`syncTampermonkeyScripts` is idempotent, so the per-test
`setup.installScriptsFrom(__dirname)` call is cheap after the first
install (one dashboard read, no UI churn).

There is intentionally no per-test reset on the TM side — that would
push UI churn into every test, and the example userscripts don't
collide with each other (they all `@match` distinct paths under
`/<dir>/<dir>.html`).

## Tampermonkey extension ID

`tests/fixtures/tampermonkey-driver.mjs` defaults to TM Stable's CWS ID
(`dhdgffkkebhmkfjojejmpbldmpobfkfo`). Override via `TM_EXTENSION_ID`
if you're testing against TM Beta. The CDP port defaults to 9223;
override via `TM_CDP_PORT`.

## Results and divergences

What's passing, what's skipped, and what fails under TM is captured
in [`cross-manager-test-results.md`](cross-manager-test-results.md).
Update that doc when you (a) add a new TM-skip, (b) triage a
previously-failing spec, or (c) discover a new divergence.

## Fragile bits

- **TM dashboard selectors**: the row table and Install button live
  inside TM's options page DOM, which shifts between minor versions.
  If `listInstalled` returns an empty array or `installFromFile`
  throws "Could not find an Install button", the selectors need an
  update in `tests/fixtures/tampermonkey-driver.mjs`.
- **CDP attachment**: `connectOverCDP` against a running Chromium
  doesn't trigger automation-detection (e.g. for Google login) in the same way as
  `launchPersistentContext` would. Worth keeping in mind if we ever extend
  the cross-manager suite to manager dashboards that re-check automation.
