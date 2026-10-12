// A page restored from the back/forward cache sees GM values written
// while it was cached. It hears no broadcasts while cached, so the
// runtime resyncs on a restore (docs/GM-APIs-storage.md, "Resync").

import { expect, testWithBackForwardCache as test } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForGmValues } from '../fixtures/sw-api';

test.describe('GM values across the back/forward cache', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('a restored page reads a value written while it was cached', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Reports its cached `shared` value every 50 ms; on `?write=`, writes
    // that value first.
    scriptsDir.write({
      relativePath: 'bf.user.js',
      meta: {
        name: 'BfCache',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        const write = new URLSearchParams(location.search).get('write');
        if (write) GM_setValue('shared', write);
        setInterval(() => {
          document.body.dataset.smValue = String(GM_getValue('shared', '_NONE_'));
        }, 50);
        window.addEventListener('pageshow', (e) => {
          if (e.persisted) document.body.dataset.smRestored = '1';
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html?write=first`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-value', 'first');
    await waitForGmValues(sm, (v) => v.shared === 'first', 'shared = first');

    await page.goto(`${fixtureServer.baseUrl}/target.html?write=second`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-value', 'second');
    await waitForGmValues(sm, (v) => v.shared === 'second', 'shared = second');

    // From the page itself: Playwright's `goBack` loses track of a page
    // restored from the cache.
    await page.evaluate(() => history.back());
    // Only meaningful if the first page really came back from the cache.
    await expect(page.locator('body')).toHaveAttribute('data-sm-restored', '1');
    await expect(page.locator('body')).toHaveAttribute('data-sm-value', 'second');
    await page.close();
  });
});
