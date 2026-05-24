import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded. They are not parallelizable per worker because
// each worker spins up its own browser context anyway.
//
// Two spec locations:
//   - tests/e2e/*.spec.ts          — the main suite, grouped by feature.
//   - tests/examples/*/*.spec.ts   — per-API spec lives next to its
//                                    paired example page + userscript.
export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.ts', 'examples/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
