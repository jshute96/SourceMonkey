// The "deleted" and "modified" chips: a local file a page names that
// is no longer on disk, or differs from what was read, noticed at
// paint time rather than on the next refresh — and the collections
// page's per-collection "refresh pending" chip. Covers the
// viewer's Location and Local overrides rows, its versions table, and
// the collections page. See docs/file-changes.md.

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

const CHIP = '.file-change-chip';
const PENDING = '.collection-header .file-change-chip-pending';

test.describe('file-change chips', () => {
  let scriptsDir: ScriptsDir;
  let server: UserscriptServer;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    server = await UserscriptServer.start();
    server.setRoute('/lib/util.js', 'window.__SM_LOCAL = "remote";', {
      contentType: 'application/javascript',
    });
  });
  test.afterEach(async () => {
    scriptsDir.cleanup();
    await server.stop();
  });

  test('the viewer marks a deleted script file and a deleted stand-in', async ({
    extensionContext, extensionId, sm,
  }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Local Files',
        match: ['https://example.com/*'],
        extra: [`// @require     ${server.baseUrl}/lib/util.js`],
      },
      body: 'void window.__SM_LOCAL;',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.requires?.[0]?.localUrl).toBeTruthy();
    // A second copy of the same script, served over http, so the
    // versions panel has something to list: it only draws with more
    // than one copy. Its own row is not a local file and gets no chip.
    server.setRoute('/main.user.js', fs.readFileSync(path.join(scriptsDir.path, 'main.user.js'), 'utf8'));
    const webCollection = await sm.addCollection(`${server.baseUrl}/main.user.js`);
    const webCopy = (await sm.getCollectionWithScripts(webCollection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const location = page.locator('.filename-cell');
    const override = page.locator('.local-override-cell');
    await expect(location).toContainText('main.user.js');
    await expect(override).toContainText('util.js');
    // Both files are there: no chips. Settled by waiting for the panel
    // to have painted, then checking nothing was added.
    await expect(page.locator(CHIP)).toHaveCount(0);

    // The stand-in is edited (a different size). The row still holds
    // the old bytes, but the chip says the file has moved on.
    fs.appendFileSync(path.join(scriptsDir.path, 'util.js'), '// edited\n');
    await page.reload();
    await expect(override.locator(CHIP)).toHaveText('modified');
    await expect(override.locator(CHIP)).toHaveAttribute(
      'title', 'This file has changed on disk. The next refresh will load the new version.',
    );

    // Then it goes. The row still says the script loads it, but the
    // chip says the file is gone, and what the next refresh will do
    // about it.
    fs.rmSync(path.join(scriptsDir.path, 'util.js'));
    await page.reload();
    await expect(override.locator(CHIP)).toHaveText('deleted');
    await expect(override.locator(CHIP)).toHaveAttribute(
      'title', 'This file has been deleted. The next refresh will reload the remote version.',
    );
    await expect(location.locator(CHIP)).toHaveCount(0);

    // An edit to the script file itself: a different size, so the
    // listing can't agree with the row.
    fs.appendFileSync(path.join(scriptsDir.path, 'main.user.js'), '// edited\n');
    await page.reload();
    await expect(location.locator(CHIP)).toHaveText('modified');
    await expect(page.locator('#other-versions td.col-location ' + CHIP)).toHaveText('modified');

    // Then deleted. This is a directory collection, so the hint says
    // the row will go.
    fs.rmSync(path.join(scriptsDir.path, 'main.user.js'));
    await page.reload();
    await expect(location.locator(CHIP)).toHaveText('deleted');
    await expect(location.locator(CHIP)).toHaveAttribute(
      'title', 'This file has been deleted. The next refresh will remove this script.',
    );
    // The versions table names the same file, and marks it too — and
    // only it: the http copy's row has no file to be missing.
    await expect(page.locator('#other-versions td.col-location ' + CHIP)).toHaveText('deleted');
    await expect(page.locator('#other-versions ' + CHIP)).toHaveCount(1);

    // Refresh does what the tooltip promised — and, with another copy
    // in the versions table, moves the page onto it rather than
    // stranding it on a not-found line, the way the panel's trash can
    // does.
    await page.locator('#refresh-btn').click();
    await expect(page).toHaveURL(new RegExp(`script=${webCopy.id}`));
    await expect(page.locator('.filename-cell')).toContainText('main.user.js');
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts).toHaveLength(0);
    await page.close();
  });

  test('the collections page marks deleted, modified and new files until a refresh applies them', async ({
    extensionContext, extensionId, sm,
  }) => {
    for (const name of ['a.user.js', 'b.user.js', 'c.user.js']) {
      scriptsDir.write({
        relativePath: name,
        meta: { name, match: ['https://example.com/*'] },
        body: '',
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(3);
    await expect(section.locator(CHIP)).toHaveCount(0);

    // One deleted, one edited (a different size, so the listing can't
    // agree with the row whatever its mtime granularity), one new.
    scriptsDir.remove('a.user.js');
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'b.user.js', match: ['https://example.com/*'] },
      body: 'console.log("edited");\n',
    });
    scriptsDir.write({
      relativePath: 'd.user.js',
      meta: { name: 'd.user.js', match: ['https://example.com/*'] },
      body: '',
    });
    await page.reload();
    const rowA = section.locator('tbody tr', { hasText: 'a.user.js' });
    const rowB = section.locator('tbody tr', { hasText: 'b.user.js' });
    await expect(rowA.locator('td.name-cell ' + CHIP)).toHaveText('deleted');
    await expect(rowB.locator('td.name-cell ' + CHIP)).toHaveText('modified');
    await expect(rowB.locator('td.name-cell ' + CHIP)).toHaveAttribute(
      'title', 'This file has changed on disk. The next refresh will load the new version.',
    );
    await expect(section.locator(PENDING)).toHaveText('refresh pending');
    await expect(section.locator(PENDING)).toHaveAttribute(
      'title', '1 file modified, 1 file deleted, 1 new file on disk. Refresh to load.',
    );
    // The heading chip is the third; the two rows carry the others.
    await expect(section.locator(CHIP)).toHaveCount(3);

    // The refresh applies all three; chips and line go with it.
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator('tbody tr')).toHaveCount(3);
    await expect(section.locator('tbody tr', { hasText: 'd.user.js' })).toHaveCount(1);
    await expect(section.locator(CHIP)).toHaveCount(0);
    await page.close();
  });
  test('a file manifest collection marks its entries, and the manifest itself, until a refresh', async ({
    extensionContext, extensionId, sm,
  }) => {
    for (const name of ['a.user.js', 'b.user.js']) {
      scriptsDir.write({
        relativePath: name,
        meta: { name, match: ['https://example.com/*'] },
        body: '',
      });
    }
    const manifestPath = path.join(scriptsDir.path, 'script_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(['a.user.js', 'b.user.js']));
    const collection = await sm.addCollection(manifestPath);
    // The scan recorded a listing stat for each file:// entry, which is
    // what lets the refresh skip an unchanged one and a page report an
    // edited one.
    const rows = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    expect(rows.every((s) => s.fsMtime !== undefined)).toBe(true);
    expect((await sm.getCollections()).find((c) => c.id === collection!.id)!.manifestMtime).toBeDefined();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(2);
    await expect(section.locator(CHIP)).toHaveCount(0);

    // An entry edited: its row is marked, and the collection with it.
    fs.appendFileSync(path.join(scriptsDir.path, 'a.user.js'), '// edited\n');
    await page.reload();
    await expect(section.locator('tbody tr', { hasText: 'a.user.js' }).locator(CHIP)).toHaveText('modified');
    await expect(section.locator(PENDING)).toHaveAttribute('title', '1 file modified on disk. Refresh to load.');

    // The manifest edited too (its new entry exists, so nothing else
    // will read as deleted after the refresh).
    scriptsDir.write({
      relativePath: 'c.user.js',
      meta: { name: 'c.user.js', match: ['https://example.com/*'] },
      body: '',
    });
    fs.writeFileSync(manifestPath, JSON.stringify(['a.user.js', 'b.user.js', 'c.user.js']));
    await page.reload();
    await expect(section.locator(PENDING)).toHaveAttribute(
      'title', 'The manifest changed, 1 file modified on disk. Refresh to load.',
    );

    // An entry whose file is gone is marked, but a refresh keeps it
    // (the manifest still lists it) — unlike a directory collection.
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator(CHIP)).toHaveCount(0);
    fs.rmSync(path.join(scriptsDir.path, 'b.user.js'));
    await page.reload();
    await expect(section.locator('tbody tr', { hasText: 'b.user.js' }).locator(CHIP)).toHaveText('deleted');
    await expect(section.locator('tbody tr', { hasText: 'b.user.js' }).locator(CHIP)).toHaveAttribute(
      'title',
      'This file has been deleted. The last copy of the script keeps running until the entry is removed from the manifest.',
    );
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator('tbody tr', { hasText: 'b.user.js' })).toHaveCount(1);
    await page.close();
  });
  test('a single file added on its own is stat\'ed too, so it can read as modified', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'solo.user.js',
      meta: { name: 'Solo', match: ['https://example.com/*'] },
      body: '',
    });
    const file = path.join(scriptsDir.path, 'solo.user.js');
    const collection = await sm.addCollection(file);
    const row = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(row.fsMtime).toBeDefined();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(1);
    await expect(section.locator(CHIP)).toHaveCount(0);

    fs.appendFileSync(file, '// edited\n');
    await page.reload();
    await expect(section.locator('tbody tr').locator(CHIP)).toHaveText('modified');
    // A container is the user's list, not a directory: no collection
    // chip, and the row stays through a refresh with the file gone.
    await expect(section.locator(PENDING)).toHaveCount(0);
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator(CHIP)).toHaveCount(0);
    fs.rmSync(file);
    await page.reload();
    await expect(section.locator('tbody tr').locator(CHIP)).toHaveText('deleted');
    await expect(section.locator('tbody tr').locator(CHIP)).toHaveAttribute(
      'title', 'This file has been deleted. The last copy of the script keeps running until you remove it.',
    );
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator('tbody tr')).toHaveCount(1);
    await page.close();
  });
  test('the same file held by two collections is judged per row', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A directory collection and a manifest listing the same file: two
    // rows, each with the stat from its own last read. Refreshing one
    // must not clear the other's chip — that row still holds the old
    // bytes.
    scriptsDir.write({
      relativePath: 'shared.user.js',
      meta: { name: 'Shared', match: ['https://example.com/*'] },
      body: '',
    });
    const manifestPath = path.join(scriptsDir.path, 'script_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(['shared.user.js']));
    const dir = await sm.addCollection(scriptsDir.path);
    const man = await sm.addCollection(manifestPath);

    fs.appendFileSync(path.join(scriptsDir.path, 'shared.user.js'), '// edited\n');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const dirRow = page.locator(`section.collection[data-collection-id="${dir!.id}"] tbody tr`);
    const manRow = page.locator(`section.collection[data-collection-id="${man!.id}"] tbody tr`);
    await expect(dirRow.locator(CHIP)).toHaveText('modified');
    await expect(manRow.locator(CHIP)).toHaveText('modified');

    await sm.updateCollection(dir!.id, 'manual');
    await expect(dirRow.locator(CHIP)).toHaveCount(0);
    await expect(manRow.locator(CHIP)).toHaveText('modified');
    await page.close();
  });
  test('Refresh on the only copy of a deleted file says why the page emptied', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'only.user.js',
      meta: { name: 'Only', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await expect(page.locator('.filename-cell')).toContainText('only.user.js');
    scriptsDir.remove('only.user.js');
    await page.reload();
    await expect(page.locator('.filename-cell ' + CHIP)).toHaveText('deleted');
    // No other copy to move to: the not-found state, with the reason —
    // not the generic "not found in storage" wording.
    await page.locator('#refresh-btn').click();
    await expect(page.locator('#message')).toHaveText(
      'This script has been removed because its file was deleted',
    );
    await page.close();
  });

  // The versions panel's own buttons — the row for the copy on screen,
  // and Refresh all — take the same path as the page's Refresh when
  // the check drops that row: on to the next copy, not the not-found
  // line.
  for (const control of ['row button', 'Refresh all'] as const) {
    test(`the panel's ${control} on a deleted copy moves the page to the next copy`, async ({
      extensionContext, extensionId, sm,
    }) => {
      scriptsDir.write({
        relativePath: 'twin.user.js',
        meta: { name: 'Twin', match: ['https://example.com/*'] },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);
      const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      // Two more copies, so the panel is still drawn after the local
      // one is dropped (with one copy left it would hide itself).
      const text = fs.readFileSync(path.join(scriptsDir.path, 'twin.user.js'), 'utf8');
      server.setRoute('/twin.user.js', text);
      server.setRoute('/other/twin.user.js', text);
      // Both land in the one "Scripts from web" container.
      await sm.addCollection(`${server.baseUrl}/twin.user.js`);
      const web = await sm.addCollection(`${server.baseUrl}/other/twin.user.js`);
      const survivors = (await sm.getCollectionWithScripts(web!.id))!.scripts.map((s) => s.id);
      expect(survivors).toHaveLength(2);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
      await expect(page.locator('.filename-cell')).toContainText('twin.user.js');
      scriptsDir.remove('twin.user.js');
      await page.reload();
      await expect(page.locator('.filename-cell ' + CHIP)).toHaveText('deleted');

      const button = control === 'row button'
        ? page.locator('#other-versions tr.is-current td.col-actions button')
        : page.locator('#other-versions th.col-actions button');
      await button.click();
      // On to the next copy in the table — whichever of the two web
      // copies that is.
      await expect(page).toHaveURL(new RegExp(`script=(${survivors.join('|')})`));
      const shown = new URL(page.url()).searchParams.get('script')!;
      await expect(page.locator('.filename-cell')).toContainText('twin.user.js');
      await expect(page.locator('#message')).toBeEmpty();
      // The panel followed the page: its current row is the copy now
      // shown, not a repaint from the dropped copy's point of view —
      // and the dropped row is gone from it.
      await expect(page.locator('#other-versions tr.is-current'))
        .toHaveAttribute('data-script-id', shown);
      await expect(page.locator('#other-versions tbody tr')).toHaveCount(2);
      expect((await sm.getCollectionWithScripts(collection!.id))!.scripts).toHaveLength(0);
      await page.close();
    });
  }
});
