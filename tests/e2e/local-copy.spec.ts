// Making a local copy of an installed script from the viewer's
// Collection row (src/extension/copy-dialog.ts, src/extension/local-copy.ts): the copy
// lands in `<Downloads>/SourceMonkey/`, that directory becomes the
// "Scripts copied in Downloads" collection, and the copy takes over as
// the running version.
//
// `testWithBrowserDownloads` rather than `test`: Playwright's default
// download interception renames every download to a GUID in its own
// artifacts directory, which hides exactly the file name and location
// this feature reads back from `chrome.downloads`.

import { testWithBrowserDownloads as test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { UserscriptServer } from '../fixtures/userscript-server';
import fs from 'node:fs';
import path from 'node:path';

const COPY_BTN = '#local-copy-btn';
const DIALOG = 'dialog.copy-dialog';
const FILE_NAME = `${DIALOG} #copy-file-name`;
const VERSION = `${DIALOG} #copy-version`;
const DESCRIPTION = `${DIALOG} #copy-description`;
const DEPS = `${DIALOG} #copy-deps`;
const ERROR = `${DIALOG} .dlg-error`;
const CONFIRM = `${DIALOG} #copy-confirm-btn`;

function viewerUrl(extensionId: string, scriptId: string): string {
  return `chrome-extension://${extensionId}/userscript.html?script=${scriptId}`;
}

function scriptWith(opts: { name: string; version?: string; description?: string; extra?: string[] }): string {
  return [
    '// ==UserScript==',
    `// @name        ${opts.name}`,
    ...(opts.version ? [`// @version     ${opts.version}`] : []),
    ...(opts.description ? [`// @description ${opts.description}`] : []),
    '// @match       https://example.com/*',
    ...(opts.extra ?? []),
    '// ==/UserScript==',
    `console.log('${opts.name}');`,
    '',
  ].join('\n');
}

// The install lines in a script's Log.
async function installLines(
  sm: { getScriptLog(id: string): Promise<{ source: string; message: string }[]> },
  id: string,
): Promise<string[]> {
  return (await sm.getScriptLog(id)).filter((e) => e.source === 'add').map((e) => e.message);
}

// Confirm the open dialog; resolve with the id the page moved to. A
// copy the dialog refused is reported with its own message rather
// than as a bare timeout.
async function copyAndWait(page: Page, fromId: string): Promise<string> {
  await page.locator(CONFIRM).click();
  // A warning (a file to replace) lives in the same slot and is not a
  // refusal — only a plain error is.
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get('script') !== id
      || (document.querySelector('dialog.copy-dialog .dlg-error:not(.warn)')?.textContent ?? '') !== '',
    fromId,
  );
  const id = new URL(page.url()).searchParams.get('script')!;
  if (id === fromId) {
    throw new Error(`copy refused: ${await page.locator(ERROR).innerText()}`);
  }
  return id;
}

test.describe('local copy of a script', () => {
  let server: UserscriptServer;
  // The browser — and so its Downloads folder — is shared by every test
  // in the worker, while `resetAllState` wipes only storage. Start each
  // test with an empty copies directory, or the previous test's files
  // would be "already there".
  test.beforeEach(async ({ downloadsDir }) => {
    fs.rmSync(path.join(downloadsDir!, 'SourceMonkey'), { recursive: true, force: true });
    server = await UserscriptServer.start();
  });
  test.afterEach(async () => {
    await server.stop();
  });

  test('the first copy writes the file, creates the collection, and takes over', async ({
    extensionContext, extensionId, sm, downloadsDir, getServiceWorker,
  }) => {
    const url = `${server.baseUrl}/hello.user.js`;
    server.setRoute('/hello.user.js', scriptWith({
      name: 'Hello', version: '1.2', description: 'Says hello',
      extra: [`// @downloadURL ${url}`],
    }));
    const def = await sm.addCollection(url);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} .dlg-title`)).toHaveText('Make a local copy of this script');
    // Nothing copied yet: the destination is described, not known.
    await expect(page.locator(`${DIALOG} #copy-target`)).toContainText('Scripts copied in Downloads');
    await expect(page.locator(`${DIALOG} #copy-target`))
      .toContainText("a SourceMonkey directory under Chrome's Downloads directory");
    await expect(page.locator(FILE_NAME)).toHaveValue('hello.user.js');
    await expect(page.locator(`${DIALOG} .dlg-section`)).toHaveText('Updated headers in downloaded script');
    // The version the copy is edited from, beside the box that edits it.
    await expect(page.locator(`${DIALOG} #copy-version-was`)).toHaveText('1.2');
    // Shown in full and on one line: the box beside it gives way, and
    // only a version past half the row wraps.
    const was = await page.locator(`${DIALOG} #copy-version-was`).boundingBox();
    const box = await page.locator(VERSION).boundingBox();
    expect(was!.height).toBeLessThanOrEqual(box!.height);
    await expect(page.locator(VERSION)).toHaveValue('1.2-local');
    await expect(page.locator(DESCRIPTION)).toHaveValue('Says hello');
    // One line for a short description; it grows with the value, to
    // four lines, and scrolls past that.
    const short = await page.locator(DESCRIPTION).boundingBox();
    expect(short!.height).toBe(29);
    await page.locator(DESCRIPTION).fill(
      'A description long enough that it cannot possibly fit on a single line of this dialog, so the box has to grow',
    );
    const grown = await page.locator(DESCRIPTION).boundingBox();
    expect(grown!.height).toBeGreaterThan(short!.height);
    await page.locator(DESCRIPTION).fill('word '.repeat(200));
    expect((await page.locator(DESCRIPTION).boundingBox())!.height).toBe(86);
    // A pasted newline is one line's worth of value, not two.
    await page.locator(DESCRIPTION).fill('one\ntwo');
    await expect(page.locator(DESCRIPTION)).toHaveValue('one two');
    await expect(page.locator(`${DIALOG} #copy-name`)).toHaveText('Hello');
    await expect(page.locator(DEPS)).toBeDisabled();
    await expect(page.locator(CONFIRM)).toBeEnabled();
    await page.locator(DESCRIPTION).fill('My edit');
    expect((await page.locator(DESCRIPTION).boundingBox())!.height).toBe(29);

    const copyId = await copyAndWait(page, originalId);

    // On disk, under Downloads/SourceMonkey, with only the header edits.
    const file = path.join(downloadsDir!, 'SourceMonkey', 'hello.user.js');
    expect(fs.readFileSync(file, 'utf8')).toBe(scriptWith({
      name: 'Hello', version: '1.2-local', description: 'My edit',
      extra: [`// @downloadURL ${url}`],
    }));

    // The collection: at that directory, seeded name, holding the copy.
    const collections = await sm.getCollections() as { id: string; path: string; displayName?: string; scriptIds: string[] }[];
    const copies = collections.find((c) => c.path === path.join(downloadsDir!, 'SourceMonkey'));
    expect(copies).toBeDefined();
    expect(copies!.displayName).toBe('Scripts copied in Downloads');
    expect(copies!.scriptIds).toEqual([copyId]);
    const rows = (await sm.getCollectionWithScripts(copies!.id))!.scripts;
    expect(rows[0].relativePath).toBe('hello.user.js');
    expect(rows[0].status).toBe('ok');
    // A copy is an install, logged once whichever path scanned it in.
    expect(await installLines(sm, copyId)).toEqual([expect.stringMatching(/^Installed /)]);

    // The setting: where Downloads is, and which collection is ours.
    const sw = await getServiceWorker();
    const setting = await sw.evaluate(() => chrome.storage.local.get('smDownloadsCopies'));
    expect(setting.smDownloadsCopies).toEqual({ downloadsDir, collectionId: copies!.id });

    // The copy runs; the original was swept off.
    expect((await sm.getCollectionWithScripts(def!.id))!.scripts[0].enabled).toBe(false);
    expect(rows[0].enabled).toBe(true);

    // The page moved to the copy in place, and the panel that now has
    // two copies to show is open.
    await expect(page.locator('.collection-cell .collection-display-name')).toHaveText('Scripts copied in Downloads');
    await expect(page.locator('#other-versions .versions-collapse')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#other-versions tbody tr')).toHaveCount(2);

    // The upstream probe reads the -local tail as an edit of 1.2, not
    // as being behind it.
    await sm.updateScript(copyId, 'manual', 'force');
    await expect(page.locator('dd', { hasText: 'Base of this local edit' })).toHaveText('1.2 (Base of this local edit)');

    // The Options page shows what was learned.
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator('#downloads-dir')).toHaveValue(downloadsDir!);
    await page.close();
  });

  test('a later copy reuses the collection; existing files replace, an installed script updates in place', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', version: '1' }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    const firstCopy = await copyAndWait(page, originalId);
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');

    // Back on the original: the same name is now an installed script.
    // Replacing it is allowed — the refresh rebuilds that row from the
    // new file, keeping its id — and the warning says it is a script.
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await expect(page.locator(`${DIALOG} #copy-target`)).toContainText(copiesDir);
    await expect(page.locator(ERROR)).toHaveText('Target script file already exists and will be replaced');
    await expect(page.locator(CONFIRM)).toHaveText('Replace');
    await page.locator(VERSION).fill('1-local.2');
    const replaced = await copyAndWait(page, originalId);
    expect(replaced).toBe(firstCopy);
    expect(fs.readFileSync(path.join(copiesDir, 'hello.user.js'), 'utf8')).toContain('@version     1-local.2');

    // A stray file nothing has registered: replaceable all the same.
    fs.writeFileSync(path.join(copiesDir, 'stray.user.js'), 'old');
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(FILE_NAME).fill('stray.user.js');
    await expect(page.locator(ERROR)).toHaveText('Target script file already exists and will be replaced');
    await expect(page.locator(CONFIRM)).toHaveText('Replace');
    const secondCopy = await copyAndWait(page, originalId);
    expect(secondCopy).not.toBe(firstCopy);
    expect(fs.readFileSync(path.join(copiesDir, 'stray.user.js'), 'utf8')).toContain('@name        Hello');

    // Still one collection, now holding both copies; only the newest runs.
    const collections = await sm.getCollections();
    const copies = collections.filter((c) => c.path === copiesDir);
    expect(copies).toHaveLength(1);
    // Each new copy logged its install; replacing one didn't again.
    for (const id of [firstCopy, secondCopy]) {
      expect(await installLines(sm, id)).toEqual([expect.stringMatching(/^Installed /)]);
    }
    const rows = (await sm.getCollectionWithScripts(copies[0].id))!.scripts;
    expect(rows.map((r) => [r.relativePath, r.enabled]).sort()).toEqual([
      ['hello.user.js', false],
      ['stray.user.js', true],
    ]);
    await page.close();
  });

  test('a bad file name is refused before anything is written', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello' }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;
    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(FILE_NAME).fill('hello.js');
    await expect(page.locator(ERROR)).toHaveText('Filename must end with .user.js');
    await expect(page.locator(CONFIRM)).toBeDisabled();
    await page.locator(FILE_NAME).fill('a/b/c/hello.user.js');
    await expect(page.locator(ERROR)).toContainText('folders deep');
    await page.locator(FILE_NAME).fill('a/b/hello.user.js');
    await expect(page.locator(ERROR)).toHaveText('');
    await expect(page.locator(CONFIRM)).toBeEnabled();
    await page.locator(`${DIALOG} button`, { hasText: 'Cancel' }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await page.close();
  });

  test('dependencies are written beside the script and stand in for their URLs', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await expect(page.locator(`${DIALOG} .dlg-check`)).toContainText('Also copy 1 dependency file');
    // Not being copied yet, so where they'd land is dimmed.
    await expect(page.locator(`${DIALOG} .dlg-deps .dlg-hint`))
      .toHaveText('Local filenames in download collection');
    await expect(page.locator(`${DIALOG} .dlg-deps-list`)).toHaveClass(/dimmed/);
    // The mirror layout would be `<host:port>/lib/util.js`, but Chrome
    // refuses a `:` in a download path, so the next-longest suffix is
    // what gets written — and what the override lookup finds.
    await expect(page.locator(`${DIALOG} .dlg-deps-list li`)).toHaveText('lib/util.js');
    await page.locator(DEPS).check();
    await expect(page.locator(`${DIALOG} .dlg-deps-list`)).not.toHaveClass(/dimmed/);
    const copyId = await copyAndWait(page, originalId);

    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    expect(fs.readFileSync(path.join(copiesDir, 'lib', 'util.js'), 'utf8')).toBe('window.__util = 1;\n');
    // The copy's @require line is untouched, and resolved to the local
    // file through the override lookup.
    expect(fs.readFileSync(path.join(copiesDir, 'hello.user.js'), 'utf8')).toContain(`// @require ${libUrl}`);
    const collections = await sm.getCollections();
    const copies = collections.find((c) => c.path === copiesDir)!;
    const row = (await sm.getCollectionWithScripts(copies.id))!.scripts.find((s) => s.id === copyId)!;
    const requires = (row as unknown as { requires: { url: string; localUrl?: string }[] }).requires;
    expect(requires[0].url).toBe(libUrl);
    expect(requires[0].localUrl).toBe(`file://${path.join(copiesDir, 'lib', 'util.js')}`);

    // Copying again under another name: the dependency is what already
    // exists. It is marked in the list, and Replace applies only once
    // the dependencies are actually being copied.
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(FILE_NAME).fill('hello-2.user.js');
    await expect(page.locator(`${DIALOG} .dlg-deps-list li`)).toHaveText('lib/util.js (already exists)');
    await expect(page.locator(`${DIALOG} .dlg-deps-list li .dlg-exists`)).toBeVisible();
    await expect(page.locator(ERROR)).toHaveText('');
    await expect(page.locator(CONFIRM)).toHaveText('Copy');
    await page.locator(DEPS).check();
    await expect(page.locator(ERROR)).toHaveText('Target dependency file already exists and will be replaced');
    await expect(page.locator(CONFIRM)).toHaveText('Replace');

    // Editing the name must not blink the mark and the warning off
    // while the disk is re-checked. Read in the same tick as the edit,
    // before the debounce can fire: everything on screen is still the
    // last answer, and only the confirm has gone dead.
    const midEdit = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#copy-file-name')!;
      input.value = 'hello-3.user.js';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const ok = document.querySelector<HTMLButtonElement>('#copy-confirm-btn')!;
      return {
        disabled: ok.disabled,
        label: ok.textContent,
        error: document.querySelector('dialog.copy-dialog .dlg-error')!.textContent,
        marks: document.querySelectorAll('dialog.copy-dialog .dlg-exists').length,
      };
    });
    expect(midEdit).toEqual({
      disabled: true,
      label: 'Replace',
      error: 'Target dependency file already exists and will be replaced',
      marks: 1,
    });
    // ... and the settled answer is the same one, so nothing moved.
    await expect(page.locator(CONFIRM)).toBeEnabled();
    await expect(page.locator(CONFIRM)).toHaveText('Replace');
    await expect(page.locator(`${DIALOG} .dlg-exists`)).toHaveCount(1);

    // A subdirectory in the file name moves the dependencies with it,
    // and the list says where they would land — nothing exists there,
    // so the mark goes.
    await page.locator(FILE_NAME).fill('sub/hello.user.js');
    await expect(page.locator(`${DIALOG} .dlg-deps-list li`)).toHaveText('sub/lib/util.js');
    await expect(page.locator(CONFIRM)).toHaveText('Copy');

    // Its own name too: one line covers both.
    await page.locator(FILE_NAME).fill('hello.user.js');
    await expect(page.locator(`${DIALOG} .dlg-deps-list li`)).toHaveText('lib/util.js (already exists)');
    await expect(page.locator(ERROR))
      .toHaveText('Target script file and dependency files already exist and will be replaced');
    await page.close();
  });

  // A copy that fails part-way must leave nothing behind: an abandoned
  // `.user.js` in the copies directory would be scanned in as a new,
  // enabled script by the next refresh.
  test('a refused write takes back the files it already wrote', async ({
    extensionContext, extensionId, sm, downloadsDir,
  }) => {
    const libUrl = `${server.baseUrl}/lib/util.js`;
    server.setRoute('/lib/util.js', 'window.__util = 1;\n');
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello', extra: [`// @require ${libUrl}`] }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    await page.locator(DEPS).check();
    // The dependency is written second, and Chrome refuses a filename
    // with a `:` in it — so the script file lands and the copy then
    // fails, which is the case this is about.
    await page.evaluate(() => {
      const dl = chrome.downloads.download.bind(chrome.downloads);
      chrome.downloads.download = ((options: chrome.downloads.DownloadOptions) =>
        dl(options.filename?.endsWith('.user.js')
          ? options
          : { ...options, filename: 'bad:name.js' })) as typeof chrome.downloads.download;
    });
    await page.locator(CONFIRM).click();
    await expect(page.locator(ERROR)).toContainText('was refused by Chrome');

    // Nothing registered, and nothing left on disk to be scanned in.
    const copiesDir = path.join(downloadsDir!, 'SourceMonkey');
    expect(fs.existsSync(path.join(copiesDir, 'hello.user.js'))).toBe(false);
    expect(await sm.getCollections()).toHaveLength(1);
    await page.close();
  });

  test('a copy standing in the collection refuses its own name', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/hello.user.js', scriptWith({ name: 'Hello' }));
    const def = await sm.addCollection(`${server.baseUrl}/hello.user.js`);
    const originalId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;
    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, originalId));
    await page.locator(COPY_BTN).click();
    const copyId = await copyAndWait(page, originalId);

    // Now standing on the copy: the default name is its own file, which
    // is refused rather than silently renamed. Another name goes through.
    await page.locator(COPY_BTN).click();
    await expect(page.locator(FILE_NAME)).toHaveValue('hello.user.js');
    await expect(page.locator(ERROR))
      .toHaveText('The copy source and destination are the same. Choose another filename.');
    await expect(page.locator(CONFIRM)).toBeDisabled();
    await page.locator(FILE_NAME).fill('hello-fork.user.js');
    await expect(page.locator(ERROR)).toHaveText('');
    const forkId = await copyAndWait(page, copyId);
    expect(forkId).not.toBe(copyId);
    await page.close();
  });
});
