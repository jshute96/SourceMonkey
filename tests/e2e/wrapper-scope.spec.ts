// The user program (requires + body) runs in a scope NESTED inside the
// wrap function that declares our own names (`GM_info`, granted
// `GM_*`, `unsafeWindow`, the `__sm*` preamble). So a script's own
// top-level declaration of one of those names shadows ours, as it does
// under Tampermonkey and Violentmonkey, instead of being a duplicate-
// declaration SyntaxError or putting our `const unsafeWindow = window;`
// in the temporal dead zone (TDZ) of the script's `const window`.
//
// See wrapCombinedEntry in src/injector.ts and
// docs/injection.md#the-user-program-scope.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const PAGE = 'page-globals.html';
const GREEN = '#2e7d32';

test.describe('user program scope', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a top-level `const window = unsafeWindow` runs', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Smart Auto Redirect & Scroll (GreasyFork 531756) does exactly
    // this. With our binding in the same scope, reading `window` for
    // `const unsafeWindow = window;` hit the script's `window` before
    // its initializer ran, and the whole script died with a
    // ReferenceError.
    scriptsDir.write({
      relativePath: 'granted.user.js',
      meta: {
        name: 'WindowFromUnsafeWindow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow'],
      },
      body: `
        const window = unsafeWindow;
        document.body.dataset.smGranted = String(window.__PAGE_APP__.name);
      `,
    });
    // Same, with the binding inferred from an ungranted reference.
    scriptsDir.write({
      relativePath: 'implicit.user.js',
      meta: {
        name: 'WindowFromImplicitUnsafeWindow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        const window = unsafeWindow;
        document.body.dataset.smImplicit = String(window.__PAGE_APP__.name);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-granted', 'page-app');
    await expect(page.locator('body')).toHaveAttribute('data-sm-implicit', 'page-app');
    await page.close();
  });

  test('a script redeclaring wrapper-provided names shadows them', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Every shape here was a SyntaxError (or TDZ error) against a
    // same-scope wrap. The polyfill and own-`GM_addStyle` shapes are
    // from real GreasyFork scripts that run under Tampermonkey.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Redeclares',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_getValue', 'GM_setValue', 'GM_addStyle'],
      },
      body: `
        const unsafeWindow = window;
        let GM_info = { mine: true };
        if (typeof GM_setValue === 'undefined') { var GM_setValue = function () {}; }
        function GM_addStyle(css) { return 'own:' + css; }
        const self = window;
        var __smE = 1;
        let __smDecision = 2;
        document.body.dataset.smRan = [
          GM_info.mine,
          GM_addStyle('x'),
          unsafeWindow === window,
          typeof self.__PAGE_APP__,
          // A name the script left alone still reaches our binding.
          GM_getValue('k', 'dflt'),
        ].join(',');
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // The install-time parse check compiles the same scope arrangement,
    // so it must not call this script broken.
    const detail = await sm.getCollectionWithScripts(added!.id);
    expect(detail!.scripts[0].status).toBe('ok');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute(
      'data-sm-ran', 'true,own:x,true,object,dflt',
    );
    await page.close();
  });

  test('a @require that declares unsafeWindow runs beside the grant', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // `const unsafeWindow = window.wrappedJSObject || window;` is a real
    // library idiom. The requires share the script's nested scope, so
    // the library's declaration shadows our granted binding.
    scriptsDir.writeRaw('lib.js', 'const unsafeWindow = window.wrappedJSObject || window;\n');
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'LibDeclaresUnsafeWindow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow'],
        extra: ['// @require     lib.js'],
      },
      body: `document.body.dataset.smApp = String(unsafeWindow.__PAGE_APP__.name);`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const detail = await sm.getCollectionWithScripts(added!.id);
    expect(detail!.scripts[0].status).toBe('ok');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-app', 'page-app');
    await page.close();
  });

  test('a leading "use strict" stays inert; top-level this and return still work', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The nested scope starts with our own `void 0;`, so a directive at
    // the top of the script is not a directive, as before the nested
    // scope existed: the program runs sloppy, so an undeclared
    // assignment still works.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Directive',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['none'],
      },
      body: `'use strict';
        const b = document.body.dataset;
        smUndeclared = 'sloppy';
        b.smUndeclared = smUndeclared;
        // Sloppy-only syntax: the install-time parse check must agree.
        with (Math) { b.smWith = String(PI > 3); }
        b.smInnerThis = String((function () { return this === window; })());
        b.smThis = String(this === window);
        if (this === window) return;
        b.smAfterReturn = 'reached';
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const detail = await sm.getCollectionWithScripts(added!.id);
    expect(detail!.scripts[0].status).toBe('ok');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-undeclared', 'sloppy');
    await expect(page.locator('body')).toHaveAttribute('data-sm-with', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-inner-this', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-this', 'true');
    expect(await page.locator('body').getAttribute('data-sm-after-return')).toBeNull();
    await page.close();
  });

  test('a reload swap gives the swapped body the same nested scope', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The swap evals the GM bindings and the new body together, so the
    // same clash existed there. See buildSwapEvalBody.
    scriptsDir.write({
      relativePath: 'live.user.js',
      // USER_SCRIPT world, where the fast path checks in with the SW;
      // see reload-fast-path.spec.ts.
      meta: {
        name: 'SwapScope',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        injectInto: 'content',
        grant: ['GM_setValue'],
      },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial v1 green');

    scriptsDir.rewriteBody('live.user.js', `
      const GM_info = 'mine';
      var GM_setValue = 0;
      document.title = 'v2:' + GM_info + ':' + GM_setValue;
    `);
    await page.reload();
    await expect(page).toHaveTitle('v2:mine:0');
    await page.close();
  });
});
