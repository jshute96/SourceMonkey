// End-to-end tests for MAIN-world storage writes made just before the
// document goes away.
//
// In USER_SCRIPT world a flush leaves over `chrome.runtime.sendMessage`,
// which is handed to the browser synchronously and survives teardown.
// MAIN world has to reach the bridge first, and the only way that
// survives is a DOM event (`sourcemonkey-bridge-sync`): its listeners
// run in the DISPATCHING task, so the bridge's own sendMessage happens
// before the caller returns. Both shapes below lost the write every
// time when that hop was a `window.postMessage`, which the bridge sees
// only on a LATER task — one a document in `pagehide` never gets.
// These pin that the hop stays synchronous: a write's send, from a
// microtask or the pagehide flush, has to leave before the document
// does.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('MAIN-world storage writes at document teardown', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('write then a script-driven navigation in the same task: the next document sees it', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The common userscript idiom: save state, then `location.href =`.
    // Nothing yields between the write and the navigation, so only the
    // pagehide flush (and the bridge's turn after it) can save it.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'MainTeardownNav',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue', 'GM_getValue'],
      },
      body: `
        const step = new URL(location.href).searchParams.get('step');
        if (step === '1') {
          GM_setValue('shared', 'fromStep1');
          location.href = location.pathname + '?step=2';
        } else if (step === '2') {
          document.body.dataset.smInitial = String(GM_getValue('shared', '_NONE_'));
        }
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html?step=1`);
    await page.waitForURL(/step=2/);
    await expect(page.locator('body')).toHaveAttribute('data-sm-initial', 'fromStep1');
    await page.close();
  });

  test('write then the tab closes straight away: a fresh tab sees it', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'MainTeardownClose',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue', 'GM_getValue'],
      },
      body: `
        document.body.dataset.smInitial = String(GM_getValue('shared', '_NONE_'));
        let lastSeen = '';
        setInterval(() => {
          const cmd = document.body.dataset.smCmd || '';
          if (cmd && cmd !== lastSeen) {
            lastSeen = cmd;
            if (cmd.startsWith('set:')) GM_setValue('shared', cmd.slice(4));
            document.body.dataset.smWrote = cmd;
          }
        }, 20);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-initial', '_NONE_');
    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:closedWrite'; });
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-wrote', 'set:closedWrite');
    // Close straight after the write, without waiting for the worker.
    await pageA.close();

    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html?n=2`);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-initial', 'closedWrite');
    await pageB.close();
  });
});
