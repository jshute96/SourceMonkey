// Playwright fixture that launches Chromium with the unpacked extension
// loaded from dist/, and exposes a handle to its MV3 service worker.
//
// MV3 extensions can't be triggered by clicking the toolbar from Playwright,
// so tests invoke functions through `serviceWorker.evaluate(...)`, which
// calls into `self.VibeMonkey` (set up in src/background.ts).

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GetServiceWorker = () => Promise<Worker>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');

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
  fixtureServer: { baseUrl: string };
  extensionContext: BrowserContext;
};

type TestFixtures = {
  // A function that returns a freshly-resolved, known-live service
  // worker handle. Tests should call this every time they need to
  // evaluate something — caching the returned Worker across page
  // operations risks the handle going stale.
  getServiceWorker: GetServiceWorker;
  extensionId: string;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  fixtureServer: [
    async ({}, use) => {
      const server = http.createServer((req, res) => {
        try {
          // Serve a fixture page from FIXTURE_PAGES_DIR. Reject path
          // traversal so a malformed URL can't escape the fixture root.
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const name = url.pathname.replace(/^\//, '') || 'index.html';
          const filePath = path.join(FIXTURE_PAGES_DIR, name);
          const rel = path.relative(FIXTURE_PAGES_DIR, filePath);
          if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(fs.readFileSync(filePath));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      await use({ baseUrl });
      // closeAllConnections() forces idle keep-alive sockets shut so
      // server.close() doesn't block on them — without it, teardown hangs
      // until Playwright's 30s fixture timeout fires.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    { scope: 'worker' },
  ],

  extensionContext: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext('', {
        // Extensions require Chrome's new headless mode (--headless=new,
        // available since Chrome 112). We set headless: false so Playwright
        // doesn't inject its own --headless flag, then pass --headless=new
        // ourselves. This avoids a visible window that steals focus.
        headless: false,
        args: [
          '--headless=new',
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
        ],
      });
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' },
  ],

  getServiceWorker: async ({ extensionContext }, use) => {
    // MV3 service workers idle out aggressively, and Playwright's
    // `serviceWorkers()` list can hand back a Worker handle whose
    // underlying CDP target has already been torn down. So we don't
    // cache — every call walks the current list and verifies each
    // candidate with a no-op evaluate, falling back to waitForEvent
    // for a fresh spawn if nothing in the list is live.
    const get: GetServiceWorker = async () => {
      for (const candidate of extensionContext.serviceWorkers()) {
        try {
          await candidate.evaluate(() => true);
          return candidate;
        } catch {
          // stale; try the next one
        }
      }
      const sw = await extensionContext.waitForEvent('serviceworker', { timeout: 5000 });
      // Newly-spawned worker may need a moment to be ready for evaluate.
      await sw.evaluate(() => true);
      return sw;
    };
    await use(get);
  },

  extensionId: async ({ getServiceWorker }, use) => {
    // Service worker URL looks like: chrome-extension://<id>/background.js
    const sw = await getServiceWorker();
    const id = new URL(sw.url()).host;
    await use(id);
  },
});

export const expect = test.expect;
