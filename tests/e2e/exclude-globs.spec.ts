// `@exclude`, and the Chrome behaviour the registration path has to
// work around: `chrome.userScripts.update` ignores `includeGlobs` /
// `excludeGlobs` entirely. Only Chrome can say that, so this is e2e.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('@exclude', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  const body = `
    const el = document.getElementById('target');
    if (el) el.textContent = 'injected by SourceMonkey';
  `;

  test('a script @exclude-d from a page does not run there', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'excluded.user.js',
      meta: {
        name: 'Excluded',
        match: [`${fixtureServer.baseUrl}/*`],
        exclude: [`${fixtureServer.baseUrl}/other*`],
        runAt: 'document-end',
      },
      body,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#target')).toHaveText('other page');
    await page.close();
  });

  // The regression: adding an `@exclude` to a script that was already
  // registered without one. `update` silently drops the new glob, so
  // the script kept running on the excluded page and the badge showed
  // UNEXPECTED. `replaceRegistration` is what makes it land.
  test('an @exclude added after registration takes effect', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const meta = {
      name: 'Excluded Later',
      match: [`${fixtureServer.baseUrl}/*`],
      runAt: 'document-end' as const,
    };
    scriptsDir.write({ relativePath: 'later.user.js', meta, body });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');

    scriptsDir.write({
      relativePath: 'later.user.js',
      meta: { ...meta, exclude: [`${fixtureServer.baseUrl}/other*`] },
      body,
    });
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();

    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#target')).toHaveText('other page');
    // Still runs where it isn't excluded.
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');
    await page.close();
  });

  // Ask Chrome directly, with no SourceMonkey code in the way. If any
  // of this ever changes, `PlacedPatterns` in src/extension/injector.ts can stop
  // re-registering scripts whose globs changed.
  test('Chrome honours excludeGlobs at register, and ignores them on update', async ({
    extensionContext, fixtureServer, getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    const reported = await sw.evaluate(async (base) => {
      await chrome.userScripts.register([{
        id: 'exclude-globs-probe',
        matches: [`${base}/*`],
        excludeGlobs: [`${base}/other*`],
        runAt: 'document_end',
        js: [{ code: `const el = document.getElementById('target'); if (el) el.textContent = 'probe';` }],
      }]);
      // Neither the add nor the change lands, and neither call throws.
      // The casts are only because the DOM typings mark `js` required
      // on `update`; the real API takes a partial spec.
      type UpdateSpec = chrome.userScripts.RegisteredUserScript;
      await chrome.userScripts.update([{ id: 'exclude-globs-probe', excludeGlobs: [`${base}/target*`] } as UpdateSpec]);
      await chrome.userScripts.update([{ id: 'exclude-globs-probe', includeGlobs: [`${base}/inc*`] } as UpdateSpec]);
      const got = await chrome.userScripts.getScripts({ ids: ['exclude-globs-probe'] });
      return { excludeGlobs: got[0].excludeGlobs, includeGlobs: got[0].includeGlobs };
    }, fixtureServer.baseUrl);

    // Everything after the register goes inside the `try`: this test
    // deliberately skips the `sm` fixture, so the reset it performs
    // between tests doesn't cover this registration — and a leaked one
    // matching `${base}/*` would inject into other specs' fixture pages.
    try {
      // getScripts reports the REGISTERED globs, not the updated ones —
      // which is why our own record of what's placed has to be believed
      // over any hope that `update` applied them.
      expect(reported.excludeGlobs).toEqual([`${fixtureServer.baseUrl}/other*`]);
      expect(reported.includeGlobs).toBeUndefined();

      const page = await extensionContext.newPage();
      // The registered exclude is live; the updated one never arrived.
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveText('probe');
      await page.goto(`${fixtureServer.baseUrl}/other.html`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#target')).toHaveText('other page');
      await page.close();
    } finally {
      await sw.evaluate(() => chrome.userScripts.unregister({ ids: ['exclude-globs-probe'] }));
    }
  });
});
