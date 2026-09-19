// The "deleted" chip: a local file a page names that is no longer on
// disk, noticed at paint time rather than on the next refresh. Covers
// the viewer's Location and Local overrides rows, its versions table,
// and the collections page. See docs/missing-files.md.

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

const CHIP = '.missing-file-chip';

test.describe('deleted-file chips', () => {
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
    await sm.addCollection(`${server.baseUrl}/main.user.js`);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const location = page.locator('.filename-cell');
    const override = page.locator('.local-override-cell');
    await expect(location).toContainText('main.user.js');
    await expect(override).toContainText('util.js');
    // Both files are there: no chips. Settled by waiting for the panel
    // to have painted, then checking nothing was added.
    await expect(page.locator(CHIP)).toHaveCount(0);

    // The stand-in goes. The row still says the script loads it — the
    // stored row hasn't changed — but the chip says the file is gone,
    // and what the next refresh will do about it.
    fs.rmSync(path.join(scriptsDir.path, 'util.js'));
    await page.reload();
    await expect(override.locator(CHIP)).toHaveText('deleted');
    await expect(override.locator(CHIP)).toHaveAttribute(
      'title', 'This file has been deleted. The next refresh will reload the remote version.',
    );
    await expect(location.locator(CHIP)).toHaveCount(0);

    // Then the script file itself. This is a directory collection, so
    // the hint says the row will go.
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

    // Refresh does what the tooltip promised, and says so — not the
    // generic "not found in storage" wording.
    await page.locator('#refresh-btn').click();
    await expect(page.locator('#message')).toHaveText(
      'This script has been removed because its file was deleted',
    );
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts).toHaveLength(0);
    await page.close();
  });

  test('the collections page marks a deleted file until the refresh drops it', async ({
    extensionContext, extensionId, sm,
  }) => {
    for (const name of ['a.user.js', 'b.user.js']) {
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
    await expect(section.locator('tbody tr')).toHaveCount(2);
    await expect(section.locator(CHIP)).toHaveCount(0);

    scriptsDir.remove('a.user.js');
    await page.reload();
    const rowA = section.locator('tbody tr', { hasText: 'a.user.js' });
    await expect(rowA.locator('td.name-cell ' + CHIP)).toHaveText('deleted');
    await expect(section.locator(CHIP)).toHaveCount(1);

    // The refresh drops the row, chip and all; the other row is
    // untouched and still unmarked.
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator('tbody tr')).toHaveCount(1);
    await expect(section.locator(CHIP)).toHaveCount(0);
    await page.close();
  });
});
