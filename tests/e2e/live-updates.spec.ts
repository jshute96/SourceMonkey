// Live state watchers: the Collections page and the viewer follow
// chrome.storage.local writes made from ANOTHER origin (a background
// refresh, a second tab, the SW test surface) without a manual browser
// reload. Regression coverage for issue #10 — a script that recovered
// elsewhere kept its stale failure badge until the page was reloaded.

import fs from 'node:fs';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('collections page live updates', () => {
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
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
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
    await sm.updateCollection(collection!.id, 'manual');

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
    await sm.updateCollection(collection!.id, 'manual');
    await expect(statusCell.locator('a')).toHaveText('INVALID');
    await expect(row).toHaveAttribute('data-script-status', 'invalid');

    await page.close();
  });

  test('a live repaint keeps the diagnostic location in the hover text', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The row's `data-script-error` snapshot feeds both the status
    // link's hover text and every later repaint, and it is stored
    // already-described — message plus `(in <file>, line N…)`. The live
    // update path has to describe it the same way the first render does,
    // or a script that breaks while the page is open reports WHAT went
    // wrong without WHERE, and keeps doing so from then on.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = page.locator(`tr[data-script-id="${script.id}"]`);
    await expect(row).toHaveAttribute('data-script-status', 'ok');

    // Break the body with a syntax error the parse check can pin to a
    // line, and refresh from the SW so the page learns about it only
    // through the storage watcher.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'function () {}\n',
    });
    await sm.updateCollection(collection!.id, 'manual');

    await expect(row).toHaveAttribute('data-script-status', 'invalid');
    const stored = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(stored.errorLocation?.file).toBe('a.user.js');
    // Both the dataset and the visible hover text carry the location.
    await expect(row).toHaveAttribute('data-script-error', /\(in a\.user\.js, line \d+/);
    await expect(row.locator('td.status-cell a')).toHaveAttribute(
      'title', /\(in a\.user\.js, line \d+/,
    );

    await page.close();
  });

  test('an edited @description reaches the filename tooltip', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The Filename cell is only rebuilt when one of its inputs moved, so
    // the skip has to be able to tell "moved" from "didn't" — a repaint
    // that never rebuilds leaves the old tooltip and the old favicon on
    // screen for good.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'], extra: ['// @description first'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const nameLink = page.locator(`tr[data-script-id="${script.id}"] td.name-cell a:not(.site-icon-inner)`);
    await expect(nameLink).toHaveAttribute('title', 'first');

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'], extra: ['// @description second'] },
      body: '',
    });
    await sm.updateCollection(collection!.id, 'manual');
    await expect(nameLink).toHaveAttribute('title', 'second');

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
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const sourceCheckbox = section.locator('.collection-toggle input[type="checkbox"]');
    const row = page.locator(`tr[data-script-id="${script.id}"]`);
    const checkbox = row.locator('.toggle input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
    await expect(row).not.toHaveClass(/disabled/);

    // Per-script disable from the SW greys just this row.
    await sm.setScriptEnabled(script.id, false);
    await expect(checkbox).not.toBeChecked();
    await expect(row).toHaveClass(/disabled/);

    // Collection-level disable greys the whole section and hard-disables the
    // per-script checkbox (its underlying value is preserved). The
    // collection's OWN toggle has to follow too — it lives in the section
    // header, and nothing on this page clicked it, so a greyed-out
    // section under a checked "on" toggle is the state to avoid.
    await sm.setCollectionEnabled(collection!.id, false);
    await expect(section).toHaveClass(/disabled/);
    await expect(checkbox).toBeDisabled();
    await expect(sourceCheckbox).not.toBeChecked();

    // And back: re-enabling elsewhere re-checks it and ungreys the row.
    await sm.setCollectionEnabled(collection!.id, true);
    await expect(section).not.toHaveClass(/disabled/);
    await expect(sourceCheckbox).toBeChecked();
    await expect(checkbox).toBeEnabled();

    await page.close();
  });

  test('a repaint triggered elsewhere keeps the refresh highlights', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Refresh highlights say what changed on the last refresh and stay
    // until the next one. A script appearing elsewhere repaints this
    // section; the highlight survives because the repaint reuses the
    // `<tr>` rather than rebuilding it. If rows were ever recreated on
    // a repaint, the user's what-changed colour would vanish for a
    // completely unrelated reason.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const row = page.locator(`tr[data-script-id="${script.id}"]`);

    // Change the file, then refresh from THIS page so the row picks up
    // the green "updated" highlight.
    scriptsDir.rewriteBody('a.user.js', '/* v2 */\n');
    await section.locator('button', { hasText: 'Refresh' }).click();
    await expect(row).toHaveClass(/row-updated/);

    // A second script appears elsewhere: `scriptIds` changes, which is
    // structural, so the watcher rebuilds the section under us.
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.updateCollection(collection!.id, 'manual');

    await expect(section.locator('tbody tr')).toHaveCount(2);
    await expect(row).toHaveClass(/row-updated/);

    await page.close();
  });

  test('a later refresh clears the previous refresh highlights', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Rows survive a refresh now (updated in place, not rebuilt), so the
    // highlights have to be cleared explicitly — a section rebuild used
    // to do it implicitly by throwing the old rows away. Without that,
    // a row that changed once stays coloured through every later
    // refresh and the "what changed" signal stops meaning anything.
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
    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const a = scripts.find((s) => s.relativePath === 'a.user.js')!;
    const b = scripts.find((s) => s.relativePath === 'b.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const rowA = page.locator(`tr[data-script-id="${a.id}"]`);
    const rowB = page.locator(`tr[data-script-id="${b.id}"]`);
    const refresh = section.locator('button', { hasText: 'Refresh' });

    // Only a changed → only a is highlighted.
    scriptsDir.rewriteBody('a.user.js', '/* v2 */\n');
    await refresh.click();
    await expect(rowA).toHaveClass(/row-updated/);
    await expect(rowB).not.toHaveClass(/row-updated/);

    // Now only b changes. a's colour is from the previous refresh and
    // has to go.
    scriptsDir.rewriteBody('b.user.js', '/* v2 */\n');
    await refresh.click();
    await expect(rowB).toHaveClass(/row-updated/);
    await expect(rowA).not.toHaveClass(/row-updated/);

    await page.close();
  });

  test("the per-script Remove swaps in the container's own empty message", async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two things at once. The table and the "no scripts" message are
    // different elements, so this is the one path a repaint can't update
    // in place — it swaps the block whole. And the copy has to be the
    // CONTAINER's ("No scripts here yet"), not the
    // directory-scan one: the per-row Remove button only exists on
    // container rows, so hand-rolling that message here got it wrong on
    // every row that has the button.
    const file = scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(file);
    expect(collection!.path).toBe('container:file');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('tbody tr')).toHaveCount(1);

    page.once('dialog', (dialog) => void dialog.accept());
    await section.locator('tbody tr .remove-script').click();

    await expect(section.locator('table.script-table')).toHaveCount(0);
    await expect(section.locator('p.empty'))
      .toHaveText('No scripts here yet — add one above.');

    await page.close();
  });

  test('a scan failure appearing and clearing elsewhere updates the section', async ({
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
    await expect(section.locator('p.error')).toHaveCount(0);

    // Directory becomes unreadable → the scan fails and the section
    // grows an error line, with the scripts left in place.
    const moved = `${scriptsDir.path}-moved`;
    fs.renameSync(scriptsDir.path, moved);
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator('p.error')).toContainText('This collection did not load');
    await expect(section.locator('tbody tr')).toHaveCount(1);

    // Directory comes back → the error line goes away again.
    fs.renameSync(moved, scriptsDir.path);
    await sm.updateCollection(collection!.id, 'manual');
    await expect(section.locator('p.error')).toHaveCount(0);

    await page.close();
  });

  test('a collection removed elsewhere drops its section', async ({
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

    // Removed from the SW — the index reconcile drops the section and,
    // since it was the only one, puts the empty placeholder back.
    await sm.removeCollection(collection!.id);
    await expect(section).toHaveCount(0);
    await expect(page.locator('.empty-placeholder')).toHaveCount(1);

    await page.close();
  });

  test('a script added to the collection elsewhere appears as a new row', async ({
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
    await expect(section.locator('tbody tr')).toHaveCount(1);

    // A second file appears in the directory and a refresh happens from
    // the SW; the new row shows up without reloading the page.
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.updateCollection(collection!.id, 'manual');

    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const b = scripts.find((s) => s.relativePath === 'b.user.js')!;
    await expect(page.locator(`tr[data-script-id="${b.id}"]`)).toBeVisible();
    await expect(section.locator('tbody tr')).toHaveCount(2);

    await page.close();
  });

  // The page's own writes echo back into the live watcher (chrome.storage
  // fires in the writing context too). These two guard that the watcher
  // and the flow handler don't BOTH insert the same structural node.

  test("adding a collection via the page's own form yields exactly one section", async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;   // taken for its per-test resetAllState, not called directly
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator('.empty-placeholder')).toBeVisible();

    // addCollection writes the `collections` index early, then scans; the index
    // echo could make the watcher build the section before the handler's
    // own append. Exactly one section must exist, not two.
    await page.locator('#add-path').fill(scriptsDir.path);
    await page.locator('#add-form button[type="submit"]').click();

    await expect(page.locator('section.collection')).toHaveCount(1);
    await expect(page.locator('section.collection tbody tr')).toHaveCount(1);
    await expect(page.locator('.empty-placeholder')).toHaveCount(0);

    await page.close();
  });

  test("removing the last collection via the page's own button leaves one placeholder", async ({
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

    // removeCollection writes `collections: []`; that echo makes the watcher add
    // the empty placeholder. The handler must not add a second one.
    page.once('dialog', (dialog) => void dialog.accept());
    await section.locator('button', { hasText: 'Remove' }).click();

    await expect(section).toHaveCount(0);
    await expect(page.locator('.empty-placeholder')).toHaveCount(1);

    await page.close();
  });
});

// The stale-dataset bug this PR fixes was specifically about
// `data-script-refresh-error`: it was written when a refresh failed and
// never removed when the refresh started working again, so every later
// repaint recomputed REFRESH FAILED from the leftover value. Needs an
// HTTP collection, since that's what can fail a fetch and then recover.
test.describe('collections page live updates (refresh failures)', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('REFRESH FAILED appears and clears again without a reload', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const collection = await sm.addCollection(`${server.baseUrl}/app.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = page.locator(`tr[data-script-id="${script.id}"]`);
    const statusLink = row.locator('td.status-cell a');
    await expect(statusLink).toHaveText('OK');

    // The URL starts 404'ing. The script stays `ok` and injectable; only
    // the update failed, so the row flips to REFRESH FAILED and stores
    // the reason for its hover text.
    server.removeRoute('/app.user.js');
    await sm.updateCollection(collection!.id, 'manual');
    await expect(statusLink).toHaveText('REFRESH FAILED');
    await expect(row).toHaveAttribute('data-script-refresh-error', /.+/);
    await expect(row).toHaveAttribute('data-script-status', 'ok');

    // The collection comes back. Nothing about the STORED status changed
    // across this transition — it was `ok` throughout — so the cleared
    // `refreshError` can only show up if it reached the repaint and the
    // stale dataset was deleted.
    server.setRoute('/app.user.js', userscriptText('App', ' /* v2 */'));
    await sm.updateCollection(collection!.id, 'manual');
    await expect(row).not.toHaveAttribute('data-script-refresh-error');
    await expect(row.locator('td.status-cell')).not.toHaveClass(/status-refresh-failed/);

    // The badge still reads WARNING, because the failure and recovery
    // are both in the script's Log and the level promotes the cell.
    // Clearing the log drops the promotion — and that clear goes through
    // `applyStatusCellsToDom`, the repaint that recomputes purely from
    // the row datasets. It's the path a stale snapshot used to poison,
    // so this is where REFRESH FAILED would come back from the dead.
    await expect(statusLink).toHaveText('WARNING');
    await sm.clearScriptLog(script.id);
    await expect(statusLink).toHaveText('OK');

    await page.close();
  });
});

test.describe('viewer live updates', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a collection write that changes nothing on screen does not re-render', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The viewer only re-renders for the collection fields it displays. A
    // refresh rewrites `lastRefreshedAt` whether or not it achieved
    // anything, so without the filter a collection retrying a failing scan
    // would re-render every viewer open on it, forever. Proven by way of
    // the code pane's scroll position, which a re-render resets.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: `// ${'x'.repeat(60)}\n`.repeat(200),
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const codeBox = page.locator('#code-pane');
    await expect(codeBox).toBeVisible();
    await codeBox.evaluate((el) => { el.scrollTop = 400; });
    expect(await codeBox.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // Nothing about the file changed, so this refresh only bumps the
    // collection's `lastRefreshedAt`.
    await sm.updateCollection(collection!.id, 'manual');
    // Give a re-render the chance to happen before declaring it didn't.
    await page.waitForTimeout(300);
    expect(await codeBox.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    await page.close();
  });

  test('disabling the parent collection elsewhere greys the viewer toggle', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const checkbox = page.locator('#enable-checkbox');
    const label = page.locator('#enable-label');
    await expect(checkbox).toBeEnabled();
    await expect(label).not.toHaveClass(/toggle-disabled/);

    // Collection disabled from the collections page / another tab: the viewer's
    // Enable toggle greys out without a reload.
    await sm.setCollectionEnabled(collection!.id, false);
    await expect(checkbox).toBeDisabled();
    await expect(label).toHaveClass(/toggle-disabled/);

    await page.close();
  });
});
