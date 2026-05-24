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
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'sourcemonkey',
      testMatch: ['e2e/**/*.spec.ts', 'examples/**/*.spec.ts'],
      metadata: { manager: 'sourcemonkey' },
    },
    {
      name: 'tampermonkey',
      testMatch: ['examples/**/*.spec.ts'],
      metadata: { manager: 'tampermonkey' },
    },
  ],
});
