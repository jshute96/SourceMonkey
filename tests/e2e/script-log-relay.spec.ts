// The per-script Log is read-modify-written under a promise chain that
// is module state, so it only orders the writes made in one JS context.
// Every change from a page therefore runs in the worker, whose chain is
// then the only one touching the key: the viewer's Clear log goes
// through the worker's operations (docs/worker-writes.md). See
// src/extension/script-log.ts.
//
// What needs an end-to-end test is the wiring: the visible result is
// the same whichever context cleared the log. This test watches the
// request itself.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('page log writes go through the worker', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => {
    server = await UserscriptServer.start();
    server.setRoute('/one.user.js', userscriptText('One'));
  });
  test.afterEach(async () => { await server.stop(); });

  test('the viewer\'s Clear log is performed by the worker', async ({
    extensionContext, extensionId, sm, getServiceWorker,
  }) => {
    const collection = (await sm.addCollection(`${server.baseUrl}/one.user.js`))!;
    const scriptId = (await sm.getCollectionWithScripts(collection.id))!.scripts[0].id;
    await sm.appendScriptLog(scriptId, {
      level: 'warning', source: 'test', message: 'to be cleared',
    });

    // Count the worker's clear requests: the entry alone can't tell the
    // two writers apart. An extra listener, so the real one still runs.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      const w = self as unknown as { __smLogClears: number };
      w.__smLogClears = 0;
      chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== 'sm:op') return;
        port.onMessage.addListener((msg: { op?: unknown }) => {
          if (msg?.op === 'clearScriptLog') w.__smLogClears++;
        });
      });
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('.log-toolbar button', { hasText: 'Clear log' })).toBeEnabled();
    await page.locator('.log-toolbar button', { hasText: 'Clear log' }).click();
    await expect(page.locator('.log-empty')).toBeVisible();

    expect(await sw.evaluate(() => (self as unknown as { __smLogClears: number }).__smLogClears))
      .toBe(1);
    // And the removal really landed in storage, not just in the DOM.
    expect(await sm.getScriptLog(scriptId)).toEqual([]);
    await page.close();
  });
});
