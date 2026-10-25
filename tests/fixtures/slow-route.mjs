// Shared HTTP-fixture primitives used by the Playwright fixture server
// (tests/fixtures/sourcemonkey-launch.ts) and the standalone
// serve-examples CLI (scripts/serve-examples.mjs). Kept here
// so the `/__slow/` route, the static content-type table, the tiny PNG
// blob, and the static-file serving all have a single source of truth
// — if a consumer drifts, the `headers-run-at` example silently
// degrades.
//
// Plain .mjs (not .ts) so the CLI can import it directly without a
// build step; the TypeScript fixture imports it the same way it
// already imports tampermonkey-driver.mjs.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Content-Type table for the static-file fall-through. Both servers
// fall back to application/octet-stream for unlisted extensions.
// JSDoc `Record<string, string>` lets the TypeScript consumer index
// it with an arbitrary file-extension string.
/** @type {Record<string, string>} */
export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  // gm-download/sample.txt — served as text so a browser that opens it
  // instead of downloading it shows something readable.
  '.txt': 'text/plain; charset=utf-8',
};

// Smallest valid PNG: 1x1, transparent. Sent by `/__slow/*.png`.
export const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// Handle a `/__slow/<filename>?ms=N` request: schedule a delayed
// response with content-type picked from the extension (.js →
// text/javascript, default image/png) and the body either a tiny JS
// comment or ONE_PX_PNG. `ms` is clamped to [0, 5000]; non-finite
// values fall back to 0 (setTimeout(fn, NaN) would fire immediately
// and silently break timing-sensitive callers).
//
// Returns true when the URL was handled and the response was
// scheduled, false otherwise. Caller is expected to short-circuit
// further handling on true.
export function handleSlowRoute(url, res) {
  if (!url.pathname.startsWith('/__slow/')) return false;
  const raw = Number(url.searchParams.get('ms') ?? '0');
  const ms = Number.isFinite(raw) ? Math.max(0, Math.min(5000, raw)) : 0;
  const ext = path.extname(url.pathname).toLowerCase();
  const isJs = ext === '.js';
  setTimeout(() => {
    res.statusCode = 200;
    res.setHeader('Content-Type', isJs ? 'text/javascript; charset=utf-8' : 'image/png');
    res.end(isJs ? '/* slow delay */' : ONE_PX_PNG);
  }, ms);
  return true;
}

/**
 * Serve `<root>/<name>` if it exists and stays inside `root`, with a
 * Content-Type from the table above. Returns false without touching
 * `res` when there's nothing to serve, so callers can fall through to
 * another root or a 404.
 */
export function serveStaticFile(res, root, name) {
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

/**
 * A static server over `root` plus the `/__slow/` route. Pass port 0
 * for an ephemeral port; `listen` resolves with the bound base URL.
 *
 * Used by the serve-examples CLI.
 */
export function createStaticServer(root) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (handleSlowRoute(url, res)) return;
      const name = url.pathname.replace(/^\//, '') || 'index.html';
      if (serveStaticFile(res, root, name)) return;
      res.statusCode = 404;
      res.end();
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  return {
    // Rejects rather than throwing an unhandled 'error' event: port 0
    // callers can't fail, but `serve-examples --port 8080` on a busy
    // port should say so instead of dying in an event handler.
    listen: (port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
