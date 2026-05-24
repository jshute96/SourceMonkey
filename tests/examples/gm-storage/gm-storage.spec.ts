// E2E coverage for the gm-storage userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-storage', () => {
  test('set then get round-trips a value', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-storage/gm-storage.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#key').fill('demo-key');
    await page.locator('#value').fill('"hello-world"');
    await page.locator('#btn-set').click();
    await expect(page.locator('#output')).toContainText('setValue');
    await expect(page.locator('#output')).toContainText('hello-world');

    // Clear the input to prove the getValue read is coming from
    // storage and not echoing back the form field.
    await page.locator('#value').fill('');
    await page.locator('#btn-get').click();
    await expect(page.locator('#output')).toContainText('hello-world');

    await page.locator('#btn-list').click();
    await expect(page.locator('#output')).toContainText('demo-key');

    await page.locator('#btn-delete').click();
    await page.locator('#btn-get').click();
    await expect(page.locator('#output')).toContainText('(undefined)');

    await page.close();
  });
});
