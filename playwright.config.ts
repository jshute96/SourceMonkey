import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded. Each worker spins up its own context, which
// is what makes running several at once safe: the fixture server binds
// to port 0 and every context gets its own `mkdtemp` profile, so two
// workers share nothing (see tests/fixtures/sourcemonkey-launch.ts).
//
// Two spec locations:
//   - tests/e2e/*.spec.ts          — the main suite, grouped by feature.
//   - tests/examples/*/*.spec.ts   — per-API spec lives next to its
//                                    paired example page + userscript.
//
// Three projects:
//   - sourcemonkey (default) — runs every spec under both directories.
//   - tampermonkey           — runs only the examples suite against the
//                              user's TM-equipped browser opened via
//                              `scripts/open-test-browser.sh tampermonkey`.
//   - violentmonkey          — the same, against a VM-equipped profile.
//
// SM-internals specs (e2e/) are skipped under the external managers
// because they reach into the SM service worker, which doesn't exist
// there.
//
// `metadata.manager` is the source of truth for which backend
// tests/fixtures/manager.ts uses. Pick the project explicitly with
// `--project=<name>`; the `test:e2e` script wires the SM project so
// `pnpm test` doesn't try to reach a TM or VM browser. See
// docs/cross-manager-testing.md.
export default defineConfig({
  testDir: './tests',
  // Half the cores. Each worker runs its own Chromium with the
  // extension loaded, so this trades memory for wall-clock; leaving
  // headroom keeps the box usable while a run is going.
  //
  // The external-manager projects must NOT run this way — each drives
  // one real browser over CDP with no per-test reset — so
  // `pnpm run test:e2e:tm` / `:vm` pass `--workers=1`.
  fullyParallel: true,
  workers: '50%',
  reporter: 'list',
  // Don't record a trace unless a test is being retried. `retain-on-failure`
  // records one for EVERY test and throws it away on pass, and the suite
  // shares a single worker-scoped browser context across all its tests
  // (tests/fixtures/extension.ts) — recording against a context that
  // long-lived eventually stalls the trace fixture past its own 30s
  // setup timeout, failing whichever test is next. See docs/testing.md.
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'sourcemonkey',
      testMatch: ['e2e/**/*.spec.ts', 'examples/**/*.spec.ts'],
      metadata: { manager: 'sourcemonkey' },
      // Scoped to this project on purpose: a retry here starts from a
      // fresh browser (Playwright discards the crashed worker and its
      // context), which is what makes it safe. The external-manager
      // projects drive the developer's own long-lived profile over CDP
      // with no per-test reset, where re-running a half-finished install
      // is not the same proposition.
      retries: 1,
    },
    {
      name: 'tampermonkey',
      testMatch: ['examples/**/*.spec.ts'],
      metadata: { manager: 'tampermonkey' },
      // Documents intent where the setting lives. It does not by itself
      // prevent cross-worker parallelism — `workers` is global — which
      // is why tests/fixtures/manager.ts refuses to run this project
      // with more than one.
      fullyParallel: false,
    },
    {
      name: 'violentmonkey',
      testMatch: ['examples/**/*.spec.ts'],
      metadata: { manager: 'violentmonkey' },
      fullyParallel: false,
    },
  ],
});
