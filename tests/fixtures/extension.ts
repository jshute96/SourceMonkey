// Playwright fixture that launches Chromium with the unpacked extension
// loaded from dist/, and exposes a handle to its MV3 service worker.
//
// MV3 extensions can't be triggered by clicking the toolbar from Playwright,
// so tests invoke functions through `serviceWorker.evaluate(...)`, which
// calls into `self.SourceMonkey` (set up in src/background.ts).

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPath } from './extension-id';
import { makeSwApi } from './sw-api';

export type GetServiceWorker = () => Promise<Worker>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');
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
  // Typed proxy over the `self.SourceMonkey` SW surface. Wipes storage
  // between tests so each test starts from a known-clean slate.
  sm: ReturnType<typeof makeSwApi>;
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
      // Use a real on-disk user-data-dir (instead of Playwright's
      // default temp '') because we need to pre-write Preferences for
      // the extension before Chrome launches:
      //   - `extensions.settings.<id>.user_scripts_enabled` — Chrome
      //     ≥138 gates chrome.userScripts behind a per-extension toggle.
      //     Without this, the API is undefined and no injection works.
      //     Key name discovered by grepping the Chrome binary for
      //     `user_scripts`; matches what Chrome writes when a user
      //     flips the UI toggle.
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemonkey-test-'));
      writeExtensionPreferences(userDataDir, EXTENSION_ID);

      const forwardSwConsole = process.env.SM_FORWARD_SW_CONSOLE === '1';
      const ctx = await chromium.launchPersistentContext(userDataDir, {
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
      // Optional SW console forwarding so tests can use console.log
      // in the SW for diagnostics. Off by default (noisy); flip
      // SM_FORWARD_SW_CONSOLE=1 to enable. Each newly-spawned SW gets
      // its own listener — MV3 workers respawn aggressively.
      if (forwardSwConsole) {
        const wireUp = (sw: Worker): void => {
          sw.on('console', (msg) => {
            process.stderr.write(`[sw ${msg.type()}] ${msg.text()}\n`);
          });
        };
        ctx.serviceWorkers().forEach(wireUp);
        ctx.on('serviceworker', wireUp);
      }
      await use(ctx);
      await ctx.close();
      // Best-effort cleanup; Chrome may still hold a lock briefly.
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
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

  sm: async ({ getServiceWorker }, use) => {
    const api = makeSwApi(getServiceWorker);
    // Clean slate per test: clears chrome.storage.local + session AND
    // unregisters every chrome.userScripts entry. Without this each
    // test inherits the previous test's sources and the badge counts
    // are non-deterministic.
    await api.resetAllState();
    await use(api);
    // Best-effort teardown so a failure in one test doesn't poison
    // sibling tests' bootstrap.
    try { await api.resetAllState(); } catch {}
  },
});

export const expect = test.expect;

// Pre-seed the Chrome profile so the unpacked extension at our known ID
// is granted the per-extension toggles that headless test runs can't
// click. Today this is just `user_scripts_allowed` (Chrome ≥138), but
// the same Preferences file is the right place to drop future toggles.
//
// Chrome writes its own Preferences on first run; ours has to be in
// place before launch so it takes precedence. Keys observed by reading
// what Chrome itself writes after a user flips the toggle in the UI.
function writeExtensionPreferences(userDataDir: string, extensionId: string): void {
  const defaultDir = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefs = {
    extensions: {
      settings: {
        [extensionId]: {
          // Chrome ≥138 stores this when the user flips the
          // "Allow User Scripts" toggle on chrome://extensions.
          // Setting it pre-launch grants the permission to the
          // already-known extension ID without UI clicks.
          //
          // CAREFUL: `extensionId` here must be the same ID Chrome
          // actually uses for the unpacked extension. If manifest.json
          // has a `"key"` field (it does — see src/manifest.json),
          // Chrome derives the ID from the key bytes, not the
          // filesystem path. The helper in tests/fixtures/
          // extension-id.ts reads the manifest to pick the right
          // derivation. Writing to the wrong ID silently no-ops:
          // chrome.userScripts ends up undefined and the SW boots
          // fine but every userscript registration is dropped.
          user_scripts_enabled: true,
        },
      },
    },
  };
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs));
}
