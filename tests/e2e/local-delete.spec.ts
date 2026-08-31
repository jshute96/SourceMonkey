// Deleting a local copy from disk (src/delete-dialog.ts,
// src/local-delete.ts): the trash can beside Local copy… removes the
// file the copy was written to, takes the dependency files only that
// copy uses with it if asked, and leaves the ones another script in the
// collection is loading.
//
// `testWithBrowserDownloads` for the same reason as the copy spec: the
// files have to land in a real Downloads folder, since a file the
// browser didn't download is one `chrome.downloads.removeFile` cannot
// delete.

import { testWithBrowserDownloads as test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { UserscriptServer } from '../fixtures/userscript-server';
import fs from 'node:fs';
import path from 'node:path';

const COPY_BTN = '#local-copy-btn';
const COPY_DIALOG = 'dialog.copy-dialog';
const COPY_CONFIRM = `${COPY_DIALOG} #copy-confirm-btn`;

const DELETE_BTN = '#delete-copy-btn';
const DIALOG = 'dialog.delete-dialog';
// The three headed lists, in the order the dialog draws them: going,
// kept because another script loads them, kept because Chrome has no
// record of them. A group with nothing in it is hidden, not removed,
// so the indices are stable.
const GROUP = (n: number) => `${DIALOG} .dlg-dep-group >> nth=${n}`;
const ERROR = `${DIALOG} .dlg-error`;
const CONFIRM = `${DIALOG} #delete-confirm-btn`;

function viewerUrl(extensionId: string, scriptId: string): string {
  return `chrome-extension://${extensionId}/userscript.html?script=${scriptId}`;
}

// Which of the two trash cans a button is wearing (src/delete-icon.ts).
// The pair is the only thing telling a record removal apart from a file
// deletion before the user hovers, and five call sites paint it, so it
// is asserted rather than left to the tooltip.
async function expectGlyph(
  btn: ReturnType<Page['locator']>,
  kind: 'record' | 'file',
): Promise<void> {
  await expect(btn.locator('svg.delete-icon use')).toHaveAttribute(
    'href', kind === 'file' ? '#sm-trash-file' : '#sm-trash',
  );
  if (kind === 'file') await expect(btn).toHaveClass(/\bdeletes-file\b/);
  else await expect(btn).not.toHaveClass(/\bdeletes-file\b/);
}

function scriptWith(opts: { name: string; extra?: string[] }): string {
  return [
    '// ==UserScript==',
    `// @name        ${opts.name}`,
    '// @version     1.0',
    '// @match       https://example.com/*',
    ...(opts.extra ?? []),
    '// ==/UserScript==',
    `console.log('${opts.name}');`,
    '',
  ].join('\n');
}

// Copy the script the viewer is showing, with its dependencies, and
// resolve with the copy's id.
async function copyWithDeps(page: Page, fromId: string, fileName?: string): Promise<string> {
  await page.locator(COPY_BTN).click();
  await expect(page.locator(COPY_DIALOG)).toBeVisible();
  if (fileName) await page.locator(`${COPY_DIALOG} #copy-file-name`).fill(fileName);
  await page.locator(`${COPY_DIALOG} #copy-deps`).check();
  await page.locator(COPY_CONFIRM).click();
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get('script') !== id,
    fromId,
  );
  return new URL(page.url()).searchParams.get('script')!;
}

test.describe('deleting a local copy', () => {
  let server: UserscriptServer;
  // The Downloads folder outlives `resetAllState`, which wipes only
  // storage — so each test starts with the copies directory empty.
  test.beforeEach(async ({ downloadsDir }) => {
    fs.rmSync(path.join(downloadsDir!, 'SourceMonkey'), { recursive: true, force: true });
    server = await UserscriptServer.start();
  });
  test.afterEach(async () => {
    await server.stop();
  });

  test('the copy and its own dependency go, and the row is unregistered', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    const copyId = await copyWithDeps(page, originalId);
    // The copy's button is visible, which is what proves the setting
    // read has landed on this page — the button starts hidden, so
    // asserting on the web original before that would pass for the
    // wrong reason. Checked after going back to it.
    await expect(page.locator(DELETE_BTN)).toBeVisible();
    await expectGlyph(page.locator(DELETE_BTN), 'file');
    await page.goto(viewerUrl(extensionId, originalId));
    await expect(page.locator('#local-copy-btn')).toBeVisible();
    // Nothing to delete on the web original: its file is not ours.
    await expect(page.locator(DELETE_BTN)).toBeHidden();
    await page.goto(viewerUrl(extensionId, copyId));
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const file = path.join(copiesDir, 'hello.user.js');
    const lib = path.join(copiesDir, 'lib', 'util.js');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(lib)).toBe(true);

    await expect(page.locator(DELETE_BTN)).toBeVisible();
    await page.locator(DELETE_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} .dlg-title`)).toHaveText('Delete local script file');
    await expect(page.locator(`${DIALOG} #delete-collection`)).toContainText('Scripts copied in Downloads');
    await expect(page.locator(`${DIALOG} #delete-file`)).toHaveText('hello.user.js');
    await expect(page.locator(`${DIALOG} #delete-file-path`)).toHaveText(file);
    // The dependency is only this script's, so it goes too — no control,
    // and the warning counts both files.
    await expect(page.locator(GROUP(0))).toContainText('Files used by this script only');
    await expect(page.locator(GROUP(0)).locator('li')).toHaveText('lib/util.js');
    await expect(page.locator(GROUP(1))).toBeHidden();
    await expect(page.locator(GROUP(2))).toBeHidden();
    await expect(page.locator(ERROR))
      .toHaveText('Delete will remove 2 files from disk.\nThis cannot be undone.');
    await page.locator(CONFIRM).click();

    // Both files gone, and the page says what happened rather than
    // reading as a script the store lost.
    await expect(page.locator('#message')).toHaveText('This script has been removed');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(lib)).toBe(false);

    // The record went with the file — by `removeScript`, not a refresh
    // (see docs/local-delete.md#why-not-a-refresh).
    const copies = (await sm.getCollections()).find((c) => c.path === copiesDir)!;
    expect((await sm.getCollectionWithScripts(copies.id))!.scripts.map((s) => s.id)).not.toContain(copyId);
    await page.close();
  });

  // Both controls act on the script the page is showing, so they sit in
  // its own controls row rather than on the Collection row, which is
  // about where the script is filed. The trash can's glyph is sized
  // from the font, so its height is asserted against Refresh rather
  // than left to a padding that happens to match today.
  test('the two controls sit between the Enabled box and Refresh', async ({
    extensionContext, extensionId, sm,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    const copyId = await copyWithDeps(page, originalId);
    await page.goto(viewerUrl(extensionId, copyId));
    await expect(page.locator(DELETE_BTN)).toBeVisible();

    await expect(page.locator(`#meta-row ${COPY_BTN}`)).toBeVisible();
    await expect(page.locator(`#meta-row ${DELETE_BTN}`)).toBeVisible();
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
    const [enabled, copy, del, refresh] = await Promise.all(
      ['#enable-label', COPY_BTN, DELETE_BTN, '#refresh-btn'].map(box),
    );
    expect(enabled.x).toBeLessThan(copy.x);
    expect(copy.x).toBeLessThan(del.x);
    expect(del.x).toBeLessThan(refresh.x);
    expect(Math.abs(del.height - refresh.height)).toBeLessThan(1.5);
    expect(Math.abs(copy.height - refresh.height)).toBeLessThan(1.5);
    await page.close();
  });

  test('a dependency another copy loads is listed as kept, and stays on disk', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    server.setRoute('/other.user.js', scriptWith({ name: 'Other', extra: [`// @require ${libUrl}`] }));
    // Both land in the same "Scripts from web" container, so each row is
    // found by its own URL rather than by position.
    const one = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    await sm.addCollection(`${server.baseUrl}/other.user.js`);
    const web = (await sm.getCollectionWithScripts(one!.id))!.scripts;
    const firstId = web.find((s) => s.relativePath.endsWith('/hello.user.js'))!.id;
    const secondId = web.find((s) => s.relativePath.endsWith('/other.user.js'))!.id;

    const page = await extensionContext.newPage();
    // Two copies in the copies collection, both loading the one library
    // file the first of them wrote.
    await page.goto(viewerUrl(extensionId, firstId));
    const copyId = await copyWithDeps(page, firstId);
    await page.goto(viewerUrl(extensionId, secondId));
    await copyWithDeps(page, secondId, 'other.user.js');

    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const lib = path.join(copiesDir, 'lib', 'util.js');
    await page.goto(viewerUrl(extensionId, copyId));
    await page.locator(DELETE_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} #delete-file`)).toHaveText('hello.user.js');
    // Nothing goes but the script: the only dependency is one the other
    // copy needs, so it is listed under the heading that says so — and
    // the other script is deliberately not named.
    await expect(page.locator(GROUP(0))).toBeHidden();
    await expect(page.locator(GROUP(1)))
      .toContainText('Not deleting files also used by other scripts');
    await expect(page.locator(GROUP(1)).locator('li')).toHaveText('lib/util.js');
    await expect(page.locator(GROUP(1))).not.toContainText('Other');
    // Counted, not "this file": the dialog is showing files it is not
    // taking.
    await expect(page.locator(ERROR))
      .toHaveText('Delete will remove 1 file from disk.\nThis cannot be undone.');
    await page.locator(CONFIRM).click();

    await expect(page.locator('#message')).toHaveText('This script has been removed');
    expect(fs.existsSync(path.join(copiesDir, 'hello.user.js'))).toBe(false);
    // The library the other copy loads is still there, and so is it.
    expect(fs.existsSync(lib)).toBe(true);
    const copies = (await sm.getCollections()).find((c) => c.path === copiesDir)!;
    const rows = (await sm.getCollectionWithScripts(copies.id))!.scripts;
    expect(rows.map((s) => s.relativePath)).toEqual(['other.user.js']);
    expect(rows[0].status).toBe('ok');
    await page.close();
  });

  test('a dependency Chrome has forgotten is left on disk, and the script still goes', async ({
    extensionContext, extensionId, sm, downloadsDir, getServiceWorker,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    const copyId = await copyWithDeps(page, originalId);
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const lib = path.join(copiesDir, 'lib', 'util.js');

    // What clearing the downloads list does to one of the two files.
    const sw = await getServiceWorker();
    await sw.evaluate((filename) => chrome.downloads.erase({ filename }), lib);

    await page.goto(viewerUrl(extensionId, copyId));
    await page.locator(DELETE_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(GROUP(0))).toBeHidden();
    await expect(page.locator(GROUP(2)))
      .toContainText('Not deleting files no longer in Chrome download history');
    await expect(page.locator(GROUP(2)).locator('li')).toHaveText('lib/util.js');
    // Only the script is going, and Delete is still offered: an
    // unreachable library is no reason to refuse it.
    await expect(page.locator(ERROR))
      .toHaveText('Delete will remove 1 file from disk.\nThis cannot be undone.');
    await expect(page.locator(CONFIRM)).toBeEnabled();
    await page.locator(CONFIRM).click();

    await expect(page.locator('#message')).toHaveText('This script has been removed');
    expect(fs.existsSync(path.join(copiesDir, 'hello.user.js'))).toBe(false);
    expect(fs.existsSync(lib)).toBe(true);
    await page.close();
  });

  test('a script Chrome has forgotten cannot be deleted, and says so', async ({
    extensionContext, extensionId, sm, downloadsDir, getServiceWorker,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    const copyId = await copyWithDeps(page, originalId);
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const file = path.join(copiesDir, 'hello.user.js');

    const sw = await getServiceWorker();
    await sw.evaluate((filename) => chrome.downloads.erase({ filename }), file);

    await page.goto(viewerUrl(extensionId, copyId));
    await page.locator(DELETE_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    // Blocked: the message takes the slot the warning would use, and it
    // says "files" because the dependency was going with it.
    await expect(page.locator(ERROR)).toHaveText(
      'Script file is no longer in Chrome download history, so SourceMonkey cannot delete it.\n'
      + 'You can delete the files manually.',
    );
    await expect(page.locator(ERROR)).not.toHaveClass(/warn/);
    await expect(page.locator(CONFIRM)).toBeDisabled();
    // Nothing was touched, and the row is still registered.
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(copiesDir, 'lib', 'util.js'))).toBe(true);
    const copies = (await sm.getCollections()).find((c) => c.path === copiesDir)!;
    expect((await sm.getCollectionWithScripts(copies.id))!.scripts.map((x) => x.id)).toContain(copyId);
    await page.close();
  });

  test('the Other versions panel deletes the file too, and the row leaves the table', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello' }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(COPY_CONFIRM).click();
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get('script') !== id,
      originalId,
    );
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const file = path.join(copiesDir, 'hello.user.js');

    // The panel lists the copy and the web original. Waited for: the
    // copy's landing repaints it, and a row located mid-repaint is a
    // node about to be replaced under the click.
    await expect(page.locator('#other-versions tr[data-script-id]')).toHaveCount(2);
    // The copy's trash can is live even though it came in with a
    // directory collection — deleting the file is what stops the next
    // scan bringing the row back.
    const copyRow = page.locator(`#other-versions tr[data-script-id="${
      new URL(page.url()).searchParams.get('script')}"]`);
    const trash = copyRow.locator('button.versions-remove');
    await expect(trash).toBeEnabled();
    await expect(trash).toHaveAttribute('title', 'Delete local script file');
    await expectGlyph(trash, 'file');
    // The web original two rows up only drops a record, and says so.
    await expectGlyph(
      page.locator(`#other-versions tr[data-script-id="${originalId}"] button.versions-remove`),
      'record',
    );
    await trash.click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} #delete-file`)).toHaveText('hello.user.js');
    await page.locator(CONFIRM).click();

    expect(fs.existsSync(file)).toBe(false);
    // The page was standing on the copy, so it moves to the surviving
    // version rather than to the not-found line — which leaves that
    // version with no others, and the panel with nothing to show.
    await expect(page).toHaveURL(viewerUrl(extensionId, originalId));
    await expect(page.locator('#other-versions tr[data-script-id]')).toHaveCount(0);
    await page.close();
  });

  test('a copy whose file has gone keeps only the plain trash can', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello' }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(COPY_CONFIRM).click();
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get('script') !== id,
      originalId,
    );
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const copies = (await sm.getCollections()).find((c) => c.path === copiesDir)!;

    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`.collection[data-collection-id="${copies.id}"]`);
    await expect(section.locator('td.action-cell button.remove-script')).toHaveCount(1);

    // Deleting the file by hand, the way a user would when Chrome can no
    // longer be asked to. The refresh leaves the row MISSING — an empty
    // directory can't be told apart from an unreadable one, so the row
    // is kept — and the row must not still offer to delete a file that
    // has gone: the status cell's own trash can, which clears the
    // record, is the whole answer now.
    fs.rmSync(path.join(copiesDir, 'hello.user.js'));
    await sm.updateCollection(copies.id, 'manual');
    await expect(section.locator('td.status-cell')).toContainText('MISSING');
    await expect(section.locator('td.status-cell button.remove-script')).toHaveCount(1);
    await expectGlyph(section.locator('td.status-cell button.remove-script'), 'record');
    await expect(section.locator('td.action-cell button')).toHaveCount(0);
    await page.close();
  });

  test('the collections page offers the same deletion on a copy row', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello' }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(COPY_CONFIRM).click();
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get('script') !== id,
      originalId,
    );
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    const copies = (await sm.getCollections()).find((c) => c.path === copiesDir)!;

    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`.collection[data-collection-id="${copies.id}"]`);
    const trash = section.locator('td.action-cell button.remove-script');
    await expect(trash).toHaveCount(1);
    // The original's own row has a trash can too — it is in a scripts
    // collection, where every row does — but it is the plain one that
    // removes the record.
    const original = page.locator(`.collection[data-collection-id="${def!.id}"] td.action-cell button`);
    await expect(original).toHaveAttribute('title', 'Remove this script');
    await expectGlyph(original, 'record');
    await expect(trash).toHaveAttribute(
      'title', 'Delete local script file',
    );
    await expectGlyph(trash, 'file');
    await trash.click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.locator(CONFIRM).click();

    await expect(section.locator('tr[data-script-id]')).toHaveCount(0);
    expect(fs.existsSync(path.join(copiesDir, 'hello.user.js'))).toBe(false);
    await page.close();
  });
});
