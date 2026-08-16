// The search-paths box on the options page — the global list of
// directories searched for `@require` / `@resource` / `@icon` stand-ins
// after each script's own folder. See docs/local-file-overrides.md.
//
// What the resolution rule DOES with the roots is covered by
// local-file-overrides.spec.ts; this file is about the control:
// hydration, saving, and the two kinds of complaint (a line that isn't
// an absolute path, and one that is but names nothing on disk).

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('options: local file overrides', () => {
  let dir: ScriptsDir;

  test.beforeEach(() => {
    dir = ScriptsDir.create('sourcemonkey-roots-');
  });
  test.afterEach(() => {
    dir.cleanup();
  });

  test('saving persists the text and reports what will be searched', async ({
    extensionContext, extensionId,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    const box = page.locator('#local-roots-text');
    const status = page.locator('#local-roots-status');
    await expect(status).toHaveText(/No directories configured/);

    await box.fill(dir.path);
    // Unsaved edits say so, so the box never looks like it took effect
    // before the write happened.
    await expect(status).toHaveText('Unsaved changes');

    await page.locator('#local-roots-save').click();
    await expect(status).toHaveText(/Searching 1 directory/);
    await expect(page.locator('#local-roots-problems li')).toHaveCount(0);

    // The setting stores the parsed array, so the box re-renders in the
    // canonical form it saved — what's shown is what's searched.
    await expect(box).toHaveValue(`file://${dir.path}/`);

    // …and survives a reload, since that array is what's persisted.
    await page.reload();
    await expect(page.locator('#local-roots-text')).toHaveValue(`file://${dir.path}/`);
    await page.close();
  });

  // Save builds the stored array, so it must not run on text that
  // doesn't fully parse — there'd be no honest answer for the bad line.
  test('Save is disabled while any line is malformed', async ({
    extensionContext, extensionId,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    const box = page.locator('#local-roots-text');
    const saveBtn = page.locator('#local-roots-save');
    await expect(saveBtn).toBeEnabled();

    await box.fill(`${dir.path}\nrelative/path`);
    await expect(saveBtn).toBeDisabled();
    // The listed problem is the whole message — the status line doesn't
    // restate it.
    await expect(page.locator('#local-roots-status')).toHaveText('');
    await expect(page.locator('#local-roots-problems li')).toHaveCount(1);

    // Fixing the bad line re-enables it, and the good line is still there.
    await box.fill(dir.path);
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.locator('#local-roots-status')).toHaveText(/Searching 1 directory/);
    await page.close();
  });

  test('a line that is not an absolute path is flagged with its line number', async ({
    extensionContext, extensionId,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.locator('#local-roots-text').fill(`${dir.path}\nrelative/path`);
    const problems = page.locator('#local-roots-problems li');
    await expect(problems).toHaveCount(1);
    await expect(problems.first()).toHaveText(
      'Line 2: A local file root must be an absolute path starting with / or a file:// URL',
    );
    await page.close();
  });

  test('a well-formed root that does not exist is reported as missing', async ({
    extensionContext, extensionId,
  }) => {
    const missing = `${dir.path}/not-there`;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.locator('#local-roots-text').fill(missing);
    const problems = page.locator('#local-roots-problems li');
    await expect(problems).toHaveText([`Line 1: No directory found at ${missing}`]);

    // Missing is a warning, not a rejection: Save stays live, because
    // the directory can appear later.
    await expect(page.locator('#local-roots-save')).toBeEnabled();

    // And the complaint clears once it does. (A fresh page: existence
    // results are cached per page.)
    fs.mkdirSync(missing);
    await page.reload();
    await page.locator('#local-roots-text').fill(missing);
    await expect(page.locator('#local-roots-problems li')).toHaveCount(0);
    await page.close();
  });

  // A file is not a directory, and pointing at one is an easy slip when
  // the roots are meant to hold libraries.
  test('a path to a file, not a directory, is reported as missing', async ({
    extensionContext, extensionId,
  }) => {
    const filePath = `${dir.path}/util.js`;
    fs.writeFileSync(filePath, '// not a directory');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.locator('#local-roots-text').fill(filePath);
    await expect(page.locator('#local-roots-problems li'))
      .toHaveText([`Line 1: No directory found at ${filePath}`]);
    await page.close();
  });

  // The whole journey, with nothing stubbed: save a root on the real
  // options page, and the script's dependency comes from disk. Every
  // other test drives the setting through `sm.setLocalRoots`, which
  // pushes the value into the service worker's cache directly — so this
  // is the only coverage of the production seam (`storage.onChanged`
  // into the SW) and of Save refreshing the affected collections.
  test('saving on the options page re-resolves a script from the new root', async ({
    extensionContext, extensionId, sm,
  }) => {
    const server = await UserscriptServer.start();
    const scriptsDir = ScriptsDir.create('sourcemonkey-roots-scripts-');
    try {
      server.setRoute('/lib/util.js', 'window.__SM_LOCAL = "remote";', {
        contentType: 'application/javascript',
      });
      fs.mkdirSync(path.join(dir.path, 'lib'));
      fs.writeFileSync(path.join(dir.path, 'lib', 'util.js'), 'window.__SM_LOCAL = "configured";');
      scriptsDir.write({
        relativePath: 'main.user.js',
        meta: {
          name: 'Roots Journey',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/lib/util.js`],
        },
        body: '',
      });

      // Installed BEFORE any root exists, so it starts on the remote copy.
      const collection = await sm.addCollection(scriptsDir.path);
      expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0]?.source)
        .toBe('window.__SM_LOCAL = "remote";');

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await page.locator('#local-roots-text').fill(dir.path);
      await page.locator('#local-roots-save').click();
      await expect(page.locator('#local-roots-status')).toHaveText(/Searching 1 directory/);

      // No explicit refresh here: Save is what re-resolves the collection.
      await expect.poll(async () => {
        const data = await sm.getCollectionWithScripts(collection!.id);
        return data!.scripts[0].requires?.[0]?.source;
      }).toBe('window.__SM_LOCAL = "configured";');
      await page.close();
    } finally {
      scriptsDir.cleanup();
      await server.stop();
    }
  });
});
