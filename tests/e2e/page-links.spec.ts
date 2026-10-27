// Cross-page links between the extension's own pages (src/extension/page-links.ts).
//
// Two things are under test:
//   - A link to the Collections or Options page opens a NEW tab, so the
//     page the user was reading survives the trip.
//   - Collections and Options are NAMED tabs: a second link to one
//     focuses the tab that is already open instead of stacking up
//     copies, and scrolls it to whatever the link pointed at.

import type { Page, Route } from '@playwright/test';
import { closeCollectionsTabs, test, expect } from '../fixtures/extension';
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

    await closeCollectionsTabs(extensionContext);
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

  test('Help opens the README in a new tab, by a plain or a middle click', async ({
    extensionContext, extensionId,
  }) => {
    // Answered here, so the test doesn't reach GitHub.
    const help = (r: Route) => r.fulfill({ body: 'help' });
    await extensionContext.route('https://github.com/**', help);
    for (const file of ['collections.html', 'options.html']) {
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/${file}`);
      for (const button of ['left', 'middle'] as const) {
        const [opened] = await Promise.all([
          extensionContext.waitForEvent('page'),
          page.locator('#open-help').click({ button }),
        ]);
        await opened.waitForURL('https://github.com/jshute96/SourceMonkey#readme');
        await opened.close();
      }
      await page.close();
    }
    await extensionContext.unroute('https://github.com/**', help);
  });

  test('a middle click on Options or Collections opens another tab beside this one, and Shift a window', async ({
    extensionContext, extensionId, getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    const tabsOf = (file: string) => sw.evaluate(async (f) => (await chrome.tabs.query({}))
      .filter((t) => (t.pendingUrl ?? t.url ?? '').includes(f))
      .map((t) => ({ id: t.id!, index: t.index, windowId: t.windowId, active: t.active })), file);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const options = await extensionContext.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await page.bringToFront();
    const here = (await tabsOf('collections.html')).find((t) => t.active)!;
    // Moved off the slot right of `here`, so only the new tab can be there.
    await sw.evaluate((id) => chrome.tabs.move(id, { index: -1 }), (await tabsOf('options.html'))[0].id);
    const before = new Set((await tabsOf('options.html')).map((t) => t.id));
    const added = async (file: string, known: Set<number>) =>
      (await tabsOf(file)).filter((t) => !known.has(t.id));

    // A second Options tab, though one is open: a plain click would reuse it.
    await page.locator('#open-options').click({ button: 'middle' });
    await expect.poll(async () => (await added('options.html', before)).length).toBe(1);
    const [beside] = await added('options.html', before);
    expect(beside).toMatchObject({ index: here.index + 1, windowId: here.windowId, active: false });

    before.add(beside.id);
    await page.locator('#open-options').click({ modifiers: ['Shift'] });
    await expect.poll(async () => (await added('options.html', before)).length).toBe(1);
    const [inWindow] = await added('options.html', before);
    expect(inWindow.windowId).not.toBe(here.windowId);

    const collections = new Set((await tabsOf('collections.html')).map((t) => t.id));
    await options.bringToFront();
    await options.locator('#open-collections').click({ button: 'middle' });
    await expect.poll(async () => (await added('collections.html', collections)).length).toBe(1);

    for (const p of extensionContext.pages()) {
      if (/(options|collections)\.html/.test(p.url())) await p.close();
    }
  });
});
