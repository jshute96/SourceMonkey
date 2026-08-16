// End-to-end test for GM_log — the simplest of the late-phase APIs.
// It's a thin wrapper over console.log with a per-script prefix.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor } from '../fixtures/sw-api';

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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const captured: string[] = [];
    page.on('console', (msg) => { captured.push(msg.text()); });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // GM_log is defined (compile-in bound).
    await expect(page.locator('body')).toHaveAttribute('data-sm-log', 'function');
    // Poll for the console event rather than pausing: it arrives over
    // CDP, and 100ms was the tightest budget in the suite — the first
    // thing to break when several browsers compete for cores.
    await expect
      .poll(() => captured.find((line) => line.includes('[SourceMonkey:') && line.includes('hello from gm log')),
        { message: `expected a prefixed log line; saw: ${captured.join(' | ')}` })
      .toBeTruthy();
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const captured: string[] = [];
    page.on('console', (msg) => { captured.push(msg.text()); });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-log', 'ok');
    // Same as above: poll the CDP console array, don't race a fixed pause.
    await expect.poll(() => captured.find((line) => line.includes('via GM dot'))).toBeTruthy();
    await page.close();
  });

  test('GM_log calls also land on the script Log tab with source=gm-log', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'LogToTab',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_log'],
      },
      body: `
        GM_log('first line');
        GM_log('second', 42, { k: 'v' });
        document.body.dataset.smReady = '1';
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const scriptId = collections.find((s) => s.id === added!.id)!.scriptIds[0];

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ready', '1');

    // Wait for both GM_log calls to land in the per-script log.
    const log = await waitFor(
      () => sm.getScriptLog(scriptId),
      (entries) => entries.filter((e) => e.source === 'gm-log').length >= 2,
      { label: 'two gm-log entries' },
    );
    const gmRows = log.filter((e) => e.source === 'gm-log');
    expect(gmRows[0].level).toBe('info');
    expect(gmRows[0].message).toBe('first line');
    // Multi-arg: primitives stringified, object JSON-encoded, joined by spaces.
    expect(gmRows[1].message).toBe('second 42 {"k":"v"}');
    // tabId is attached so the viewer can render "tab N · gm-log".
    expect(typeof gmRows[0].tabId).toBe('number');
    await page.close();
  });

  test('GM_log renders Error / undefined / null / function arguments without dropping the call', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Covers the tricky branches in _renderArg: Error → "message\nstack",
    // undefined / null → literal words, function → "[Function: name]"
    // (rather than the JSON.stringify-returns-undefined trap).
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'EdgeArgs',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_log'],
      },
      body: `
        GM_log(new Error('boom'));
        GM_log(undefined, null);
        GM_log('cb is', function namedFn() {});
        document.body.dataset.smReady = '1';
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const scriptId = collections.find((s) => s.id === added!.id)!.scriptIds[0];

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ready', '1');

    const log = await waitFor(
      () => sm.getScriptLog(scriptId),
      (entries) => entries.filter((e) => e.source === 'gm-log').length >= 3,
      { label: 'three gm-log entries' },
    );
    const rows = log.filter((e) => e.source === 'gm-log');
    // Error: message first, stack appended on a new line. We don't
    // assert the full stack — just that the message is at the head
    // and a stack frame snuck in.
    expect(rows[0].message.startsWith('boom')).toBe(true);
    expect(rows[0].message).toContain('\n');
    // undefined / null render as literal words; join is " ".
    expect(rows[1].message).toBe('undefined null');
    // Function renders with name; would have been "undefined" if we
    // relied on JSON.stringify alone.
    expect(rows[2].message).toBe('cb is [Function: namedFn]');
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-log-type', 'undefined');
    await page.close();
  });
});
