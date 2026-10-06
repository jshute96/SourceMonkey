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
    await waitForTabState(sm, tabId, (s) => s.title.includes('Gamma | OK'), 'scripts ran');

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

  test('toggles word the reload banner and the pills', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    await twoCollections(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.title.includes('Alpha | OK'), 'Alpha ran');
    const popup = await openPopup(extensionContext, extensionId, tabId);

    const order = () => popup.locator('.row .script-name').allTextContents();
    const before = await order();
    // Disable Alpha: it stays where it is (the layout holds while the
    // popup is open), greyed, still running until a reload.
    await popup.locator('.row', { hasText: 'Alpha' }).locator('input[type="checkbox"]').uncheck();
    await expect(popup.locator('section[data-section="enabled"] .row', { hasText: 'Alpha' }).locator('.pill')).toHaveText('Still running');
    await expect(popup.locator('.row', { hasText: 'Alpha' })).toHaveClass(/\boff\b/);
    await expect(popup.locator('.banner-row.reload')).toContainText('Reload required: Scripts disabled');

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
    await expect(popup.locator('section[data-section="disabled"] .row', { hasText: 'Gamma' }).locator('.pill')).toHaveText('Reload to run');
    await expect(head.locator('.collection-off')).toHaveCount(0);
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
    await waitForTabState(sm, tabId, (s) => s.title.includes('Alpha | OK'), 'Alpha ran');
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
    await waitForTabState(sm, tabId, (s) => s.title.includes('Alpha | OK'), 'Alpha ran');
    const popup = await openPopup(extensionContext, extensionId, tabId);
    await popup.locator('#page-menu').click();
    await expect(popup.locator('.menu')).toBeVisible();
    // Another tab loading a page writes its own state and its scripts'
    // Logs; none of that is this popup's.
    const other = await extensionContext.newPage();
    await other.goto(`${fixtureServer.baseUrl}/target.html`);
    await waitForTabState(sm, await activeTabId(getServiceWorker), (s) => s.title.includes('Alpha | OK'), 'other tab ran');
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
    await sm.clickAction(tabId, windowId);
    const sw = await getServiceWorker();
    // Opens after the double-click wait, as a real popup.
    await expect.poll(() => sw.evaluate(async () => (await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.POPUP],
    })).map((c) => new URL(c.documentUrl ?? '').pathname))).toEqual(['/popup.html']);
    // Cleared again, so the next click reaches the click handler rather
    // than Chrome opening the popup itself.
    await expect.poll(() => sw.evaluate((id) => chrome.action.getPopup({ tabId: id }), tabId)).toBe('');
    await page.close();
  });

  test('the icon\'s right-click menu has the one item, naming the double click', async ({ getServiceWorker }) => {
    const sw = await getServiceWorker();
    // No API reads a menu back; updating an id that doesn't exist fails.
    const error = await sw.evaluate(() => new Promise<string | null>((resolve) => {
      chrome.contextMenus.update('sm-open-collections', { title: 'Open Collections page (double-click)' }, () => {
        resolve(chrome.runtime.lastError?.message ?? null);
      });
    }));
    expect(error).toBeNull();
  });

  test('a double click on the icon opens the collections page', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const windowId = await windowOf(getServiceWorker, tabId);
    const opened = extensionContext.waitForEvent('page', (p) => p.url().includes('/collections.html'));
    await sm.clickAction(tabId, windowId);
    await sm.clickAction(tabId, windowId);
    await opened;
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
