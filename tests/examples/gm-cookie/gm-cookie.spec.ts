// E2E coverage for the gm-cookie userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-cookie', () => {
  // The cookie jar outlives each test's script state.
  test.afterEach(async ({ extensionContext }) => {
    await extensionContext.clearCookies();
  });

  test('set, list and delete round-trip', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-cookie/gm-cookie.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    const log = page.locator('#log');

    await page.locator('#btn-set').click();
    await expect(log.locator('li').first()).toHaveText(/→ set\n  document\.cookie: sm_example=hello cookie$/);

    await page.locator('#btn-gm-list').click();
    await expect(log.locator('li').first()).toHaveText(/GM\.cookie\.list.*\n  → 1 cookie:\n      sm_example=hello cookie$/);

    // Ignores the name field, so it also finds a cookie of another name.
    await extensionContext.addCookies([{ name: 'sm_other', value: 'x', url: fixtureServer.baseUrl }]);
    await page.locator('#btn-list-all').click();
    await expect(log.locator('li').first()).toHaveText(/GM_cookie\.list\(\{\}\)\n  → 2 cookies:\n.*sm_example=hello cookie\n.*sm_other=x$/);

    await page.locator('#btn-delete').click();
    await expect(log.locator('li').first()).toHaveText(/→ deleted\n  document\.cookie: sm_other=x$/);

    await page.close();
  });

  test('a site the script does not match is refused', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-cookie/gm-cookie.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-elsewhere').click();
    await expect(page.locator('#log')).toContainText(/error: .+expected: the script doesn't match/);

    await page.close();
  });
});
