// The toolbar popup, "Active scripts" (popup.html). Opened here as an
// ordinary tab with `?tab=<id>`, since Playwright can't click the
// toolbar; the toolbar click itself is driven through the worker's
// `clickAction` test surface. Design: docs/status-popup.md.

import type { BrowserContext, Page, Worker } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId, allScripts, waitFor, waitForTabState, type SmApi } from '../fixtures/sw-api';

async function openPopup(context: BrowserContext, extensionId: string, tabId: number): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await expect(popup.locator('body[data-ready="true"]')).toBeAttached();
  return popup;
}

// "Collection: script, script | Collection: …" per section, from the
// rendered page.
async function sectionText(popup: Page, section: 'enabled' | 'disabled'): Promise<string> {
  return await popup.evaluate((sec) => {
    const out: string[] = [];
    const el = document.querySelector(`section[data-section="${sec}"]`);
    for (const head of el?.querySelectorAll('.group-head') ?? []) {
      const names: string[] = [];
      let n = head.nextElementSibling;
      while (n && n.classList.contains('row')) {
        names.push(n.querySelector('.script-name')!.textContent!);
        n = n.nextElementSibling;
      }
      out.push(`${head.querySelector('.collection-name')!.textContent}: ${names.join(', ')}`);
    }
    return out.join(' | ');
  }, section);
}

// The window shows the collections page: a double click opens it, or
// brings forward one an earlier test left open.
// The extension page showing in the window's active tab, or null for a
// web page. The worker can't read a tab's URL; an extension page's
// context carries it.
async function activePagePath(sw: Worker, windowId: number): Promise<string | null> {
  return await sw.evaluate(async (id) => {
    const [active] = await chrome.tabs.query({ active: true, windowId: id });
    const pages = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
    const page = pages.find((c) => c.tabId === active?.id);
    return page?.documentUrl ? new URL(page.documentUrl).pathname : null;
  }, windowId);
}

// Collections-page tabs, closed by `closeCollectionsTabs` so a test can
// tell whether it opened one. Earlier tests' tabs linger in the window.
async function collectionsTabIds(sw: Worker): Promise<number[]> {
  return await sw.evaluate(async () => (await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
  })).filter((c) => c.documentUrl && new URL(c.documentUrl).pathname === '/collections.html').map((c) => c.tabId));
}

async function closeCollectionsTabs(sw: Worker): Promise<void> {
  const ids = await collectionsTabIds(sw);
  if (ids.length) await sw.evaluate((list) => chrome.tabs.remove(list), ids);
}

async function expectCollectionsShown(getServiceWorker: () => Promise<Worker>, windowId: number): Promise<void> {
  const sw = await getServiceWorker();
  await expect.poll(() => activePagePath(sw, windowId)).toBe('/collections.html');
}

async function popupContexts(sw: Worker): Promise<number> {
  return await sw.evaluate(async () => (await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.POPUP],
  })).length);
}

async function windowOf(getServiceWorker: () => Promise<Worker>, tabId: number): Promise<number> {
  const sw = await getServiceWorker();
  return await sw.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, tabId);
}

test.describe('toolbar popup', () => {
  let dirs: ScriptsDir[];
  test.beforeEach(() => { dirs = []; });
  test.afterEach(() => { for (const d of dirs) d.cleanup(); });

  function dir(): ScriptsDir {
    const d = ScriptsDir.create();
    dirs.push(d);
    return d;
  }

  // Two collections on one page:
  //   A: Alpha (on), Beta (off), Shared (on)
  //   B: Gamma (on), Shared (off), a copy of A's
  async function twoCollections(sm: SmApi, base: string): Promise<{ a: string; b: string }> {
    const match = [`${base}/*`];
    const a = dir();
    a.write({ relativePath: 'alpha.user.js', meta: { name: 'Alpha', match }, body: `document.documentElement.dataset.alpha = 'ran';` });
    a.write({ relativePath: 'beta.user.js', meta: { name: 'Beta', match }, body: `` });
    a.write({ relativePath: 'shared.user.js', meta: { name: 'Shared', match, extra: ['// @namespace   ns', '// @version     1.0'] }, body: `` });
    const b = dir();
    b.write({ relativePath: 'gamma.user.js', meta: { name: 'Gamma', match }, body: `` });
    b.write({ relativePath: 'shared.user.js', meta: { name: 'Shared', match, extra: ['// @namespace   ns', '// @version     2.0'] }, body: `` });
    const ca = (await sm.addCollection(a.path))!;
    const cb = (await sm.addCollection(b.path))!;
    const scripts = await allScripts(sm);
    const id = (coll: string, file: string) => scripts.find((s) => s.collectionId === coll && s.relativePath === file)!.id;
    await sm.setScriptEnabled(id(ca.id, 'beta.user.js'), false);
    await sm.setScriptEnabled(id(cb.id, 'shared.user.js'), false);
    // Adding B turned A's Shared off, as the newer copy took over.
    await sm.setScriptEnabled(id(ca.id, 'shared.user.js'), true);
    await sm.syncNow();
    return { a: ca.id, b: cb.id };
  }

  test('lists scripts by collection, one row per script, enabled apart from disabled', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Gamma | OK'), 'scripts ran');

    const popup = await openPopup(extensionContext, extensionId, tabId);
    await expect(popup).toHaveTitle('SourceMonkey | Active scripts');
    // Collections in collections-page order; B's disabled Shared is
    // hidden behind A's running copy.
    await expect.poll(() => sectionText(popup, 'enabled')).toBe(
      `${await collectionName(popup, 0)}: Alpha, Shared | ${await collectionName(popup, 1)}: Gamma`,
    );
    expect(await sectionText(popup, 'disabled')).toBe(`${await collectionName(popup, 0, 'disabled')}: Beta`);
    await expect(popup.locator('.row', { hasText: 'Alpha' }).locator('.pill')).toHaveText('Running');
    await expect(popup.locator('.row', { hasText: 'Alpha' }).locator('.pill')).toHaveAttribute('title', /Running on this page\nClick to open the script log\./);
    await expect(popup.locator('.row', { hasText: 'Beta' }).locator('.pill')).toHaveCount(0);
    // A disabled script's per-script reloads are greyed; an active one's aren't.
    await popup.locator('.row', { hasText: 'Beta' }).locator('button.kebab').click();
    await expect(popup.getByRole('menuitem', { name: 'Reload page with only this script' })).toBeDisabled();
    await expect(popup.getByRole('menuitem', { name: 'Reload page without this script' })).toBeDisabled();
    await expect(popup.getByRole('menuitem', { name: 'Script details' })).toBeEnabled();
    await popup.locator('.row', { hasText: 'Alpha' }).locator('button.kebab').click();
    await expect(popup.getByRole('menuitem', { name: 'Reload page with only this script' })).toBeEnabled();
    await popup.keyboard.press('Escape');
    // No reload needed yet.
    await expect(popup.locator('.banner-row.reload')).toHaveCount(0);
    await popup.close();
    await page.close();
  });

  test('a script removed while its page is open turns the badge purple, and a reload clears it', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const d = dir();
    const match = [`${fixtureServer.baseUrl}/*`];
    d.write({ relativePath: 'keep.user.js', meta: { name: 'Keep', match }, body: `` });
    d.write({ relativePath: 'gone.user.js', meta: { name: 'Gone', match }, body: `` });
    await sm.addCollection(d.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Keep | OK') && s.rows.includes('Gone | OK'), 'both ran');

    const gone = (await allScripts(sm)).find((s) => s.relativePath === 'gone.user.js')!;
    await sm.removeScript(gone.id);
    await sm.syncNow();
    // Purple: a reload would remove it.
    const snap = await waitForTabState(
      sm, tabId,
      (s) => s.rows.includes('Gone | STILL_RUNNING') && s.title.includes('\nReload needed to remove 1 script.\n'),
      'Gone still running after its delete',
    );
    expect(snap.badgeColor).toEqual([0xd5, 0x00, 0xf9, 255]);

    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.rows.join('\n') === 'Keep | OK', 'only Keep after the reload');
    await page.close();
  });

  test('toggles word the reload banner and the pills', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Alpha | OK'), 'Alpha ran');
    const popup = await openPopup(extensionContext, extensionId, tabId);

    const order = () => popup.locator('.row .script-name').allTextContents();
    const before = await order();
    // Disable Alpha: it stays where it is (the layout holds while the
    // popup is open), greyed, still running until a reload.
    const alphaBox = popup.locator('.row', { hasText: 'Alpha' }).locator('input[type="checkbox"]');
    const boxTop = async () => (await alphaBox.boundingBox())!.y;
    const topBefore = await boxTop();
    await alphaBox.uncheck();
    await expect(popup.locator('section[data-section="enabled"] .row', { hasText: 'Alpha' }).locator('.pill')).toHaveText('Still running');
    await expect(popup.locator('.row', { hasText: 'Alpha' })).toHaveClass(/\boff\b/);
    await expect(popup.locator('.banner-row.reload')).toContainText('Reload required: Scripts disabled');
    // The banner appears below the list, so the checkbox just clicked
    // stays under the pointer.
    expect(await boxTop()).toBe(topBefore);

    // Enable Beta as well: the banner says the mix changed.
    await popup.locator('.row', { hasText: 'Beta' }).locator('input[type="checkbox"]').check();
    await expect(popup.locator('section[data-section="disabled"] .row', { hasText: 'Beta' }).locator('.pill')).toHaveText('Reload to run');
    await expect(popup.locator('.banner-row.reload')).toContainText('Reload required: Enabled scripts changed');
    expect(await order()).toEqual(before);

    // The banner's Reload settles both.
    await popup.locator('.banner-row.reload button').click();
    await expect(popup.locator('.banner-row.reload')).toHaveCount(0);
    await expect(popup.locator('.row', { hasText: 'Beta' }).locator('.pill')).toHaveText('Running');
    expect(await page.evaluate(() => document.documentElement.dataset.alpha ?? null)).toBeNull();
    // Nor does the reload move anything.
    expect(await order()).toEqual(before);
    // Reopened, it sorts afresh: Alpha under Disabled, Beta under Enabled.
    await popup.reload();
    await expect(popup.locator('section[data-section="disabled"] .row', { hasText: 'Alpha' })).toBeVisible();
    await expect(popup.locator('section[data-section="enabled"] .row', { hasText: 'Beta' })).toBeVisible();
    await popup.close();
    await page.close();
  });

  test('the checkbox turns other copies off, and the copy last turned off stands for the script', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const { a, b } = await twoCollections(sm, fixtureServer.baseUrl);
    const scripts = await allScripts(sm);
    const shared = (coll: string) => scripts.find((s) => s.collectionId === coll && s.relativePath === 'shared.user.js')!.id;
    const enabledOf = async (id: string) => (await allScripts(sm)).find((s) => s.id === id)!.enabled;
    // Both copies running (as a Ctrl-click leaves them), then B's
    // turned off last: B's is the one to offer back, though A's comes
    // first in collection order. Before the page loads, so neither
    // is listed for still running in it.
    await sm.setScriptEnabled(shared(b), true);
    await sm.setScriptEnabled(shared(a), false);
    await sm.setScriptEnabled(shared(b), false);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Alpha | OK'), 'Alpha ran');
    let popup = await openPopup(extensionContext, extensionId, tabId);
    const disabledShared = popup.locator('section[data-section="disabled"] .row', { hasText: 'Shared' });
    await expect(disabledShared).toHaveAttribute('data-script-id', shared(b));
    await popup.close();

    // Both running again, so both are listed. A's turned off and back
    // on in the popup turns B's off.
    await sm.setScriptEnabled(shared(a), true);
    await sm.setScriptEnabled(shared(b), true);
    await sm.syncNow();
    popup = await openPopup(extensionContext, extensionId, tabId);
    const boxA = popup.locator(`.row[data-script-id="${shared(a)}"] input[type="checkbox"]`);
    await boxA.uncheck();
    await expect.poll(() => enabledOf(shared(a))).toBe(false);
    expect(await enabledOf(shared(b))).toBe(true);
    await boxA.check();
    await expect.poll(() => enabledOf(shared(b))).toBe(false);
    expect(await enabledOf(shared(a))).toBe(true);
    await popup.close();
    await page.close();
  });

  test('an enabled script that failed to load but targets the page is listed as Invalid', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const d = dir();
    // Valid @match, but its @require isn't there, so it lands invalid.
    d.write({
      relativePath: 'broken.user.js',
      meta: { name: 'Broken', match: [`${fixtureServer.baseUrl}/*`], extra: ['// @require     missing-lib.js'] },
      body: ``,
    });
    await sm.addCollection(d.path);
    expect((await allScripts(sm))[0]!.status).toBe('invalid');
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const popup = await openPopup(extensionContext, extensionId, tabId);
    const row = popup.locator('section[data-section="enabled"] .row', { hasText: 'Broken' });
    await expect(row.locator('.pill')).toHaveText('Invalid');
    await expect(row.locator('.pill')).toHaveAttribute('title', /failed to load, so it can't run: .*missing-lib\.js/);
    await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    await expect(popup.locator('.banner-row.reload')).toHaveCount(0);
    await popup.close();
    await page.close();
  });

  test('a script removed while it runs in the page stays listed, under Removed scripts', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const { a } = await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Alpha | OK'), 'Alpha ran');
    await sm.removeCollection(a);
    await sm.syncNow();

    const popup = await openPopup(extensionContext, extensionId, tabId);
    const group = popup.locator('section[data-section="enabled"] .group-head', { hasText: 'Removed scripts' });
    await expect(group).toBeVisible();
    const row = popup.locator('section[data-section="enabled"] .row', { hasText: 'Alpha' });
    await expect(row.locator('.pill')).toHaveText('Still running');
    await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(popup.locator('.banner-row.reload')).toContainText('Reload required: Scripts removed');
    await popup.close();
    await page.close();
  });

  test('a disabled collection sits under Disabled, its scripts greyed', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const { b } = await twoCollections(sm, fixtureServer.baseUrl);
    await sm.setCollectionEnabled(b, false);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const popup = await openPopup(extensionContext, extensionId, tabId);

    const head = popup.locator(`section[data-section="disabled"] .group-head[data-collection-id="${b}"]`);
    await expect(head.locator('.collection-off')).toHaveText('Collection off');
    const gamma = popup.locator('section[data-section="disabled"] .row', { hasText: 'Gamma' });
    await expect(gamma).toHaveClass(/muted/);
    await expect(gamma.locator('input[type="checkbox"]')).toBeChecked();
    await expect(gamma.locator('input[type="checkbox"]')).toHaveAttribute(
      'title', 'Enable this script\nScript will not run because its collection is disabled');

    // The collection's menu turns it back on.
    await head.locator('button.kebab').click();
    await popup.getByRole('menuitem', { name: 'Enable collection' }).click();
    const pill = popup.locator('section[data-section="disabled"] .row', { hasText: 'Gamma' }).locator('.pill');
    await expect(pill).toHaveText('Reload to run');
    await expect(head.locator('.collection-off')).toHaveCount(0);

    // Clicking Reload to run reloads the page, so Gamma runs.
    await expect(pill).toHaveAttribute('title', /\nClick to reload the page\.$/);
    await sm.syncNow();
    await pill.click();
    await expect(pill).toHaveText('Running');
    await popup.close();
    await page.close();
  });

  test('lists menu commands, collapsing a long list, and runs them', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const d = dir();
    d.write({
      relativePath: 'cmds.user.js',
      meta: { name: 'Cmds', match: [`${fixtureServer.baseUrl}/*`], grant: ['GM_registerMenuCommand'] },
      body: `
        GM_registerMenuCommand('Paint', () => { document.body.dataset.painted = 'yes'; });
      `,
    });
    d.write({
      relativePath: 'many.user.js',
      meta: { name: 'Many', match: [`${fixtureServer.baseUrl}/*`], grant: ['GM_registerMenuCommand'] },
      body: `for (const n of ['M1', 'M2', 'M3', 'M4', 'M5']) GM_registerMenuCommand(n, () => {});`,
    });
    await sm.addCollection(d.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitFor(() => sm.getActionContextMenu(tabId), (g) => g.length === 2, { label: 'commands registered' });
    const popup = await openPopup(extensionContext, extensionId, tabId);

    const many = popup.locator('.row', { hasText: 'Many' });
    await expect(many.locator('button.disclose')).toHaveText('▸ 5 commands');
    await expect(many.locator('button.command')).toHaveCount(0);
    await many.locator('button.disclose').click();
    await expect(many.locator('button.command')).toHaveText(['M1', 'M2', 'M3', 'M4', 'M5']);

    await popup.locator('.row', { hasText: 'Cmds' }).locator('button.command', { hasText: 'Paint' }).click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.painted ?? null)).toBe('yes');
    await popup.close();
    await page.close();
  });

  test('"Reload page" reloads with every script, keeping the popup open', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Alpha | OK'), 'Alpha ran');
    await page.evaluate(() => { document.documentElement.dataset.alpha = 'stale'; });
    const popup = await openPopup(extensionContext, extensionId, tabId);
    await popup.locator('#page-menu').click();
    const items = popup.getByRole('menuitem');
    await expect(items.first()).toHaveText('Reload page');
    await items.first().click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.alpha).catch(() => null)).toBe('ran');
    expect(popup.isClosed()).toBe(false);
    await popup.close();
    await page.close();
  });

  test('a collection name opens the collections page before the popup closes', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const { b } = await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    // A real popup's close ends the page at once, along with anything it
    // still had in flight. `close=1` has this tab close as a popup
    // would, and navigating away stands in for the close itself.
    const popup = await extensionContext.newPage();
    await popup.addInitScript(() => {
      window.close = () => { location.href = 'about:blank#closed'; };
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}&close=1`);
    await expect(popup.locator('body[data-ready="true"]')).toBeAttached();
    const collections = extensionContext.waitForEvent('page', (p) => p.url().includes('/collections.html'));
    await popup.locator(`.group-head[data-collection-id="${b}"] .collection-name`).click();
    expect(new URL((await collections).url()).hash).toBe(`#collection-${b}`);
    await expect(popup).toHaveURL('about:blank#closed');
    await popup.close();
    await page.close();
  });

  test('activity in other tabs leaves an open menu alone', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Alpha | OK'), 'Alpha ran');
    const popup = await openPopup(extensionContext, extensionId, tabId);
    await popup.locator('#page-menu').click();
    await expect(popup.locator('.menu')).toBeVisible();
    // Another tab loading a page writes its own state and its scripts'
    // Logs; none of that is this popup's.
    const other = await extensionContext.newPage();
    await other.goto(`${fixtureServer.baseUrl}/target.html`);
    await waitForTabState(sm, await activeTabId(getServiceWorker), (s) => s.rows.includes('Alpha | OK'), 'other tab ran');
    await popup.waitForTimeout(300);
    await expect(popup.locator('.menu')).toBeVisible();
    await other.close();
    await popup.close();
    await page.close();
  });

  test('a navigation to another URL lists that page afresh', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    const d = dir();
    d.write({ relativePath: 'here.user.js', meta: { name: 'Here', match: [`${fixtureServer.baseUrl}/target.html`] }, body: '' });
    d.write({ relativePath: 'there.user.js', meta: { name: 'There', match: [`${fixtureServer.baseUrl}/target.html?there`] }, body: '' });
    await sm.addCollection(d.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const popup = await openPopup(extensionContext, extensionId, tabId);
    await expect(popup.locator('.row .script-name')).toHaveText(['Here']);
    await page.goto(`${fixtureServer.baseUrl}/target.html?there`);
    // Here's row goes with its page, rather than lingering as a script
    // a reload would run.
    await expect(popup.locator('.row .script-name')).toHaveText(['There']);
    await expect(popup.locator('.banner-row.reload')).toHaveCount(0);
    await popup.close();
    await page.close();
  });

  test('says when no script can run on the page', async ({ extensionContext, sm, getServiceWorker, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto('about:blank');
    const tabId = await activeTabId(getServiceWorker);
    expect((await sm.getPopupView(tabId)).injectable).toBe(false);
    const popup = await openPopup(extensionContext, extensionId, tabId);
    await expect(popup.locator('.empty-page')).toHaveText('SourceMonkey can\'t run scripts on this page.');
    await popup.close();
    await page.close();
  });

  test('a single click on the icon opens the popup, and leaves none set', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    await closeCollectionsTabs(sw);
    await sm.clickAction(tabId, windowId);
    // Opens at once, as a real popup, without waiting out the
    // double-click time.
    await expect.poll(() => sw.evaluate(async () => (await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.POPUP],
      // The address can lag the context by a moment.
    })).map((c) => (c.documentUrl ? new URL(c.documentUrl).pathname : '')))).toEqual(['/popup.html']);
    // Cleared again, so the next click reaches the click handler rather
    // than Chrome opening the popup itself.
    await expect.poll(() => sw.evaluate((id) => chrome.action.getPopup({ tabId: id }), tabId)).toBe('');
    // Left open past the double-click time, it was a single click: no
    // collections page.
    await page.waitForTimeout(600);
    expect(await collectionsTabIds(sw)).toEqual([]);
    await page.close();
  });

  test('the icon\'s right-click menu has its items', async ({ getServiceWorker }) => {
    const sw = await getServiceWorker();
    // No API reads a menu back; updating an id that doesn't exist fails.
    const errors = await sw.evaluate(() => Promise.all([
      ['sm-open-collections', 'Open Collections page (double-click)'],
      ['sm-reload-no-scripts', 'Reload page with no userscripts'],
    ].map(([id, title]) => new Promise<string | null>((resolve) => {
      chrome.contextMenus.update(id!, { title }, () => resolve(chrome.runtime.lastError?.message ?? null));
    }))));
    expect(errors).toEqual([null, null]);
  });

  test('a double click on the icon opens the collections page, and takes the popup back', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    // The second click lands while the first's popup is still opening,
    // so it closes as soon as it connects.
    await sm.clickAction(tabId, windowId);
    await sm.clickAction(tabId, windowId);
    await expectCollectionsShown(getServiceWorker, windowId);
    await expect.poll(() => popupContexts(sw)).toBe(0);
    await page.close();
  });

  test('a second click once the popup shows closes it too', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    // Both clicks inside the worker, so the wait for the popup can't
    // outlast the double-click time on a slow run.
    const shown = await sw.evaluate(async ({ tabId, windowId }) => {
      const api = (self as unknown as { SourceMonkey: { clickAction(t: number, w: number): void } }).SourceMonkey;
      const start = Date.now();
      api.clickAction(tabId, windowId);
      while (Date.now() - start < 200) {
        const n = (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] })).length;
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      // Give the popup a moment to connect, still inside the wait.
      await new Promise((r) => setTimeout(r, 20));
      const n = (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] })).length;
      api.clickAction(tabId, windowId);
      return n;
    }, { tabId, windowId });
    test.skip(shown === 0, 'The popup took longer than the double-click time to open');
    await expectCollectionsShown(getServiceWorker, windowId);
    await expect.poll(() => popupContexts(sw)).toBe(0);
    await page.close();
  });

  test('a popup that closes within the double-click time counts as the second click', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    // Chrome takes a click on the icon while its popup shows: it closes
    // the popup and reports nothing. Closing the popup from outside, as
    // DevTools can, stands in for that. (Chrome dropping an open still
    // under way, the other sign, can't be brought about from here.)
    await sm.clickAction(tabId, windowId);
    await expect.poll(() => popupContexts(sw)).toBe(1);
    const cdp = await extensionContext.newCDPSession(page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const popup = targetInfos.find((t) => t.url.endsWith('/popup.html'));
    expect(popup).toBeDefined();
    await cdp.send('Target.closeTarget', { targetId: popup!.targetId });
    await expect.poll(() => popupContexts(sw)).toBe(0);
    await expectCollectionsShown(getServiceWorker, windowId);
    await page.close();
  });

  test('a click soon after an open popup closes counts as the second click', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    await closeCollectionsTabs(sw);
    await sm.clickAction(tabId, windowId);
    await expect.poll(() => popupContexts(sw)).toBe(1);
    // Left open past the double-click time, then a double click: Chrome
    // takes the first click, closing the popup (closed over CDP here, as
    // above), and reports the second.
    await page.waitForTimeout(600);
    const cdp = await extensionContext.newCDPSession(page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const popup = targetInfos.find((t) => t.url.endsWith('/popup.html'));
    await cdp.send('Target.closeTarget', { targetId: popup!.targetId });
    // Polled closely: the second click has to land within the
    // double-click time of the close.
    await expect.poll(() => popupContexts(sw), { intervals: [10] }).toBe(0);
    await sm.clickAction(tabId, windowId);
    await expectCollectionsShown(getServiceWorker, windowId);
    // Taken as the second click, it opens no popup.
    await page.waitForTimeout(300);
    expect(await popupContexts(sw)).toBe(0);
    await page.close();
  });

  test('closing the tab right after a click is no double click', async ({
    fixtureServer, sm, getServiceWorker, extensionContext,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    await closeCollectionsTabs(sw);
    await sm.clickAction(tabId, windowId);
    await expect.poll(() => popupContexts(sw)).toBe(1);
    // Ctrl+W: the popup closes with its tab.
    await page.close();
    await expect.poll(() => popupContexts(sw)).toBe(0);
    await sw.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    expect(await collectionsTabIds(sw)).toEqual([]);
  });

  test('a popup closing itself after an action is no double click', async ({
    fixtureServer, sm, getServiceWorker, extensionContext,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.bringToFront();
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const sw = await getServiceWorker();
    await closeCollectionsTabs(sw);
    await sm.clickAction(tabId, windowId);
    await expect.poll(() => popupContexts(sw)).toBe(1);
    // What a link or menu command does: say so, then close. A worker
    // request to close goes the same way.
    // Retried until the popup's port has connected.
    await expect.poll(() => sm.closePopup(tabId)).toBeGreaterThan(0);
    await expect.poll(() => popupContexts(sw)).toBe(0);
    await page.waitForTimeout(600);
    expect(await collectionsTabIds(sw)).toEqual([]);
    await page.close();
  });

  test('"Collection options" opens the collection\'s edit dialog', async ({
    extensionContext, fixtureServer, sm, extensionId,
  }) => {
    const { b } = await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html#edit-collection-${b}`);
    await expect(page.locator('dialog.sm-dialog[open]')).toBeVisible();
    // The URL is left on the plain anchor, so a reload doesn't reopen it.
    expect(new URL(page.url()).hash).toBe(`#collection-${b}`);
    await page.close();
  });
});

async function collectionName(popup: Page, index: number, section: 'enabled' | 'disabled' = 'enabled'): Promise<string> {
  return (await popup.locator(`section[data-section="${section}"] .group-head .collection-name`).nth(index).textContent()) ?? '';
}
