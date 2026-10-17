// Scripts in iframes, SourceMonkey's side (docs/frames.md): one popup
// row and badge count per script however many frames it runs in, an
// "Active in frames" section for scripts that don't match the page,
// menu commands fired in the document that registered them, and runs
// that end with their frame.
//
// Uses the frames example (tests/examples/frames/), whose own spec
// covers what runs where.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { activeTabId, allScripts, waitFor, waitForTabState } from '../fixtures/sw-api';
import { ScriptsDir } from '../fixtures/scripts-dir';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(__dirname, '../examples/frames');

const EVERY = 'SourceMonkey example: frames: every frame';
const TOP_ONLY = 'SourceMonkey example: frames: top frame only';
const B_ONLY = 'SourceMonkey example: frames: Frame B only';

async function frameByPage(page: Page, name: string): Promise<Frame> {
  return waitFor(async () => {
    for (const frame of page.frames()) {
      const got = await frame.evaluate(() => document.body?.dataset.page ?? '').catch(() => '');
      if (got === name) return frame;
    }
    return null;
  }, (f) => f !== null, { label: `frame ${name}` }) as Promise<Frame>;
}

test.describe('scripts in iframes', () => {
  test('one row per script, frame-only scripts apart, menu commands per document', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    await sm.addCollection(EXAMPLE_DIR);
    await sm.syncNow();
    const byFile = Object.fromEntries((await allScripts(sm)).map((s) => [s.relativePath, s.id]));
    const ids = {
      [EVERY]: byFile['every-frame.user.js'], [TOP_ONLY]: byFile['top-only.user.js'], [B_ONLY]: byFile['frame-b-only.user.js'],
    };

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
    const tabId = await activeTabId(getServiceWorker);
    const frameA = await frameByPage(page, 'frame-a');
    await expect(frameA.locator('#log')).toContainText('Ran in frame-a');
    await expect((await frameByPage(page, 'nested')).locator('#log')).toContainText('Ran in nested');

    // Three scripts, each counted once: every-frame runs in four
    // documents, frame-b-only in one frame.
    await waitForTabState(sm, tabId, (s) => s.badgeText === '3', 'badge counts each script once');
    const view = await sm.getPopupView(tabId);
    const rowNames = (groups: typeof view.enabled) => groups.flatMap((g) => g.rows.map((r) => `${r.name}=${r.status}`));
    expect(rowNames(view.enabled).sort()).toEqual([`${EVERY}=OK`, `${TOP_ONLY}=OK`]);
    expect(rowNames(view.frames)).toEqual([`${B_ONLY}=OK`]);

    // Menu commands: the top frame's first, then each frame's.
    const menus = await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.find((x) => x.scriptId === ids[EVERY])?.commands.length === 5
        && g.some((x) => x.scriptId === ids[B_ONLY]),
      { label: 'menu commands from every document' },
    );
    const every = menus.find((x) => x.scriptId === ids[EVERY])!.commands;
    expect(every[0]!.name).toBe('Every frame: mark top');
    expect(every.map((c) => c.name).sort()).toEqual([
      'Every frame: mark all', 'Every frame: mark frame-a', 'Every frame: mark frame-b', 'Every frame: mark nested',
      'Every frame: mark top',
    ]);

    // A command fires in the document that registered it, only.
    const markA = every.find((c) => c.name === 'Every frame: mark frame-a')!;
    expect(await sm.fireActionContextMenuItem(tabId, ids[EVERY]!, markA.commandId, markA.documentId)).toEqual({ ok: true });
    await expect(frameA.locator('#log')).toContainText('Menu command ran in frame-a');
    await expect(page.locator('#log')).not.toContainText('Menu command ran');

    // A caption registered in each document shows once, and runs in all.
    const markAll = every.find((c) => c.name === 'Every frame: mark all')!;
    expect(await sm.fireActionContextMenuItem(tabId, ids[EVERY]!, markAll.commandId, markAll.documentId)).toEqual({ ok: true });
    for (const [where, doc] of [['top', page], ['frame-a', frameA], ['nested', await frameByPage(page, 'nested')]] as const) {
      await expect(doc.locator('#log')).toContainText(`Mark all ran in ${where}`);
    }

    // The Log says where a run in a frame was, and on which page, with
    // one row per page for a script's frames, counting them.
    const PAGE = String.raw`http://127\.0\.0\.1:\d+/frames/frames\.html`;
    // The install's own lines aren't about runs.
    const messages = async (id: string) => (await sm.getScriptLog(id))
      .filter((e) => e.source !== 'add').map((e) => e.message);
    // Order isn't fixed: a frame's script can start before the page's.
    await expect.poll(() => messages(ids[B_ONLY]!)).toEqual([
      expect.stringMatching(new RegExp(String.raw`^Started in an iframe at http://localhost:\d+/frames/frame-b\.html on ${PAGE}$`)),
    ]);
    await expect.poll(async () => (await messages(ids[EVERY]!)).sort()).toEqual([
      expect.stringMatching(new RegExp(String.raw`^Started 3 times in iframes on ${PAGE}, latest at http://\S+/frames/frame-(a|b|nested)\.html$`)),
      expect.stringMatching(new RegExp(String.raw`^Started at ${PAGE}$`)),
    ]);

    // Removing Frame B ends the runs in it and its nested frame: its
    // script and its commands go once the popup asks.
    await page.evaluate(() => document.getElementById('frame-b')!.remove());
    await expect.poll(async () => rowNames((await sm.getPopupView(tabId)).frames)).toEqual([]);
    const after = await sm.getActionContextMenu(tabId);
    expect(after.some((x) => x.scriptId === ids[B_ONLY])).toBe(false);
    expect(after.find((x) => x.scriptId === ids[EVERY])!.commands.map((c) => c.name).sort())
      .toEqual(['Every frame: mark all', 'Every frame: mark frame-a', 'Every frame: mark top']);
    await waitForTabState(sm, tabId, (s) => s.badgeText === '2', 'badge drops the removed frame\'s script');

    await page.close();
  });

  test('a frame navigating ends the runs of the document it left', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    await sm.addCollection(EXAMPLE_DIR);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes(`${B_ONLY} | OK`), 'frame-b-only running');

    // Frame B to Frame A's page (no frame-b-only there): the commit
    // alone prunes it, no popup needed.
    await page.evaluate(() => {
      const b = document.getElementById('frame-b') as HTMLIFrameElement;
      b.src = b.src.replace('frame-b.html', 'frame-a.html');
    });
    await waitForTabState(sm, tabId, (s) => !s.rows.some((r) => r.startsWith(B_ONLY)) && s.badgeText === '2',
      'frame-b-only gone after its frame navigated');

    await page.close();
  });

  test('dropping @noframes from an installed script lets it into frames', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Chrome updates the registration in place (`update`), so this is
    // what shows `allFrames` is applied by an update too.
    const dir = ScriptsDir.create();
    try {
      const write = (noframes: boolean) => dir.write({
        relativePath: 'marker.user.js',
        meta: {
          name: 'Frame marker',
          match: [`${fixtureServer.baseUrl}/frames/*`],
          runAt: 'document-end',
          extra: noframes ? ['// @noframes'] : [],
        },
        body: `document.body.dataset.marked = 'yes';`,
      });
      write(true);
      const collection = await sm.addCollection(dir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      const marked = async (name: string) =>
        (await frameByPage(page, name)).evaluate(() => document.body.dataset.marked ?? 'no');
      await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
      await expect.poll(() => marked('top')).toBe('yes');
      expect(await marked('frame-a')).toBe('no');

      write(false);
      await sm.updateCollection(collection!.id, 'manual');
      await sm.syncNow();
      await page.reload();
      await expect.poll(() => marked('frame-a')).toBe('yes');
      await page.close();
    } finally {
      dir.cleanup();
    }
  });

  test('header warnings print once per page; frames with no URL get no script', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const dir = ScriptsDir.create();
    try {
      // An unknown @grant earns each a header warning (`startupLogs`).
      for (const [file, match] of [
        ['everywhere.user.js', `${fixtureServer.baseUrl.replace('127.0.0.1', '*')}/frames/*`],
        ['frames-only.user.js', '*://*/frames/frame-*.html'],
      ] as const) {
        dir.write({
          relativePath: file,
          meta: { name: file, match: [match], runAt: 'document-end', grant: ['GM_noSuchApi'] },
          body: `document.documentElement.dataset.ran = (document.documentElement.dataset.ran ?? '') + '${file} ';`,
        });
      }
      await sm.addCollection(dir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      const warnings: string[] = [];
      page.on('console', (m) => { if (m.text().includes('GM_noSuchApi')) warnings.push(m.text()); });
      await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
      const nested = await frameByPage(page, 'nested');
      await expect.poll(() => nested.evaluate(() => (document.documentElement.dataset.ran ?? '').trim().split(' ').sort()))
        .toEqual(['everywhere.user.js', 'frames-only.user.js']);
      // Four documents run `everywhere`, three run `frames-only`: one
      // warning each.
      await expect.poll(() => warnings.length).toBe(2);
      // And no late duplicate.
      await page.waitForTimeout(1000);
      expect(warnings).toHaveLength(2);
      expect(warnings.some((w) => w.includes('everywhere.user.js'))).toBe(true);
      expect(warnings.some((w) => w.includes('frames-only.user.js'))).toBe(true);

      // Frames with no URL of their own match nothing.
      await page.evaluate(() => {
        for (const make of [(f: HTMLIFrameElement) => { f.srcdoc = '<p>srcdoc</p>'; }, (f: HTMLIFrameElement) => { f.src = 'about:blank'; }]) {
          const f = document.createElement('iframe');
          f.className = 'no-url';
          make(f);
          document.body.append(f);
        }
      });
      await page.waitForTimeout(500);
      const noUrl = page.frames().filter((f) => f.url().startsWith('about:'));
      expect(noUrl).toHaveLength(2);
      for (const f of noUrl) expect(await f.evaluate(() => document.documentElement.dataset.ran ?? '')).toBe('');
      await page.close();
    } finally {
      dir.cleanup();
    }
  });
});
