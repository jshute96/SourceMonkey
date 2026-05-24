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

These fail under TM today. Each is a real SM-vs-TM behaviour
difference, not a harness bug. Pick one per follow-up:

- **`gm-log/`** — asserts the SM-specific `[SourceMonkey:` console
  prefix; TM uses its own per-script prefix.
- **`headers-inject-into/`** — page-world script doesn't see the
  page's inline-script globals the way it does under SM. Different
  world / context-isolation behaviour.
- **`headers-run-at/`** — asserts strict
  `document-start → document-end → document-idle` injection order
  on a shared page. Flaky under TM: passes in headed mode (with the
  tab-cleanup nudging timing) but fails in headless. TM doesn't
  guarantee the ordering on small local pages.
- **`gm-dom/`** (default-parent `<p>` → body) — TM may resolve the
  default parent differently when no explicit parent is passed to
  `GM_addElement`.
- **`gm-notification/`** (empty-text rejection) — TM may not reject
  the call the same way.

For each, the triage options are:
1. Loosen the assertion so both managers pass.
2. Decide it's an SM-only invariant and `test.skip` under TM with a
   pointer to here.
3. File the divergence upstream (TM tracker) if we think TM is wrong.

## Inspecting failures

Failing traces land in `test-results/` after each run. The
`--project=tampermonkey` invocation prints the failure list at the
end; open the trace zip via
`npx playwright show-trace test-results/<dir>/trace.zip` to step
through what the page actually saw.
