# Cross-manager test results

What happens when the examples suite runs against Tampermonkey (TM) and
Violentmonkey (VM) — the two third-party userscript managers the suite
can drive. The framework itself is documented in
[`cross-manager-testing.md`](cross-manager-testing.md); this doc is
a snapshot of which specs pass, which are intentionally skipped,
and which surface real divergences from SourceMonkey.

Re-run the suites with:

```sh
pnpm run test:e2e:tm
pnpm run test:e2e:vm
# or directly:
pnpm exec playwright test --project=tampermonkey
pnpm exec playwright test --project=violentmonkey
```

Update this doc when a result changes.

## Status

- **TM**: 33 passed, 0 failed, 7 skipped (TM 5.5.0).
- **VM**: 32 passed, 0 failed, 8 skipped (VM 2.49.0).

## Awaiting a TM / VM run

- **`xmlhttp-same-origin/`** — added with the `@connect` default-policy
  change and written to run under every manager: a
  `GM_xmlhttpRequest` back to the page's own origin must load, with no
  `@connect` header and with an unrelated one. TM is expected to agree
  (`self` became implicit in TM 4.0,
  [Tampermonkey/tampermonkey#283](https://github.com/Tampermonkey/tampermonkey/issues/283))
  — a TM consent prompt would surface as a timeout. Not yet exercised
  against a real TM browser; record the outcome here when it is.

## Intentional skips

Specs that opt out of a manager via
`test.skip(setup.manager === '<name>', '<reason>')`:

- **`xmlhttp-denied/`** — skipped under **both** TM and VM. It asserts
  SM's exact denial messages (`"blocked by this script's @connect
  rules"`, and `"blocked because this script declares no @connect"`
  for a script that declared none). Each
  of TM and VM has its own `@connect` UX (potentially prompting the
  user) and its own denial message. Out of scope for cross-manager
  comparison.
- **`gm-menu/`** (by-name test only) — skipped under **VM**. VM keys
  menu commands by `opts.id || caption`
  (`GM_registerMenuCommand` in its `src/injected/web/gm-api.js`), so
  registering the same caption three times replaces one entry rather
  than stacking three. The test is entirely about that stacking, so
  nothing survives loosening. The by-id test still runs under VM. SM
  coverage: `tests/examples/gm-menu/gm-menu.spec.ts`.
- **`window-onurlchange/`** — skipped under **VM**. VM doesn't
  implement `window.onurlchange` at all (no mention in its source),
  and the example page duly reports the feature as unavailable. Every
  assertion in that spec is about events only it can produce.
- **`gm-resource/`** — skipped under **TM only**. The example uses
  relative `@resource` refs (`./resource.css`, etc.). SM resolves those
  against the host script's URL; VM resolves them against the URL the
  script was installed from, which the harness makes a real fixture
  server URL, so VM installs and fetches them for real. TM accepts
  absolute URLs only, so it can't install the example cleanly. SM
  coverage: `tests/examples/gm-resource/gm-resource.spec.ts`.
- **`require-scope/`** — skipped under **TM only**, same shape, for
  `@require ./lib.js`. TM installs these examples from a local file, so
  it has no base URL to resolve a relative ref against even in
  principle, and the fixture server's port is assigned per run so an
  absolute URL can't be baked into the file. SM coverage:
  `tests/examples/require-scope/require-scope.spec.ts`.
  - Consequence worth stating plainly: **no example exercises
    `@require` under TM at all**, so the TM-compatibility claim for
    the concatenated injection arrangement rests on unit and SM-only
    e2e coverage, plus the VM run — VM installs from the fixture
    server's URL and resolves the relative ref against it. See the
    "Cross-manager coverage" entry in [TODO.md](../TODO.md).
  - `test:e2e:tm` is unaffected — the skip fires before the install
    step, and that package script never invokes
    `scripts/sync-manager-scripts.mjs`. A manual sync run *will* try to
    install both variants; TM prefetches `@require` URLs at the install
    prompt, so expect that install to error or stall rather than
    complete.
- **`gm-download/`** (the two tests that let a download complete) —
  skipped under **VM**. Not a VM bug: a Chromium one.
  - VM saves a download by clicking an anchor on a
    `blob:chrome-extension://` URL from its own extension page.
  - In headless Chromium 153 (Playwright's bundled build and system
    Chrome alike), the browser process segfaults about half the time
    right as such a download completes, and every open page goes with
    it (`Protocol error … session closed`, or `browser has been closed`
    on the next test).
  - Nothing on our side avoids it: `Browser.setDownloadBehavior`
    (`allow`, `default`, `deny`), download-UI feature flags, and
    pre-granting VM the `downloads` permission were all tried. TM,
    which downloads through `chrome.downloads`, is unaffected.
  - The `file://` refusal test still runs under VM — no download
    starts, so nothing crashes.
  - Re-check when the bundled Chromium moves past 153.

## Failing specs (untriaged divergences)

None outstanding under either manager.

### Duplicate installs in the profile — check this first

The `gm-dom` and `headers-run-at` failures seen after the install path
was repaired were **not** a manager divergence: the TM profile held two
copies of fourteen example scripts, so each one ran twice on every
matching page and every `toHaveCount(1)` saw 2.

- The copies pre-dated the repair. Nothing in the suite creates them
  now — sync matches on `@name` and updates in place — but the profile
  is persistent, so old damage survives indefinitely.
- `getInstalledMap` now prints a warning naming any duplicated script,
  because from the spec end this looks like an injection bug and
  nothing points at the profile.
- To clear them: TM dashboard → tick the extra rows → *Apply this to
  all selected scripts* → **Delete** → Start, and accept the confirm.
  Keep one copy of each `@name`.

## Behavior diffs (SM vs TM/VM)

Cases where the managers genuinely behave differently on the same
input — none of them is buggy, the API spec just doesn't pin the
behavior down and each picked its own rule. The cross-manager
assertion has been loosened to accept all of them; SM's specific rule
stays enforced in an SM-only spec.

- **`headers-inject-into/`** (content-world isolation) — TM doesn't
  implement `@inject-into` at all. It's a Violentmonkey /
  SourceMonkey header; TM's nearest equivalent is `@sandbox`. VM does
  implement it, so it is held to the same assertions SM is.
  - TM therefore ignores `@inject-into content` and honours the
    variant's `@grant none`, which by TM's own rules means "run in
    page context". The script then legitimately sees the page's
    globals — a difference in what the header *means*, not a
    world-isolation bug.
  - The isolation assertions are skipped under TM only (guarded in
    `tests/examples/headers-inject-into/headers-inject-into.spec.ts`);
    everything else in that spec, including the page-world half, still
    runs under both. SM's rule stays enforced by the same spec on the
    `sourcemonkey` project.
- **`unsafe-window/`** (`unsafeWindow === window`, and the
  `@inject-into content` variant) — measured under TM 5.5.0 and VM
  2.48.0.
  - **Identity is SM-only.** SM answers `true`: it satisfies the grant
    by running the script in MAIN world and binding
    `unsafeWindow = window`, with nothing in between. TM and VM both
    answer `false` on Chrome — each hands out its sandbox's wrapper
    rather than the raw window. VM answers `false` in its isolated mode
    too: `unsafeWindow` there is neither this script's own `window` nor a
    way into the page, since its `isolated-read` still came back
    `undefined`.
    - This corrects an earlier assumption in our docs that only Firefox
      managers wrap. Both Chrome managers wrap; SM is the one that
      doesn't.
    - All three reach the page's own variables under the plain grant,
      which is the contract, so the read / call / write assertions are
      unconditional. The identity row is only required to *exist* under
      TM and VM — what it says there is a report.
  - **The isolated variant under TM.** Same cause as
    `headers-inject-into/` below: TM has no `@inject-into`, so it
    honours the `@grant unsafeWindow` and runs `isolated.user.js` in the
    page, where the page's globals are visible. VM implements the header
    and is held to the assertion. The example script derives its
    explanation from what it observed, so its log stays true under all
    three.
  - **Stored values persist across TM runs.** The SM fixture wipes
    storage per test; TM keeps the installed script's values, so the
    visit counter is asserted as counting up rather than starting at 0.
  - **`ungranted.user.js`** uses `unsafeWindow` with no grant line for
    it, and its assertions are unconditional: every manager here is
    expected to define the name and reach the page through it. This is
    the premise SourceMonkey's own implicit handling rests on (see
    [injection.md](injection.md#unsafewindow-forces-main-world)), so it
    is measured rather than assumed.
    - **Both confirm it** (TM 5.5.0, VM 2.49.0): `typeof unsafeWindow` is
      `object` with no `@grant` line for it, and the read reaches the
      page's own object. Nothing in this variant is manager-conditional —
      it sets no `@inject-into`, so TM's lack of that header doesn't
      change what it measures.
- **`gm-dom/`** (default parent, no-parent form) — all three managers
  disagree, and the TM docs don't pin the default parent down, so none
  is wrong.
  - `<p>`: TM appends to `<head>` regardless of tag; SM and VM route
    by tag instead. Cross-manager assertion: element was inserted and
    the count of matching `<p>`s went up by one.
  - `<title>`: SM sends it to `<head>` (its head list is
    `script`/`style`/`link`/`meta`/`title`/`base`); VM's head list
    stops at `meta`, so VM appends it to `<body>` — observed, not just
    read off VM's source. Cross-manager assertion: the log names
    either parent, and the document-wide `<title>` count went up by
    one (`document.title` is unaffected either way, since it reads the
    first `<title>` in tree order).
  - SM's rule is enforced strictly in `tests/e2e/gm-dom.spec.ts`.
- **`gm-notification/`** (empty-text) — TM accepts an empty `text`
  field and resolves with a notification id (or surfaces it some
  other way); SM rejects strictly. Cross-manager assertion: accepts
  resolved, rejected, or synchronously thrown — just verifies an
  observable outcome. SM strict-rejection invariant:
  `tests/e2e/gm-notification.spec.ts`.
- **`headers-run-at/`** (lifecycle ordering) — TM doesn't guarantee
  the `start → end → idle` injection order under every page-load
  shape (cross-manager test results varied). SM does guarantee it
  (the wrapper gates on the right lifecycle event; see
  `docs/injection.md`). Cross-manager assertion: all three scripts
  ran and document-idle observes `readyState=complete`. SM strict
  ordering: `tests/e2e/injection.spec.ts` ("document-start,
  document-end, document-idle inject in @run-at order").

## Harness details worth knowing

Cases where a manager needs something arranged for it before a spec
can even reach its assertions, or where the spec had to accommodate
one.

- **`window-close-focus/` "close closes this tab"** — under VM the tab
  is gone before Playwright's `click()` returns, which it reports as
  "Target page, context or browser has been closed". That is the
  outcome the test wants, so the click swallows exactly that error and
  lets the `isClosed()` poll decide. Not a divergence — a race the SM
  and TM timings happened to hide.
- **`gm-info/` file:// case** — skipped under VM, and the reason is
  *not* the file-access toggle.
  - Checked with the grant live
    (`chrome.extension.isAllowedFileSchemeAccess()` returns true), the
    script installed and enabled with its `file:///*/…` `@match`
    intact, and VM reloaded: a `file://` load of the example page
    still reports no userscript.
  - VM registers one `chrome.userScripts` entry matching `<all_urls>`
    and does its own matching inside it, so whether the cause is VM,
    Chrome's MV3 `userScripts` API, or the persistence of that
    registration is unresolved.
  - Nothing the harness can arrange — recorded as a divergence, not a
    setup gap.
  - TM still does need the toggle, and it's step 4 of the one-time
    profile setup either way.

- **`GM_download` needs Chrome's `downloads` permission granted to
  TM.**
  - `downloads` is an *optional* permission in TM's manifest, so the
    first `GM_download` call opens TM's "Browser API Downloads — click
    OK" page, whose OK button calls `chrome.permissions.request`.
  - That needs Chrome's native grant bubble, which a headless run
    can't show: the click does nothing, the GM call never settles, and
    the spec times out on an empty log.
  - VM needs no equivalent: it uses `chrome.downloads` only when the
    permission is already granted and falls back to an anchor download
    otherwise, so nothing blocks.
  - `scripts/e2e-manager-preflight.mjs` writes the grant into the test
    profile's `Preferences` before the browser starts (browser must be
    closed — Chrome rewrites that file from memory on exit). Same
    shortcut `tests/fixtures/extension.ts` uses for
    `user_scripts_enabled` on the SM profile.
  - A one-time pre-edit backup is left at
    `Preferences.pre-sm-downloads-grant`.
- **TM's permission prompts are auto-answered.** The driver clicks OK
  on any `ask.html` permission page — see
  `autoApprovePermissionPrompts` in
  `tests/fixtures/tampermonkey-driver.mjs`. A prompt we haven't
  pre-granted then stalls the run for seconds rather than forever.

## Loose-by-design assertions

- **`gm-download/`** — passes under TM (as of TM 5.5.0); under VM only
  the `file://` refusal runs (see "Intentional skips"). The assertions
  stay at "some callback fired" rather than a specific value, because
  TM applies its own file-extension allowlist and can answer
  `not_whitelisted` where SM answers `onload`.
  - The `file://` case asserts only that `onload` did **not** fire —
    neither manager should quietly pull a local file onto disk on a
    userscript's say-so; the refusal shape differs.
  - Both managers save real files into your downloads folder when you
    run this. SM's exact contract lives in
    `tests/e2e/gm-download.spec.ts`.

## SM-only invariants (loosened for cross-manager)

Cases where the cross-manager assertion was loosened not because of
a manager behavior diff, but because the original assertion encoded
an SM-specific extension or environmental requirement that TM was
never expected to share.

- **`gm-log/`** — assertion no longer requires the SM-specific
  `[SourceMonkey:` prefix on `console.log` lines; just checks the
  message text reached the console. SM prefix coverage:
  `tests/e2e/gm-log.spec.ts`.
- **`headers-run-at/`** (slow-script setup) — the example page
  pulls in a slow sync `<script src="/__slow/blocker.js?ms=400">`
  so document-start gets an actual loading-phase injection window.
  See `tests/examples/README.md` for the serve-script setup that
  provides the `/__slow/` route. Not a manager diff — both managers
  need the slow route to exhibit a clean three-state split, the
  setup is just specific to our examples server.

When triaging a new TM or VM divergence, the options are:
1. Loosen the assertion so both managers pass (and move any
   SM-specific invariant into a `tests/e2e/` spec).
2. Decide it's an SM-only invariant and `test.skip` under that manager
   with a pointer to here.
3. File the divergence upstream (the manager's tracker) if we think the
   manager is wrong.

## Inspecting failures

Failing traces land in `test-results/` after each run. The
`--project=tampermonkey` / `--project=violentmonkey` invocation prints
the failure list at the end; open the trace zip via
`pnpm exec playwright show-trace test-results/<dir>/trace.zip` to step
through what the page actually saw.
