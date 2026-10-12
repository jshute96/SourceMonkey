// The channel key against a hostile page (docs/injection.md, "The
// channel key"). The page hooks the built-ins a page could use to watch
// our page-world code after document_start, before any of it runs past
// its first entries: `Function.prototype.call` / `apply`, `Reflect.apply`,
// timers, `Promise.prototype.then`, JSON, event construction and
// dispatch, getters on `Object.prototype` for fields we read, and V8's
// stack-trace API. A granted page-world script then uses storage, XHR,
// DOM insertion and a GM4 alias, on a load and on a reload swap. Nothing
// the page saw may contain the key.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Runs first in the page's <head>. Every hook records what passes
// through it, as strings, in `window.__seen`.
const HOOKS = `
(function () {
  var seen = window.__seen = [];
  var origCall = Function.prototype.call, origApply = Function.prototype.apply, origReflect = Reflect.apply;
  var fnToString = Function.prototype.toString, stringify = JSON.stringify, parse = JSON.parse;
  var busy = false;
  var str = function (v) {
    try {
      if (typeof v === 'function') return origReflect(fnToString, v, []);
      if (v && typeof v === 'object') {
        var out = '';
        try { out += String(v.type) + ' '; } catch (e) {}
        try { out += origReflect(stringify, JSON, [v]); } catch (e) {}
        return out;
      }
      return String(v);
    } catch (e) { return ''; }
  };
  // Records its arguments, and the current event's type. Hooks call
  // only saved references inside it, and it doesn't re-enter.
  var note = function () {
    if (busy) return;
    busy = true;
    try {
      try { if (window.event) seen.push(String(window.event.type)); } catch (e) {}
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        // An arguments list or array: each of its items.
        if (a && typeof a === 'object' && typeof a.length === 'number' && !(a instanceof Node)) {
          for (var j = 0; j < a.length; j++) seen.push(str(a[j]));
        } else seen.push(str(a));
      }
    } finally { busy = false; }
  };
  Function.prototype.call = function () { note(this, arguments); return origReflect(origCall, this, arguments); };
  Function.prototype.apply = function (t, a) { note(this, t, a); return origReflect(origApply, this, arguments); };
  Reflect.apply = function (f, t, a) { note(f, t, a); return origReflect(f, t, a); };
  ['setTimeout', 'clearTimeout', 'queueMicrotask'].forEach(function (n) {
    var o = window[n];
    window[n] = function () { note(arguments); return origReflect(o, window, arguments); };
  });
  var add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function () { note(arguments); return origReflect(add, this, arguments); };
  var then = Promise.prototype.then;
  Promise.prototype.then = function (a, b) {
    note(this);
    var wrap = function (f) { return typeof f === 'function' ? function (v) { note(v); return f(v); } : f; };
    return origReflect(then, this, [wrap(a), wrap(b)]);
  };
  JSON.parse = function (s) { note(s); return origReflect(parse, JSON, arguments); };
  JSON.stringify = function (v) { var r = origReflect(stringify, JSON, arguments); note(r); return r; };
  var CE = window.CustomEvent;
  window.CustomEvent = function (type, init) { note(type, init); return new CE(type, init); };
  window.CustomEvent.prototype = CE.prototype;
  var dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) { note(ev); return origReflect(dispatch, this, [ev]); };
  // Not get / set / then / toJSON: on Object.prototype those break the
  // page itself (every defineProperty with a value throws).
  ['startupLogs', 'needsRuntime', 'seedValues', 'gmValues', 'gm', 'prelude'].forEach(function (k) {
    Object.defineProperty(Object.prototype, k, { configurable: true, get: function () { note(this); return undefined; } });
  });
  Error.prepareStackTrace = function (e, sites) {
    sites.forEach(function (s) { try { var f = s.getFunction(); if (f) note(f); } catch (x) {} });
    return String(e);
  };
})();
`;

test.describe('the channel key', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a page hooking the usual built-ins never sees it', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const url = `${fixtureServer.baseUrl}/hostile.html`;
    scriptsDir.write({
      relativePath: 'granted.user.js',
      meta: {
        name: 'Granted',
        match: [url],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest', 'GM_addStyle', 'GM.getValue'],
        extra: ['// @connect 127.0.0.1'],
      },
      body: `
        GM_setValue('n', GM_getValue('n', 0) + 1);
        GM_addStyle('body { color: rgb(1, 2, 3); }');
        GM.getValue('n').then((v) => { document.body.dataset.alias = String(v); });
        GM_xmlhttpRequest({ url: location.href, onload: (r) => { document.body.dataset.fetched = String(r.status); } });
        // Page code the program calls, and an error it throws later.
        setTimeout(() => { document.body.dataset.done = '1'; throw new Error('late'); }, 0);
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
    const check = async (): Promise<void> => {
      await expect(page.locator('body')).toHaveAttribute('data-done', '1');
      await expect(page.locator('body')).toHaveAttribute('data-fetched', /^\d+$/);
      await expect(page.locator('body')).toHaveAttribute('data-alias', /\d/);
      const key = await sm.channelKey();
      const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => s.includes(key))).toEqual([]);
    };
    await page.goto(url);
    await check();
    // A reload swap: an edit picked up on reload hands the wrapper a new
    // body, which carries the key, over the bridge.
    scriptsDir.write({
      relativePath: 'granted.user.js',
      meta: {
        name: 'Granted',
        match: [url],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest', 'GM_addStyle', 'GM.getValue'],
        extra: ['// @connect 127.0.0.1'],
      },
      body: `
        GM_setValue('n', GM_getValue('n', 0) + 1);
        GM.getValue('n').then((v) => { document.body.dataset.alias = String(v); });
        GM_xmlhttpRequest({ url: location.href, onload: (r) => { document.body.dataset.fetched = String(r.status); } });
        setTimeout(() => { document.body.dataset.done = '1'; document.body.dataset.v = '2'; }, 0);
      `,
    });
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-v', '2');
    await check();
    await page.close();
  });
});
