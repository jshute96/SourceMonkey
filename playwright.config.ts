import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded. They are not parallelizable per worker because
// each worker spins up its own browser context anyway.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
