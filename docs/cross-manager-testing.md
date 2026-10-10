# Cross-manager testing

The examples Playwright suite (`tests/examples/`) can run against
SourceMonkey, Tampermonkey, or Violentmonkey. This lets us treat the
example pages as a compliance reference and surface divergences between
managers.

- **`sourcemonkey` project** (default) — runs the e2e suite and the
  examples suite against an unpacked-extension build of SourceMonkey.
- **`tampermonkey` project** — runs only the examples suite against a
  persistent Chromium profile with Tampermonkey (TM) installed.
- **`violentmonkey` project** — the same, for Violentmonkey (VM).

"TM" and "VM" below are those two extensions; both are third-party
userscript managers installed from the Chrome Web Store rather than
built from this repo.

## Running the suite

- `pnpm run test:e2e` — SM project only (`pnpm test` runs it, then
  the `sm-dev` project).
- `pnpm run test:e2e:tm` / `pnpm run test:e2e:vm` — TM / VM project,
  **headless**.
  - Launches its own Chromium against that manager's persistent profile.
  - The headed browser for the same manager must **not** be open at the
    same time — Chromium can't share a profile between two processes.
  - Preflight (`scripts/e2e-manager-preflight.mjs <manager>
    --need-closed`): if a CDP-attached browser is already up, calls
    `page.bringToFront()` to surface the offending tab (best-effort —
    on Linux/X11 this activates the tab but may not raise the window
    above other apps), prints a "close it" message, and exits 1
    before Playwright runs.
- `pnpm run test:e2e:tm:headed` / `pnpm run test:e2e:vm:headed` — the
  same projects, **headed**.
  - Sets `TM_HEADED=1` / `VM_HEADED=1` and connects via CDP to the
    browser opened by `scripts/open-test-browser.sh <manager>`.
  - Use this when you want to watch the run or debug interactively.
  - Preflight (`--need-open`): if the CDP port isn't answering, spawns
    the opener script (detached) and waits up to 15s for the port to
    come up, so the command "just works" from a cold start.
- `pnpm exec playwright test --project=<name>` works directly too, but
  skips the preflight — make sure the browser state is right yourself.
  - It also skips the `--workers=1` the package scripts pass. The
    external-manager projects each drive one real browser with no
    per-test reset, so they refuse to start with more than one worker
    (`tests/fixtures/manager.ts`) rather than corrupt that session.

Each Playwright project carries `metadata.manager` and the manager
fixture (`tests/fixtures/manager.ts`) reads it. No env var needed for
manager selection — `--project=<name>` picks the backend on its own.

Env vars used by the TM / VM paths:

- `TM_HEADED=1` / `VM_HEADED=1` — connect to a CDP-attached browser
  instead of launching headless. Set automatically by the `:headed`
  package scripts.
- `TM_CDP_PORT` / `VM_CDP_PORT` — override the default CDP port (9223
  for TM, 9224 for VM).
- `TM_EXTENSION_ID` / `VM_EXTENSION_ID` — override the extension ID
  (e.g. to test a beta channel).
- `SM_MANAGER` — fallback for direct
  `pnpm exec playwright test path/to/spec.ts` runs that bypass
  `--project`. If `SM_MANAGER` and project metadata are set and
  disagree, the fixture throws.

Every one of those defaults — port, profile path, Web Store ID — is a
row in `tests/fixtures/managers.mjs`, which the fixture, the preflight,
the sync CLI, and the opener shell script all read.

## One-time profile setup

Each external manager gets its own persistent Chromium profile with the
extension already installed:

| Manager | Profile (gitignored) | CDP port |
| --- | --- | --- |
| Tampermonkey | `.chrome-tampermonkey-profile/` | 9223 |
| Violentmonkey | `.chrome-violentmonkey-profile/` | 9224 |

Steps, per manager:

1. `scripts/open-test-browser.sh <tampermonkey|violentmonkey>` — opens
   Playwright's bundled Chromium with that profile and CDP enabled. It
   prints the Web Store URL to install from.
2. In that browser, install the manager from the Chrome Web Store.
3. Open `chrome://extensions` and flip "Developer mode" on.
4. On the manager's card, click "Details" and enable "Allow access to
   file URLs". A couple of specs load example pages over `file://`
   (see gm-info), and both managers block file URLs by default.
   - VM still won't inject into `file://` pages even with the grant;
     that case is skipped under VM. See
     [cross-manager-test-results.md](cross-manager-test-results.md).
5. Close the browser (headless runs need the profile free), or leave it
   running and use the `:headed` scripts.

The profile persists across runs, so steps 2–4 only happen once.

**Per checkout, not per machine.** The profiles live inside the working
tree, so a second clone starts with no manager installed and every spec
fails against a browser that has none in it. Either redo the steps
above there, or, with every test browser closed, copy the directory
over from the checkout that has it:

```sh
cp -a ../other-checkout/.chrome-tampermonkey-profile .
```

Nothing else is manual. What a manager would otherwise ask a human for
is handled by the harness:

- **Chrome's `downloads` permission** (optional in TM's manifest, and
  required by `GM_download`) is written into the profile's
  `Preferences` by `scripts/e2e-manager-preflight.mjs`, which runs
  before the browser starts. VM needs no equivalent — it only reaches
  for `chrome.downloads` when the permission is already granted, and
  falls back to an anchor download otherwise. (That fallback is what
  crashes headless Chromium 153, so the download-completing
  `gm-download` tests are skipped under VM; granting the permission
  doesn't help. See
  [cross-manager-test-results.md](cross-manager-test-results.md).)
- **TM's own permission prompts** (`ask.html`) are auto-OK'd by the
  driver.

Both are explained in
[cross-manager-test-results.md](cross-manager-test-results.md).

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
- That is what lets the `require-scope` and `gm-resource` examples —
  both of which use relative refs — run under VM at all.
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

Idempotent across runs: a no-op run is one script-list read with no
install churn.

## Standalone sync CLI

`scripts/sync-manager-scripts.mjs` runs the same sync logic outside the
Playwright harness, against the same running browser:

```sh
node scripts/sync-manager-scripts.mjs                       # TM, install/update everything
node scripts/sync-manager-scripts.mjs --manager violentmonkey
node scripts/sync-manager-scripts.mjs --dry-run             # report plan only
node scripts/sync-manager-scripts.mjs --dir <path>          # alternate root
node scripts/sync-manager-scripts.mjs --allow-downgrade     # also install older-than-installed
```

It prints a clear plan per script (`INSTALL` / `UPDATE` / `SKIP`)
before doing any work, and a final re-read for confirmation.

- It also lists installed examples that no local file is named for any
  more (`[STALE]`): ones renamed or deleted.
  - Matching is by `@name`, so a renamed example installs as a new
    script beside the old copy, and both run on the example pages.
  - Remove the stale ones from the manager's dashboard. The CLI doesn't,
    as removing goes through each manager's own UI. This is
the easiest way to (a) prime a fresh profile with every example script
and (b) debug install issues when a manager's UI changes.

Under VM the CLI also starts a throwaway static server over the scripts
directory, for the same install-URL reason described above.

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

Under TM and VM, the installed scripts persist *across* tests AND
across runs. The sync helpers are idempotent, so the per-test
`setup.installScriptsFrom(__dirname)` call is cheap after the first
install (one list read, no install churn).

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
- **CDP attachment**: `connectOverCDP` against a running Chromium
  doesn't trigger automation-detection (e.g. for Google login) in the same way as
  `launchPersistentContext` would. Worth keeping in mind if we ever extend
  the cross-manager suite to manager dashboards that re-check automation.
