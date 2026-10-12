// Pages served with a `Content-Security-Policy: sandbox` header (no
// `allow-scripts`). Sites serving user uploads send it to stop XSS, and
// with it Chrome turns off script in the page's own world: a MAIN-world
// userscript (`@grant none`) is never injected, while a USER_SCRIPT-world
// one still runs. The bridge notices and has the worker run the MAIN-world
// script in USER_SCRIPT world instead (`runBlockedMainScripts` in
// background.ts). Where that fails, the badge shows MISSING and the
// script's Log says why (src/extension/missing-scripts.ts, unit-tested).
//
// The header has to come from a real response (`sandbox` is ignored in
// a <meta> CSP), so each page is served with `page.route`.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import {
  waitForTabState, activeTabId, type TabStateSnapshot,
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
    // Counted, so a script run both ways would show.
    body: `const h = document.documentElement; h.setAttribute('data-main-ran', String(+(h.getAttribute('data-main-ran') || 0) + 1));`,
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

test.describe('CSP sandbox pages', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  for (const kind of ['html', 'png'] as const) {
    test(`${kind}: the MAIN-world script runs isolated instead, beside the USER_SCRIPT-world one`, async ({
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
        (s) => s.rows.includes('ContentWorld | OK') && s.rows.includes('MainWorld | OK'),
        'both OK',
      );
      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-content-ran', '1');
      await expect(html).toHaveAttribute('data-main-ran', '1');
      const ids = scriptIdsByName(snap);
      expect((await sm.getScriptLog(ids.MainWorld)).some((e) => e.level === 'warning')).toBe(false);
      await page.close();
    });
  }

  test('only a MAIN-world script: it runs isolated too', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // The bridge is there for the MAIN-world script alone, and its own
    // origin check is what spots the sandbox.
    scriptsDir.write({
      relativePath: 'main-world.user.js',
      meta: { name: 'MainWorld', match: [`${fixtureServer.baseUrl}/*`], grant: ['GM_setValue', 'GM_getValue'], runAt: 'document-end' },
      body: `GM_setValue('k', 'v'); document.documentElement.setAttribute('data-main-ran', GM_getValue('k'));`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const url = `${fixtureServer.baseUrl}/sandboxed-alone.html`;
    await serveWithCsp(page, url, 'sandbox', 'html');
    await page.goto(url);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('MainWorld | OK'), 'MainWorld OK');
    await expect(page.locator('html')).toHaveAttribute('data-main-ran', 'v');
    await page.close();
  });

  test('an <iframe sandbox> without allow-scripts: the MAIN-world script runs isolated in it', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'main-world.user.js',
      meta: { name: 'MainWorld', match: [`${fixtureServer.baseUrl}/sandboxed-child.html`], grant: ['none'], runAt: 'document-end' },
      body: `document.documentElement.setAttribute('data-main-ran', '1');`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const parentUrl = `${fixtureServer.baseUrl}/sandbox-parent.html`;
    await page.route(parentUrl, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<!doctype html><iframe sandbox src="sandboxed-child.html"></iframe>',
    }));
    await page.route(`${fixtureServer.baseUrl}/sandboxed-child.html`, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: HTML,
    }));
    await page.goto(parentUrl);
    const child = page.frames().find((f) => f.url().endsWith('/sandboxed-child.html'))!;
    await expect(child.locator('html')).toHaveAttribute('data-main-ran', '1');
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
      (s) => s.rows.includes('ContentWorld | OK') && s.rows.includes('MainWorld | OK'),
      'both OK',
    );
    // Once: the page's own world runs it, so the bridge asks for no
    // fallback.
    await expect(page.locator('html')).toHaveAttribute('data-main-ran', '1');
    await page.waitForTimeout(500);
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
