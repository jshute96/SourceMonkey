// sm-dev's tab claims (src/sm-dev-link.ts): a tab an sm-dev run controls
// runs only the extension scripts its claim allows, across reloads, in
// the tabs it opens, and until the claim is released or its lease runs
// out. Drives the SW's `claimTab` / `renewRun` / `releaseRun` surface,
// as sm-dev does. Design: docs/sm-dev-extension.md.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId, allScripts, hasBadgeColor, waitForTabState, type SmApi } from '../fixtures/sw-api';

const GREY = '#757575';
const GREEN = '#2e7d32';

test.describe('sm-dev tab claims', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  async function twoScripts(sm: SmApi, baseUrl: string): Promise<{ kept: string; allowed: string }> {
    scriptsDir.write({
      relativePath: 'kept.user.js',
      meta: { name: 'Kept', match: [`${baseUrl}/*`], runAt: 'document-start' },
      body: `document.documentElement.dataset.kept = 'ran';`,
    });
    scriptsDir.write({
      relativePath: 'allowed.user.js',
      meta: { name: 'Allowed', match: [`${baseUrl}/*`] },
      body: `document.documentElement.dataset.allowed = 'ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    return {
      kept: scripts.find((s) => s.relativePath === 'kept.user.js')!.id,
      allowed: scripts.find((s) => s.relativePath === 'allowed.user.js')!.id,
    };
  }

  const ran = (page: import('@playwright/test').Page, which: string): Promise<string | null> =>
    page.evaluate((w) => document.documentElement.dataset[w] ?? null, which);

  test('a claimed tab runs only the allowed scripts, quietly, across reloads', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const { kept, allowed } = await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', [allowed], 60_000);

    for (const load of [() => page.reload(), () => page.goto(`${fixtureServer.baseUrl}/other.html`)]) {
      await load();
      await expect.poll(() => ran(page, 'allowed')).toBe('ran');
      expect(await ran(page, 'kept')).toBeNull();
    }
    // The badge shows the kept-out script as not loaded, not missing.
    await waitForTabState(sm, tabId, (s) => s.title.includes('Kept | NOT LOADED') && s.title.includes('Allowed | OK'), 'Kept not loaded');
    // And nothing lands in its Log for it: the person asked nothing of it.
    expect((await sm.getScriptLog(kept)).filter((e) => e.message.includes('Did not run'))).toEqual([]);

    // Released, the tab runs everything again on its next load.
    await sm.releaseRun('R1');
    await page.reload();
    await expect.poll(() => ran(page, 'kept')).toBe('ran');
  });

  test('a claim with nothing allowed keeps every script out, and greys the badge', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', null, 60_000);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREY), 'grey badge');
    expect(await ran(page, 'kept')).toBeNull();
    expect(await ran(page, 'allowed')).toBeNull();
  });

  test('a tab a claimed tab opens is claimed too', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const { allowed } = await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', [allowed], 60_000);
    const [popup] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.evaluate((url) => { window.open(url); }, `${fixtureServer.baseUrl}/other.html`),
    ]);
    await expect.poll(() => ran(popup, 'allowed')).toBe('ran');
    expect(await ran(popup, 'kept')).toBeNull();
  });

  test('an expired lease lets every script run again', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', null, 300);
    await new Promise((r) => setTimeout(r, 500));
    await page.reload();
    await expect.poll(() => ran(page, 'kept')).toBe('ran');
  });

  test('a tab where only some scripts were kept out stays green', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const { allowed } = await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', [allowed], 60_000);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.title.includes('Kept | NOT LOADED') && hasBadgeColor(s, GREEN), 'green with Kept not loaded');
    // Counted: only the script the claim let run. And the menu says
    // whose tab it is.
    expect((await sm.getTabState(tabId)).badgeText).toBe('1');
    expect((await sm.getActionContextMenuPlan(tabId)).smDevControl).toBe(true);
    // Released and reloaded, it's an ordinary tab again.
    await sm.releaseRun('R1');
    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.badgeText === '2', 'both counted');
    expect((await sm.getActionContextMenuPlan(tabId)).smDevControl).toBe(false);
  });

  test('a claimed tab with its scripts off runs none, its own included, and calls none missing', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const { allowed } = await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', [allowed], 60_000);
    await sm.setTabScriptsOff(tabId, true);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.title.includes('Allowed | NOT LOADED') && hasBadgeColor(s, GREY), 'all not loaded');
    expect(await ran(page, 'allowed')).toBeNull();
  });

  test('a renewal claims a lost tab again, if it is still open', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    // As if the extension reloaded, losing the claim.
    await sm.claimTab(tabId, 'R1', null, 60_000);
    await sm.releaseRun('R1');
    expect(await sm.renewRun('R1', 60_000, null, [{ tabId }, { tabId: 999_999 }])).toBe(1);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREY), 'grey again');
    expect(await ran(page, 'kept')).toBeNull();
  });

  test('a tab GM_openInTab opens from a claimed tab is claimed before it loads', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'opener.user.js',
      meta: { name: 'Opener', match: [`${fixtureServer.baseUrl}/target.html`], grant: ['GM_openInTab'] },
      body: `GM_openInTab(location.href.replace('target.html', 'other.html'));`,
    });
    scriptsDir.write({
      relativePath: 'kept.user.js',
      meta: { name: 'Kept', match: [`${fixtureServer.baseUrl}/other.html`], runAt: 'document-start' },
      body: `document.documentElement.dataset.kept = 'ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const opener = (await allScripts(sm)).find((x) => x.relativePath === 'opener.user.js')!.id;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/blank.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', [opener], 60_000);
    const [opened] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.goto(`${fixtureServer.baseUrl}/target.html`),
    ]);
    await expect.poll(() => opened.url()).toContain('/other.html');
    await opened.waitForLoadState('load');
    expect(await ran(opened, 'kept')).toBeNull();
  });
});
