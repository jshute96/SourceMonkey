// Options page UI: adding a directory through the form, toggling a
// script, removing a source. The page talks to the same script-store
// the SW does, so these exercise the real add/remove pipeline without
// any SW-side shortcut.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('options page', () => {
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
    const source = await sm.addSource(scriptsDir.path);
    expect(source).not.toBeNull();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator(`section.directory[data-source-id="${source!.id}"] h2`))
      .toHaveText(scriptsDir.path);
    await expect(page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`))
      .toHaveCount(1);
    await page.close();
  });

  test('add-directory form registers a new source', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'hi.user.js',
      meta: { name: 'Hi', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    await page.locator('#add-path').fill(scriptsDir.path);
    await page.locator('#add-form button[type="submit"]').click();

    // Section appears with the new script row.
    await expect(page.locator('section.directory')).toHaveCount(1);
    await expect(page.locator('section.directory h2')).toHaveText(scriptsDir.path);
    await expect(page.locator('section.directory tbody tr')).toHaveCount(1);

    // And the SW now sees the source.
    const sources = await sm.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe(scriptsDir.path);
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
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section).toBeVisible();

    // Source has 1 script, so Remove now prompts a confirm.
    page.once('dialog', (dialog) => void dialog.accept());
    await section.locator('button', { hasText: 'Remove' }).click();
    await expect(section).toHaveCount(0);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    expect(await sm.getSources()).toHaveLength(0);
    await page.close();
  });

  test('?add_source registers a new source and jumps to its anchor', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/options.html`);
    url.searchParams.set('add_source', scriptsDir.path);
    await page.goto(url.toString());

    // Section gets rendered, URL hash points to it, query param is scrubbed.
    const section = page.locator('section.directory').first();
    await expect(section).toBeVisible();
    await expect(section.locator('h2')).toHaveText(scriptsDir.path);

    const sources = await sm.getSources();
    expect(sources).toHaveLength(1);
    const sourceId = sources[0].id;
    await expect(section).toHaveAttribute('id', `source-${sourceId}`);

    await expect.poll(() => page.evaluate(() => location.hash))
      .toBe(`#source-${sourceId}`);
    await expect.poll(() => page.evaluate(() => location.search))
      .toBe('');

    await page.close();
  });

  test('?add_source on an already-registered path jumps to existing without re-adding', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const existing = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/options.html`);
    url.searchParams.set('add_source', scriptsDir.path);
    await page.goto(url.toString());

    // Still exactly one source — no duplicate row.
    await expect(page.locator('section.directory')).toHaveCount(1);
    expect(await sm.getSources()).toHaveLength(1);

    // URL hash points at the existing source.
    await expect.poll(() => page.evaluate(() => location.hash))
      .toBe(`#source-${existing!.id}`);

    // User is told why nothing new appeared.
    await expect(page.locator('#add-error')).toBeVisible();
    await expect(page.locator('#add-error')).toContainText('already registered');

    await page.close();
  });

  test('?add_source with invalid input shows an error and does not add', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/options.html`);
    url.searchParams.set('add_source', 'not-a-valid-path-or-url');
    await page.goto(url.toString());

    const errorEl = page.locator('#add-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toContainText(/absolute path|http\(s\):\/\/|file:\/\//);

    expect(await sm.getSources()).toHaveLength(0);
    await expect(page.locator('section.directory')).toHaveCount(0);

    // URL preserves `add_source` so the user can edit/retry/reload.
    await expect.poll(() => page.evaluate(() => location.search))
      .toContain('add_source');

    await page.close();
  });

  test('?add_source rejects a bare "/" path', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    const url = new URL(`chrome-extension://${extensionId}/options.html`);
    url.searchParams.set('add_source', '/');
    await page.goto(url.toString());

    await expect(page.locator('#add-error')).toBeVisible();
    expect(await sm.getSources()).toHaveLength(0);

    await page.close();
  });

  test('Remove confirm: cancel keeps the source', async ({
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
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section).toBeVisible();

    // Dismiss the confirm — section must stay.
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('Remove source with 2 scripts?');
      await dialog.dismiss();
    });
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toBeVisible();
    expect(await sm.getSources()).toHaveLength(1);

    await page.close();
  });

  test('Remove confirm: accept removes the source', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'only.user.js',
      meta: { name: 'Only', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section).toBeVisible();

    // Singular "script" since count is 1.
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe('Remove source with 1 script?');
      await dialog.accept();
    });
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toHaveCount(0);
    expect(await sm.getSources()).toHaveLength(0);

    await page.close();
  });

  test('Remove on an empty source does not prompt', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Create a dir but write no userscripts — the source loads with
    // zero scripts, so Remove should skip the confirm prompt.
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
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
    expect(await sm.getSources()).toHaveLength(0);

    await page.close();
  });

  test('per-script toggle disables matching for that script', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: { name: 'Mark', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'marked';`,
    });
    const source = await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    // Toggle the script OFF via the options page.
    const optionsPage = await extensionContext.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    const row = optionsPage.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const checkbox = row.locator('.toggle input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();

    // Wait for the storage write to settle, then force a sync so the
    // navigation that follows doesn't race the debounced re-register.
    await expect(async () => {
      const ws = await sm.getSourceWithScripts(source!.id);
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
