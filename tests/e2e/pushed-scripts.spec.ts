// Pushed scripts: text handed to the extension over the test surface,
// for the development harness's extension backend. See
// docs/harness-design.md, "Extension backend".

import { test, expect } from '../fixtures/extension';
import { ScriptsDir, renderUserscript } from '../fixtures/scripts-dir';

function script(body: string, name = 'Pushed one'): string {
  return renderUserscript({
    relativePath: 'pushed.user.js',
    meta: { name, match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_getValue'] },
    body,
  });
}

test.describe('pushed scripts', () => {
  test('a pushed script runs on the next navigation, in a Pushed scripts collection', async ({ extensionContext, fixtureServer, sm }) => {
    const result = await sm.pushScript({ text: script(`document.getElementById('target').textContent = 'pushed';`) });
    expect(result.status).toBe('ok');
    expect(result.replaced).toBe(false);
    const collections = await sm.getCollections();
    expect(collections.map((c) => [c.path, c.displayName])).toEqual([['container:pushed', 'Pushed scripts']]);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('pushed');
    await page.close();
  });

  test('re-pushing the same name replaces the script in place and keeps its values', async ({ extensionContext, fixtureServer, sm }) => {
    const first = await sm.pushScript({ text: script(`GM_setValue('v', 1); document.getElementById('target').textContent = 'one';`) });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('one');
    await expect.poll(() => sm.getGmValues(first.scriptId)).toEqual({ v: 1 });

    const second = await sm.pushScript({ text: script(`document.getElementById('target').textContent = 'two:' + GM_getValue('v');`) });
    expect(second.scriptId).toBe(first.scriptId);
    expect(second.replaced).toBe(true);
    await page.reload();
    await expect(page.locator('#target')).toHaveText('two:1');
    await page.close();
  });

  test('an invalid push reports the extension\'s own diagnostic', async ({ sm }) => {
    const result = await sm.pushScript({ text: 'not a userscript at all', name: 'Broken' });
    expect(result.status).toBe('invalid');
    expect(result.errorMessage).toBeTruthy();
  });

  test('clearPushedScripts removes them all with their values', async ({ extensionContext, fixtureServer, sm }) => {
    const pushed = await sm.pushScript({ text: script(`GM_setValue('k', 'v'); document.getElementById('target').textContent = 'pushed';`) });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('pushed');
    await expect.poll(() => sm.getGmValues(pushed.scriptId)).toEqual({ k: 'v' });
    expect(await sm.clearPushedScripts()).toBe(1);
    expect(await sm.getCollections()).toEqual([]);
    expect(await sm.getGmValues(pushed.scriptId)).toEqual({});
    await page.reload();
    await expect(page.locator('#target')).toHaveText('original content');
    await page.close();
  });

  test('solo mode disables the other collections and restores them', async ({ extensionContext, fixtureServer, sm }) => {
    const dir = ScriptsDir.create();
    try {
      dir.write({
        relativePath: 'other.user.js',
        meta: { name: 'Other', match: ['*://*/target.html'], grant: ['none'] },
        body: `document.getElementById('target').dataset.other = 'ran';`,
      });
      const other = await sm.addCollection(dir.path);
      await sm.pushScript({ text: script(`document.getElementById('target').dataset.pushed = 'ran';`) });
      await sm.soloMode(true);
      expect((await sm.getCollections()).map((c) => [c.id === other!.id, c.enabled])).toEqual(
        expect.arrayContaining([[true, false], [false, true]]),
      );
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveAttribute('data-pushed', 'ran');
      await page.waitForTimeout(300);
      await expect(page.locator('#target')).not.toHaveAttribute('data-other', 'ran');

      await sm.soloMode(false);
      expect((await sm.getCollections()).every((c) => c.enabled)).toBe(true);
      await page.reload();
      await expect(page.locator('#target')).toHaveAttribute('data-other', 'ran');
      await page.close();
    } finally {
      dir.cleanup();
    }
  });
});
