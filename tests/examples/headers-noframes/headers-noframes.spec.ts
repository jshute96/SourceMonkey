// E2E coverage for the @noframes header example.
//
// Runs against any manager the fixture supports, so it doubles as the
// cross-manager check that our default (run in every matching frame)
// really is what TM does.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / headers-noframes', () => {
  test('the default script runs in both documents; @noframes runs only in the top one', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/headers-noframes/headers-noframes.html`);

    // Top-level document: both scripts match its URL, so both run.
    await expect(page.locator('#log li[data-script="all-frames"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="noframes"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="all-frames"]'))
      .toHaveAttribute('data-frame', 'top');

    // Embedded frame: its own URL matches both scripts' patterns, so
    // the only thing keeping the second one out is `@noframes`.
    const frame = page.frameLocator('#child');
    await expect(frame.locator('#log li[data-script="all-frames"]')).toHaveCount(1);
    await expect(frame.locator('#log li[data-script="all-frames"]'))
      .toHaveAttribute('data-frame', 'sub');
    // Settle the frame before asserting a negative: the row above
    // proves the frame ran scripts at all, so an empty result here is
    // a real absence rather than a race.
    await expect(frame.locator('#log li[data-script="noframes"]')).toHaveCount(0);

    await page.close();
  });
});
