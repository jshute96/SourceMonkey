// E2E coverage for the gm-info userscript example. Lives next to its
// paired page + userscript so per-API work stays in one dir.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-info', () => {
  test('dumps the metadata object onto the page (http)', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-info/gm-info.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    const text = await page.locator('#output').textContent();
    expect(text).toContain('scriptHandler');
    // "SourceMonkey" appears two ways: as the literal scriptHandler
    // value under SM, and inside the rendered @name string under any
    // manager (the example's @name is "SourceMonkey example: GM_info").
    // Either match is fine — the assertion proves the userscript ran
    // and its body produced output, not that a specific manager is
    // active.
    expect(text).toContain('SourceMonkey');

    await page.close();
  });

  test('also runs against a file:// URL', async ({ extensionContext, setup }) => {
    // The example userscript ships a `file:///*/<api>/<api>.html`
    // match alongside the http one, so loading the page from disk
    // works without a local server. Under TM, this requires "Allow
    // access to file URLs" enabled on the TM card in chrome://extensions
    // — a step covered by the one-time setup in
    // docs/cross-manager-testing.md.
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`file://${path.join(__dirname, 'gm-info.html')}`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    const text = await page.locator('#output').textContent();
    expect(text).toContain('scriptHandler');

    await page.close();
  });
});
