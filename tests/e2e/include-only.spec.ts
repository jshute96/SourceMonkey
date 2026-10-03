// A userscript whose header carries only `@include` — no `@match`.
// Chrome refuses a registration without `matches`, so
// `buildRegistrationSpec` registers `<all_urls>` and the wrapper's
// in-page matcher holds the script to its globs. Only Chrome can say
// whether that runs where the header says, so this is e2e.
//
// The second test is the measurement the first one rests on: Chrome's
// `chrome.userScripts` ORs `includeGlobs` with `matches` instead of
// filtering within them as the content-script docs describe.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const GREEN = '#2e7d32';

test.describe('glob-only @include', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('registers and injects, and stays inside the glob', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'include-only.user.js',
      meta: {
        name: 'Include Only',
        include: [`${fixtureServer.baseUrl}/target*`],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = 'injected by SourceMonkey';
      `,
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // Loaded clean and accepted by Chrome — the bug this covers left
    // the script sitting REJECTED with "must specify 'matches'".
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('ok');
    expect(await sm.getRejections()).toEqual({});

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');

    // The badge counts the same page the script ran on: the badge's
    // matcher and the wrapper's agree on where it runs.
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(
      sm,
      tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN),
      'badge green=1 on the included page',
    );

    // `<all_urls>` is only the carrier: a page outside the glob, on the
    // same host, must not run it.
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#target')).toHaveText('other page');
    const otherTabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, otherTabId, (s) => s.badgeText === '', 'empty badge off-glob');
    await page.close();
  });

  // A granted script (USER_SCRIPT world, so the GM runtime listens for
  // messages from the service worker) with a @match on one host and a
  // glob @include on another. Without NO_PAGE_MATCH's `*` host, Chrome
  // crashed the @include page when the worker messaged it.
  test('a glob @include on a host no @match names runs, and the page survives', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'mixed.user.js',
      meta: {
        name: 'Mixed',
        match: ['https://example.com/*'],
        include: [`${fixtureServer.baseUrl}/target*`],
        grant: ['GM_setValue'],
        runAt: 'document-end',
      },
      body: `
        GM_setValue('ran', true);
        document.getElementById('target').textContent = 'injected by SourceMonkey';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');
    await page.waitForTimeout(500);
    expect(crashed).toBe(false);
    await page.close();
  });

  // Ask Chrome directly what `includeGlobs` means, with no SourceMonkey
  // code in the way. If this ever flips to the documented AND, a
  // glob-only script (registered on NO_PAGE_MATCH) would run nowhere,
  // and `docs/injection.md` and the injector comment would be wrong.
  test('Chrome ORs includeGlobs with matches, it does not filter within them', async ({
    extensionContext, fixtureServer, getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    await sw.evaluate(async (base) => {
      await chrome.userScripts.register([{
        id: 'include-globs-probe',
        // Disjoint on purpose: /target.html by @match, /other* by glob.
        matches: [`${base}/target.html`],
        includeGlobs: [`${base}/other*`],
        runAt: 'document_end',
        js: [{ code: `const el = document.getElementById('target'); if (el) el.textContent = 'probe'; ` }],
      }]);
    }, fixtureServer.baseUrl);

    try {
      const page = await extensionContext.newPage();
      // Both halves matter. /other.html shows the globs are not merely
      // a filter within `matches` — under AND it would be untouched.
      await page.goto(`${fixtureServer.baseUrl}/other.html`);
      await expect(page.locator('#target')).toHaveText('probe');
      // /target.html shows the globs don't *replace* `matches` either:
      // it's the union, which is what a userscript header means.
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveText('probe');
      await page.close();
    } finally {
      // This test deliberately skips the `sm` fixture, so the reset it
      // performs between tests doesn't cover this registration.
      const cleanupSw = await getServiceWorker();
      await cleanupSw.evaluate(() => chrome.userScripts.unregister({ ids: ['include-globs-probe'] }));
    }
  });

  // The Chrome behavior NO_PAGE_MATCH's `*` host works around: a page
  // covered only by `includeGlobs`, on a host `matches` doesn't name,
  // is killed when the worker messages a USER_SCRIPT-world listener in
  // it. If the first half stops crashing, Chrome fixed it and the `*`
  // host is no longer needed for this.
  test('Chrome crashes a glob-only page on a message unless matches covers its host', async ({
    extensionContext, fixtureServer, getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      chrome.runtime.onUserScriptMessage.addListener((msg: { type?: string }, sender) => {
        if (msg?.type === 'crash-probe' && sender.tab?.id !== undefined) {
          void chrome.tabs.sendMessage(sender.tab.id, { type: 'crash-probe-back' }).catch(() => {});
        }
      });
    });
    const crashes = async (match: string): Promise<boolean> => {
      await sw.evaluate(async ([base, match]) => {
        await chrome.userScripts.unregister({ ids: ['crash-probe'] }).catch(() => {});
        await chrome.userScripts.register([{
          id: 'crash-probe',
          world: 'USER_SCRIPT',
          runAt: 'document_start',
          matches: [match],
          includeGlobs: [`${base}/target*`],
          js: [{ code: `chrome.runtime.onMessage.addListener(() => {}); chrome.runtime.sendMessage({ type: 'crash-probe' }).catch(() => {});` }],
        }]);
      }, [fixtureServer.baseUrl, match] as const);
      const page = await extensionContext.newPage();
      let crashed = false;
      page.on('crash', () => { crashed = true; });
      await page.goto(`${fixtureServer.baseUrl}/target.html`).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      await page.close().catch(() => {});
      return crashed;
    };
    try {
      expect(await crashes('*://sourcemonkey.invalid/*')).toBe(true);
      expect(await crashes('*://*/__sourcemonkey_no_page__/*')).toBe(false);
    } finally {
      const cleanupSw = await getServiceWorker();
      await cleanupSw.evaluate(() => chrome.userScripts.unregister({ ids: ['crash-probe'] }));
    }
  });
});
