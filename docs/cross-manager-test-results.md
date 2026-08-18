# Cross-manager test results

What happens when the examples suite runs against Tampermonkey. The
framework itself is documented in
[`cross-manager-testing.md`](cross-manager-testing.md); this doc is
a snapshot of which specs pass, which are intentionally skipped,
and which surface real SM-vs-TM divergences.

Re-run the suite with:

```sh
pnpm run test:e2e:tm
# or directly:
pnpm exec playwright test --project=tampermonkey
```

Update this doc when a result changes.

## Awaiting a TM run

- **`xmlhttp-same-origin/`** — added with the `@connect` default-policy
  change and written to run under both managers: a
  `GM_xmlhttpRequest` back to the page's own origin must load, with no
  `@connect` header and with an unrelated one. TM is expected to agree
  (`self` became implicit in TM 4.0,
  [Tampermonkey/tampermonkey#283](https://github.com/Tampermonkey/tampermonkey/issues/283))
  — a TM consent prompt would surface as a timeout. Not yet exercised
  against a real TM browser; record the outcome here when it is.

## Intentional skips

Specs that opt out under TM via
`test.skip(setup.manager === 'tampermonkey', '<reason>')`:

- **`xmlhttp-denied/`** — asserts SM's exact denial messages
  (`"blocked by this script's @connect rules"`, and
  `"blocked because this script declares no @connect"` for a script
  that declared none). TM has its own
  `@connect` UX (potentially prompting the user) and its own denial
  message. Out of scope for cross-manager comparison.
- **`gm-resource/`** — the example uses relative `@resource` refs
  (`./resource.css`, etc.) resolved against the host script's URL,
  which is a SourceMonkey extension over TM/VM. TM accepts absolute
  URLs only, so it can't install the example cleanly. Skipped under
  TM until we ship an absolute-URL variant. SM coverage:
  `tests/examples/gm-resource/gm-resource.spec.ts`.
- **`require-scope/`** — same shape, for `@require ./lib.js`. TM
  installs these examples from a local file, so it has no base URL to
  resolve a relative ref against even in principle, and the fixture
  server's port is assigned per run so an absolute URL can't be baked
  into the file. SM coverage:
  `tests/examples/require-scope/require-scope.spec.ts`.
  - Consequence worth stating plainly: **no example exercises
    `@require` under TM at all**, so the TM-compatibility claim for
    the concatenated injection arrangement rests on unit and SM-only
    e2e coverage. See the "Cross-manager coverage" entry in
    [TODO.md](../TODO.md) for the two ways to close it.
  - `test:e2e:tm` is unaffected — the skip fires before the install
    step, and that package script never invokes
    `scripts/sync-tm-scripts.mjs`. A manual `sync-tm-scripts.mjs` run
    *will* try to install both variants; TM prefetches `@require`
    URLs at the install prompt, so expect that install to error or
    stall rather than complete.

## Failing specs (untriaged divergences)

Last full TM run: 23 passed, 0 failed, 6 skipped (TM 5.5.0).

None outstanding.

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

## Behavior diffs (SM vs TM)

Cases where SM and TM genuinely behave differently on the same input
— neither implementation is buggy, the API spec just doesn't pin the
behavior down and the two managers picked different rules. The
cross-manager assertion has been loosened to accept both; SM's
specific rule stays enforced in an SM-only spec.

- **`headers-inject-into/`** (content-world isolation) — TM doesn't
  implement `@inject-into` at all. It's a Violentmonkey /
  SourceMonkey header; TM's nearest equivalent is `@sandbox`.
  - TM therefore ignores `@inject-into content` and honours the
    variant's `@grant none`, which by TM's own rules means "run in
    page context". The script then legitimately sees the page's
    globals — a difference in what the header *means*, not a
    world-isolation bug.
  - The isolation assertions are skipped under TM (guarded in
    `tests/examples/headers-inject-into/headers-inject-into.spec.ts`);
    everything else in that spec, including the page-world half, still
    runs under both. SM's rule stays enforced by the same spec on the
    `sourcemonkey` project.
- **`gm-dom/`** (default-parent `<p>`) — TM appends the no-parent
  element to `<head>` regardless of tag; SM/VM route by tag (head
  for `script`/`style`/`link`/`meta`/`title`/`base`, body for
  everything else). The TM docs don't pin the default parent down,
  so neither rule is wrong. Cross-manager assertion: element was
  inserted and the count of matching `<p>`s went up by one. SM rule
  enforced strictly in `tests/e2e/gm-dom.spec.ts`.
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

## Manager-specific setup baked into the harness

Cases where TM needs something arranged for it before a spec can even
reach its assertions.

- **`GM_download` needs Chrome's `downloads` permission granted to
  TM.** It's an *optional* permission in TM's manifest, so the first
  `GM_download` call opens TM's "Browser API Downloads — click OK"
  page, whose OK button calls `chrome.permissions.request`. That needs
  Chrome's native grant bubble, which a headless run can't show: the
  click does nothing, the GM call never settles, and the spec times
  out on an empty log.
  - `scripts/e2e-tm-preflight.mjs` writes the grant into the test
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

- **`gm-download/`** — passes under TM (as of TM 5.5.0). The
  assertions stay at "some
  callback fired" rather than a specific value, because TM applies its
  own file-extension allowlist and can answer `not_whitelisted` where
  SM answers `onload`.
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

When triaging a new TM divergence, the options are:
1. Loosen the assertion so both managers pass (and move any
   SM-specific invariant into a `tests/e2e/` spec).
2. Decide it's an SM-only invariant and `test.skip` under TM with a
   pointer to here.
3. File the divergence upstream (TM tracker) if we think TM is wrong.

## Inspecting failures

Failing traces land in `test-results/` after each run. The
`--project=tampermonkey` invocation prints the failure list at the
end; open the trace zip via
`pnpm exec playwright show-trace test-results/<dir>/trace.zip` to step
through what the page actually saw.
