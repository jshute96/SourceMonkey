// E2E coverage for `@grant window.close` and `@grant window.focus`.
//
// What makes these grants worth testing end to end is that the page's
// own versions are hobbled by the browser: Chrome refuses
// `window.close()` for a tab the script didn't open, and ignores
// `window.focus()` for a background tab. The grant swaps the method the
// script sees (on its sandbox `window` in the page's world, on the
// isolated world's `window` there) for one that asks the service
// worker to do it (`chrome.tabs.remove` / `chrome.windows.update`), so
// the assertions below are "the tab actually went away" and "the
// method the script sees is no longer the native one".
//
// `window.focus` has two halves: it selects the calling tab (real
// state, asserted below) and raises its window (not observable
// headlessly — a headless browser reports every window as focused, and
// raising is the OS window manager's call anyway).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Reports whether the method the script sees is still the browser's,
// then calls it. `[native code]` in the source is the tell: our
// override is ordinary script.
function probeBody(method: 'close' | 'focus'): string {
  return `
    document.body.dataset.native = String(
      Function.prototype.toString.call(window.${method}).includes('native code'),
    );
    document.body.dataset.ready = 'yes';
    let threw = '';
    let returned = 'x';
    try {
      returned = String(window.${method}());
    } catch (e) {
      threw = String(e && e.message || e);
    }
    document.body.dataset.threw = threw;
    document.body.dataset.returned = returned;
  `;
}

test.describe('window.close / window.focus', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('granted: window.close() closes the tab the script runs in', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'closer.user.js',
      meta: {
        name: 'Closer',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.close'],
      },
      body: probeBody('close'),
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // Closing the LAST tab takes the browser with it, which Playwright
    // reports as a dead context rather than a page close. The
    // persistent context happens to keep an about:blank around, but
    // don't depend on that.
    const keepAlive = await extensionContext.newPage();
    await keepAlive.goto(`${fixtureServer.baseUrl}/other.html`);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // The close is a service-worker round-trip, so the tab goes away
    // shortly after the script runs rather than during it. Polled
    // rather than waiting on the `close` event, which can fire before
    // a listener is attached.
    await expect.poll(() => page.isClosed(), { timeout: 10_000 }).toBe(true);

    await keepAlive.close();
  });

  test('ungranted: window.close() is the browser\'s own no-op', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'noclose.user.js',
      meta: {
        name: 'No Close Grant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addStyle'],
      },
      body: probeBody('close'),
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    // Native method, and Chrome refuses it for a tab it didn't open —
    // so the page is still here.
    await expect(page.locator('body')).toHaveAttribute('data-native', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-threw', '');
    expect(page.isClosed()).toBe(false);

    await page.close();
  });

  test('granted: window.focus() is replaced, accepted, and returns undefined', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'focuser.user.js',
      meta: {
        name: 'Focuser',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.focus'],
        injectInto: 'content',
      },
      body: probeBody('focus'),
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-native', 'false');
    // TM's window.focus is a void, synchronous call — ours matches.
    await expect(page.locator('body')).toHaveAttribute('data-returned', 'undefined');
    await expect(page.locator('body')).toHaveAttribute('data-threw', '');

    await page.close();
  });

  test('granted: window.focus() selects the calling tab', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The window-raising half can't be asserted headlessly (a headless
    // browser reports every window as focused), but tab selection is
    // real state. The call is triggered through the DOM rather than by
    // clicking, because Playwright brings a page to the front to
    // deliver input — which would select the tab for us and prove
    // nothing.
    scriptsDir.write({
      relativePath: 'focus-on-cue.user.js',
      meta: {
        name: 'Focus On Cue',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.focus'],
      },
      body: `
        new MutationObserver(() => {
          if (document.body.dataset.go === 'now') window.focus();
        }).observe(document.body, { attributes: true });
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');

    // A second tab, opened after, is the active one.
    const other = await extensionContext.newPage();
    await other.goto(`${fixtureServer.baseUrl}/other.html`);

    const sw = await getServiceWorker();
    const activeUrl = async (): Promise<string | undefined> => {
      const tabs = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
      return (tabs as Array<{ url?: string }>)[0]?.url;
    };
    expect(await activeUrl()).toContain('/other.html');

    // MAIN world sets the attribute; the USER_SCRIPT-world script sees
    // the mutation and calls the granted window.focus().
    await page.evaluate(() => { document.body.dataset.go = 'now'; });
    await expect.poll(activeUrl, { timeout: 10_000 }).toContain('/target.html');

    await other.close();
    await page.close();
  });

  test('the override leaks to an ungranted sibling in the same document', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Pinning a KNOWN LIMITATION, not a feature. All isolated
    // SourceMonkey scripts on a page share one USER_SCRIPT world, so
    // the override lands on a `window` the ungranted sibling also sees,
    // and here
    // that hands it the user's tab, not just an observation channel.
    // TM gates per script because it sandboxes each script's window.
    // See docs/GM-APIs.md and the per-script-worlds item in TODO.md;
    // a future fix has to flip this assertion consciously.
    scriptsDir.write({
      relativePath: 'granter.user.js',
      meta: {
        name: 'Granter',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.close'],
        injectInto: 'content',
      },
      body: `document.body.dataset.granterRan = 'yes';`,
    });
    scriptsDir.write({
      relativePath: 'sibling.user.js',
      meta: {
        name: 'Ungranted Sibling',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-idle',
        grant: ['GM_addStyle'],
        injectInto: 'content',
      },
      // Re-probed on a timer rather than once at load: run order
      // between two scripts on the same page isn't guaranteed, and the
      // claim under test is "the override is visible to this script",
      // not "it is visible before the granting script has run".
      body: `
        const probe = () => {
          document.body.dataset.siblingNative = String(
            Function.prototype.toString.call(window.close).includes('native code'),
          );
        };
        probe();
        const timer = setInterval(probe, 50);
        setTimeout(() => clearInterval(timer), 5000);
        document.body.dataset.siblingRan = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sibling-ran', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-granter-ran', 'yes');
    // The leak: the sibling granted nothing and sees the override.
    await expect(page.locator('body')).toHaveAttribute('data-sibling-native', 'false');

    await page.close();
  });

  test('page world: only the granting script sees the override', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // In the page's world the override goes on the granting script's
    // sandbox `window`, so neither the page nor an ungranted sibling
    // can close or focus the tab with it.
    scriptsDir.write({
      relativePath: 'granter.user.js',
      meta: {
        name: 'Granter',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.close', 'window.focus'],
      },
      body: `
        const native = (f) => String(Function.prototype.toString.call(f).includes('native code'));
        document.body.dataset.granterClose = native(window.close);
        document.body.dataset.granterFocus = native(focus);
        document.body.dataset.granterRan = 'yes';
      `,
    });
    scriptsDir.write({
      relativePath: 'sibling.user.js',
      meta: {
        name: 'Ungranted Sibling',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-idle',
        grant: ['GM_addStyle'],
      },
      body: `
        document.body.dataset.siblingClose = String(
          Function.prototype.toString.call(window.close).includes('native code'),
        );
        document.body.dataset.siblingRan = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-granter-ran', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-sibling-ran', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-granter-close', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-granter-focus', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-sibling-close', 'true');
    const pageSide = await page.evaluate(() => ({
      close: Function.prototype.toString.call(window.close).includes('native code'),
      focus: Function.prototype.toString.call(window.focus).includes('native code'),
    }));
    expect(pageSide).toEqual({ close: true, focus: true });

    await page.close();
  });

  test('page world: a frame keeps the page\'s own close', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The override closes the whole tab, which a frame's close() never
    // does, so a frame's sandbox gets none (docs/frames.md).
    scriptsDir.write({
      relativePath: 'frame-closer.user.js',
      meta: {
        name: 'Frame Closer',
        match: [`${fixtureServer.baseUrl}/frames/*`],
        runAt: 'document-end',
        grant: ['window.close'],
      },
      body: `
        document.body.dataset.closeNative = String(
          Function.prototype.toString.call(window.close).includes('native code'),
        );
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
    await expect(page.locator('body')).toHaveAttribute('data-close-native', 'false');
    await expect.poll(async () => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const v = await f.evaluate(() => document.body?.dataset.closeNative ?? '').catch(() => '');
        if (v) return v;
      }
      return '';
    }).toBe('true');

    await page.close();
  });

  test('granted: only the isolated world is patched, not the page', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The override lands on the USER_SCRIPT world's `window`. The
    // page's own `window.close` must be untouched — otherwise a site
    // could detect SourceMonkey (and lose its own close behavior).
    scriptsDir.write({
      relativePath: 'focus-only.user.js',
      meta: {
        name: 'Focus Only',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.focus'],
        injectInto: 'content',
      },
      body: `document.body.dataset.ready = 'yes';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');

    const pageSide = await page.evaluate(() => ({
      close: Function.prototype.toString.call(window.close).includes('native code'),
      focus: Function.prototype.toString.call(window.focus).includes('native code'),
    }));
    expect(pageSide).toEqual({ close: true, focus: true });

    await page.close();
  });

  test('a script that grants only window.close keeps the native focus', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Each grant installs exactly its own override — granting one must
    // not drag the other in.
    scriptsDir.write({
      relativePath: 'close-not-focus.user.js',
      meta: {
        name: 'Close Not Focus',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.close'],
        injectInto: 'content',
      },
      body: `
        document.body.dataset.focusNative = String(
          Function.prototype.toString.call(window.focus).includes('native code'),
        );
        document.body.dataset.closeNative = String(
          Function.prototype.toString.call(window.close).includes('native code'),
        );
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-focus-native', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-close-native', 'false');

    await page.close();
  });
});
