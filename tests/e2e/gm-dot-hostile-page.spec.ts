// The Promise a `GM.` call returns, against a page that hooks what
// resolving one passes through: an `Object.prototype.then` getter
// (resolving with an object reads `then`) and `Promise.prototype.then`.
// Neither should see a stored value the script reads with GM.getValue
// or GM.listValues (docs/GM-APIs.md, "GM4 alias namespace").

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const SECRET = 'gm-dot-secret-7b2e';

// Runs first in the page's <head>. Keeps each object it's handed that
// carries the secret in `window.__seen`, as JSON.
const HOOKS = `
(function () {
  var seen = window.__seen = [];
  var R = Reflect.apply, stringify = JSON.stringify, indexOf = String.prototype.indexOf;
  var note = function (v) {
    try {
      var t = v && typeof v === 'object' ? R(stringify, JSON, [v]) : '';
      if (t && R(indexOf, t, [${JSON.stringify(SECRET)}]) !== -1) seen[seen.length] = t;
    } catch (e) {}
  };
  Object.defineProperty(Object.prototype, 'then', {
    configurable: true, get: function () { note(this); return undefined; },
  });
  var PT = Promise.prototype.then;
  Promise.prototype.then = function (a, b) {
    return R(PT, this, [function (v) { note(v); return typeof a === 'function' ? a(v) : v; }, b]);
  };
})();
`;

test.describe('GM. Promises on a hostile page', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('GM.getValue / GM.listValues results reach the script, not the page', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const url = `${fixtureServer.baseUrl}/hostile-gm-dot.html`;
    scriptsDir.write({
      relativePath: 'reader.user.js',
      meta: {
        name: 'Reader',
        match: [url],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_listValues'],
      },
      body: `
        GM_setValue('k', { secret: ${JSON.stringify(SECRET)}, list: [${JSON.stringify(SECRET)}] });
        (async () => {
          const awaited = await GM.getValue('k');
          const viaThen = await new Promise((ok) => GM.getValue('k').then(ok));
          const keys = await GM.listValues();
          // The added \`then\` stays out of what the script reads.
          document.body.dataset.got = [
            awaited.secret === ${JSON.stringify(SECRET)},
            viaThen === awaited,
            keys.length === 1 && keys[0] === 'k',
            Object.keys(awaited).join('+'),
          ].join(',');
        })();
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
    await expect(page.locator('body')).toHaveAttribute('data-got', 'true,true,true,secret+list');
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([]);
    await page.close();
  });
});
