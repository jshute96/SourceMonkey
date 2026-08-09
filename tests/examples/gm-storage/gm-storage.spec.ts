// E2E coverage for the gm-storage userscript example.
//
// Doubles as the coverage for the shared API explorer's form path
// (tests/examples/lib/api-explorer.js): this is the example with
// several boxes on one page, and with a field kind (`jsonOrString`)
// whose parsing decides what actually gets stored.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-storage', () => {
  test.beforeEach(({ setup }) => {
    // The explorer library arrives via a relative `@require`, which is
    // a SourceMonkey extension — TM/VM/GM take absolute URLs only, and
    // TM installs these examples from a local file so it has no base
    // URL to resolve against even in principle. Same reason
    // require-scope and gm-resource skip.
    test.skip(setup.manager === 'tampermonkey',
      'TM requires absolute @require URLs; this example @requires the explorer library by relative path');
  });

  test('set then get round-trips a value through the forms', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-storage/gm-storage.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#field-set-key').fill('demo-key');
    await page.locator('#field-set-value').fill('"hello-world"');
    await page.locator('#submit-set').click();
    await expect(page.locator('#log')).toContainText('GM_setValue("demo-key", "hello-world")');

    // Read it back through the other box — a separate form, so this
    // can't be echoing the field that wrote it.
    await page.locator('#field-get-key').fill('demo-key');
    await page.locator('#submit-get').click();
    await expect(page.locator('#log li').first()).toContainText('returned "hello-world"');

    await page.locator('#submit-list').click();
    await expect(page.locator('#log li').first()).toContainText('demo-key');

    await page.locator('#field-delete-key').fill('demo-key');
    await page.locator('#submit-delete').click();
    await page.locator('#submit-get').click();
    await expect(page.locator('#log li').first()).toContainText('returned undefined');

    await page.close();
  });

  test('a preset runs its call and fills the form with the arguments it used', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-storage/gm-storage.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // A preset both calls and fills, and the object preset proves the
    // value is stored structured rather than as the text typed in.
    await page.locator('#btn-set-object').click();
    await expect(page.locator('#field-set-key')).toHaveValue('demo-object');
    await expect(page.locator('#field-set-value')).toHaveValue('{"a":1,"b":[true,null]}');
    await expect(page.locator('#log li').first())
      .toContainText('GM_setValue("demo-object", {"a":1,"b":[true,null]})');

    await page.locator('#field-get-key').fill('demo-object');
    await page.locator('#submit-get').click();
    await expect(page.locator('#log li').first()).toContainText('returned {"a":1,"b":[true,null]}');

    // Clear empties the box it belongs to and leaves the others alone.
    await page.locator('#clear-set').click();
    await expect(page.locator('#field-set-key')).toHaveValue('');
    await expect(page.locator('#field-get-key')).toHaveValue('demo-object');

    await page.close();
  });

  test('an omitted defaultValue is a different call from a supplied one', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-storage/gm-storage.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-get-missing').click();
    await expect(page.locator('#log li').first()).toContainText('GM_getValue("no-such-key")');
    await expect(page.locator('#log li').first()).toContainText('returned undefined');

    await page.locator('#btn-get-default').click();
    await expect(page.locator('#log li').first())
      .toContainText('GM_getValue("no-such-key", "(fallback)")');
    await expect(page.locator('#log li').first()).toContainText('returned "(fallback)"');

    // An empty required field isn't refused by the form — it goes
    // through as an omitted argument and the API answers for it.
    await page.locator('#clear-get').click();
    await page.locator('#submit-get').click();
    await expect(page.locator('[data-box="get"] .explorer-error')).toBeHidden();
    await expect(page.locator('#log li').first()).toContainText('GM_getValue()');

    await page.close();
  });
});
