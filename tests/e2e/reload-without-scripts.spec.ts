// "Reload page with no userscripts" — the action menu's closing row.
// One reload during which every wrapper on the tab is told to skip;
// the registrations stay put and the next ordinary reload runs them
// again. Drives the SW's `reloadWithoutScripts` test surface in place
// of the real chrome.contextMenus click, which Playwright can't make.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts, waitFor, waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const GREY = '#757575';

test.describe('reload with no userscripts', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('skips every script once, then a plain reload runs them again', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // One script per gate that matters: document-start has no
    // lifecycle wait to hide behind, so the skip decision is its only
    // gate; document-end is the ordinary case.
    scriptsDir.write({
      relativePath: 'early.user.js',
      meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start' },
      body: `document.documentElement.dataset.early = 'ran';`,
    });
    scriptsDir.write({
      relativePath: 'late.user.js',
      meta: { name: 'Late', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'late ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('late ran');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '2' && hasBadgeColor(s, GREEN),
      'green before the skip reload',
    );
    // The row is offered because the tab has script rows.
    expect((await sm.getActionContextMenuPlan(tabId)).reloadWithoutScripts).toBe(true);

    await sm.reloadWithoutScripts(tabId);

    // Neither body ran on the reloaded document…
    await expect(page).toHaveTitle('target');
    expect(await page.evaluate(() => document.documentElement.dataset.early ?? null)).toBeNull();
    // …and the badge says so in grey, with the count intact, rather
    // than painting the scripts as MISSING.
    const snap = await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, GREY)
        && s.title.includes('Early | NOT LOADED') && s.title.includes('Late | NOT LOADED'),
      'grey + NOT LOADED after the skip reload',
    );
    expect(snap.badgeText).toBe('2');

    // The skip is recorded on each script's Log as information, not a
    // warning — the user asked for it.
    const late = (await allScripts(sm)).find((s) => s.relativePath === 'late.user.js')!;
    const entry = await waitFor(
      async () => (await sm.getScriptLog(late.id)).find((e) => e.message.includes('Did not run')),
      (e) => e != null,
      { label: 'abandoned Log entry' },
    );
    expect(entry!.level).toBe('info');
    expect(entry!.message).toBe('Did not run on this page (reload with no userscripts)');

    // One-shot: the next ordinary reload runs both scripts again.
    await page.reload();
    await expect(page).toHaveTitle('late ran');
    expect(await page.evaluate(() => document.documentElement.dataset.early)).toBe('ran');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '2' && hasBadgeColor(s, GREEN) && s.title.includes('Late | OK'),
      'green again after a plain reload',
    );
    await page.close();
  });

  test('the row is absent on a page with no script rows', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'elsewhere.user.js',
      meta: { name: 'Elsewhere', match: ['https://example.invalid/*'], runAt: 'document-end' },
      body: ``,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const plan = await sm.getActionContextMenuPlan(tabId);
    expect(plan.top).toEqual([]);
    expect(plan.reloadWithoutScripts).toBe(false);
    await page.close();
  });
});
