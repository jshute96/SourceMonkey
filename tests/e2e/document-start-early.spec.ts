// A `document-start` script runs ahead of the page's first inline
// <script>, by skipping the check-pending round trip where its answer
// can only be `run` (`canSkipDecision` in userscript-prelude.js). In a
// browser sm-dev marks, that takes a claimed tab vouching for the
// script's run (the skips there are sm-dev-claims.spec.ts's).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir, renderUserscript } from '../fixtures/scripts-dir';
import { activeTabId } from '../fixtures/sw-api';
import { SM_DEV_MARKERS } from '../../lib/sm-dev-protocol.js';

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

});

test.describe('document-start runs before the page, in an sm-dev browser', () => {
  test.beforeEach(({ smDevMarked }) => smDevMarked);

  test('a run\'s own script, in a tab vouching for its run', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/blank.html`);
    await sm.claimTab(await activeTabId(getServiceWorker), 'R1', 60_000);
    // The marker a run puts in its claimed tab (`setVouch` in
    // src/harness/extension-link.ts).
    const cdp = await extensionContext.newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.addEventListener(${JSON.stringify(`${SM_DEV_MARKERS.vouchPrefix}R1`)}, (e) => e.preventDefault());`,
      worldName: 'sourcemonkey-sm-dev',
    });
    const pushed = await sm.writeRunScript({
      run: 'R1',
      text: renderUserscript({
        relativePath: 'early.user.js',
        meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start', grant: ['none'] },
        body: `document.documentElement.dataset.early = 'script';`,
      }),
    });
    expect(pushed.status).toBe('ok');
    for (let i = 0; i < 3; i++) {
      await page.goto(`${fixtureServer.baseUrl}/early-inline.html?n=${i}`);
      expect(await page.evaluate(() => document.documentElement.dataset.pageSaw)).toBe('script');
    }
    await cdp.detach();
    await sm.releaseRun('R1');
  });
});
