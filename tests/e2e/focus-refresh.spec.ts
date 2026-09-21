// Focus-triggered refresh: bringing a tab to the front checks the
// local scripts running on it for edits, so the RELOAD badge is up —
// and the new body already registered — before the user reloads.
//
// The point of the feature is what the last assertion covers: the
// reload that follows runs the new body without racing anything and
// without a second reload. See docs/updates.md#focus-triggered-refresh.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const PURPLE = '#d500f9';

test.describe('focus-triggered refresh', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('switching back to a tab picks up a local edit and asks for a reload', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: { name: 'Live', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN), 'initial green');

    // Spend the page's own focus-signal budget, so what follows can
    // only be delivered by `tabs.onActivated`.
    //
    // `bringToFront` raises BOTH signals — Chrome's activation event
    // and a real `focus` in the page — so without this the test would
    // pass with the chrome-event listener deleted outright. The
    // prelude's 5s per-document floor is production behavior, and
    // everything below runs well inside it.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    // Switch away, edit the file the way an editor would, then switch
    // back. Nothing else touches the extension in between — no
    // navigation, no Refresh click.
    const other = await extensionContext.newPage();
    await other.goto(`${fixtureServer.baseUrl}/blank.html`);
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2';`);
    // The navigation above already ran an opportunistic check, and this
    // test switches back inside `UPDATE_MIN_INTERVAL_MS`. A real user
    // is away far longer; clearing the gate is how the test models that
    // without sitting out ten seconds.
    await sm.clearUpdateRateLimit();
    await page.bringToFront();

    // Wait on colour AND title together: renderBadge awaits
    // setBadgeBackgroundColor before setTitle, so a state sampled
    // between the two carries the new colour with the old title.
    await waitForTabState(
      sm,
      tabId,
      (s) => hasBadgeColor(s, PURPLE) && s.title.includes('Live | Reload to update'),
      'purple + RELOAD title after the tab regained focus',
    );

    // The whole point: no syncNow here. The focus check already wrote
    // the row and the debounced registration sync has had the time the
    // badge round-trip took, so one plain reload runs the new body.
    await page.reload();
    await expect(page).toHaveTitle('v2');
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN), 'green after reload');
    await other.close();
    await page.close();
  });

  test('a page reporting focus picks up a local edit while it is not the active tab', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The page-side half of the trigger (`sm:focus` from the prelude).
    // It exists because Chrome stays silent when the browser regains
    // focus from another application, so this test deliberately drives
    // it with the target tab in the BACKGROUND — no `tabs.onActivated`,
    // no `windows.onFocusChanged`, nothing but the page's own report.
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: { name: 'Live', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN), 'initial green');

    const other = await extensionContext.newPage();
    await other.goto(`${fixtureServer.baseUrl}/blank.html`);
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2';`);
    await sm.clearUpdateRateLimit();
    // A real OS focus can't be delivered to a headless background tab,
    // so raise the event the prelude listens for directly. Everything
    // after this point — the throttle, the message, the SW handler —
    // is production code.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await waitForTabState(
      sm,
      tabId,
      (s) => hasBadgeColor(s, PURPLE) && s.title.includes('Live | Reload to update'),
      'purple + RELOAD title after the page reported focus',
    );
    await other.close();
    await page.close();
  });

  test('an http script on the tab is not re-fetched on focus', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Local scripts are cheap to re-read; an http(s) one would mean a
    // conditional GET to a third party on every alt-tab. Only the local
    // row is checked, so the served route sees exactly the one fetch
    // that installed it.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/remote.user.js', [
        '// ==UserScript==',
        '// @name        Remote',
        `// @match       ${fixtureServer.baseUrl}/*`,
        '// @run-at      document-end',
        '// ==/UserScript==',
        `console.log('remote');`,
        '',
      ].join('\n'));
      const remote = await sm.addCollection(`${server.baseUrl}/remote.user.js`);
      scriptsDir.write({
        relativePath: 'local.user.js',
        meta: { name: 'Local', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
        body: `document.title = 'v1';`,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page).toHaveTitle('v1');
      const tabId = await activeTabId(getServiceWorker);
      await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN), 'initial green');

      // Barrier before sampling. The navigation above fired an
      // opportunistic check for EVERY matching script, the remote one
      // included, and nothing about a green badge says that check has
      // finished — so a count taken here could miss a fetch still in
      // flight and the assertion below would fail for the wrong
      // reason. This awaits it: `gate` coalesces onto the in-flight
      // check when there is one, and is a no-op when there isn't.
      await sm.updateCollection(remote!.id, 'opportunistic');
      const fetchesBeforeFocus = server.requestLog.filter(
        (e) => e.path === '/remote.user.js',
      ).length;

      const other = await extensionContext.newPage();
      await other.goto(`${fixtureServer.baseUrl}/blank.html`);
      // Edit the local script too, so the focus check has real work to
      // do and the assertion below isn't just "nothing happened".
      scriptsDir.rewriteBody('local.user.js', `document.title = 'v2';`);
      // See the first test: models a user who was away longer than the
      // update interval.
      await sm.clearUpdateRateLimit();
      await page.bringToFront();
      await waitForTabState(
        sm,
        tabId,
        (s) => hasBadgeColor(s, PURPLE),
        'purple after the local edit was picked up',
      );

      expect(
        server.requestLog.filter((e) => e.path === '/remote.user.js').length,
      ).toBe(fetchesBeforeFocus);
      await other.close();
      await page.close();
    } finally {
      await server.stop();
    }
  });
});
