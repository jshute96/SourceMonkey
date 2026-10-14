// E2E coverage for `GM_getTab` / `GM_saveTab` / `GM_getTabs`: a
// per-tab object that outlives the page's navigations, is listed across
// tabs, and goes with its tab. Run in both worlds, since the page's
// world reaches the service worker through the bridge.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Counts the loads in this tab, then reports the count and every tab's
// count. The callback forms for the first two, the GM. Promise form
// for the list, so both shapes are covered.
const BODY = `
  GM_getTab(function (tab) {
    tab.loads = (tab.loads || 0) + 1;
    GM_saveTab(tab, function () {
      GM.getTabs().then(function (tabs) {
        const counts = Object.keys(tabs).map(function (id) { return tabs[id].loads || 0; }).sort();
        document.body.dataset.loads = String(tab.loads);
        document.body.dataset.tabs = counts.join(',');
        document.body.dataset.tabCount = String(counts.length);
      });
    });
  });
`;

for (const world of ['page', 'content'] as const) {
  test.describe(`GM_getTab (${world} world)`, () => {
    let scriptsDir: ScriptsDir;

    test.beforeEach(() => {
      scriptsDir = ScriptsDir.create();
    });
    test.afterEach(() => {
      scriptsDir.cleanup();
    });

    test('keeps a per-tab object across loads, lists tabs, and drops a closed one', async ({
      extensionContext, fixtureServer, sm,
    }) => {
      scriptsDir.write({
        relativePath: 'tab-counter.user.js',
        meta: {
          name: 'Tab Counter',
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          injectInto: world,
          grant: ['GM_getTab', 'GM_saveTab', 'GM.getTabs'],
        },
        body: BODY,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const first = await extensionContext.newPage();
      await first.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(first.locator('body')).toHaveAttribute('data-loads', '1');
      await first.goto(`${fixtureServer.baseUrl}/other.html`);
      await expect(first.locator('body')).toHaveAttribute('data-loads', '2');
      await expect(first.locator('body')).toHaveAttribute('data-tabs', '2');

      // A second tab starts from {} and sees both.
      const second = await extensionContext.newPage();
      await second.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(second.locator('body')).toHaveAttribute('data-loads', '1');
      await expect(second.locator('body')).toHaveAttribute('data-tabs', '1,2');

      // The first tab's object goes with it. Polled on the tab count,
      // since each reload also adds to this tab's own load count.
      await first.close();
      await expect.poll(async () => {
        await second.reload();
        await expect(second.locator('body')).toHaveAttribute('data-tab-count', /\d/);
        return second.locator('body').getAttribute('data-tab-count');
      }, { timeout: 10_000 }).toBe('1');

      await second.close();
    });
  });
}
