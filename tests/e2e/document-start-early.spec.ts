// A `document-start` script runs ahead of the page's first inline
// <script>, by skipping the check-pending round trip where its answer
// can only be `run` (`canSkipDecision` in userscript-prelude.js). Where
// it can't, the script still asks: a reload, and while an sm-dev claim
// is live (whose skips sm-dev-claims.spec.ts covers).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId } from '../fixtures/sw-api';

test.describe('document-start runs before the page', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  for (const grant of [['none'], ['GM_info']]) {
    test(`ahead of an inline head script (@grant ${grant[0]})`, async ({ extensionContext, fixtureServer, sm }) => {
      scriptsDir.write({
        relativePath: 'early.user.js',
        meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start', grant },
        body: `document.documentElement.dataset.early = 'script';`,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();
      const page = await extensionContext.newPage();
      // Several loads: the race this guards against is timing-dependent.
      for (let i = 0; i < 3; i++) {
        await page.goto(`${fixtureServer.baseUrl}/early-inline.html?n=${i}`);
        expect(await page.evaluate(() => document.documentElement.dataset.pageSaw)).toBe('script');
      }
    });
  }

  test('a live sm-dev claim makes every script ask, until it ends', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'early.user.js',
      meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start', grant: ['none'] },
      body: `document.documentElement.dataset.early = 'script';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/blank.html`);
    const tabId = await activeTabId(getServiceWorker);
    const flag = (): Promise<boolean> => getServiceWorker().then((sw) => sw.evaluate(async () => {
      const got = await chrome.userScripts.getScripts();
      return got.some((s) => s.js.some((j) => (j.code ?? '').includes('"mustAsk":true')));
    }));
    expect(await flag()).toBe(false);
    await sm.claimTab(tabId, 'R1', 60_000);
    expect(await flag()).toBe(true);
    await sm.releaseRun('R1');
    await expect.poll(flag).toBe(false);
  });
});
