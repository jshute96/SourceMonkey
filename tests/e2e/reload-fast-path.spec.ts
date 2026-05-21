// Reload fast-path: when the user explicitly clicks reload on a tab
// with matching userscripts, an edit-on-disk that landed before the
// reload should take effect on THIS navigation rather than requiring a
// second reload. Documented in docs/injection.md#reload-fast-path.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState, type TabStateSnapshot } from '../fixtures/sw-api';

const GREEN = '#2e7d32';

function hasColor(snapshot: TabStateSnapshot, hex: string): boolean {
  if (!Array.isArray(snapshot.badgeColor)) return false;
  const [r, g, b] = snapshot.badgeColor as number[];
  return (
    r === parseInt(hex.slice(1, 3), 16) &&
    g === parseInt(hex.slice(3, 5), 16) &&
    b === parseInt(hex.slice(5, 7), 16)
  );
}

async function activeTabId(getServiceWorker: () => Promise<import('@playwright/test').Worker>): Promise<number> {
  const sw = await getServiceWorker();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab');
    return tab.id;
  });
}

test.describe('reload fast-path', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('reload picks up edited body on the same reload click', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The script writes to document.title at document-end. The body's
    // value is the assertion target — we never touch document.title
    // from the page itself, so any title change is the wrapper.
    scriptsDir.write({
      relativePath: 'live.user.js',
      // injectInto:'content' forces USER_SCRIPT world. The fast-path
      // needs chrome.runtime.sendMessage to be callable from the
      // wrapper, which is only true in USER_SCRIPT — MAIN-world scripts
      // (the default for `@grant none`) short-circuit past
      // sm:check-pending and never benefit from the fast-path. See
      // docs/injection.md#caveats.
      meta: { name: 'Live', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', injectInto: 'content' },
      body: `document.title = 'v1';`,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasColor(s, GREEN), 'initial v1 green');

    // Edit the file on disk. Crucially: do NOT call updateSource. The
    // whole point is that the reload itself discovers the update.
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2';`);

    // page.reload() sets transitionType=reload on the resulting
    // webNavigation.onCommitted, which is what the fast-path keys on.
    await page.reload();
    // If the fast-path worked, the wrapper eval'd v2 directly. The page
    // title settles within the navigation's load.
    await expect(page).toHaveTitle('v2');
    // Badge stays green: sm:swapped is treated as 'started' and the
    // wrapper just ran the LATEST stored content, so clearScriptStale
    // keeps the row non-stale.
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasColor(s, GREEN),
      'green after reload swap',
    );
    await page.close();
  });

  test('reload with no on-disk change runs the baked-in body (no spurious swap)', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Sanity guard for the common reload case: when the file hasn't
    // changed, the fast-path's refresh detects no update and replies
    // {action:'run'}. The wrapper proceeds with its baked-in body and
    // everything looks identical to a normal navigation.
    scriptsDir.write({
      relativePath: 'stable.user.js',
      meta: { name: 'Stable', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'same';`,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('same');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasColor(s, GREEN), 'initial green');

    await page.reload();
    await expect(page).toHaveTitle('same');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasColor(s, GREEN),
      'green after no-op reload',
    );
    await page.close();
  });

  test('MAIN-world script swaps via the postMessage bridge', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // No @grant and no injectInto → resolveWorld returns MAIN. Most
    // real-world userscripts hit this branch. The MAIN wrapper can't
    // call chrome.runtime.sendMessage directly, so sm:check-pending
    // round-trips through wrapper-bridge.js using a per-request nonce.
    // Without that bridge protocol the wrapper short-circuits past
    // check-pending entirely and the fast-path never engages, which
    // is what the user reported on example.com.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'MainWorld', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'v1';`,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasColor(s, GREEN), 'initial v1 green');

    scriptsDir.rewriteBody('main.user.js', `document.title = 'v2';`);
    await page.reload();
    // If the bridge protocol works, MAIN wrapper got run-new and
    // eval'd the new body in this navigation.
    await expect(page).toHaveTitle('v2');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasColor(s, GREEN),
      'green after MAIN-world swap',
    );
    await page.close();
  });

  test('non-reload navigation does not trigger the swap path', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Navigating to a fresh URL (not a reload) should NOT swap, even
    // if the file on disk has changed since registration. The user
    // edited the file but didn't click reload — opportunistic refresh
    // will still fire, but the wrapper that's about to run gets the
    // baked-in body. This guards against the fast-path leaking onto
    // first-visit navigations.
    scriptsDir.write({
      relativePath: 'nav.user.js',
      meta: { name: 'Nav', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = (document.title || '') + '-baked';`,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle(/-baked$/);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasColor(s, GREEN), 'first-visit green');

    // Edit on disk, then navigate (not reload) to a different page on
    // the same origin. The new page's first injection should still run
    // the baked-in body — the on-disk change is only consumed when the
    // user explicitly reloads.
    scriptsDir.rewriteBody('nav.user.js', `document.title = (document.title || '') + '-NEW';`);
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    // Title contains '-baked' because the baked body ran; not '-NEW'.
    await expect(page).toHaveTitle(/-baked$/);
    await page.close();
  });
});
