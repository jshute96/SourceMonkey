# Cross-manager testing

The examples Playwright suite (`tests/examples/`) can run against either
SourceMonkey or Tampermonkey. This lets us treat the example pages as a
compliance reference and surface divergences between managers.

- **`sourcemonkey` project** (default) — runs the e2e suite and the
  examples suite against an unpacked-extension build of SourceMonkey.
- **`tampermonkey` project** — runs only the examples suite against the
  user's interactive Chromium with Tampermonkey installed.

## Running the suite

- `pnpm run test:e2e` — SM project only (default for `pnpm test` too).
- `pnpm run test:e2e:tm` — TM project, **headless**.
  - Launches its own Chromium against the persistent TM profile.
  - The headed browser (`open-test-browser-with-Tampermonkey.sh`) must
    **not** be open at the same time — Chromium can't share a profile
    between two processes.
  - Preflight (`test:e2e:tm` runs `scripts/e2e-tm-preflight.mjs
    --need-closed`): if a CDP-attached browser is already up, calls
    `page.bringToFront()` to surface the offending tab (best-effort —
    on Linux/X11 this activates the tab but may not raise the window
    above other apps), prints a "close it" message, and exits 1
    before Playwright runs.
- `pnpm run test:e2e:tm:headed` — TM project, **headed**.
  - Sets `TM_HEADED=1` and connects via CDP to the browser opened by
    `scripts/open-test-browser-with-Tampermonkey.sh`.
  - Use this when you want to watch the run or debug interactively.
  - Preflight (`test:e2e:tm:headed` runs `scripts/e2e-tm-preflight.mjs
    --need-open`): if CDP 9223 isn't answering, spawns the opener
    script (detached) and waits up to 15s for the port to come up, so
    the command "just works" from a cold start.
- `pnpm exec playwright test --project=<name>` works directly too, but
  skips the preflight — make sure the browser state is right yourself.
  - It also skips the `--workers=1` the package scripts pass. The
    tampermonkey project drives one real browser with no per-test
    reset, so it refuses to start with more than one worker
    (`tests/fixtures/manager.ts`) rather than corrupt that session.

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
  `pnpm exec playwright test path/to/spec.ts` runs that bypass `--project`.
  If `SM_MANAGER` and project metadata are set and disagree, the
  fixture throws.

## One-time Tampermonkey profile setup

The TM project connects via CDP (port 9223) to a persistent Chromium
profile that already has Tampermonkey installed. The profile lives at
`.chrome-tampermonkey-profile/` (gitignored).

Steps:

1. `scripts/open-test-browser-with-Tampermonkey.sh` — opens Playwright's
   bundled Chromium with the persistent profile and CDP enabled.
2. In that browser, install Tampermonkey from the Chrome Web Store:
   <https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo>
3. Open `chrome://extensions` and flip "Developer mode" on.
4. On the Tampermonkey card, click "Details" and enable
   "Allow access to file URLs". A handful of specs load example pages
   over `file://` (see gm-info), and TM blocks file URLs by default.
5. Leave the browser running — the suite will connect to it via CDP.

The profile persists across runs, so steps 2–4 only happen once.

**Per checkout, not per machine.** The profile lives inside the
working tree, so a second clone starts with no Tampermonkey and every
TM spec fails against a browser that has no manager in it. Either
redo the steps above there, or, with every test browser closed, copy
the directory over from the checkout that has it:

```sh
cp -a ../other-checkout/.chrome-tampermonkey-profile .
```

Nothing else is manual. What TM would otherwise ask a human for is
handled by the harness:

- **Chrome's `downloads` permission** (optional in TM's manifest, and
  required by `GM_download`) is written into the profile's
  `Preferences` by `scripts/e2e-tm-preflight.mjs`, which runs before
  the browser starts.
- **TM's own permission prompts** (`ask.html`) are auto-OK'd by the
  driver.

Both are explained in
[cross-manager-test-results.md](cross-manager-test-results.md).

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
  - Both pages ship an empty `<body>` and build their DOM from script,
    so the driver **waits** for each element rather than probing once
    after `domcontentloaded` — a one-shot check finds nothing on a
    perfectly healthy page.

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

## Network dependency

Most of the suite is self-contained (the fixture server serves every
example page and asset locally). One exception:

- **`require-scope/`** — its two portable scripts `@require` `lib.js`
  by absolute `https://raw.githubusercontent.com/...` URL, because
  that's the only `@require` form TM/VM/GM accept. Both managers fetch
  it at install time.
- Consequences: the spec **fails offline**, and it **fails while the
  repo is private** (raw.githubusercontent.com 404s without a token).
- Managers fetch from `main`, so an unmerged edit to `lib.js` is not
  what TM runs. Keep behavioral changes out of `lib.js` — put them in
  `relative-lib.js`, which only SourceMonkey fetches.

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
