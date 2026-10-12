// Shared helpers for the suites that run SourceMonkey: launching
// Chromium with the unpacked extension, finding its service worker, and
// the HTTP fixture server. Used by `extension.ts` (the SM-only e2e
// fixture) and `manager.ts` (the examples fixture, on its SM branch).
// The launch itself is sm-dev's (src/harness/extension-launch.ts), so
// the suites, sm-dev and the consumer fixture run the same browser.

import { type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { handleSlowRoute, serveStaticFile } from './slow-route.mjs';
import { launchExtensionBrowser } from '../../lib/harness/extension-launch.js';

export interface LaunchedSmContext {
  ctx: BrowserContext;
  /** Closes the browser and removes its profile. */
  close(): Promise<void>;
}

/**
 * Launch a fresh hidden Chromium with the unpacked SM extension, "Allow
 * User Scripts" granted and first run done (see extension-launch.ts).
 * Optionally wires `SM_FORWARD_SW_CONSOLE` so SW `console.log` lines
 * stream to test stderr.
 */
export async function launchSourceMonkeyContext(opts: {
  // Leave downloads to Chrome itself, landing in this directory, instead
  // of Playwright's interception, which hides the real file name and
  // location from `chrome.downloads`, which the local-copy feature
  // depends on.
  downloads?: { dir: string };
  // Keep Chrome's back/forward cache, which Playwright turns off.
  backForwardCache?: boolean;
} = {}): Promise<LaunchedSmContext> {
  const launched = await launchExtensionBrowser({
    downloadsDir: opts.downloads?.dir,
    backForwardCache: opts.backForwardCache,
  });
  const ctx = launched.context;

  if (process.env.SM_FORWARD_SW_CONSOLE === '1') {
    const wireUp = (sw: Worker): void => {
      sw.on('console', (msg) => {
        process.stderr.write(`[sw ${msg.type()}] ${msg.text()}\n`);
      });
    };
    ctx.serviceWorkers().forEach(wireUp);
    ctx.on('serviceworker', wireUp);
  }

  return { ctx, close: launched.close };
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
      // `/__attachment/<name>` is a small text file the browser saves as
      // `<name>` rather than showing, for download tests.
      if (url.pathname.startsWith('/__attachment/')) {
        const name = path.basename(url.pathname);
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${name}"` });
        res.end(`attachment ${name}`);
        return;
      }
      // `/__slowbody/<page>?ms=N` sends the headers at once and the
      // page's bytes N ms later, so the browser has made the new
      // document well before the parser can create <html>. Clamped
      // like `/__slow/`'s ms.
      if (url.pathname.startsWith('/__slowbody/')) {
        const raw = Number(url.searchParams.get('ms') ?? '0');
        const ms = Number.isFinite(raw) ? Math.max(0, Math.min(5000, raw)) : 0;
        const file = path.join(pagesDir, url.pathname.slice('/__slowbody/'.length));
        const rel = path.relative(pagesDir, file);
        if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.flushHeaders();
        setTimeout(() => res.end(fs.readFileSync(file)), ms);
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
