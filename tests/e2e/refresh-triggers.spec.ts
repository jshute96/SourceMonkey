// The collections page's targeted refresh triggers: `?refresh_local`
// (every local collection, nothing remote) and `?refresh_file=<path>`
// (the local collections and scripts covering one path). Both exist so
// a tool that just wrote files to disk can poke the extension without
// paying for a re-read of every http(s) collection.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('targeted refresh triggers', () => {
  let dirA: ScriptsDir;
  let dirB: ScriptsDir;
  let server: UserscriptServer;

  test.beforeEach(async () => {
    dirA = ScriptsDir.create();
    dirB = ScriptsDir.create();
    server = await UserscriptServer.start();
  });
  test.afterEach(async () => {
    dirA.cleanup();
    dirB.cleanup();
    await server.stop();
  });

  test('?refresh_local reloads local collections and leaves http ones alone', async ({
    extensionContext, extensionId, sm,
  }) => {
    dirA.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'console.log("v1");',
    });
    server.setRoute('/web.user.js', userscriptText('Web'));
    const local = await sm.addCollection(dirA.path);
    const web = await sm.addCollection(`${server.baseUrl}/web.user.js`);
    await sm.syncNow();
    const fetchesAfterAdd = server.requestLog.length;

    // Change the local file behind the extension's back, then poke it.
    // `rewriteBody` bumps the file's mtime, so the scan's size+mtime
    // skip doesn't hide the edit.
    dirA.rewriteBody('a.user.js', 'console.log("v2");');
    dirA.write({
      relativePath: 'added.user.js',
      meta: { name: 'Added', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html?refresh_local`);
    // The trigger scrubs itself once consumed, which is also our signal
    // that the refresh finished.
    await expect(page).toHaveURL(/collections\.html$/);

    const after = await sm.getCollectionWithScripts(local!.id);
    const names = after!.scripts.map((s) => s.relativePath).sort();
    expect(names).toEqual(['a.user.js', 'added.user.js']);
    expect(after!.scripts.find((s) => s.relativePath === 'a.user.js')!.bodyText)
      .toContain('v2');
    // The http collection was never re-read.
    expect(server.requestLog.length).toBe(fetchesAfterAdd);
    expect(web).not.toBeNull();
    await page.close();
  });

  test('?refresh_file reloads the collection covering the path and no other', async ({
    extensionContext, extensionId, sm,
  }) => {
    for (const dir of [dirA, dirB]) {
      dir.write({
        relativePath: 'a.user.js',
        meta: { name: 'A', match: ['https://example.com/*'] },
        body: 'console.log("v1");',
      });
    }
    const a = await sm.addCollection(dirA.path);
    const b = await sm.addCollection(dirB.path);
    await sm.syncNow();
    const priorB = (await sm.getCollectionWithScripts(b!.id))!.scripts[0].loadedAt;

    // Rewrite one file in A and add a sibling: naming the edited file
    // has to bring the whole scanned directory up to date, not just
    // that one row.
    dirA.rewriteBody('a.user.js', 'console.log("v2");');
    dirA.write({
      relativePath: 'sibling.user.js',
      meta: { name: 'Sibling', match: ['https://example.com/*'] },
      body: '',
    });
    // Change B too — it must NOT be picked up.
    dirB.rewriteBody('a.user.js', 'console.log("v2-b");');

    const target = encodeURIComponent(`${dirA.path}/a.user.js`);
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/collections.html?refresh_file=${target}`,
    );
    await expect(page).toHaveURL(/collections\.html$/);

    const afterA = await sm.getCollectionWithScripts(a!.id);
    expect(afterA!.scripts.map((s) => s.relativePath).sort())
      .toEqual(['a.user.js', 'sibling.user.js']);
    expect(afterA!.scripts.find((s) => s.relativePath === 'a.user.js')!.bodyText)
      .toContain('v2');

    const afterB = await sm.getCollectionWithScripts(b!.id);
    expect(afterB!.scripts).toHaveLength(1);
    expect(afterB!.scripts[0].loadedAt).toBe(priorB);
    expect(afterB!.scripts[0].bodyText).toContain('v1');
    await page.close();
  });

  test('?refresh_file naming an individually added script refreshes just that row', async ({
    extensionContext, extensionId, sm,
  }) => {
    dirA.write({
      relativePath: 'loose.user.js',
      meta: { name: 'Loose', match: ['https://example.com/*'] },
      body: 'console.log("v1");',
    });
    const file = `${dirA.path}/loose.user.js`;
    // A single `.user.js` lands in the local-files container, which has
    // no directory to re-scan — its rows are selected one by one.
    await sm.addCollection(file);
    await sm.syncNow();
    dirA.rewriteBody('loose.user.js', 'console.log("v2");');

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/collections.html`
      + `?refresh_file=${encodeURIComponent(file)}`,
    );
    await expect(page).toHaveURL(/collections\.html$/);

    const container = (await sm.getCollections())[0];
    const scripts = (await sm.getCollectionWithScripts(container.id))!.scripts;
    expect(scripts).toHaveLength(1);
    expect(scripts[0].bodyText).toContain('v2');
    await page.close();
  });

  test('a path no local collection covers reports it and stays in the URL', async ({
    extensionContext, extensionId, sm,
  }) => {
    dirA.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.addCollection(dirA.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/collections.html`
      + `?refresh_file=${encodeURIComponent(`${dirB.path}/nope.user.js`)}`,
    );
    const error = page.locator('#add-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText(
      'Refresh failed: No local collection or script covers',
    );
    // Left in place so the caller can see (and fix) what it asked for.
    await expect(page).toHaveURL(/refresh_file=/);
    await page.close();
  });

  test('a relative refresh path is rejected on shape', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/collections.html?refresh_file=scripts/a.user.js`,
    );
    const error = page.locator('#add-error');
    await expect(error).toContainText(
      'Refresh failed: A refresh path must be a file:// URL',
    );
    await expect(page).toHaveURL(/refresh_file=/);
    await page.close();
  });

  test('a root-resolving refresh path is refused rather than sweeping every collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    dirA.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'console.log("v1");',
    });
    const a = await sm.addCollection(dirA.path);
    await sm.syncNow();
    const prior = (await sm.getCollectionWithScripts(a!.id))!.scripts[0].loadedAt;
    dirA.rewriteBody('a.user.js', 'console.log("v2");');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html?refresh_file=%2F`);
    await expect(page.locator('#add-error')).toContainText(
      'Refresh failed: A refresh path must name something below the filesystem root',
    );
    await expect(page).toHaveURL(/refresh_file=/);

    const after = await sm.getCollectionWithScripts(a!.id);
    expect(after!.scripts[0].loadedAt).toBe(prior);
    await page.close();
  });
});
