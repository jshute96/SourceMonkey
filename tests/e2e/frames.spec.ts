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
    // frames.html has four same-origin documents below the top one.
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
    // One script, one row — not one per frame.
    const rows = snap.record!.byDoc[snap.record!.currentDocId];
    expect(Object.keys(rows.actual)).toEqual([scriptId]);
    // Sub-frames never get a slot in the per-tab document LRU (cap 5),
    // which they would otherwise evict the real bfcache entries from.
    expect(snap.record!.docOrder).toHaveLength(1);

    // The Log gets the top-frame start plus ONE coalesced sub-frame
    // row, no matter how many frames actually ran.
    const log = await sm.getScriptLog(scriptId);
    const starts = log.filter((e) => e.message.startsWith('started at'));
    const frameStarts = log.filter((e) => e.message.startsWith('started in sub-frame'));
    expect(starts).toHaveLength(1);
    expect(frameStarts).toHaveLength(1);

    await page.close();
  });
});
