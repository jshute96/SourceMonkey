// Playwright fixtures for sm-dev's own suite (`tests/harness/`): the
// `sourcemonkey/harness` fixture (a browser per worker with SourceMonkey
// loaded, and a claimed page, host and attachment per test), plus the
// fixture HTTP server, a scripts directory per test, and `loadScript`.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base } from '../../lib/harness/fixture.js';
import { attachPage, type PageAttachment } from '../../lib/harness/page-watch.js';
import type { PrepareOptions, PreparedScript } from '../../lib/harness/prepare.js';
import type { Page } from '@playwright/test';
import { createFixtureServer, type FixtureServer } from './sourcemonkey-launch.js';
import { ScriptsDir, type UserscriptSpec } from './scripts-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.resolve(here, 'pages');
const EXAMPLES_DIR = path.resolve(here, '..', 'examples');

export interface HarnessWorkerFixtures {
  fixtureServer: FixtureServer;
  /**
   * A runs directory of the worker's own, so the runs these tests start
   * in-process never register beside the developer's real ones.
   */
  runsDir: string;
}

export interface HarnessFixtures {
  scriptsDir: ScriptsDir;
  /** Write a userscript into `scriptsDir` and push it for the test's page. */
  loadScript: (spec: UserscriptSpec, options?: Omit<PrepareOptions, 'file'> & { values?: Record<string, unknown> }) => Promise<PreparedScript>;
  /**
   * Another page of the test's, claimed and watched as `page` is, for a
   * second tab. The test records the scripts it runs there itself
   * (`inject`). Disposed with the test.
   */
  watchPage: (page: Page) => Promise<PageAttachment>;
}

export const test = base.extend<HarnessFixtures, HarnessWorkerFixtures>({
  runsDir: [async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-test-runs-'));
    process.env.SM_DEV_RUNS_DIR = dir;
    // Runs keep logs too, which stay out of the real ones' way here.
    process.env.SM_DEV_LOGS_DIR = path.join(dir, 'logs');
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  }, { scope: 'worker', auto: true }],

  fixtureServer: [async ({}, use) => {
    const server = await createFixtureServer(PAGES_DIR, EXAMPLES_DIR);
    await use(server);
    await server.close();
  }, { scope: 'worker' }],

  scriptsDir: async ({}, use) => {
    const dir = ScriptsDir.create('sourcemonkey-harness-');
    await use(dir);
    dir.cleanup();
  },

  watchPage: async ({ host, _smLink }, use) => {
    const made: PageAttachment[] = [];
    await use(async (page) => {
      const tabId = await _smLink.claimPage(page);
      const attachment = await attachPage(page, host, { watchOnly: { extensionOrigin: _smLink.origin } });
      host.addTab(attachment, tabId);
      made.push(attachment);
      return attachment;
    });
    for (const attachment of made) await attachment.dispose().catch(() => undefined);
  },

  loadScript: async ({ scriptsDir, loadUserscript }, use) => {
    await use(async (spec, options = {}) => {
      const file = scriptsDir.write(spec);
      return loadUserscript(file, { collectionRoot: scriptsDir.path, ...options });
    });
  },
});

export { expect } from '@playwright/test';
