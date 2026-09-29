#!/usr/bin/env node
// Serve results.html and corpus.json over http on localhost, so the page can
// read corpus.json itself. (Opened as a file:// page, Chrome won't let it
// fetch, and it has to ask you to pick the file.)
//
// Usage:
//   node tests/greasyfork-examples/serve-results.mjs [--port N]
//
//   --port N   port to listen on (default 8765)
//
// Serves only those two files, read fresh on every request, so reloading the
// page shows results recorded since. Listens on 127.0.0.1 only.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FILES = {
  '/results.html': { file: 'results.html', type: 'text/html; charset=utf-8' },
  '/corpus.json': { file: 'corpus.json', type: 'application/json; charset=utf-8' },
};
FILES['/'] = FILES['/results.html'];

function parseArgs(argv) {
  const opts = { port: 8765 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) opts.port = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('The --port option must be a port number');
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
const server = createServer(async (req, res) => {
  const entry = FILES[new URL(req.url, 'http://localhost').pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  try {
    const body = await readFile(fileURLToPath(new URL(entry.file, import.meta.url)));
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`Could not read ${entry.file}: ${err.message}`);
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
