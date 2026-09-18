// Reload fast-path: when the user explicitly clicks reload on a tab
// with matching userscripts, an edit-on-disk that landed before the
// reload should take effect on THIS navigation rather than requiring a
// second reload. Documented in docs/injection.md#reload-fast-path.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';
import { waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const PURPLE = '#d500f9';

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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial v1 green');

    // Edit the file on disk. Crucially: do NOT call updateCollection. The
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
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN),
      'green after reload swap',
    );
    await page.close();
  });

  test('a successful swap flashes the badge purple, then returns to green', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The swap itself is invisible — the page just works — so the badge
    // blinks purple while it lands. Purple that STAYS up keeps its old
    // meaning ("reload again"); this test pins the transient one.
    scriptsDir.write({
      relativePath: 'flash.user.js',
      meta: { name: 'Flash', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', injectInto: 'content' },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial v1 green');

    scriptsDir.rewriteBody('flash.user.js', `document.title = 'v2';`);

    // Not awaited before the poll: the flash is time-boxed from the
    // swap decision, and waiting for the load event first would spend
    // part of that window.
    const navigated = page.reload();
    // The tooltip separates the two purples: a swap that MISSED its
    // window also paints purple, but as a stale `Reload to update`
    // row. Asserting its absence keeps a missed window failing here
    // rather than passing this wait and failing the title check.
    await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, PURPLE) && !s.title.includes('Reload to update'),
      'purple while the swap lands',
    );
    await navigated;
    await expect(page).toHaveTitle('v2');
    // Comes back down on its own — nothing here reloads again.
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN),
      'green once the flash ends',
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('same');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial green');

    await page.reload();
    await expect(page).toHaveTitle('same');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN),
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial v1 green');

    scriptsDir.rewriteBody('main.user.js', `document.title = 'v2';`);
    await page.reload();
    // If the bridge protocol works, MAIN wrapper got run-new and
    // eval'd the new body in this navigation.
    await expect(page).toHaveTitle('v2');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN),
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle(/-baked$/);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'first-visit green');

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

  test('reload swap of a @require-using script keeps the require bodies in scope', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Regression: the fast-path's `run-new` payload used to ship only
    // `bodyText`, so the wrapper's eval ran the new body without the
    // prepended `@require` collection — any reference to a require-set-up
    // global threw ReferenceError on the swap and only "worked" on the
    // next reload (because by then chrome.userScripts had re-registered
    // the script with the requires baked into the body again).
    //
    // The require defines a function the main body invokes. If the
    // swap payload includes the require prelude, document.title gets
    // set to the function's return value; if it doesn't, the body
    // throws and the page keeps its prior title.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      'function __SM_REQ_FN(){ return "swapped-v2"; }',
    );
    scriptsDir.write({
      relativePath: 'reqswap.user.js',
      meta: {
        name: 'ReqSwap',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        // USER_SCRIPT world so the wrapper can talk to the SW
        // directly. Same reason the earlier reload-fast-path tests
        // use injectInto:'content'.
        injectInto: 'content',
        extra: ['// @require     lib.js'],
      },
      body: `document.title = 'v1-' + __SM_REQ_FN();`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1-swapped-v2');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial green');

    // Edit the main body. The require is untouched.
    scriptsDir.rewriteBody('reqswap.user.js', `document.title = 'v2-' + __SM_REQ_FN();`);

    await page.reload();
    // If run-new includes the require prelude, the swap eval sees
    // __SM_REQ_FN and the title updates. If it doesn't, the wrapper
    // throws ReferenceError and the title stays 'v1-swapped-v2'.
    await expect(page).toHaveTitle('v2-swapped-v2');
    await page.close();
  });

  test('reload swap keeps a @require\'s top-level const/class in scope', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The sibling test above uses `function __SM_REQ_FN`, which is the
    // easy case: a top-level `function` in a standalone script becomes
    // a property of globalThis, so it survived even when requires were
    // injected as separate scripts.
    //
    // `const` and `class` are script-scoped and don't. They only reach
    // the body because the swap payload concatenates requires into it
    // — the same arrangement a fresh registration uses, now that both
    // paths share composeSource. This is what would break if the
    // swap path ever diverged again.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      [
        'const REQ_CONST = "const-ok";',
        'class ReqClass { tag() { return "class-ok"; } }',
      ].join('\n'),
    );
    scriptsDir.write({
      relativePath: 'lexswap.user.js',
      meta: {
        name: 'LexSwap',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        injectInto: 'content',
        extra: ['// @require     lib.js'],
      },
      body: `document.title = 'v1-' + REQ_CONST + '-' + new ReqClass().tag();`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1-const-ok-class-ok');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial green');

    scriptsDir.rewriteBody('lexswap.user.js', `document.title = 'v2-' + REQ_CONST + '-' + new ReqClass().tag();`);

    await page.reload();
    // A swap that dropped the require prelude would ReferenceError on
    // REQ_CONST and leave the v1 title in place.
    await expect(page).toHaveTitle('v2-const-ok-class-ok');
    await page.close();
  });

  test('storage-granting script swaps with its stored values intact', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The swap eval runs at runMain's function scope, so the emitted
    // gm prelude — which is spliced INSIDE the main-body wrap function
    // and holds `storage.init` — never runs on this path. The prelude
    // compensates by calling `storage.init` itself from the `gmValues`
    // the SW attaches to the run-new reply.
    //
    // The assertion that matters is the value, not just the body: a
    // swap that ran without the init would read the default ('init')
    // instead of what the first load stored, and a read-modify-write
    // script would then overwrite the user's real data.
    scriptsDir.write({
      relativePath: 'store.user.js',
      meta: {
        name: 'Store',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        const prev = GM_getValue('marker', 'init');
        document.title = 'v1:' + prev;
        GM_setValue('marker', 'v1');
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1:init');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN), 'initial green');

    scriptsDir.rewriteBody('store.user.js', `
      const prev = GM_getValue('marker', 'init');
      document.title = 'v2:' + prev;
      GM_setValue('marker', 'v2');
    `);

    await page.reload();
    // 'v2' — the new body ran on THIS reload. ':v1' — it saw the value
    // the previous load stored, so the cache was seeded. 'v1:v1' would
    // mean no swap; 'v2:init' would mean a swap with an empty cache.
    await expect(page).toHaveTitle('v2:v1');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN),
      'green after storage swap',
    );
    await page.close();
  });

  test('a refresh that ADDS a storage grant still seeds the swapped body', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The wrapper's own `needsValues` request flag describes the
    // REGISTERED grant set, so this script asks for no snapshot. The
    // SW has to notice that the NEW row grants storage and load one
    // anyway — otherwise the swapped body's GM_getValue reads an empty
    // cache.
    //
    // `injectInto: 'content'` on both versions keeps the world fixed
    // at USER_SCRIPT. Without it, adding the first real grant would
    // also move the script MAIN → USER_SCRIPT, and the SW defers the
    // swap for a world change (the running wrapper can't move).
    const meta = {
      name: 'GrantAdd',
      match: [`${fixtureServer.baseUrl}/*`],
      runAt: 'document-end' as const,
      injectInto: 'content' as const,
    };
    // A sibling that always grants storage, so the shared `__SM_GM__`
    // runtime stays registered in USER_SCRIPT world for every version
    // below. The runtime follows the scripts that need it, and the SW
    // defers a swap whose body would land on a document without it —
    // a real behavior, but not the one under test here.
    scriptsDir.write({
      relativePath: 'keeps-runtime.user.js',
      meta: {
        name: 'KeepsRuntime',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end' as const,
        injectInto: 'content' as const,
        grant: ['GM_setValue'],
      },
      body: 'void 0;',
    });
    scriptsDir.write({
      relativePath: 'grantadd.user.js',
      meta: { ...meta, grant: ['GM_setValue', 'GM_getValue'] },
      body: `document.title = 'v1:' + GM_getValue('marker', 'init'); GM_setValue('marker', 'stored');`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1:init');

    // Now drop the grants and reload, so the REGISTERED copy is a
    // non-storage script...
    scriptsDir.write({
      relativePath: 'grantadd.user.js',
      meta,
      body: `document.title = 'v2:no-grants';`,
    });
    await page.reload();
    await expect(page).toHaveTitle('v2:no-grants');
    // Let that reload's own storage write finish re-registering before
    // the next one starts. `syncRegistrations` unregisters everything
    // and then registers it back, so a document created inside that
    // window gets no userscripts at all — which failed this test with
    // the page's own title rather than any version of the script. The
    // wait is about the PRECONDITION; what the third reload asserts is
    // still that the fast path picks up an edit with no explicit sync.
    await sm.syncNow();

    // ...then add the grants back. This reload's wrapper sends
    // needsValues:false; the swapped body needs a snapshot regardless.
    scriptsDir.write({
      relativePath: 'grantadd.user.js',
      meta: { ...meta, grant: ['GM_setValue', 'GM_getValue'] },
      body: `document.title = 'v3:' + GM_getValue('marker', 'init');`,
    });
    await page.reload();
    // 'v3:stored' — swapped AND seeded from what v1 wrote. 'v3:init'
    // would mean the SW shipped the body without a snapshot.
    await expect(page).toHaveTitle('v3:stored');
    await page.close();
  });

  test('a refresh that REMOVES the storage grant still swaps', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Mirror of the case above: the wrapper asks for a snapshot (its
    // registered copy grants storage) but the new body has no storage
    // bindings to seed. Nothing to init, and the swap must not be
    // blocked by the stale request flag.
    const meta = {
      name: 'GrantDrop',
      match: [`${fixtureServer.baseUrl}/*`],
      runAt: 'document-end' as const,
      injectInto: 'content' as const,
    };
    scriptsDir.write({
      relativePath: 'grantdrop.user.js',
      meta: { ...meta, grant: ['GM_setValue', 'GM_getValue'] },
      body: `document.title = 'v1:' + GM_getValue('marker', 'init');`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1:init');

    scriptsDir.write({
      relativePath: 'grantdrop.user.js',
      meta,
      body: `document.title = 'v2:no-storage';`,
    });
    await page.reload();
    await expect(page).toHaveTitle('v2:no-storage');
    await page.close();
  });

  test('a refresh that changes injection world defers to the next reload', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Adding a script's first real @grant moves it MAIN → USER_SCRIPT.
    // The wrapper Chrome already injected can't move, and the new
    // body's bindings dereference `window.__SM_GM__`, which MAIN
    // doesn't have — so the SW defers the swap and the reload runs the
    // baked-in body. The reload after that runs the re-registered
    // script in its new world.
    scriptsDir.write({
      relativePath: 'worldflip.user.js',
      meta: { name: 'WorldFlip', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'v1-main';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1-main');

    scriptsDir.write({
      relativePath: 'worldflip.user.js',
      meta: {
        name: 'WorldFlip',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `document.title = 'v2:' + GM_getValue('marker', 'init'); GM_setValue('marker', 'v2');`,
    });
    await page.reload();
    // Deferred: the MAIN-world wrapper ran its own body again. A swap
    // here would have thrown on `window.__SM_GM__` being undefined and
    // left the page with no title change at all.
    await expect(page).toHaveTitle('v1-main');

    // The refresh that ran during that reload landed the new row.
    // syncNow flushes the registration debounce it queued, which a
    // fast-following reload would otherwise out-race.
    await sm.syncNow();
    await page.reload();
    await expect(page).toHaveTitle('v2:init');
    await page.close();
  });

  test('a refresh that first needs the GM runtime defers to the next reload', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The shared `__SM_GM__` runtime is registered only in worlds that
    // have a script granting a runtime-backed API, so a page whose
    // only script grants nothing carries no runtime. Adding the first
    // such grant produces a body whose GM_* bindings would resolve to
    // nothing on the document already open — the SW marks the reply
    // `needsRuntime`, and the wrapper, finding no runtime when the body
    // is about to run, runs the baked-in body instead.
    //
    // `injectInto: 'content'` pins the world across both versions, so
    // this asserts the runtime check and not the world change (which
    // would defer for its own reason and prove nothing).
    const meta = {
      name: 'RuntimeAdd',
      match: [`${fixtureServer.baseUrl}/*`],
      runAt: 'document-end' as const,
      injectInto: 'content' as const,
    };
    scriptsDir.write({
      relativePath: 'runtimeadd.user.js',
      meta,
      body: `document.title = 'v1-no-runtime';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1-no-runtime');

    scriptsDir.write({
      relativePath: 'runtimeadd.user.js',
      meta: { ...meta, grant: ['GM_setValue', 'GM_getValue'] },
      body: `document.title = 'v2:' + GM_getValue('marker', 'init');`,
    });
    await page.reload();
    // Deferred: the baked-in body ran again. A swap here would have
    // thrown on `window.__SM_GM__` being undefined.
    await expect(page).toHaveTitle('v1-no-runtime');

    // That reload's refresh landed the new row; syncNow flushes the
    // registration debounce so the next reload gets the runtime.
    await sm.syncNow();
    await page.reload();
    await expect(page).toHaveTitle('v2:init');
    await page.close();
  });

  test('swapped body sees its own @resource bytes', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // `resource.init` used to live in the gm prelude, which the swap
    // path never runs — so a hot-swapped script's GM_getResourceText
    // read whatever box the registered version had left behind (or
    // none at all). It's emitted in the binding block now, which
    // `buildSwapEvalBody` prepends.
    scriptsDir.writeRaw('res.txt', 'RESOURCE-BODY');
    const meta = {
      name: 'ResSwap',
      match: [`${fixtureServer.baseUrl}/*`],
      runAt: 'document-end' as const,
      injectInto: 'content' as const,
      grant: ['GM_getResourceText'],
      extra: ['// @resource    payload res.txt'],
    };
    scriptsDir.write({
      relativePath: 'resswap.user.js',
      meta,
      body: `document.title = 'v1:' + GM_getResourceText('payload');`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1:RESOURCE-BODY');

    scriptsDir.rewriteBody('resswap.user.js', `document.title = 'v2:' + GM_getResourceText('payload');`);
    await page.reload();
    // 'v2:undefined' would mean the swapped body ran with an
    // uninitialised resource box.
    await expect(page).toHaveTitle('v2:RESOURCE-BODY');
    await page.close();
  });

  test('slow page: the decision wait hides behind the @run-at gate', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The gate-overlap contract, end to end. `slow-dcl.html` holds the
    // parser at readyState=loading for ~1s, and the script is served
    // over HTTP with a deliberate response delay, so the refresh takes
    // real time while the page takes much more of it.
    //
    // Two things have to hold at once:
    //   - the swap still happens (the refresh answered inside the
    //     fast-path window),
    //   - and the swapped body still ran at its declared @run-at, not
    //     at document-start and not deferred past `load`.
    // The body records `document.readyState` at the moment it runs, so
    // 'interactive' is the assertion that pins both bounds.
    const server = await UserscriptServer.start();
    const source = (marker: string) => [
      '// ==UserScript==',
      '// @name        SlowPage',
      `// @match       ${fixtureServer.baseUrl}/*`,
      '// @run-at      document-end',
      '// @inject-into content',
      '// ==/UserScript==',
      `document.title = '${marker}:' + document.readyState;`,
      '',
    ].join('\n');
    // The delay applies to the initial install fetch too; that one is
    // off the critical path.
    server.setRoute('/slow.user.js', source('v1'), { delayMs: 150 });
    try {
      await sm.addCollection(`${server.baseUrl}/slow.user.js`);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/slow-dcl.html`);
      await expect(page).toHaveTitle('v1:interactive');

      server.setRoute('/slow.user.js', source('v2'), { delayMs: 150 });
      await page.reload();
      // 'v1:*' would mean the refresh lost the fast-path window;
      // 'v2:loading' would mean the swap ignored @run-at; 'v2:complete'
      // would mean it was deferred past the document-end window.
      await expect(page).toHaveTitle('v2:interactive');
      await page.close();
    } finally {
      await server.stop();
    }
  });
});
