// Collections page UI: adding a directory through the form, toggling a
// script, removing a collection. The page talks to the same script-store
// the SW does, so these exercise the real add/remove pipeline without
// any SW-side shortcut.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('collections page', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('renders directories that already exist in storage', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    expect(collection).not.toBeNull();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator(`section.collection[data-collection-id="${collection!.id}"] h2 .collection-display-name`))
      .toHaveText(scriptsDir.path);
    await expect(page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`))
      .toHaveCount(1);
    await page.close();
  });

  test('add-directory form registers a new collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'hi.user.js',
      meta: { name: 'Hi', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    await page.locator('#add-path').fill(scriptsDir.path);
    await page.locator('#add-form button[type="submit"]').click();
    // The field hands a location to the create dialog, prefilled;
    // Create is what adds it.
    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#collection-dialog-location')).toHaveValue(scriptsDir.path);
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();

    // Section appears with the new script row.
    await expect(page.locator('section.collection')).toHaveCount(1);
    await expect(page.locator('section.collection h2 .collection-display-name')).toHaveText(scriptsDir.path);
    await expect(page.locator('section.collection tbody tr')).toHaveCount(1);

    // And the SW now sees the collection.
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0].path).toBe(scriptsDir.path);
    await page.close();
  });

  test('Remove button drops the section and the storage rows', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section).toBeVisible();

    // Collection has 1 script, so Remove now prompts a confirm.
    page.once('dialog', (dialog) => void dialog.accept());
    await section.locator('button', { hasText: 'Remove' }).click();
    await expect(section).toHaveCount(0);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    expect(await sm.getCollections()).toHaveLength(0);
    await page.close();
  });

  test('?add registers a new collection and jumps to its anchor', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/collections.html`);
    url.searchParams.set('add', scriptsDir.path);
    await page.goto(url.toString());

    // The param opens the dialog prefilled, exactly as typing would;
    // Create is what adds it.
    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog.locator('#collection-dialog-location')).toHaveValue(scriptsDir.path);
    await dialog.locator('button.primary').click();
    await expect(dialog).toBeHidden();

    // Section gets rendered, URL hash points to it, query param is scrubbed.
    const section = page.locator('section.collection').first();
    await expect(section).toBeVisible();
    await expect(section.locator('h2 .collection-display-name')).toHaveText(scriptsDir.path);

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    const collectionId = collections[0].id;
    await expect(section).toHaveAttribute('id', `collection-${collectionId}`);

    await expect.poll(() => page.evaluate(() => location.hash))
      .toBe(`#collection-${collectionId}`);
    await expect.poll(() => page.evaluate(() => location.search))
      .toBe('');

    await page.close();
  });

  test('?add on an already-registered path jumps to existing without re-adding', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const existing = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/collections.html`);
    url.searchParams.set('add', scriptsDir.path);
    await page.goto(url.toString());

    // The dialog opens prefilled and already says why Create is off.
    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dlg-error')).toContainText('already registered');
    await expect(dialog.locator('button.primary')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Still exactly one collection — no duplicate row.
    await expect(page.locator('section.collection')).toHaveCount(1);
    expect(await sm.getCollections()).toHaveLength(1);
    expect((await sm.getCollections())[0].id).toBe(existing!.id);

    await page.close();
  });

  // Text that is neither a URL nor a path is the NAME of a new scripts
  // collection; the dialog opens on it and nothing is added until
  // Create.
  test('?add with plain text opens the dialog as a scripts-collection name', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/collections.html`);
    url.searchParams.set('add', 'not-a-valid-path-or-url');
    await page.goto(url.toString());

    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="collection-kind"][value="scripts"]')).toBeChecked();
    await expect(dialog.locator('#collection-dialog-name')).toHaveValue('not-a-valid-path-or-url');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    expect(await sm.getCollections()).toHaveLength(0);
    await expect(page.locator('section.collection')).toHaveCount(0);

    // A cancelled dialog leaves `add` in the URL so the user can
    // edit/retry/reload.
    await expect.poll(() => page.evaluate(() => location.search))
      .toContain('add');

    await page.close();
  });

  test('?add rejects a bare "/" path', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/collections.html`);
    url.searchParams.set('add', '/');
    await page.goto(url.toString());

    // Shaped like a location, so it goes in as one — and fails the
    // shape check there, with Create off.
    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#collection-dialog-location')).toHaveValue('/');
    await expect(dialog.locator('.dlg-error')).toContainText('Location must be a URL or absolute file path');
    await expect(dialog.locator('button.primary')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await sm.getCollections()).toHaveLength(0);

    await page.close();
  });

  test('Remove confirm: cancel keeps the collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section).toBeVisible();

    // Dismiss the confirm — section must stay.
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('Remove collection with 2 scripts?');
      await dialog.dismiss();
    });
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toBeVisible();
    expect(await sm.getCollections()).toHaveLength(1);

    await page.close();
  });

  test('Remove confirm: accept removes the collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'only.user.js',
      meta: { name: 'Only', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section).toBeVisible();

    // Singular "script" since count is 1.
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe('Remove collection with 1 script?');
      await dialog.accept();
    });
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toHaveCount(0);
    expect(await sm.getCollections()).toHaveLength(0);

    await page.close();
  });

  test('Remove on an empty collection does not prompt', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Create a dir but write no userscripts — the collection loads with
    // zero scripts, so Remove should skip the confirm prompt.
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section).toBeVisible();

    // If anything pops a dialog this test fails loudly.
    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toHaveCount(0);
    expect(dialogFired).toBe(false);
    expect(await sm.getCollections()).toHaveLength(0);

    await page.close();
  });

  test('Up/Down buttons reorder collections and disable at the ends', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two separate collection dirs so we get two sections to reorder.
    const dirA = ScriptsDir.create();
    const dirB = ScriptsDir.create();
    dirA.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    dirB.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    try {
      const sourceA = await sm.addCollection(dirA.path);
      const sourceB = await sm.addCollection(dirB.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);

      const sections = page.locator('section.collection');
      await expect(sections).toHaveCount(2);
      // Initial order matches add order; first row's Up is disabled and
      // last row's Down is disabled.
      await expect(sections.nth(0)).toHaveAttribute('data-collection-id', sourceA!.id);
      await expect(sections.nth(1)).toHaveAttribute('data-collection-id', sourceB!.id);
      await expect(sections.nth(0).locator('.move-up')).toBeDisabled();
      await expect(sections.nth(0).locator('.move-down')).toBeEnabled();
      await expect(sections.nth(1).locator('.move-up')).toBeEnabled();
      await expect(sections.nth(1).locator('.move-down')).toBeDisabled();

      // Move A down — sections swap and the disabled bookends follow.
      await sections.nth(0).locator('.move-down').click();
      await expect(sections.nth(0)).toHaveAttribute('data-collection-id', sourceB!.id);
      await expect(sections.nth(1)).toHaveAttribute('data-collection-id', sourceA!.id);
      await expect(sections.nth(0).locator('.move-up')).toBeDisabled();
      await expect(sections.nth(1).locator('.move-down')).toBeDisabled();

      // Persisted in the store too.
      const stored = await sm.getCollections();
      expect(stored.map((s) => s.id)).toEqual([sourceB!.id, sourceA!.id]);

      // Move A back up — round-trip restores the original order.
      await sections.nth(1).locator('.move-up').click();
      await expect(sections.nth(0)).toHaveAttribute('data-collection-id', sourceA!.id);
      await expect(sections.nth(1)).toHaveAttribute('data-collection-id', sourceB!.id);
      const stored2 = await sm.getCollections();
      expect(stored2.map((s) => s.id)).toEqual([sourceA!.id, sourceB!.id]);

      await page.close();
    } finally {
      dirA.cleanup();
      dirB.cleanup();
    }
  });

  test('per-script toggle disables matching for that script', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: { name: 'Mark', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'marked';`,
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // Toggle the script OFF via the collections page.
    const optionsPage = await extensionContext.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = optionsPage.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`).first();
    const checkbox = row.locator('.toggle input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();

    // Wait for the storage write to settle, then force a sync so the
    // navigation that follows doesn't race the debounced re-register.
    await expect(async () => {
      const ws = await sm.getCollectionWithScripts(collection!.id);
      expect(ws!.scripts[0].enabled).toBe(false);
    }).toPass();
    await sm.syncNow();

    // Navigate to the fixture page; the script should NOT inject.
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle('target');
    await page.close();
    await optionsPage.close();
  });
});
