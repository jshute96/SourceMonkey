// E2E coverage for the gm-clipboard userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-clipboard', () => {
  // The grant below lands on the worker-scoped context, so without this
  // it would persist for every later test sharing that worker — and
  // which tests those are is scheduling-dependent under parallelism.
  test.afterEach(async ({ extensionContext }) => {
    await extensionContext.clearPermissions();
  });

  test('clicking copy lands the text on the system clipboard', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // navigator.clipboard requires explicit grants in Playwright's
    // Chromium context — match the existing gm-clipboard spec.
    await extensionContext.grantPermissions(['clipboard-read', 'clipboard-write']);

    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-clipboard/gm-clipboard.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#text').fill('round-trip via clipboard');
    await page.locator('#btn-copy').click();

    await expect(page.locator('#log')).toContainText('resolved');

    const pasted = await page.evaluate(() => navigator.clipboard.readText());
    expect(pasted).toBe('round-trip via clipboard');

    await page.close();
  });
});
