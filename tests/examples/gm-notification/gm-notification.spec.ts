// E2E coverage for the gm-notification userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-notification', () => {
  test('simple call resolves with an id', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-notification/gm-notification.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await page.locator('#btn-simple').click();
    await expect(page.locator('#log')).toContainText(/resolved id=/);

    await page.close();
  });

  test('empty-text call produces an observable outcome', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-notification/gm-notification.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-empty').click();
    // Whether empty text is rejected (SM), accepted, or silently
    // ignored is manager-specific. We just want to see that the call
    // produced *some* observable outcome — resolved, rejected, or a
    // synchronous throw. SM's strict-rejection invariant is covered in
    // tests/e2e/gm-notification.spec.ts.
    await expect(page.locator('#log')).toContainText(/(resolved|rejected|threw)/);

    await page.close();
  });
});
