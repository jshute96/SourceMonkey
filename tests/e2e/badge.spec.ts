// End-to-end badge state: matching → green, error → red, post-update
// stale, disabled since load or loaded before the extension started →
// purple, collection disabled → empty, and warnings in the tooltip and
// popup rows. Exercises the real
// chrome.action surface, the chrome.webNavigation listener, and the
// sm:start / sm:error pipeline from injected wrappers back to the SW.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const ORANGE = '#f57c00';
const RED = '#d32f2f';
const PURPLE = '#d500f9';

test.describe('badge', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('green + count=1 for one matching script', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'hello';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    // The rows are part of the wait, not just the assertion — as they
    // are in every other rows check in this file. `getTabState` reads the
    // badge text, color, title and rows separately, so a repaint landing
    // between them returns a snapshot that mixes two states: green
    // (settled) beside `MISSING` (the moment before). That pairing is
    // impossible in the product — MISSING forces amber — so waiting on
    // only the badge and asserting on the rows is a race against the
    // read, not against the state.
    const snap = await waitForTabState(
      sm,
      tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN) && s.rows.includes('Hello | OK')
        && s.title === 'SourceMonkey\n1 script running.\nClick for details. Double-click for collections.',
      'badge green=1 + OK row + tooltip',
    );
    expect(snap.badgeText).toBe('1');
    expect(snap.rows).toContain('Hello | OK');
    await page.close();
  });

  test('red for a script that throws on activation', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'boom.user.js',
      meta: { name: 'Boom', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `throw new Error('intentional test failure');`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    // Wait on the rows as well as the colour: they are read from
    // the same record but the colour can land first, and asserting on
    // rows the wait never checked is a race (see the PURPLE case below,
    // which already does this).
    const snap = await waitForTabState(
      sm,
      tabId,
      (s) => hasBadgeColor(s, RED) && s.rows.includes('Boom | ERROR'),
      'badge red + ERROR tooltip',
    );
    expect(snap.rows).toContain('Boom | ERROR');
    await page.close();
  });

  test('purple/RELOAD after script body changes on disk', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: { name: 'Live', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'v1';`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial green');

    // Simulate an external edit: rewrite the file body, then trigger a
    // manual refresh through the updater. The SW's storage.onChanged
    // listener should fire markScriptStale for this tab.
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2';`);
    await sm.updateCollection(added!.id, 'manual');

    // Wait on the colour AND the title together. `renderBadge` awaits
    // `setBadgeBackgroundColor` before `setTitle`, so a state sampled
    // between the two carries the new colour with the old title —
    // waiting on colour alone and then asserting the title is a race.
    const snap = await waitForTabState(
      sm,
      tabId,
      (s) => hasBadgeColor(s, PURPLE) && s.rows.includes('Live | RELOAD'),
      'purple + RELOAD title after update',
    );
    expect(snap.rows).toContain('Live | RELOAD');

    // Reload the page → new wrapper runs the fresh body → back to green.
    // syncNow before reload so chrome.userScripts is registered with
    // the v2 body before navigation; otherwise the debounced sync that
    // updateCollection scheduled may not have run yet, and the reload would
    // re-inject v1.
    await sm.syncNow();
    await page.reload();
    await expect(page).toHaveTitle('v2');
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN), 'green after reload');
    await page.close();
  });

  test('empty badge when collection is disabled', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: ``,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.setCollectionEnabled(added!.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    // Badge stays empty since no scripts match.
    const snap = await waitForTabState(sm, tabId, (s) => s.badgeText === '', 'empty badge');
    expect(snap.badgeText).toBe('');
    await page.close();
  });

  test('orange/MISSING when matcher expects a script the wrapper never reported', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // A MAIN-world script with no @grant runs in MAIN world; it cannot
    // call chrome.runtime.sendMessage so the bridge forwards via
    // postMessage. To produce a genuine MISSING (expected ∪ ¬actual)
    // without going through the bridge, register a USER_SCRIPT-world
    // script that bails before sending sm:start. The wrapper's sm:start
    // is sent synchronously at activation, so we instead arrange for
    // the script to be EXPECTED but never injected: register a real
    // script, then unregister it from chrome.userScripts directly while
    // leaving the storage row in place. The match index still sees it.
    scriptsDir.write({
      relativePath: 'ghost.user.js',
      meta: { name: 'Ghost', match: [`${fixtureServer.baseUrl}/*`], grant: ['unsafeWindow'], runAt: 'document-end' },
      body: ``,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    // Drop the script from chrome.userScripts so it's expected but
    // never actually runs.
    const sw = await getServiceWorker();
    await sw.evaluate(async () => {
      const all = await chrome.userScripts.getScripts();
      const ids = all.filter((s) => s.id !== 'sourcemonkey-bridge').map((s) => s.id);
      if (ids.length > 0) await chrome.userScripts.unregister({ ids });
    });

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const snap = await waitForTabState(
      sm,
      tabId,
      (s) => hasBadgeColor(s, ORANGE) && s.rows.includes('Ghost | MISSING'),
      'orange + MISSING tooltip',
    );
    expect(snap.rows).toContain('Ghost | MISSING');
    await page.close();
  });

  test('a script disabled since the page loaded turns the badge purple and says a reload is needed', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    for (const name of ['One', 'Two']) {
      scriptsDir.write({
        relativePath: `${name.toLowerCase()}.user.js`,
        meta: { name, match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
        body: `void 0;`,
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN) && s.title.includes('\n2 scripts running.\n'), 'both ran');

    const two = (await sm.getCollectionWithScripts(collection!.id))!.scripts.find((x) => x.relativePath === 'two.user.js')!;
    await sm.setScriptEnabled(two.id, false);
    await sm.syncNow();
    const snap = await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, PURPLE) && s.rows.includes('Two | STILL_RUNNING'),
      'purple with Two still running',
    );
    expect(snap.title.split('\n').slice(1, -1)).toEqual(['2 scripts running.', 'Reload needed to remove 1 script.']);
    await page.close();
  });

  test('a header warning shows as Warning and a tooltip line, and leaves the badge green', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'warned.user.js',
      meta: { name: 'Warned', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant: ['GM_notARealApi'] },
      body: `void 0;`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const snap = await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, GREEN) && s.rows.includes('Warned | WARNING')
        && s.title.includes('\n1 script has warnings.\n'),
      'green with a Warning row and tooltip line',
    );
    expect(snap.title.split('\n').slice(1, -1)).toEqual(['1 script running.', '1 script has warnings.']);
    await page.close();
  });

  test('a warning a script logs from the tab marks it Warning there', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // A refused download is logged as a warning with this tab's id.
    scriptsDir.write({
      relativePath: 'fetcher.user.js',
      meta: { name: 'Fetcher', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant: ['GM_download'] },
      body: `GM_download({ url: 'file:///etc/passwd', name: 'x.txt' });`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const snap = await waitForTabState(
      sm, tabId,
      // The tooltip is part of the wait: the rows are read live, and a
      // warning changes no color, so only the title shows the repaint.
      (s) => hasBadgeColor(s, GREEN) && s.rows.includes('Fetcher | WARNING')
        && s.title.includes('\n1 script has warnings.\n'),
      'green with a Warning row and tooltip line',
    );
    expect(snap.title).toContain('\n1 script has warnings.\n');
    await page.close();
  });

  test('a page open before the extension started turns purple and asks for a reload', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'early.user.js',
      meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `void 0;`,
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN), 'green before');

    await sm.simulateExtensionStart();
    const snap = await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, PURPLE) && s.rows.includes('Early | UNTRACKED'),
      'purple with Early untracked',
    );
    expect(snap.badgeText).toBe('1');
    expect(snap.title.split('\n').slice(1, -1)).toEqual([
      'Page loaded before SourceMonkey started. Reload needed for 1 script.',
    ]);

    // A script added since is Reload to run, and the refresh that
    // shows it keeps the rest unknown.
    scriptsDir.write({
      relativePath: 'late.user.js',
      meta: { name: 'Late', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `void 0;`,
    });
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();
    await waitForTabState(
      sm, tabId,
      (s) => s.rows.includes('Late | PENDING') && s.rows.includes('Early | UNTRACKED') && s.badgeText === '2',
      'Late to run, Early still unknown',
    );

    await page.reload();
    await waitForTabState(sm, tabId, (s) => hasBadgeColor(s, GREEN) && s.rows.includes('Early | OK'), 'green after reload');
    await page.close();
  });

  test('a page open before the extension started with nothing matching yet gets a badge once a script is added', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.simulateExtensionStart();

    scriptsDir.write({
      relativePath: 'added.user.js',
      meta: { name: 'Added', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `void 0;`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, PURPLE) && s.rows.includes('Added | PENDING'),
      'purple with Added to run',
    );
    await page.close();
  });
});
