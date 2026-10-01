// sm-dev's tab claims (src/sm-dev-link.ts): a tab an sm-dev run controls
// runs only the extension scripts its claim allows, across reloads, in
// the tabs it opens, and until the claim is released or its lease runs
// out. Drives the SW's `claimTab` / `renewRun` / `releaseRun` surface,
// as sm-dev does. Design: docs/sm-dev-extension.md.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId, allScripts, hasBadgeColor, waitForTabState, type SmApi } from '../fixtures/sw-api';

const GREY = '#757575';

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
});
