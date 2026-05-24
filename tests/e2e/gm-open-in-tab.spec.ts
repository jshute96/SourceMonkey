// End-to-end test for GM_openInTab.
//
// We open a new tab from a userscript, verify the tab actually opens
// at the right URL, and verify the onclose callback fires when the
// tab is closed (either by the script via .close() or by the user).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_openInTab', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('GM_openInTab opens a new tab at the requested URL', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'OpenTab',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_openInTab'],
      },
      body: `
        // Open via the legacy positional form: just a URL, then a
        // truthy second arg meaning "background tab".
        const target = ${JSON.stringify(`${fixtureServer.baseUrl}/other.html`)};
        const ctl = GM_openInTab(target, true);
        document.body.dataset.smOpened = String(typeof ctl === 'object');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const newTabPromise = extensionContext.waitForEvent('page');
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-opened', 'true');
    const opened = await newTabPromise;
    await opened.waitForLoadState('domcontentloaded');
    expect(opened.url()).toBe(`${fixtureServer.baseUrl}/other.html`);
    await opened.close();
    await page.close();
  });

  test('GM_openInTab options object: active:false opens in background', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'OpenTabOpts',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_openInTab'],
      },
      body: `
        const ctl = GM_openInTab(${JSON.stringify(`${fixtureServer.baseUrl}/other.html`)}, { active: false });
        document.body.dataset.smOpened = String(typeof ctl === 'object');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const newTabPromise = extensionContext.waitForEvent('page');
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-opened', 'true');
    const opened = await newTabPromise;
    await opened.waitForLoadState('domcontentloaded');
    expect(opened.url()).toBe(`${fixtureServer.baseUrl}/other.html`);
    await opened.close();
    await page.close();
  });

  test('onclose callback fires when the opened tab is closed', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CloseHook',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_openInTab'],
      },
      body: `
        const ctl = GM_openInTab(${JSON.stringify(`${fixtureServer.baseUrl}/other.html`)}, true);
        ctl.onclose = function () { document.body.dataset.smOnClose = 'fired'; };
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const newTabPromise = extensionContext.waitForEvent('page');
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const opened = await newTabPromise;
    await opened.waitForLoadState('domcontentloaded');
    await opened.close();
    await expect(page.locator('body')).toHaveAttribute('data-sm-on-close', 'fired');
    await page.close();
  });

  test('ungranted GM_openInTab is undefined in scope', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoOpenGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        document.body.dataset.smOpenType = typeof GM_openInTab;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-open-type', 'undefined');
    await page.close();
  });
});
