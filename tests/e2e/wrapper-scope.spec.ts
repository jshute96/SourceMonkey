// The user program (requires + body) runs in a scope NESTED inside the
// wrap function that declares our own names (`GM_info`, granted
// `GM_*`, `unsafeWindow`, the `__sm*` preamble). So a script's own
// top-level declaration of one of those names shadows ours, as it does
// under Tampermonkey and Violentmonkey, instead of being a duplicate-
// declaration SyntaxError or putting our `const unsafeWindow = window;`
// in the temporal dead zone (TDZ) of the script's `const window`.
//
// See wrapCombinedEntry in src/extension/injector.ts and
// docs/injection.md#the-user-program-scope.

import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const PAGE = 'page-globals.html';

// The 1-based line of a file that starts with `prefix`.
function lineOf(file: string, prefix: string): number {
  return fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.startsWith(prefix)) + 1;
}
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

  test('names TM and VM give every script: an open GM, the module names, the Firefox stand-ins', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Measured in TM 5.5.0 and VM 2.49.0. A UMD library sees no module
    // system, not even the page's AMD `define`, so it sets a global.
    scriptsDir.writeRaw('umd.js', [
      '(function (root, factory) {',
      '  if (typeof define === "function" && define.amd) define([], factory);',
      '  else if (typeof module === "object" && module.exports) module.exports = factory();',
      '  else root.UmdLib = factory();',
      '})(this, function () { return { name: "umd" }; });',
    ].join('\n'));
    const body = `
      GM.myExtra = 1;
      const fn = () => 7;
      const target = {};
      document.documentElement.dataset['sm_' + GM_info.script.name] = [
        Object.isFrozen(GM), GM.myExtra, Object.isFrozen(GM_info),
        exports, module, define,
        UmdLib.name,
        cloneInto(target, {}) === target,
        exportFunction(fn, target, { defineAs: 'f' }) === fn && target.f === fn,
        typeof createObjectIn(target, { defineAs: 'o' }) === 'object' && typeof target.o,
      ].join(',');
    `;
    for (const [name, extra] of [['page', []], ['isolated', ['// @inject-into content']]] as const) {
      scriptsDir.write({
        relativePath: `${name}.user.js`,
        meta: {
          name,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          grant: ['GM_setValue'],
          extra: ['// @require     umd.js', ...extra],
        },
        body,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.route(`${fixtureServer.baseUrl}/amd.html`, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html><head><script>
        window.define = function () { window.__pageDefineCalled = true; };
        window.define.amd = {};
      </script></head><body></body></html>`,
    }));
    await page.goto(`${fixtureServer.baseUrl}/amd.html`);
    const expected = 'false,1,false,,,,umd,true,true,object';
    await expect(page.locator('html')).toHaveAttribute('data-sm_page', expected);
    await expect(page.locator('html')).toHaveAttribute('data-sm_isolated', expected);
    expect(await page.evaluate(() => (window as any).__pageDefineCalled)).toBeUndefined();
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
        var define = 'mine';
        exports = 'assigned';
        var __smE = 1;
        let __smDecision = 2;
        document.body.dataset.smRan = [
          GM_info.mine,
          GM_addStyle('x'),
          unsafeWindow === window,
          // The sandbox, which shows only the browser's built-ins.
          typeof self.__PAGE_APP__,
          // A name the script left alone still reaches our binding.
          GM_getValue('k', 'dflt'),
          define, exports,
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
      'data-sm-ran', 'true,own:x,true,undefined,dflt,mine,assigned',
    );
    await page.close();
  });

  test('a @require that declares unsafeWindow runs beside the grant', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // `const unsafeWindow = window.wrappedJSObject || window;` is a real
    // library idiom. The requires share the script's nested scope, so
    // the library's declaration shadows our granted binding. On Chrome
    // that makes it the sandbox, as in Tampermonkey, so the page's
    // globals are read by bare name here.
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
      body: `document.body.dataset.smApp = String(unsafeWindow === window) + ':' + __PAGE_APP__.name;`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const detail = await sm.getCollectionWithScripts(added!.id);
    expect(detail!.scripts[0].status).toBe('ok');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-app', 'true:page-app');
    await page.close();
  });

  test('a leading "use strict" applies; top-level this and return still work', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The script is the nested scope's first statement, so its
    // directive applies to the whole program, as in Tampermonkey and
    // Violentmonkey (tests/examples/use-strict).
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
        try { smUndeclared = 'sloppy'; b.smUndeclared = 'assigned'; } catch (e) { b.smUndeclared = e.name; }
        b.smInnerThis = String((function () { return this === undefined; })());
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
    await expect(page.locator('body')).toHaveAttribute('data-sm-undeclared', 'ReferenceError');
    await expect(page.locator('body')).toHaveAttribute('data-sm-inner-this', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-this', 'true');
    expect(await page.locator('body').getAttribute('data-sm-after-return')).toBeNull();
    await page.close();
  });

  test('the install-time syntax check applies a leading "use strict" too', async ({ sm }) => {
    // `with` is legal sloppy code and a SyntaxError in strict mode, so
    // the check has to judge the program in the mode it will run in, and
    // still point at the right line past its own blank first line.
    const file = scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Strict with', match: ['https://e.com/*'], grant: ['none'] },
      body: `'use strict';\nwith (Math) { void PI; }\n`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    const [script] = (await sm.getCollectionWithScripts(added!.id))!.scripts;
    expect(script.status).toBe('invalid');
    expect(script.errorMessage).toMatch(/^Syntax error: .*with statement/i);
    expect(script.errorLocation).toEqual({ file: 'a.user.js', line: lineOf(file, 'with'), column: 1 });
  });

  test('a first @require\'s "use strict" applies to the body in the syntax check', async ({ sm }) => {
    scriptsDir.writeRaw('strict-lib.js', `'use strict';\nvar lib = 1;\n`);
    const file = scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Strict lib', match: ['https://e.com/*'], grant: ['none'], extra: ['// @require     strict-lib.js'] },
      body: `with (Math) { void PI; }\n`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    const [script] = (await sm.getCollectionWithScripts(added!.id))!.scripts;
    expect(script.status).toBe('invalid');
    expect(script.errorMessage).toMatch(/^Syntax error: .*with statement/i);
    expect(script.errorLocation).toEqual({ file: 'a.user.js', line: lineOf(file, 'with'), column: 1 });
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

    // Its 'use strict' applies in the swap too.
    scriptsDir.rewriteBody('live.user.js', `'use strict';
      const GM_info = 'mine';
      var GM_setValue = 0;
      const strict = (function () { return this === undefined; })();
      document.title = 'v2:' + GM_info + ':' + GM_setValue + ':' + strict;
    `);
    await page.reload();
    await expect(page).toHaveTitle('v2:mine:0:true');
    await page.close();
  });
});
