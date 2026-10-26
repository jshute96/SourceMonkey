// "Run now": running a script that runs on load into the page it's
// open on, without a reload. From the popup's script menu, its page
// menu, and sm-dev's `run-now`, which all go through the worker's
// `runScriptNow` (its test surface stands in for them here, except
// where a test clicks the popup page itself). Design: docs/run-now.md.

import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId, allScripts, hasBadgeColor, waitForTabState, type SmApi } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const GREY = '#757575';
const DOCUMENT_START = 'This script runs at document-start, but the page has already loaded';
const RERUN = 'A copy of this script is already running here. Its listeners, timers and changes to the page stay.';

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

const rowOf = async (sm: SmApi, tabId: number, id: string) => {
  const view = await sm.getPopupView(tabId);
  return [...view.enabled, ...view.frames, ...view.disabled].flatMap((g) => g.rows).find((r) => r.id === id);
};

test.describe('run now', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('after a reload with no userscripts, runs one; the badge counts what runs', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'early.user.js',
      meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start' },
      body: `document.documentElement.dataset.early = 'ran';`,
    });
    scriptsDir.write({
      relativePath: 'late.user.js',
      meta: { name: 'Late', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'late ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const early = await idOf(sm, 'early.user.js');
    const late = await idOf(sm, 'late.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('late ran');
    const tabId = await activeTabId(getServiceWorker);
    await sm.reloadWithoutScripts(tabId);
    await expect(page).toHaveTitle('target');
    await waitForTabState(sm, tabId, (s) => s.badgeText === '2' && hasBadgeColor(s, GREY), 'grey, both kept out');
    expect((await rowOf(sm, tabId, late))!.runNow).toEqual({ kind: 'run', warnings: [] });
    expect((await rowOf(sm, tabId, early))!.runNow).toEqual({ kind: 'run', warnings: [DOCUMENT_START] });

    expect(await sm.runScriptNow(tabId, late)).toEqual({ ok: true, rerun: false, warnings: [] });
    await expect(page).toHaveTitle('late ran');
    // Only what tried to run counts now, in its own color.
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '1' && hasBadgeColor(s, GREEN) && s.rows.includes('Late | OK') && s.rows.includes('Early | NOT_LOADED'),
      'Late running, Early still kept out',
    );
    const row = (await rowOf(sm, tabId, late))!;
    expect(row.tooltip).toMatch(/^Run manually\n/);
    expect(row.runNow).toBeUndefined();
    const logged = (await sm.getScriptLog(late)).find((e) => e.message.startsWith('Run manually on'));
    expect(logged?.level).toBe('info');

    // Late, and with a warning: the page has loaded.
    expect(await sm.runScriptNow(tabId, early)).toEqual({ ok: true, rerun: false, warnings: [DOCUMENT_START] });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.early ?? null)).toBe('ran');
    await waitForTabState(sm, tabId, (s) => s.badgeText === '2' && s.rows.includes('Early | OK'), 'both running');
    await page.close();
  });

  test('a disabled page-world script runs, reaches GM storage through the bridge, and asks for no reload', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'off.user.js',
      meta: { name: 'Off', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant: ['GM_setValue'] },
      body: `GM_setValue('ran', 'yes'); document.title = 'off ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    const id = await idOf(sm, 'off.user.js');
    await sm.setScriptEnabled(id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await page.waitForLoadState('load');
    await expect(page).toHaveTitle('target');
    expect((await rowOf(sm, tabId, id))!.runNow).toEqual({ kind: 'run', warnings: [] });

    expect(await sm.runScriptNow(tabId, id)).toEqual({ ok: true, rerun: false, warnings: [] });
    await expect(page).toHaveTitle('off ran');
    // A page-world script's GM call is let through for the document it
    // was run in, though the script is off.
    await expect.poll(() => sm.getGmValues(id)).toEqual({ ran: 'yes' });
    await expect.poll(async () => (await rowOf(sm, tabId, id))?.status).toBe('OK');
    const view = await sm.getPopupView(tabId);
    expect(view.enabled.flatMap((g) => g.rows).map((r) => r.id)).toContain(id);
    expect(view.banner).toBeNull();

    // A reload goes back to the usual rules: it's off.
    await page.reload();
    await page.waitForLoadState('load');
    await expect(page).toHaveTitle('target');
    await page.close();
  });

  test('an updated script reruns its new version, dropping the old copy\'s menu commands', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const write = (version: string) => scriptsDir.write({
      relativePath: 'live.user.js',
      meta: {
        name: 'Live', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end',
        grant: ['GM_registerMenuCommand'], extra: [`// @version ${version}`],
      },
      body: `document.body.dataset.ver = '${version}'; GM_registerMenuCommand('Command ${version}', () => {});`,
    });
    // Versions of different lengths, so the refresh sees a change by size.
    write('1');
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'live.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await expect.poll(() => page.evaluate(() => document.body.dataset.ver)).toBe('1');
    const commands = async () => (await sm.getActionContextMenu(tabId)).flatMap((g) => g.commands.map((c) => c.name));
    await expect.poll(commands).toEqual(['Command 1']);

    write('2.0');
    await sm.updateCollection(added!.id, 'manual');
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Live | RELOAD'), 'Updated');
    const view = await sm.getPopupView(tabId);
    expect(view.rerunUpdated).toEqual({ ids: [id], warnings: [RERUN] });
    expect((await rowOf(sm, tabId, id))!.runNow).toEqual({ kind: 'rerun', warnings: [RERUN] });

    expect(await sm.runScriptNow(tabId, id)).toEqual({ ok: true, rerun: true, warnings: [RERUN] });
    await expect.poll(() => page.evaluate(() => document.body.dataset.ver)).toBe('2.0');
    await expect.poll(commands).toEqual(['Command 2.0']);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Live | OK'), 'running the new version');
    expect((await rowOf(sm, tabId, id))!.tooltip).toMatch(/^Rerun manually\n/);
    expect((await sm.getPopupView(tabId)).banner).toBeNull();
    await page.close();
  });

  test('runs in each matching frame, even when the top page doesn\'t match', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'frame.user.js',
      meta: { name: 'Frame A', match: [`${fixtureServer.baseUrl}/frames/frame-a.html`], runAt: 'document-end' },
      body: `document.body.dataset.ranNow = 'yes';`,
    });
    await sm.addCollection(scriptsDir.path);
    const id = await idOf(sm, 'frame.user.js');
    await sm.setScriptEnabled(id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
    const tabId = await activeTabId(getServiceWorker);
    await page.waitForLoadState('load');
    const frameA = page.frameLocator('#frame-a');
    await expect(frameA.locator('body')).toBeAttached();

    expect(await sm.runScriptNow(tabId, id)).toEqual({ ok: true, rerun: false, warnings: [] });
    await expect(frameA.locator('body')).toHaveAttribute('data-ran-now', 'yes');
    expect(await page.evaluate(() => document.body.dataset.ranNow ?? null)).toBeNull();
    // Listed with the scripts running only in frames.
    await expect.poll(async () => (await sm.getPopupView(tabId)).frames.flatMap((g) => g.rows).map((r) => `${r.name}=${r.status}`))
      .toEqual(['Frame A=OK']);
    await page.close();
  });

  test('reloading with a script runs it in matching frames, including ones added later', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'frame.user.js',
      meta: { name: 'Frame A', match: [`${fixtureServer.baseUrl}/frames/frame-a.html`], runAt: 'document-start' },
      body: `document.documentElement.dataset.runs = String(Number(document.documentElement.dataset.runs || 0) + 1);`,
    });
    await sm.addCollection(scriptsDir.path);
    const id = await idOf(sm, 'frame.user.js');
    await sm.setScriptEnabled(id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
    const tabId = await activeTabId(getServiceWorker);
    await page.waitForLoadState('load');
    const reloaded = page.waitForEvent('load');
    await sm.reloadWithScript(tabId, id);
    await reloaded;
    // The top page doesn't match, so only the frame runs it, once.
    const runsIn = (sel: string) => page.frameLocator(sel).locator('html');
    await expect(runsIn('#frame-a')).toHaveAttribute('data-runs', '1');
    expect(await page.evaluate(() => document.documentElement.dataset.runs ?? null)).toBeNull();

    // An iframe added after the load gets it too.
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.id = 'late';
      f.src = 'frame-a.html';
      document.body.append(f);
    });
    await expect(runsIn('#late')).toHaveAttribute('data-runs', '1');
    await expect(runsIn('#frame-a')).toHaveAttribute('data-runs', '1');
    // No warning that the page had already loaded.
    const entries = (await sm.getScriptLog(id)).map((e) => e.message);
    expect(entries.filter((m) => m.startsWith('Run manually'))).toHaveLength(2);
    expect(entries.some((m) => m.includes(DOCUMENT_START))).toBe(false);

    // A plain reload ends it.
    const again = page.waitForEvent('load');
    await page.reload();
    await again;
    await expect(page.frameLocator('#frame-a').locator('body')).toBeAttached();
    // Long enough for a run the worker would start.
    await page.waitForTimeout(500);
    expect(await page.frameLocator('#frame-a').locator('html').getAttribute('data-runs')).toBeNull();
    await page.close();
  });

  test('a page it doesn\'t match is refused', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'elsewhere.user.js',
      meta: { name: 'Elsewhere', match: ['https://elsewhere.example/*'] },
      body: '',
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = await idOf(sm, 'elsewhere.user.js');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    expect(await sm.runScriptNow(tabId, id)).toEqual({
      ok: false, error: 'This script\'s @match and @include rules don\'t cover this page or its iframes',
    });
    await page.close();
  });

  test('the popup: a disabled script\'s menu runs it now, or reloads with it', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    scriptsDir.write({
      relativePath: 'off.user.js',
      meta: { name: 'Off', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.body.dataset.runs = String(Number(document.body.dataset.runs || 0) + 1);`,
    });
    await sm.addCollection(scriptsDir.path);
    const id = await idOf(sm, 'off.user.js');
    await sm.setScriptEnabled(id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await page.waitForLoadState('load');
    const popup = await openPopup(extensionContext, extensionId, tabId);
    const menuItems = popup.locator('.menu button[role="menuitem"]');

    await popup.locator(`[data-script-id="${id}"] button.more-menu`).click();
    // "Reload page with this script" stands in for only / without.
    await expect(menuItems).toHaveText(['Script details', 'Script log', 'Reload page with this script', 'Run now']);
    await menuItems.filter({ hasText: 'Run now' }).click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.runs)).toBe('1');
    // Redrawn: running now, though it's off.
    await expect(popup.locator(`[data-script-id="${id}"] .pill`)).toHaveText('Running');

    await popup.locator(`[data-script-id="${id}"] button.more-menu`).click();
    const reloaded = page.waitForEvent('load');
    await menuItems.filter({ hasText: 'Reload page with this script' }).click();
    await reloaded;
    // A new document, where it ran once, though it's off.
    await expect.poll(() => page.evaluate(() => document.body.dataset.runs)).toBe('1');
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Off | OK'), 'running after the reload');
    await popup.close();
    await page.close();
  });
});
