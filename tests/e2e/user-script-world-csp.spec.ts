// End-to-end tests for <script> elements a userscript inserts into the
// page, and which CSP (Content Security Policy) governs them.
//
// - Chrome checks script elements inserted from the USER_SCRIPT world
//   against that world's own CSP (set by `configureWorld` in
//   src/injector.ts), not the page's. So the world CSP must allow
//   inline and external scripts, or this common pattern (injecting
//   page code) fails even on pages with no CSP.
// - The same rule means a strict page CSP doesn't stop them either,
//   which matches Tampermonkey.
// - MAIN-world scripts insert as the page, so the page CSP applies.
// - Inline event handlers stay under the page CSP in either world.

import { test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Inserts two inline scripts, one per insertion route, each setting a
// page global. `done` marks that the userscript itself finished.
const INSERT_BODY = `
  const s = document.createElement('script');
  s.textContent = 'window.smInlineCreate = 1;';
  document.head.appendChild(s);
  GM_addElement('script', { textContent: 'window.smInlineAddElement = 1;' });
  document.body.dataset.smDone = '1';
`;

async function pageGlobals(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-sm-done', '1');
  return page.evaluate(() => ({
    create: (window as any).smInlineCreate ?? null,
    addElement: (window as any).smInlineAddElement ?? null,
  }));
}

test.describe('<script> insertion and CSP', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  for (const world of ['USER_SCRIPT', 'MAIN'] as const) {
    const grant = world === 'MAIN' ? ['GM_addElement', 'unsafeWindow'] : ['GM_addElement'];

    test(`${world} world: inline scripts run on a page with no CSP`, async ({
      extensionContext, fixtureServer, sm,
    }) => {
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'Inline', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant },
        body: INSERT_BODY,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      expect(await pageGlobals(page)).toEqual({ create: 1, addElement: 1 });
      await page.close();
    });

    test(`${world} world: a page script-src without 'unsafe-inline' ${world === 'MAIN' ? 'blocks' : 'does not block'} them`, async ({
      extensionContext, fixtureServer, sm,
    }) => {
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'InlineStrict', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant },
        body: INSERT_BODY,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/strict-script-csp.html`);
      const ran = world === 'MAIN' ? null : 1;
      expect(await pageGlobals(page)).toEqual({ create: ran, addElement: ran });
      await page.close();
    });

    test(`${world} world: a cross-origin <script src> on a strict page ${world === 'MAIN' ? 'is blocked' : 'runs'}`, async ({
      extensionContext, fixtureServer, sm,
    }) => {
      // Same server under another host name, so the page's 'self'
      // doesn't cover it.
      const crossOrigin = fixtureServer.baseUrl.replace('127.0.0.1', 'localhost');
      expect(crossOrigin).not.toBe(fixtureServer.baseUrl);
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'SrcStrict', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant },
        body: `
          const el = GM_addElement('script', { src: '${crossOrigin}/set-page-global.js' });
          el.addEventListener('load', () => { document.body.dataset.smSrc = 'load'; });
          el.addEventListener('error', () => { document.body.dataset.smSrc = 'error'; });
        `,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/strict-script-csp.html`);
      await expect(page.locator('body')).toHaveAttribute('data-sm-src', world === 'MAIN' ? 'error' : 'load');
      expect(await page.evaluate(() => (window as any).smExternalSrc ?? null)).toBe(world === 'MAIN' ? null : 1);
      await page.close();
    });
  }

  // 'unsafe-inline' in the world CSP only covers <script> elements.
  // Inline event handlers a USER_SCRIPT-world script adds still answer
  // to the page CSP (and javascript: URLs likewise).
  for (const [pageName, ran] of [['target.html', 1], ['strict-script-csp.html', null]] as const) {
    test(`USER_SCRIPT world: an inline event handler ${ran ? 'runs on a page with no CSP' : 'stays blocked by a strict page CSP'}`, async ({
      extensionContext, fixtureServer, sm,
    }) => {
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'Handler', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant: ['GM_addElement'] },
        body: `
          const b = GM_addElement('button', { id: 'sm-handler', textContent: 'click' });
          b.setAttribute('onclick', 'window.smHandler = 1;');
          document.body.dataset.smDone = '1';
        `,
      });
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/${pageName}`);
      await expect(page.locator('body')).toHaveAttribute('data-sm-done', '1');
      await page.locator('#sm-handler').click();
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).smHandler ?? null)).toBe(ran);
      await page.close();
    });
  }

  test('USER_SCRIPT world: an external <script src> runs', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'ExternalSrc', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end', grant: ['GM_addElement'] },
      body: `GM_addElement('script', { src: '/set-page-global.js' });`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => page.evaluate(() => (window as any).smExternalSrc ?? null)).toBe(1);
    await page.close();
  });
});
