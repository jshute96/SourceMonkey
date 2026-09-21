// E2E coverage for the gm-download userscript example.
//
// Runs under both managers, so the assertions stay at the level the
// documented API guarantees: a call produces *some* observable
// callback. Which error value a refused download reports (and whether
// a manager applies its own file-extension allowlist) is
// manager-specific — SourceMonkey's exact contract is asserted in
// tests/e2e/gm-download.spec.ts.
//
// HERMETIC ONLY BY CHOICE OF BUTTON. Most of the example page's
// buttons fetch from an external host (www.gnu.org) so their behavior
// doesn't depend on how the page was opened. The specs here click only
// `btn-file`, `btn-data` and `btn-scheme`, which stay on the fixture
// server or need no network at all. Don't add assertions that depend
// on `btn-http`, `btn-404`, `btn-positional`, `btn-abort` or
// `btn-traversal` completing — that would put the suite on the
// internet.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Violentmonkey saves a download by clicking an anchor on a
// `blob:chrome-extension://` URL from its own extension page. In
// headless Chromium 153 (Playwright's bundled build and the system
// Chrome alike) the *browser process* segfaults about half the time
// the moment such a download completes, taking every open page with
// it. No download-handling setting or flag on our side changes that,
// and Tampermonkey (which downloads through `chrome.downloads`) is
// unaffected, so the tests that let a download run to completion sit
// out under VM. Re-check when the bundled Chromium moves past 153.
const VM_DOWNLOAD_CRASH =
  'A completed Violentmonkey download crashes headless Chromium 153';

test.describe('examples / gm-download', () => {
  test('downloading a same-origin file reports a callback', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    test.skip(setup.manager === 'violentmonkey', VM_DOWNLOAD_CRASH);
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-download/gm-download.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await page.locator('#btn-file').click();
    // onload under SM; a manager with a stricter extension allowlist
    // may answer onerror instead. Either is a working call.
    await expect(page.locator('#log')).toContainText(/(onload|onerror)/, { timeout: 15000 });

    await page.close();
  });

  test('a data: URL download reports a callback', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    test.skip(setup.manager === 'violentmonkey', VM_DOWNLOAD_CRASH);
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-download/gm-download.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-data').click();
    await expect(page.locator('#log')).toContainText(/(onload|onerror|threw)/, { timeout: 15000 });

    await page.close();
  });

  test('a file:// URL is refused', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-download/gm-download.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-scheme').click();
    // No manager should quietly *succeed* at pulling a local file onto
    // disk on a userscript's say-so. Refusal shape varies.
    await expect(page.locator('#log')).toContainText(/(onerror|threw|ontimeout)/, { timeout: 15000 });
    await expect(page.locator('#log')).not.toContainText('onload');

    await page.close();
  });
});
