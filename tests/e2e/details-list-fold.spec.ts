// Long lists in the viewer's details panel (Match, Exclude, Network
// access, …) fold past a handful of items behind a "(N more)" bullet
// that expands them in place and offers to fold them back.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('details-panel list fold', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a long Match list shows the first items and a toggle for the rest', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'many.user.js',
      meta: {
        name: 'Many',
        match: Array.from({ length: 14 }, (_, i) => `https://h${i}.example/*`),
        exclude: Array.from({ length: 11 }, (_, i) => `https://x${i}.example/*`),
        connect: ['a.example', 'b.example'],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const id = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${id}`);

    const matchRow = page.locator('#header-summary dt', { hasText: 'Match' }).locator('+ dd');
    const items = matchRow.locator('li:not(.list-fold)');
    const visible = matchRow.locator('li:not(.list-fold):visible');
    const toggle = matchRow.locator('.list-fold-toggle');

    // Every item is in the DOM (so per-item work happens once); only
    // the first `LIST_FOLD_AT` show, then the toggle.
    await expect(items).toHaveCount(14);
    await expect(visible).toHaveCount(10);
    await expect(toggle).toHaveText('(4 more)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(visible.last()).toContainText('https://h9.example/*');

    await toggle.click();
    await expect(visible).toHaveCount(14);
    await expect(toggle).toHaveText('(show fewer)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await toggle.click();
    await expect(visible).toHaveCount(10);
    await expect(toggle).toHaveText('(4 more)');

    // A short list has no toggle.
    const connectRow = page.locator('#header-summary dt', { hasText: 'Network access' }).locator('+ dd');
    await expect(connectRow.locator('li')).toHaveCount(2);
    await expect(connectRow.locator('.list-fold-toggle')).toHaveCount(0);
    // Nor does one item over the fold: "(1 more)" would take the line it saves.
    const excludeRow = page.locator('#header-summary dt', { hasText: 'Exclude' }).locator('+ dd');
    await expect(excludeRow.locator('li:visible')).toHaveCount(11);
    await expect(excludeRow.locator('.list-fold-toggle')).toHaveCount(0);
    await page.close();
  });
});
