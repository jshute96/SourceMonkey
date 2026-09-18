// E2E coverage for the gm-dom userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-dom', () => {
  test('GM_addStyle injects CSS the playground picks up', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

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
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-parent').click();
    await expect(page.locator('#playground span')).toContainText('span via parent form');

    await page.close();
  });

  test('GM_addElement (default form) inserts <p> somewhere in the document', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // Snapshot any <p>s that match our text before clicking. The
    // example page itself doesn't ship one with this text, so the
    // count should be 0; we still subtract to be robust.
    const beforeCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll('p'))
        .filter((p) => p.textContent && p.textContent.includes('default parent'))
        .length,
    );

    await page.locator('#btn-default').click();
    // Log line confirms GM_addElement returned an element and the
    // userscript captured *some* parent. Where managers route the
    // default parent for non-head tags is implementation-defined —
    // SM uses <body>, but we don't assert that here.
    await expect(page.locator('#log')).toContainText(/appended to </);

    const afterCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll('p'))
        .filter((p) => p.textContent && p.textContent.includes('default parent'))
        .length,
    );
    expect(afterCount).toBe(beforeCount + 1);

    await page.close();
  });

  test('GM_addElement (default form) sends <title> to <head>; repeated calls stack', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-dom/gm-dom.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    const originalTitle = await page.title();
    expect(originalTitle).toBe('Userscript examples for DOM injection');

    // Each click appends a new <title>. document.title stays as the
    // page's original title because the spec reads from the FIRST
    // <title> in tree order, not the last — true wherever the new
    // ones land.
    //
    // WHICH parent they land in is a manager difference, so the
    // assertion accepts either: SM routes `title` to <head>, VM's
    // head list stops at `meta` so it appends to <body>. SM's rule is
    // enforced strictly in tests/e2e/gm-dom.spec.ts.
    await page.locator('#btn-title').click();
    await expect(page.locator('#log')).toContainText(/appended to <(HEAD|BODY)>/);
    await page.locator('#btn-title').click();
    await page.locator('#btn-title').click();

    const titles = await page.evaluate(
      () => document.querySelectorAll('title').length,
    );
    expect(titles).toBe(4); // 1 original + 3 appended
    expect(await page.title()).toBe(originalTitle);

    await page.close();
  });

  test('Reset removes the injected style + elements', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

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
    // Document-wide, not head-only: managers disagree on where a
    // parentless <title> goes (see the default-form test above).
    expect(
      await page.evaluate(() => document.querySelectorAll('title').length),
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
    // Appended <title> gone (the document is back to just the original).
    expect(
      await page.evaluate(() => document.querySelectorAll('title').length),
    ).toBe(1);

    await page.close();
  });
});
