// E2E coverage for the gm-info userscript example. Lives next to its
// paired page + userscript so per-API work stays in one dir.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/extension';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-info', () => {
  test('dumps the metadata object onto the page (http)', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-info/gm-info.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    const text = await page.locator('#output').textContent();
    expect(text).toContain('scriptHandler');
    expect(text).toContain('SourceMonkey');

    await page.close();
  });

  test('also runs against a file:// URL', async ({ extensionContext, sm }) => {
    // The example userscript ships a `file:///*/<api>/<api>.html`
    // match alongside the http one, so loading the page from disk
    // works without a local server.
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`file://${path.join(__dirname, 'gm-info.html')}`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    const text = await page.locator('#output').textContent();
    expect(text).toContain('scriptHandler');

    await page.close();
  });
});
