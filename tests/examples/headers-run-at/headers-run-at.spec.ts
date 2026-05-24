// E2E coverage for the @run-at header example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / headers-run-at', () => {
  test('all three @run-at variants run in start/end/idle order', async ({
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

    // chrome.userScripts honors run-at as an "earliest" bound, so
    // start is always injected before end, and end before idle.
    // Each script appends synchronously when it can run, so #log
    // order reflects injection order: start, end, idle.
    const order = await page.locator('#log li').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.script),
    );
    expect(order).toEqual(['start', 'end', 'idle']);

    // document-idle runs after load fired, so readyState should be
    // "complete". The other two are timing-dependent on real Chrome:
    // for trivial local pages, chrome.userScripts at document_start /
    // document_end frequently injects *after* parsing has reached
    // "interactive", so we don't pin their readyState here. (See the
    // page's Details section for the manual-exploration commentary.)
    await expect(page.locator('#log li[data-script="idle"]'))
      .toContainText('readyState=complete');

    await page.close();
  });
});
