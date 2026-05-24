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
}): Promise<LaunchedSmContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemonkey-test-'));
  writeExtensionPreferences(userDataDir, opts.extensionId);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    // Extensions require Chrome's new headless mode (--headless=new,
    // available since Chrome 112). We set headless: false so Playwright
    // doesn't inject its own --headless flag, then pass --headless=new
    // ourselves. This avoids a visible window that steals focus.
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${opts.extensionPath}`,
      `--load-extension=${opts.extensionPath}`,
    ],
  });

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

/**
 * Return a function that re-resolves a live SW handle each call. MV3
 * service workers idle out aggressively, and Playwright's
 * `serviceWorkers()` list can hand back a Worker whose underlying CDP
 * target has already been torn down. Don't cache — every call walks
 * the current list and verifies each candidate with a no-op evaluate,
 * falling back to `waitForEvent` for a fresh spawn if nothing is live.
 */
export function makeGetServiceWorker(ctx: BrowserContext): () => Promise<Worker> {
  return async () => {
    for (const candidate of ctx.serviceWorkers()) {
      try {
        await candidate.evaluate(() => true);
        return candidate;
      } catch {
        // stale; try the next one
      }
    }
    const sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 });
    await sw.evaluate(() => true);
    return sw;
  };
}

// Pre-seed the Chrome profile so the unpacked extension at our known
// ID is granted the per-extension toggles that headless test runs
// can't click. Today this is just `user_scripts_enabled`, but the
// same Preferences file is the right place for future per-extension
// toggles. Keys observed by reading what Chrome itself writes after
// a user flips the toggle in the UI.
function writeExtensionPreferences(userDataDir: string, extensionId: string): void {
  const defaultDir = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefs = {
    extensions: {
      settings: {
        [extensionId]: { user_scripts_enabled: true },
      },
    },
  };
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs));
}

// ----- HTTP fixture server -----

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

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
      const name = url.pathname.replace(/^\//, '') || 'index.html';
      if (serveFile(res, pagesDir, name)) return;
      if (serveFile(res, examplesDir, name)) return;
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

function serveFile(res: http.ServerResponse, root: string, name: string): boolean {
  const filePath = path.join(root, name);
  const rel = path.relative(root, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.end(fs.readFileSync(filePath));
  return true;
}
