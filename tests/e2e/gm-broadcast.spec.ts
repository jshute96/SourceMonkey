// End-to-end test for cross-tab GM_setValue broadcast (Phase 6).
//
// Two tabs running the same script. Tab A writes; Tab B's cache
// should see the new value on the next GM_getValue call WITHOUT
// reloading. The SW maintains an openers table and broadcasts
// sm:gm-value-update to every tab in that script's set after a
// batched write applies.
//
// Three of the tests here cover the failure the openers table used to
// have when the service worker was evicted between the tabs loading
// and the write (issue #19): delivery has to survive a worker restart,
// and a document that missed a broadcast has to be able to re-sync
// (both a changed value and a deleted one).

import { expect, test } from '../fixtures/extension';
import type { BrowserContext, Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForGmValues, type SmApi } from '../fixtures/sw-api';
import type { FixtureServer } from '../fixtures/sourcemonkey-launch';

// The value-change events one tab's listener recorded, in order.
// `_ABSENT_` stands in for `undefined`, which survives neither
// `JSON.stringify` (the transport) nor `toEqual` (which ignores
// undefined-valued properties, so asserting one pins nothing).
async function readEvents(page: Page): Promise<unknown[]> {
  return JSON.parse((await page.locator('body').getAttribute('data-sm-events')) ?? 'null');
}

// Two tabs running one script that: records every value-change event,
// reports its cached `shared` value on `data-sm-value`, and applies
// `data-sm-cmd` (`set:<value>` / `del`) from a poll loop, which is how
// a test reaches into USER_SCRIPT world.
async function openTwoListeningTabs(ctx: {
  extensionContext: BrowserContext;
  fixtureServer: FixtureServer;
  sm: SmApi;
  scriptsDir: ScriptsDir;
}): Promise<[Page, Page]> {
  ctx.scriptsDir.write({
    relativePath: 'a.user.js',
    meta: {
      name: 'ResyncAfterMissedBroadcast',
      match: [`${ctx.fixtureServer.baseUrl}/*`],
      runAt: 'document-end',
      grant: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_addValueChangeListener'],
    },
    body: `
      const show = (v) => (v === undefined ? '_ABSENT_' : v);
      const events = [];
      GM_addValueChangeListener('shared', (key, oldVal, newVal, remote) => {
        events.push({ key, oldVal: show(oldVal), newVal: show(newVal), remote });
        document.body.dataset.smEvents = JSON.stringify(events);
      });
      document.body.dataset.smEvents = '[]';
      const reportCurrent = () => {
        document.body.dataset.smValue = String(GM_getValue('shared', '_NONE_'));
      };
      reportCurrent();
      let lastSeen = '';
      setInterval(() => {
        const cmd = document.body.dataset.smCmd || '';
        if (cmd && cmd !== lastSeen) {
          lastSeen = cmd;
          if (cmd.startsWith('set:')) GM_setValue('shared', cmd.slice(4));
          else if (cmd === 'del') GM_deleteValue('shared');
        }
        reportCurrent();
      }, 50);
    `,
  });
  await ctx.sm.addCollection(ctx.scriptsDir.path);
  await ctx.sm.syncNow();

  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await ctx.extensionContext.newPage();
    await page.goto(`${ctx.fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');
    pages.push(page);
  }
  return [pages[0], pages[1]];
}

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

    // Tab B should see the new value once the write reaches the SW and
    // it broadcasts. The polling loop in page B then reports the new
    // cache value. Give it ample time.
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-value', 'fromA', { timeout: 3000 });

    await pageA.close();
    await pageB.close();
  });

  test('a write still reaches the other tab after the SW loses its in-memory state', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Regression for issue #19. Same shape as the test above, but the
    // SW's in-memory openers table is wiped between the two tabs
    // loading and the write — which is what an idle eviction does. The
    // table is mirrored to chrome.storage.session, so the broadcast
    // still has somewhere to go.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'BroadcastAcrossRestart',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        const reportCurrent = () => {
          document.body.dataset.smValue = String(GM_getValue('shared', '_NONE_'));
        };
        reportCurrent();
        let lastSeen = '';
        setInterval(() => {
          const cmd = document.body.dataset.smCmd || '';
          if (cmd && cmd !== lastSeen) {
            lastSeen = cmd;
            if (cmd.startsWith('set:')) GM_setValue('shared', cmd.slice(4));
          }
          reportCurrent();
        }, 50);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');
    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');

    // The worker "restarts": its in-memory table is empty and nothing
    // will re-register these two documents, exactly as after an idle
    // eviction. Only the session-storage mirror can save the write.
    await sm.dropGmOpenersForTests();

    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:afterRestart'; });
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', 'afterRestart');
    await expect(pageB.locator('body'))
      .toHaveAttribute('data-sm-value', 'afterRestart', { timeout: 3000 });

    await pageA.close();
    await pageB.close();
  });

  test('a document that missed a broadcast re-syncs on the SW nudge', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The other half of issue #19: a lost broadcast used to be
    // permanent, because GM_getValue is a pure cache read. Here the
    // broadcast is suppressed outright, then the SW sends the same
    // all-tabs nudge it sends at startup — the reader's cache catches
    // up and its value-change listener fires with remote=true.
    const [pageA, pageB] = await openTwoListeningTabs({
      extensionContext, fixtureServer, sm, scriptsDir,
    });

    try {
      await sm.setDebugSuppressGmBroadcast(true);
      await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:missed'; });
      await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', 'missed');
      // Waiting on the persisted row is waiting for the write to have
      // reached the point where a broadcast would have gone out — so
      // "tab B is still stale" below is a statement about a dropped
      // broadcast, not about a write still in flight.
      await waitForGmValues(sm, (values) => values.shared === 'missed', "shared = 'missed'");
      await expect(pageB.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');
    } finally {
      await sm.setDebugSuppressGmBroadcast(false);
    }

    await sm.nudgeGmResync();
    await expect(pageB.locator('body'))
      .toHaveAttribute('data-sm-value', 'missed', { timeout: 3000 });
    expect(await readEvents(pageB)).toEqual([
      { key: 'shared', oldVal: '_ABSENT_', newVal: 'missed', remote: true },
    ]);
    // The writer is nudged too, and its cache already agrees with the
    // snapshot — so the diff must find nothing and fire nothing. A
    // resync that re-fired every key would show up here as a second,
    // remote=true echo of tab A's own write.
    expect(await readEvents(pageA)).toEqual([
      { key: 'shared', oldVal: '_ABSENT_', newVal: 'missed', remote: false },
    ]);

    await pageA.close();
    await pageB.close();
  });

  test('a resync also catches a delete that was lost', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The delete branch of the snapshot diff: it has to notice a key
    // MISSING from the snapshot, not just one whose value changed.
    const [pageA, pageB] = await openTwoListeningTabs({
      extensionContext, fixtureServer, sm, scriptsDir,
    });

    // Seed both caches the ordinary way — this write's broadcast is
    // allowed through, so tab B has the key before we break delivery.
    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:seeded'; });
    await expect(pageB.locator('body'))
      .toHaveAttribute('data-sm-value', 'seeded', { timeout: 3000 });

    try {
      await sm.setDebugSuppressGmBroadcast(true);
      await pageA.evaluate(() => { document.body.dataset.smCmd = 'del'; });
      await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', '_NONE_');
      await waitForGmValues(sm, (values) => !('shared' in values), 'shared deleted');
      await expect(pageB.locator('body')).toHaveAttribute('data-sm-value', 'seeded');
    } finally {
      await sm.setDebugSuppressGmBroadcast(false);
    }

    await sm.nudgeGmResync();
    await expect(pageB.locator('body'))
      .toHaveAttribute('data-sm-value', '_NONE_', { timeout: 3000 });
    expect(await readEvents(pageB)).toEqual([
      { key: 'shared', oldVal: '_ABSENT_', newVal: 'seeded', remote: true },
      { key: 'shared', oldVal: 'seeded', newVal: '_ABSENT_', remote: true },
    ]);

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
