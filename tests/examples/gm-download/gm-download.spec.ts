// E2E coverage for the gm-download userscript example.
//
// SourceMonkey only: the page's explorer arrives via a relative
// `@require`, which TM/VM/GM don't support (see the skip below).
// SourceMonkey's exact GM_download contract is asserted in
// tests/e2e/gm-download.spec.ts; what's pinned here is that the
// example page drives it.
//
// HERMETIC ONLY BY CHOICE OF PRESET. Most of the example page's
// presets fetch from an external host (www.gnu.org) so their behavior
// doesn't depend on how the page was opened. The specs here click only
// `btn-file`, `btn-data` and `btn-scheme`, which stay on the fixture
// server or need no network at all. Don't add assertions that depend
// on `btn-http`, `btn-404`, `btn-positional`, `btn-saveas`,
// `btn-abort` or `btn-traversal` completing — that would put the suite
// on the internet.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-download', () => {
  test.beforeEach(({ setup }) => {
    // Relative `@require` is a SourceMonkey extension, and TM installs
    // these examples from a local file so it has no base URL to
    // resolve against. Same reason require-scope and gm-resource skip.
    test.skip(setup.manager === 'tampermonkey',
      'TM requires absolute @require URLs; this example @requires the explorer library by relative path');
  });

  test('downloading a same-origin file reports a callback', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-download/gm-download.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await page.locator('#btn-file').click();
    await expect(page.locator('#log')).toContainText(/(onload|onerror)/, { timeout: 15000 });

    await page.close();
  });

  test('a preset fills the form with the arguments it called with', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-download/gm-download.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-data').click();
    await expect(page.locator('#field-download-url'))
      .toHaveValue('data:text/plain;charset=utf-8,Hello%20from%20a%20data%20URL');
    await expect(page.locator('#field-download-name')).toHaveValue('sourcemonkey-data.txt');
    await expect(page.locator('#log')).toContainText(/(onload|onerror|threw)/, { timeout: 15000 });

    // The form is now a working call the user can edit and re-submit.
    await page.locator('#field-download-name').fill('sourcemonkey-edited.txt');
    await page.locator('#submit-download').click();
    await expect(page.locator('#log li').first())
      .toContainText('"name":"sourcemonkey-edited.txt"');

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

  test('a missing url reaches the API and fails there', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-download/gm-download.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // The form doesn't police required arguments — an empty field is
    // an omitted one, and the API's own refusal is the thing worth
    // seeing. `url` is documented as throwing synchronously.
    await page.locator('#submit-download').click();
    await expect(page.locator('[data-box="download"] .explorer-error')).toBeHidden();
    await expect(page.locator('#log li').first()).toContainText('GM_download()');
    await expect(page.locator('#log li').first()).toContainText('threw:');

    await page.close();
  });
});
