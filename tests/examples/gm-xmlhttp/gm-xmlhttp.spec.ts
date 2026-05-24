// E2E coverage for the gm-xmlhttp userscript example.
//
// Uses the standard fixture server to expose a known URL the
// example userscript can fetch.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-xmlhttp', () => {
  test('GET against the fixture server populates the output panel', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-xmlhttp/gm-xmlhttp.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // fixtureServer always serves target.html with a known body.
    await page.locator('#url').fill(`${fixtureServer.baseUrl}/target.html`);
    await page.locator('#btn-send').click();

    await expect(page.locator('#output')).toContainText('status: 200');
    await expect(page.locator('#output')).toContainText('original content');

    await page.close();
  });

  test('a 404 still fires onload (not onerror)', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-xmlhttp/gm-xmlhttp.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#url').fill(`${fixtureServer.baseUrl}/no-such-file.html`);
    await page.locator('#btn-send').click();

    await expect(page.locator('#output')).toContainText('onload');
    await expect(page.locator('#output')).toContainText('status: 404');

    await page.close();
  });
});
