// The backup export (src/extension/export-backup.ts,
// src/extension/export-dialog.ts): the ⋯ menus on the collections page
// open the dialog, and Export writes the zip described in
// docs/export-format.md#sourcemonkey.
//
// `testWithBrowserDownloads`, as for local copies: the export reads the
// saved file's path back from `chrome.downloads`, which Playwright's
// download interception would hide.
import { testWithBrowserDownloads as test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { readZip } from '../fixtures/zip-read.mjs';
import fs from 'node:fs';

const DIALOG = 'dialog.export-dialog';
const RESULT = `${DIALOG} #export-result`;

// Open the collections page and export through `menuButton`'s menu.
async function exportVia(page: Page, menuButton: string, options: { files?: boolean } = {}): Promise<string> {
  // Headless Chrome can't show a Save As (see `saveFile`).
  await page.evaluate(() => { (globalThis as { smExportSkipSaveAs?: boolean }).smExportSkipSaveAs = true; });
  await page.locator(menuButton).click();
  await page.locator('.menu button', { hasText: /^Export/ }).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  if (options.files) await page.locator(`${DIALOG} #export-files`).check();
  await page.locator(`${DIALOG} #export-confirm-btn`).click();
  await expect(page.locator(RESULT)).toBeVisible();
  return await page.locator(`${RESULT} #export-saved-path`).innerText();
}

test.describe('backup export', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('exports every collection with values, manifest and TM metadata', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'alpha.user.js',
      meta: { name: 'Alpha', match: ['https://example.com/*'] },
      body: 'console.log("alpha");\n',
    });
    scriptsDir.write({
      relativePath: 'sub/beta.user.js',
      meta: { name: 'Beta', match: ['https://example.com/*'] },
      body: 'console.log("beta");\n',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const { scripts } = (await sm.getCollectionWithScripts(collection!.id))!;
    const alpha = scripts.find((s) => s.relativePath === 'alpha.user.js')!;
    const beta = scripts.find((s) => s.relativePath === 'sub/beta.user.js')!;
    await sm.setScriptEnabled(beta.id, false);
    await sm.writeGmValues(alpha.id, [
      { key: 'theme', value: 'dark' },
      { key: 'count', value: 3 },
      { key: 'cfg', value: { a: 1 } },
    ]);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const saved = await exportVia(page, '#page-menu');
    await expect(page.locator(RESULT)).toContainText('Exported 2 scripts');

    const entries = readZip(fs.readFileSync(saved));
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(entries[0].path).toBe('script_manifest.json');
    expect([...byPath.keys()].sort()).toEqual([
      'Alpha/Alpha.options.json', 'Alpha/Alpha.storage.json', 'Alpha/Alpha.user.js',
      'Beta/Beta.options.json', 'Beta/Beta.user.js', 'script_manifest.json',
    ]);

    const manifest = JSON.parse(byPath.get('script_manifest.json')!.data.toString('utf8'));
    expect(manifest).toMatchObject({ created_by: 'SourceMonkey', format: 'sourcemonkey-export', version: 1 });
    expect(manifest.collections).toEqual([{
      uuid: collection!.id,
      name: expect.any(String),
      kind: 'directory',
      location: scriptsDir.path,
      enabled: true,
      local_files: true,
    }]);
    expect(manifest.scripts).toEqual(expect.arrayContaining([
      { path: 'Alpha/Alpha.user.js', uuid: alpha.id, collection: collection!.id, location: `${scriptsDir.path}/alpha.user.js`, enabled: true },
      { path: 'Beta/Beta.user.js', uuid: beta.id, collection: collection!.id, location: `${scriptsDir.path}/sub/beta.user.js`, enabled: false },
    ]));

    expect(byPath.get('Alpha/Alpha.user.js')!.data.toString('utf8'))
      .toBe(fs.readFileSync(`${scriptsDir.path}/alpha.user.js`, 'utf8'));
    const betaOptions = JSON.parse(byPath.get('Beta/Beta.options.json')!.data.toString('utf8'));
    // A local file has no URL for TM or VM to update from.
    expect(betaOptions.meta).toEqual({ name: 'Beta', uuid: beta.id, modified: expect.any(Number) });
    expect(betaOptions.settings).toEqual({ enabled: false, position: expect.any(Number) });
    expect(betaOptions.options).toEqual({ check_for_updates: false });

    const storage = JSON.parse(byPath.get('Alpha/Alpha.storage.json')!.data.toString('utf8'));
    expect(storage.data).toEqual({ theme: 'sdark', count: 'n3', cfg: 'o{"a":1}' });
    await page.close();
  });

  test('a collection\'s menu exports just that collection, with its dependency files', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.writeRaw('lib/util.js', 'window.util = 1;\n');
    scriptsDir.write({
      relativePath: 'uses-lib.user.js',
      meta: { name: 'Uses lib', match: ['https://example.com/*'], extra: ['// @require lib/util.js'] },
      body: 'console.log(window.util);\n',
    });
    const other = ScriptsDir.create();
    other.write({ relativePath: 'other.user.js', meta: { name: 'Other', match: ['https://example.com/*'] }, body: '' });
    try {
      const collection = await sm.addCollection(scriptsDir.path);
      await sm.addCollection(other.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const section = `.collection[data-collection-id="${collection!.id}"]`;
      const saved = await exportVia(page, `${section} button.collection-menu`, { files: true });

      const entries = readZip(fs.readFileSync(saved));
      const paths = entries.map((e) => e.path);
      expect(paths).toContain('Uses lib/Uses lib.user.js');
      expect(paths.some((p) => p.endsWith('Other.user.js'))).toBe(false);
      // A relative `@require` is bundled at its own path in the script's
      // folder, where it resolves from the unzipped script.
      const dep = entries.find((e) => e.path === 'Uses lib/lib/util.js');
      expect(dep?.data.toString('utf8')).toBe('window.util = 1;\n');
      const manifest = JSON.parse(entries[0].data.toString('utf8'));
      expect(manifest.collections.map((c: { uuid: string }) => c.uuid)).toEqual([collection!.id]);
      await page.close();
    } finally {
      other.cleanup();
    }
  });

  test('the unzipped export loads as a manifest collection, odd names included', async ({
    extensionContext, extensionId, sm,
  }) => {
    for (const name of ['Tools #2 100%', 'Café ünïcode', 'Plain']) {
      scriptsDir.write({
        relativePath: `${name.replace(/[^A-Za-z]/g, '')}.user.js`,
        meta: { name, match: ['https://example.com/*'], extra: ['// @require lib/util.js'] },
        body: '',
      });
    }
    scriptsDir.writeRaw('lib/util.js', 'window.util = 1;\n');
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const saved = await exportVia(page, '#page-menu', { files: true });
    await page.close();

    const unzipped = ScriptsDir.create('sourcemonkey-unzipped-');
    try {
      for (const e of readZip(fs.readFileSync(saved))) unzipped.writeRaw(e.path, e.data.toString('utf8'));
      const manifest = await sm.addCollection(`${unzipped.path}/script_manifest.json`);
      const { scripts } = (await sm.getCollectionWithScripts(manifest!.id))!;
      expect(scripts.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
      // Each loads its `@require` from the copy in its own folder.
      for (const s of scripts) {
        const folder = s.relativePath.slice(0, s.relativePath.lastIndexOf('/'));
        expect(decodeURIComponent(s.requires![0].url)).toBe(`file://${unzipped.path}/${decodeURIComponent(folder)}/lib/util.js`);
      }
      expect(scripts.map((s) => s.header && s.header.tags.find((t) => t.tag === 'name')?.value).sort())
        .toEqual(['Café ünïcode', 'Plain', 'Tools #2 100%']);
    } finally {
      unzipped.cleanup();
    }
  });
});
