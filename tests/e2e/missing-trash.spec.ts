// Options-page trash-can on missing rows.
// Goal: clicking the trash on one missing row leaves the OTHER missing
// rows (with their own trash buttons) in place.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('missing-row trash-can', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('removing one missing row keeps the other missing rows', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Three valid scripts to start, all on disk.
    for (const name of ['a.user.js', 'b.user.js', 'c.user.js']) {
      scriptsDir.write({
        relativePath: name,
        meta: { name, match: ['https://example.com/*'] },
        body: '',
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    expect(collection).not.toBeNull();

    // Delete all three so they become 'missing' after a refresh.
    scriptsDir.remove('a.user.js');
    scriptsDir.remove('b.user.js');
    scriptsDir.remove('c.user.js');
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();

    const ws = await sm.getCollectionWithScripts(collection!.id);
    const allMissing = ws!.scripts.every((s) => s.status === 'missing');
    expect(allMissing).toBe(true);
    expect(ws!.scripts).toHaveLength(3);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(3);
    await expect(section.locator('.script-table button.remove-script')).toHaveCount(3);

    // Click the first trash. Two rows + two trash buttons should remain.
    await section.locator('.script-table button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(2);
    await expect(section.locator('.script-table button.remove-script')).toHaveCount(2);

    // Click the next one. One should remain.
    await section.locator('.script-table button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(1);
    await expect(section.locator('.script-table button.remove-script')).toHaveCount(1);

    // And the last.
    await section.locator('.script-table button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(0);
    await expect(section.locator('.script-table button.remove-script')).toHaveCount(0);

    await page.close();
  });

  test('trashing missing rows leaves another collection\'s ok row intact', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two collections on the page: one whose directory came back empty
    // (both rows missing) and one still holding a file. A collection
    // refresh can't leave that mix inside one collection — rows only
    // stay `missing` when the scan found nothing at all, and the next
    // non-empty scan drops whatever is still absent.
    const okDir = ScriptsDir.create();
    try {
      for (const name of ['b.user.js', 'c.user.js']) {
        scriptsDir.write({
          relativePath: name,
          meta: { name, match: ['https://example.com/*'] },
          body: '',
        });
      }
      okDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'a.user.js', match: ['https://example.com/*'] },
        body: '',
      });
      const gone = await sm.addCollection(scriptsDir.path);
      const kept = await sm.addCollection(okDir.path);
      scriptsDir.remove('b.user.js');
      scriptsDir.remove('c.user.js');
      await sm.updateCollection(gone!.id, 'manual');
      await sm.syncNow();

      const ws = await sm.getCollectionWithScripts(gone!.id);
      expect(ws!.scripts.filter((s) => s.status === 'missing')).toHaveLength(2);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const goneSection = page.locator(`section.collection[data-collection-id="${gone!.id}"]`);
      const keptSection = page.locator(`section.collection[data-collection-id="${kept!.id}"]`);
      await expect(goneSection.locator('tbody tr')).toHaveCount(2);
      await expect(goneSection.locator('.script-table button.remove-script')).toHaveCount(2);
      // The ok collection's row never gets the destructive button.
      await expect(keptSection.locator('.script-table button.remove-script')).toHaveCount(0);

      // Click the first trash. The other missing row keeps its trash.
      await goneSection.locator('.script-table button.remove-script').first().click();
      await expect(goneSection.locator('tbody tr')).toHaveCount(1);
      await expect(goneSection.locator('.script-table button.remove-script')).toHaveCount(1);

      // Click the remaining trash. That collection empties out; the
      // other one is untouched.
      await goneSection.locator('.script-table button.remove-script').first().click();
      await expect(goneSection.locator('tbody tr')).toHaveCount(0);
      await expect(keptSection.locator('tbody tr')).toHaveCount(1);
      // Name link, not the favicon anchor (also an `<a>` in the row).
      await expect(keptSection.locator('tbody tr td.name-cell a:not(.site-icon-inner)'))
        .toHaveText('a.user.js');

      // And the storage reflects both outcomes.
      const afterGone = await sm.getCollectionWithScripts(gone!.id);
      expect(afterGone!.scripts).toHaveLength(0);
      expect(afterGone!.collection.scriptIds).toEqual([]);
      const afterKept = await sm.getCollectionWithScripts(kept!.id);
      expect(afterKept!.scripts).toHaveLength(1);
      expect(afterKept!.scripts[0].status).toBe('ok');

      await page.close();
    } finally {
      okDir.cleanup();
    }
  });
});
