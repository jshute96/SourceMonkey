// E2E coverage for the gm-open-in-tab userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/extension';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-open-in-tab', () => {
  test('clicking active opens a new tab at the typed URL', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-open-in-tab/gm-open-in-tab.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // Replace the default value with a known-served URL.
    const targetUrl = `${fixtureServer.baseUrl}/other.html`;
    await page.locator('#url').fill(targetUrl);

    const newTabPromise = extensionContext.waitForEvent('page');
    await page.locator('#btn-active').click();

    const opened = await newTabPromise;
    await opened.waitForLoadState('domcontentloaded');
    expect(opened.url()).toBe(targetUrl);

    await expect(page.locator('#log')).toContainText('returned: object');

    await opened.close();
    await page.close();
  });
});
