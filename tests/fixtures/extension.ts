// Playwright fixture that launches Chromium with the unpacked extension
// loaded from dist/, and exposes a handle to its MV3 service worker.
//
// MV3 extensions can't be triggered by clicking the toolbar from Playwright,
// so tests invoke functions through `serviceWorker.evaluate(...)`, which
// calls into `self.SourceMonkey` (set up in src/extension/background.ts).

import { test as base, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPath } from './extension-id';
import { makeSwApi } from './sw-api';
import { SM_DEV_MARKERS } from '../../lib/sm-dev-protocol.js';
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
// example userscripts' `@match *://*/*<api>/<api>.html` patterns working
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
  // Where Chrome's own download manager saves files in this worker's
  // browser. Only set by `testWithBrowserDownloads`; the default `test`
  // leaves downloads to Playwright's interception (see
  // `launchSourceMonkeyContext`), where this is undefined.
  downloadsDir: string | undefined;
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
  // The browser marked as one sm-dev is connected to, for the test, as a
  // run marks it (`markBrowser` in src/harness/extension-link.ts), so a
  // claimed tab's `document-start` wrappers ask the SW. For a test that
  // claims tabs itself.
  smDevMarked: void;
};

// Two flavours of the same fixture set, differing only in who handles
// downloads. Most specs want Playwright's interception (`test`), which
// is what `page.waitForEvent('download')` needs. Specs that observe
// downloads through `chrome.downloads` — the local-copy feature reads
// the saved file's real path back from the download item — need
// Chrome's own download manager instead (`testWithBrowserDownloads`).
function makeTest(browserDownloads: boolean) {
  return base.extend<TestFixtures, WorkerFixtures>({
  fixtureServer: [
    async ({}, use) => {
      const server = await createFixtureServer(FIXTURE_PAGES_DIR, EXAMPLES_DIR);
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  downloadsDir: [
    async ({}, use) => {
      if (!browserDownloads) {
        await use(undefined);
        return;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemonkey-downloads-'));
      await use(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
    { scope: 'worker' },
  ],

  extensionContext: [
    async ({ downloadsDir }, use) => {
      const launched = await launchSourceMonkeyContext({
        downloads: downloadsDir ? { dir: downloadsDir } : undefined,
      });
      await use(launched.ctx);
      await launched.close();
    },
    { scope: 'worker' },
  ],

  getServiceWorker: async ({ extensionContext }, use) => {
    await use(makeGetServiceWorker(extensionContext));
  },

  extensionId: async ({ getServiceWorker }, use) => {
    // Service worker URL looks like: chrome-extension://<id>/extension/background.js
    const sw = await getServiceWorker();
    const id = new URL(sw.url()).host;
    await use(id);
  },

  smDevMarked: async ({ extensionContext }, use) => {
    const marker = await extensionContext.addInitScript({
      content: `window.addEventListener(${JSON.stringify(SM_DEV_MARKERS.present)}, (e) => e.preventDefault());`,
    });
    await use();
    await marker.dispose();
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
}

export const test = makeTest(false);
export const testWithBrowserDownloads = makeTest(true);

export const expect = test.expect;

// Close any collections tab left open, before a test that waits for a
// link to open one. The link focuses an open collections tab rather
// than opening another (src/extension/page-links.ts), and tests in one
// worker share `extensionContext`, so a tab an earlier test left behind
// (one opened by a link it clicked, say) means no new tab appears.
export async function closeCollectionsTabs(context: BrowserContext): Promise<void> {
  for (const page of context.pages()) {
    if (page.url().includes('/collections.html')) await page.close();
  }
}
