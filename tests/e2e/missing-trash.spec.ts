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
    const source = await sm.addSource(scriptsDir.path);
    expect(source).not.toBeNull();

    // Delete all three so they become 'missing' after a refresh.
    scriptsDir.remove('a.user.js');
    scriptsDir.remove('b.user.js');
    scriptsDir.remove('c.user.js');
    await sm.updateSource(source!.id, 'manual');
    await sm.syncNow();

    const ws = await sm.getSourceWithScripts(source!.id);
    const allMissing = ws!.scripts.every((s) => s.status === 'missing');
    expect(allMissing).toBe(true);
    expect(ws!.scripts).toHaveLength(3);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(3);
    await expect(section.locator('button.remove-script')).toHaveCount(3);

    // Click the first trash. Two rows + two trash buttons should remain.
    await section.locator('button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(2);
    await expect(section.locator('button.remove-script')).toHaveCount(2);

    // Click the next one. One should remain.
    await section.locator('button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(1);
    await expect(section.locator('button.remove-script')).toHaveCount(1);

    // And the last.
    await section.locator('button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(0);
    await expect(section.locator('button.remove-script')).toHaveCount(0);

    await page.close();
  });

  test('mixed ok + missing: clicking both missing trashes leaves the ok row intact', async ({
    extensionContext, extensionId, sm,
  }) => {
    // a, b, c on disk; we'll keep `a` and delete `b` and `c` so the
    // table has one ok row plus two missing rows.
    for (const name of ['a.user.js', 'b.user.js', 'c.user.js']) {
      scriptsDir.write({
        relativePath: name,
        meta: { name, match: ['https://example.com/*'] },
        body: '',
      });
    }
    const source = await sm.addSource(scriptsDir.path);
    scriptsDir.remove('b.user.js');
    scriptsDir.remove('c.user.js');
    await sm.updateSource(source!.id, 'manual');
    await sm.syncNow();

    const ws = await sm.getSourceWithScripts(source!.id);
    expect(ws!.scripts.filter((s) => s.status === 'missing')).toHaveLength(2);
    expect(ws!.scripts.filter((s) => s.status === 'ok')).toHaveLength(1);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(3);
    await expect(section.locator('button.remove-script')).toHaveCount(2);

    // Click the first trash. The other missing row should keep its trash.
    await section.locator('button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(2);
    await expect(section.locator('button.remove-script')).toHaveCount(1);

    // Click the remaining trash. The ok row should be the only thing
    // left, and no trash buttons remain.
    await section.locator('button.remove-script').first().click();
    await expect(section.locator('tbody tr')).toHaveCount(1);
    await expect(section.locator('button.remove-script')).toHaveCount(0);

    // The surviving row is the ok one (filename "a.user.js"); it
    // shouldn't carry a trash button.
    await expect(section.locator('tbody tr')).toHaveCount(1);
    // Filename link, not the favicon anchor (also an `<a>` in the row).
    await expect(section.locator('tbody tr td.name-cell a:not(.site-icon-inner)'))
      .toHaveText('a.user.js');

    // And the storage reflects only the ok row.
    const after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts).toHaveLength(1);
    expect(after!.scripts[0].relativePath).toBe('a.user.js');
    expect(after!.scripts[0].status).toBe('ok');
    expect(after!.source.scriptIds).toEqual([after!.scripts[0].id]);

    await page.close();
  });
});
