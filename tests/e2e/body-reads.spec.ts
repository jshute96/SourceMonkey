// Which reads load script bodies (docs/storage.md#content-blobs): the
// bodies live in `blob:` rows, and only code that needs them reads them.
//
//   - Turning a script off, and the sync after it, read no bodies.
//   - Turning it back on reads its own bodies only, to register it.
//   - A full sync (a fresh worker's) sends nothing for a script Chrome
//     already holds exactly as specified, and the script still runs.
//   - A refresh that finds nothing new reads each body once, for the
//     copy it started from, and writes no script row or blob.
//   - A refresh puts back a body or a `@require` whose blob went
//     missing, though the row it rebuilds is the same as the stored one.

import path from 'node:path';
import fs from 'node:fs';

import type { Worker } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

type Raw = Record<string, unknown>;

declare const self: {
  __smBlobReads?: string[];
  __smWrites?: string[];
  __smUpdates?: { id: string; withCode: boolean }[];
  __smRestore?: (() => void)[];
};

// Undo the patches below, so later tests in this worker get the real
// functions.
async function restorePatches(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    for (const restore of self.__smRestore ?? []) restore();
    self.__smRestore = [];
  });
}

// Start recording the `blob:` keys the worker reads.
async function recordBlobReads(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    const reads: string[] = [];
    self.__smBlobReads = reads;
    const area = chrome.storage.local as { get: unknown };
    const original = area.get;
    (self.__smRestore ??= []).push(() => { area.get = original; });
    const inner = chrome.storage.local.get.bind(chrome.storage.local);
    area.get = (key?: string | string[] | null) => {
      if (key == null) reads.push('(everything)');
      else for (const k of Array.isArray(key) ? key : [key]) if (k.startsWith('blob:')) reads.push(k);
      return inner(key as string[]);
    };
  });
}

// Start recording the keys the worker writes.
async function recordWrites(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    const writes: string[] = [];
    self.__smWrites = writes;
    const area = chrome.storage.local as { set: unknown };
    const original = area.set;
    (self.__smRestore ??= []).push(() => { area.set = original; });
    const inner = chrome.storage.local.set.bind(chrome.storage.local);
    area.set = (items: Record<string, unknown>) => {
      writes.push(...Object.keys(items));
      return inner(items);
    };
  });
}

async function blobReads(sw: Worker): Promise<string[]> {
  return sw.evaluate(() => [...(self.__smBlobReads ?? [])]);
}

test.describe('body reads', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(async ({ getServiceWorker }) => {
    await restorePatches(await getServiceWorker());
    scriptsDir.cleanup();
  });

  function writeScripts(match: string): void {
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'window.__smLib = "lib";');
    for (const name of ['a', 'b']) {
      scriptsDir.write({
        relativePath: `${name}.user.js`,
        meta: {
          name: `Body reads ${name}`,
          match: [match],
          runAt: 'document-end',
          extra: ['// @require     lib.js'],
        },
        body: `document.getElementById("target").dataset.${name} = window.__smLib;`,
      });
    }
  }

  test('turning a script off reads no bodies, and back on reads only its own', async ({
    sm, getServiceWorker, fixtureServer,
  }) => {
    // No background parse check, which reads bodies when it records its
    // verdict and could land while the reads are recorded.
    await sm.setParseCheckEnabled(false);
    writeScripts(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    const [a, b] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    await sm.syncNow();

    const sw = await getServiceWorker();
    const rows = await sw.evaluate(async (keys: string[]) => chrome.storage.local.get(keys), [`script:${a.id}`, `script:${b.id}`]) as Raw;
    const refsOf = (row: Raw): string[] => [
      `blob:${(row.bodyBlobRef as { hash: string }).hash}`,
      ...(row.requires as { blobRef: { hash: string } }[]).map((r) => `blob:${r.blobRef.hash}`),
    ];
    const aRow = rows[`script:${a.id}`] as Raw;

    await recordBlobReads(sw);
    await sm.setScriptEnabled(a.id, false);
    const off = await sm.syncNow();
    expect(off.registered.map((r) => r.id)).not.toContain(a.id);
    expect(await blobReads(sw)).toEqual([]);
    // The write kept the row's bodies where they were.
    const after = (await sw.evaluate(async (key: string) => chrome.storage.local.get(key), `script:${a.id}`) as Raw)[`script:${a.id}`] as Raw;
    expect(after.bodyBlobRef).toEqual(aRow.bodyBlobRef);
    expect(after.enabled).toBe(false);

    await sm.setScriptEnabled(a.id, true);
    const on = await sm.syncNow();
    expect(on.registered.map((r) => r.id)).toContain(a.id);
    const reads = await blobReads(sw);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((k) => refsOf(aRow).includes(k))).toBe(true);
  });

  test('a full sync sends nothing for what Chrome already holds', async ({
    sm, getServiceWorker, fixtureServer, extensionContext,
  }) => {
    writeScripts(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    const [a, b] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    await sm.syncNow();

    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      const updates: { id: string; withCode: boolean }[] = [];
      self.__smUpdates = updates;
      const api = chrome.userScripts as unknown as { update: (s: { id: string; js?: unknown }[]) => Promise<void> };
      const original = api.update;
      (self.__smRestore ??= []).push(() => { api.update = original; });
      const inner = api.update.bind(api);
      api.update = (specs) => {
        for (const spec of specs) updates.push({ id: spec.id, withCode: spec.js !== undefined });
        return inner(specs);
      };
    });
    await sm.forgetRegistrationState();
    const sync = await sm.syncNow();
    expect(sync.kind).toBe('full');
    const updates = await sw.evaluate(() => self.__smUpdates ?? []);
    for (const id of [a.id, b.id]) {
      expect(updates.filter((u) => u.id === id)).toEqual([]);
    }

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-a', 'lib');
    await expect(page.locator('#target')).toHaveAttribute('data-b', 'lib');
    await page.close();
  });

  test('a refresh that finds nothing new reads each body once and writes no script row', async ({
    sm, getServiceWorker, fixtureServer,
  }) => {
    await sm.setParseCheckEnabled(false);
    writeScripts(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const sw = await getServiceWorker();
    const stored = await sw.evaluate(async () => chrome.storage.local.getKeys());
    const blobKeys = stored.filter((k) => k.startsWith('blob:'));
    await recordBlobReads(sw);
    await recordWrites(sw);
    await sm.updateCollection(collection!.id, 'manual');

    const reads = await blobReads(sw);
    expect(reads.sort()).toEqual([...blobKeys].sort());
    const writes = await sw.evaluate(() => self.__smWrites ?? []);
    expect(writes.filter((k) => k.startsWith('script:') || k.startsWith('blob:'))).toEqual([]);

    // The same for one script's refresh.
    const [a] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    await sw.evaluate(() => { self.__smBlobReads!.length = 0; self.__smWrites!.length = 0; });
    await sm.updateScript(a.id, 'opportunistic');
    const aRow = (await sw.evaluate(async (key: string) => chrome.storage.local.get(key), `script:${a.id}`) as Raw)[`script:${a.id}`] as Raw;
    const aKeys = [
      `blob:${(aRow.bodyBlobRef as { hash: string }).hash}`,
      ...(aRow.requires as { blobRef: { hash: string } }[]).map((r) => `blob:${r.blobRef.hash}`),
    ];
    expect((await blobReads(sw)).sort()).toEqual(aKeys.sort());
    const scriptWrites = await sw.evaluate(() => self.__smWrites ?? []);
    expect(scriptWrites.filter((k) => k.startsWith('script:') || k.startsWith('blob:'))).toEqual([]);
  });

  test('a refresh puts back a body whose blob went missing', async ({
    sm, getServiceWorker, fixtureServer,
  }) => {
    // Settled first, so no sync or parse check reads the script after
    // its blob goes and saves it `invalid`: the row the refresh compares
    // against has to be the same `ok` row it rebuilds.
    await sm.setParseCheckEnabled(false);
    writeScripts(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const [a] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const sw = await getServiceWorker();
    const key = `script:${a.id}`;
    const readRow = async () => (await sw.evaluate(async (k: string) => chrome.storage.local.get(k), key) as Raw)[key] as Raw;
    const row = await readRow();
    const blob = `blob:${(row.bodyBlobRef as { hash: string }).hash}`;
    await sw.evaluate(async (k: string) => chrome.storage.local.remove(k), blob);
    expect((await readRow()).status).toBe('ok');

    await sm.updateScript(a.id, 'manual');
    const keys = await sw.evaluate(async () => chrome.storage.local.getKeys());
    expect(keys).toContain(blob);
    const back = (await sm.getCollectionWithScripts(collection!.id))!.scripts.find((s) => s.id === a.id)!;
    expect(back.status).toBe('ok');
    expect(back.bodyText).toContain('dataset.a');
  });

  test('a refresh puts back a @require whose blob went missing', async ({
    sm, getServiceWorker, fixtureServer,
  }) => {
    await sm.setParseCheckEnabled(false);
    writeScripts(`${fixtureServer.baseUrl}/target.html`);
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const [a] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const sw = await getServiceWorker();
    const key = `script:${a.id}`;
    const row = (await sw.evaluate(async (k: string) => chrome.storage.local.get(k), key) as Raw)[key] as Raw;
    const blob = `blob:${(row.requires as { blobRef: { hash: string } }[])[0].blobRef.hash}`;
    await sw.evaluate(async (k: string) => chrome.storage.local.remove(k), blob);

    // The cheapest refresh: the one a navigation starts.
    await sm.updateScript(a.id, 'opportunistic');
    expect(await sw.evaluate(async () => chrome.storage.local.getKeys())).toContain(blob);
    const back = (await sm.getCollectionWithScripts(collection!.id))!.scripts.find((s) => s.id === a.id)!;
    expect(back.status).toBe('ok');
    expect(back.requires?.[0]?.source).toBe('window.__smLib = "lib";');
  });
});
