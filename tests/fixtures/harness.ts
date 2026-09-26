// Playwright fixtures for the harness suite (`tests/harness/`): a plain
// Chromium with NO extension loaded, the fixture HTTP server, and a
// host + attachment per test.
//
// This is the harness's own test bed, distinct from the `sourcemonkey`
// project's fixtures in `extension.ts`: the point of these specs is
// that the injected code runs without `chrome.*` at all, so loading the
// extension here would defeat them.

import { test as base } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HarnessHost } from '../../lib/harness/host.js';
import { attachPage, type PageAttachment } from '../../lib/harness/inject.js';
import { prepareScript, type PrepareOptions, type PreparedScript } from '../../lib/harness/prepare.js';
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
  host: HarnessHost;
  attachment: PageAttachment;
  /** Write a userscript into `scriptsDir`, prepare it, and inject it. */
  loadScript: (spec: UserscriptSpec, options?: Omit<PrepareOptions, 'file'>) => Promise<PreparedScript>;
}

export const test = base.extend<HarnessFixtures, HarnessWorkerFixtures>({
  runsDir: [async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-runs-test-'));
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

  host: async ({ scriptsDir }, use) => {
    const host = new HarnessHost();
    // Per test, so parallel workers downloading the same name can't
    // collide in the shared default directory.
    host.downloadDir = path.join(scriptsDir.path, 'downloads');
    await use(host);
  },

  attachment: async ({ page, host }, use) => {
    const attachment = await attachPage(page, host);
    await use(attachment);
    await attachment.dispose();
  },

  loadScript: async ({ scriptsDir, attachment }, use) => {
    await use(async (spec, options = {}) => {
      const file = scriptsDir.write(spec);
      const prepared = await prepareScript({ file, collectionRoot: scriptsDir.path, ...options });
      if (prepared.status !== 'ok') throw new Error(`Test script is invalid: ${prepared.diagnostic}`);
      await attachment.inject(prepared);
      return prepared;
    });
  },
});

export { expect } from '@playwright/test';
