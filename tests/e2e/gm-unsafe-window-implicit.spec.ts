// End-to-end tests for `unsafeWindow` used WITHOUT `@grant unsafeWindow`.
//
// Tampermonkey and Violentmonkey both expose `unsafeWindow` with no
// grant line, so a script written against either has no reason to
// declare one — 112 of the GreasyFork top 2000 don't. Honoring only the
// grant left those scripts throwing a ReferenceError on the very name
// that was supposed to reach the page.
//
// So a body that names `unsafeWindow` gets the same treatment as the
// grant: MAIN world plus the `const unsafeWindow = window;` binding.
// The reference is found by a text scan at load time
// (src/unsafe-window-use.ts), recorded on the stored row, and read by
// `resolveScriptWorld`.
//
// See docs/injection.md#unsafewindow-is-the-pages-window.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const PAGE = 'page-globals.html';

test.describe('unsafeWindow without a grant', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a GM_*-granting script that never granted unsafeWindow still reaches the page', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Without the binding, `unsafeWindow` is a ReferenceError. The
    // grants work alongside it: the GM runtime and the bridge are in
    // MAIN too.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ImplicitUnsafeWindow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        const b = document.body.dataset;
        b.smAppName = String(unsafeWindow.__PAGE_APP__ && unsafeWindow.__PAGE_APP__.name);
        b.smSameAsWindow = String(unsafeWindow === window);
        b.smVisits = String(GM_getValue('visits', 0));
        GM_setValue('visits', GM_getValue('visits', 0) + 1);
        unsafeWindow.__FROM_SCRIPT__ = 'implicit';
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
    // Granted, so its window is a sandbox over the page's.
    await expect(page.locator('body')).toHaveAttribute('data-sm-same-as-window', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-sm-visits', '0');
    expect(await page.evaluate(
      () => (window as unknown as { __FROM_SCRIPT__?: string }).__FROM_SCRIPT__,
    )).toBe('implicit');
    await page.waitForTimeout(500);
    await page.close();

    // The write went out over the bridge, as it does for the granted case.
    const second = await extensionContext.newPage();
    await second.goto(`${fixtureServer.baseUrl}/${PAGE}?n=2`);
    await expect(second.locator('body')).toHaveAttribute('data-sm-visits', '1');
    await second.close();

    // Nothing to report: the script was in the page anyway.
    const detail = await sm.getCollectionWithScripts(added!.id);
    expect((detail!.scripts[0].startupLogs ?? []).filter(
      (l) => l.message.includes('unsafeWindow'),
    )).toEqual([]);
  });

  test('a script with no @grant lines at all gets the binding and no runtime', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Already MAIN world, so nothing moves — the binding was the only
    // thing missing. `unsafeWindow` needs no GM runtime, so the page
    // must stay as clean as it is for any other grant-free script.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ImplicitNoGrants',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: `
        document.body.dataset.smAppName = String(unsafeWindow.__PAGE_APP__.name);
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
    const sw = await getServiceWorker();
    const ids = await sw.evaluate(async () => (await chrome.userScripts.getScripts()).map((r) => r.id));
    expect(ids).not.toContain('sourcemonkey-gm-runtime-main');
    await page.close();

    // Nothing to report: the script did not change worlds.
    const detail = await sm.getCollectionWithScripts(added!.id);
    expect(detail!.scripts[0].startupLogs ?? []).toEqual([]);
  });

  test('a mention in a comment or a string gives no binding', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The scan strips comments and string literals first. A script that
    // only talks ABOUT unsafeWindow gets no binding for it; its sandbox
    // window carries only the bindings it got.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'MentionsOnly',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        // One day this will use unsafeWindow for the page's app object.
        const note = 'needs unsafeWindow';
        const b = document.body.dataset;
        b.smNote = note;
        b.smBinding = String(typeof this['unsafe' + 'Window']);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-note', 'needs unsafeWindow');
    await expect(page.locator('body')).toHaveAttribute('data-sm-binding', 'undefined');
    await page.close();
  });

  test('a script that declares the name itself still installs and runs', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The script reads its own binding, so the scan leaves it where its
    // grants put it. It recognizes a declarator list and a
    // destructuring pattern for this. (Our binding would be harmless
    // beside it anyway: the user program runs in a nested scope that
    // shadows ours; see wrapper-scope.spec.ts.)
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DeclaresItsOwn',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: `
        const { unsafeWindow } = window;
        const uw = unsafeWindow || window;
        document.body.dataset.smRan = '1';
        document.body.dataset.smAppName = String(uw.__PAGE_APP__.name);
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const detail = await sm.getCollectionWithScripts(added!.id);
    expect(detail!.scripts[0].status).toBe('ok');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ran', '1');
    // It reached the page on its own terms: `@grant none`-style scripts
    // already run in MAIN, and `window` there is the page's.
    await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
    await page.close();
  });

  test('@inject-into content still wins, and the dead end is reported', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // An explicit request for isolation beats an inferred one for page
    // access — the same rule as the grant, and the same warning, because
    // the grant is not what makes the combination broken.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ImplicitIsolated',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
        injectInto: 'content',
      },
      body: `
        document.body.dataset.smAppName = String(unsafeWindow.__PAGE_APP__);
        document.body.dataset.smSameAsWindow = String(unsafeWindow === window);
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'undefined');
    await expect(page.locator('body')).toHaveAttribute('data-sm-same-as-window', 'true');
    await page.close();

    const detail = await sm.getCollectionWithScripts(added!.id);
    const warning = (detail!.scripts[0].startupLogs ?? []).find(
      (l) => l.message.includes('unsafeWindow'),
    );
    expect(warning, 'expected the isolated-unsafeWindow warning').toBeTruthy();
    expect(warning!.level).toBe('warn');
  });
});
