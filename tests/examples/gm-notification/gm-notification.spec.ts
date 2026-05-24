// E2E coverage for the gm-notification userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/extension';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-notification', () => {
  test('simple call resolves with an id', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-notification/gm-notification.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await page.locator('#btn-simple').click();
    await expect(page.locator('#log')).toContainText(/resolved id=/);

    await page.close();
  });

  test('empty-text call rejects', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-notification/gm-notification.html`);

    await page.locator('#btn-empty').click();
    // Either a Promise rejection or a synchronous throw is acceptable —
    // we just want to see that empty text didn't quietly succeed.
    await expect(page.locator('#log')).toContainText(/(rejected|threw)/);

    await page.close();
  });
});
