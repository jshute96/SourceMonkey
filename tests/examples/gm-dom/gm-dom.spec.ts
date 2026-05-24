// E2E coverage for the gm-dom userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/extension';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  test('GM_addElement (default form) sends <p> to <body>', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // Count body-level <p>s before/after so we don't accidentally
    // match a <p> the example page itself ships with.
    const beforeBodyPs = await page.evaluate(() =>
      Array.from(document.body.querySelectorAll('p'))
        .filter((p) => p.textContent && p.textContent.includes('default parent'))
        .length,
    );
    expect(beforeBodyPs).toBe(0);

    await page.locator('#btn-default').click();
    await expect(page.locator('#log')).toContainText(/appended to <BODY>/);

    const afterBodyPs = await page.evaluate(() =>
      Array.from(document.body.querySelectorAll('p'))
        .filter((p) => p.textContent && p.textContent.includes('default parent'))
        .length,
    );
    expect(afterBodyPs).toBe(1);
    // And nothing went to head.
    const inHead = await page.evaluate(() =>
      Array.from(document.head.querySelectorAll('p'))
        .some((p) => p.textContent && p.textContent.includes('default parent')),
    );
    expect(inHead).toBe(false);

    await page.close();
  });

  test('GM_addElement (default form) sends <title> to <head>; repeated calls stack', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await sm.addSource(__dirname);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    const originalTitle = await page.title();
    expect(originalTitle).toBe('Userscript examples for DOM injection');

    // Each click appends a new <title> to head. document.title
    // stays as the page's original title because the spec reads
    // from the FIRST <title> in tree order, not the last.
    await page.locator('#btn-title').click();
    await expect(page.locator('#log')).toContainText(/appended to <HEAD>/);
    await page.locator('#btn-title').click();
    await page.locator('#btn-title').click();

    const titlesInHead = await page.evaluate(
      () => document.head.querySelectorAll('title').length,
    );
    expect(titlesInHead).toBe(4); // 1 original + 3 appended
    const titlesInBody = await page.evaluate(
      () => document.body.querySelectorAll('title').length,
    );
    expect(titlesInBody).toBe(0);
    expect(await page.title()).toBe(originalTitle);

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

    await page.locator('#btn-style').click();
    await page.locator('#btn-parent').click();
    await page.locator('#btn-default').click();
    await page.locator('#btn-title').click();
    await expect.poll(() =>
      page.locator('#playground').evaluate((el) => getComputedStyle(el).borderColor),
    ).toMatch(/rgb\(220,\s*20,\s*60\)/);
    await expect(page.locator('#playground span')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.head.querySelectorAll('title').length),
    ).toBe(2); // original + 1 appended

    await page.locator('#btn-reset').click();

    // Style gone.
    await expect.poll(() =>
      page.locator('#playground').evaluate((el) => getComputedStyle(el).borderColor),
    ).not.toMatch(/rgb\(220,\s*20,\s*60\)/);
    // Default-parent <p> gone (was in body).
    const stillInBody = await page.evaluate(() =>
      Array.from(document.body.querySelectorAll('p'))
        .some((p) => p.textContent && p.textContent.includes('default parent')),
    );
    expect(stillInBody).toBe(false);
    // Parent-form <span> gone.
    await expect(page.locator('#playground span')).toHaveCount(0);
    // Appended <title> gone (head is back to just the original).
    expect(
      await page.evaluate(() => document.head.querySelectorAll('title').length),
    ).toBe(1);

    await page.close();
  });
});
