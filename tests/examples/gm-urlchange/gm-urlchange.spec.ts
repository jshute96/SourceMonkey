// E2E coverage for the gm-urlchange userscript example.
//
// Manager-agnostic: drives the page's OWN buttons (so every history
// call comes from the page, not from the test or the userscript) and
// asserts on the log the userscript writes. Tampermonkey supports the
// same grant, so this doubles as a cross-manager check under
// `--project=tampermonkey`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-urlchange', () => {
  test('pushState, replaceState, hash and back all report a new URL', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-urlchange/gm-urlchange.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await expect(page.locator('#supported')).toContainText('urlchange events are available');

    // The initial load is not an event.
    await expect(page.locator('#count')).toHaveText('0');
    await expect(page.locator('#log')).toContainText('initial URL');

    await page.locator('#btn-push-alpha').click();
    await expect(page.locator('#count')).toHaveText('1');
    await expect(page.locator('#current')).toContainText('?view=alpha');

    await page.locator('#btn-push-beta').click();
    await expect(page.locator('#count')).toHaveText('2');

    await page.locator('#btn-replace-gamma').click();
    await expect(page.locator('#count')).toHaveText('3');
    await expect(page.locator('#current')).toContainText('?view=gamma');

    await page.locator('#btn-hash-next').click();
    await expect(page.locator('#count')).toHaveText('4');
    await expect(page.locator('#current')).toContainText('#section-1');

    // Back over the hash entry: a same-document traversal.
    await page.locator('#btn-back').click();
    await expect(page.locator('#count')).toHaveText('5');
    await expect(page.locator('#current')).not.toContainText('#section-1');

    await page.close();
  });

  test('a replaceState to the same URL still fires — no de-duplication', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // Tampermonkey compares nothing; every reported history update is
    // an event. This asserts the same, so the example demonstrates the
    // behavior a TM-authored script was written against.
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-urlchange/gm-urlchange.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-push-alpha').click();
    await expect(page.locator('#count')).toHaveText('1');

    await page.locator('#btn-replace-same').click();
    await expect(page.locator('#count')).toHaveText('2');
    await page.locator('#btn-replace-same').click();
    await expect(page.locator('#count')).toHaveText('3');

    await page.close();
  });
});
