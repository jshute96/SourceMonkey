// End-to-end badge state: matching → green, error → red, post-update
// stale → purple, source disabled → empty. Exercises the real
// chrome.action surface, the chrome.webNavigation listener, and the
// vm:start / vm:error pipeline from injected wrappers back to the SW.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, type TabStateSnapshot } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const ORANGE = '#f57c00';
const RED = '#d32f2f';
const PURPLE = '#d500f9';

function hasColor(snapshot: TabStateSnapshot, hex: string): boolean {
  // chrome.action.getBadgeBackgroundColor returns [r, g, b, a].
  if (!Array.isArray(snapshot.badgeColor)) return false;
  const [r, g, b] = snapshot.badgeColor as number[];
  const expectedR = parseInt(hex.slice(1, 3), 16);
  const expectedG = parseInt(hex.slice(3, 5), 16);
  const expectedB = parseInt(hex.slice(5, 7), 16);
  return r === expectedR && g === expectedG && b === expectedB;
}

// `chrome.tabs.Tab.id` is the same numeric ID Chrome uses for tabId in
// the action APIs. Playwright doesn't expose it directly on Page, so we
// query the SW for the active tab right after opening the page.
async function activeTabId(getServiceWorker: () => Promise<import('@playwright/test').Worker>): Promise<number> {
  const sw = await getServiceWorker();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab');
    return tab.id;
  });
}

test.describe('badge', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('green + count=1 for one matching script', async ({
    extensionContext, fixtureServer, vm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'hello';`,
    });
    await vm.addSource(scriptsDir.path);
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const snap = await waitForTabState(vm, tabId, (s) => s.badgeText === '1' && hasColor(s, GREEN), 'badge green=1');
    expect(snap.badgeText).toBe('1');
    expect(snap.title).toContain('Hello | OK');
    await page.close();
  });

  test('red for a script that throws on activation', async ({
    extensionContext, fixtureServer, vm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'boom.user.js',
      meta: { name: 'Boom', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `throw new Error('intentional test failure');`,
    });
    await vm.addSource(scriptsDir.path);
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const snap = await waitForTabState(vm, tabId, (s) => hasColor(s, RED), 'badge red');
    expect(snap.title).toContain('Boom | ERROR');
    await page.close();
  });

  test('purple/RELOAD after script body changes on disk', async ({
    extensionContext, fixtureServer, vm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: { name: 'Live', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'v1';`,
    });
    const added = await vm.addSource(scriptsDir.path);
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(vm, tabId, (s) => s.badgeText === '1' && hasColor(s, GREEN), 'initial green');

    // Simulate an external edit: rewrite the file body, then trigger a
    // manual refresh through the updater. The SW's storage.onChanged
    // listener should fire markScriptStale for this tab.
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2';`);
    await vm.updateSource(added!.id, 'manual');

    const snap = await waitForTabState(vm, tabId, (s) => hasColor(s, PURPLE), 'purple after update');
    expect(snap.title).toContain('Live | Reload to update');

    // Reload the page → new wrapper runs the fresh body → back to green.
    // syncNow before reload so chrome.userScripts is registered with
    // the v2 body before navigation; otherwise the debounced sync that
    // updateSource scheduled may not have run yet, and the reload would
    // re-inject v1.
    await vm.syncNow();
    await page.reload();
    await expect(page).toHaveTitle('v2');
    await waitForTabState(vm, tabId, (s) => hasColor(s, GREEN), 'green after reload');
    await page.close();
  });

  test('empty badge when source is disabled', async ({
    extensionContext, fixtureServer, vm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: ``,
    });
    const added = await vm.addSource(scriptsDir.path);
    await vm.setSourceEnabled(added!.id, false);
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    // Badge stays empty since no scripts match.
    const snap = await waitForTabState(vm, tabId, (s) => s.badgeText === '', 'empty badge');
    expect(snap.badgeText).toBe('');
    await page.close();
  });

  test('orange/MISSING when matcher expects a script the wrapper never reported', async ({
    extensionContext, fixtureServer, vm, getServiceWorker,
  }) => {
    // A MAIN-world script with no @grant runs in MAIN world; it cannot
    // call chrome.runtime.sendMessage so the bridge forwards via
    // postMessage. To produce a genuine MISSING (expected ∪ ¬actual)
    // without going through the bridge, register a USER_SCRIPT-world
    // script that bails before sending vm:start. The wrapper's vm:start
    // is sent synchronously at activation, so we instead arrange for
    // the script to be EXPECTED but never injected: register a real
    // script, then unregister it from chrome.userScripts directly while
    // leaving the storage row in place. The match index still sees it.
    scriptsDir.write({
      relativePath: 'ghost.user.js',
      meta: { name: 'Ghost', match: [`${fixtureServer.baseUrl}/*`], grant: ['unsafeWindow'], runAt: 'document-end' },
      body: ``,
    });
    await vm.addSource(scriptsDir.path);
    await vm.syncNow();
    // Drop the script from chrome.userScripts so it's expected but
    // never actually runs.
    const sw = await getServiceWorker();
    await sw.evaluate(async () => {
      const all = await chrome.userScripts.getScripts();
      const ids = all.filter((s) => s.id !== 'vibemonkey-bridge').map((s) => s.id);
      if (ids.length > 0) await chrome.userScripts.unregister({ ids });
    });

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);

    const snap = await waitForTabState(vm, tabId, (s) => hasColor(s, ORANGE), 'orange MISSING');
    expect(snap.title).toContain('Ghost | MISSING');
    await page.close();
  });
});
