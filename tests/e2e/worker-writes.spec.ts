// Extension pages write through the service worker (docs/worker-writes.md):
//
//   - A page's enable click runs in the worker: the page writes nothing
//     itself, and the worker finds the related copies from its row cache,
//     reading no script rows or active times from storage once that is
//     loaded.
//   - The row cache follows the worker's own writes, and drops what it
//     holds when something else writes a row.
//   - A page can change only the settings the worker lists.
//   - The worker refuses to write a script row outside the store's lock,
//     and the extension-update backfills write under it.

import type { Page, Worker } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts, type SmApi, type StoredScriptLike } from '../fixtures/sw-api';

declare const self: { __smWorkerReads?: string[]; __smRestore?: (() => void)[] };
declare const window: Window & { __smPageWrites?: string[] };

// Record the worker's storage reads: `(keys)` for a key listing, else the
// keys read.
async function recordWorkerReads(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    const reads: string[] = [];
    self.__smWorkerReads = reads;
    const area = chrome.storage.local as { get: unknown; getKeys: unknown };
    const { get, getKeys } = area;
    (self.__smRestore ??= []).push(() => { area.get = get; area.getKeys = getKeys; });
    const innerGet = chrome.storage.local.get.bind(chrome.storage.local);
    const innerKeys = chrome.storage.local.getKeys.bind(chrome.storage.local);
    area.get = (key?: string | string[] | null) => {
      reads.push(...(key == null ? ['(everything)'] : Array.isArray(key) ? key : [key]));
      return innerGet(key as string[]);
    };
    area.getKeys = () => {
      reads.push('(keys)');
      return innerKeys();
    };
  });
}

async function takeWorkerReads(sw: Worker): Promise<string[]> {
  return sw.evaluate(() => (self.__smWorkerReads ?? []).splice(0));
}

async function recordPageWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__smPageWrites = [];
    const area = chrome.storage.local as { set: unknown; remove: unknown };
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    const remove = chrome.storage.local.remove.bind(chrome.storage.local);
    area.set = (items: Record<string, unknown>) => {
      window.__smPageWrites!.push(...Object.keys(items));
      return set(items);
    };
    area.remove = (keys: string | string[]) => {
      window.__smPageWrites!.push(...(Array.isArray(keys) ? keys : [keys]));
      return remove(keys);
    };
  });
}

test.describe('worker writes', () => {
  let dirs: ScriptsDir[];
  test.beforeEach(() => { dirs = []; });
  test.afterEach(async ({ getServiceWorker }) => {
    await (await getServiceWorker()).evaluate(() => {
      for (const restore of self.__smRestore ?? []) restore();
      self.__smRestore = [];
    });
    for (const d of dirs) d.cleanup();
  });

  async function addCopy(sm: SmApi): Promise<StoredScriptLike> {
    const dir = ScriptsDir.create();
    dirs.push(dir);
    dir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Shared Script', match: ['https://example.com/*'] },
      body: 'void 0;',
    });
    const collection = await sm.addCollection(dir.path);
    return (await allScripts(sm)).find((s) => s.collectionId === collection!.id)!;
  }

  test('a page\'s enable click runs in the worker, from its row cache', async ({
    extensionContext, extensionId, sm, getServiceWorker,
  }) => {
    await sm.setParseCheckEnabled(false);
    const a = await addCopy(sm);
    const b = await addCopy(sm);
    await sm.setScriptEnabled(a.id, true);
    await sm.setScriptEnabled(b.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const box = (id: string) => page.locator(`tr[data-script-id="${id}"] .toggle input`);
    await expect(box(a.id)).toBeChecked();
    await recordPageWrites(page);
    const sw = await getServiceWorker();
    // Loaded now, so the clicks below find it loaded.
    await sm.getAllScriptMetas();
    const loads = await sm.rowCacheLoads();
    await recordWorkerReads(sw);

    // What a click reads, up to the registration sync it starts. The sync
    // reads storage itself and starts with a key listing, which also
    // shows the recorder saw the worker's reads at all.
    const clickReads = async (): Promise<string[]> => {
      await sm.syncNow();
      const reads = await takeWorkerReads(sw);
      const sync = reads.indexOf('(keys)');
      expect(sync).toBeGreaterThanOrEqual(0);
      return reads.slice(0, sync);
    };
    await box(b.id).check();
    await expect(box(a.id)).not.toBeChecked();
    expect((await clickReads()).filter((k) => k.startsWith('script:') || k === 'enablementTimes')).toEqual([]);

    await box(a.id).check();
    await expect(box(b.id)).not.toBeChecked();
    expect((await clickReads()).filter((k) => k.startsWith('script:') || k === 'enablementTimes')).toEqual([]);
    expect(await sm.rowCacheLoads()).toBe(loads);
    expect(await page.evaluate(() => window.__smPageWrites)).toEqual([]);
    // The active times the worker planned from are the ones stored.
    const stored = await page.evaluate(async () => (await chrome.storage.local.get('enablementTimes')).enablementTimes);
    expect(await sm.getEnablementTimes()).toEqual(stored);
    await page.close();
  });

  test('the row cache follows the worker\'s writes and drops a row written elsewhere', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.setParseCheckEnabled(false);
    const a = await addCopy(sm);
    await sm.getAllScriptMetas();
    const loads = await sm.rowCacheLoads();

    await sm.setScriptEnabled(a.id, false);
    expect((await sm.getAllScriptMetas()).find((s) => s.id === a.id)!.enabled).toBe(false);
    expect(await sm.rowCacheLoads()).toBe(loads);

    // A write from a page: the worker's copy can't know it, so it drops
    // the copy and reads storage again.
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await page.evaluate(async (key: string) => {
      const row = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
      await chrome.storage.local.set({ [key]: { ...row, relativePath: 'elsewhere.user.js' } });
    }, `script:${a.id}`);
    await expect.poll(async () =>
      (await sm.getAllScriptMetas()).find((s) => s.id === a.id)!.relativePath).toBe('elsewhere.user.js');
    expect(await sm.rowCacheLoads()).toBe(loads + 1);
    await page.close();
  });

  test('a page can change only the settings the worker lists', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const call = (key: string) => page.evaluate((k) => new Promise<string>((resolve) => {
      const port = chrome.runtime.connect({ name: 'sm:op' });
      port.onMessage.addListener((reply: { ok: boolean; error?: string }) => {
        port.disconnect();
        resolve(reply.ok ? 'ok' : reply.error!);
      });
      port.postMessage({ op: 'writeSetting', args: [k, true] });
    }), key);
    expect(await call('smDebugLogging')).toBe('ok');
    expect(await call('firstRunComplete')).toContain('is not a setting a page may change');
    await page.close();
  });

  test('the worker refuses to write a script row outside the store\'s lock', async ({
    sm, getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    const outside = await sw.evaluate(() => chrome.storage.local.set({ 'script:unlocked': { id: 'unlocked' } })
      .then(() => 'written', (err: Error) => err.message));
    expect(outside).toContain('was written outside the store\'s write lock');
    // Other keys, and the same row under the lock, are fine.
    await sw.evaluate(() => chrome.storage.local.set({ 'gmval:x:y': 1 }));
    await sm.seedStorage({ 'script:unlocked': { id: 'unlocked' } });
  });

  test('an extension-update backfill writes its rows under the lock', async ({
    sm, getServiceWorker,
  }) => {
    const dir = ScriptsDir.create();
    dirs.push(dir);
    dir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Uses unsafeWindow', match: ['https://example.com/*'] },
      body: 'unsafeWindow.x = 1;',
    });
    const collection = await sm.addCollection(dir.path);
    const [a] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    expect(a.usesUnsafeWindow).toBe(true);
    // As a row written before the flag existed.
    const sw = await getServiceWorker();
    const key = `script:${a.id}`;
    const row = (await sw.evaluate(async (k: string) => chrome.storage.local.get(k), key))[key] as Record<string, unknown>;
    const { usesUnsafeWindow: _, ...old } = row;
    await sm.seedStorage({ [key]: old });

    expect(await sm.backfillUsesUnsafeWindow()).toBe(1);
    expect((await sm.getAllScriptMetas()).find((s) => s.id === a.id)!.usesUnsafeWindow).toBe(true);
  });
});
