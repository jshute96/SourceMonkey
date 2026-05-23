// End-to-end tests for GM_xmlhttpRequest binary path (Phase 9).
//
// responseType: 'blob' | 'arraybuffer' | 'document'. SW serializes
// bytes as base64; page-side runtime decodes and reconstructs the
// right native object (Blob / ArrayBuffer / Document).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('GM_xmlhttpRequest binary path (Phase 9)', () => {
  let scriptsDir: ScriptsDir;
  let dataServer: UserscriptServer;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    dataServer = await UserscriptServer.start();
  });
  test.afterEach(async () => {
    scriptsDir.cleanup();
    await dataServer.stop();
  });

  test('responseType: arraybuffer reconstructs the bytes', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Serve a known byte sequence: 0x00 .. 0xff.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    dataServer.setRoute('/bin', bytes, { contentType: 'application/octet-stream' });

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'BinABuf',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/bin',
          responseType: 'arraybuffer',
          onload: (res) => {
            const buf = res.response;
            const view = new Uint8Array(buf);
            // Sum + first/last byte fingerprint for verification.
            let sum = 0;
            for (let i = 0; i < view.length; i++) sum += view[i];
            document.body.dataset.smLen = String(view.length);
            document.body.dataset.smSum = String(sum);
            document.body.dataset.smFirst = String(view[0]);
            document.body.dataset.smLast = String(view[view.length - 1]);
            document.body.dataset.smType = Object.prototype.toString.call(buf);
          },
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-len', '256');
    // Sum of 0..255 = 32640.
    await expect(page.locator('body')).toHaveAttribute('data-sm-sum', '32640');
    await expect(page.locator('body')).toHaveAttribute('data-sm-first', '0');
    await expect(page.locator('body')).toHaveAttribute('data-sm-last', '255');
    await expect(page.locator('body')).toHaveAttribute('data-sm-type', '[object ArrayBuffer]');
    await page.close();
  });

  test('responseType: blob builds a Blob with the right MIME type', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const bytes = Buffer.from('binary content', 'utf-8');
    dataServer.setRoute('/blob', bytes, { contentType: 'image/png' });

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'BinBlob',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/blob',
          responseType: 'blob',
          onload: async (res) => {
            const b = res.response;
            document.body.dataset.smType = Object.prototype.toString.call(b);
            document.body.dataset.smMime = b.type;
            document.body.dataset.smSize = String(b.size);
            // Read it back so we can verify content survived the round-trip.
            const txt = await b.text();
            document.body.dataset.smText = txt;
          },
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-type', '[object Blob]');
    await expect(page.locator('body')).toHaveAttribute('data-sm-mime', 'image/png');
    await expect(page.locator('body')).toHaveAttribute('data-sm-size', '14');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'binary content');
    await page.close();
  });

  test('responseType: document parses the body as HTML', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const html = '<!doctype html><html><body><div id="hi">hello document</div></body></html>';
    dataServer.setRoute('/doc', html, { contentType: 'text/html' });

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'BinDoc',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/doc',
          responseType: 'document',
          onload: (res) => {
            const doc = res.response;
            document.body.dataset.smType = Object.prototype.toString.call(doc);
            const el = doc && doc.getElementById('hi');
            document.body.dataset.smContent = el ? el.textContent : '<no-hi>';
            // responseText should be populated too (page-side
            // rebuild fills it in for document type).
            document.body.dataset.smText = res.responseText.indexOf('hello document') !== -1 ? 'ok' : 'missing';
          },
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // HTMLDocument toString varies by browser but always contains
    // "Document" or "HTMLDocument".
    await expect(page.locator('body')).toHaveAttribute('data-sm-type', /Document/);
    await expect(page.locator('body')).toHaveAttribute('data-sm-content', 'hello document');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'ok');
    await page.close();
  });
});
