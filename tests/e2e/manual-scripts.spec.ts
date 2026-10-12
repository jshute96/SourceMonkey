// Manual scripts (`@run-at context-menu`): never registered, listed in
// the popup's Manual section, and run on request with "Run this
// script". The worker's `runManualScript` test surface stands in for
// the popup click, except in the last test, which clicks the popup
// page itself. Design: docs/manual-scripts.md.

import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { bridgeRequest } from '../fixtures/bridge-forge';
import { activeTabId, allScripts, hasBadgeColor, waitForTabState, type SmApi } from '../fixtures/sw-api';
import {
  MANUAL_RUN_COLLECTION_OFF, MANUAL_RUN_NOT_HERE, MANUAL_RUN_NOT_MANUAL, MANUAL_RUN_SCRIPT_OFF, MANUAL_RUN_SM_DEV,
} from '../../lib/sm-dev-protocol.js';

const RED = '#d32f2f';
const GREEN = '#2e7d32';

async function idOf(sm: SmApi, relativePath: string): Promise<string> {
  const row = (await allScripts(sm)).find((s) => s.relativePath === relativePath);
  if (!row) throw new Error(`no stored script ${relativePath}`);
  return row.id;
}

async function openPopup(context: BrowserContext, extensionId: string, tabId: number): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await expect(popup.locator('body[data-ready="true"]')).toBeAttached();
  return popup;
}

test.describe('manual scripts (@run-at context-menu)', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('not registered, not run on load, and not missing; each run starts it again', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'manual.user.js',
      meta: { name: 'Manual', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu' },
      body: `document.body.dataset.runs = String(Number(document.body.dataset.runs || 0) + 1);`,
    });
    await sm.addCollection(scriptsDir.path);
    const synced = await sm.syncNow();
    const id = await idOf(sm, 'manual.user.js');
    expect(synced.registered.map((r) => r.id)).not.toContain(id);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    // Give a load-time script every chance to have run.
    await page.waitForLoadState('load');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.body.dataset.runs)).toBeUndefined();
    // Nothing expected it, so the badge has nothing to count.
    expect((await sm.getTabState(tabId)).badgeText).toBe('');

    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(() => document.body.dataset.runs)).toBe('1');
    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(() => document.body.dataset.runs)).toBe('2');
    await expect.poll(async () => (await sm.getTabState(tabId)).badgeText).toBe('1');

    // A reload starts over: not run in the new document.
    await page.reload();
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => document.body.dataset.runs)).toBeUndefined();
    const view = await sm.getPopupView(tabId);
    expect(view.manual[0].rows.map((r) => r.status)).toEqual(['NOT_RUN']);
    await page.close();
  });

  test('a page-world script runs through the bridge, with no other script on the page', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'page-world.user.js',
      meta: { name: 'Page world', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu', grant: ['none'] },
      body: `window.__manualRan = (window.__manualRan || 0) + 1;`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'page-world.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    // The page sees it: MAIN world.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __manualRan?: number }).__manualRan)).toBe(1);
    // Its start report came back over the bridge.
    await expect.poll(async () => (await sm.getPopupView(tabId)).manual[0]?.rows[0]?.status).toBe('OK');
    await page.close();
  });

  test('a page-world script\'s reports go through once where the bridge is registered already', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'page-world.user.js',
      meta: { name: 'Page world', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu', grant: ['none'] },
      body: '',
    });
    // Runs on load in the page's world, so the bridge is registered here.
    scriptsDir.write({
      relativePath: 'on-load.user.js',
      meta: { name: 'On load', match: [`${fixtureServer.baseUrl}/*`], grant: ['none'] },
      body: '',
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'page-world.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    await expect.poll(async () => (await sm.getPopupView(tabId)).enabled[0]?.rows[0]?.status).toBe('OK');
    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    const starts = async () => (await sm.getScriptLog(id)).filter((e) => e.message.startsWith('Started at')).length;
    await expect.poll(starts).toBe(1);
    await page.waitForTimeout(300);
    expect(await starts()).toBe(1);
    await page.close();
  });

  test('page-world manual runs: a GM call goes through, and two scripts in one document each work', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Each run's bridge relays only its script's traffic (docs/manual-scripts.md):
    // an XHR request names the script as `scriptId` (its `id` is the
    // request's own), and a second script's runs get a bridge of their own.
    scriptsDir.write({
      relativePath: 'fetcher.user.js',
      meta: {
        name: 'Fetcher', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu',
        grant: ['GM_xmlhttpRequest'], extra: ['// @connect 127.0.0.1'],
      },
      body: `GM_xmlhttpRequest({ url: location.href, onload: (r) => { document.body.dataset.fetched = String(r.status); } });`,
    });
    scriptsDir.write({
      relativePath: 'storer.user.js',
      meta: { name: 'Storer', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu', grant: ['GM_setValue', 'GM_getValue'] },
      body: `GM_setValue('n', GM_getValue('n', 0) + 1); document.body.dataset.stored = String(GM_getValue('n'));`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const fetcher = await idOf(sm, 'fetcher.user.js');
    const storer = await idOf(sm, 'storer.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    expect(await sm.runManualScript(tabId, fetcher)).toEqual({ ok: true });
    await expect(page.locator('body')).toHaveAttribute('data-fetched', '200');
    expect(await sm.runManualScript(tabId, storer)).toEqual({ ok: true });
    await expect(page.locator('body')).toHaveAttribute('data-stored', '1');
    await expect.poll(async () => (await sm.getGmValues(storer)).n).toBe(1);
    // A second run of the same script picks up where the first left off.
    expect(await sm.runManualScript(tabId, storer)).toEqual({ ok: true });
    await expect(page.locator('body')).toHaveAttribute('data-stored', '2');
    await page.close();
  });

  test('says why it can\'t run: not manual, not this page, turned off', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'manual.user.js',
      meta: { name: 'Manual', match: [`${fixtureServer.baseUrl}/only-here/*`], runAt: 'context-menu' },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'load.user.js',
      meta: { name: 'On load', match: [`${fixtureServer.baseUrl}/*`] },
      body: '',
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const manual = await idOf(sm, 'manual.user.js');
    const onLoad = await idOf(sm, 'load.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    expect((await sm.runManualScript(tabId, onLoad)).error).toBe(MANUAL_RUN_NOT_MANUAL);
    expect((await sm.runManualScript(tabId, manual)).error).toBe(MANUAL_RUN_NOT_HERE);
    await sm.setScriptEnabled(manual, false);
    await sm.syncNow();
    expect((await sm.runManualScript(tabId, manual)).error).toBe(MANUAL_RUN_SCRIPT_OFF);
    await page.close();
  });

  test('says when its collection is off, and in a tab an sm-dev run controls, keeps the person\'s own script out', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'manual.user.js',
      meta: { name: 'Manual', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu' },
      body: '',
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'manual.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    await sm.setCollectionEnabled(added!.id, false);
    await sm.syncNow();
    expect((await sm.runManualScript(tabId, id)).error).toBe(MANUAL_RUN_COLLECTION_OFF);
    await sm.setCollectionEnabled(added!.id, true);
    await sm.syncNow();

    await sm.claimTab(tabId, 'run-x', 60_000);
    await page.reload();
    expect((await sm.runManualScript(tabId, id)).error).toBe(MANUAL_RUN_SM_DEV);
    // The popup doesn't offer what the worker won't do.
    const row = (await sm.getPopupView(tabId)).manual[0].rows[0];
    expect(row.runnable).toBeUndefined();
    await sm.releaseRun('run-x');
    await page.close();
  });

  test('a page can\'t use a page-world manual script\'s powers where it wasn\'t run', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'stash.user.js',
      meta: {
        name: 'Stash', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu',
        grant: ['GM_setValue', 'GM_getValue', 'unsafeWindow'],
      },
      body: `GM_setValue('secret', 'canary-41c7');`,
    });
    // Runs on load in the page's world, so the bridge is there to forge through.
    scriptsDir.write({
      relativePath: 'filler.user.js',
      meta: { name: 'Filler', match: [`${fixtureServer.baseUrl}/*`], grant: ['none'] },
      body: '',
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'stash.user.js');

    // Store the secret with one run in another tab.
    const first = await extensionContext.newPage();
    await first.goto(`${fixtureServer.baseUrl}/`);
    expect(await sm.runManualScript(await activeTabId(getServiceWorker), id)).toEqual({ ok: true });
    await expect.poll(async () => (await sm.getGmValues(id)).secret).toBe('canary-41c7');
    await first.close();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    await expect.poll(async () => (await sm.getPopupView(await activeTabId(getServiceWorker))).enabled[0]?.rows[0]?.status).toBe('OK');
    // As a page with the channel key could: the SW-side gate behind it.
    const key = await sm.channelKey();
    const forge = (): Promise<unknown> => bridgeRequest(page, key, { type: 'sm:gm-resync', scriptId: id });

    // Not run in this document: refused.
    const refused = await forge();
    expect(refused, 'the bridge should answer').not.toBeNull();
    expect(JSON.stringify(refused)).not.toContain('canary-41c7');
    // Once run here, the page shares its world, as with any page-world script.
    expect(await sm.runManualScript(await activeTabId(getServiceWorker), id)).toEqual({ ok: true });
    expect(JSON.stringify(await forge())).toContain('canary-41c7');
    await page.close();
  });

  test('a run sees values another tab wrote since its last run here', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'count.user.js',
      meta: { name: 'Count', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu', grant: ['GM_setValue', 'GM_getValue'] },
      body: `const n = GM_getValue('n', 0) + 1; GM_setValue('n', n); document.body.dataset.n = String(n);`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'count.user.js');

    const a = await extensionContext.newPage();
    await a.goto(`${fixtureServer.baseUrl}/`);
    const tabA = await activeTabId(getServiceWorker);
    expect(await sm.runManualScript(tabA, id)).toEqual({ ok: true });
    await expect.poll(() => a.evaluate(() => document.body.dataset.n)).toBe('1');
    await expect.poll(async () => (await sm.getGmValues(id)).n).toBe(1);

    // Another tab's write, which this tab's copy never hears about.
    await sm.dropGmOpenersForTests();
    await sm.writeGmValues(id, [{ key: 'n', value: 10 }]);

    await a.bringToFront();
    expect(await sm.runManualScript(tabA, id)).toEqual({ ok: true });
    await expect.poll(() => a.evaluate(() => document.body.dataset.n)).toBe('11');
    // Right away, so the last run's write is likely not flushed yet:
    // the new run keeps it rather than the worker's older copy.
    expect(await sm.runManualScript(tabA, id)).toEqual({ ok: true });
    await expect.poll(() => a.evaluate(() => document.body.dataset.n)).toBe('12');
    await a.close();
  });

  test('a run that throws shows Error, as on load, and the next run shows its own outcome', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const write = (body: string) => scriptsDir.write({
      relativePath: 'flaky.user.js',
      meta: { name: 'Flaky', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu' },
      body,
    });
    write(`throw new Error('Boom from a manual run');`);
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'flaky.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    const row = async () => (await sm.getPopupView(tabId)).manual[0].rows[0];

    // Chrome ran it, so the run itself succeeded; the script threw.
    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    await expect.poll(async () => (await row()).status).toBe('ERROR');
    expect((await row()).tooltip).toContain('Boom from a manual run');
    await waitForTabState(sm, tabId, (st) => hasBadgeColor(st, RED) && st.badgeText === '1', 'red badge');

    // Fixed on disk: the next run uses the new copy, and its outcome
    // replaces the last one's.
    write(`document.body.dataset.fixed = '1';`);
    await sm.updateCollection(added!.id, 'manual');
    await sm.syncNow();
    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(() => document.body.dataset.fixed)).toBe('1');
    await expect.poll(async () => (await row()).status).toBe('OK');
    await waitForTabState(sm, tabId, (st) => hasBadgeColor(st, GREEN) && st.badgeText === '1', 'green badge');

    // Broken again: back to Error.
    write(`throw new Error('Boom again');`);
    await sm.updateCollection(added!.id, 'manual');
    await sm.syncNow();
    expect(await sm.runManualScript(tabId, id)).toEqual({ ok: true });
    await expect.poll(async () => (await row()).tooltip).toContain('Boom again');
    expect((await row()).status).toBe('ERROR');
    await page.close();
  });

  test('a script that doesn\'t parse is Invalid, as on load, and isn\'t run', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'broken.user.js',
      meta: { name: 'Broken', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu' },
      body: `document.body.dataset.ran = '1'; {`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'broken.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    const view = await sm.getPopupView(tabId);
    const row = view.manual[0].rows[0];
    expect(row.status).toBe('INVALID');
    expect(row.runnable).toBeUndefined();
    const refused = await sm.runManualScript(tabId, id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^Syntax error: /);
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
    await page.close();
  });

  test('the popup lists it under Manual, and Run this script runs it, with the run\'s commands after it', async ({
    extensionContext, extensionId, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'manual.user.js',
      meta: { name: 'Manual', match: [`${fixtureServer.baseUrl}/*`], runAt: 'context-menu', grant: ['GM_registerMenuCommand'] },
      body: `
        const n = Number(document.body.dataset.runs || 0) + 1;
        document.body.dataset.runs = String(n);
        GM_registerMenuCommand('From run ' + n, () => {});
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/`);
    const tabId = await activeTabId(getServiceWorker);
    const popup = await openPopup(extensionContext, extensionId, tabId);
    const section = popup.locator('section[data-section="manual"]');
    await expect(section.locator('.section-head')).toHaveText('Manual');
    await expect(section.locator('.pill')).toHaveText('Not run');

    await section.locator('button.run-script').click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.runs)).toBe('1');
    // The popup stays open and catches up.
    await expect(section.locator('.pill')).toHaveText('Running');
    await expect(section.locator('.commands button')).toHaveText(['Run this script', 'From run 1']);

    // Another run's command replaces the first one's.
    await section.locator('button.run-script').click();
    await expect(section.locator('.commands button')).toHaveText(['Run this script', 'From run 2']);
    await popup.close();
    await page.close();
  });
});
