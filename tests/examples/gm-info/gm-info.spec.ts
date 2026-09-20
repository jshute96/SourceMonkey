// E2E coverage for the gm-info userscript example. Lives next to its
// paired page + userscript so per-API work stays in one dir.

import fs from 'node:fs';
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

    // The comparison table gets one column per run and one row per
    // flattened field path.
    const table = page.locator('#comparison');
    await expect(table.locator('thead th')).toHaveCount(2);
    await expect(table.locator('tbody th', { hasText: /^script\.name$/ })).toHaveCount(1);

    await page.close();
  });

  test('merges a second manager run into the same table', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-info/gm-info.html`);
    await expect(page.locator('#runStatus')).toHaveText(/ran 1 time/);
    // Whatever manager this project runs under; its label is compared
    // against the fake run's below.
    const realLabel = await page.locator('#output section.dump h3').textContent();

    // Stand in for a second manager: run the same script body again in
    // the page with a hand-built GM_info. The script reads `GM_info` as
    // a bare global, so a window property satisfies it. "Alphamonkey"
    // sorts before every real handler name, so it lands first even
    // though it ran second.
    const source = fs.readFileSync(path.join(__dirname, 'gm-info.user.js'), 'utf8');
    await page.evaluate((src) => {
      (window as any).GM_info = {
        script: { name: 'fake', onlyHere: true },
        scriptHandler: 'Alphamonkey',
        version: '9.9',
      };
      new Function(src)();
    }, source);

    await expect(page.locator('#runStatus')).toHaveText(/ran 2 time/);

    const dumps = page.locator('#output section.dump h3');
    await expect(dumps).toHaveCount(2);
    await expect(dumps.nth(0)).toHaveText('Alphamonkey 9.9');
    await expect(dumps.nth(1)).toHaveText(realLabel!);

    const table = page.locator('#comparison');
    await expect(table.locator('thead th')).toHaveText([
      'Field path', 'Alphamonkey 9.9', realLabel!,
    ]);
    // A field only one side has shows a placeholder in the other.
    // `scriptMetaStr` is top-level under every real manager and absent
    // from the fake object.
    const onlyHere = table.locator('tbody tr', { hasText: 'script.onlyHere' });
    await expect(onlyHere.locator('td')).toHaveText(['true', '—']);
    const meta = table.locator('tbody tr', { has: page.locator('th', { hasText: /^scriptMetaStr$/ }) });
    await expect(meta.locator('td').nth(0)).toHaveText('—');

    await page.close();
  });

  test('also runs against a file:// URL', async ({ extensionContext, setup }) => {
    // The example userscript ships a `file:///*/<api>/<api>.html`
    // match alongside the http one, so loading the page from disk
    // works without a local server. Under TM, this requires "Allow
    // access to file URLs" enabled on the TM card in chrome://extensions
    // — a step covered by the one-time setup in
    // docs/cross-manager-testing.md.
    //
    // VM doesn't inject into file:// pages here at all. Checked, not
    // assumed: the grant is live (`isAllowedFileSchemeAccess` returns
    // true), the script is installed and enabled with its file://
    // `@match` intact, and the page still reports no userscript after
    // an extension reload. See docs/cross-manager-test-results.md.
    test.skip(setup.manager === 'violentmonkey', 'VM does not inject into file:// pages in this setup');

    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`file://${path.join(__dirname, 'gm-info.html')}`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    const text = await page.locator('#output').textContent();
    expect(text).toContain('scriptHandler');

    await page.close();
  });
});
