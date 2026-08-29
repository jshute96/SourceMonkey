// E2E coverage for the gm-menu userscript example.
//
// Manager-agnostic: only asserts the page-side mirror (the
// `#registered` <ul>) the userscript maintains for the page itself.
// The cross-manager part — that TM and SM both call the registered
// callback — needs a manager-specific test (Playwright can't drive
// either toolbar's right-click menu). The SourceMonkey-side fire path
// is covered separately in `tests/e2e/gm-menu.spec.ts`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-menu', () => {
  test('by-name pair: each Register adds a new entry; Unregister peels them off LIFO', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // VM keys menu commands by `opts.id || caption`, so registering
    // the same caption three times replaces one entry instead of
    // stacking three. This test is entirely about that stacking, so
    // there's nothing left to assert once it's gone. See
    // docs/cross-manager-test-results.md.
    test.skip(setup.manager === 'violentmonkey', 'VM keys menu commands by caption, so same-name registrations collapse');

    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-menu/gm-menu.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // Nothing registered on load.
    await expect(page.locator('#registered li.empty')).toHaveCount(1);

    // Three register clicks → three distinct entries with the same
    // visible name. Each gets a unique generated id from
    // GM_registerMenuCommand.
    await page.locator('#btn-register-by-name').click();
    await page.locator('#btn-register-by-name').click();
    await page.locator('#btn-register-by-name').click();
    await expect(page.locator('#registered li')).toHaveCount(3);
    const ids = await page.locator('#registered li').evaluateAll(
      (els) => els.map((li) => (li as HTMLLIElement).dataset.id),
    );
    expect(new Set(ids).size).toBe(3); // all distinct
    await expect(page.locator('#registered')).toContainText('Toggle Foo');

    // Unregister picks the most recent entry (LIFO). The first
    // unregister should remove the third id; the second should remove
    // the second id; etc.
    const beforeFirstRemove = ids.slice();
    await page.locator('#btn-unregister-by-name').click();
    await expect(page.locator('#registered li')).toHaveCount(2);
    const afterFirst = await page.locator('#registered li').evaluateAll(
      (els) => els.map((li) => (li as HTMLLIElement).dataset.id),
    );
    expect(afterFirst).toEqual(beforeFirstRemove.slice(0, 2));

    // Second unregister: peels off the next-newest.
    await page.locator('#btn-unregister-by-name').click();
    await expect(page.locator('#registered li')).toHaveCount(1);
    const afterSecond = await page.locator('#registered li').evaluateAll(
      (els) => els.map((li) => (li as HTMLLIElement).dataset.id),
    );
    expect(afterSecond).toEqual(beforeFirstRemove.slice(0, 1));

    // Third unregister empties the list.
    await page.locator('#btn-unregister-by-name').click();
    await expect(page.locator('#registered li.empty')).toHaveCount(1);

    // Fourth unregister with nothing to remove: the userscript logs
    // a "no entries named" line and stays silent on the GM side.
    await page.locator('#btn-unregister-by-name').click();
    await expect(page.locator('#log')).toContainText(/no entries named "Toggle Foo"/);
    await expect(page.locator('#registered li.empty')).toHaveCount(1);

    await page.close();
  });

  test('by-id pair: re-register updates in place; double-unregister is a silent no-op', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-menu/gm-menu.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    // First register: one entry with the fixed id.
    await page.locator('#btn-register-by-id').click();
    await expect(page.locator('#registered li')).toHaveCount(1);
    await expect(page.locator('#registered li').first()).toContainText('id: bar-settings');

    // Second register with the same options.id → still one entry
    // (TM/VM update-in-place semantics).
    await page.locator('#btn-register-by-id').click();
    await page.locator('#btn-register-by-id').click();
    await expect(page.locator('#registered li')).toHaveCount(1);
    await expect(page.locator('#registered li').first()).toContainText('id: bar-settings');

    // Unregister removes the entry.
    await page.locator('#btn-unregister-by-id').click();
    await expect(page.locator('#registered li.empty')).toHaveCount(1);

    // Second unregister with nothing registered: silent no-op. The
    // userscript exercises this by calling GM_unregisterMenuCommand
    // anyway, and TM/VM/SM all accept the unknown id without throwing.
    await page.locator('#btn-unregister-by-id').click();
    await expect(page.locator('#log')).toContainText(/returned without throwing/);
    await expect(page.locator('#registered li.empty')).toHaveCount(1);

    await page.close();
  });
});
