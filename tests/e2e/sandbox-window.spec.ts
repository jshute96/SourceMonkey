// Scripts run in the page (MAIN) world by default, and any but a
// `@grant none` one runs inside a sandbox `window`, as Tampermonkey and Violentmonkey
// run theirs: reads reach the page's globals, but the script's own
// writes (a `@require`d library's included) stay off the page's
// `window`. A `@grant none` script gets the page's `window` itself.
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
          // Page globals: bare names reach them; the sandbox window
          // shows only the browser's built-ins, as in TM and VM.
          __PAGE_APP__.name,
          typeof window.__PAGE_APP__,
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
          // Feature tests with \`in\` see the built-ins, not the page's
          // own globals.
          'setTimeout' in window,
          '__PAGE_APP__' in window,
          'IntersectionObserver' in self,
          Object.keys(window).includes('__PAGE_APP__'),
          // A bare built-in is the sandbox's too.
          setTimeout === window.setTimeout,
          // Object.prototype's methods see the sandbox.
          window.hasOwnProperty('__OWN__'),
          // A native constructor with no prototype still constructs.
          typeof new window.Proxy({}, {}),
          // A bound copy reads as native exactly when the original does,
          // and is the same copy each time. The page's wrapper above
          // isn't seen: the sandbox has the browser's own method.
          Function.prototype.toString.call(window.setTimeout).includes('native code'),
          Function.prototype.toString.call(window.addEventListener).includes('native code'),
          window.setTimeout === window.setTimeout,
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
      'page-app', 'undefined',
      'lib-fn', 'lib-fn', 'my-lib', '1',
      'true', 'true', 'true', 'true',
      'object', 'function', 'object',
      'false', 'page-fn:x',
      '[object Window]',
      'shim',
      'true', 'false', 'true', 'false', 'true',
      'true',
      'object',
      'true', 'true', 'true',
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

  test('iframe guards: bare top and parent match the sandbox in the top frame, and not in a child frame', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // `if (window.self !== top) return;` and its variants are how most
    // scripts skip frames; in the top frame each must read as false.
    scriptsDir.write({
      relativePath: 'guards.user.js',
      meta: {
        name: 'Guards',
        match: [`${fixtureServer.baseUrl}/frames-*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        document.documentElement.dataset.smFramed = [
          self !== top, window.self !== top, window !== top, window.top !== window.self,
          parent !== window, self !== window.parent, frames === window,
        ].join(',');
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const html = (body: string) => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body });
    await page.route(`${fixtureServer.baseUrl}/frames-top.html`, (route) => route.fulfill(
      html('<!doctype html><iframe src="frames-child.html"></iframe>'),
    ));
    await page.route(`${fixtureServer.baseUrl}/frames-child.html`, (route) => route.fulfill(html('<!doctype html><p>child</p>')));
    await page.goto(`${fixtureServer.baseUrl}/frames-top.html`);
    await expect(page.locator('html')).toHaveAttribute('data-sm-framed', 'false,false,false,false,false,false,true');
    const child = page.frames().find((f) => f.url().endsWith('/frames-child.html'))!;
    await expect(child.locator('html')).toHaveAttribute('data-sm-framed', 'true,true,true,true,true,true,true');
    await page.close();
  });

  test('the sandbox window has the browser\'s built-ins as they were before the page ran', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Measured in TM 5.5.0 and VM 2.49.0: a page's replacement of a
    // built-in, its `var` / `function` globals and element ids are
    // left off the sandbox window, while bare names still reach them.
    scriptsDir.write({
      relativePath: 'builtins.user.js',
      meta: { name: 'Builtins', match: [`${fixtureServer.baseUrl}/builtins.html`], runAt: 'document-end', grant: ['GM_setValue'] },
      body: `
        document.documentElement.dataset.smSeen = [
          window.fetch === unsafeWindow.fetch,
          fetch === unsafeWindow.fetch,
          Function.prototype.toString.call(window.fetch).includes('native code'),
          typeof window.pageVar, pageVar,
          typeof window.pageFn, typeof pageFn,
          typeof window.probeDiv, typeof probeDiv,
          window.name,
          window.document === unsafeWindow.document,
          (() => { const f = (x) => eval('x + 1'); return f(1); })(),
        ].join(',');
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.route(`${fixtureServer.baseUrl}/builtins.html`, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html><head><script>
        var pageVar = 'pv';
        function pageFn() {}
        const origFetch = window.fetch;
        window.fetch = function pageFetch() { return origFetch.apply(this, arguments); };
        window.name = 'pagename';
      </script></head><body><div id="probeDiv"></div></body></html>`,
    }));
    await page.goto(`${fixtureServer.baseUrl}/builtins.html`);
    await expect(page.locator('html')).toHaveAttribute('data-sm-seen', [
      'false', 'false', 'true',
      'undefined', 'pv',
      'undefined', 'function',
      'undefined', 'object',
      'pagename', 'true',
      '2',
    ].join(','));
    await page.close();
  });

  test('the sandbox window: frames by index, static members, and what a page changed before the script', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'edges.user.js',
      meta: { name: 'Edges', match: [`${fixtureServer.baseUrl}/edges.html`], runAt: 'document-end', grant: ['GM_setValue'] },
      body: `
        window.opener = 'mine';
        document.documentElement.dataset.smEdges = [
          // Child frames by index are the page's.
          window.length, window[0] === unsafeWindow[0], frames[0] === unsafeWindow[0],
          // A native constructor's static members survive.
          typeof Proxy.revocable, typeof window.Proxy.revocable,
          // The language's globals are the originals.
          window.JSON === unsafeWindow.JSON, typeof JSON.parse,
          // A constructor the page deleted before the script ran is gone.
          'Notification' in window,
          // One the page replaced before first use shows through (read lazily).
          FormData.name,
          // A [Replaceable] write reads back.
          window.opener,
        ].join(',');
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.route(`${fixtureServer.baseUrl}/edges.html`, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html><head><script>
        window.JSON = { parse: function () {}, stringify: function () {} };
        delete window.Notification;
        window.FormData = function PageFormData() {};
      </script></head><body><iframe srcdoc="<p>child</p>"></iframe></body></html>`,
    }));
    await page.goto(`${fixtureServer.baseUrl}/edges.html`);
    // The [Replaceable] write stayed in the sandbox.
    await expect.poll(() => page.locator('html').getAttribute('data-sm-edges')).toBeTruthy();
    expect(await page.evaluate(() => window.opener)).toBeNull();
    await expect(page.locator('html')).toHaveAttribute('data-sm-edges', [
      '1', 'true', 'true',
      'function', 'function',
      'false', 'function',
      'false',
      'PageFormData',
      'mine',
    ].join(','));
    await page.close();
  });

  // The sandbox is built when the script runs, which for a document-end
  // or idle script is after the page's own code. A page that replaced
  // `Object.create` would get the sandbox's own properties (every
  // granted GM_* function) defined on an object it made; one hooking
  // array and function methods would see the load listeners the body
  // queues. The prelude uses built-ins it saved first.
  test('a page replacing Object.create or array methods sees none of the sandbox', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const url = `${fixtureServer.baseUrl}/hostile-sandbox.html`;
    const HOOKS = `
      (function () {
        // Keeps only what names the script's functions, so a hook that
        // runs constantly doesn't fill the page's memory.
        var seen = window.__seen = [], calls = 0, busy = false;
        var R = Reflect.apply, fnToString = Function.prototype.toString, test = RegExp.prototype.test;
        var secret = /GM_getValue|onLoadSecret|ownSecret/;
        var note = function (v) {
          if (busy) return;
          busy = true;
          try {
            calls++;
            var t = typeof v === 'function' ? R(fnToString, v, []) : typeof v === 'string' ? v : '';
            if (R(test, secret, [t])) seen[seen.length] = t;
          } catch (e) {} finally { busy = false; }
          window.__calls = calls;
        };
        var create = Object.create;
        Object.create = function (proto) {
          var o = R(create, Object, arguments);
          if (proto !== null) return o;
          return new Proxy(o, {
            defineProperty: function (t, k, d) { note(k); note(d.value); return Reflect.defineProperty(t, k, d); },
            set: function (t, k, v) { note(k); note(v); t[k] = v; return true; },
          });
        };
        ['push', 'forEach'].forEach(function (n) {
          var orig = Array.prototype[n];
          Array.prototype[n] = function () { for (var i = 0; i < arguments.length; i++) note(arguments[i]); return R(orig, this, arguments); };
        });
        var call = Function.prototype.call, apply = Function.prototype.apply;
        Function.prototype.call = function () { note(this); return R(call, this, arguments); };
        Function.prototype.apply = function () { note(this); return R(apply, this, arguments); };
        // The page's own use, so the test knows the hooks are live.
        [Object.create(null)].forEach(function () {});
      })();
    `;
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Sandboxed', match: [url], grant: ['GM_getValue'] },
      body: `
        window.addEventListener('load', function onLoadSecret() { document.body.dataset.loaded = 'yes'; });
        window.mine = function ownSecret() {};
        document.body.dataset.smRan = typeof GM_getValue;
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.route(url, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html><head><script>${HOOKS}</script></head><body>hostile</body></html>`,
    }));
    await page.goto(url);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ran', 'function');
    await expect(page.locator('body')).toHaveAttribute('data-loaded', 'yes');
    const { calls, seen } = await page.evaluate(() => {
      const w = window as unknown as { __calls: number; __seen: string[] };
      return { calls: w.__calls, seen: w.__seen };
    });
    // The hooks ran, and saw nothing of the script's.
    expect(calls).toBeGreaterThan(0);
    expect(seen).toEqual([]);
    await page.close();
  });

  test('a script with no @grant line is sandboxed too, as in TM and VM', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'grantless.user.js',
      meta: { name: 'Grantless', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `
        window.__GRANTLESS_OWN__ = 1;
        const { unsafeWindow } = window;
        document.body.dataset.smGrantless = [
          typeof window.__PAGE_APP__, __PAGE_APP__.name,
          unsafeWindow === window, unsafeWindow.__PAGE_APP__.name,
        ].join(',');
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-grantless', 'undefined,page-app,false,page-app');
    expect(await page.evaluate(() => typeof (window as any).__GRANTLESS_OWN__)).toBe('undefined');
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

  test('a granted script reads page globals by default; @sandbox DOM isolates it', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The world default: the page, as in TM and VM. TM's @sandbox DOM
    // (like VM's @inject-into content) asks for the isolated world.
    for (const [file, extra] of [['page.user.js', []], ['dom.user.js', ['// @sandbox     DOM']]] as const) {
      scriptsDir.write({
        relativePath: file,
        meta: {
          name: file,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          grant: ['GM_setValue'],
          extra: [...extra],
        },
        body: `document.body.dataset['sm_' + ${JSON.stringify(file.split('.')[0])}] = typeof __PAGE_APP__;`,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm_page', 'object');
    await expect(page.locator('body')).toHaveAttribute('data-sm_dom', 'undefined');
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
