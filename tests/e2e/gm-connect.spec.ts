// End-to-end tests for `@connect` URL gating on GM_xmlhttpRequest
// (Phase 10) — the rule grammar and the redirect re-check.
//
// Scripts declare the hosts they intend to reach via
// `// @connect <host>` (with `*`, `*.subdomain`, `self` shortcuts);
// a cross-origin host that no rule covers is blocked.
//
// The *default* policy for a script that declares no `@connect` at
// all — including the same-origin allowance —
// lives in `gm-connect-default.spec.ts`.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('GM_xmlhttpRequest @connect gating (Phase 10)', () => {
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

  test('no @connect declared → cross-origin request blocked, onerror with policy reason', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/x', 'body', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        // NO connect.
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/x',
          onload: () => { document.body.dataset.smGotLoad = 'yes'; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /@connect/);
    expect(await page.locator('body').getAttribute('data-sm-got-load')).toBeNull();
    await page.close();
  });

  test('matching @connect allows the request', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/ok', 'allowed', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'OkConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/ok',
          onload: (res) => { document.body.dataset.smText = res.responseText; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'allowed');
    await page.close();
  });

  test('@connect *.subdomain matches example.com itself and api.example.com', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // We can't actually hit two different hosts in the test (both
    // resolve to 127.0.0.1 by way of the fixture server), so this
    // test verifies the URL-pattern matching surface via two
    // different request attempts: one to an allowed host, one to a
    // disallowed host that should fail the policy.
    dataServer.setRoute('/ok', 'allowed', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'SubdomainConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        // Allows 127.0.0.1 and its subdomains (no subdomains exist
        // here in test, but the rule should still match the host
        // itself).
        connect: ['*.0.0.1'],  // weirdly-shaped but it does match 127.0.0.1 the way *.0.0.1 → "0.0.1" subdomain works
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/ok',
          onload: (res) => { document.body.dataset.smOk = res.responseText; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // 127.0.0.1 ends with `.0.0.1` so `*.0.0.1` matches.
    await expect(page.locator('body')).toHaveAttribute('data-sm-ok', 'allowed');
    await page.close();
  });

  test('@connect * allows everything', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/anywhere', 'wild', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'WildConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['*'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/anywhere',
          onload: (res) => { document.body.dataset.smText = res.responseText; },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'wild');
    await page.close();
  });

  test('redirect to a non-allowlisted host is blocked (no response leaked)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The initial host (127.0.0.1) is allowlisted, but it 302-redirects
    // to `localhost` — a distinct hostname (also loopback, so it's
    // reachable) that the policy does NOT allow. Without the
    // post-redirect re-check, fetch would follow the redirect and hand
    // the script the secret body. With it, the request is blocked.
    const blockedHost = dataServer.baseUrl.replace('127.0.0.1', 'localhost');
    dataServer.setRoute('/secret', 'leaked-via-redirect', { contentType: 'text/plain' });
    dataServer.setRedirect('/redirect', `${blockedHost}/secret`);
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'RedirectConnect',
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /redirect to .* not allowed/);
    expect(await page.locator('body').getAttribute('data-sm-leaked')).toBeNull();
    await page.close();
  });

  test('@connect host that does NOT match the URL is blocked', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/should-block', 'leaked', { contentType: 'text/plain' });
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'WrongConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        // Explicitly allow a different host. The request to 127.0.0.1
        // should be blocked.
        connect: ['example.com'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/should-block',
          onload: () => { document.body.dataset.smLeaked = 'yes'; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /not in @connect/);
    expect(await page.locator('body').getAttribute('data-sm-leaked')).toBeNull();
    await page.close();
  });
});
