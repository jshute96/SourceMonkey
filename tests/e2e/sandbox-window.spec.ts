// A granted script in the page (MAIN) world runs inside a sandbox
// `window`, as Tampermonkey and Violentmonkey run theirs: reads reach
// the page's globals, but the script's own writes (a `@require`d
// library's included) stay off the page's `window`. A `@grant none`
// script gets the page's `window` itself.
//
// See makeSandbox in src/userscript-prelude.js and
// docs/injection.md#the-sandbox-window.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const PAGE = 'page-globals.html';
const GREEN = '#2e7d32';

test.describe('sandbox window', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('reads reach the page, writes stay in the sandbox', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // A library in the shapes real ones use: jQuery's
    // `(function (window) { window.$ = … })(window)`, and a UMD
    // (universal module definition) assigning to top-level `this`.
    scriptsDir.writeRaw('lib.js', [
      '(function (window) { window.__PAGE_FN__ = function () { return "lib-fn"; }; })(window);',
      'this.MyLib = { name: "my-lib" };',
    ].join('\n'));
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Sandboxed',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
        injectInto: 'page',
        extra: ['// @require     lib.js'],
      },
      body: `
        window.__OWN__ = 1;
        let timerFired = false;
        window.setTimeout(() => {
          timerFired = true;
          document.body.dataset.smTimer = 'fired';
        }, 0);
        // Pages often wrap addEventListener; the wrapper ends in the
        // native method, which needs the real window as \`this\`.
        const nativeAdd = unsafeWindow.addEventListener;
        unsafeWindow.addEventListener = function (...args) { return nativeAdd.apply(this, args); };
        window.addEventListener('sm-test', () => { document.body.dataset.smListener = 'heard'; });
        window.dispatchEvent(new Event('sm-test'));
        window.onclick = () => {};
        document.body.dataset.smRan = [
          // Page globals, bare and through window.
          __PAGE_APP__.name,
          window.__PAGE_APP__.name,
          // The library's copy, bare and through window.
          __PAGE_FN__(),
          window.__PAGE_FN__(),
          MyLib.name,
          __OWN__,
          // The sandbox stands in for window everywhere.
          this === window,
          self === window,
          globalThis === window,
          window.window === window,
          // The script's own bindings are on it.
          typeof this.unsafeWindow,
          typeof window.GM_setValue,
          typeof window.GM_info,
          // unsafeWindow is the page's.
          unsafeWindow === window,
          unsafeWindow.__PAGE_FN__('x'),
          Object.prototype.toString.call(window),
          // A shim reassigning a granted name works, as in VM, rather
          // than hitting our const.
          (() => { GM_setValue = 'shim'; return GM_setValue; })(),
          // Feature tests with \`in\` see the page's properties.
          'setTimeout' in window,
          '__PAGE_APP__' in window,
          'IntersectionObserver' in self,
          // Object.prototype's methods see the sandbox.
          window.hasOwnProperty('__OWN__'),
          // A native constructor with no prototype still constructs.
          typeof new window.Proxy({}, {}),
          // Non-configurable properties keep the Proxy invariants.
          (() => {
            Object.defineProperty(window, 'LOCKED', { value: 'locked', configurable: false });
            return Object.getOwnPropertyDescriptor(window, 'LOCKED').configurable + ':' + LOCKED;
          })(),
        ].join(',');
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    const body = page.locator('body');
    await expect(body).toHaveAttribute('data-sm-ran', [
      'page-app', 'page-app',
      'lib-fn', 'lib-fn', 'my-lib', '1',
      'true', 'true', 'true', 'true',
      'object', 'function', 'object',
      'false', 'page-fn:x',
      '[object Window]',
      'shim',
      'true', 'true', 'true',
      'true',
      'object',
      'false:locked',
    ].join(','));
    await expect(body).toHaveAttribute('data-sm-timer', 'fired');
    await expect(body).toHaveAttribute('data-sm-listener', 'heard');

    // The page kept its own globals, and saw none of the script's.
    expect(await page.evaluate(() => [
      (window as any).__PAGE_FN__('y'),
      typeof (window as any).MyLib,
      typeof (window as any).__OWN__,
      // A setter on the page's window took the write.
      typeof window.onclick,
      typeof (window as any).LOCKED,
    ].join(','))).toBe('page-fn:y,undefined,undefined,function,undefined');
    await page.close();
  });

  test('a reload swap runs the new body in the sandbox too', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The swap evals the new body as global code; it has to build the
    // same sandbox scope. See buildSwapEvalBody.
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: {
        name: 'SwapSandbox',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
        injectInto: 'page',
      },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial v1 green');

    scriptsDir.rewriteBody('live.user.js', `
      window.__OWN__ = 'own';
      document.title = ['v2', this === window, typeof this.GM_setValue, __OWN__, __PAGE_APP__.name].join(':');
    `);
    await page.reload();
    await expect(page).toHaveTitle('v2:true:function:own:page-app');
    expect(await page.evaluate(() => typeof (window as any).__OWN__)).toBe('undefined');
    await page.close();
  });

  test('a @grant none script gets the page window itself', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Ungranted',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['none'],
      },
      body: `
        window.__OWN__ = 'shared';
        document.body.dataset.smRan = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ran', 'yes');
    expect(await page.evaluate(() => (window as any).__OWN__)).toBe('shared');
    await page.close();
  });
});
