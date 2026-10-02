// @run-at timing under the push backend. CDP's
// `addScriptToEvaluateOnNewDocument` runs our entries before the parser
// has made <html>, earlier than the extension's document_start, so the
// prelude's gates have to wait for the nodes the extension would have
// had. Each case loads the page several times, since parse timing
// varies from load to load. The document-start cases load through
// `/__slowbody/`, which holds the page's bytes back after the headers,
// so <html> is surely missing when the entries run.

import { test, expect } from '../fixtures/harness.js';

const LOADS = 5;

test.describe('harness @run-at timing', () => {
  test('document-start code and its @require see <html>', async ({ page, fixtureServer, host, scriptsDir, loadScript }) => {
    scriptsDir.writeRaw('lib.js', `window.__smLibSawHtml = document.documentElement !== null;\n`);
    await loadScript({
      relativePath: 'start.user.js',
      meta: {
        name: 'Start', match: ['*://*/__slowbody/run-at.html*'], grant: ['none'], runAt: 'document-start',
        extra: ['// @require     lib.js'],
      },
      body: `window.__smStartSawHtml = document.documentElement !== null;`,
    });
    for (let i = 0; i < LOADS; i++) {
      await page.goto(`${fixtureServer.baseUrl}/__slowbody/run-at.html?ms=300`);
      await expect(page.locator('#log')).toBeAttached();
      const seen = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return { lib: w.__smLibSawHtml, body: w.__smStartSawHtml };
      });
      expect(seen, `load ${i + 1}`).toEqual({ lib: true, body: true });
    }
    expect(host.reports.errors).toEqual([]);
  });

  // The wrapper skips the check-pending round trip on a non-reload
  // load (`canSkipDecision`), so the body beats the page's first
  // inline script, as in the extension.
  test('document-start runs before the page\'s first head script', async ({ page, fixtureServer, loadScript }) => {
    await loadScript({
      relativePath: 'early.user.js',
      meta: { name: 'Early', match: ['*://*/early-inline.html*'], grant: ['none'], runAt: 'document-start' },
      body: `document.documentElement.dataset.early = 'script';`,
    });
    for (let i = 0; i < LOADS; i++) {
      await page.goto(`${fixtureServer.baseUrl}/early-inline.html?n=${i}`);
      expect(await page.evaluate(() => document.documentElement.dataset.pageSaw), `load ${i + 1}`).toBe('script');
    }
  });

  test('document-start in the isolated world sees <html>', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'start-isolated.user.js',
      meta: { name: 'StartIsolated', match: ['*://*/__slowbody/run-at.html*'], grant: ['GM_setValue'], runAt: 'document-start' },
      body: `document.documentElement.dataset.start = 'ran';`,
    });
    for (let i = 0; i < LOADS; i++) {
      await page.goto(`${fixtureServer.baseUrl}/__slowbody/run-at.html?ms=300`);
      await expect(page.locator('html'), `load ${i + 1}`).toHaveAttribute('data-start', 'ran');
    }
    expect(host.reports.errors).toEqual([]);
  });

  for (const grant of ['none', 'GM_setValue']) {
    test(`document-body sees <body> (@grant ${grant})`, async ({ page, fixtureServer, host, loadScript }) => {
      await loadScript({
        relativePath: 'body.user.js',
        meta: { name: 'Body', match: ['*://*/run-at.html'], grant: [grant], extra: ['// @run-at      document-body'] },
        body: `document.documentElement.dataset.bodyAtRun = String(document.body !== null);`,
      });
      for (let i = 0; i < LOADS; i++) {
        await page.goto(`${fixtureServer.baseUrl}/run-at.html`);
        await expect(page.locator('html'), `load ${i + 1}`).toHaveAttribute('data-body-at-run', 'true');
      }
      expect(host.reports.errors).toEqual([]);
    });
  }

  test('on an SVG page, document-start runs and document-body quietly does not', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'svg-start.user.js',
      meta: { name: 'SvgStart', match: ['*://*/wide-icon.svg'], grant: ['none'], runAt: 'document-start' },
      body: `window.__smSvgStart = true;`,
    });
    await loadScript({
      relativePath: 'svg-body.user.js',
      meta: { name: 'SvgBody', match: ['*://*/wide-icon.svg'], grant: ['none'], extra: ['// @run-at      document-body'] },
      body: `window.__smSvgBody = true;`,
    });
    await page.goto(`${fixtureServer.baseUrl}/wide-icon.svg`);
    await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__smSvgStart)).toBe(true);
    await page.waitForLoadState('load');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__smSvgBody)).toBeUndefined();
    expect(host.reports.errors).toEqual([]);
  });

  test('document-idle runs on a page that calls window.stop(), where load never fires', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'idle.user.js',
      meta: { name: 'Idle', match: ['*://*/window-stop.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'idle ran';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/window-stop.html`, { waitUntil: 'commit' });
    await expect(page.locator('#target')).toHaveText('idle ran');
    expect(host.reports.started).toHaveLength(1);
  });
});
