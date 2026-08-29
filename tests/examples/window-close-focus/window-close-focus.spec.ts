// E2E coverage for the window-close-focus userscript example.
//
// Manager-agnostic: both assertions are about what the grant does, not
// how it does it. `window.focus` has no observable effect in a headless
// browser, so it is covered by the override being installed and the
// call being accepted.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / window-close-focus', () => {
  test('both methods are the manager\'s, and focus is accepted', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/window-close-focus/window-close-focus.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await expect(page.locator('#closeKind')).toHaveText('window.close: manager');
    await expect(page.locator('#focusKind')).toHaveText('window.focus: manager');

    await page.locator('#btn-focus').click();
    await expect(page.locator('#log')).toContainText('returned (nothing to see');

    await page.close();
  });

  test('close closes this tab', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);

    // Closing the LAST tab takes the browser with it, which Playwright
    // reports as a dead context rather than a page close. Keep a second
    // tab around so the close is observable.
    const keepAlive = await extensionContext.newPage();
    await keepAlive.goto(`${fixtureServer.baseUrl}/other.html`);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/window-close-focus/window-close-focus.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // The click itself can lose the race: under VM the tab is gone
    // before `click()` returns, and Playwright reports that as
    // "Target page, context or browser has been closed" — the very
    // outcome the test wants. Swallow that one error and let the poll
    // below decide; anything else still fails here.
    await page.locator('#btn-close').click().catch((err) => {
      if (!String(err?.message ?? err).includes('has been closed')) throw err;
    });
    // Poll rather than wait for the `close` event: the tab can be gone
    // before `click()` resolves, and a listener attached after the fact
    // never sees it.
    await expect.poll(() => page.isClosed(), { timeout: 10_000 }).toBe(true);

    await keepAlive.close();
  });
});
