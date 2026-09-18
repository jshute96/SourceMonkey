// The per-script Log is read-modify-written under a promise chain that
// is module state, so it only orders the writes made in one JS context —
// and both the worker and the extension pages write. Every mutation
// from a page therefore hops to the worker, whose chain is then the only
// one touching the key. See src/script-log.ts.
//
// What needs an end-to-end test is the wiring: the page's fallback
// writes the same entry locally when the message goes unanswered, so the
// visible result is identical whether the relay works or was never
// registered. These tests watch the message itself.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

const LOG_WRITE = 'sm:script-log-write';

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

    // Count the relay's arrivals: the entry alone can't tell the two
    // writers apart. An extra listener, so the real one still runs.
    const sw = await getServiceWorker();
    await sw.evaluate((type) => {
      const w = self as unknown as { __smLogHops: number };
      w.__smLogHops = 0;
      chrome.runtime.onMessage.addListener((msg: { type?: unknown }) => {
        if (msg?.type === type) w.__smLogHops++;
        return undefined;
      });
    }, LOG_WRITE);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('.log-toolbar button', { hasText: 'Clear log' })).toBeEnabled();
    await page.locator('.log-toolbar button', { hasText: 'Clear log' }).click();
    await expect(page.locator('.log-empty')).toBeVisible();

    expect(await sw.evaluate(() => (self as unknown as { __smLogHops: number }).__smLogHops))
      .toBe(1);
    // And the removal really landed in storage, not just in the DOM.
    expect(await sm.getScriptLog(scriptId)).toEqual([]);
    await page.close();
  });
});
