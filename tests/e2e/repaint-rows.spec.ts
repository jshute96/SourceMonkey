// The collections page repaints only the rows of scripts whose rows
// changed, when that's all that changed (`repaintScriptRows`), and
// everything otherwise:
//
//   - An enable toggle made elsewhere, or a refresh that changes a
//     script's status, re-reads just that row: not the collection list,
//     not every row.
//   - A collection toggle, or a refresh that renames a script, takes the
//     full repaint.

import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

declare const window: Window & { __smReads?: string[][] };

// Record the keys of every `chrome.storage.local.get` the page makes.
async function recordReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__smReads = [];
    const inner = chrome.storage.local.get.bind(chrome.storage.local);
    (chrome.storage.local as { get: unknown }).get = (key?: string | string[] | null) => {
      window.__smReads!.push(key == null ? ['(everything)'] : Array.isArray(key) ? [...key] : [key]);
      return inner(key as string[]);
    };
  });
}

async function takeReads(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const keys = (window.__smReads ?? []).flat();
    window.__smReads = [];
    return keys;
  });
}

test.describe('collections page row repaint', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  function writeScript(file: string, name: string, body = 'void 0;'): void {
    scriptsDir.write({ relativePath: file, meta: { name, match: ['https://example.com/*'] }, body });
  }

  test('a toggle or status change elsewhere repaints just that row', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Settled before recording: no parse check or sync left to write a
    // row while the reads below are counted.
    await sm.setParseCheckEnabled(false);
    writeScript('a.user.js', 'A');
    writeScript('b.user.js', 'B');
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const [a, b] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const rowB = page.locator(`tr[data-script-id="${b.id}"]`);
    await expect(rowB.locator('.toggle input')).toBeChecked();
    await expect(page.locator(`tr[data-script-id="${a.id}"]`)).toHaveAttribute('data-script-status', 'ok');
    await recordReads(page);

    await sm.setScriptEnabled(b.id, false);
    await expect(rowB.locator('.toggle input')).not.toBeChecked();
    await expect(rowB).toHaveClass(/disabled/);
    let reads = await takeReads(page);
    expect(reads).toContain(`script:${b.id}`);
    expect(reads).not.toContain('collections');
    expect(reads).not.toContain(`script:${a.id}`);

    // A refresh of one script that breaks it, keeping its name: a
    // `@match` Chrome can't use, which the header check refuses.
    scriptsDir.write({ relativePath: 'a.user.js', meta: { name: 'A', match: ['not a pattern'] }, body: 'void 0;' });
    await sm.updateScript(a.id, 'manual');
    const rowA = page.locator(`tr[data-script-id="${a.id}"]`);
    await expect(rowA).toHaveAttribute('data-script-status', 'invalid');
    reads = await takeReads(page);
    expect(reads).toContain(`script:${a.id}`);
    expect(reads).not.toContain('collections');
    await page.close();
  });

  test('a collection toggle or a rename takes the full repaint', async ({
    extensionContext, extensionId, sm,
  }) => {
    writeScript('a.user.js', 'A');
    const collection = await sm.addCollection(scriptsDir.path);
    const [a] = (await sm.getCollectionWithScripts(collection!.id))!.scripts;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const row = page.locator(`tr[data-script-id="${a.id}"]`);
    await expect(row).toBeVisible();
    await recordReads(page);

    await sm.setCollectionEnabled(collection!.id, false);
    await expect(section).toHaveClass(/disabled/);
    await expect(row).toHaveClass(/disabled/);
    expect(await takeReads(page)).toContain('collections');

    // A new @name changes the Name cell, which can move the row.
    writeScript('a.user.js', 'Renamed');
    await sm.updateScript(a.id, 'manual');
    await expect(row.locator('td.name-cell')).toContainText('Renamed');
    expect(await takeReads(page)).toContain('collections');
    await page.close();
  });
});
