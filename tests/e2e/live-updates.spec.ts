// Live state watchers: the Sources page and the viewer follow
// chrome.storage.local writes made from ANOTHER origin (a background
// refresh, a second tab, the SW test surface) without a manual browser
// reload. Regression coverage for issue #10 — a script that recovered
// elsewhere kept its stale failure badge until the page was reloaded.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('sources page live updates', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a status change made elsewhere repaints the row without a reload', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Start invalid (no @name), so the first paint is INVALID.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const row = page.locator(`tr[data-script-id="${script.id}"]`);
    const statusCell = row.locator('td.status-cell');
    await expect(statusCell.locator('a')).toHaveText('INVALID');
    await expect(row).toHaveAttribute('data-script-status', 'invalid');

    // Fix the file and refresh it from the SW — i.e. NOT via this page's
    // own Refresh button. The row must follow the stored status off
    // INVALID, and the stale `data-script-*` snapshot must be cleared so
    // the recompute can't pin the cell to INVALID (the issue-#10 bug).
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.updateSource(source!.id, 'manual');

    await expect(row).toHaveAttribute('data-script-status', 'ok');
    await expect(statusCell).not.toHaveClass(/status-invalid/);
    // The invalid-only error snapshot is gone, not left dangling.
    await expect(row).not.toHaveAttribute('data-script-error');

    // And the reverse transition still lands: breaking the file again
    // brings INVALID straight back.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.updateSource(source!.id, 'manual');
    await expect(statusCell.locator('a')).toHaveText('INVALID');
    await expect(row).toHaveAttribute('data-script-status', 'invalid');

    await page.close();
  });

  test('enabled toggles flipped elsewhere grey the row and section', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    const row = page.locator(`tr[data-script-id="${script.id}"]`);
    const checkbox = row.locator('.toggle input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
    await expect(row).not.toHaveClass(/disabled/);

    // Per-script disable from the SW greys just this row.
    await sm.setScriptEnabled(script.id, false);
    await expect(checkbox).not.toBeChecked();
    await expect(row).toHaveClass(/disabled/);

    // Source-level disable greys the whole section and hard-disables the
    // per-script checkbox (its underlying value is preserved).
    await sm.setSourceEnabled(source!.id, false);
    await expect(section).toHaveClass(/disabled/);
    await expect(checkbox).toBeDisabled();

    await page.close();
  });

  test('a script added to the source elsewhere appears as a new row', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(1);

    // A second file appears in the directory and a refresh happens from
    // the SW; the new row shows up without reloading the page.
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.updateSource(source!.id, 'manual');

    const scripts = (await sm.getSourceWithScripts(source!.id))!.scripts;
    const b = scripts.find((s) => s.relativePath === 'b.user.js')!;
    await expect(page.locator(`tr[data-script-id="${b.id}"]`)).toBeVisible();
    await expect(section.locator('tbody tr')).toHaveCount(2);

    await page.close();
  });

  // The page's own writes echo back into the live watcher (chrome.storage
  // fires in the writing context too). These two guard that the watcher
  // and the flow handler don't BOTH insert the same structural node.

  test("adding a source via the page's own form yields exactly one section", async ({
    extensionContext, extensionId,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    // addSource writes the `sources` index early, then scans; the index
    // echo could make the watcher build the section before the handler's
    // own append. Exactly one section must exist, not two.
    await page.locator('#add-path').fill(scriptsDir.path);
    await page.locator('#add-form button[type="submit"]').click();

    await expect(page.locator('section.directory')).toHaveCount(1);
    await expect(page.locator('section.directory tbody tr')).toHaveCount(1);
    await expect(page.locator('.empty-placeholder')).toHaveCount(0);

    await page.close();
  });

  test("removing the last source via the page's own button leaves one placeholder", async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const section = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    await expect(section).toBeVisible();

    // removeSource writes `sources: []`; that echo makes the watcher add
    // the empty placeholder. The handler must not add a second one.
    page.once('dialog', (dialog) => void dialog.accept());
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toHaveCount(0);
    await expect(page.locator('.empty-placeholder')).toHaveCount(1);

    await page.close();
  });
});

test.describe('viewer live updates', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('disabling the parent source elsewhere greys the viewer toggle', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const checkbox = page.locator('#enable-checkbox');
    const label = page.locator('#enable-label');
    await expect(checkbox).toBeEnabled();
    await expect(label).not.toHaveClass(/toggle-disabled/);

    // Source disabled from the sources page / another tab: the viewer's
    // Enable toggle greys out without a reload.
    await sm.setSourceEnabled(source!.id, false);
    await expect(checkbox).toBeDisabled();
    await expect(label).toHaveClass(/toggle-disabled/);

    await page.close();
  });
});
