// E2E coverage for the gm-tab userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-tab', () => {
  test('keeps the tab\'s object across loads and lists both tabs', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    test.skip(setup.manager === 'violentmonkey', 'VM has no GM_getTab / GM_saveTab / GM_getTabs');
    await setup.installScriptsFrom(__dirname);
    const url = `${fixtureServer.baseUrl}/gm-tab/gm-tab.html`;

    const page = await extensionContext.newPage();
    await page.goto(url);
    await expect(page.locator('#runStatus')).toHaveText(/Loads of this page in this tab: 1\./);

    await page.locator('#note').fill('hello');
    await page.locator('#btn-save').click();
    await expect(page.locator('#output')).toContainText('GM_saveTab saved');

    // The count and the note survive a reload.
    await page.reload();
    await expect(page.locator('#runStatus')).toHaveText(/Loads of this page in this tab: 2\./);
    await expect(page.locator('#note')).toHaveValue('hello');

    // A second tab starts over, and each tab lists both.
    const second = await extensionContext.newPage();
    await second.goto(url);
    await expect(second.locator('#runStatus')).toHaveText(/Loads of this page in this tab: 1\./);
    await second.locator('#btn-list').click();
    await expect(second.locator('#output')).toContainText('"loads": 2');
    await expect(second.locator('#output')).toContainText('"loads": 1');
    await expect(second.locator('#output')).toContainText('"note": "hello"');

    await second.close();
    await page.close();
  });
});
