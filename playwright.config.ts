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
// Spec locations:
//   - tests/e2e/*.spec.ts                — the main suite, grouped by feature.
//   - userscripts/**/*.spec.ts           — a userscript's spec, next to it.
//                                          Each example's sits with its
//                                          page; the standalone scripts' use
//                                          the `sourcemonkey/harness` fixture.
//
// Projects:
//   - sourcemonkey (default) — runs every spec under both directories.
//   - sm-dev                 — tests/harness/, sm-dev's own suite.
//   - tampermonkey           — runs only the examples suite, each worker
//                              in a new browser with TM loaded
//                              (tests/fixtures/manager-launch.ts).
//   - violentmonkey          — the same, with VM.
//
// SM-internals specs (tests/e2e/) are skipped under the external managers
// because they reach into the SM service worker, which doesn't exist
// there.
//
// `metadata.manager` is the source of truth for which backend
// tests/fixtures/manager.ts uses. Pick the project explicitly with
// `--project=<name>`; the `test:e2e` script wires the SM project so
// `pnpm test` doesn't also run the TM and VM suites. See
// docs/cross-manager-testing.md.
export default defineConfig({
  // The repo root, since specs live under both tests/ and userscripts/.
  testDir: '.',
  // Agents' git worktrees under .claude/ hold copies of the specs.
  testIgnore: ['.claude/**'],
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
      testMatch: ['tests/e2e/**/*.spec.ts', 'userscripts/**/*.spec.ts'],
      metadata: { manager: 'sourcemonkey' },
      // A retry starts from a fresh browser (Playwright discards the
      // crashed worker and its context), which is what makes it safe.
      retries: 1,
    },
    {
      // sm-dev and the `sourcemonkey/harness` fixture's own suite
      // (src/harness/). See docs/harness-design.md.
      name: 'sm-dev',
      testMatch: ['tests/harness/**/*.spec.ts'],
      retries: 1,
    },
    {
      // Whether the Violentmonkey `manager fetch` got still answers the
      // calls sm-dev makes. Run on demand (`pnpm run test:vm-api`). See
      // docs/sm-dev-violentmonkey.md.
      name: 'vm-api',
      testMatch: ['tests/vm-api/**/*.spec.ts'],
    },
    {
      // The same for Tampermonkey (`pnpm run test:tm-api`). See
      // docs/sm-dev-tampermonkey.md.
      name: 'tm-api',
      testMatch: ['tests/tm-api/**/*.spec.ts'],
    },
    {
      // SourceMonkey, Tampermonkey and Violentmonkey loaded together, for
      // how their `.user.js` captures get along. Run on demand
      // (`pnpm run test:all-managers`). See docs/install-capture.md.
      name: 'all-managers',
      testMatch: ['tests/all-managers/**/*.spec.ts'],
      // A describe group's tests share one browser with the managers
      // loaded, rather than each worker launching its own: less load,
      // so less noise in timing-sensitive tests.
      fullyParallel: false,
    },
    {
      name: 'tampermonkey',
      testMatch: ['userscripts/examples/**/*.spec.ts'],
      metadata: { manager: 'tampermonkey' },
      // A spec file's tests stay in one worker, in order, so its
      // scripts are installed into that worker's manager once.
      fullyParallel: false,
    },
    {
      name: 'violentmonkey',
      testMatch: ['userscripts/examples/**/*.spec.ts'],
      metadata: { manager: 'violentmonkey' },
      fullyParallel: false,
    },
  ],
});
