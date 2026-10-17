// E2E coverage for the @run-at header example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / headers-run-at', () => {
  test('all three @run-at variants run; idle observes readyState=complete', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/headers-run-at/headers-run-at.html`);

    // Each variant appends exactly one <li> with a data-script
    // attribute identifying it. Wait for all three.
    await expect(page.locator('#log li[data-script="start"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="end"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="idle"]')).toHaveCount(1);

    // The one cross-manager invariant we can rely on is the
    // document-idle lifecycle contract: on this page, whose `load`
    // follows DOMContentLoaded at once, idle scripts run *after* the
    // page's `load` event, so they observe readyState=complete.
    //
    // Cross-script ordering on tiny local pages is implementation-
    // defined and varies between managers (and even between runs of
    // the same manager): chrome.userScripts queues by @run-at then
    // registration order (so SM lands start → end → idle), while TM
    // has been observed running document-end at `load` — which can
    // land *after* idle when a slow subresource pushes load past
    // idle's static timeout. The SM-specific ordering is covered in
    // tests/e2e/injection.spec.ts.
    await expect(page.locator('#log li[data-script="idle"]'))
      .toContainText('readyState=complete');

    // Whether a load listener the idle script adds fires differs by
    // manager: TM and VM run this @grant none script after `load` here.
    // SM runs it just before `load`, or replays `load` to it.
    if (setup.manager === 'sourcemonkey') {
      await expect(page.locator('#log li[data-script="idle-load"]')).toHaveCount(1);
    }

    await page.close();
  });
});
