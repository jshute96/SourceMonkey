// End-to-end test for GM_setClipboard (Phase 5).
//
// Implementation uses navigator.clipboard.writeText from USER_SCRIPT
// world. The headless fixture pages are focused by the time the
// userscript runs, so the API resolves cleanly.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_setClipboard (Phase 5)', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('GM_setClipboard resolves and the text lands on the system clipboard', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Playwright Chromium grants clipboard-read permission via the
    // browser context; grant clipboard-write too so navigator.clipboard
    // can be exercised end-to-end.
    await extensionContext.grantPermissions(['clipboard-read', 'clipboard-write']);

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CopyText',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setClipboard'],
      },
      body: `
        // GM_setClipboard returns the underlying writeText Promise.
        Promise.resolve(GM_setClipboard('hello clipboard')).then(
          () => { document.body.dataset.smCopy = 'ok'; },
          (e) => { document.body.dataset.smCopy = 'err:' + String(e?.message || e); }
        );
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-copy', 'ok');

    // Read the clipboard from the page to verify what landed.
    const got = await page.evaluate(() => navigator.clipboard.readText());
    expect(got).toBe('hello clipboard');
    await page.close();
  });

  test('GM.setClipboard (GM4 alias) also works', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    await extensionContext.grantPermissions(['clipboard-read', 'clipboard-write']);

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GMDotCopy',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setClipboard'],
      },
      body: `
        GM.setClipboard('via GM dot').then(
          () => { document.body.dataset.smCopy = 'ok'; },
          (e) => { document.body.dataset.smCopy = 'err:' + String(e?.message || e); }
        );
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-copy', 'ok');
    const got = await page.evaluate(() => navigator.clipboard.readText());
    expect(got).toBe('via GM dot');
    await page.close();
  });

  test('ungranted GM_setClipboard is not callable', async ({
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
        grant: ['GM_setValue'],  // no clipboard grant
      },
      body: `
        document.body.dataset.smClipType = typeof GM_setClipboard;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-clip-type', 'undefined');
    await page.close();
  });
});
