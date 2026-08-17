// Local HTTP server for interactive exploration of the userscript
// examples in tests/examples/.
//
// Why we need our own script instead of `pnpm dlx http-server`: the
// `headers-run-at` example deliberately pulls in a sync script from
// `/__slow/blocker.js?ms=400`, a route that holds the response for
// 400ms before answering. The parser blocks at `readyState=loading`
// for the duration of that fetch, which is what lets document-start
// userscripts inject during the loading phase and gives each
// @run-at variant a distinct lifecycle window. A static-file server
// doesn't know about that route and just 404s, collapsing the demo.
//
// Behaviour: serve tests/examples/ as the document root, plus the
// special `/__slow/<filename>?ms=N` route from
// tests/fixtures/slow-route.mjs (shared with the Playwright fixture
// server so the two stay in lockstep).
//
// Run: node scripts/serve-examples.mjs [--port 8080]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_TYPES, handleSlowRoute } from '../tests/fixtures/slow-route.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(__dirname, '..', 'tests', 'examples');

const portFlag = process.argv.indexOf('--port');
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 8080;

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (handleSlowRoute(url, res)) return;
    const name = url.pathname.replace(/^\//, '') || 'index.html';
    const filePath = path.join(examplesDir, name);
    const rel = path.relative(examplesDir, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.end(fs.readFileSync(filePath));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving tests/examples/ on http://127.0.0.1:${port}/`);
  console.log(`  /__slow/<file>?ms=N delays the response by N ms (max 5000).`);
});
