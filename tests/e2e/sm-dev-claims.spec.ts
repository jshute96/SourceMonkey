// sm-dev's tab claims (src/extension/sm-dev-link.ts): a tab an sm-dev run controls
// runs only the run's own scripts, if any, across reloads, in
// the tabs it opens, and until the claim is released or its lease runs
// out. Drives the SW's `claimTab` / `renewRun` / `releaseRun` surface,
// as sm-dev does. Design: docs/sm-dev-design.md.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir, renderUserscript } from '../fixtures/scripts-dir';
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    // Run R1's own, in its test collection.
    const allowed = await sm.writeRunScript({
      run: 'R1',
      name: 'allowed.user.js',
      text: renderUserscript({
        relativePath: 'allowed.user.js',
        meta: { name: 'Allowed', match: [`${baseUrl}/*`] },
        body: `document.documentElement.dataset.allowed = 'ran';`,
      }),
    });
    return {
      kept: (await allScripts(sm)).find((s) => s.relativePath === 'kept.user.js')!.id,
      allowed: allowed.scriptId,
    };
  }

  const ran = (page: import('@playwright/test').Page, which: string): Promise<string | null> =>
    page.evaluate((w) => document.documentElement.dataset[w] ?? null, which);

  test('a claimed tab runs only the run\'s own scripts, quietly, across reloads', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const { kept } = await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', 60_000);

    for (const load of [() => page.reload(), () => page.goto(`${fixtureServer.baseUrl}/other.html`)]) {
      await load();
      await expect.poll(() => ran(page, 'allowed')).toBe('ran');
      expect(await ran(page, 'kept')).toBeNull();
    }
    // The badge shows the kept-out script as not loaded, not missing.
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Kept | NOT_LOADED') && s.rows.includes('Allowed | OK'), 'Kept not loaded');
    // And nothing lands in its Log for it: the person asked nothing of it.
    expect((await sm.getScriptLog(kept)).filter((e) => e.message.includes('Did not run'))).toEqual([]);

    // Released, the tab runs the extension's scripts again on its next
    // load, and the run's own are gone with its test collection.
    await sm.releaseRun('R1');
    await page.reload();
    await expect.poll(() => ran(page, 'kept')).toBe('ran');
    expect(await ran(page, 'allowed')).toBeNull();
  });

  test('a tab a claimed tab opens is claimed too', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', 60_000);
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
    await sm.claimTab(tabId, 'R1', 300);
    await new Promise((r) => setTimeout(r, 500));
    await page.reload();
    await expect.poll(() => ran(page, 'kept')).toBe('ran');
  });

  test('a tab where only some scripts were kept out stays green', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', 60_000);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Kept | NOT_LOADED') && hasBadgeColor(s, GREEN), 'green with Kept not loaded');
    // Counted: only the script the claim let run. And the popup and
    // tooltip say whose tab it is.
    expect((await sm.getTabState(tabId)).badgeText).toBe('1');
    expect((await sm.getPopupView(tabId)).smDev).toBe(true);
    // Which scripts run there is the run's choice, not the popup's.
    expect((await sm.getPopupView(tabId)).perScriptReload).toBe(false);
    expect((await sm.getTabState(tabId)).title).toContain('SourceMonkey\nPage under sm-dev control');
    // Released and reloaded, it's an ordinary tab again, and the run's
    // script is gone with its test collection.
    await sm.releaseRun('R1');
    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Kept | OK') && s.badgeText === '1', 'Kept counted');
    expect((await sm.getPopupView(tabId)).smDev).toBe(false);
    expect((await sm.getPopupView(tabId)).perScriptReload).toBe(true);
    expect((await sm.getTabState(tabId)).title).not.toContain('sm-dev');
  });

  test('a claimed tab with its scripts off runs none, its own included, and calls none missing', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', 60_000);
    await sm.setTabScriptsOff(tabId, true);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Allowed | NOT_LOADED') && hasBadgeColor(s, GREY), 'all not loaded');
    expect(await ran(page, 'allowed')).toBeNull();
  });

  test('a renewal claims a lost tab again, if it is still open', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    // As if the extension reloaded, losing the claim.
    await sm.claimTab(tabId, 'R1', 60_000);
    await sm.releaseRun('R1');
    expect(await sm.renewRun('R1', 60_000, [{ tabId }, { tabId: 999_999 }])).toBe(1);
    await page.reload();
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREY), 'grey again');
    expect(await ran(page, 'kept')).toBeNull();
  });

  test('a tab GM_openInTab opens from a claimed tab is claimed before it loads', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Run R1's own.
    await sm.writeRunScript({
      run: 'R1',
      name: 'opener.user.js',
      text: renderUserscript({
        relativePath: 'opener.user.js',
        meta: { name: 'Opener', match: [`${fixtureServer.baseUrl}/target.html`], grant: ['GM_openInTab'] },
        body: `GM_openInTab(location.href.replace('target.html', 'other.html'));`,
      }),
    });
    scriptsDir.write({
      relativePath: 'kept.user.js',
      meta: { name: 'Kept', match: [`${fixtureServer.baseUrl}/other.html`], runAt: 'document-start' },
      body: `document.documentElement.dataset.kept = 'ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/blank.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.claimTab(tabId, 'R1', 60_000);
    const [opened] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.goto(`${fixtureServer.baseUrl}/target.html`),
    ]);
    await expect.poll(() => opened.url()).toContain('/other.html');
    await opened.waitForLoadState('load');
    expect(await ran(opened, 'kept')).toBeNull();
  });

  test('a run\'s script runs only in its own run\'s tabs', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    await sm.writeRunScript({
      run: 'R1',
      name: 'mine.user.js',
      text: renderUserscript({
        relativePath: 'mine.user.js',
        meta: { name: 'Mine', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start' },
        body: `document.documentElement.dataset.mine = 'ran';`,
      }),
    });
    await sm.syncNow();
    const page = await extensionContext.newPage();
    // Unclaimed: one of the person's own tabs. Not run, and not listed.
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await page.waitForTimeout(300);
    expect(await ran(page, 'mine')).toBeNull();
    expect((await sm.getTabState(tabId)).rows.join('\n')).not.toContain('Mine');
    // Another run's tab: not run either.
    await sm.claimTab(tabId, 'R2', 60_000);
    await page.reload();
    await page.waitForTimeout(300);
    expect(await ran(page, 'mine')).toBeNull();
    await sm.releaseRun('R2');
    // The run that pushed it: run, and listed.
    await sm.claimTab(tabId, 'R1', 60_000);
    await page.reload();
    await expect.poll(() => ran(page, 'mine')).toBe('ran');
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Mine | OK'), 'Mine OK');
    // Its claim gone (the run still holding its test collection), nowhere again.
    await sm.renewRun('R1', 0);
    await page.waitForTimeout(10);
    await page.reload();
    await page.waitForTimeout(300);
    expect(await ran(page, 'mine')).toBeNull();
  });

  test('the toolbar icon is marked while the tab\'s document loaded under a claim', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    await twoScripts(sm, fixtureServer.baseUrl);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    expect(await sm.isSmDevMarked(tabId)).toBe(false);
    await sm.claimTab(tabId, 'R1', 60_000);
    await page.reload();
    await expect.poll(() => sm.isSmDevMarked(tabId)).toBe(true);
    await sm.releaseRun('R1');
    await page.reload();
    await expect.poll(() => sm.isSmDevMarked(tabId)).toBe(false);
  });

  test('a report relayed by the page bridge for a script SourceMonkey doesn\'t have is ignored', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // A page-world script, so SourceMonkey's bridge is on the page.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: [`${fixtureServer.baseUrl}/*`], grant: ['none'] },
      body: `document.documentElement.dataset.main = 'ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Main | OK'), 'Main OK');
    // As the page could, forging a report for a script it made up.
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('sourcemonkey-bridge-sync', {
        detail: JSON.stringify({ payload: { type: 'sm:start', id: 'harness-stranger', name: 'Stranger' } }),
      }));
    });
    await page.waitForTimeout(300);
    expect((await sm.getTabState(tabId)).rows.join('\n')).not.toContain('Stranger');
  });
});
