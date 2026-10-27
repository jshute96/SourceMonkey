// E2E coverage for the gm-resource userscript example.
//
// Exercises both reads (GM_getResourceText, GM_getResourceURL) against
// three @resource entries (CSS, JSON, SVG) plus the missing-name case.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The example's `@resource` refs are the files' GitHub Pages URLs, so
// TM and VM fetch them from there. SourceMonkey, which loads the
// example from this directory, reads the copies beside the script
// instead (a local file override).
test.describe('examples / gm-resource', () => {
  test('GM_getResourceText returns the prefetched CSS bytes and GM_addStyle applies it', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-resource/gm-resource.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    const before = await page.locator('#playground').evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(before).not.toMatch(/rgb\(0,\s*128,\s*128\)/);

    await page.locator('#btn-css').click();
    await expect.poll(() =>
      page.locator('#playground').evaluate((el) => getComputedStyle(el).borderColor),
    ).toMatch(/rgb\(0,\s*128,\s*128\)/);
    await expect(page.locator('#log')).toContainText(/GM_getResourceText\("styleSheet"\)/);

    await page.close();
  });

  test('GM_getResourceText returns the JSON resource body as text', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-resource/gm-resource.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-json').click();
    await expect(page.locator('#log')).toContainText(
      /greeting="hello from a JSON resource", items=\[1,2,3\]/,
    );

    await page.close();
  });

  test('GM_getResourceURL produces a URL the page can render', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-resource/gm-resource.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-img').click();
    const img = page.locator('#imgSlot img');
    await expect(img).toHaveCount(1);
    const src = await img.getAttribute('src');
    // SM and VM mint a blob: URL; TM returns a base64 data: URL.
    expect(src).toMatch(setup.manager === 'tampermonkey' ? /^data:image\/svg\+xml;base64,/ : /^blob:/);
    // Either way the page can fetch it and gets the SVG back.
    const body = await page.evaluate(async (url) => {
      const res = await fetch(url);
      return res.text();
    }, src!);
    expect(body).toContain('<svg');

    await page.close();
  });

  test('Unknown resource name returns nothing from both APIs', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-resource/gm-resource.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-missing').click();
    // SM and VM return undefined; TM returns null.
    await expect(page.locator('#log')).toContainText(
      setup.manager === 'tampermonkey' ? /text=null, url=null/ : /text=undefined, url=undefined/,
    );

    await page.close();
  });
});
