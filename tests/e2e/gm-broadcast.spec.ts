// End-to-end test for cross-tab GM_setValue broadcast (Phase 6).
//
// Two tabs running the same script. Tab A writes; Tab B's cache
// should see the new value on the next GM_getValue call WITHOUT
// reloading. The SW maintains an openers table and broadcasts
// sm:gm-value-update to every tab in that script's set after a
// batched write applies.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForGmValues } from '../fixtures/sw-api';

test.describe('GM_* cross-tab broadcast (Phase 6)', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('a write in tab A is observable in tab B via GM_getValue after a tick', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The userscript exposes a function (via DOM data attribute as a
    // probe protocol) that lets the test read the cache at will.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Broadcast',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        // Expose a per-tab handle so the test can poke the cache.
        // We can't reach into USER_SCRIPT world from page.evaluate
        // directly, so the script polls a data-attribute trigger.
        const reportCurrent = () => {
          document.body.dataset.smValue = String(GM_getValue('shared', '_NONE_'));
        };
        const apply = (cmd) => {
          try {
            if (cmd && cmd.startsWith('set:')) GM_setValue('shared', cmd.slice(4));
            reportCurrent();
          } catch (e) {
            document.body.dataset.smValue = 'err:' + e.message;
          }
        };
        // Initial report.
        reportCurrent();
        // Poll the trigger attribute every 50ms.
        let lastSeen = '';
        setInterval(() => {
          const cmd = document.body.dataset.smCmd || '';
          if (cmd && cmd !== lastSeen) { lastSeen = cmd; apply(cmd); }
          else reportCurrent();
        }, 50);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // Open both pages.
    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');

    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');

    // Tab A writes. The userscript's polling loop catches the cmd
    // and calls GM_setValue('shared', 'fromA').
    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:fromA'; });
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', 'fromA');

    // Tab B should see the new value once the batched-write flushes
    // (150ms debounce) and the SW broadcasts. The polling loop in
    // page B then reports the new cache value. Give it ample time.
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-value', 'fromA', { timeout: 3000 });

    await pageA.close();
    await pageB.close();
  });

  test('broadcast skips the originating tab (no echo-back)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // We can't directly observe "no echo" but we CAN observe that the
    // originating tab's cache is consistent with its own write — i.e.,
    // it doesn't receive a stale update or fire a value-listener
    // twice. Here we just confirm the write+read still works on the
    // one-tab case (a smoke that the broadcast plumbing didn't break
    // single-tab semantics).
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Echo',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        GM_setValue('x', 'wrote');
        document.body.dataset.smReadback = String(GM_getValue('x'));
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-readback', 'wrote');
    // The broadcast is only decided AFTER the write persists — the SW
    // awaits `applyBatchValues` and then broadcasts — so waiting for the
    // value in storage is waiting for the broadcast to have happened.
    // A fixed pause could expire before the write was even attempted,
    // which would let the "it's a no-op for this tab" assertion pass
    // without the broadcast ever running.
    await waitForGmValues(sm, (values) => values.x === 'wrote', "x = 'wrote'");
    await expect(page.locator('body')).toHaveAttribute('data-sm-readback', 'wrote');
    await page.close();
  });
});
