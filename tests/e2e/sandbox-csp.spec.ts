// Pages served with a `Content-Security-Policy: sandbox` header (no
// `allow-scripts`). Sites serving user uploads send it to stop XSS, and
// with it Chrome turns off script in the page's own world: a MAIN-world
// userscript (`@grant none`) is silently never injected, while a
// USER_SCRIPT-world one still runs. SourceMonkey's badge shows MISSING,
// and after the load the script's Log gets a warning saying why
// (src/extension/missing-scripts.ts).
//
// The header has to come from a real response (`sandbox` is ignored in
// a <meta> CSP), so each page is served with `page.route`.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import {
  waitFor, waitForTabState, activeTabId, type SmApi, type TabStateSnapshot,
} from '../fixtures/sw-api';

// A 1x1 transparent PNG, for the standalone-image-document case.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const HTML = '<!doctype html><html><head><title>sandboxed</title></head><body><p>hi</p></body></html>';

async function serveWithCsp(
  page: Page,
  url: string,
  csp: string,
  kind: 'html' | 'png',
): Promise<void> {
  await page.route(url, (route) => route.fulfill({
    status: 200,
    headers: {
      'Content-Type': kind === 'html' ? 'text/html; charset=utf-8' : 'image/png',
      'Content-Security-Policy': csp,
    },
    body: kind === 'html' ? HTML : PNG_1X1,
  }));
}

// Each script marks <html> so the test can see which ones ran; the DOM
// is shared across worlds, so this works for both.
function writeMarkerScripts(dir: ScriptsDir, baseUrl: string): void {
  dir.write({
    relativePath: 'main-world.user.js',
    meta: { name: 'MainWorld', match: [`${baseUrl}/*`], grant: ['none'], runAt: 'document-start' },
    body: `document.documentElement.setAttribute('data-main-ran', '1');`,
  });
  dir.write({
    relativePath: 'content-world.user.js',
    meta: {
      name: 'ContentWorld',
      match: [`${baseUrl}/*`],
      grant: ['none'],
      runAt: 'document-start',
      extra: ['// @inject-into content'],
    },
    body: `document.documentElement.setAttribute('data-content-ran', '1');`,
  });
}

function scriptIdsByName(snap: TabStateSnapshot): Record<string, string> {
  const doc = snap.record!.byDoc[snap.record!.currentDocId];
  return Object.fromEntries(doc.matches.map((m) => [m.name, m.id]));
}

// The worker writes it 11s after the load: its grace period for late
// starters (MISSING_SCRIPT_GRACE_MS) outlasts the wrapper's 10s wait
// for a run decision.
async function waitForWarning(sm: SmApi, scriptId: string): Promise<string> {
  const log = await waitFor(
    () => sm.getScriptLog(scriptId),
    (entries) => entries.some((e) => e.level === 'warning'),
    { timeoutMs: 20_000, label: 'never-started warning' },
  );
  return log.find((e) => e.level === 'warning')!.message;
}

test.describe('CSP sandbox pages', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  for (const kind of ['html', 'png'] as const) {
    test(`${kind}: MAIN-world script is not injected, USER_SCRIPT-world one runs`, async ({
      extensionContext, fixtureServer, sm, getServiceWorker,
    }) => {
      writeMarkerScripts(scriptsDir, fixtureServer.baseUrl);
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      const url = `${fixtureServer.baseUrl}/sandboxed.${kind}`;
      await serveWithCsp(page, url, 'sandbox', kind);
      await page.goto(url);
      const tabId = await activeTabId(getServiceWorker);

      const snap = await waitForTabState(
        sm,
        tabId,
        (s) => s.title.includes('ContentWorld | OK') && s.title.includes('MainWorld | MISSING'),
        'ContentWorld OK + MainWorld MISSING',
      );
      expect(snap.title).toContain('MainWorld | MISSING');

      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-content-ran', '1');
      expect(await html.getAttribute('data-main-ran')).toBeNull();

      // After the load, the missing script's Log says why: ContentWorld's
      // report told the worker the page is sandboxed.
      const ids = scriptIdsByName(snap);
      const warning = await waitForWarning(sm, ids.MainWorld);
      expect(warning).toContain(`Matched ${url} but never started there. This page is sandboxed`);
      expect(warning).toContain('@inject-into content');
      expect((await sm.getScriptLog(ids.ContentWorld)).some((e) => e.level === 'warning')).toBe(false);
      await page.close();
    });
  }

  test('only a MAIN-world script: the warning says the page may be blocking it', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // No other script runs here to report the opaque origin, so the
    // worker can only name the likely cause.
    scriptsDir.write({
      relativePath: 'main-world.user.js',
      meta: { name: 'MainWorld', match: [`${fixtureServer.baseUrl}/*`], grant: ['none'], runAt: 'document-start' },
      body: `document.documentElement.setAttribute('data-main-ran', '1');`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const url = `${fixtureServer.baseUrl}/sandboxed-alone.html`;
    await serveWithCsp(page, url, 'sandbox', 'html');
    await page.goto(url);
    const tabId = await activeTabId(getServiceWorker);
    const snap = await waitForTabState(sm, tabId, (s) => s.title.includes('MainWorld | MISSING'), 'MainWorld MISSING');

    const warning = await waitForWarning(sm, scriptIdsByName(snap).MainWorld);
    expect(warning).toContain('The page may be blocking scripts in its own context');
    await page.close();
  });

  test('sandbox allow-scripts: MAIN-world script runs', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    writeMarkerScripts(scriptsDir, fixtureServer.baseUrl);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const url = `${fixtureServer.baseUrl}/sandboxed-allow.html`;
    await serveWithCsp(page, url, 'sandbox allow-scripts', 'html');
    await page.goto(url);
    const tabId = await activeTabId(getServiceWorker);

    await waitForTabState(
      sm,
      tabId,
      (s) => s.title.includes('ContentWorld | OK') && s.title.includes('MainWorld | OK'),
      'both OK',
    );
    await expect(page.locator('html')).toHaveAttribute('data-main-ran', '1');
    await page.close();
  });

  // What the extension APIs can see on such a page, pinned because a
  // diagnosis could rely on it:
  //   - MAIN world: executeScript doesn't throw; it resolves with a
  //     null result, since the function never ran.
  //   - ISOLATED world: runs, and sees the opaque origin `sandbox` gives
  //     the document (`self.origin === 'null'`).
  test('probe: chrome.scripting.executeScript on a sandboxed page', async ({
    extensionContext, fixtureServer, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    const url = `${fixtureServer.baseUrl}/sandboxed-probe.html`;
    await serveWithCsp(page, url, 'sandbox', 'html');
    await page.goto(url);
    const tabId = await activeTabId(getServiceWorker);

    const sw = await getServiceWorker();
    const result = await sw.evaluate(async (tabId) => {
      const run = async (world: 'MAIN' | 'ISOLATED') => {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            world,
            func: () => ({ ok: true, origin: String(self.origin) }),
          });
          return { results: r.map((x) => x.result ?? null) };
        } catch (e) {
          return { error: String((e as Error).message ?? e) };
        }
      };
      return { main: await run('MAIN'), isolated: await run('ISOLATED') };
    }, tabId);
    expect(result).toEqual({
      main: { results: [null] },
      isolated: { results: [{ ok: true, origin: 'null' }] },
    });
    await page.close();
  });
});
