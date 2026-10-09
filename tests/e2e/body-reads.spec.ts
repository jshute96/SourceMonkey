// Which reads load script bodies (docs/storage.md#content-blobs): the
// bodies live in `blob:` rows, and only code that needs them reads them.
//
//   - Turning a script off, and the sync after it, read no bodies.
//   - Turning it back on reads its own bodies only, to register it.
//   - A full sync (a fresh worker's) leaves out of its updates the code
//     Chrome already holds, and the script still runs.

import path from 'node:path';
import fs from 'node:fs';

import type { Worker } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

type Raw = Record<string, unknown>;

declare const self: {
  __smBlobReads?: string[];
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

  test('a full sync leaves out the code Chrome already holds', async ({
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
      expect(updates.filter((u) => u.id === id)).toEqual([{ id, withCode: false }]);
    }

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-a', 'lib');
    await expect(page.locator('#target')).toHaveAttribute('data-b', 'lib');
    await page.close();
  });
});
