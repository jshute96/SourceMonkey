// E2E coverage for the unsafeWindow example.
//
// Written to hold under any userscript manager: it asserts the
// *observable contract* of `@grant unsafeWindow` (the page's globals
// are reachable, and what the script writes there is visible to the
// page) rather than SourceMonkey's mechanism for getting there.
//
// The `identity` assertion is deliberately Chrome-shaped —
// `unsafeWindow === window` because Chrome managers satisfy the grant
// by running the script in the page realm. Firefox managers hand out a
// distinct wrapper, so this line would need relaxing if the suite ever
// runs there.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / unsafe-window', () => {
  test('unsafeWindow reaches the page realm, and GM storage still works', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);

    // Read: the page-defined app object is visible.
    await expect(page.locator('#log li[data-script="read"]'))
      .toContainText('"name":"page-app"');
    // Call: a page-defined function runs and returns the page's answer.
    await expect(page.locator('#log li[data-script="call"]'))
      .toContainText('hello userscript from the page');
    // Identity: Chrome managers run the script in the page realm.
    await expect(page.locator('#log li[data-script="identity"]'))
      .toContainText('unsafeWindow === window: true');
    // Storage still works from a script that also reaches the page.
    await expect(page.locator('#log li[data-script="gm"]'))
      .toContainText("GM_getValue('visits') = 0");

    // Write: the page's own polling loop read back what the script put
    // on the page's window. This is checked from the page's side, so it
    // can't be satisfied by an isolated-world write.
    await expect(page.locator('#pageSees'))
      .toHaveAttribute('data-value', 'written-by-userscript');

    await page.close();
  });

  test('@inject-into content keeps unsafeWindow isolated from the page', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);

    // The isolated variant sees nothing of the page's realm — the
    // failure mode the grant exists to avoid, made explicit.
    await expect(page.locator('#log li[data-script="isolated-read"]'))
      .toContainText('unsafeWindow.__PAGE_APP__ = undefined');
    // It is still a window, just not the page's.
    await expect(page.locator('#log li[data-script="isolated-identity"]'))
      .toContainText('unsafeWindow === window: true');

    await page.close();
  });

  test('GM storage persists across reloads for a page-realm script', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // The regression this guards: moving unsafeWindow scripts into the
    // page realm must not cost them their GM_* surface. Under
    // SourceMonkey the value round-trips over the MAIN-world bridge.
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);
    await expect(page.locator('#log li[data-script="gm"]'))
      .toContainText("GM_getValue('visits') = 0");

    // Give the manager's debounced write a chance to persist.
    await page.waitForTimeout(600);
    await page.reload();

    await expect(page.locator('#log li[data-script="gm"]'))
      .toContainText("GM_getValue('visits') = 1");

    await page.close();
  });
});
