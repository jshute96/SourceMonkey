// Shared helpers for launching a Chromium with the unpacked SourceMonkey
// extension loaded. Used by both `extension.ts` (the SM-only e2e fixture)
// and `manager.ts` (the manager-agnostic examples fixture, on its SM
// branch). Keeping the launch path in one place so the examples suite
// under SM runs in the same environment as the main e2e suite.

import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handleSlowRoute, serveStaticFile } from './slow-route.mjs';

export interface LaunchedSmContext {
  ctx: BrowserContext;
  /** Removes the on-disk user-data-dir. Best-effort — Chrome may still hold a lock briefly. */
  cleanup(): void;
}

/**
 * Launch a fresh persistent Chromium with the unpacked SM extension.
 * Writes a Preferences file pre-launch to grant the per-extension
 * `user_scripts_enabled` toggle (Chrome ≥138 gates `chrome.userScripts`
 * behind it). Optionally wires `SM_FORWARD_SW_CONSOLE` so SW
 * `console.log` lines stream to test stderr.
 *
 * **The `extensionId` must match the ID Chrome actually uses for the
 * unpacked extension.** Our `src/manifest.json` has a `"key"` field,
 * so Chrome derives the ID from the key bytes rather than the
 * filesystem path. Use `extensionIdFromPath()` from `extension-id.ts`
 * — it reads the manifest and picks the right derivation. Writing to
 * the wrong ID silently no-ops: `chrome.userScripts` ends up
 * undefined and every userscript registration is dropped.
 */
export async function launchSourceMonkeyContext(opts: {
  extensionPath: string;
  extensionId: string;
  // Leave downloads to Chrome itself, landing in this directory, instead
  // of Playwright's interception. Playwright normally tells Chromium to
  // save every download under a GUID name in its own temp dir (CDP
  // `Browser.setDownloadBehavior: allowAndName`), which is what makes
  // `page.waitForEvent('download')` work — but it also hides the real
  // file name and location from `chrome.downloads`, which the local-copy
  // feature depends on. With this set, Chrome's own download manager
  // runs, honouring the `download.*` Preferences written here.
  downloads?: { dir: string };
}): Promise<LaunchedSmContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemonkey-test-'));
  writeExtensionPreferences(userDataDir, opts.extensionId, opts.downloads);

  await primeFirstRunFlag(userDataDir, opts.extensionPath);

  const ctx = await launchChromium(userDataDir, opts.extensionPath);

  if (opts.downloads) {
    // Playwright has already told Chromium to intercept downloads
    // (`allowAndName` into its artifacts dir) as part of creating the
    // context, and its public options offer no way to opt out. Undo
    // it over CDP: `default` hands download handling back to Chrome,
    // which then follows the `download.*` Preferences written above.
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await cdp.detach();
    await page.close();
  }

  if (process.env.SM_FORWARD_SW_CONSOLE === '1') {
    const wireUp = (sw: Worker): void => {
      sw.on('console', (msg) => {
        process.stderr.write(`[sw ${msg.type()}] ${msg.text()}\n`);
      });
    };
    ctx.serviceWorkers().forEach(wireUp);
    ctx.on('serviceworker', wireUp);
  }

  return {
    ctx,
    cleanup: () => {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function launchChromium(userDataDir: string, extensionPath: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    // Extensions require Chrome's new headless mode (--headless=new,
    // available since Chrome 112). We set headless: false so Playwright
    // doesn't inject its own --headless flag, then pass --headless=new
    // ourselves. This avoids a visible window that steals focus.
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

/**
 * Write `firstRunComplete` into the profile in a throwaway browser, so
 * the real context launches against a profile where first run is
 * already done.
 *
 * Why a whole extra launch: on a fresh profile the SW receives
 * `onInstalled('install')` and opens `collections.html?first_run=1`.
 * That happens while Chrome is still starting, before any test code can
 * reach the SW, so setting the flag after launch is a race — and one
 * that is lost regularly when several workers start their browsers at
 * once. Losing it is not harmless: the first-run page scrubs
 * `?first_run` out of its own URL, so what is left is an ordinary
 * `collections.html` tab that lives for the whole worker's lifetime.
 * Every later test that counts collections tabs, or expects a link to
 * open one, then sees the stray tab instead
 * (`tests/e2e/page-links.spec.ts`).
 *
 * The flag is persistent `chrome.storage.local`, so it survives into
 * the relaunch, where the SW's first-run check returns early and no tab
 * is opened. That also keeps the default collections from being seeded
 * over the network (GitHub), which is slow and flaky in a test run.
 * Key mirrors FIRST_RUN_DONE_KEY in script-store.ts.
 */
async function primeFirstRunFlag(userDataDir: string, extensionPath: string): Promise<void> {
  const ctx = await launchChromium(userDataDir, extensionPath);
  try {
    const sw = await makeGetServiceWorker(ctx)();
    await sw.evaluate(() => chrome.storage.local.set({ firstRunComplete: true }));
  } finally {
    // A clean close is what flushes the storage write to disk.
    await ctx.close();
  }
}

/**
 * Return a function that re-resolves a live SW handle each call. MV3
 * service workers idle out aggressively, and Playwright's
 * `serviceWorkers()` list can hand back a Worker whose underlying CDP
 * target has already been torn down. Don't cache — every call walks the
 * current list and polls each candidate for the `self.SourceMonkey` test
 * surface, falling back to `waitForEvent` for a fresh spawn if the list
 * is empty.
 */
export function makeGetServiceWorker(ctx: BrowserContext): () => Promise<Worker> {
  // The worker is "ready" only once its top-level module has run far
  // enough to expose the `self.SourceMonkey` test surface. Playwright's
  // `serviceworker` event (and a live `serviceWorkers()` entry) can both
  // precede that assignment — a bare `evaluate(() => true)` succeeds
  // against a worker whose module body hasn't finished — so every method
  // on the `sm` proxy would race the surface into existence. Poll for it.
  const apiReady = async (worker: Worker, budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      // A `true` result means the surface is live; a throw means the CDP
      // target went away (stale handle) — bail so the caller tries the
      // next candidate or waits for a fresh spawn.
      const has = await worker.evaluate(
        () => typeof (self as unknown as { SourceMonkey?: unknown }).SourceMonkey !== 'undefined',
      );
      if (has) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  return async () => {
    // A worker that answers but never exposes the surface (its module
    // body threw, say) is still the best handle available: returning it
    // fails the test on `SourceMonkey.<method> is not a function`, which
    // names the real problem. Discarding it in favour of `waitForEvent`
    // would report a spawn timeout instead and hide the cause.
    // Short budget per already-listed candidate: a live worker answers on
    // the first poll, so the only thing a long wait here buys is a delay
    // on EVERY proxy call once some worker is permanently surfaceless.
    // The long budget is spent only on a freshly spawned worker, which
    // genuinely needs time to evaluate its module.
    let answered: Worker | null = null;
    for (const candidate of ctx.serviceWorkers()) {
      try {
        if (await apiReady(candidate, 1000)) return candidate;
        answered ??= candidate;
      } catch {
        // stale; try the next one
      }
    }
    if (answered) return answered;
    const sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 });
    await apiReady(sw, 5000);
    return sw;
  };
}

// Pre-seed the Chrome profile so the unpacked extension at our known
// ID is granted the per-extension toggles that headless test runs
// can't click. Today this is just `user_scripts_enabled`, but the
// same Preferences file is the right place for future per-extension
// toggles. Keys observed by reading what Chrome itself writes after
// a user flips the toggle in the UI.
function writeExtensionPreferences(
  userDataDir: string,
  extensionId: string,
  downloads?: { dir: string },
): void {
  const defaultDir = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefs: Record<string, unknown> = {
    extensions: {
      settings: {
        [extensionId]: { user_scripts_enabled: true },
      },
    },
  };
  if (downloads) {
    // The same keys Chrome writes when the download location is changed
    // in its settings UI. `directory_upgrade` marks the directory as
    // user-chosen, so Chrome doesn't fall back to its platform default.
    prefs.download = {
      default_directory: downloads.dir,
      directory_upgrade: true,
      prompt_for_download: false,
    };
  }
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs));
}

// ----- HTTP fixture server -----

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Spin up an HTTP server that serves `pagesDir` first, then falls
 * through to `examplesDir`. Binds on a random port (so parallel
 * workers don't collide). Used by both the e2e and examples suites
 * so example pages live at `${baseUrl}/<dir>/<dir>.html`.
 */
export async function createFixtureServer(pagesDir: string, examplesDir: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // `/__slow/` is shared with the standalone serve CLI — see
      // tests/fixtures/slow-route.mjs.
      if (handleSlowRoute(url, res)) return;
      // `/__echo` reflects the request's own headers back as JSON. It is
      // how a test learns what a manager actually put on the wire —
      // forbidden headers (Origin, Referer, Sec-Fetch-*) are invisible
      // from inside the page that asked for the request.
      if (url.pathname === '/__echo') {
        const send = () => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          // The route's whole job is reporting *this* request's
          // headers, and the tests deliberately fire identical URLs at
          // it — exactly what the HTTP cache would collapse.
          res.setHeader('Cache-Control', 'no-store');
          // Answer any origin: the caller is an extension request whose
          // Origin we don't control, and a CORS rejection would hide the
          // very headers the route exists to report.
          res.setHeader('Access-Control-Allow-Origin', '*');
          // `url` is the request target as the server received it —
          // what the header tests use to check that the per-request URL
          // tag (a fragment) really stayed inside the browser.
          res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }, null, 2));
        };
        // `?delay=N` holds the whole response — headers included — so a
        // test can keep one request in flight while another runs. The
        // param rides in the URL on purpose: same-URL overlap tests
        // need two requests to the *identical* URL. Clamped like
        // `/__slow/`'s ms.
        const rawDelay = Number(url.searchParams.get('delay') ?? '0');
        const delay = Number.isFinite(rawDelay) ? Math.max(0, Math.min(5000, rawDelay)) : 0;
        if (delay > 0) setTimeout(send, delay);
        else send();
        return;
      }
      // `/__sandbox/<page>` serves a fixture page with a CSP `sandbox`
      // header, which a <meta> CSP can't set. See sandbox-csp.spec.ts.
      if (url.pathname.startsWith('/__sandbox/')) {
        res.setHeader('Content-Security-Policy', 'sandbox');
        if (serveStaticFile(res, pagesDir, url.pathname.slice('/__sandbox/'.length))) return;
        res.removeHeader('Content-Security-Policy');
        res.statusCode = 404;
        res.end();
        return;
      }
      const name = url.pathname.replace(/^\//, '') || 'index.html';
      if (serveStaticFile(res, pagesDir, name)) return;
      if (serveStaticFile(res, examplesDir, name)) return;
      res.statusCode = 404;
      res.end();
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      // closeAllConnections() forces idle keep-alive sockets shut so
      // server.close() doesn't block on them — without it teardown
      // hangs until Playwright's 30s fixture timeout fires.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
