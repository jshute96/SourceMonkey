// End-to-end tests for the DEFAULT `@connect` policy — what happens
// to a script that declares no `@connect` at all, which is how 137 of
// the 346 `GM_xmlhttpRequest` scripts in the GreasyFork top-2000
// corpus are written.
//
// The rules under test (see
// docs/GM-APIs.md#connect-url-gating-phase-10):
//   - A request to the page's OWN origin always goes through, with or
//     without `@connect`. The page could issue it itself.
//   - Cross-origin with no `@connect` is denied, and the denial is
//     visible: `onerror` gets the reason, and the script's Log tab
//     gets a warning naming the host and the header line to add.
//
// The fixture server and the data server are both on 127.0.0.1 but on
// different ports, so "the data server" is genuinely cross-origin to
// the page while staying reachable in CI.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';
import { waitFor } from '../fixtures/sw-api';

test.describe('GM_xmlhttpRequest default @connect policy', () => {
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

  test('no @connect: a request to the page\'s own origin is allowed', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'SameOriginNoConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        // NO connect — the point of the test.
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${fixtureServer.baseUrl}/other.html',
          onload: (res) => { document.body.dataset.smStatus = String(res.status); },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    expect(await page.locator('body').getAttribute('data-sm-err')).toBeNull();
    await page.close();
  });

  test('no @connect: a page-relative URL resolves and is allowed', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // `GM_xmlhttpRequest({url: '/other.html'})` is relative to the
    // PAGE, not to the service worker. Without resolving it against
    // the sender's document the SW's `new URL(url)` throws and the
    // script gets "invalid URL" — a shape that works in TM/VM.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'RelativeNoConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '/other.html',
          onload: (res) => {
            document.body.dataset.smStatus = String(res.status);
            document.body.dataset.smFinal = res.finalUrl;
          },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    // Resolved against the page, so the script sees the absolute URL
    // it would have got from any other manager.
    await expect(page.locator('body')).toHaveAttribute(
      'data-sm-final', `${fixtureServer.baseUrl}/other.html`);
    await page.close();
  });

  test('a declared @connect does not cost the script its own origin', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // TM made `self` implicit in 4.0 (Tampermonkey/tampermonkey#283)
    // precisely because the opposite is a trap: declaring the one API
    // host you call would otherwise silently break every same-origin
    // call in the same script.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DeclaredElsewhere',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['api.example.com'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${fixtureServer.baseUrl}/other.html',
          onload: (res) => { document.body.dataset.smStatus = String(res.status); },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    await page.close();
  });

  test('no @connect: a cross-origin request is denied, and the Log says why', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/x', 'secret', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CrossOriginNoConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/x',
          onload: (res) => { document.body.dataset.smLeaked = res.responseText; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const scriptId = collections.find((s) => s.id === added!.id)!.scriptIds[0];

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // The script's own error handler is told what happened...
    await expect(page.locator('body')).toHaveAttribute(
      'data-sm-err', /blocked because this script declares no @connect/,
    );
    expect(await page.locator('body').getAttribute('data-sm-leaked')).toBeNull();

    // ...and so is anyone reading the script's Log tab, who may not be
    // the person who wrote it.
    const log = await waitFor(
      () => sm.getScriptLog(scriptId),
      (entries) => entries.some((e) => e.source === 'gm-xhr'),
      { label: 'a gm-xhr policy entry' },
    );
    const rows = log.filter((e) => e.source === 'gm-xhr');
    expect(rows.length).toBe(1);
    expect(rows[0].level).toBe('warning');
    expect(rows[0].message).toContain('blocked because this script declares no @connect');
    expect(rows[0].message).toContain('@connect 127.0.0.1');
    // Identified by origin + path — no query string, which is where
    // tokens live.
    expect(rows[0].message).toContain(`${dataServer.baseUrl}/x`);
    expect(typeof rows[0].tabId).toBe('number');
    await page.close();
  });

  test('a redirect denial is logged too, marked as the post-redirect hop', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The initial host is allowed; the 302 target is not. The script
    // hears about it (covered in gm-connect.spec.ts) — here we check
    // the Log names the hop, so the entry doesn't read as if the
    // script had asked for the redirect target directly.
    const blockedHost = dataServer.baseUrl.replace('127.0.0.1', 'localhost');
    dataServer.setRoute('/secret', 'leaked', { contentType: 'text/plain' });
    dataServer.setRedirect('/redirect', `${blockedHost}/secret`);
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'RedirectDenial',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/redirect',
          onload: (res) => { document.body.dataset.smLeaked = res.responseText; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const scriptId = collections.find((s) => s.id === added!.id)!.scriptIds[0];

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /redirect to .* not allowed/);
    expect(await page.locator('body').getAttribute('data-sm-leaked')).toBeNull();

    const log = await waitFor(
      () => sm.getScriptLog(scriptId),
      (entries) => entries.some((e) => e.source === 'gm-xhr'),
      { label: 'a gm-xhr redirect entry' },
    );
    const rows = log.filter((e) => e.source === 'gm-xhr');
    expect(rows.length).toBe(1);
    expect(rows[0].level).toBe('warning');
    expect(rows[0].message).toContain('(after redirect)');
    expect(rows[0].message).toContain('not in @connect allowlist');
    await page.close();
  });

  test('repeated denials on one host are logged once, whatever the path', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // A polling script re-issues blocked requests forever, often
    // walking a whole URL space on the same host. The log has a fixed
    // cap, and a second copy of the same verdict says nothing the
    // first didn't — so the dedupe key is the target ORIGIN, not the
    // full path. Three different paths here, to pin exactly that.
    dataServer.setRoute('/a', 'secret', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'RepeatedDenial',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        let done = 0;
        const fire = (path) => GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}' + path,
          onerror: () => { document.body.dataset.smErrCount = String(++done); },
        });
        fire('/a'); fire('/b'); fire('/c');
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const scriptId = collections.find((s) => s.id === added!.id)!.scriptIds[0];

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // All three requests get their own onerror — the dedupe is about
    // the Log, never about what the script is told.
    await expect(page.locator('body')).toHaveAttribute('data-sm-err-count', '3');
    await waitFor(
      () => sm.getScriptLog(scriptId),
      (entries) => entries.some((e) => e.source === 'gm-xhr'),
      { label: 'a gm-xhr policy entry' },
    );
    // Re-read after a settle: `logScriptEvent` is fire-and-forget
    // through a serialized queue, so asserting on the snapshot that
    // carried the FIRST entry would pass even with no dedupe at all.
    await new Promise((r) => setTimeout(r, 250));
    const settled = await sm.getScriptLog(scriptId);
    expect(settled.filter((e) => e.source === 'gm-xhr').length).toBe(1);
    await page.close();
  });
});
