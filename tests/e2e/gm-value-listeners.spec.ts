// End-to-end tests for GM_addValueChangeListener /
// GM_removeValueChangeListener (Phase 7).
//
// Behavior:
//   - Listeners fire SYNCHRONOUSLY on local GM_setValue /
//     GM_deleteValue with remote=false.
//   - Listeners also fire on cross-tab broadcasts (sm:gm-value-update)
//     with remote=true.
//   - removeValueChangeListener unregisters by the returned id.
//   - Each listener is keyed per-script and per-key.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_addValueChangeListener (Phase 7)', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('listener fires synchronously on local GM_setValue (remote=false)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'LocalListener',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_addValueChangeListener'],
      },
      body: `
        const events = [];
        GM_addValueChangeListener('counter', (key, oldVal, newVal, remote) => {
          events.push({ key, oldVal, newVal, remote });
        });
        GM_setValue('counter', 1);
        GM_setValue('counter', 2);
        GM_setValue('counter', 'three');
        document.body.dataset.smEvents = JSON.stringify(events);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-events', /counter/);

    const json = await page.locator('body').getAttribute('data-sm-events');
    const events = JSON.parse(json!);
    expect(events).toEqual([
      { key: 'counter', oldVal: undefined, newVal: 1, remote: false },
      { key: 'counter', oldVal: 1, newVal: 2, remote: false },
      { key: 'counter', oldVal: 2, newVal: 'three', remote: false },
    ]);
    await page.close();
  });

  test('listener fires on GM_deleteValue with newValue=undefined', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DeleteListener',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_deleteValue', 'GM_addValueChangeListener'],
      },
      body: `
        const events = [];
        GM_addValueChangeListener('k', (key, oldVal, newVal, remote) => {
          events.push({ key, oldVal, newVal, remote });
        });
        GM_setValue('k', 'present');
        GM_deleteValue('k');
        document.body.dataset.smEvents = JSON.stringify(events);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-events', /present/);

    const json = await page.locator('body').getAttribute('data-sm-events');
    const events = JSON.parse(json!);
    // JSON.stringify drops undefined fields, so they appear as missing.
    expect(events[0]).toMatchObject({ key: 'k', newVal: 'present', remote: false });
    expect(events[1]).toMatchObject({ key: 'k', oldVal: 'present', remote: false });
    // newVal undefined → JSON.stringify drops it.
    expect(events[1].newVal).toBeUndefined();
    await page.close();
  });

  test('removeValueChangeListener unregisters by the returned id', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'RemoveListener',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_addValueChangeListener', 'GM_removeValueChangeListener'],
      },
      body: `
        const events = [];
        const id = GM_addValueChangeListener('k', (key, oldVal, newVal) => {
          events.push(newVal);
        });
        GM_setValue('k', 'first');
        GM_removeValueChangeListener(id);
        GM_setValue('k', 'second');  // listener should NOT fire
        document.body.dataset.smEvents = JSON.stringify(events);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-events', /first/);

    const json = await page.locator('body').getAttribute('data-sm-events');
    const events = JSON.parse(json!);
    expect(events).toEqual(['first']);
    await page.close();
  });

  test('listener fires with remote=true on cross-tab broadcast', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'RemoteListener',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_addValueChangeListener'],
      },
      body: `
        // Accumulate every change into a data attribute as a flat
        // JSON list so the test can read it.
        const events = [];
        const flush = () => {
          document.body.dataset.smEvents = JSON.stringify(events);
        };
        GM_addValueChangeListener('shared', (key, oldVal, newVal, remote) => {
          events.push({ newVal, remote });
          flush();
        });
        flush();
        // Poll for a trigger command.
        let lastSeen = '';
        setInterval(() => {
          const cmd = document.body.dataset.smCmd || '';
          if (cmd && cmd !== lastSeen) {
            lastSeen = cmd;
            if (cmd.startsWith('set:')) GM_setValue('shared', cmd.slice(4));
          }
        }, 50);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // Two tabs, same script.
    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-events', '[]');

    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-events', '[]');

    // Tab A writes — fires its own listener with remote=false.
    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:fromA'; });
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-events', /fromA/);
    const aJson = await pageA.locator('body').getAttribute('data-sm-events');
    expect(JSON.parse(aJson!)).toEqual([{ newVal: 'fromA', remote: false }]);

    // Tab B sees the broadcast with remote=true.
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-events', /fromA/, { timeout: 3000 });
    const bJson = await pageB.locator('body').getAttribute('data-sm-events');
    expect(JSON.parse(bJson!)).toEqual([{ newVal: 'fromA', remote: true }]);

    await pageA.close();
    await pageB.close();
  });

  test('ungranted listener APIs return undefined', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoListenerGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],  // no listener grant
      },
      body: `
        document.body.dataset.smAddType = typeof GM_addValueChangeListener;
        document.body.dataset.smRemoveType = typeof GM_removeValueChangeListener;
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-add-type', 'undefined');
    await expect(page.locator('body')).toHaveAttribute('data-sm-remove-type', 'undefined');
    await page.close();
  });
});
