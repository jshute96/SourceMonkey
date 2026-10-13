// End-to-end coverage for GM_registerMenuCommand / GM_unregisterMenuCommand.
//
// The SW exposes two test helpers in `self.SourceMonkey` (named for the
// context menu the popup replaced):
//   - getActionContextMenu(tabId) — returns the (scriptId, commands[])
//     groups the tab has registered, which the popup lists.
//   - fireActionContextMenuItem(tabId, scriptId, commandId) — sends the
//     same `sm:gm-menu-fire` message a click in the popup does.
// The popup page itself is covered by tests/e2e/popup.spec.ts.
//
// USER_SCRIPT vs MAIN world: page.evaluate runs in MAIN, GM_* bindings
// live in USER_SCRIPT. The two worlds share the DOM but not window
// globals — userscripts surface state via `document.body.dataset.*`
// and accept test signals via DOM events on pre-created elements.

import type { BrowserContext, Page, Worker } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor, waitForTabState, type SmApi, activeTabId } from '../fixtures/sw-api';

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
    await sm.addCollection(scriptsDir.path);
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
      // The name carries the path so the assertions below can tell
      // WHICH document a command came from. A fixed name would make
      // the post-navigation state identical to the pre-navigation one,
      // and the test would pass just as well if the commands had
      // simply been carried over and never re-registered at all.
      body: `GM_registerMenuCommand('One ' + location.pathname, () => {});`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands[0]?.name === 'One /target.html',
      { label: 'first registration lands' },
    );

    // Navigate to a different page that the script also matches. The
    // SW clears the per-tab menu state on the fresh document, then the
    // new wrapper re-registers — and the new document's name is what
    // proves the second half of that actually happened.
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    // The name is in the PREDICATE, not just the assertion after it: a
    // carried-over command satisfies `commands.length === 1` the
    // instant we look, so waiting on the count would race the
    // re-registration and fail on a state that was about to be right.
    const afterNav = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands[0]?.name === 'One /other.html',
      { label: 'fresh document re-registers' },
    );
    expect(afterNav[0]!.commands[0]!.name).toBe('One /other.html');

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

  // The two cases where updateTabMatches must NOT touch the mirror.
  // Both are invisible to the fresh-document test above — an
  // unconditional wipe on every call would still pass it — so they get
  // their own coverage. Each waits on independent evidence that the SW
  // processed the event before reading the mirror; without that the
  // assertion could pass simply by running first.
  async function menuScriptOnTarget(
    extensionContext: BrowserContext,
    fixtureServer: { baseUrl: string },
    sm: SmApi,
    getServiceWorker: () => Promise<Worker>,
  ): Promise<{ page: Page; tabId: number }> {
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'MenuScript',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `GM_registerMenuCommand('One ' + location.pathname, () => {});`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands[0]?.name === 'One /target.html',
      { label: 'registration lands' },
    );
    return { page, tabId };
  }

  test('an in-document URL change keeps the menu state', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const { page, tabId } = await menuScriptOnTarget(extensionContext, fixtureServer, sm, getServiceWorker);

    // pushState keeps the document alive, so the wrapper's callbacks
    // are still there and nothing re-registers. Chrome reuses the
    // documentId, which is what the clear keys off.
    await page.evaluate(() => history.pushState({}, '', '/pushed.html'));
    await waitForTabState(
      sm, tabId,
      (s) => s.record?.byDoc[s.record.currentDocId]?.url.endsWith('/pushed.html') ?? false,
      'pushState reached the SW',
    );

    // Still the name the ORIGINAL load registered — proof the commands
    // were kept rather than cleared and re-registered.
    const after = await sm.getActionContextMenu(tabId);
    expect(after).toHaveLength(1);
    expect(after[0]!.commands[0]!.name).toBe('One /target.html');
    await page.close();
  });

  test('a script-set change re-evaluates the tab without clearing the menu state', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const { page, tabId } = await menuScriptOnTarget(extensionContext, fixtureServer, sm, getServiceWorker);

    // A second collection matching the same page changes the match
    // index, which sends `refreshAllOpenTabs` through updateTabMatches
    // for this already-loaded tab — trigger 'refresh', no documentId.
    // No navigation happened, so the mirror must survive.
    const other = ScriptsDir.create();
    try {
      other.write({
        relativePath: 'second.user.js',
        meta: { name: 'Second', match: [`${fixtureServer.baseUrl}/*`] },
        body: '',
      });
      await sm.addCollection(other.path);
      await sm.syncNow();

      // The tab's expected set growing is the refresh landing — it
      // comes from the same match-index walk, and needs no reload.
      await waitForTabState(
        sm, tabId,
        (s) => (s.record?.byDoc[s.record.currentDocId]?.matches.length ?? 0) === 2,
        'refresh re-evaluated the tab',
      );

      const after = await sm.getActionContextMenu(tabId);
      expect(after).toHaveLength(1);
      expect(after[0]!.commands[0]!.name).toBe('One /target.html');
    } finally {
      other.cleanup();
      await page.close();
    }
  });

  test('two scripts on the same page can share an explicit options.id without callback collisions', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Regression for the wrapper-side menu-command table: the GM runtime
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
    await sm.addCollection(scriptsDir.path);
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
    await sm.addCollection(scriptsDir.path);
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
    await sm.addCollection(scriptsDir.path);
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
