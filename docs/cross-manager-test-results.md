# Cross-manager test results

What happens when the examples suite runs against Tampermonkey. The
framework itself is documented in
[`cross-manager-testing.md`](cross-manager-testing.md); this doc is
a snapshot of which specs pass, which are intentionally skipped,
and which surface real SM-vs-TM divergences.

Re-run the suite with:

```sh
npm run test:e2e:tm
# or directly:
npx playwright test --project=tampermonkey
```

Update this doc when a result changes.

## Intentional skips

Specs that opt out under TM via
`test.skip(setup.manager === 'tampermonkey', '<reason>')`:

- **`xmlhttp-denied/`** — asserts SM's exact
  `"blocked by @connect policy"` message. TM has its own `@connect`
  UX (potentially prompting the user) and its own denial message.
  Out of scope for cross-manager comparison.

## Failing specs (untriaged divergences)

- **`headers-inject-into/`** — page-world script doesn't see the
  page's inline-script globals the way it does under SM. Different
  world / context-isolation behaviour. Needs its own triage.

## Resolved divergences

Specs that previously diverged and have been loosened to compliance-
level assertions. Manager-specific invariants have moved into
SM-only specs under `tests/e2e/`:

- **`gm-log/`** — assertion no longer requires the SM-specific
  `[SourceMonkey:` prefix; just checks the message text reached the
  console. SM prefix coverage: `tests/e2e/gm-log.spec.ts`.
- **`gm-dom/`** (default-parent `<p>`) — assertion no longer pins
  the parent to `<body>`; just checks the element was inserted and
  the count of matching `<p>`s went up by one. SM default-parent
  rules (head-tag list, body for non-head tags): `tests/e2e/gm-dom.spec.ts`.
- **`gm-notification/`** (empty-text) — assertion now accepts
  resolved, rejected, or synchronously thrown; just verifies an
  observable outcome. SM strict-rejection invariant:
  `tests/e2e/gm-notification.spec.ts`.
- **`headers-run-at/`**:
  - Strict `start → end → idle` ordering removed. Cross-manager
    spec now asserts only that all three scripts ran and that
    document-idle observes `readyState=complete`.
  - SM-specific strict ordering covered by
    `tests/e2e/injection.spec.ts` ("document-start, document-end,
    document-idle inject in @run-at order").
  - The example page pulls in a slow sync
    `<script src="/__slow/blocker.js?ms=400">` so document-start
    gets an actual loading-phase injection window. See
    `tests/examples/README.md` for the serve-script setup that
    provides the `/__slow/` route.

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
`npx playwright show-trace test-results/<dir>/trace.zip` to step
through what the page actually saw.
