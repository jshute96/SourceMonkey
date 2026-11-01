// Removing a script deletes its stored GM values (`gmval:` rows). A
// reinstall gets a new id, so nothing could ever reattach them.
//
// Pages already running the script when that happens keep their own
// copy of its values, each to itself. Deleting an installed script's
// values (the storage debug page's trash can) reaches its pages.

import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

type Sm = Parameters<Parameters<typeof test>[2]>[0]['sm'];

test.describe('GM values of removed scripts', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('uninstall, a refresh drop and collection removal delete the values', async ({ sm, getServiceWorker }) => {
    for (const name of ['a', 'b', 'c']) {
      scriptsDir.write({
        relativePath: `${name}.user.js`,
        meta: { name, match: ['https://example.com/*'], grant: ['GM_setValue'] },
        body: '',
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    const { scripts } = (await sm.getCollectionWithScripts(collection!.id))!;
    const idOf = (name: string) => scripts.find((s) => s.relativePath === `${name}.user.js`)!.id;
    const [a, b, c] = [idOf('a'), idOf('b'), idOf('c')];
    for (const id of [a, b, c]) await sm.writeGmValues(id, [{ key: 'k', value: id }]);
    await sm.gmValuesSaved();

    const sw = await getServiceWorker();
    // The script ids that still have a `gmval:` row on disk.
    const withValues = async () => (await sw.evaluate(async () =>
      Object.keys(await chrome.storage.local.get(null))
        .filter((k) => k.startsWith('gmval:'))
        .map((k) => k.split(':')[1]))).sort();
    expect(await withValues()).toEqual([a, b, c].sort());

    await sm.removeScript(a);
    expect(await withValues()).toEqual([b, c].sort());
    expect(await sm.getGmValues(a)).toEqual({});

    // `a`'s file goes too, as the delete-local-file dialog does, so the
    // refresh doesn't add it back.
    scriptsDir.remove('a.user.js');
    scriptsDir.remove('b.user.js');
    await sm.updateCollection(collection!.id, 'manual');
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts.map((s) => s.id)).toEqual([c]);
    expect(await withValues()).toEqual([c]);

    await sm.removeCollection(collection!.id);
    expect(await withValues()).toEqual([]);
  });

  // On a command from the test (`body[data-cmd]` and an `sm-cmd`
  // event), sets a value; then, and whenever a value changes, shows all
  // its values on `body[data-values]`.
  const VALUES_SCRIPT = `
    const show = () => {
      const out = {};
      for (const k of GM_listValues().sort()) out[k] = GM_getValue(k);
      document.body.dataset.values = JSON.stringify(out);
    };
    for (const k of ['a', 'b', 'c']) GM_addValueChangeListener(k, show);
    document.addEventListener('sm-cmd', () => {
      const [k, v] = document.body.dataset.cmd.split('=');
      if (k) GM_setValue(k, v);
      show();
    });
    show();
  `;

  // Long enough for a message to the worker and back.
  const SETTLE_MS = 300;

  const command = (page: Page, cmd: string) => page.evaluate((c) => {
    document.body.dataset.cmd = c;
    document.dispatchEvent(new Event('sm-cmd'));
  }, cmd);
  const shown = (page: Page) => expect(page.locator('body'));

  // The page's own world (the default) or the extension's isolated
  // one (`@sandbox DOM`): their messages reach the worker by different
  // routes.
  const WORLDS = { MAIN: [], USER_SCRIPT: ['// @sandbox DOM'] } as const;

  async function twoTabs(
    { sm, extensionContext, baseUrl }: { sm: Sm; extensionContext: BrowserContext; baseUrl: string },
    extra: readonly string[] = [],
  ): Promise<{ id: string; tabs: Page[] }> {
    scriptsDir.write({
      relativePath: 'v.user.js',
      meta: {
        name: 'Values', match: [`${baseUrl}/*`], runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_listValues', 'GM_addValueChangeListener'],
        extra: [...extra],
      },
      body: VALUES_SCRIPT,
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await sm.writeGmValues(id, [{ key: 'a', value: '1' }]);
    await sm.gmValuesSaved();
    const tabs: Page[] = [];
    for (let i = 0; i < 2; i++) {
      const tab = await extensionContext.newPage();
      await tab.goto(`${baseUrl}/target.html`);
      await shown(tab).toHaveAttribute('data-values', '{"a":"1"}');
      tabs.push(tab);
    }
    return { id, tabs };
  }

  for (const [world, extra] of Object.entries(WORLDS)) {
    test(`pages still running an uninstalled script keep its values, each to itself (${world})`, async ({
      sm, extensionContext, fixtureServer, getServiceWorker,
    }) => {
      const { id, tabs: [p1, p2] } = await twoTabs({ sm, extensionContext, baseUrl: fixtureServer.baseUrl }, extra);
      const sw = await getServiceWorker();
      const stored = () => sw.evaluate(async () =>
        Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('gmval:')));

      await sm.removeScript(id);
      await sm.syncNow();
      expect(await stored()).toEqual([]);

      // Each page still has the values it had, and its own writes, but
      // not the other page's.
      await command(p1, 'b=2');
      await shown(p1).toHaveAttribute('data-values', '{"a":"1","b":"2"}');
      await command(p2, 'c=3');
      await shown(p2).toHaveAttribute('data-values', '{"a":"1","c":"3"}');
      // What's checked here is that nothing more happens: give the writes
      // time to reach the worker, and a broadcast time to come back.
      await p1.waitForTimeout(SETTLE_MS);
      await command(p1, '');
      await shown(p1).toHaveAttribute('data-values', '{"a":"1","b":"2"}');

      // A resync (as after a worker restart) doesn't empty them.
      await sm.nudgeGmResync();
      await p1.waitForTimeout(SETTLE_MS);
      await command(p1, '');
      await command(p2, '');
      await shown(p1).toHaveAttribute('data-values', '{"a":"1","b":"2"}');
      await shown(p2).toHaveAttribute('data-values', '{"a":"1","c":"3"}');

      // Nothing was saved.
      await sm.gmValuesSaved();
      expect(await stored()).toEqual([]);
      expect(await sm.getGmValues(id)).toEqual({});
    });
  }

  test('deleting an installed script\'s values reaches every page running it', async ({
    sm, extensionContext, fixtureServer,
  }) => {
    const { id, tabs: [p1, p2] } = await twoTabs({ sm, extensionContext, baseUrl: fixtureServer.baseUrl });
    await command(p1, 'b=2');
    await shown(p2).toHaveAttribute('data-values', '{"a":"1","b":"2"}');

    await sm.clearScriptValues(id);
    for (const p of [p1, p2]) {
      await command(p, '');
      await shown(p).toHaveAttribute('data-values', '{}');
    }
    // And the pages go on sharing values as before.
    await command(p1, 'c=3');
    await shown(p2).toHaveAttribute('data-values', '{"c":"3"}');
  });
});
