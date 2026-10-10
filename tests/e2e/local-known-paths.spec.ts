// A page load's checks read a `file://` script and its stand-ins at the
// paths the last check found, without listing any folder; the focus
// check and Refresh still search the roots. See
// docs/local-file-overrides.md#page-load-checks and `localLookup` on
// `RefreshBatch` in src/extension/script-store.ts.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';
import type { SmApi } from '../fixtures/sw-api';

// A 1x1 PNG, for a remote `@icon` with no local copy: the usual case,
// and one that used to list every root on each page load.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Wait for the page load's checks to stop listing, then zero the count,
// so the next window measures only the reload under test.
async function settleListings(sm: SmApi): Promise<void> {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && stable < 3) {
    const now = await sm.getDirectoryListingFetches();
    stable = now === last ? stable + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
  await sm.resetDirectoryListingFetches();
}

test.describe('page-load checks read known paths', () => {
  let scriptsDir: ScriptsDir;
  let libDir: ScriptsDir;
  let server: UserscriptServer;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    libDir = ScriptsDir.create('sourcemonkey-lib-');
    server = await UserscriptServer.start();
    server.setRoute('/lib/util.js', 'window.__SM_LOCAL = "remote";', {
      contentType: 'application/javascript',
    });
    server.setRoute('/icon.png', Buffer.from(PNG_1PX, 'base64'), { contentType: 'image/png' });
  });
  test.afterEach(async () => {
    scriptsDir.cleanup();
    libDir.cleanup();
    await server.stop();
  });

  // A script nested a level down, so its own folder and the collection
  // root are different roots, and a configured root after them.
  async function setUp(sm: SmApi, pageUrl: string): Promise<string> {
    scriptsDir.write({
      relativePath: 'sites/main.user.js',
      meta: {
        name: 'Known Paths',
        match: [`${pageUrl}/*`],
        runAt: 'document-end',
        injectInto: 'content',
        extra: [
          `// @require     ${server.baseUrl}/lib/util.js`,
          `// @icon        ${server.baseUrl}/icon.png`,
        ],
      },
      body: 'document.title = String(window.__SM_LOCAL);',
    });
    await sm.setLocalRoots([libDir.path]);
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    return collection!.id;
  }

  function writeLib(dir: string, body: string): string {
    const full = path.join(dir, 'lib', 'util.js');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  }

  test('a reload takes an edited stand-in without listing a folder', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const libPath = writeLib(libDir.path, 'window.__SM_LOCAL = "v1";');
    await setUp(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');

    await settleListings(sm);
    fs.writeFileSync(libPath, 'window.__SM_LOCAL = "v2";');
    await page.reload();
    await expect(page).toHaveTitle('v2');
    expect(await sm.getDirectoryListingFetches()).toBe(0);
    await page.close();
  });

  test('a reload keeps the script\'s listing mtime and takes the unchanged skip', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The add listed the folder; the reload reads the file. The two
    // must report the same mtime, or every check would rebuild and
    // rewrite the row.
    writeLib(libDir.path, 'window.__SM_LOCAL = "v1";');
    const id = await setUp(sm, fixtureServer.baseUrl);
    const before = (await sm.getCollectionWithScripts(id))!.scripts[0] as { fsMtime?: number; loadedAt: number };
    const scriptPath = path.join(scriptsDir.path, 'sites', 'main.user.js');
    expect(before.fsMtime).toBe(Math.floor(fs.statSync(scriptPath).mtimeMs / 1000));

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    await settleListings(sm);
    await page.reload();
    await expect(page).toHaveTitle('v1');
    await settleListings(sm);
    const after = (await sm.getCollectionWithScripts(id))!.scripts[0] as { fsMtime?: number; loadedAt: number };
    expect(after.fsMtime).toBe(before.fsMtime);
    expect(after.loadedAt).toBe(before.loadedAt);
    await page.close();
  });

  test('the modified time comes from the read, in listing units', async ({ sm }) => {
    // The "modified" chip compares the stored time with a later listing
    // of the folder, so a time taken from the read must equal what the
    // listing reports: whole seconds.
    const libPath = writeLib(libDir.path, 'window.__SM_LOCAL = "v1";');
    const id = await setUp(sm, 'https://example.com');
    const req = (await sm.getCollectionWithScripts(id))!.scripts[0].requires?.[0] as
      { localUrl?: string; fsMtime?: number } | undefined;
    expect(req?.localUrl).toBe(`file://${libPath}`);
    expect(req?.fsMtime).toBe(Math.floor(fs.statSync(libPath).mtimeMs / 1000));
  });

  test('a nearer copy that appears is taken by Refresh, not by a reload', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeLib(libDir.path, 'window.__SM_LOCAL = "configured";');
    const id = await setUp(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('configured');

    // The collection root comes before the configured root.
    writeLib(scriptsDir.path, 'window.__SM_LOCAL = "collection";');
    await page.reload();
    await expect(page).toHaveTitle('configured');

    const scriptId = (await sm.getCollectionWithScripts(id))!.scripts[0].id;
    await sm.updateScript(scriptId, 'manual', 'force');
    await sm.syncNow();
    await page.reload();
    await expect(page).toHaveTitle('collection');
    await page.close();
  });

  test('with no stand-in last time, a reload looks for none', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const id = await setUp(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('remote');

    await settleListings(sm);
    writeLib(libDir.path, 'window.__SM_LOCAL = "configured";');
    await page.reload();
    await expect(page).toHaveTitle('remote');
    expect(await sm.getDirectoryListingFetches()).toBe(0);

    // Refresh searches, and finds it.
    const scriptId = (await sm.getCollectionWithScripts(id))!.scripts[0].id;
    await sm.updateScript(scriptId, 'manual', 'force');
    await sm.syncNow();
    await page.reload();
    await expect(page).toHaveTitle('configured');
    await page.close();
  });

  test('a known stand-in that is gone falls back to the search', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const nearPath = writeLib(scriptsDir.path, 'window.__SM_LOCAL = "collection";');
    writeLib(libDir.path, 'window.__SM_LOCAL = "configured";');
    await setUp(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('collection');

    fs.rmSync(nearPath);
    await page.reload();
    await expect(page).toHaveTitle('configured');
    await page.close();
  });
});
