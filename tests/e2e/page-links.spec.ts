// Cross-page links between the extension's own pages (src/extension/page-links.ts).
//
// Two things are under test:
//   - A link to the Collections or Options page opens a NEW tab, so the
//     page the user was reading survives the trip.
//   - Collections and Options are NAMED tabs: a second link to one
//     focuses the tab that is already open instead of stacking up
//     copies, and scrolls it to whatever the link pointed at.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Every extension tab currently showing `file`.
async function tabsShowing(page: Page, file: string): Promise<Page[]> {
  return page.context().pages().filter((p) => p.url().includes(file));
}

test.describe('cross-page links', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('the Options button opens Options in a new tab, and reuses it after that', async ({
    extensionContext, extensionId,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    const [options] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#open-options').click(),
    ]);
    await options.waitForURL(/options\.html/);
    // The collections page is still the collections page.
    await expect(page).toHaveURL(/collections\.html/);

    // A second click has nowhere new to go: the named tab already exists.
    await page.bringToFront();
    await page.locator('#open-options').click();
    await expect.poll(async () => (await tabsShowing(page, 'options.html')).length).toBe(1);

    await options.close();
    await page.close();
  });

  test('Options links back to the collections tab it was opened from', async ({
    extensionContext, extensionId,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const options = await extensionContext.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    await options.locator('#open-collections').click();
    // No second collections tab, and the existing one is now active.
    await expect.poll(async () => (await tabsShowing(page, 'collections.html')).length).toBe(1);

    await options.close();
    await page.close();
  });

  test('the viewer\'s collection link opens the collections tab and scrolls to that collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const withScripts = await sm.getCollectionWithScripts(collection!.id);
    const scriptId = withScripts!.scripts[0].id;

    const viewer = await extensionContext.newPage();
    await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);

    const link = viewer.locator('#header-summary .collection-display-name');
    // A real href, so the browser's own new-tab gestures still work.
    await expect(link).toHaveAttribute('href', `collections.html#collection-${collection!.id}`);

    const [collections] = await Promise.all([
      extensionContext.waitForEvent('page'),
      link.click(),
    ]);
    await collections.waitForURL(/collections\.html/);
    // The viewer stayed put — that is the whole point of the new tab.
    await expect(viewer).toHaveURL(/userscript\.html\?script=/);
    await expect(collections.locator(`#collection-${collection!.id}`)).toBeVisible();

    await collections.close();
    await viewer.close();
  });

  test('a link into an already-open collections tab scrolls it to that collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two collections, the viewer showing a script in the SECOND one,
    // and the collections tab opened on its own rather than by the
    // link — the case the focus message exists for, since a loaded tab
    // does not act on a fragment written into its URL.
    const dirs = [ScriptsDir.create(), ScriptsDir.create()];
    try {
      const ids: string[] = [];
      for (const [i, dir] of dirs.entries()) {
        // The first collection gets enough rows to push the second
        // section well below the fold; one row would leave the page
        // too short to scroll and the assertion vacuous.
        const rows = i === 0 ? 40 : 1;
        for (let n = 0; n < rows; n += 1) {
          dir.write({
            relativePath: `s${i}-${n}.user.js`,
            meta: { name: `S${i}-${n}`, match: ['https://example.com/*'] },
            body: '',
          });
        }
        const collection = await sm.addCollection(dir.path);
        ids.push(collection!.id);
      }
      const target = ids[1];
      const withScripts = await sm.getCollectionWithScripts(target);
      const scriptId = withScripts!.scripts[0].id;

      const collections = await extensionContext.newPage();
      await collections.goto(`chrome-extension://${extensionId}/collections.html`);
      await expect(collections.locator(`#collection-${target}`)).toBeAttached();
      expect(await collections.evaluate(() => window.scrollY)).toBe(0);

      const viewer = await extensionContext.newPage();
      await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
      await viewer.locator('#header-summary .collection-display-name').click();

      // No second collections tab, and the one that was open moved to
      // the linked section and took the anchor into its URL.
      await expect.poll(async () => (await tabsShowing(viewer, 'collections.html')).length).toBe(1);
      await expect.poll(() => collections.evaluate(() => location.hash))
        .toBe(`#collection-${target}`);
      await expect.poll(() => collections.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await expect(viewer).toHaveURL(/userscript\.html\?script=/);

      await viewer.close();
      await collections.close();
    } finally {
      for (const dir of dirs) dir.cleanup();
    }
  });

  test('the header bar\'s product name is a link to the collections tab', async ({
    extensionContext, extensionId,
  }) => {
    const collections = await extensionContext.newPage();
    await collections.goto(`chrome-extension://${extensionId}/collections.html`);

    const options = await extensionContext.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('h1 a.page-home').click();

    // Focused the tab that was already open rather than opening another.
    await expect.poll(async () => (await tabsShowing(options, 'collections.html')).length).toBe(1);
    await expect(options).toHaveURL(/options\.html/);

    await options.close();
    await collections.close();
  });
});
