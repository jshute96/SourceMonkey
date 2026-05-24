// End-to-end test for GM_log — the simplest of the late-phase APIs.
// It's a thin wrapper over console.log with a per-script prefix.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_log', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('GM_log prefixes the message with the scriptId and forwards to console.log', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'LogTest',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_log'],
      },
      body: `
        GM_log('hello from gm log');
        document.body.dataset.smLog = typeof GM_log;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const captured: string[] = [];
    page.on('console', (msg) => { captured.push(msg.text()); });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // GM_log is defined (compile-in bound).
    await expect(page.locator('body')).toHaveAttribute('data-sm-log', 'function');
    // Wait briefly for the console event to flush.
    await page.waitForTimeout(100);
    const matched = captured.find((line) => line.includes('[SourceMonkey:') && line.includes('hello from gm log'));
    expect(matched, `expected a prefixed log line; saw: ${captured.join(' | ')}`).toBeTruthy();
    await page.close();
  });

  test('GM.log (GM4 alias) also forwards', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'LogDotTest',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_log'],
      },
      body: `
        GM.log('via GM dot');
        document.body.dataset.smLog = 'ok';
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const captured: string[] = [];
    page.on('console', (msg) => { captured.push(msg.text()); });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-log', 'ok');
    await page.waitForTimeout(100);
    const matched = captured.find((line) => line.includes('via GM dot'));
    expect(matched).toBeTruthy();
    await page.close();
  });

  test('ungranted GM_log is undefined in scope', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoLogGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],  // no GM_log grant
      },
      body: `
        document.body.dataset.smLogType = typeof GM_log;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-log-type', 'undefined');
    await page.close();
  });
});
