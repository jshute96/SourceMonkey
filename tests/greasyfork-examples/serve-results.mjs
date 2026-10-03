#!/usr/bin/env node
// Serve the results page (results.html) on localhost, with the corpus.json it
// reads and the downloaded scripts in files/ that its viewer shows. Opened as
// a file:// page instead, Chrome won't let it fetch, so it has to ask you to
// pick the files.
//
// Usage:
//   node tests/greasyfork-examples/serve-results.mjs [--port N]
//
//   --port N   port to listen on (default 8765)
//
// Everything is read fresh on every request, so reloading the page shows
// results recorded since. Listens on 127.0.0.1 only. Any other static server
// for this folder works too; this one just needs no setup.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printHelp } from './corpus.mjs';

const FILES = {
  '/results.html': { file: 'results.html', type: 'text/html; charset=utf-8' },
  '/corpus.json': { file: 'corpus.json', type: 'application/json; charset=utf-8' },
};
FILES['/'] = FILES['/results.html'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'files');

/** The body and type for a path other than the two page files, or null for a 404. */
async function dynamicResponse(pathname) {
  if (!pathname.startsWith('/files/')) return null;
  // Each URL part decodes to the name on disk, which keeps its own
  // percent-encoding (`%20`, sent as `%2520`).
  let parts;
  try {
    parts = pathname.slice('/files/'.length).split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  const file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep) || parts.some((p) => p === '..' || p.includes('/'))) return null;
  const body = await readFile(file).catch((err) => {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  });
  return body && { body, type: 'text/plain; charset=utf-8' };
}

function parseArgs(argv) {
  const opts = { port: 8765 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) opts.port = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('The --port option must be a port number');
  return opts;
}

if (printHelp(process.argv.slice(2), import.meta.url)) process.exit(0);
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const entry = FILES[pathname];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  try {
    const found = entry
      ? { body: await readFile(path.join(HERE, entry.file)), type: entry.type }
      : await dynamicResponse(pathname);
    if (!found) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': found.type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : found.body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`Could not read ${entry?.file ?? pathname}: ${err.message}`);
  }
});
server.on('error', (err) => {
  process.stderr.write(err.code === 'EADDRINUSE'
    ? `Port ${opts.port} is already in use. Pass --port to pick another.\n`
    : `${err.message}\n`);
  process.exitCode = 1;
});
server.listen(opts.port, '127.0.0.1', () => {
  console.info(`Serving results at http://localhost:${opts.port}/  (Ctrl+C to stop)`);
});
