// Two tabs writing the same GM value keys at once end up agreeing with
// the worker (docs/GM-APIs-storage.md, "Ordering writes").
//
// Each write gets a sequence number from the worker, and a tab holds a
// broadcast for a key it has a write of its own out for until that
// write is answered. Without that, a tab's own delete could be undone
// in its cache by another tab's older write arriving later, and the
// tabs drifted apart for good (seen on A.C.A.S, GreasyFork 459137).

import { expect, test } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM value ordering across tabs', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('tabs churning the same keys converge on the worker\'s values', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Until the deadline in the URL, set and delete a handful of keys at
    // random, a few at a time; a while after it, report the whole cache.
    scriptsDir.write({
      relativePath: 'churn.user.js',
      meta: {
        name: 'Churn',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues'],
      },
      body: `
        const until = Number(new URLSearchParams(location.search).get('until'));
        const tab = new URLSearchParams(location.search).get('tab');
        let n = 0;
        const step = () => {
          if (Date.now() >= until) return;
          const ops = 1 + Math.floor(Math.random() * 3);
          for (let i = 0; i < ops; i++) {
            const key = 'k' + Math.floor(Math.random() * 4);
            if (Math.random() < 0.4) GM_deleteValue(key);
            else GM_setValue(key, tab + ':' + (n++));
          }
          setTimeout(step, Math.floor(Math.random() * 4));
        };
        step();
        setTimeout(() => {
          const out = {};
          for (const k of GM_listValues().sort()) out[k] = GM_getValue(k);
          document.body.dataset.smFinal = JSON.stringify(out);
        }, until - Date.now() + 1500);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = (await sm.getCollections()).flatMap((c) => c.scriptIds)[0];

    const until = Date.now() + 3000;
    const pages = await Promise.all(['a', 'b'].map(async (tab) => {
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html?tab=${tab}&until=${until}`);
      return page;
    }));
    const finals = await Promise.all(pages.map(async (page) => {
      await expect(page.locator('body')).toHaveAttribute('data-sm-final', /\{/, { timeout: 15_000 });
      return JSON.parse((await page.locator('body').getAttribute('data-sm-final'))!);
    }));
    const stored = await sm.getGmValues(id);
    const sorted = Object.fromEntries(Object.keys(stored).sort().map((k) => [k, stored[k]]));
    expect(finals[0]).toEqual(sorted);
    expect(finals[1]).toEqual(sorted);
    await Promise.all(pages.map((page) => page.close()));
  });
});
