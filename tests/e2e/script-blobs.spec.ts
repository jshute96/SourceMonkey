// Storage format 2 (docs/storage.md#content-blobs): script rows hold no
// bodies, which live in shared `blob:<sha256>` rows.
//
//   - Two copies of a script whose bodies match store that body once,
//     and a shared `@require` once too, while the rows read back whole.
//   - The one-time migration turns format 1 rows (bodies inline) into
//     small rows plus blobs, and the script still reads back the same
//     and still runs.
//   - A page's write waits for the worker's migration, asking for it by
//     message, so the migration can't overwrite it.
//   - A body a refresh replaced is deleted by the cleanup, once two
//     checks a wait apart found it unused.

import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

type Raw = Record<string, unknown>;

test.describe('script blobs', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // Two scripts with different headers and the same body, both
  // requiring the same library.
  function writeTwoCopies(match: string): void {
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'window.__smLib = "lib";');
    for (const [file, version] of [['a.user.js', '1.0'], ['b.user.js', '2.0']]) {
      scriptsDir.write({
        relativePath: file,
        meta: {
          name: `Copy ${version}`,
          match: [match],
          runAt: 'document-end',
          extra: [`// @version     ${version}`, '// @require     lib.js'],
        },
        body: 'document.getElementById("target").dataset.blob = window.__smLib;',
      });
    }
  }

  test('copies with the same body and the same @require store each once', async ({
    sm, getServiceWorker, fixtureServer,
  }) => {
    writeTwoCopies(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
    expect(data!.scripts.map((s) => s.status)).toEqual(['ok', 'ok']);
    // Read back whole, through the store.
    for (const s of data!.scripts) {
      expect(s.bodyText).toContain('dataset.blob');
      expect(s.requires?.[0]?.source).toBe('window.__smLib = "lib";');
    }

    const sw = await getServiceWorker();
    const raw = await sw.evaluate(async () => chrome.storage.local.get(null)) as Raw;
    const rows = Object.entries(raw).filter(([k]) => k.startsWith('script:')).map(([, v]) => v as Raw);
    for (const row of rows) {
      expect(row.bodyText).toBeUndefined();
      expect((row.requires as Raw[])[0].source).toBeUndefined();
    }
    // One body, one library.
    expect(Object.keys(raw).filter((k) => k.startsWith('blob:'))).toHaveLength(2);
    expect(raw.storeFormat).toBe(2);
  });

  test('the migration moves format 1 rows to blobs, and the script still runs', async ({
    sm, getServiceWorker, fixtureServer, extensionContext,
  }) => {
    writeTwoCopies(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    const before = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    // Only one copy runs at a time; turn the second off so the check
    // below is about the first.
    await sm.setScriptEnabled(before[1].id, false);
    const full = (await sm.getCollectionWithScripts(collection!.id))!.scripts;

    // Write the rows back as a format 1 profile has them: bodies inline,
    // no blobs, no format key.
    const sw = await getServiceWorker();
    await sw.evaluate(async (scripts: Raw[]) => {
      const keys = await chrome.storage.local.getKeys();
      await chrome.storage.local.remove([...keys.filter((k) => k.startsWith('blob:')), 'storeFormat']);
      await (self as unknown as { SourceMonkey: { seedStorage(items: Record<string, unknown>): Promise<void> } }).SourceMonkey.seedStorage(Object.fromEntries(scripts.map((s) => [`script:${s.id}`, s])));
    }, full as unknown as Raw[]);

    await sm.rerunStoreMigration();

    const raw = await sw.evaluate(async () => chrome.storage.local.get(null)) as Raw;
    expect(raw.storeFormat).toBe(2);
    for (const s of full) {
      const row = raw[`script:${s.id}`] as Raw;
      expect(row.bodyText).toBeUndefined();
      expect(row.bodyBlobRef).toBeTruthy();
    }
    expect(Object.keys(raw).filter((k) => k.startsWith('blob:'))).toHaveLength(2);
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts).toEqual(full);

    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-blob', 'lib');
    await page.close();
  });

  test('a page\'s write waits for the worker to migrate, and lands in format 2', async ({
    sm, getServiceWorker, fixtureServer, extensionContext, extensionId,
  }) => {
    writeTwoCopies(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    const full = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const active = full.find((s) => s.enabled)!;

    // A format 1 profile, in a worker that hasn't migrated yet.
    const sw = await getServiceWorker();
    await sw.evaluate(async (scripts: Raw[]) => {
      const keys = await chrome.storage.local.getKeys();
      await chrome.storage.local.remove([...keys.filter((k) => k.startsWith('blob:')), 'storeFormat']);
      await (self as unknown as { SourceMonkey: { seedStorage(items: Record<string, unknown>): Promise<void> } }).SourceMonkey.seedStorage(Object.fromEntries(scripts.map((s) => [`script:${s.id}`, s])));
    }, full as unknown as Raw[]);
    await sm.forgetStoreMigration();

    const page: Page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const box = page.locator(`tr[data-script-id="${active.id}"] .toggle input`);
    await expect(box).toBeChecked();
    await box.click();
    await expect(box).not.toBeChecked();
    await expect.poll(async () => (await sm.getCollectionWithScripts(collection!.id))!
      .scripts.find((s) => s.id === active.id)?.enabled).toBe(false);

    // The page's toggle made the worker migrate, then landed on the
    // converted row rather than being overwritten by it.
    const raw = await sw.evaluate(async () => chrome.storage.local.get(null)) as Raw;
    expect(raw.storeFormat).toBe(2);
    for (const s of full) expect((raw[`script:${s.id}`] as Raw).bodyText).toBeUndefined();
    expect((raw[`script:${active.id}`] as Raw).enabled).toBe(false);
    await page.close();
  });

  test('a body a refresh replaced is cleaned up after the wait, and the rest stay', async ({
    sm, getServiceWorker, fixtureServer,
  }) => {
    writeTwoCopies(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    const sw = await getServiceWorker();
    const blobKeys = async () => (await sw.evaluate(() => chrome.storage.local.getKeys()))
      .filter((k) => k.startsWith('blob:')).sort();
    const before = await blobKeys();
    expect(before).toHaveLength(2);

    // Give one copy a new body: the other copy still uses the old one.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Copy 1.0', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void "new body";',
    });
    await sm.updateCollection(collection!.id, 'manual');
    expect(await blobKeys()).toHaveLength(3);
    // Nothing unused yet.
    expect(await sm.sweepUnusedBlobs()).toEqual({ checked: 3, removed: 0 });

    // Now the second copy too: the old body is unused.
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'Copy 2.0', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void "new body";',
    });
    await sm.updateCollection(collection!.id, 'manual');
    // Deleted on the first check that finds it unused.
    expect(await sm.sweepUnusedBlobs()).toEqual({ checked: 3, removed: 1 });

    // The new shared body and the library are left, and read back.
    expect(await blobKeys()).toHaveLength(2);
    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    expect(scripts.map((s) => s.bodyText.trim())).toEqual(['void "new body";', 'void "new body";']);
    expect(scripts.map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});
