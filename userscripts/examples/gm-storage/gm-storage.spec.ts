// E2E coverage for the gm-storage userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../../tests/fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-storage', () => {
  test('set then get round-trips a value', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-storage/gm-storage.html`);

    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#key').fill('demo-key');
    await page.locator('#value').fill('"hello-world"');
    await page.locator('#btn-set').click();
    await expect(page.locator('#output')).toContainText('setValue');
    await expect(page.locator('#output')).toContainText('hello-world');

    // Clear the input to prove the getValue read is coming from
    // storage and not echoing back the form field.
    await page.locator('#value').fill('');
    await page.locator('#btn-get').click();
    await expect(page.locator('#output')).toContainText('hello-world');

    await page.locator('#btn-list').click();
    await expect(page.locator('#output')).toContainText('demo-key');

    await page.locator('#btn-delete').click();
    await page.locator('#btn-get').click();
    await expect(page.locator('#output')).toContainText('(undefined)');

    await page.close();
  });

  test('bulk calls, with repeated keys and the change log', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-storage/gm-storage.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    const bulk = async (button: string, json: string) => {
      await page.locator('#bulk').fill(json);
      await page.locator(button).click();
      // Drop the label line; the rest is the result as JSON.
      return (await page.locator('#output').textContent())!.split('\n').slice(1).join('\n');
    };
    await bulk('#btn-set-many', '{"a":1,"b":2}');
    // A repeated key comes back once; an unset one is left out.
    expect(JSON.parse(await bulk('#btn-get-many', '["a","a","missing"]'))).toEqual({ a: 1 });
    expect(JSON.parse(await bulk('#btn-get-many', '{"a":0,"c":"dflt"}'))).toEqual({ a: 1, c: 'dflt' });
    // A repeated key deletes once.
    await bulk('#btn-delete-many', '["b","b"]');
    expect(JSON.parse(await bulk('#btn-get-many', '["a","b"]'))).toEqual({ a: 1 });

    // Managers differ on firing a listener for a delete that changes
    // nothing (Violentmonkey fires it), so check only the changes they
    // all report.
    const changes = (await page.locator('#changes').textContent())!.split('\n');
    expect(changes).toContain('a: undefined -> 1');
    expect(changes).toContain('b: undefined -> 2');
    expect(changes.filter((l) => l === 'b: 2 -> undefined')).toHaveLength(1);
    await page.close();
  });
});
