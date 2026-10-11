// MAIN-world coverage for the GM_* surfaces whose specs only ever ran
// in USER_SCRIPT world.
//
// Why these and not the others: the surfaces below either install
// themselves on the world's own `window` (`window.onurlchange`,
// `window.close` / `window.focus` — in MAIN that window is the
// PAGE's), or depend on an unprompted service-worker PUSH reaching the
// script. MAIN world has no `chrome.runtime.onMessage`, so every push
// has to be re-posted by wrapper-bridge.js and is gated there on the
// destination script's world (`smWorld`) — the direction most likely
// to be silently missing for a subsystem nobody exercised from MAIN.
//
// Push types covered here: `sm:url-change`, `sm:gm-value-update`,
// `sm:gm-menu-fire`, `sm:gm-tab-closed`. `sm:gm-xhr-event` is covered
// in gm-unsafe-window.spec.ts. Not covered, and not coverable
// headlessly: `sm:gm-notification-event` (no way to click a Chrome
// notification) and `sm:gm-download-event` (needs a real download).
//
// Every script here grants `unsafeWindow` purely to land in MAIN
// world; the assertions are about the other grant on the script.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor, activeTabId } from '../fixtures/sw-api';

test.describe('GM_* surfaces in MAIN world', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('window.onurlchange fires in MAIN world, and its surface lands on the page\'s window', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'urlchange.user.js',
      meta: {
        name: 'MainUrlChange',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'window.onurlchange'],
      },
      body: `
        const seen = [];
        document.body.dataset.supported = String(window.onurlchange === null);
        // Read through the page's own window too: that proves the
        // accessor went onto it, not onto the script's sandbox.
        document.body.dataset.onPageWindow = String(unsafeWindow.onurlchange === null);
        window.addEventListener('urlchange', function (info) {
          seen.push(info && info.url);
          document.body.dataset.urls = JSON.stringify(seen);
        });
        document.body.dataset.urls = '[]';
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    // The documented feature test has to hold in MAIN too — a script
    // that reads `undefined` here concludes the feature is unsupported.
    await expect(page.locator('body')).toHaveAttribute('data-supported', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-on-page-window', 'true');

    // A genuine page-initiated navigation. `page.evaluate` runs in MAIN
    // world, which is now the same world as the script.
    await page.evaluate(() => history.pushState({}, '', '/pushed-main.html'));
    await expect.poll(async () => JSON.parse(
      (await page.locator('body').getAttribute('data-urls')) ?? '[]',
    ) as string[]).toEqual([`${fixtureServer.baseUrl}/pushed-main.html`]);

    // The other half of installing on the page's window: the PAGE can
    // see the surface too, and subscribe to it. This is the documented
    // MAIN-world exposure (TODO.md, "`window.*` grant scope is
    // per-document-and-world"), pinned here so a change to it is a test
    // failure rather than a surprise.
    // Cast: `onurlchange` is ours, not a DOM standard, so it isn't on
    // lib.dom's Window.
    expect(await page.evaluate(() => (window as unknown as { onurlchange: unknown }).onurlchange)).toBeNull();

    await page.close();
  });

  test('window.close from MAIN world closes the tab, and the override replaces the page\'s method', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'closer.user.js',
      meta: {
        name: 'MainCloser',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'window.close', 'window.focus'],
      },
      body: `
        // '[native code]' is the tell that the override didn't take:
        // ours is ordinary script. In MAIN world these overwrite the
        // methods on the page's own window.
        const native = (fn) => Function.prototype.toString.call(fn).includes('native code');
        document.body.dataset.nativeClose = String(native(window.close));
        document.body.dataset.nativeFocus = String(native(window.focus));
        document.body.dataset.ready = 'yes';
        // Wait for the test to read the flags above before the tab goes
        // away: Chrome refuses the page's own close() for a tab the
        // script didn't open, so a tab that really closes proves the
        // override reached the service worker over the bridge.
        document.getElementById('sm-close-now')
          || document.body.insertAdjacentHTML('beforeend', '<button id="sm-close-now"></button>');
        document.getElementById('sm-close-now')
          .addEventListener('click', function () { window.close(); });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-native-close', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-native-focus', 'false');

    const closed = page.waitForEvent('close', { timeout: 10_000 });
    // The click closes the page, sometimes before Playwright has finished
    // the click, which then reports the page gone. The close event is
    // what's under test.
    await page.locator('#sm-close-now').click().catch(() => undefined);
    await closed;
    expect(page.isClosed()).toBe(true);
  });

  test('GM_addValueChangeListener in MAIN world receives a cross-tab broadcast', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'listener.user.js',
      meta: {
        name: 'MainRemoteListener',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_setValue', 'GM_addValueChangeListener'],
      },
      body: `
        const events = [];
        GM_addValueChangeListener('shared', function (key, oldVal, newVal, remote) {
          events.push({ newVal: newVal, remote: remote });
          document.body.dataset.smEvents = JSON.stringify(events);
        });
        document.body.dataset.smEvents = '[]';
        // MAIN world means the page's realm, so the test can call into
        // the script directly instead of polling a dataset command.
        unsafeWindow.__smWrite = function (v) { GM_setValue('shared', v); };
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-ready', 'yes');
    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageB.locator('body')).toHaveAttribute('data-ready', 'yes');

    // B writes; A must hear about it with remote=true. The write leaves
    // A's document entirely (bridge → SW → broadcast) and comes back as
    // an `sm:gm-value-update` push that the bridge has to re-post into
    // MAIN world.
    await pageB.evaluate(() => (window as unknown as {
      __smWrite: (v: string) => void;
    }).__smWrite('from-b'));

    await expect.poll(async () => JSON.parse(
      (await pageA.locator('body').getAttribute('data-sm-events')) ?? '[]',
    ) as Array<{ newVal: string; remote: boolean }>)
      .toEqual([{ newVal: 'from-b', remote: true }]);

    // B saw its own write locally, not as a broadcast.
    expect(JSON.parse((await pageB.locator('body').getAttribute('data-sm-events'))!))
      .toEqual([{ newVal: 'from-b', remote: false }]);

    await pageA.close();
    await pageB.close();
  });

  test('a menu command registered from MAIN world fires its callback there', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'MainMenu',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_registerMenuCommand'],
      },
      body: `
        GM_registerMenuCommand('Main world command', function () {
          // Written through unsafeWindow so the assertion also proves
          // the callback ran in the page's realm, not somewhere else.
          unsafeWindow.__smMenuFired = 'yes';
          document.body.dataset.smFired = 'yes';
        });
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    const tabId = await activeTabId(getServiceWorker);

    // The registration rides the bridge, so poll for the SW to have it.
    const groups = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.length === 1 && g[0]!.commands.length === 1,
      { label: 'MAIN-world menu command registered' },
    );
    const scriptId = groups[0]!.scriptId;
    const command = groups[0]!.commands[0]!;
    expect(command.name).toBe('Main world command');

    // Equivalent to the user clicking the entry. The fire is a
    // `sm:gm-menu-fire` push, which only reaches the callback if the
    // bridge relays MAIN-addressed pushes.
    expect(await sm.fireActionContextMenuItem(tabId, scriptId, command.commandId))
      .toEqual({ ok: true });
    await expect(page.locator('body')).toHaveAttribute('data-sm-fired', 'yes');
    expect(await page.evaluate(() => (window as unknown as {
      __smMenuFired?: string;
    }).__smMenuFired)).toBe('yes');

    await page.close();
  });

  test('GM_openInTab from MAIN world fires onclose when the opened tab goes away', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'opener.user.js',
      meta: {
        name: 'MainOpener',
        match: [`${fixtureServer.baseUrl}/target.html`],
        runAt: 'document-end',
        grant: ['unsafeWindow', 'GM_openInTab'],
      },
      body: `
        const ctl = GM_openInTab('${fixtureServer.baseUrl}/page-globals.html', { active: false });
        ctl.onclose = function () { document.body.dataset.smOnClose = 'fired'; };
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const opened = extensionContext.waitForEvent('page');
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    const openedPage = await opened;
    await openedPage.waitForLoadState();

    // Closing it produces an `sm:gm-tab-closed` push addressed to a
    // MAIN-world script.
    await openedPage.close();
    await expect(page.locator('body')).toHaveAttribute('data-sm-on-close', 'fired');

    await page.close();
  });
});
