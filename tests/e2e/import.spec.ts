// Importing backups (src/extension/import-backup.ts, import-plan.ts,
// import-dialog.ts, and `importScripts` in script-store.ts): the ⋯ menus
// open the dialog, it previews the file against what's installed, and
// Import applies the choices. See docs/import.md. The cross-manager
// round trips are in backup-interop.spec.ts.
//
// `testWithBrowserDownloads` for the tests that export first: the export
// reads the saved file's path back from `chrome.downloads`.
import { testWithBrowserDownloads as test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';
import {
  chooseImport, closeExport, closeImport, confirmImport, exportVia, IMPORT_DIALOG, importRows, importVia, openImport,
} from '../fixtures/backup-dialogs';
import fs from 'node:fs';
import path from 'node:path';

type Sm = Parameters<Parameters<typeof test>[2]>[0]['sm'];

function userscript(name: string, version: string, extra = '', body = 'void 0;'): string {
  return `// ==UserScript==\n// @name        ${name}\n// @namespace   sm-test\n// @version     ${version}\n${extra}// @grant       none\n// ==/UserScript==\n${body}\n`;
}

// A Tampermonkey JSON backup (docs/export-format.md#json-format).
function tampermonkeyJson(scripts: {
  name: string; uuid: string; text: string; enabled?: boolean; fileUrl?: string;
  values?: Record<string, string>; requires?: { url: string; text: string }[];
}[]): string {
  const b64 = (t: string): string => Buffer.from(t, 'utf8').toString('base64');
  return JSON.stringify({
    created_by: 'Tampermonkey',
    version: '1',
    scripts: scripts.map((s, i) => ({
      name: s.name,
      uuid: s.uuid,
      enabled: s.enabled ?? true,
      position: i + 1,
      ...(s.fileUrl ? { file_url: s.fileUrl } : {}),
      source: b64(s.text),
      options: {},
      storage: { ts: 1, data: s.values ?? {} },
      ...(s.requires ? { requires: s.requires.map((r) => ({ meta: { url: r.url, mimetype: 'text/javascript' }, source: b64(r.text) })) } : {}),
    })),
  });
}

async function collectionsPage(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/collections.html`);
  await expect(page.locator('#page-menu')).toBeVisible();
}

async function collectionByName(sm: Sm, prefix: string): Promise<{ id: string; scriptIds: string[] }> {
  const all = await sm.getCollections();
  const found = all.find((c) => (c.displayName ?? '').startsWith(prefix));
  if (!found) throw new Error(`No collection named ${prefix}…; have ${all.map((c) => c.displayName).join(', ')}`);
  return found;
}

test.describe('backup import', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  test('an export imported after its collection is gone comes back as imported scripts', async ({
    extensionContext, extensionId, sm,
  }) => {
    dir.write({ relativePath: 'alpha.user.js', meta: { name: 'Alpha', match: ['https://example.com/*'] }, body: 'void 1;\n' });
    dir.write({ relativePath: 'beta.user.js', meta: { name: 'Beta', match: ['https://example.com/*'] }, body: 'void 2;\n' });
    const added = await sm.addCollection(dir.path);
    const { scripts } = (await sm.getCollectionWithScripts(added!.id))!;
    const alpha = scripts.find((s) => s.relativePath === 'alpha.user.js')!;
    const beta = scripts.find((s) => s.relativePath === 'beta.user.js')!;
    await sm.setScriptEnabled(beta.id, false);
    await sm.writeGmValues(alpha.id, [{ key: 'theme', value: 'dark' }, { key: 'count', value: 3 }, { key: 'cfg', value: { a: [1] } }]);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    const saved = await exportVia(page, '#page-menu');
    await closeExport(page);
    await sm.removeCollection(added!.id);

    await openImport(page, '#page-menu', saved);
    await expect(page.locator(`${IMPORT_DIALOG} #import-summary`)).toHaveText('SourceMonkey export: 2 scripts.');
    expect(await importRows(page)).toEqual([
      { name: 'Alpha', here: 'New', result: 'Install as imported text' },
      { name: 'Beta', here: 'New', result: 'Install as imported text' },
    ]);
    expect(await confirmImport(page)).toBe('Imported 2 scripts.');
    await closeImport(page);

    const into = await collectionByName(sm, 'Imported from SourceMonkey');
    const got = (await sm.getCollectionWithScripts(into.id))!.scripts;
    expect(got.map((s) => [s.relativePath.startsWith('imported:///'), s.status, s.enabled]).sort())
      .toEqual([[true, 'ok', false], [true, 'ok', true]]);
    const newAlpha = got.find((s) => s.relativePath.endsWith('/Alpha.user.js'))!;
    expect(await sm.getGmValues(newAlpha.id)).toEqual({ theme: 'dark', count: 3, cfg: { a: [1] } });
    // The page lands on the new collection.
    await expect(page.locator(`.collection[data-collection-id="${into.id}"]`)).toBeVisible();
    await expect(page.locator(`.collection[data-collection-id="${into.id}"] .scheme-chip.chip-imported`)).toHaveCount(2);
    await page.close();
  });

  test('re-importing an export matches by id; the choice decides what is replaced', async ({
    extensionContext, extensionId, sm,
  }) => {
    dir.write({ relativePath: 'alpha.user.js', meta: { name: 'Alpha', match: ['https://example.com/*'] }, body: 'void 1;\n' });
    const added = await sm.addCollection(dir.path);
    const [alpha] = (await sm.getCollectionWithScripts(added!.id))!.scripts;
    await sm.writeGmValues(alpha.id, [{ key: 'theme', value: 'dark' }]);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    const saved = await exportVia(page, '#page-menu');
    await closeExport(page);
    await sm.writeGmValues(alpha.id, [{ key: 'theme', value: 'light' }, { key: 'extra', value: 1 }]);
    await sm.setScriptEnabled(alpha.id, false);
    await sm.syncNow();

    await openImport(page, '#page-menu', saved);
    // The same text: the default, newer versions only, leaves it.
    expect(await importRows(page)).toEqual([{ name: 'Alpha', here: 'Same', result: 'Leave as it is' }]);
    await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toBeDisabled();
    await chooseImport(page, { existing: 'always' });
    // It loads from its own file, so only its values and state change.
    expect((await importRows(page))[0].result).toBe('Replace its values and on/off state');
    await chooseImport(page, { enabled: false });
    expect((await importRows(page))[0].result).toBe('Replace its values');
    expect(await confirmImport(page)).toBe('Updated 1.');
    await closeImport(page);

    expect(await sm.getGmValues(alpha.id)).toEqual({ theme: 'dark' });
    const after = (await sm.getCollectionWithScripts(added!.id))!.scripts;
    expect(after.map((s) => [s.id, s.enabled])).toEqual([[alpha.id, false]]);
    expect((await sm.getCollections()).length).toBe(1);
    await page.close();
  });

  test('a Tampermonkey backup: text kept with its bundled @require, then a newer version replaces it', async ({
    extensionContext, extensionId, sm, fixtureServer,
  }) => {
    const pageUrl = `${fixtureServer.baseUrl}/blank.html`;
    // A host that never resolves: the @require can only come from the file.
    const lib = { url: 'https://sm-import-test.invalid/lib.js', text: 'var importLib = 41;\n' };
    const v1 = userscript('Kept', '1.0', `// @match       ${pageUrl}\n// @require     ${lib.url}\n`,
      'document.documentElement.dataset.kept = String(importLib + 1);');
    fs.writeFileSync(path.join(dir.path, 'tm-v1.txt'), tampermonkeyJson([
      { name: 'Kept', uuid: 'tm-kept', text: v1, values: { n: 'n7' }, requires: [lib] },
    ]));

    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    expect(await importVia(page, '#page-menu', path.join(dir.path, 'tm-v1.txt'))).toBe('Imported 1 script.');
    const into = await collectionByName(sm, 'Imported from Tampermonkey');
    const [kept] = (await sm.getCollectionWithScripts(into.id))!.scripts;
    expect(kept.status).toBe('ok');
    expect(await sm.getGmValues(kept.id)).toEqual({ n: 7 });
    await sm.syncNow();
    const target = await extensionContext.newPage();
    await target.goto(pageUrl);
    await expect(target.locator('html')).toHaveAttribute('data-kept', '42');

    // The same uuid with a newer version, from the collection's own menu.
    const v2 = v1.replace('1.0', '2.0').replace('importLib + 1', 'importLib + 2');
    fs.writeFileSync(path.join(dir.path, 'tm-v2.txt'), tampermonkeyJson([
      { name: 'Kept', uuid: 'tm-kept', text: v2, values: { n: 'n8' }, requires: [lib] },
      { name: 'Fresh', uuid: 'tm-fresh', text: userscript('Fresh', '1.0', `// @match       ${pageUrl}\n`), enabled: false },
    ]));
    const section = `.collection[data-collection-id="${into.id}"]`;
    await openImport(page, `${section} button.collection-menu`, path.join(dir.path, 'tm-v2.txt'));
    // Opened from the collection, new scripts go into it.
    await expect(page.locator(`${IMPORT_DIALOG} #import-into`)).toHaveValue(into.id);
    expect(await importRows(page)).toEqual([
      { name: 'Kept', here: 'Older here', result: 'Replace its text and values' },
      { name: 'Fresh', here: 'New', result: 'Install as imported text' },
    ]);
    expect(await confirmImport(page)).toBe('Imported 1 script and updated 1.');
    await closeImport(page);

    const after = (await sm.getCollectionWithScripts(into.id))!.scripts;
    expect(after.length).toBe(2);
    const updated = after.find((s) => s.id === kept.id)!;
    expect(updated.header?.tags.find((t) => t.tag === 'version')?.value).toBe('2.0');
    expect(await sm.getGmValues(kept.id)).toEqual({ n: 8 });
    expect(after.find((s) => s.id !== kept.id)!.enabled).toBe(false);
    await sm.syncNow();
    await target.reload();
    await expect(target.locator('html')).toHaveAttribute('data-kept', '43');
    await page.close();
    await target.close();
  });

  test('a script with a web address installs from the file\'s text and updates from there', async ({
    extensionContext, extensionId, sm, fixtureServer,
  }) => {
    const url = `${fixtureServer.baseUrl}/gm-log/gm-log.user.js`;
    const text = userscript('From the web', '0.1', '// @match       https://example.com/*\n');
    // A second script at the same address: one collection holds one row per location.
    const twin = userscript('Twin', '0.1', '// @match       https://example.com/*\n');
    fs.writeFileSync(path.join(dir.path, 'tm.txt'), tampermonkeyJson([
      { name: 'From the web', uuid: 'tm-w', text, fileUrl: url },
      { name: 'Twin', uuid: 'tm-t', text: twin, fileUrl: url },
    ]));
    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    await openImport(page, '#page-menu', path.join(dir.path, 'tm.txt'));
    expect((await importRows(page))[0].result).toBe('Install, updating from its web address');
    expect(await confirmImport(page)).toBe('Imported 1 script.\n\nThese failed:\n\nTwin: This script is already installed there');
    await closeImport(page);
    const into = await collectionByName(sm, 'Imported from Tampermonkey');
    const rows = (await sm.getCollectionWithScripts(into.id))!.scripts;
    expect(rows.length).toBe(1);
    const [row] = rows;
    expect(row.relativePath).toBe(url);
    // The file's copy, not the server's, until it next refreshes.
    expect(row.header?.tags.find((t) => t.tag === 'name')?.value).toBe('From the web');
    await page.close();
  });

  test('files that are not backups are refused in the dialog', async ({ extensionContext, extensionId }) => {
    fs.writeFileSync(path.join(dir.path, 'one.user.js'), userscript('One', '1'));
    fs.writeFileSync(path.join(dir.path, 'notes.txt'), 'hello');
    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    await openImport(page, '#page-menu', path.join(dir.path, 'one.user.js'));
    await expect(page.locator(`${IMPORT_DIALOG} #import-error`))
      .toHaveText('This is a userscript, not a backup file. Add it with the Add field instead.');
    await page.locator(`${IMPORT_DIALOG} #import-file`).setInputFiles(path.join(dir.path, 'notes.txt'));
    await expect(page.locator(`${IMPORT_DIALOG} #import-error`)).toContainText('This is not a backup file SourceMonkey can read.');
    await expect(page.locator(`${IMPORT_DIALOG} #import-table`)).toBeHidden();
    await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toBeDisabled();
    await page.close();
  });
});
