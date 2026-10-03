// A `fetch()` made by a DOCUMENT hands that document the response's
// `Link: <…>; rel=preload; as=script` header, and Chrome tries to
// preload the named script INTO that document. Our pages are extension
// pages (`script-src 'self'`), so the preload is refused — and the
// refusal is filed under chrome://extensions/?errors, where it is
// uncatchable and reads as SourceMonkey being broken rather than a site
// sending hints we never asked for.
//
// Nothing exotic triggers it: sites that preload their bundles send the
// header on every page, and we fetch site HTML (the site-icon probe)
// and arbitrary script URLs (Add / Refresh / the install preview) from
// pages.
//
// The fix is to make those reads from the service worker, which has no
// document for the hints to apply to (`src/http-read.ts`). Asserted on
// the request itself — the preload either happens or it doesn't — for
// both page-side readers, plus the worker as a control.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { test, expect } from '../fixtures/extension';

const PRELOADED_SCRIPT = 'https://web-assets.example.com/preloaded.js';

// A server that answers with a preload hint on every response —
// exactly the shape a site with a bundled front end sends. `/page.html`
// is HTML (what the icon probe reads); `/main.user.js` is a real
// userscript (what Add / Refresh reads).
async function startHintingServer(): Promise<{ base: string; stop: () => Promise<void> }> {
  const script = [
    '// ==UserScript==',
    '// @name        Hinted',
    '// @match       https://example.com/*',
    '// ==/UserScript==',
    'void 0;',
    '',
  ].join('\n');
  const server = http.createServer((req, res) => {
    const isScript = (req.url ?? '').includes('.user.js');
    res.writeHead(200, {
      'content-type': isScript ? 'text/javascript' : 'text/html',
      link: `<${PRELOADED_SCRIPT}>; rel=preload; as=script`,
    });
    res.end(isScript
      ? script
      : '<!doctype html><html><head><link rel="icon" href="/favicon.ico"></head><body>hi</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe('preload hints on fetched responses', () => {
  // Context-level, so it catches the preload whichever context would
  // have made it — a page or the service worker.
  function watchPreloads(context: { on: (e: 'request', cb: (r: { url(): string }) => void) => void }): string[] {
    const seen: string[] = [];
    context.on('request', (r) => {
      if (r.url().startsWith('https://web-assets.example.com/')) seen.push(r.url());
    });
    return seen;
  }

  test('a page-side resource read (site-icon probe) acts on no preload hint', async ({
    extensionContext, extensionId,
  }) => {
    const server = await startHintingServer();
    try {
      const preloads = watchPreloads(extensionContext);
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      // Through the production fetcher the site-icon probe uses, so
      // this is the real path and not a hand-rolled `fetch`.
      const bytes = await page.evaluate(async (url) => {
        // Specifier through a variable: this runs in the page, where
        // the module sits next to collections.html, but the test file
        // is compiled from tests/ where that path means nothing.
        const spec = './file-loader.js';
        const mod = await import(spec) as {
          fetchResourceBytes: (u: string, o: { maxBytes: number }) =>
            Promise<{ failed?: true; body?: ArrayBuffer }>;
        };
        const got = await mod.fetchResourceBytes(url, { maxBytes: 1_000_000 });
        return got.failed ? -1 : got.body!.byteLength;
      }, `${server.base}/page.html`);

      expect(bytes).toBeGreaterThan(0);
      expect(preloads).toEqual([]);
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('a page-side script read (Add / Refresh) acts on no preload hint', async ({
    extensionContext, extensionId,
  }) => {
    // The other page-side reader, and the likelier one in practice: a
    // refresh that lands on a login page is both the case `fetchHttpText`
    // has a branch for and the kind of response that carries hints.
    const server = await startHintingServer();
    try {
      const preloads = watchPreloads(extensionContext);
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const len = await page.evaluate(async (url) => {
        const spec = './extension/directories.js';
        const mod = await import(spec) as {
          fetchHttpText: (u: string) => Promise<{ kind: string; text?: string }>;
        };
        const got = await mod.fetchHttpText(url);
        return got.text?.length ?? -1;
      }, `${server.base}/main.user.js`);

      expect(len).toBeGreaterThan(0);
      expect(preloads).toEqual([]);
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('the same read from the service worker acts on no preload hint either', async ({
    extensionContext, getServiceWorker,
  }) => {
    // The control: if a worker fetch DID process the hint, the tests
    // above would be passing for some incidental reason rather than
    // because the document is out of the loop.
    const server = await startHintingServer();
    try {
      const preloads = watchPreloads(extensionContext);
      const sw = await getServiceWorker();
      // A bare `fetch`, because `import()` is disallowed in a service
      // worker — and it is the same call the hop's handler makes, so
      // what's under test is the context, which is the point.
      const bytes = await sw.evaluate(async (url) => {
        const res = await fetch(url, { cache: 'no-store' });
        return (await res.arrayBuffer()).byteLength;
      }, `${server.base}/page.html`);
      expect(bytes).toBeGreaterThan(0);
      expect(preloads).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});
