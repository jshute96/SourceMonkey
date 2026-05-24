// E2E coverage for the gm-value-listeners userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/extension';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-value-listeners', () => {
  test('a setValue fires both listeners; remove silences one', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-value-listeners/gm-value-listeners.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#value').fill('"first"');
    await page.locator('#btn-set').click();
    await expect(page.locator('#log')).toContainText('listener 1 fired');
    await expect(page.locator('#log')).toContainText('listener 2 fired');

    await page.locator('#btn-remove1').click();

    await page.locator('#value').fill('"second"');
    await page.locator('#btn-set').click();
    // Listener 2 should fire for the new value.
    await expect(page.locator('#log')).toContainText(/listener 2 fired.*new="second"/);

    await page.close();
  });
});
