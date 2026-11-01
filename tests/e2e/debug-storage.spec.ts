// The storage debug page (/debug/storage.html): storage by script, by
// stored file, and in GM values, with sortable columns.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('/debug/storage.html page', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  test('shows scripts, shared files and GM values', async ({
    extensionContext, extensionId, getServiceWorker, sm,
  }) => {
    // Two scripts share one @require; the big one also has a big body.
    dir.writeRaw('lib/shared.js', `// shared\n${'x'.repeat(4000)}\n`);
    dir.write({
      relativePath: 'big.user.js',
      meta: { name: 'Big Script', match: ['*://*/*'], grant: ['GM_setValue'], extra: ['// @require lib/shared.js'] },
      body: `// ${'b'.repeat(8000)}\n`,
    });
    dir.write({
      relativePath: 'small.user.js',
      meta: { name: 'Small Script', match: ['*://*/*'], extra: ['// @require lib/shared.js'] },
      body: '// small\n',
    });
    const collection = await sm.addCollection(dir.path);
    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const big = scripts.find((s) => s.relativePath === 'big.user.js')!;
    const sw = await getServiceWorker();
    await sw.evaluate((id) => chrome.storage.local.set({ [`gmval:${id}:k`]: 'v'.repeat(3000) }), big.id);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/debug/storage.html`);
    await expect(page.locator('header.page-header h1')).toContainText('Storage');

    // By script, largest first; the shared @require shows its 2 copies.
    const groups = page.locator('#storage-table tbody.group');
    await expect(page.locator('#storage-summary')).toHaveText(
      '2 scripts in 1 collection. Shared files are counted once in each script that references them.');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator('tr.group-head')).toContainText('Big Script');
    await expect(groups.nth(1).locator('tr.group-head')).toContainText('Small Script');
    const req = groups.nth(0).locator('tr.group-item', { hasText: '@require' });
    await expect(req.locator('td.num').nth(1)).toHaveText('2');
    await expect(groups.nth(0).locator('tr.group-item', { hasText: 'metadata' }).locator('td.num').nth(1)).toHaveText('');
    // Its GM values, as one line; the script without any has none.
    await expect(groups.nth(0).locator('tr.group-item', { hasText: 'stored values' }).locator('td.num').nth(0)).toHaveText('3 KB');
    await expect(groups.nth(1).locator('tr.group-item', { hasText: 'stored values' })).toHaveCount(0);
    // The script link opens its viewer; the collection link the collections page.
    await expect(groups.nth(0).locator('tr.group-head a').nth(1))
      .toHaveAttribute('href', `../userscript.html?script=${big.id}`);
    await expect(groups.nth(0).locator('tr.group-head a').nth(0)).toHaveAttribute('href', /^chrome-extension:\/\/[^/]+\/collections\.html#collection-/);

    // Sorting by script name puts Big first ascending, then flips.
    const scriptHeading = page.locator('th[data-sort="script"]');
    await scriptHeading.click();
    await expect(groups.nth(0).locator('tr.group-head')).toContainText('Big Script');
    await scriptHeading.click();
    await expect(groups.nth(0).locator('tr.group-head')).toContainText('Small Script');
    await expect(scriptHeading).toHaveAttribute('aria-sort', 'descending');

    // By file: the shared @require is one group with both scripts.
    await page.getByRole('button', { name: 'By file' }).click();
    await expect(page).toHaveURL(/#file$/);
    const shared = groups.filter({ hasText: 'shared.js' });
    await expect(shared).toHaveCount(1);
    await expect(shared.locator('tr.group-head td.num').nth(1)).toHaveText('2');
    await expect(shared.locator('tr.group-head')).toContainText('@require');
    // The first use shares the heading's line.
    await expect(shared.locator('tr.group-head')).toContainText('Big Script');
    await expect(shared.locator('tr.group-item')).toHaveCount(1);
    // Here only Size and Shared copies sort.
    await expect(page.locator('th.sortable')).toHaveText([/Size/, /Shared copies/]);

    // Stored values: only the script that has some.
    await page.getByRole('button', { name: 'Stored values', exact: true }).click();
    await expect(groups).toHaveCount(1);
    await expect(groups.nth(0)).toContainText('Big Script');
    await expect(groups.nth(0).locator('td.num').nth(0)).toHaveText('3 KB');
    await expect(groups.nth(0).locator('td.num').nth(1)).toHaveText('1');

    // The view survives a reload, and the page follows storage changes.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Stored values', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sw.evaluate((id) => chrome.storage.local.set({ [`gmval:${id}:k2`]: 1 }), big.id);
    await expect(groups.nth(0).locator('td.num').nth(1)).toHaveText('2');
    await page.close();
  });

  test('the trash can deletes a script\'s values, asking first for an installed one', async ({
    extensionContext, extensionId, fixtureServer, getServiceWorker, sm,
  }) => {
    // Shows its value of `a` on the page, as its listener hears it.
    dir.write({
      relativePath: 'keeper.user.js',
      meta: {
        name: 'Keeper', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end',
        grant: ['GM_getValue', 'GM_addValueChangeListener'],
      },
      body: `
        document.body.dataset.a = String(GM_getValue('a'));
        GM_addValueChangeListener('a', (_k, _o, n) => { document.body.dataset.a = String(n); });
      `,
    });
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const live = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    await sm.writeGmValues(live.id, [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
    await sm.gmValuesSaved();
    const site = await extensionContext.newPage();
    await site.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(site.locator('body')).toHaveAttribute('data-a', '1');
    // Values whose script row is gone.
    const sw = await getServiceWorker();
    const gone = '00000000-0000-4000-8000-000000000000';
    await sw.evaluate((id) => chrome.storage.local.set({ [`gmval:${id}:k`]: 'v' }), gone);
    const valueOwners = async () => [...new Set(await sw.evaluate(async () =>
      Object.keys(await chrome.storage.local.get(null))
        .filter((k) => k.startsWith('gmval:'))
        .map((k) => k.split(':')[1])))].sort();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/debug/storage.html#values`);
    const groups = page.locator('#storage-table tbody.group');
    await expect(groups).toHaveCount(2);
    const trash = (text: string) => groups.filter({ hasText: text })
      .getByRole('button', { name: /^Delete \d+ stored values? for this script$/ });

    // A removed script's go on the click.
    await expect(trash('Removed script')).toHaveAttribute('title', 'Delete 1 stored value for this script');
    await trash('Removed script').click();
    await expect(groups).toHaveCount(1);
    await expect(page.locator('dialog.confirm-dialog')).not.toBeVisible();

    // An installed script's ask first, naming it and its collection.
    const dialog = page.locator('dialog.confirm-dialog');
    await trash('Keeper').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dlg-title')).toHaveText('Delete 2 stored values for this script?');
    await expect(dialog.locator('.dlg-body')).toContainText('Keeper');
    await expect(dialog.locator('.dlg-body')).toContainText('Collection');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    expect(await valueOwners()).toEqual([live.id]);

    await trash('Keeper').click();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#storage-empty')).toHaveText('No scripts have stored values.');
    await sm.gmValuesSaved();
    expect(await valueOwners()).toEqual([]);
    expect(await sm.getGmValues(live.id)).toEqual({});
    // The tab running it heard the delete.
    await expect(site.locator('body')).toHaveAttribute('data-a', 'undefined');
    await site.close();
    await page.close();
  });

  test('the Options page links to the debug pages', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator('#storage a[href="debug/storage.html"]')).toBeVisible();
    await expect(page.locator('#storage a[href="debug/icons.html"]')).toBeVisible();
    await page.close();
  });
});
