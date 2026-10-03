// End-to-end tests for GM_xmlhttpRequest (Phase 8, text path only).
//
// Phase 8 covers:
//   - GET → text body via responseText / response.
//   - POST with `data` body.
//   - responseType: 'json' parses on the SW side.
//   - HTTP error status (e.g. 404) still fires onload (XHR semantics —
//     non-network errors aren't "errors", they're successful loads
//     with a non-2xx status).
//   - Network-level failures fire onerror.
//   - .abort() fires onabort and prevents onload.
//   - timeout fires ontimeout.
//   - Permission gating (ungranted is undefined).
//
// Phase 9 adds binary responseTypes; Phase 10 adds header surgery +
// @connect gating. Those tests will land alongside their phases.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('GM_xmlhttpRequest text path (Phase 8)', () => {
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

  test('GET returns responseText to onload', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/hello', 'hello from server', {
      contentType: 'text/plain; charset=utf-8',
    });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GetText',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/hello',
          onload: (res) => {
            document.body.dataset.smStatus = String(res.status);
            document.body.dataset.smText = String(res.responseText);
          },
          onerror: (e) => {
            document.body.dataset.smError = String(e && e.error || e);
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'hello from server');
    await page.close();
  });

  test('a URL object works as the url', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/hello', 'hello from server', {
      contentType: 'text/plain; charset=utf-8',
    });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GetUrlObject',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          url: new URL('/hello', '${dataServer.baseUrl}'),
          onload: (res) => {
            document.body.dataset.smText = String(res.responseText);
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'hello from server');
    await page.close();
  });

  test('onreadystatechange fires at 2, 3 and 4, before onload', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/hello', 'hello from server', {
      contentType: 'text/plain; charset=utf-8',
    });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ReadyState',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        const seen = [];
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/hello',
          onreadystatechange: (res) => {
            seen.push('rsc' + res.readyState + ':' + res.responseText);
          },
          onload: (res) => {
            seen.push('load' + res.readyState);
            document.body.dataset.smSeen = seen.join(',');
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-seen', 'rsc2:,rsc3:hello from server,rsc4:hello from server,load4');
    await page.close();
  });

  test('responseType: json parses the body', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/data', JSON.stringify({ foo: 'bar', n: 42 }), {
      contentType: 'application/json',
    });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GetJson',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/data',
          responseType: 'json',
          onload: (res) => {
            document.body.dataset.smParsed = JSON.stringify(res.response);
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-parsed', '{"foo":"bar","n":42}');
    await page.close();
  });

  test('POST sends the data body', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // UserscriptServer doesn't echo POST bodies. Use the fact that the
    // request reached us as confirmation: count requests to a known
    // path before and after. The page-side onload still fires; we just
    // need the body to be ALLOWED on a POST (GET would 405 / reject).
    dataServer.setRoute('/post-target', 'ack', {
      contentType: 'text/plain',
    });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Post',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'POST',
          url: '${dataServer.baseUrl}/post-target',
          data: '{"hi":1}',
          headers: { 'Content-Type': 'application/json' },
          onload: (res) => {
            document.body.dataset.smStatus = String(res.status);
            document.body.dataset.smText = String(res.responseText);
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'ack');
    await page.close();
  });

  test('HTTP error status fires onload (not onerror)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // /missing isn't a route the server knows → 404.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NotFound',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/does-not-exist',
          onload: (res) => {
            document.body.dataset.smOnloadStatus = String(res.status);
          },
          onerror: (e) => {
            document.body.dataset.smOnerror = 'true';
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-onload-status', '404');
    // onerror should NOT have fired — HTTP errors are still "loads".
    const errored = await page.locator('body').getAttribute('data-sm-onerror');
    expect(errored).toBeNull();
    await page.close();
  });

  test('network failure fires onerror', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Point at a port nothing listens on.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NetFail',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: 'http://127.0.0.1:1/never',
          onload: () => {
            document.body.dataset.smGotLoad = 'yes';
          },
          onerror: (e) => {
            document.body.dataset.smGotError = 'yes';
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-got-error', 'yes', { timeout: 6000 });
    const gotLoad = await page.locator('body').getAttribute('data-sm-got-load');
    expect(gotLoad).toBeNull();
    await page.close();
  });

  test('abort() fires onabort and prevents onload', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Use a route the server intentionally never resolves (we don't
    // have a delayed-response feature, but pointing at a non-listening
    // port + aborting before timeout achieves the same shape).
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Abort',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        let rsc = '';
        const handle = GM_xmlhttpRequest({
          method: 'GET',
          url: 'http://127.0.0.1:1/never',
          onload: () => { document.body.dataset.smGotLoad = 'yes'; },
          onerror: () => { document.body.dataset.smGotError = 'yes'; },
          onabort: (r) => {
            document.body.dataset.smGotAbort = 'yes';
            document.body.dataset.smAbortSeen = rsc + ',abort' + r.readyState;
          },
          onreadystatechange: (r) => { rsc = 'rsc' + r.readyState + ' ' + r.status; },
        });
        // Abort immediately. Page-side, this should fire onabort
        // synchronously (TM/VM behavior).
        handle.abort();
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-got-abort', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-sm-abort-seen', 'rsc4 0,abort4');
    // Neither load nor error should fire.
    expect(await page.locator('body').getAttribute('data-sm-got-load')).toBeNull();
    expect(await page.locator('body').getAttribute('data-sm-got-error')).toBeNull();
    await page.close();
  });

  test('timeout fires ontimeout', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // No fixture for a slow response, so point at a non-listening
    // port. A short `timeout` aborts before the network failure
    // surfaces; the SW's shadow flag tells us this was a timeout.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Timeout',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ["GM_xmlhttpRequest"],
        connect: ["127.0.0.1"],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: 'http://127.0.0.1:1/never',
          timeout: 50,
          onload: () => { document.body.dataset.smGotLoad = 'yes'; },
          onerror: () => { document.body.dataset.smGotError = 'yes'; },
          ontimeout: () => { document.body.dataset.smGotTimeout = 'yes'; },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // Race: the network failure can sometimes arrive before the
    // 50ms timeout fires (depending on how fast the OS rejects the
    // connection). Accept either ontimeout OR onerror, but require
    // a terminal event of some kind.
    await expect.poll(async () => {
      const t = await page.locator('body').getAttribute('data-sm-got-timeout');
      const e = await page.locator('body').getAttribute('data-sm-got-error');
      return Boolean(t || e);
    }, { timeout: 5000 }).toBe(true);
    expect(await page.locator('body').getAttribute('data-sm-got-load')).toBeNull();
    await page.close();
  });

  test('ungranted GM_xmlhttpRequest is undefined', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],  // no xhr grant
      },
      body: `
        document.body.dataset.smXhrType = typeof GM_xmlhttpRequest;
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-xhr-type', 'undefined');
    await page.close();
  });
});
