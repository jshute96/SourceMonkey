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
  chooseImport, closeExport, closeImport, collectionRows, confirmImport, existingRows, exportVia, IMPORT_DIALOG, importVia, newRows,
  openImport, previewShown, unchangedNames,
} from '../fixtures/backup-dialogs';
import { buildZip } from '../../dist/extension/zip-writer.js';
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

  test('an export imported after its collection is gone: linked to its files, or kept as text', async ({
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
    // Beta's file is gone, so it can't be linked to it.
    fs.rmSync(path.join(dir.path, 'beta.user.js'));

    await openImport(page, '#page-menu', saved);
    // Not restoring the collection: its scripts import one by one.
    await previewShown(page);
    await chooseImport(page, { restore: false });
    expect(await newRows(page)).toEqual([
      { name: 'Alpha', version: '', type: 'file', href: `file://${dir.path}/alpha.user.js` },
      { name: 'Beta', version: '', type: 'file', href: `file://${dir.path}/beta.user.js` },
    ]);
    // Only new scripts: no Existing or Invalid section.
    await expect(page.locator(`${IMPORT_DIALOG} #import-collections .import-heading`)).toHaveText('Collections (1)');
    await expect(page.locator(`${IMPORT_DIALOG} #import-new .import-heading`)).toHaveText('New scripts (2)');
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing`)).toBeHidden();
    await expect(page.locator(`${IMPORT_DIALOG} #import-invalid`)).toBeHidden();
    expect(await confirmImport(page))
      .toBe('Imported 2 scripts.\n\nThese scripts’ files couldn’t be read, so they use the backup’s copy and won’t get updates:\n\nBeta');
    // An information dialog by now: Esc closes it.
    await page.keyboard.press('Escape');
    await expect(page.locator(IMPORT_DIALOG)).toBeHidden();

    const into = await collectionByName(sm, 'Imported from SourceMonkey');
    const got = (await sm.getCollectionWithScripts(into.id))!.scripts;
    const newAlpha = got.find((s) => s.relativePath.endsWith('alpha.user.js'))!;
    const newBeta = got.find((s) => s.relativePath !== newAlpha.relativePath)!;
    expect([newAlpha.relativePath, newAlpha.status, newAlpha.enabled]).toEqual([path.join(dir.path, 'alpha.user.js'), 'ok', true]);
    expect([newBeta.relativePath.startsWith('imported:///'), newBeta.status, newBeta.enabled]).toEqual([true, 'ok', false]);
    expect(await sm.getGmValues(newAlpha.id)).toEqual({ theme: 'dark', count: 3, cfg: { a: [1] } });
    // The page lands on the new collection.
    const section = `.collection[data-collection-id="${into.id}"]`;
    await expect(page.locator(section)).toBeVisible();
    await expect(page.locator(`${section} .scheme-chip.chip-file`)).toHaveCount(1);
    await expect(page.locator(`${section} .scheme-chip.chip-imported`)).toHaveCount(1);

    // Again the same day: the new collection's name is taken, so the
    // choice shows the numbered name it will get.
    await openImport(page, '#page-menu', saved);
    await expect(page.locator(`${IMPORT_DIALOG} #import-into option`).first())
      .toHaveText(`(New) ${(await sm.getCollections()).find((c) => c.id === into.id)!.displayName} (2)`);
    await page.locator(`${IMPORT_DIALOG} .dlg-actions button`, { hasText: 'Cancel' }).click();
    await page.close();
  });

  test('an export restores its collection: name, location, scripts and values, until its next refresh', async ({
    extensionContext, extensionId, sm,
  }) => {
    dir.write({ relativePath: 'alpha.user.js', meta: { name: 'Alpha', match: ['https://example.com/*'] }, body: 'void 1;\n' });
    dir.write({ relativePath: 'sub/beta.user.js', meta: { name: 'Beta', match: ['https://example.com/*'] }, body: 'void 2;\n' });
    const added = await sm.addCollection(dir.path);
    await sm.setCollectionOptions(added!.id, { displayName: 'My scripts', localFiles: false });
    const { scripts } = (await sm.getCollectionWithScripts(added!.id))!;
    const alpha = scripts.find((s) => s.relativePath === 'alpha.user.js')!;
    const beta = scripts.find((s) => s.relativePath === 'sub/beta.user.js')!;
    await sm.setScriptEnabled(beta.id, false);
    await sm.writeGmValues(alpha.id, [{ key: 'theme', value: 'dark' }]);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    const saved = await exportVia(page, '#page-menu');
    await closeExport(page);
    await sm.removeCollection(added!.id);

    await openImport(page, '#page-menu', saved);
    expect(await collectionRows(page)).toEqual([
      { name: 'My scripts', kind: 'Directory', location: dir.path, scripts: '2', status: 'New', restore: true },
    ]);
    // Its scripts go with it, so no other section lists them.
    await expect(page.locator(`${IMPORT_DIALOG} #import-new`)).toBeHidden();
    await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toHaveText('Import 2 scripts');
    expect(await confirmImport(page)).toBe('Restored 1 collection with 2 scripts.');
    await closeImport(page);

    const restored = await collectionByName(sm, 'My scripts');
    const got = (await sm.getCollectionWithScripts(restored.id))!;
    expect([got.collection.path, (await sm.getCollections()).find((c) => c.id === restored.id)?.displayName]).toEqual([dir.path, 'My scripts']);
    const byPath = new Map(got.scripts.map((s) => [s.relativePath, s]));
    expect([...byPath.keys()].sort()).toEqual(['alpha.user.js', 'sub/beta.user.js']);
    expect([byPath.get('alpha.user.js')!.enabled, byPath.get('sub/beta.user.js')!.enabled]).toEqual([true, false]);
    const newAlpha = byPath.get('alpha.user.js')!;
    expect(await sm.getGmValues(newAlpha.id)).toEqual({ theme: 'dark' });

    // The next refresh loads what the folder has now: Beta is gone, and
    // Alpha keeps its row and values.
    fs.rmSync(path.join(dir.path, 'sub', 'beta.user.js'));
    await sm.updateCollection(restored.id, 'manual');
    const after = (await sm.getCollectionWithScripts(restored.id))!.scripts;
    expect(after.map((s) => [s.id, s.relativePath])).toEqual([[newAlpha.id, 'alpha.user.js']]);
    expect(await sm.getGmValues(newAlpha.id)).toEqual({ theme: 'dark' });

    // Here now, so a second import doesn't restore it again: its
    // scripts are matched one by one.
    await openImport(page, '#page-menu', saved);
    expect(await collectionRows(page)).toEqual([
      { name: 'My scripts', kind: 'Directory', location: dir.path, scripts: '2', status: 'Already here', restore: false },
    ]);
    // Alpha is just as the backup has it.
    expect(await existingRows(page)).toEqual([]);
    expect(await unchangedNames(page)).toEqual(['Alpha']);
    await expect(page.locator(`${IMPORT_DIALOG} #import-unchanged .dlg-unchanged`))
      .toHaveText('1 existing script is exactly the same and will not be imported.Show');
    await expect(page.locator(`${IMPORT_DIALOG} #import-unchanged-table`)).toBeHidden();
    await page.locator(`${IMPORT_DIALOG} #import-unchanged-toggle`).click();
    await expect(page.locator(`${IMPORT_DIALOG} #import-unchanged-table`)).toBeVisible();
    await expect(page.locator(`${IMPORT_DIALOG} #import-unchanged-table input`)).toHaveCount(0);
    expect((await newRows(page)).map((r) => r.name)).toEqual(['Beta']);
    await page.close();
  });

  test('an export restores scripts collections: a built-in one under its own name, and a user\'s', async ({
    extensionContext, extensionId, sm,
  }) => {
    dir.write({ relativePath: 'loose.user.js', meta: { name: 'Loose', match: ['https://example.com/*'] }, body: 'void 1;\n' });
    dir.write({ relativePath: 'mine.user.js', meta: { name: 'Mine1', match: ['https://example.com/*'] }, body: 'void 2;\n' });
    const builtin = await sm.addCollection(path.join(dir.path, 'loose.user.js'));
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.installScript(path.join(dir.path, 'mine.user.js'), { collectionId: mine!.id });
    const builtinName = (await sm.getCollections()).find((c) => c.id === builtin!.id)!.displayName!;
    const [mine1] = (await sm.getCollectionWithScripts(mine!.id))!.scripts;
    await sm.writeGmValues(mine1.id, [{ key: 'k', value: 1 }]);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    const saved = await exportVia(page, '#page-menu');
    await closeExport(page);
    await sm.removeCollection(builtin!.id);
    await sm.removeCollection(mine!.id);

    await openImport(page, '#page-menu', saved);
    expect((await collectionRows(page)).map((r) => [r.name, r.kind, r.status, r.restore])).toEqual([
      [builtinName, 'Scripts (built-in)', 'New', true], ['Mine', 'Scripts', 'New', true],
    ]);
    // Link only matters while a scripts collection is being restored.
    const link = page.locator(`${IMPORT_DIALOG} #import-restore-link`);
    await expect(link).toBeVisible();
    // The heading's box clears and checks them all.
    const all = page.locator(`${IMPORT_DIALOG} #import-collections-table thead input`);
    await expect(all).toBeChecked();
    await all.uncheck();
    expect((await collectionRows(page)).map((r) => r.restore)).toEqual([false, false]);
    await expect(link).toBeHidden();
    await chooseImport(page, { restore: true });
    await expect(all).toBeChecked();
    await expect(link).toBeVisible();
    expect(await confirmImport(page)).toBe('Restored 2 collections with 2 scripts.');
    await closeImport(page);

    const after = await sm.getCollections();
    const back = after.find((c) => c.path === builtin!.path)!;
    expect(back.displayName).toBe(builtinName);
    const backMine = after.find((c) => c.displayName === 'Mine')!;
    const [newMine1] = (await sm.getCollectionWithScripts(backMine.id))!.scripts;
    expect(newMine1.relativePath).toBe(path.join(dir.path, 'mine.user.js'));
    expect(await sm.getGmValues(newMine1.id)).toEqual({ k: 1 });
    expect((await sm.getCollectionWithScripts(back.id))!.scripts.map((s) => s.relativePath)).toEqual([path.join(dir.path, 'loose.user.js')]);
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
    // Disabled here, enabled in the backup; its values changed since.
    expect(await existingRows(page)).toEqual([{
      name: 'Alpha', version: '', content: 'Same', enabled: '\u2610 \u2192 \u2713', type: 'file', values: '\u2713 \u2192 \u2713 (Different)', affected: false,
    }]);
    // It shows the collection it's in, and each heading says what its
    // column shows.
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing-table .import-collection`)).toHaveText([dir.path]);
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing-table th`, { hasText: 'Content' }))
      .toHaveAttribute('title', /^Whether the script’s text \(current and imported\) is the same/);
    // Its name opens the installed copy.
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing-table .import-name a`)).toHaveAttribute('href', `userscript.html?script=${alpha.id}`);
    await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toBeDisabled();
    await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toHaveAttribute('title', 'This import would update zero scripts.');
    // Only an existing script, and nothing newer: replacing newer ones
    // is greyed out, and leaving them is the choice.
    await expect(page.locator(`${IMPORT_DIALOG} #import-new`)).toBeHidden();
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing .import-heading`)).toHaveText('Existing scripts with changes (1)');
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing-newer`)).toBeDisabled();
    await expect(page.locator(`${IMPORT_DIALOG} label`, { has: page.locator('#import-existing-newer') }))
      .toHaveText('Replace when the imported version is newer (0)');
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing-leave`)).toBeChecked();
    const alphaBox = page.locator(`${IMPORT_DIALOG} #import-existing-table tbody td:first-child input`);
    const allBox = page.locator(`${IMPORT_DIALOG} #import-existing-table thead input`);
    // Nothing to do to it: its box is off limits, and so is the all box.
    await expect(alphaBox).toBeDisabled();
    await expect(allBox).toBeDisabled();
    await chooseImport(page, { existing: 'always' });
    // It loads from its own file, so its text isn't replaced: only its
    // values or state can change, and those start off.
    expect((await existingRows(page))[0].affected).toBe(false);
    await expect(alphaBox).toBeDisabled();
    const cell = (col: string) => page.locator(`${IMPORT_DIALOG} #import-existing-table td[data-col="${col}"]`);
    await expect(cell('values')).toHaveClass(/import-off/);
    await chooseImport(page, { existingValues: true });
    expect((await existingRows(page))[0].affected).toBe(true);
    // Values will change: no longer greyed, and highlighted. Enabled
    // differs too, but its option is off.
    await expect(cell('values')).toHaveClass(/import-change/);
    await expect(cell('values')).not.toHaveClass(/import-off/);
    await expect(cell('enabled')).toHaveClass(/import-off/);
    await expect(cell('enabled')).not.toHaveClass(/import-change/);
    await expect(alphaBox).toBeEnabled();
    await expect(alphaBox).toBeChecked();
    await expect(allBox).toBeEnabled();
    expect(await confirmImport(page)).toBe('Updated 1 script.');
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
    await openImport(page, '#page-menu', path.join(dir.path, 'tm-v2.txt'));
    // New scripts go into a new collection unless one is picked.
    await expect(page.locator(`${IMPORT_DIALOG} #import-into`)).toHaveValue('');
    // Its name is also in the new collection's numbered one, so by id.
    await page.locator(`${IMPORT_DIALOG} #import-into`).selectOption(into.id);
    await expect(page.locator(`${IMPORT_DIALOG} #import-into`)).toHaveValue(into.id);
    expect(await existingRows(page)).toEqual([{
      name: 'Kept', version: '1.0 \u2192 2.0 (Newer)', content: 'Different', enabled: '\u2713', type: 'imported', values: '\u2713 \u2192 \u2713 (Different)', affected: true,
    }]);
    // No location: it comes in as an imported script.
    expect(await newRows(page)).toEqual([{ name: 'Fresh', version: '1.0', type: 'imported', href: '' }]);
    // An existing script's values are only replaced when asked.
    await expect(page.locator(`${IMPORT_DIALOG} #import-existing-values`)).not.toBeChecked();
    await chooseImport(page, { existingValues: true });
    expect(await confirmImport(page)).toBe('Imported 1 script.\n\nUpdated 1 script.');
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

  test('a script with a web address is linked to it, starting from the file\'s text', async ({
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
    expect(await newRows(page)).toEqual([
      { name: 'From the web', version: '0.1', type: 'http', href: url },
      { name: 'Twin', version: '0.1', type: 'http', href: url },
    ]);
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

  test('scripts that can\'t be read are listed under Invalid scripts', async ({ extensionContext, extensionId }) => {
    const enc = new TextEncoder();
    fs.writeFileSync(path.join(dir.path, 'mixed.zip'), buildZip([
      { path: 'scripts/Good.user.js', data: enc.encode(userscript('Good', '1')) },
      { path: 'scripts/sub/Empty.user.js', data: enc.encode('  \n') },
    ]));
    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    await openImport(page, '#page-menu', path.join(dir.path, 'mixed.zip'));
    expect((await newRows(page)).map((r) => r.name)).toEqual(['Good']);
    await expect(page.locator(`${IMPORT_DIALOG} #import-invalid .import-heading`)).toHaveText('Invalid scripts (1)');
    await expect(page.locator(`${IMPORT_DIALOG} #import-invalid`)).toContainText('These scripts cannot be imported.');
    expect(await page.locator(`${IMPORT_DIALOG} #import-invalid-table tbody tr`).evaluateAll((rows) =>
      rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent)))).toEqual([['scripts/sub/Empty.user.js', 'The script is empty']]);
    await page.close();
  });

  test('the page behind the open dialog doesn\'t scroll', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 1000, height: 600 });
    await collectionsPage(page, extensionId);
    // Make the page tall enough to scroll.
    await page.evaluate(() => { document.body.appendChild(Object.assign(document.createElement('div'), { style: 'height: 3000px' })); });
    // A backup big enough that its table, and the dialog, scroll.
    const zip = path.join(dir.path, 'many.zip');
    fs.writeFileSync(zip, buildZip(Array.from({ length: 60 }, (_, i) => ({
      path: `s${i}.user.js`, data: Buffer.from(userscript(`Script ${i}`, '1.0')),
    })), Date.now()));
    await openImport(page, '#page-menu', zip);
    await previewShown(page);
    // Wheel over the table past its end, then over the title, and the
    // keys with focus in the dialog.
    for (const target of [`${IMPORT_DIALOG} #import-new-table`, `${IMPORT_DIALOG} .dlg-title`]) {
      const box = (await page.locator(target).boundingBox())!;
      await page.mouse.move(box.x + 20, box.y + 10);
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 800);
    }
    for (const key of ['ArrowDown', 'PageDown', 'End']) await page.keyboard.press(key);
    // The wheel landed: the dialog scrolled. Then give a smooth scroll
    // of the page time to start.
    await expect.poll(() => page.locator(IMPORT_DIALOG).evaluate((d) => d.scrollTop)).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator(`${IMPORT_DIALOG} button`, { hasText: 'Cancel' }).click();
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
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
    await expect(page.locator(`${IMPORT_DIALOG} #import-sections`)).toBeHidden();
    await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toBeDisabled();
    await page.close();
  });
});
