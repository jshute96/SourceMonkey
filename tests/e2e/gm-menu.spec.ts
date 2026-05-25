// End-to-end coverage for GM_registerMenuCommand / GM_unregisterMenuCommand.
//
// Playwright can't drive Chrome's action context menu directly, so the
// SW exposes two test helpers in `self.SourceMonkey`:
//   - getActionContextMenu(tabId) — returns the (scriptId, commands[])
//     groups we would have rendered for the tab.
//   - fireActionContextMenuItem(tabId, scriptId, commandId) — synthesizes
//     the chrome.contextMenus.onClicked dispatch by sending the same
//     `sm:gm-menu-fire` message the real click handler does.
//
// USER_SCRIPT vs MAIN world: page.evaluate runs in MAIN, GM_* bindings
// live in USER_SCRIPT. The two worlds share the DOM but not window
// globals — userscripts surface state via `document.body.dataset.*`
// and accept test signals via DOM events on pre-created elements.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor } from '../fixtures/sw-api';

async function activeTabId(
  getServiceWorker: () => Promise<import('@playwright/test').Worker>,
): Promise<number> {
  const sw = await getServiceWorker();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab');
    return tab.id;
  });
}

async function readFires(page: import('@playwright/test').Page): Promise<string[]> {
  const raw = await page.evaluate(() => document.body.dataset.smFires ?? '[]');
  return JSON.parse(raw) as string[];
}

test.describe('GM_registerMenuCommand', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('registered commands appear in the SW menu state, fire on synthetic click, then disappear on unregister', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'MenuScript',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand'],
      },
      body: `
        const fires = [];
        document.body.dataset.smFires = '[]';
        function recordFire(name) {
          fires.push(name);
          document.body.dataset.smFires = JSON.stringify(fires);
        }
        const id1 = GM_registerMenuCommand('Open settings', () => recordFire('open'));
        const id2 = GM_registerMenuCommand('Toggle thing', () => recordFire('toggle'));
        // Expose the unregister hook via a DOM button — DOM event
        // handlers fire in the world that added them, so this stays
        // in USER_SCRIPT world where GM_unregisterMenuCommand is bound.
        const btn = document.createElement('button');
        btn.id = 'sm-test-unregister-open';
        btn.addEventListener('click', () => { GM_unregisterMenuCommand(id1); });
        document.body.appendChild(btn);
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    // The wrapper sends sm:gm-menu-register asynchronously; poll the
    // SW state until both registrations have landed.
    const groups = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 2,
      { label: 'menu commands registered' },
    );
    expect(groups[0]!.commands.map((c) => c.name).sort()).toEqual(['Open settings', 'Toggle thing']);
    const scriptId = groups[0]!.scriptId;
    const openCmd = groups[0]!.commands.find((c) => c.name === 'Open settings')!;
    const toggleCmd = groups[0]!.commands.find((c) => c.name === 'Toggle thing')!;

    // Fire 'Open settings' via the SW test surface — equivalent to the
    // user clicking the indented entry in the real context menu.
    const fired1 = await sm.fireActionContextMenuItem(tabId, scriptId, openCmd.commandId);
    expect(fired1).toEqual({ ok: true });
    await expect.poll(() => readFires(page)).toEqual(['open']);

    // Fire 'Toggle thing' too.
    const fired2 = await sm.fireActionContextMenuItem(tabId, scriptId, toggleCmd.commandId);
    expect(fired2).toEqual({ ok: true });
    await expect.poll(() => readFires(page)).toEqual(['open', 'toggle']);

    // Unregister 'Open settings' via the in-page bridge button.
    await page.locator('#sm-test-unregister-open').click();
    const afterUnreg = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 1,
      { label: 'menu command unregistered' },
    );
    expect(afterUnreg[0]!.commands[0]!.name).toBe('Toggle thing');

    // Firing the unregistered id now returns ok:false from the SW —
    // a clicked-but-stale menu item should never reach the wrapper.
    const ghost = await sm.fireActionContextMenuItem(tabId, scriptId, openCmd.commandId);
    expect(ghost.ok).toBe(false);

    await page.close();
  });

  test('navigating to a fresh document clears the SW menu state', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'MenuScript',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `GM_registerMenuCommand('One', () => {});`,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 1,
      { label: 'first registration lands' },
    );

    // Navigate to a different page that the script also matches. The
    // SW clears the per-tab menu state on the fresh document, then the
    // new wrapper re-registers.
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    const afterNav = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 1,
      { label: 'fresh document re-registers' },
    );
    expect(afterNav[0]!.commands[0]!.name).toBe('One');

    // Navigate to about:blank — the script doesn't run there. The
    // non-injectable-scheme branch of updateTabMatches explicitly calls
    // clearMenuCommandsForTab(tabId), so the per-tab menu state is
    // wiped before the empty-state badge renders.
    await page.goto('about:blank');
    const afterAway = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 0,
      { label: 'menu cleared on non-matching navigation' },
    );
    expect(afterAway).toEqual([]);

    await page.close();
  });

  test('two scripts on the same page can share an explicit options.id without callback collisions', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Regression for the wrapper-side menu-command table: `__SM_GM__`
    // is a per-document singleton shared across every userscript on
    // the page, so a single-key map (commandId only) would let script
    // B clobber script A's callback for the same explicit id.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ScriptA',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `
        GM_registerMenuCommand('A label', () => {
          document.body.dataset.smCollideA = (document.body.dataset.smCollideA || '') + 'A';
        }, { id: 'shared' });
      `,
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: {
        name: 'ScriptB',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `
        GM_registerMenuCommand('B label', () => {
          document.body.dataset.smCollideB = (document.body.dataset.smCollideB || '') + 'B';
        }, { id: 'shared' });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    // SW state: both scripts namespace under their own scriptId, so
    // we expect two groups each with one command.
    const groups = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 2 && g.every((s) => s.commands.length === 1),
      { label: 'both scripts register' },
    );
    const scriptA = groups.find((g) => g.commands[0]!.name === 'A label')!;
    const scriptB = groups.find((g) => g.commands[0]!.name === 'B label')!;
    expect(scriptA).toBeTruthy();
    expect(scriptB).toBeTruthy();

    // Fire both. Each script's callback bumps its OWN dataset key.
    // With the buggy single-key map both fires would route to whichever
    // script registered last and only one key would change.
    expect(await sm.fireActionContextMenuItem(tabId, scriptA.scriptId, 'shared')).toEqual({ ok: true });
    expect(await sm.fireActionContextMenuItem(tabId, scriptB.scriptId, 'shared')).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(() => document.body.dataset.smCollideA ?? '')).toBe('A');
    await expect.poll(() => page.evaluate(() => document.body.dataset.smCollideB ?? '')).toBe('B');

    await page.close();
  });

  test('a callback that throws is logged but does not break sibling fires', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'MenuScript',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `
        document.body.dataset.smHits = '';
        GM_registerMenuCommand('Boom', () => {
          document.body.dataset.smHits = (document.body.dataset.smHits || '') + '!';
          throw new Error('callback boom');
        });
        GM_registerMenuCommand('Quiet', () => {
          document.body.dataset.smHits = (document.body.dataset.smHits || '') + 'Q';
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const groups = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 2,
      { label: 'both commands registered' },
    );
    const scriptId = groups[0]!.scriptId;
    const boom = groups[0]!.commands.find((c) => c.name === 'Boom')!;
    const quiet = groups[0]!.commands.find((c) => c.name === 'Quiet')!;

    // Fire the throwing callback. The wrapper's try/catch swallows the
    // throw and console.errors it. The dispatch promise still resolves
    // ok:true — we only care that this doesn't poison subsequent fires.
    expect(await sm.fireActionContextMenuItem(tabId, scriptId, boom.commandId)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(() => document.body.dataset.smHits ?? '')).toBe('!');

    // Sibling command still works after the throw.
    expect(await sm.fireActionContextMenuItem(tabId, scriptId, quiet.commandId)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(() => document.body.dataset.smHits ?? '')).toBe('!Q');

    await page.close();
  });

  test('GM_registerMenuCommand with options.id updates the existing entry', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'MenuScript',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `
        const id1 = GM_registerMenuCommand('Original', () => {}, { id: 'stable' });
        const id2 = GM_registerMenuCommand('Renamed',  () => {}, { id: 'stable' });
        document.body.dataset.smIds = JSON.stringify([id1, id2]);
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const groups = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 1,
      { label: 'second register overwrites first' },
    );
    expect(groups[0]!.commands[0]!.name).toBe('Renamed');
    expect(groups[0]!.commands[0]!.commandId).toBe('stable');

    const idsRaw = await page.evaluate(() => document.body.dataset.smIds ?? '[]');
    expect(JSON.parse(idsRaw)).toEqual(['stable', 'stable']);

    await page.close();
  });
});
