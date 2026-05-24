// Shared HTTP-fixture primitives used by both the Playwright fixture
// server (tests/fixtures/sourcemonkey-launch.ts) and the standalone
// serve-examples CLI (scripts/serve-examples.mjs). Kept here so the
// `/__slow/` route, the static content-type table, and the tiny PNG
// blob have a single source of truth — if either consumer drifts the
// `headers-run-at` example silently degrades.
//
// Plain .mjs (not .ts) so the CLI can import it directly without a
// build step; the TypeScript fixture imports it the same way it
// already imports tampermonkey-driver.mjs.

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
