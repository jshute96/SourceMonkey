import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded. They are not parallelizable per worker because
// each worker spins up its own browser context anyway.
//
// Two spec locations:
//   - tests/e2e/*.spec.ts          — the main suite, grouped by feature.
//   - tests/examples/*/*.spec.ts   — per-API spec lives next to its
//                                    paired example page + userscript.
//
// Two projects:
//   - sourcemonkey (default) — runs every spec under both directories.
//   - tampermonkey           — runs only the examples suite against the
//                              user's TM-equipped browser opened via
//                              scripts/open-test-browser-with-TamperMonkey.sh.
//                              SM-internals specs (e2e/) are skipped here
//                              because they reach into the SM service
//                              worker which doesn't exist under TM.
//
// `metadata.manager` is the source of truth for which backend
// tests/fixtures/manager.ts uses. Pick the project explicitly with
// `--project=sourcemonkey` or `--project=tampermonkey`; the npm
// `test:e2e` script wires the SM project so `npm test` doesn't try to
// reach a TM browser. See docs/cross-manager-testing.md.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
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
      // context), which is what makes it safe. The tampermonkey project
      // drives the developer's own long-lived profile over CDP with no
      // per-test reset, where re-running a half-finished install is not
      // the same proposition.
      retries: 1,
    },
    {
      name: 'tampermonkey',
      testMatch: ['examples/**/*.spec.ts'],
      metadata: { manager: 'tampermonkey' },
    },
  ],
});
