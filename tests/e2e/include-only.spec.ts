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

  // Ask Chrome directly what `includeGlobs` means, with no SourceMonkey
  // code in the way. If this ever flips to the documented AND, the
  // fallback above still holds (the wrapper filter is doing the work) —
  // but `docs/injection.md` and the injector comment would be wrong,
  // and the @match + @include story would change with it.
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
});
