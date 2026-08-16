// End-to-end tests for GM_xmlhttpRequest credentials.
//
// The SW-side fetch is credentialed by default (TM/VM behavior), so a
// userscript can read another site as the signed-in user; a request
// can opt out with `anonymous: true`.
//
// What each test is worth:
//   - The default case is a *regression guard*, not a proof that
//     `credentials: 'include'` is what sends the cookies. Chrome
//     already attaches them to an extension fetch aimed at a host the
//     extension has permission for, and we hold `<all_urls>`, so this
//     test passes with the option removed too. Pinning the observable
//     behavior is still the point.
//   - The `anonymous` case does fail without the option, and is what
//     actually covers the new capability.
//   - Either way the default case pins the SameSite exemption:
//     Playwright's `addCookies` defaults to `SameSite=Lax` on
//     Chromium, so a cookie arriving at all is Chrome treating the
//     extension's request to a permitted host as same-site.
//
// Cookies ignore ports, so a cookie set for 127.0.0.1 reaches the
// per-test data server on its own port too — which is also why the
// spec clears it afterwards: `extensionContext` is worker-scoped and
// `resetAllState` doesn't touch the cookie jar, so a leftover cookie
// would follow every later test in the same worker.

import type { BrowserContext } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import type { SmApi } from '../fixtures/sw-api';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('GM_xmlhttpRequest credentials', () => {
  let scriptsDir: ScriptsDir;
  let dataServer: UserscriptServer;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    dataServer = await UserscriptServer.start();
  });
  test.afterEach(async ({ extensionContext }) => {
    scriptsDir.cleanup();
    await dataServer.stop();
    await extensionContext.clearCookies();
  });

  // `anonymousArg` is spliced into the details object, so '' exercises
  // the default (credentialed) path and the explicit opt-out the other.
  async function runFetch(
    opts: {
      extensionContext: BrowserContext;
      fixtureServerUrl: string;
      sm: SmApi;
      anonymousArg: string;
    },
  ): Promise<void> {
    dataServer.setRoute('/whoami', 'ok', { contentType: 'text/plain; charset=utf-8' });
    await opts.extensionContext.addCookies([
      {
        name: 'sm_session',
        value: 'secret-token',
        url: dataServer.baseUrl,
      },
    ]);
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Creds',
        match: [`${opts.fixtureServerUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        GM_xmlhttpRequest({
          method: 'GET',
          url: '${dataServer.baseUrl}/whoami',
          ${opts.anonymousArg}
          onload: (res) => { document.body.dataset.smStatus = String(res.status); },
          onerror: (e) => { document.body.dataset.smError = String(e && e.error || e); },
        });
      `,
    });
    await opts.sm.addCollection(scriptsDir.path);
    await opts.sm.syncNow();

    const page = await opts.extensionContext.newPage();
    await page.goto(`${opts.fixtureServerUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    await page.close();
  }

  test('sends the user cookies by default', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    await runFetch({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      anonymousArg: '',
    });
    const entry = dataServer.requestLog.find((e) => e.path === '/whoami');
    expect(entry?.cookie).toContain('sm_session=secret-token');
  });

  test('anonymous: true withholds them', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    await runFetch({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      anonymousArg: 'anonymous: true,',
    });
    const entry = dataServer.requestLog.find((e) => e.path === '/whoami');
    // Assert the request happened before asserting what it lacked —
    // otherwise a missing entry would read as "no cookie sent".
    expect(entry).toBeDefined();
    expect(entry?.cookie).toBeUndefined();
  });

  // TM/VM read `anonymous` as a truthy flag, so a script ported from
  // either can pass a non-boolean. Withholding the cookies is the safe
  // reading of an ambiguous opt-out.
  test('a truthy anonymous also withholds them', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    await runFetch({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      anonymousArg: 'anonymous: 1,',
    });
    const entry = dataServer.requestLog.find((e) => e.path === '/whoami');
    expect(entry).toBeDefined();
    expect(entry?.cookie).toBeUndefined();
  });
});
