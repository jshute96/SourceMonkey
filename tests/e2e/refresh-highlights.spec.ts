// What a refresh says it did to each row on the Collections page:
// `row-added` for a script that wasn't there before, `row-updated` for
// one that was re-read, `row-failed` over either when it came out
// broken, and a tombstone — an inert struck-through ghost — in the
// place a dropped script used to hold.
//
// The colour-clearing rules live in live-updates.spec.ts, with the rest
// of the repaint coverage; the ghosts' own lifetime is covered here.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('refresh row highlights', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a script that appears is marked new, not updated', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const a = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);

    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    await section.locator('button.refresh-collection').click();

    // By the name link, not row text: the size column carries a "B"
    // (bytes) that a plain text filter matches on every row.
    const rowB = section.locator('tr[data-script-id]').filter({
      has: page.getByRole('link', { name: 'B', exact: true }),
    });
    await expect(rowB).toHaveClass(/row-added/);
    await expect(rowB).not.toHaveClass(/row-updated/);
    // The untouched script keeps its plain row.
    const rowA = page.locator(`tr[data-script-id="${a.id}"]`);
    await expect(rowA).not.toHaveClass(/row-(added|updated|failed)/);

    await page.close();
  });

  test('a script that arrives broken is red and still marked new', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The two signals are independent: what happened to the row (new)
    // and how it came out (failed). A broken newcomer wears both.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);

    // No @name → invalid on arrival.
    scriptsDir.write({
      relativePath: 'broken.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });
    await section.locator('button.refresh-collection').click();

    const row = section.locator('tr[data-script-id]', { hasText: 'broken.user.js' });
    await expect(row).toHaveClass(/row-added/);
    await expect(row).toHaveClass(/row-failed/);

    await page.close();
  });

  test('a dropped script leaves an inert ghost that a reload clears', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A drop takes the row, its Log and its stored values with it and
    // can't be undone, so the ghost is the only place the user is told
    // it happened.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('tbody tr[data-script-id]')).toHaveCount(2);

    scriptsDir.remove('b.user.js');
    await section.locator('button.refresh-collection').click();

    // The record is gone…
    const ghost = section.locator('tbody tr[data-tombstone]');
    await expect(section.locator('tbody tr[data-script-id]')).toHaveCount(1);
    // …but the row is still on screen, inert, in the place B held.
    await expect(ghost).toHaveCount(1);
    await expect(ghost).toContainText('B');
    // "Removed" reads as a chip like New / Updated, but it is real text
    // in the cell — it is this row's whole status, so it has to be
    // selectable and readable by a screen reader.
    await expect(ghost.locator('td.status-cell .change-chip')).toHaveText('Removed');
    await expect(ghost).toHaveAttribute('aria-disabled', 'true');
    await expect(section.locator('tbody tr').last()).toHaveAttribute('data-tombstone', /./);
    // Nothing on the row is a link: the name has no viewer to open, and
    // the favicon — kept, so the row stays recognizable at a glance — is
    // painted without its href.
    await expect(ghost.locator('a[href]')).toHaveCount(0);
    await expect(ghost.locator('td.name-cell .site-icon')).toHaveCount(1);
    await expect(ghost.locator('input[type="checkbox"]')).toBeDisabled();
    // It isn't counted as a script row by the bulk toggle's census.
    await expect(ghost.locator('.toggle')).toHaveCount(0);
    // But its checkbox still lines up with the live rows' — being out of
    // the `.toggle` census must not put it out of the column.
    const ghostBox = (await ghost.locator('input[type="checkbox"]').boundingBox())!;
    const liveBox = (await section
      .locator('tbody tr[data-script-id] .toggle input[type="checkbox"]')
      .first().boundingBox())!;
    expect(Math.abs(ghostBox.x - liveBox.x)).toBeLessThanOrEqual(0.5);

    // A repaint driven from elsewhere keeps it: the ghost is cleared by
    // the next refresh, not by unrelated storage traffic.
    await sm.setCollectionEnabled(collection!.id, false);
    await sm.syncNow();
    await expect(ghost).toHaveCount(1);

    // A reload never rebuilds it — it lives in the DOM only.
    await page.reload();
    await expect(section.locator('tbody tr[data-tombstone]')).toHaveCount(0);
    await expect(section.locator('tbody tr[data-script-id]')).toHaveCount(1);

    await page.close();
  });

  test('a ghost stays under the row it was shown below, in name order', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Rows are listed by name, but stored in path order. The names here
    // reverse the paths, so a ghost anchored by stored order would land
    // in the wrong place.
    for (const [relativePath, name] of [['a.user.js', 'C'], ['b.user.js', 'B'], ['c.user.js', 'A']]) {
      scriptsDir.write({ relativePath, meta: { name, match: ['https://example.com/*'] }, body: '' });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const names = section.locator('tbody tr td.name-cell');
    await expect(names).toHaveText([/A/, /B/, /C/]);

    scriptsDir.remove('b.user.js');
    await section.locator('button.refresh-collection').click();

    await expect(section.locator('tbody tr[data-tombstone]')).toHaveCount(1);
    await expect(names).toHaveText([/A/, /B/, /C/]);
    await expect(section.locator('tbody tr').nth(1)).toHaveAttribute('data-tombstone', /./);
    await page.close();
  });

  test('a later refresh clears the ghost', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const refresh = section.locator('button.refresh-collection');

    scriptsDir.remove('b.user.js');
    await refresh.click();
    await expect(section.locator('tbody tr[data-tombstone]')).toHaveCount(1);

    // A refresh that changed something else still clears it: the ghost
    // belongs to the refresh that made it, not to the table.
    scriptsDir.rewriteBody('a.user.js', '/* v2 */\n');
    await refresh.click();
    await expect(section.locator('tbody tr[data-tombstone]')).toHaveCount(0);

    await page.close();
  });
});
