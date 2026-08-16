// E2E coverage for the @inject-into header example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / headers-inject-into', () => {
  test('page-world script sees page globals; content-world script does not', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/headers-inject-into/headers-inject-into.html`);

    // Both scripts append one row each.
    await expect(page.locator('#log li[data-script="page"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="content"]')).toHaveCount(1);

    // The MAIN-world script should have read the page's marker.
    await expect(page.locator('#log li[data-script="page"]'))
      .toContainText('"i-am-the-page-world"');
    await expect(page.locator('#log li[data-script="page"]'))
      .toContainText('"page-only-function-result"');

    // The USER_SCRIPT-world script should have seen undefined for
    // both — isolated worlds don't share window globals.
    //
    // Not asserted under TM, which doesn't implement `@inject-into` at
    // all (that's a Violentmonkey/SourceMonkey header; TM's equivalent
    // is `@sandbox`). TM therefore ignores `@inject-into content` and
    // honours this variant's `@grant none`, which by TM's own rules
    // means "run in page context" — so the script legitimately sees
    // the page's globals there. A real manager difference in what the
    // header means, not a world-isolation bug. See
    // docs/cross-manager-test-results.md.
    if (setup.manager !== 'tampermonkey') {
      await expect(page.locator('#log li[data-script="content"]'))
        .toContainText('window.__SM_PAGE_MARKER__ = undefined');
      await expect(page.locator('#log li[data-script="content"]'))
        .toContainText('typeof __SM_FROM_PAGE_FN__ = undefined');
    }

    // page.evaluate runs in the MAIN world, so it can see the marker
    // the MAIN-world userscript stashed there.
    const fromPageScript = await page.evaluate(
      () => (window as unknown as { __SM_FROM_PAGE_SCRIPT__?: unknown }).__SM_FROM_PAGE_SCRIPT__,
    );
    expect(fromPageScript).toEqual({
      marker: 'i-am-the-page-world',
      fnResult: 'page-only-function-result',
    });

    await page.close();
  });
});
