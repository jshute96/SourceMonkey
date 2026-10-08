// E2E coverage for the run-at-context-menu userscript example.
//
// SourceMonkey only. Tampermonkey runs these scripts from the page's
// right-click menu, which Playwright can't open, and Violentmonkey
// doesn't support `@run-at context-menu`. The spec stands in for the
// popup's "Run this script" through the service worker's test surface.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';
import { makeGetServiceWorker } from '../../fixtures/sourcemonkey-launch';
import { activeTabId, makeSwApi } from '../../fixtures/sw-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / run-at-context-menu', () => {
  test('runs only when asked, once per run, and each run replaces the last one\'s menu commands', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    test.skip(setup.manager !== 'sourcemonkey', `${setup.manager} has no "Run this script" a test can drive`);

    await setup.installScriptsFrom(__dirname);
    const getServiceWorker = makeGetServiceWorker(extensionContext);
    const sm = makeSwApi(getServiceWorker);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/run-at-context-menu/run-at-context-menu.html`);
    const tabId = await activeTabId(getServiceWorker);

    // Listed under Manual, not run.
    const view = await sm.getPopupView(tabId);
    expect(view.enabled).toEqual([]);
    const row = view.manual[0]?.rows[0];
    expect(row?.status).toBe('NOT_RUN');
    expect(row?.runnable).toBe(true);
    await expect(page.locator('#runStatus')).toHaveText(/Not run yet/);
    await expect(page.locator('#runs li')).toHaveCount(0);

    const commandNames = async (): Promise<string[]> =>
      (await sm.getPopupView(tabId)).manual[0].rows[0].commands.map((c) => c.name);

    expect(await sm.runManualScript(tabId, row!.id)).toEqual({ ok: true });
    await expect(page.locator('#runs li')).toHaveText(['Run 1 on this page (1 in all)']);
    await expect.poll(commandNames).toEqual(['Clear lines', 'Say hello from run 1']);
    await expect.poll(async () => (await sm.getPopupView(tabId)).manual[0].rows[0].status).toBe('OK');

    // A second run adds a line, and its commands replace the first run's.
    expect(await sm.runManualScript(tabId, row!.id)).toEqual({ ok: true });
    await expect(page.locator('#runs li')).toHaveText([
      'Run 1 on this page (1 in all)',
      'Run 2 on this page (2 in all)',
    ]);
    await expect.poll(commandNames).toEqual(['Clear lines', 'Say hello from run 2']);
    const ran = (await sm.getPopupView(tabId)).manual[0].rows[0];
    expect(ran.tooltip).toContain('Ran 2 times on this page');

    // The toolbar badge counts it once.
    await expect.poll(async () => (await sm.getTabState(tabId)).badgeText).toBe('1');

    await page.close();
  });
});
