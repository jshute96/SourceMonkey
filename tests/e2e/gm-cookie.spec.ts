// End-to-end tests for GM_cookie / GM.cookie: list, set and delete
// against Chrome's real cookie jar, the @match check on the target URL,
// httpOnly cookies staying hidden, and both worlds (the page's world,
// where calls go over the bridge, and the isolated one).
//
// `extensionContext` is worker-scoped and `resetAllState` doesn't touch
// the cookie jar, so each test clears it afterwards.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Where a script puts its outcome for the test to read.
async function result(page: Page): Promise<unknown> {
  await expect(page.locator('body')).toHaveAttribute('data-sm-result', /.+/);
  return JSON.parse((await page.locator('body').getAttribute('data-sm-result'))!);
}

const REPORT = `
  const report = (v) => { document.body.dataset.smResult = JSON.stringify(v); };
  const fail = (e) => report({ error: String(e && e.message || e) });
`;

test.describe('GM_cookie', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(async ({ extensionContext }) => {
    scriptsDir.cleanup();
    await extensionContext.clearCookies();
  });

  for (const injectInto of [undefined, 'content'] as const) {
    test(`GM.cookie set, list and delete round-trip (${injectInto ?? 'page world'})`, async ({
      extensionContext, fixtureServer, sm,
    }) => {
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: {
          name: 'CookieRoundTrip',
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          grant: ['GM.cookie'],
          ...(injectInto ? { injectInto } : {}),
        },
        body: `${REPORT}
          (async () => {
            await GM.cookie.set({ name: 'sm_a', value: 'one' });
            const listed = await GM.cookie.list({ name: 'sm_a' });
            const seenByPage = document.cookie;
            await GM.cookie.delete({ name: 'sm_a' });
            const after = await GM.cookie.list({ name: 'sm_a' });
            report({ listed: listed.map((c) => [c.name, c.value, c.httpOnly]), seenByPage, after: after.length });
          })().catch(fail);
        `,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      expect(await result(page)).toEqual({ listed: [['sm_a', 'one', false]], seenByPage: 'sm_a=one', after: 0 });
      await page.close();
    });
  }

  test('GM_cookie callbacks, and httpOnly cookies stay hidden', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await extensionContext.addCookies([
      { name: 'sm_plain', value: 'p', url: fixtureServer.baseUrl },
      { name: 'sm_secret', value: 's', url: fixtureServer.baseUrl, httpOnly: true },
    ]);
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CookieCallbacks',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_cookie'],
      },
      body: `${REPORT}
        GM_cookie.list({}, (cookies, error) => {
          GM_cookie.delete({ name: 'sm_secret' }, (delError) => {
            GM_cookie('set', { name: 'sm_secret', value: 'x' }, (setError) => {
              report({ names: cookies.map((c) => c.name), error: error ?? null, delError, setError });
            });
          });
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const hidden = 'Userscripts cannot read or change httpOnly cookies';
    expect(await result(page)).toEqual({ names: ['sm_plain'], error: null, delError: hidden, setError: hidden });
    // The httpOnly cookie is untouched.
    const jar = await extensionContext.cookies(fixtureServer.baseUrl);
    expect(jar.find((c) => c.name === 'sm_secret')?.value).toBe('s');
    await page.close();
  });

  test('a URL outside the script\'s @match is refused', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Same server under another host name the script doesn't match.
    const otherUrl = fixtureServer.baseUrl.replace('127.0.0.1', 'localhost') + '/';
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CookieRefused',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM.cookie'],
      },
      body: `${REPORT}
        GM.cookie.list({ url: ${JSON.stringify(otherUrl)} }).then((c) => report({ ok: c.length }), fail);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    expect(await result(page)).toEqual({
      error: `The script's @match and @include rules must cover the cookie URL ${otherUrl}`,
    });
    await page.close();
  });

  test('without the grant there is no GM_cookie', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CookieUngranted',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `${REPORT}
        report({ legacy: typeof GM_cookie, dot: typeof GM.cookie });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    expect(await result(page)).toEqual({ legacy: 'undefined', dot: 'undefined' });
    await page.close();
  });
});
