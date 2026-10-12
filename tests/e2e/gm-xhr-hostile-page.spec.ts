// GM_xmlhttpRequest against a page that hooks the built-ins a request
// and its response pass through (docs/injection.md, "What it doesn't
// stop"). The request runs from the worker, so its response can be
// something the page itself could never read: the runtime handles it
// with built-ins captured at document_start, and objects with no
// prototype or own fields defined outright, so none of the page's hooks
// below sees the request's headers or URL, or the response's body, in
// any responseType.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const SECRET = 'xhr-secret-4f1c9a';

// Runs first in the page's <head>. Every hook looks at what passes
// through it, as text: it counts the calls in \`window.__calls\`, and
// keeps any text with the secret in it in \`window.__seen\`.
const HOOKS = `
(function () {
  var seen = window.__seen = [];
  var SECRET = ${JSON.stringify(SECRET)}, indexOf = String.prototype.indexOf;
  window.__calls = 0;
  var R = Reflect.apply, stringify = JSON.stringify, parse = JSON.parse;
  var TD = TextDecoder, decode = TextDecoder.prototype.decode;
  var busy = false;
  var isArray = Array.isArray;
  var text = function (v) {
    try {
      if (v instanceof ArrayBuffer) v = new Uint8Array(v);
      if (ArrayBuffer.isView(v)) return R(decode, new TD(), [v]);
      // An array of byte pieces (what Blob and iteration see): each one.
      if (isArray(v)) {
        var all = '';
        for (var i = 0; i < v.length; i++) all += text(v[i]) + ' ';
        return all;
      }
      if (v && typeof v === 'object') return R(stringify, JSON, [v]) || '';
      return String(v);
    } catch (e) { return ''; }
  };
  var note = function () {
    if (busy) return;
    busy = true;
    try {
      window.__calls++;
      for (var i = 0; i < arguments.length; i++) {
        var t = text(arguments[i]);
        if (R(indexOf, t, [SECRET]) !== -1) seen[seen.length] = t;
      }
    } finally { busy = false; }
  };
  var wrap = function (obj, name) {
    var orig = obj[name];
    obj[name] = function () { note.apply(null, arguments); note(this); return R(orig, this, arguments); };
  };
  wrap(TextDecoder.prototype, 'decode');
  wrap(window, 'atob');
  wrap(String.prototype, 'charCodeAt');
  wrap(String.prototype, 'indexOf');
  wrap(Array.prototype, 'push');
  wrap(JSON, 'parse');
  wrap(DOMParser.prototype, 'parseFromString');
  wrap(ReadableStreamDefaultController.prototype, 'enqueue');
  var TA = Object.getPrototypeOf(Uint8Array.prototype);
  wrap(TA, 'set');
  if (Uint8Array.fromBase64) wrap(Uint8Array, 'fromBase64');
  var bufGet = Object.getOwnPropertyDescriptor(TA, 'buffer').get;
  Object.defineProperty(TA, 'buffer', { configurable: true, get: function () { note(this); return R(bufGet, this, []); } });
  var iter = Array.prototype[Symbol.iterator];
  Array.prototype[Symbol.iterator] = function () { note(this); return R(iter, this, []); };
  var B = window.Blob;
  window.Blob = function (parts, opts) { note(parts); return new B(parts, opts); };
  window.Blob.prototype = B.prototype;
  var U = window.URL;
  window.URL = function (u, base) { note(u, base); return new U(u, base); };
  window.URL.prototype = U.prototype;
  var hrefGet = Object.getOwnPropertyDescriptor(U.prototype, 'href').get;
  Object.defineProperty(U.prototype, 'href', { configurable: true, get: function () { var h = R(hrefGet, this, []); note(h); return h; } });
  JSON.stringify = function (v) { var r = R(stringify, JSON, arguments); note(r); return r; };
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, writable: true, value: function () { note(this); return this; } });
  // Setters for the fields the runtime fills in, and getters for ones
  // an event may lack.
  ['responseText', 'response', 'readyState', 'error', 'lengthComputable', 'loaded'].forEach(function (k) {
    Object.defineProperty(Object.prototype, k, { configurable: true, set: function (v) { note(v); } });
  });
  // \`total\` and \`message\` an event may lack; the rest, fields a
  // script leaves out of \`details\`.
  ['total', 'message', 'method', 'timeout', 'anonymous', 'ontimeout', 'onabort', 'onloadend'].forEach(function (k) {
    Object.defineProperty(Object.prototype, k, { configurable: true, get: function () { note(this); return undefined; } });
  });
})();
`;

test('GM_xmlhttpRequest: a page hooking the built-ins sees neither the request nor the response', async ({
  extensionContext, fixtureServer, sm,
}) => {
  const url = `${fixtureServer.baseUrl}/hostile-xhr.html`;
  scriptsDir.write({
    relativePath: 'fetcher.user.js',
    meta: {
      name: 'Fetcher',
      match: [url],
      runAt: 'document-end',
      grant: ['GM_xmlhttpRequest'],
      extra: ['// @connect 127.0.0.1'],
    },
    // The script checks what it got with plain loops and property
    // reads, not the built-ins the page hooks, so only our handling is
    // under test.
    body: `
      const needles = ${JSON.stringify([`${SECRET}-hdr`, `${SECRET}-url`].map((n) => Array.from(n, (c) => c.charCodeAt(0))))};
      const has = (u8) => needles.every((n) => {
        outer: for (let i = 0; i + n.length <= u8.length; i++) {
          for (let j = 0; j < n.length; j++) if (u8[i + j] !== n[j]) continue outer;
          return true;
        }
        return false;
      });
      const got = {};
      const types = ['', 'json', 'arraybuffer', 'blob', 'document', 'stream'];
      const done = () => {
        if (Object.keys(got).length === types.length) document.body.dataset.got = JSON.stringify(got);
      };
      for (const rt of types) {
        GM_xmlhttpRequest({
          url: ${JSON.stringify(`${fixtureServer.baseUrl}/__echo?q=${SECRET}-url`)},
          headers: { 'X-Secret': ${JSON.stringify(`${SECRET}-hdr`)} },
          responseType: rt,
          onprogress: () => {},
          onload: async (r) => {
            let ok;
            const text = (t) => t.includes(${JSON.stringify(`${SECRET}-hdr`)}) && t.includes(${JSON.stringify(`${SECRET}-url`)});
            if (rt === '') ok = text(r.responseText);
            else if (rt === 'json') ok = r.response.headers['x-secret'] === ${JSON.stringify(`${SECRET}-hdr`)};
            else if (rt === 'arraybuffer') ok = has(new Uint8Array(r.response));
            else if (rt === 'blob') ok = has(new Uint8Array(await r.response.arrayBuffer()));
            else if (rt === 'document') ok = text(r.response.body.textContent);
            else ok = has(new Uint8Array(await new Response(r.response).arrayBuffer()));
            got[rt || 'text'] = ok;
            done();
          },
        });
      }
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
  // The script got every response whole.
  await expect.poll(async () => JSON.parse(await page.locator('body').getAttribute('data-got') ?? '{}'), { timeout: 15_000 })
    .toEqual({ text: true, json: true, arraybuffer: true, blob: true, document: true, stream: true });
  const { calls, seen } = await page.evaluate(() => {
    const w = window as unknown as { __calls: number; __seen: string[] };
    return { calls: w.__calls, seen: w.__seen };
  });
  // The hooks ran (the page's own code and the script's use them).
  expect(calls).toBeGreaterThan(0);
  expect(seen).toEqual([]);
  await page.close();
});

let scriptsDir: ScriptsDir;
test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
test.afterEach(() => { scriptsDir.cleanup(); });
