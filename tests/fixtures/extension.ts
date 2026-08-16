// Playwright fixture that launches Chromium with the unpacked extension
// loaded from dist/, and exposes a handle to its MV3 service worker.
//
// MV3 extensions can't be triggered by clicking the toolbar from Playwright,
// so tests invoke functions through `serviceWorker.evaluate(...)`, which
// calls into `self.SourceMonkey` (set up in src/background.ts).

import { test as base, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPath } from './extension-id';
import { makeSwApi } from './sw-api';
import {
  createFixtureServer,
  launchSourceMonkeyContext,
  makeGetServiceWorker,
  type FixtureServer,
} from './sourcemonkey-launch';

export type GetServiceWorker = () => Promise<Worker>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');
// Mounted as a fallback root so `tests/examples/<api>/<api>.html` is
// reachable at `/<api>/<api>.html` from the fixture server. Keeps the
// example userscripts' `@match *://*/<api>/<api>.html` patterns working
// against both the test harness and a standalone http-server.
const EXAMPLES_DIR = path.resolve(__dirname, '../examples');
export const EXTENSION_ID = extensionIdFromPath(EXTENSION_PATH);

// `extensionContext` is *worker-scoped* so a single Chromium window
// (with the extension loaded) is reused across every test in the same
// Playwright worker. Spinning up a fresh persistent context per test
// adds ~1s of launch overhead and a visible window flash. Tests get
// their own page via `extensionContext.newPage()` inside each test
// body and clean up after themselves.
//
// `serviceWorker` is *test-scoped* (and depends on the worker-scoped
// context) because the MV3 service worker can idle out and respawn
// between tests, which invalidates any previously-captured Worker
// handle. Re-resolving per test gives each test a live handle.
type WorkerFixtures = {
  // Local HTTP server fixture: serves fixture HTML pages out of
  // tests/fixtures/pages/. We need a real http:// origin (rather than
  // file:// or data:) because unpacked extensions don't get file://
  // access by default. Worker-scoped so it shares lifetime with
  // `extensionContext`, and binds to port 0 so parallel workers don't
  // collide.
  fixtureServer: FixtureServer;
  extensionContext: BrowserContext;
};

type TestFixtures = {
  // A function that returns a freshly-resolved, known-live service
  // worker handle. Tests should call this every time they need to
  // evaluate something — caching the returned Worker across page
  // operations risks the handle going stale.
  getServiceWorker: GetServiceWorker;
  extensionId: string;
  // Typed proxy over the `self.SourceMonkey` SW surface. Wipes storage
  // between tests so each test starts from a known-clean slate.
  sm: ReturnType<typeof makeSwApi>;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  fixtureServer: [
    async ({}, use) => {
      const server = await createFixtureServer(FIXTURE_PAGES_DIR, EXAMPLES_DIR);
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  extensionContext: [
    async ({}, use) => {
      const launched = await launchSourceMonkeyContext({
        extensionPath: EXTENSION_PATH,
        extensionId: EXTENSION_ID,
      });
      await use(launched.ctx);
      await launched.ctx.close();
      launched.cleanup();
    },
    { scope: 'worker' },
  ],

  getServiceWorker: async ({ extensionContext }, use) => {
    await use(makeGetServiceWorker(extensionContext));
  },

  extensionId: async ({ getServiceWorker }, use) => {
    // Service worker URL looks like: chrome-extension://<id>/background.js
    const sw = await getServiceWorker();
    const id = new URL(sw.url()).host;
    await use(id);
  },

  sm: async ({ getServiceWorker }, use) => {
    const api = makeSwApi(getServiceWorker);
    // Clean slate per test: clears chrome.storage.local + session AND
    // unregisters every chrome.userScripts entry. Without this each
    // test inherits the previous test's collections and the badge counts
    // are non-deterministic.
    await api.resetAllState();
    await use(api);
    // Best-effort teardown so a failure in one test doesn't poison
    // sibling tests' bootstrap.
    try { await api.resetAllState(); } catch {}
  },
});

export const expect = test.expect;
