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
    extensionContext, extensionId, vm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await vm.addSource(scriptsDir.path);
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
    extensionContext, extensionId, vm,
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
    const sources = await vm.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe(scriptsDir.path);
    await page.close();
  });

  test('Remove button drops the section and the storage rows', async ({
    extensionContext, extensionId, vm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await vm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section).toBeVisible();

    await section.locator('button', { hasText: 'Remove' }).click();
    await expect(section).toHaveCount(0);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    expect(await vm.getSources()).toHaveLength(0);
    await page.close();
  });

  test('per-script toggle disables matching for that script', async ({
    extensionContext, extensionId, fixtureServer, vm,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: { name: 'Mark', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'marked';`,
    });
    const source = await vm.addSource(scriptsDir.path);
    await vm.syncNow();

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
      const ws = await vm.getSourceWithScripts(source!.id);
      expect(ws!.scripts[0].enabled).toBe(false);
    }).toPass();
    await vm.syncNow();

    // Navigate to the fixture page; the script should NOT inject.
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle('target');
    await page.close();
    await optionsPage.close();
  });
});
