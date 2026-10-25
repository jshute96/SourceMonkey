import { defineConfig } from '@playwright/test';

// Playwright sets FORCE_COLOR=1 in its workers, which every sm-dev a
// test spawns would take up, coloring output the tests read as text.
// Workers load this file too, so it is dropped here for them (and in
// the runner, where it isn't set).
delete process.env.FORCE_COLOR;

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
// Projects:
//   - sourcemonkey (default) — runs every spec under both directories.
//   - sm-dev                 — tests/harness/, sm-dev's own suite.
//   - tampermonkey           — runs only the examples suite, each worker
//                              in a new browser with TM loaded
//                              (tests/fixtures/manager-launch.ts).
//   - violentmonkey          — the same, with VM.
//
// SM-internals specs (e2e/) are skipped under the external managers
// because they reach into the SM service worker, which doesn't exist
// there.
//
// `metadata.manager` is the source of truth for which backend
// tests/fixtures/manager.ts uses. Pick the project explicitly with
// `--project=<name>`; the `test:e2e` script wires the SM project so
// `pnpm test` doesn't also run the TM and VM suites. See
// docs/cross-manager-testing.md.
export default defineConfig({
  testDir: './tests',
  // Half the cores. Each worker runs its own Chromium with the
  // extension loaded, so this trades memory for wall-clock; leaving
  // headroom keeps the box usable while a run is going.
  // The TM and VM projects run the same way, each worker in its own
  // browser (tests/fixtures/manager-launch.ts).
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
      // A retry starts from a fresh browser (Playwright discards the
      // crashed worker and its context), which is what makes it safe.
      retries: 1,
    },
    {
      // sm-dev and the `sourcemonkey/harness` fixture's own suite
      // (src/harness/). See docs/harness-design.md.
      name: 'sm-dev',
      testMatch: ['harness/**/*.spec.ts'],
      retries: 1,
    },
    {
      // Whether the Violentmonkey `manager fetch` got still answers the
      // calls sm-dev makes. Run on demand (`pnpm run test:vm-api`). See
      // docs/sm-dev-violentmonkey.md.
      name: 'vm-api',
      testMatch: ['vm-api/**/*.spec.ts'],
    },
    {
      // The same for Tampermonkey (`pnpm run test:tm-api`). See
      // docs/sm-dev-tampermonkey.md.
      name: 'tm-api',
      testMatch: ['tm-api/**/*.spec.ts'],
    },
    {
      name: 'tampermonkey',
      testMatch: ['examples/**/*.spec.ts'],
      metadata: { manager: 'tampermonkey' },
      // A spec file's tests stay in one worker, in order, so its
      // scripts are installed into that worker's manager once.
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
