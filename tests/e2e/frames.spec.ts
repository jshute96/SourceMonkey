// Frame targeting end-to-end: scripts run in every matching frame by
// default (the TM/VM behavior), `@noframes` pins them to the top frame,
// and a page full of frames must not multiply the badge count or the
// per-script Log. See docs/injection.md#frames.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState } from '../fixtures/sw-api';

const MARK = 'injected by SourceMonkey';

// Text of `#target` in the named sub-frame. Playwright's frameLocator
// waits for the frame, so no explicit load synchronisation is needed.
function frameTarget(page: Page, name: string) {
  return page.frameLocator(`iframe[name="${name}"]`).locator('#target');
}

test.describe('frames', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('by default a script runs in the top frame and every matching sub-frame', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: { name: 'Mark Every Frame', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);

    await expect(page.locator('#target')).toHaveText(MARK);
    await expect(frameTarget(page, 'kid1')).toHaveText(MARK);
    await expect(frameTarget(page, 'kid2')).toHaveText(MARK);
    await expect(frameTarget(page, 'nested')).toHaveText(MARK);
    // Depth 2: a frame inside a frame is still matched independently.
    await expect(
      page.frameLocator('iframe[name="nested"]').frameLocator('iframe[name="grandkid"]').locator('#target'),
    ).toHaveText(MARK);

    await page.close();
  });

  test('a cross-origin sub-frame is injected into, and reports as a sub-frame', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Same server, different host — `localhost` and `127.0.0.1` are
    // separate origins, so this exercises the out-of-process-iframe
    // path (a different renderer, no shared `window` with the parent)
    // that the same-origin fixtures can't reach.
    const crossOrigin = fixtureServer.baseUrl.replace('127.0.0.1', 'localhost');
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: {
        name: 'Mark Every Frame',
        // Port-less patterns match any port, so one pair covers both
        // hosts of the fixture server.
        match: ['*://127.0.0.1/*', '*://localhost/*'],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
      `,
    });
    const source = await sm.addSource(scriptsDir.path);
    await sm.syncNow();
    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText(MARK);

    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.name = 'xorigin';
      f.src = src;
      document.body.appendChild(f);
    }, `${crossOrigin}/target.html`);
    await expect(frameTarget(page, 'xorigin')).toHaveText(MARK);

    // The report from the cross-origin frame must be recognised as a
    // sub-frame, not mistaken for a second top-level document.
    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });
    const snap = await waitForTabState(sm, tabId, (s) => s.badgeText === '1', 'badge count 1');
    expect(snap.record!.docOrder).toHaveLength(1);
    await expect.poll(async () => {
      const log = await sm.getScriptLog(scriptId);
      return log.filter((e) => e.message.startsWith('Started in sub-frame')).length;
    }).toBe(1);

    await page.close();
  });

  test('@noframes pins the script to the top frame', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'top-only.user.js',
      meta: {
        name: 'Top Frame Only',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @noframes'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);

    await expect(page.locator('#target')).toHaveText(MARK);
    // Give the sub-frames a chance to be wrongly injected before
    // asserting they weren't.
    await page.waitForLoadState('networkidle');
    await expect(frameTarget(page, 'kid1')).toHaveText('original content');
    await expect(frameTarget(page, 'kid2')).toHaveText('original content');
    await expect(frameTarget(page, 'nested')).toHaveText('original content');

    await page.close();
  });

  test('about:blank and srcdoc frames are not injected into', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Pins a known limitation rather than a desired behavior:
    // chrome.userScripts has no `matchOriginAsFallback`, so a frame
    // with no URL of its own never matches any pattern. TM/VM do reach
    // these frames. See TODO.md.
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: {
        name: 'Mark Every Frame',
        // <all_urls> would still not match about:blank, but use it so
        // the test can't pass merely because the pattern was too narrow.
        match: ['<all_urls>'],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
        document.documentElement.setAttribute('data-sm-ran', '1');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);
    await expect(page.locator('#target')).toHaveText(MARK);
    await page.waitForLoadState('networkidle');

    const blank = page.frame({ name: 'blank' });
    expect(blank, 'about:blank frame should exist').not.toBeNull();
    expect(await blank!.locator('html').getAttribute('data-sm-ran')).toBeNull();
    await expect(frameTarget(page, 'srcdoc')).toHaveText('original content');

    await page.close();
  });

  test('startup diagnostics are printed once, not once per frame', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // An unknown @grant is one of the load-pipeline diagnostics the
    // prelude echoes into the page console. It describes the stored
    // script, so repeating it in every frame is pure noise.
    scriptsDir.write({
      relativePath: 'diag.user.js',
      meta: {
        name: 'Has A Startup Log',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['NotARealGmApi'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    // page.on('console') sees messages from every frame of the page.
    const diagnostics: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Ignoring @grant')) diagnostics.push(msg.text());
    });
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);

    // All four sub-frames ran (so the count below isn't 1 by accident).
    await expect(frameTarget(page, 'kid1')).toHaveText(MARK);
    await expect(
      page.frameLocator('iframe[name="nested"]').frameLocator('iframe[name="grandkid"]').locator('#target'),
    ).toHaveText(MARK);
    await expect(page.locator('#target')).toHaveText(MARK);

    expect(diagnostics).toHaveLength(1);
    await page.close();
  });

  test('registration carries allFrames, and the shared helpers follow it', async ({
    fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'frames.user.js',
      // @grant GM_addStyle → USER_SCRIPT world, so the GM runtime
      // registration is emitted alongside.
      meta: {
        name: 'Runs In Frames', match: [`${fixtureServer.baseUrl}/*`],
        grant: ['GM_addStyle'],
      },
      body: 'void 0;',
    });
    scriptsDir.write({
      relativePath: 'top.user.js',
      // @grant none → MAIN world, so the bridge registration is emitted.
      meta: {
        name: 'Top Only', match: [`${fixtureServer.baseUrl}/*`],
        grant: ['none'], extra: ['// @noframes'],
      },
      body: 'void 0;',
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const sw = await getServiceWorker();
    const registered = await sw.evaluate(async () => {
      const list = await chrome.userScripts.getScripts();
      return list.map((s) => ({ id: s.id, allFrames: s.allFrames }));
    });
    const byId = new Map(registered.map((r) => [r.id, r.allFrames]));

    // Chrome echoes the field back, so this also proves it accepted it.
    const values = [...byId.entries()]
      .filter(([id]) => !id.startsWith('sourcemonkey-'))
      .map(([, allFrames]) => allFrames)
      .sort();
    expect(values).toEqual([false, true]);
    // One frame-running script is enough to pull the helpers into frames.
    expect(byId.get('sourcemonkey-bridge')).toBe(true);
    expect(byId.get('sourcemonkey-gm-runtime')).toBe(true);
  });

  test('many frames do not multiply the badge count or the script Log', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: { name: 'Mark Every Frame', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
      `,
    });
    const source = await sm.addSource(scriptsDir.path);
    await sm.syncNow();
    const withScripts = await sm.getSourceWithScripts(source!.id);
    const scriptId = withScripts!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);
    // Wait for the deepest same-origin frame, so every shallower one
    // has certainly run by the time the counts below are read.
    await expect(frameTarget(page, 'kid1')).toHaveText(MARK);
    await expect(
      page.frameLocator('iframe[name="nested"]').frameLocator('iframe[name="grandkid"]').locator('#target'),
    ).toHaveText(MARK);

    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });

    const snap = await waitForTabState(sm, tabId, (s) => s.badgeText === '1', 'badge count 1');
    expect(snap.title).toContain('Mark Every Frame | OK');
    // Sub-frames never get a slot in the per-tab document LRU (cap 5),
    // which they would otherwise evict the real bfcache entries from.
    // (`actual` is keyed by script id, so asserting on ITS keys would
    // read the same whether or not the frames were merged in — the
    // document count is what actually distinguishes the two.)
    expect(Object.keys(snap.record!.byDoc)).toHaveLength(1);
    expect(snap.record!.docOrder).toHaveLength(1);

    // The Log gets the top-frame start plus ONE coalesced sub-frame
    // row, no matter how many frames actually ran. Polled rather than
    // read once: the sub-frame reports are fire-and-forget, so a
    // single read could catch the log before any of them landed —
    // and "0 rows" would pass a naive `<= 1` assertion for the wrong
    // reason. Poll until the first one shows up, then hold it there.
    const countStarts = async (): Promise<[number, number]> => {
      const log = await sm.getScriptLog(scriptId);
      return [
        log.filter((e) => e.message.startsWith('Started at')).length,
        log.filter((e) => e.message.startsWith('Started in sub-frame')).length,
      ];
    };
    await expect.poll(async () => (await countStarts())[1]).toBe(1);
    // Re-read after a settle so a late fifth report would be caught.
    await page.waitForTimeout(300);
    expect(await countStarts()).toEqual([1, 1]);

    await page.close();
  });

  test('a script that runs only in a sub-frame stays off the badge', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The whole reason sub-frame `sm:start` is dropped: expected is
    // computed from the top-frame URL, so merging a frame-only script's
    // start would surface it as UNEXPECTED (orange) on a page where
    // nothing is wrong.
    scriptsDir.write({
      relativePath: 'frame-only.user.js',
      // Matches nested-frame.html and its child, never frames.html.
      meta: {
        name: 'Frame Only',
        match: [`${fixtureServer.baseUrl}/nested-frame.html`],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = ${JSON.stringify(MARK)};
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);
    // It really did run down there.
    await expect(frameTarget(page, 'nested')).toHaveText(MARK);

    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });
    // Nothing matches the top document, so the badge stays empty —
    // not "1 / UNEXPECTED / orange".
    await page.waitForTimeout(300);
    const snap = await sm.getTabState(tabId);
    expect(snap.badgeText).toBe('');
    const state = snap.record?.byDoc[snap.record.currentDocId];
    expect(state?.actual ?? {}).toEqual({});

    await page.close();
  });

  test('a sub-frame error turns the top document red', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The asymmetry with sm:start: an error is the only signal the user
    // gets, and computeBadge ranks it ERROR whether or not it was
    // expected. Also covers the message-keyed Log de-dup — the same
    // throw in four frames is one row, a different throw is another.
    scriptsDir.write({
      relativePath: 'thrower.user.js',
      meta: { name: 'Frame Thrower', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `
        if (window.top !== window) {
          // Two distinct messages across four sub-frames: the deepest
          // one throws differently from the rest.
          if (window.name === 'grandkid') throw new Error('deep frame boom');
          throw new Error('frame boom');
        }
      `,
    });
    const source = await sm.addSource(scriptsDir.path);
    await sm.syncNow();
    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);

    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });

    const snap = await waitForTabState(
      sm, tabId,
      (s) => s.title.includes('Frame Thrower | ERROR'),
      'sub-frame error reaches the badge',
    );
    // One row, on the top-level document — not one per frame.
    expect(snap.badgeText).toBe('1');
    expect(Object.keys(snap.record!.byDoc)).toHaveLength(1);

    // Log: one row per DISTINCT message, however many frames threw it.
    await expect.poll(async () => {
      const log = await sm.getScriptLog(scriptId);
      return log.filter((e) => e.message.includes('deep frame boom')).length;
    }).toBe(1);
    const log = await sm.getScriptLog(scriptId);
    expect(log.filter((e) => e.message.includes('Error: frame boom')).length).toBe(1);

    await page.close();
  });

  test('GM_registerMenuCommand from a sub-frame is not added to the tab menu', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Command ids are minted page-side, so N frames would register N
    // indistinguishable rows in one per-tab menu.
    scriptsDir.write({
      relativePath: 'menu.user.js',
      meta: {
        name: 'Menu In Frames',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_registerMenuCommand'],
      },
      body: `
        GM_registerMenuCommand(
          window.top === window ? 'from top' : 'from frame',
          () => {},
        );
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames.html`);

    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });

    // Poll for the top-frame registration, then confirm the four
    // sub-frame ones never joined it.
    await expect.poll(async () => (await sm.getActionContextMenu(tabId)).length).toBe(1);
    await page.waitForTimeout(300);
    const menu = await sm.getActionContextMenu(tabId);
    expect(menu[0].commands.map((c) => c.name)).toEqual(['from top']);

    await page.close();
  });
});
