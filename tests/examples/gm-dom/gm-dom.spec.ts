// E2E coverage for the gm-dom userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/extension';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SourceMonkey routes any default-parent GM_addElement call to
// document.head (or documentElement). The example highlights this
// because TM/VM use a smarter "head for script/link/style/meta, body
// otherwise" split; tests pin SM's actual behavior here so a future
// change in defaults won't silently break the example's narrative.
test.describe('examples / gm-dom', () => {
  test('GM_addStyle injects CSS the playground picks up', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    const before = await page.locator('#playground').evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(before).not.toMatch(/rgb\(220,\s*20,\s*60\)/);

    await page.locator('#btn-style').click();
    await expect.poll(() =>
      page.locator('#playground').evaluate((el) => getComputedStyle(el).borderColor),
    ).toMatch(/rgb\(220,\s*20,\s*60\)/);

    await page.close();
  });

  test('GM_addElement (parent form) appends inside the playground', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-parent').click();
    await expect(page.locator('#playground span')).toContainText('span via parent form');

    await page.close();
  });

  test('GM_addElement (default form) appends into <head> on SM', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-default').click();
    await expect(page.locator('#log')).toContainText(/appended to <HEAD>/);
    const inHead = await page.evaluate(() =>
      Array.from(document.head.querySelectorAll('p')).some(
        (p) => p.textContent && p.textContent.includes('default parent'),
      ),
    );
    expect(inHead).toBe(true);

    await page.close();
  });

  test('Reset removes the injected style + elements', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // Inject style + a default-parent <p> + a parent-form <span>.
    await page.locator('#btn-style').click();
    await page.locator('#btn-default').click();
    await page.locator('#btn-parent').click();
    await expect.poll(() =>
      page.locator('#playground').evaluate((el) => getComputedStyle(el).borderColor),
    ).toMatch(/rgb\(220,\s*20,\s*60\)/);
    await expect(page.locator('#playground span')).toHaveCount(1);

    await page.locator('#btn-reset').click();

    // Style gone: border falls back to the document default.
    await expect.poll(() =>
      page.locator('#playground').evaluate((el) => getComputedStyle(el).borderColor),
    ).not.toMatch(/rgb\(220,\s*20,\s*60\)/);
    // Default-parent <p> gone from head.
    const stillInHead = await page.evaluate(() =>
      Array.from(document.head.querySelectorAll('p')).some(
        (p) => p.textContent && p.textContent.includes('default parent'),
      ),
    );
    expect(stillInHead).toBe(false);
    // Parent-form <span> gone.
    await expect(page.locator('#playground span')).toHaveCount(0);

    await page.close();
  });
});
