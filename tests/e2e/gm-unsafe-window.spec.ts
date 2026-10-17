// End-to-end tests for `@grant unsafeWindow`.
//
// `unsafeWindow` means "the page's real window". Chrome's isolated
// worlds cannot reach it — property access is synchronous and there is
// no synchronous channel between worlds — so the grant is honored by
// running the script in MAIN world instead, where `window` already IS
// the page's window.
//
// That move only works if the rest of the GM_* surface follows the
// script into MAIN, which it does: the shared GM runtime is
// registered in MAIN too and routes its SW traffic over
// wrapper-bridge.js. These tests cover both halves plus the SW-side
// gate that keeps the page from abusing the widened bridge.
//
// See docs/injection.md#unsafewindow-is-the-pages-window.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { bridgeEvent, bridgeRequest } from '../fixtures/bridge-forge';
import { waitForGmValues } from '../fixtures/sw-api';
import { UserscriptServer } from '../fixtures/userscript-server';

const PAGE = 'page-globals.html';

test.describe('@grant unsafeWindow', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('reaches real page globals; its own window is a sandbox of the built-ins', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'UnsafeWindow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow'],
      },
      body: `
        const b = document.body.dataset;
        b.smAppName = String(unsafeWindow.__PAGE_APP__ && unsafeWindow.__PAGE_APP__.name);
        b.smFnResult = String(unsafeWindow.__PAGE_FN__ ? unsafeWindow.__PAGE_FN__('x') : 'no-fn');
        // A granted script's own window is a sandbox, so the two
        // differ, as in Tampermonkey. The sandbox shows only the
        // browser's built-ins, so the page's globals are reached
        // through unsafeWindow or by bare name.
        b.smSameAsWindow = String(unsafeWindow === window);
        b.smViaWindow = String(typeof window.__PAGE_APP__) + ':' + __PAGE_APP__.name;
        // Writes must land where the page can see them.
        unsafeWindow.__FROM_SCRIPT__ = 'hello-page';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
    await expect(page.locator('body')).toHaveAttribute('data-sm-fn-result', 'page-fn:x');
    await expect(page.locator('body')).toHaveAttribute('data-sm-same-as-window', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-sm-via-window', 'undefined:page-app');

    // page.evaluate runs in the page's MAIN world, so it sees both the
    // side effect of the page function AND what the script wrote.
    const fromPage = await page.evaluate(() => ({
      written: (window as unknown as { __FROM_SCRIPT__?: string }).__FROM_SCRIPT__,
      calls: (window as unknown as { __PAGE_APP__: { calls: number } }).__PAGE_APP__.calls,
    }));
    expect(fromPage).toEqual({ written: 'hello-page', calls: 1 });
    await page.close();
  });

  test('GM storage keeps working alongside unsafeWindow (round-trips through the bridge)', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The motivating combination: 96 of the 213 unsafeWindow-granting
    // scripts in the top-2000 GreasyFork corpus also @grant GM_getValue.
    // Moving them to MAIN world would be a net loss if storage broke.
    // In MAIN the initial snapshot arrives over the bridge and writes
    // flush back over it too.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'UnsafeWindowStorage',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue', 'GM_getValue'],
      },
      body: `
        const b = document.body.dataset;
        b.smAppName = String(unsafeWindow.__PAGE_APP__ && unsafeWindow.__PAGE_APP__.name);
        const seen = GM_getValue('visits', 0);
        b.smVisits = String(seen);
        GM_setValue('visits', seen + 1);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const first = await extensionContext.newPage();
    await first.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    // Page access and storage both work in the same script.
    await expect(first.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
    await expect(first.locator('body')).toHaveAttribute('data-sm-visits', '0');
    await waitForGmValues(sm, (values) => values.visits === 1, 'visits = 1');
    await first.close();

    // A fresh document must be seeded from the SW snapshot — which is
    // the part that only works if the bridge-relayed check-pending is
    // allowed to carry `gmValues` for a MAIN-world script.
    const second = await extensionContext.newPage();
    await second.goto(`${fixtureServer.baseUrl}/${PAGE}?n=2`);
    await expect(second.locator('body')).toHaveAttribute('data-sm-visits', '1');
    await second.close();
  });

  test('@inject-into page gets the same GM_* surface, without granting unsafeWindow', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The runtime follows the resolved WORLD, not the unsafeWindow
    // grant: any MAIN-world script that grants a runtime-backed API
    // gets it. Before GM_* ran in MAIN at all, this combination broke
    // the same way unsafeWindow did.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'InjectIntoPageStorage',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        injectInto: 'page',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        const b = document.body.dataset;
        b.smAppName = String(__PAGE_APP__ && __PAGE_APP__.name);
        const seen = GM_getValue('visits', 0);
        b.smVisits = String(seen);
        GM_setValue('visits', seen + 1);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const first = await extensionContext.newPage();
    await first.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(first.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
    await expect(first.locator('body')).toHaveAttribute('data-sm-visits', '0');
    await first.waitForTimeout(500);
    await first.close();

    const second = await extensionContext.newPage();
    await second.goto(`${fixtureServer.baseUrl}/${PAGE}?n=2`);
    await expect(second.locator('body')).toHaveAttribute('data-sm-visits', '1');
    await second.close();
  });

  test('a second MAIN-world GM script on a new host, added in a later sync, gets the runtime too', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The MAIN runtime is scoped to its scripts' patterns, so adding a
    // script on a host it isn't on yet has to move the registration —
    // an incremental sync that skipped it would leave this script's
    // GM_setValue bound to a global that never reaches its page.
    scriptsDir.write({
      relativePath: 'first.user.js',
      meta: {
        name: 'FirstHost',
        match: [`${fixtureServer.baseUrl}/target.html*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue'],
      },
      body: `GM_setValue('first', 1);`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const warm = await extensionContext.newPage();
    await warm.goto(`${fixtureServer.baseUrl}/target.html`);
    await warm.waitForTimeout(300);
    await warm.close();

    scriptsDir.write({
      relativePath: 'second.user.js',
      meta: {
        name: 'SecondPage',
        match: [`${fixtureServer.baseUrl}/${PAGE}*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue', 'GM_getValue'],
      },
      body: `
        const n = GM_getValue('visits', 0);
        document.body.dataset.smVisits = String(n);
        GM_setValue('visits', n + 1);
      `,
    });
    await sm.updateCollection(added!.id, 'manual');
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-visits', '0');
    await page.waitForTimeout(400);
    await page.close();
    const again = await extensionContext.newPage();
    await again.goto(`${fixtureServer.baseUrl}/${PAGE}?n=2`);
    await expect(again.locator('body')).toHaveAttribute('data-sm-visits', '1');
    await again.close();
  });

  test('GM_xmlhttpRequest works from MAIN world (request out and event back over the bridge)', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Exercises both bridge directions in one call: the request is a
    // page->SW relay, and the terminal load event is an SW push that
    // MAIN world can only receive because the bridge re-posts it.
    const dataServer = await UserscriptServer.start();
    try {
      dataServer.setRoute('/hello', 'hello from server', {
        contentType: 'text/plain; charset=utf-8',
      });
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: {
          name: 'UnsafeWindowXhr',
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          grant: ['unsafeWindow', 'GM_xmlhttpRequest'],
          connect: ['127.0.0.1'],
        },
        body: `
          document.body.dataset.smAppName = String(unsafeWindow.__PAGE_APP__.name);
          GM_xmlhttpRequest({
            method: 'GET',
            url: '${dataServer.baseUrl}/hello',
            onload: (res) => {
              document.body.dataset.smStatus = String(res.status);
              document.body.dataset.smText = String(res.responseText);
            },
            onerror: (e) => {
              document.body.dataset.smError = String((e && e.error) || e);
            },
          });
        `,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
      await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'page-app');
      await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
      await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'hello from server');
      await page.close();
    } finally {
      await dataServer.stop();
    }
  });

  test('@grant none MAIN-world scripts do not bring the GM runtime onto the page', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The GM runtime is registered per world only when some script in
    // that world grants a runtime-backed API. A `@grant none` script is
    // an explicit "no extension APIs" declaration, so the page it runs
    // on must stay clean.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'PlainMain',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['none'],
      },
      body: `document.body.dataset.smRan = '1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ran', '1');
    // Not a page global in any case (it lives in the registry), so
    // what's checked is that it isn't registered for MAIN world.
    const sw = await getServiceWorker();
    const ids = await sw.evaluate(async () => (await chrome.userScripts.getScripts()).map((r) => r.id));
    expect(ids).not.toContain('sourcemonkey-gm-runtime-main');
    await page.close();
  });

  test('@inject-into content keeps the script isolated and says so out loud', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The one combination that cannot work. `@inject-into content` is an
    // explicit request for isolation, so we honor it and keep VM's
    // content-mode binding (`unsafeWindow` === the isolated realm's
    // window) — but a script silently reading `undefined` off every page
    // global is exactly the failure this work exists to remove, so the
    // mismatch is reported as a parse-time warning.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'IsolatedUnsafeWindow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow'],
        injectInto: 'content',
      },
      body: `
        document.body.dataset.smAppName = String(unsafeWindow.__PAGE_APP__);
        document.body.dataset.smSameAsWindow = String(unsafeWindow === window);
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    // Isolated: the page global is not visible.
    await expect(page.locator('body')).toHaveAttribute('data-sm-app-name', 'undefined');
    // Still a real window (VM's content-mode contract), just not the page's.
    await expect(page.locator('body')).toHaveAttribute('data-sm-same-as-window', 'true');
    await page.close();

    // ...and the user is told why, on the stored script and in the Log.
    const detail = await sm.getCollectionWithScripts(added!.id);
    const script = detail!.scripts[0];
    const warning = (script.startupLogs ?? []).find(
      (l) => l.message.includes('unsafeWindow'),
    );
    expect(warning, 'expected a startup-log warning for the isolated unsafeWindow').toBeTruthy();
    expect(warning!.level).toBe('warn');
  });

  test('a USER_SCRIPT-world script\'s value broadcast is not relayed into the page', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The bridge now re-posts SW pushes into MAIN world so the MAIN
    // GM runtime can hear them. Those payloads carry real data — stored
    // values here, cross-origin response bodies on the XHR path — so
    // relaying indiscriminately would leak an isolated script's data to
    // any page that happens to also run a MAIN-world script. The SW
    // stamps each push with the destination script's world and the
    // bridge relays only `smWorld === 'MAIN'`.
    const SECRET = 'broadcast-canary-4b71';
    scriptsDir.write({
      relativePath: 'victim.user.js',
      meta: {
        name: 'BroadcastVictim',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
        injectInto: 'content',
      },
      body: `
        // Tab 2 records what it receives so we can prove the broadcast
        // really happened (and only the relay was suppressed).
        if (location.search.indexOf('writer') !== -1) {
          GM_setValue('secret', '${SECRET}');
        } else {
          setInterval(() => {
            document.body.dataset.smSeen = String(GM_getValue('secret', ''));
          }, 100);
        }
      `,
    });
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'MainSide',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow'],
      },
      body: `document.documentElement.dataset.smMain = '1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // Reader tab first, with a page-side tap on the bridge's push
    // channel — this is what a hostile page would install.
    const reader = await extensionContext.newPage();
    await reader.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(reader.locator('html')).toHaveAttribute('data-sm-main', '1');
    // Played by a page that has the channel key, so what this checks is
    // the bridge's own `smWorld` filter behind it.
    const key = await sm.channelKey();
    await reader.evaluate((pushEvent) => {
      const seen: unknown[] = [];
      (window as unknown as { __PUSHES__: unknown[] }).__PUSHES__ = seen;
      document.addEventListener(pushEvent, (ev) => { seen.push(JSON.parse((ev as CustomEvent<string>).detail)); }, true);
    }, bridgeEvent('push', key));

    // Writer tab triggers the cross-tab broadcast.
    const writer = await extensionContext.newPage();
    await writer.goto(`${fixtureServer.baseUrl}/${PAGE}?writer`);
    await writer.waitForTimeout(600);

    // The isolated script in the reader tab DID get the broadcast...
    await expect(reader.locator('body')).toHaveAttribute('data-sm-seen', SECRET);
    // ...but the page never saw it.
    const pushes = await reader.evaluate(
      () => JSON.stringify((window as unknown as { __PUSHES__: unknown[] }).__PUSHES__),
    );
    expect(pushes).not.toContain(SECRET);
    expect(pushes).not.toContain('sm:gm-value-update');

    await writer.close();
    await reader.close();
  });

  test('a page cannot drive GM_* for a USER_SCRIPT-world script through the widened bridge', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The bridge now relays GM_* calls so MAIN-world scripts can reach
    // the SW. That channel is page-observable and page-forgeable, so the
    // SW only honors a bridge-relayed, script-scoped request when the
    // named script actually runs in MAIN world on the sending page —
    // i.e. one the page shares a realm with. A USER_SCRIPT-world script
    // is never in that set. The channel key keeps the page off the
    // bridge in the first place; this plays a page that has it.
    scriptsDir.write({
      relativePath: 'victim.user.js',
      meta: {
        name: 'Victim',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
        injectInto: 'content',
      },
      body: `
        if (GM_getValue('secret', '') === '') GM_setValue('secret', 'original');
        document.body.dataset.smVictim = String(GM_getValue('secret', '_NONE_'));
      `,
    });
    // A MAIN-world script so the bridge is registered at all.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'MainSide',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow'],
      },
      body: `document.documentElement.dataset.smMain = '1';`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const seed = await extensionContext.newPage();
    await seed.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(seed.locator('body')).toHaveAttribute('data-sm-victim', 'original');
    await seed.waitForTimeout(500);
    await seed.close();

    const detail = await sm.getCollectionWithScripts(added!.id);
    const victimId = detail!.scripts.find((s) => s.relativePath === 'victim.user.js')!.id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}?n=2`);
    await expect(page.locator('html')).toHaveAttribute('data-sm-main', '1');

    // Forge a storage write as the victim, as a page with the channel
    // key could: what this checks is the SW-side gate behind the key.
    const reply = await bridgeRequest(page, await sm.channelKey(), {
      type: 'sm:gm-batch-write',
      scriptId: victimId,
      writes: [{ key: 'secret', value: 'pwned' }],
    });

    // The bridge relayed it (so we know we tested the real path) and the
    // SW refused.
    expect(reply, 'bridge should reply to the forged GM call').not.toBeNull();
    expect((reply as { ok?: unknown }).ok).toBe(false);
    await page.waitForTimeout(300);
    await page.close();

    // The victim's value is untouched on the next load.
    const after = await extensionContext.newPage();
    await after.goto(`${fixtureServer.baseUrl}/${PAGE}?n=3`);
    await expect(after.locator('body')).toHaveAttribute('data-sm-victim', 'original');
    await after.close();
  });

  test('a page cannot drive an API a MAIN-world script never granted', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Being a MAIN-world script on the page is only half the gate. The
    // "page could already call it" justification covers the bindings
    // the script has, so a `@grant none` script matching the page must
    // not become a handle for opening tabs, showing notifications, or
    // starting downloads in the extension's name.
    scriptsDir.write({
      relativePath: 'plain.user.js',
      meta: {
        name: 'Plain',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['none'],
      },
      body: `document.documentElement.dataset.smPlain = '1';`,
    });
    // A script that needs the runtime + bridge in MAIN world, on a
    // different page, so the bridge is registered on ours too.
    scriptsDir.write({
      relativePath: 'elsewhere.user.js',
      meta: {
        name: 'Elsewhere',
        match: [`${fixtureServer.baseUrl}/${PAGE}?other`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue'],
      },
      body: `GM_setValue('k', 1);`,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const detail = await sm.getCollectionWithScripts(added!.id);
    const plainId = detail!.scripts.find((s) => s.relativePath === 'plain.user.js')!.id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(page.locator('html')).toHaveAttribute('data-sm-plain', '1');
    const before = (await extensionContext.pages()).length;

    // Forge a tab open as the @grant none script, as a page with the
    // channel key could.
    const reply = await bridgeRequest(page, await sm.channelKey(), {
      type: 'sm:gm-tab-open', scriptId: plainId, requestId: 'forged-tab', url: `${fixtureServer.baseUrl}/${PAGE}?forged`, active: false,
    });

    expect(reply, 'bridge should reply to the forged GM call').not.toBeNull();
    expect((reply as { ok?: unknown }).ok).toBe(false);
    await page.waitForTimeout(300);
    expect((await extensionContext.pages()).length).toBe(before);
    await page.close();
  });
});
