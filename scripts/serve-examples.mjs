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
// special `/__slow/<filename>?ms=N` route. The server itself comes
// from tests/fixtures/slow-route.mjs, shared with the Playwright
// fixture server and the cross-manager sync CLI so all three stay in
// lockstep.
//
// Run: node scripts/serve-examples.mjs [--port 8080]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../tests/fixtures/slow-route.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(__dirname, '..', 'tests', 'examples');

const portFlag = process.argv.indexOf('--port');
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 8080;

const baseUrl = await createStaticServer(examplesDir).listen(port).catch((err) => {
  console.error(`Could not serve tests/examples/ on port ${port}: ${err?.message ?? err}`);
  process.exit(1);
});
console.log(`Serving tests/examples/ on ${baseUrl}/`);
console.log(`  /__slow/<file>?ms=N delays the response by N ms (max 5000).`);
