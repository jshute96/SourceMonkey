// The create / edit collection dialog (src/collection-dialog.ts) as
// driven from the collections page: how the Add field routes into it,
// what it makes of a location (the Type row is the dialog's own
// verdict, never a choice), what it refuses and why, and what Edit can
// change.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import { test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

const DIALOG = 'dialog.collection-dialog';
const TYPE_BUBBLE = '.dlg-type .collection-type-bubble';

async function openCollectionsPage(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/collections.html`);
  await expect(page.locator('#add-form')).toBeVisible();
}

async function addField(page: Page, value: string): Promise<void> {
  await page.locator('#add-path').fill(value);
  await page.locator('#add-form button[type="submit"]').click();
}

test.describe('collection dialog', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a blank Add opens the dialog; Create makes an empty scripts collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, '');

    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dlg-title')).toHaveText('New collection');
    // Nothing typed yet: not a collection of any kind, and the Type row
    // is where that is said — the error slot stays empty.
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
    await expect(dialog.locator('.dlg-type .dlg-hint')).toHaveText('Enter a name or path');
    await expect(dialog.locator('#collection-dialog-name'))
      .toHaveAttribute('placeholder', 'Name is required for scripts collections');
    await expect(dialog.locator('.dlg-error')).toHaveText('');
    await expect(dialog.locator('button.primary')).toBeDisabled();

    // A name with no location is a collection of individual scripts.
    await dialog.locator('#collection-dialog-name').fill('Work');
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('scripts');
    await expect(dialog.locator('button.primary')).toBeEnabled();
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();

    const section = page.locator('section.collection');
    await expect(section).toHaveCount(1);
    await expect(section.locator('h2 .collection-display-name')).toHaveText('Work');
    await expect(section.locator('.collection-type-bubble')).toHaveText('scripts');
    await expect(section.locator('.empty')).toContainText('No scripts added yet');

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0].path).toMatch(/^container:[0-9a-f-]{36}$/);
    await page.close();
  });

  test('plain text in the Add field becomes the name of a new scripts collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, 'Shopping');

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('scripts');
    await expect(dialog.locator('#collection-dialog-name')).toHaveValue('Shopping');
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('section.collection h2 .collection-display-name')).toHaveText('Shopping');
    await expect(page.locator('#add-path')).toHaveValue('');
    expect(await sm.getCollections()).toHaveLength(1);
    await page.close();
  });

  test('a directory path reads as a directory with the name left blank, and can be named before Create', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, scriptsDir.path);

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('file-dir');
    await expect(dialog.locator('#collection-dialog-location')).toHaveValue(scriptsDir.path);
    // Blank means the inferred name; the placeholder says so.
    await expect(dialog.locator('#collection-dialog-name')).toHaveValue('');
    await expect(dialog.locator('#collection-dialog-name'))
      .toHaveAttribute('placeholder', 'Name is optional for directory collections');
    // Local, so the overrides option applies and defaults on.
    await expect(dialog.locator('#collection-dialog-local-files')).toBeEnabled();
    await expect(dialog.locator('#collection-dialog-local-files')).toBeChecked();

    await dialog.locator('#collection-dialog-name').fill('My scripts');
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();

    const section = page.locator('section.collection');
    await expect(section.locator('h2 .collection-display-name')).toHaveText('My scripts');
    // The path is still there, in the tooltip.
    await expect(section.locator('h2 .collection-display-name')).toHaveAttribute('title', scriptsDir.path);
    await expect(section.locator('.collection-type-bubble')).toHaveText('file-dir');
    await expect(section.locator('tbody tr')).toHaveCount(1);
    const collections = await sm.getCollections();
    expect(collections[0].path).toBe(scriptsDir.path);
    await page.close();
  });

  test('a location that cannot be read is refused live, and nothing is created', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, '/nonexistent-sourcemonkey-dir/scripts');

    const dialog = page.locator(DIALOG);
    // Nothing could be read, so there is nothing to classify — the
    // dialog says that rather than filing it as a directory.
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
    await expect(dialog.locator('.dlg-error'))
      .toHaveText('Could not read /nonexistent-sourcemonkey-dir/scripts. Check that the path exists.');
    await expect(dialog.locator('#collection-dialog-location')).toHaveClass(/invalid/);
    await expect(dialog.locator('button.primary')).toBeDisabled();
    expect(await sm.getCollections()).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('section.collection')).toHaveCount(0);
    await page.close();
  });

  test('a path that resolves to the filesystem root is refused', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, '');
    const dialog = page.locator(DIALOG);
    // `/` is refused everywhere already; the spellings that reach the
    // same place have to go with it, or Create would offer to scan the
    // whole disk.
    for (const root of ['/', '//', '/..']) {
      await dialog.locator('#collection-dialog-location').fill(root);
      await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
      await expect(dialog.locator('.dlg-error'))
        .toHaveText('Location must be a URL or absolute file path');
      await expect(dialog.locator('button.primary')).toBeDisabled();
    }
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await sm.getCollections()).toHaveLength(0);
    await page.close();
  });

  test('a refusal is forgotten on the next edit, so a directory created meanwhile is picked up', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const later = `${scriptsDir.path}/made-later`;
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, later);

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
    await expect(dialog.locator('.dlg-error')).toContainText('Could not read');

    // The directory appears while the dialog is open. Retyping the same
    // path is the retry — the refusal must not have been cached.
    scriptsDir.write({
      relativePath: 'made-later/a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    await dialog.locator('#collection-dialog-location').fill(`${later}/x`);
    await dialog.locator('#collection-dialog-location').fill(later);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('file-dir');
    await expect(dialog.locator('button.primary')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.close();
  });

  test('a readable file that is neither a script nor a manifest is an unsupported type', async ({
    extensionContext, extensionId, sm,
  }) => {
    const notes = scriptsDir.writeRaw('notes.json', '{}\n');
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, notes);

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
    await expect(dialog.locator('.dlg-error'))
      .toContainText('File must be a script (.user.js) or a manifest (script_manifest.json)');
    await expect(dialog.locator('button.primary')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await sm.getCollections()).toHaveLength(0);
    await page.close();
  });

  test('an empty directory warns once, then Create goes through', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, scriptsDir.path);

    const dialog = page.locator(DIALOG);
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dlg-error')).toContainText('No .user.js files found');
    await expect(dialog.locator('.dlg-error')).toHaveClass(/warn/);
    expect(await sm.getCollections()).toHaveLength(0);

    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();
    expect(await sm.getCollections()).toHaveLength(1);
    await expect(page.locator('section.collection .empty')).toContainText('No *.user.js files found');
    await page.close();
  });

  test('a manifest URL reads as a manifest and greys the local-overrides option', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const server = await UserscriptServer.start();
    try {
      const page = await extensionContext.newPage();
      await openCollectionsPage(page, extensionId);
      await addField(page, `${server.baseUrl}/scripts/script_manifest.json`);

      const dialog = page.locator(DIALOG);
      await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('http-manifest');
      await expect(dialog.locator('#collection-dialog-name'))
        .toHaveAttribute('placeholder', 'Name is optional for manifest collections');
      await expect(dialog.locator('#collection-dialog-local-files')).toBeDisabled();
      await expect(dialog.locator('.dlg-check')).toContainText('Not applicable for scripts loaded over http');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('an http URL that names no collection says what would work', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, 'https://example.com/scripts/');

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
    await expect(dialog.locator('.dlg-error'))
      .toContainText('URL must be a GitHub folder');
    await expect(dialog.locator('button.primary')).toBeDisabled();

    // A GitHub tree URL is the shape it asks for — classified from the
    // URL alone, with no API call.
    await dialog.locator('#collection-dialog-location')
      .fill('https://github.com/owner/repo/tree/main/scripts');
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('github-dir');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.close();
  });

  test('a script URL gets the same install offer a local script does', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/one.user.js', '// ==UserScript==\n// @name One\n// @match https://example.com/*\n// ==/UserScript==\n');
      const page = await extensionContext.newPage();
      await openCollectionsPage(page, extensionId);
      await addField(page, '');
      const dialog = page.locator(DIALOG);
      await dialog.locator('#collection-dialog-location').fill(`${server.baseUrl}/one.user.js`);
      await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
      await expect(dialog.locator('.dlg-error')).toHaveText('This is a single script, not a collection');
      await expect(dialog.locator('button.primary')).toBeDisabled();

      await dialog.locator('.dlg-error-action').click();
      await page.waitForURL(/userscript\.html\?preview=/);
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('a real .user.js typed as the location is refused, with an install button instead', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const script = scriptsDir.write({
      relativePath: 'one.user.js',
      meta: { name: 'One', match: ['https://example.com/*'] },
      body: '',
    });
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, '');
    const dialog = page.locator(DIALOG);
    await dialog.locator('#collection-dialog-location').fill(script);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('invalid');
    await expect(dialog.locator('.dlg-error')).toContainText('This is a single script, not a collection');
    await expect(dialog.locator('button.primary')).toBeDisabled();

    // The dialog can't make a collection of it, but it can hand it to
    // the page that installs it.
    await dialog.locator('.dlg-error-action').click();
    await page.waitForURL(/userscript\.html\?preview=/);
    await page.close();
  });

  test('a name already in use is refused live, case-insensitively', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.createCollection({ kind: 'scripts', name: 'Work' });
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, 'work');

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('.dlg-error')).toContainText('Collection named "work" already exists');
    await expect(dialog.locator('button.primary')).toBeDisabled();
    await dialog.locator('#collection-dialog-name').fill('Work 2');
    await expect(dialog.locator('button.primary')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await sm.getCollections()).toHaveLength(1);
    await page.close();
  });

  test('a built-in collection name is reserved, even before that collection exists', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    await addField(page, 'Scripts from web');

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('.dlg-error'))
      .toContainText('Built-in collection name is reserved');
    await expect(dialog.locator('button.primary')).toBeDisabled();
    await dialog.locator('#collection-dialog-name').fill('Web stuff');
    await expect(dialog.locator('button.primary')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await sm.getCollections()).toHaveLength(0);
    await page.close();
  });

  test('Edit renames a scripts collection; a renamed default is still the default', async ({
    extensionContext, extensionId, sm,
  }) => {
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/a.user.js', '// ==UserScript==\n// @name A\n// @match https://example.com/*\n// ==/UserScript==\n');
      const container = await sm.addCollection(`${server.baseUrl}/a.user.js`);
      expect(container!.path).toBe('container:http');

      const page = await extensionContext.newPage();
      await openCollectionsPage(page, extensionId);
      const section = page.locator(`section.collection[data-collection-id="${container!.id}"]`);
      await expect(section.locator('h2 .collection-display-name')).toHaveText('Scripts from web');
      await section.locator('button.edit-collection').click();

      const dialog = page.locator(DIALOG);
      await expect(dialog.locator('.dlg-title')).toHaveText('Edit collection');
      // Already a scripts collection, so there is no location to show —
      // one can't be added to it.
      await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('scripts');
      await expect(dialog.locator('#collection-dialog-location')).toBeHidden();
      await expect(dialog.locator('button.primary')).toHaveText('Save');

      await dialog.locator('#collection-dialog-name').fill('Web stuff');
      await dialog.locator('button.primary').click();
      await expect(dialog).toBeHidden();
      await expect(section.locator('h2 .collection-display-name')).toHaveText('Web stuff');

      const [row] = await sm.getCollections();
      expect(row.path).toBe('container:http');
      expect((row as { displayName?: string }).displayName).toBe('Web stuff');
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('Edit on a scripts collection will not save a blank name', async ({
    extensionContext, extensionId, sm,
  }) => {
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Work' });
    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    const section = page.locator(`section.collection[data-collection-id="${mine!.id}"]`);
    await section.locator('button.edit-collection').click();

    // Nothing to infer a name from, so blank is missing rather than
    // "use the inferred one" — the Type row says what is still needed.
    const dialog = page.locator(DIALOG);
    await dialog.locator('#collection-dialog-name').fill('');
    await expect(dialog.locator('.dlg-type .dlg-hint')).toHaveText('Enter a name');
    await expect(dialog.locator('button.primary')).toBeDisabled();

    await dialog.locator('#collection-dialog-name').fill('Home');
    await expect(dialog.locator('button.primary')).toBeEnabled();
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();
    await expect(section.locator('h2 .collection-display-name')).toHaveText('Home');
    await page.close();
  });

  // The name a default is born with is its own, so renaming away from
  // it and back has to work — the reservation is against OTHER
  // collections taking it, not against the owner reclaiming it.
  test('a renamed default can be renamed back to its built-in name', async ({
    extensionContext, extensionId, sm,
  }) => {
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/a.user.js', '// ==UserScript==\n// @name A\n// @match https://example.com/*\n// ==/UserScript==\n');
      const container = await sm.addCollection(`${server.baseUrl}/a.user.js`);
      await sm.setCollectionOptions(container!.id, { displayName: 'Web stuff' });

      const page = await extensionContext.newPage();
      await openCollectionsPage(page, extensionId);
      const section = page.locator(`section.collection[data-collection-id="${container!.id}"]`);
      await expect(section.locator('h2 .collection-display-name')).toHaveText('Web stuff');

      await section.locator('button.edit-collection').click();
      const dialog = page.locator(DIALOG);
      await dialog.locator('#collection-dialog-name').fill('Scripts from web');
      // Its own name, so no reservation complaint and Save is live.
      await expect(dialog.locator('.dlg-error')).toHaveText('');
      await expect(dialog.locator('button.primary')).toBeEnabled();
      await dialog.locator('button.primary').click();
      await expect(dialog).toBeHidden();

      await expect(section.locator('h2 .collection-display-name')).toHaveText('Scripts from web');
      const [row] = await sm.getCollections();
      expect(row.path).toBe('container:http');
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('Edit on a directory collection shows the fixed location and lets the name go back to inferred', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.createCollection({ kind: 'location', path: scriptsDir.path, name: 'Mine' });

    const page = await extensionContext.newPage();
    await openCollectionsPage(page, extensionId);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('h2 .collection-display-name')).toHaveText('Mine');
    await section.locator('button.edit-collection').click();

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator(TYPE_BUBBLE)).toHaveText('file-dir');
    await expect(dialog.locator('#collection-dialog-location')).toBeVisible();
    await expect(dialog.locator('#collection-dialog-location')).toBeDisabled();
    await expect(dialog.locator('#collection-dialog-location')).toHaveValue(scriptsDir.path);
    await expect(dialog.locator('#collection-dialog-name')).toHaveValue('Mine');

    // Blank → the inferred name (the path), as the Add field always did.
    await dialog.locator('#collection-dialog-name').fill('');
    await expect(dialog.locator('button.primary')).toBeEnabled();
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();
    await expect(section.locator('h2 .collection-display-name')).toHaveText(scriptsDir.path);
    await page.close();
  });

  test('a scripts collection shows a scheme chip on each row', async ({
    extensionContext, extensionId, sm,
  }) => {
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/web.user.js', '// ==UserScript==\n// @name Web\n// @match https://example.com/*\n// ==/UserScript==\n');
      const local = scriptsDir.write({
        relativePath: 'local.user.js',
        meta: { name: 'Local', match: ['https://example.com/*'] },
        body: '',
      });
      const mine = await sm.createCollection({ kind: 'scripts', name: 'Mixed' });
      await sm.installScript(`${server.baseUrl}/web.user.js`, { collectionId: mine!.id });
      await sm.installScript(local, { collectionId: mine!.id });

      const page = await extensionContext.newPage();
      await openCollectionsPage(page, extensionId);
      const section = page.locator(`section.collection[data-collection-id="${mine!.id}"]`);
      await expect(section.locator('tbody tr')).toHaveCount(2);
      await expect(section.locator('tbody tr .scheme-chip')).toHaveText(['http', 'file']);
      await page.close();
    } finally {
      await server.stop();
    }
  });
});
