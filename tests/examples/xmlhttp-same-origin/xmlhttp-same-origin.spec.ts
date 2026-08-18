// E2E coverage for the xmlhttp-same-origin example.
//
// Both userscripts on the page fire one GM_xmlhttpRequest at the
// page's own URL: one with no `@connect` header at all, one that
// declares an unrelated host. Both must load.
//
// This spec deliberately runs under Tampermonkey too — it is the
// cross-manager claim the default policy rests on: neither manager
// makes a script declare the origin it is already running on. (TM's
// `self` became implicit in 4.0, Tampermonkey/tampermonkey#283.) A TM
// consent prompt here would show up as a timeout, which is exactly the
// signal we'd want.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / xmlhttp-same-origin', () => {
  test('a request to the page\'s own origin loads, with and without a declared @connect', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/xmlhttp-same-origin/xmlhttp-same-origin.html`);

    const noConnect = page.locator('#log li[data-script="no-connect"]');
    await expect(noConnect).toHaveCount(1);
    await expect(noConnect).toHaveAttribute('data-outcome', 'onload');
    await expect(noConnect).toContainText('status=200');

    const elsewhere = page.locator('#log li[data-script="connect-elsewhere"]');
    await expect(elsewhere).toHaveCount(1);
    await expect(elsewhere).toHaveAttribute('data-outcome', 'onload');
    await expect(elsewhere).toContainText('status=200');

    await page.close();
  });
});
