// End-to-end tests for the GM_* storage API surface (Phase 3).
//
// Validates real GM_setValue / GM_getValue / GM_deleteValue /
// GM_listValues round-trips. The page-side cache is baked into the
// wrapper at register time so the FIRST page load reads default
// values; SECOND page load (after the cache flushed to the SW and we
// re-synced) should see persisted values.
//
// Covers:
//   - First page: GM_getValue with a default returns the default
//   - GM_setValue + GM_listValues + GM_getValue on the same page
//   - GM_deleteValue removes the key
//   - After sync: SECOND page sees the persisted value
//   - Cross-script isolation: scripts have independent namespaces

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForGmValues } from '../fixtures/sw-api';

test.describe('GM_* storage (Phase 3)', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('GM_getValue returns the default when the cache is empty', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GetDefault',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_getValue'],
      },
      body: `
        const got = GM_getValue('missing', 'fallback');
        document.body.dataset.smProbe = String(got);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', 'fallback');
    await page.close();
  });

  test('GM_setValue + GM_getValue + GM_listValues round-trip on the same page', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'SetThenGet',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_listValues'],
      },
      body: `
        GM_setValue('foo', 'bar');
        GM_setValue('count', 42);
        GM_setValue('obj', { nested: { x: 1 } });
        const out = {
          foo: GM_getValue('foo'),
          count: GM_getValue('count'),
          obj: GM_getValue('obj'),
          missing: GM_getValue('missing', 'def'),
          keys: GM_listValues().sort(),
        };
        document.body.dataset.smProbe = JSON.stringify(out);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /foo/);
    const json = await page.locator('body').getAttribute('data-sm-probe');
    const got = JSON.parse(json!);
    expect(got.foo).toBe('bar');
    expect(got.count).toBe(42);
    expect(got.obj).toEqual({ nested: { x: 1 } });
    expect(got.missing).toBe('def');
    expect(got.keys).toEqual(['count', 'foo', 'obj']);
    await page.close();
  });

  test('GM_deleteValue removes the key from the cache and storage', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DeleteTest',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues'],
      },
      body: `
        GM_setValue('keep', 'stays');
        GM_setValue('drop', 'gone');
        GM_deleteValue('drop');
        const out = {
          keep: GM_getValue('keep'),
          drop: GM_getValue('drop', 'NOT_SET'),
          keys: GM_listValues().sort(),
        };
        document.body.dataset.smProbe = JSON.stringify(out);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /keep/);
    const json = await page.locator('body').getAttribute('data-sm-probe');
    const got = JSON.parse(json!);
    expect(got.keep).toBe('stays');
    expect(got.drop).toBe('NOT_SET');
    expect(got.keys).toEqual(['keep']);
    await page.close();
  });

  test('values persist across page reloads (next register sees the flushed batch)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Persist',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        const previous = GM_getValue('counter', 0);
        GM_setValue('counter', previous + 1);
        document.body.dataset.smProbe = String(previous);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // First load: counter starts at 0, the script sets it to 1.
    const page1 = await extensionContext.newPage();
    await page1.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page1.locator('body')).toHaveAttribute('data-sm-probe', '0');
    // The second load below is only meaningful once the first load's
    // write is on disk, and that write is batched 150ms after the fact.
    await waitForGmValues(sm, (values) => values.counter === 1, 'counter = 1');
    await page1.close();

    // Second load: previous now reads 1 (the value the FIRST load
    // persisted), and the script bumps it to 2. No re-register
    // needed — the SW attaches the current snapshot to every
    // sm:check-pending reply.
    const page2 = await extensionContext.newPage();
    await page2.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page2.locator('body')).toHaveAttribute('data-sm-probe', '1');
    await page2.close();
  });

  test('two scripts have isolated storage namespaces', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ScriptA',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_listValues'],
      },
      body: `
        GM_setValue('a-only', 'A');
        document.body.dataset.smA = JSON.stringify(GM_listValues().sort());
      `,
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: {
        name: 'ScriptB',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_listValues'],
      },
      body: `
        GM_setValue('b-only', 'B');
        document.body.dataset.smB = JSON.stringify(GM_listValues().sort());
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-a', /a-only/);
    await expect(page.locator('body')).toHaveAttribute('data-sm-b', /b-only/);
    // Crucial: each script's GM_listValues only returns its own keys.
    const a = JSON.parse((await page.locator('body').getAttribute('data-sm-a'))!);
    const b = JSON.parse((await page.locator('body').getAttribute('data-sm-b'))!);
    expect(a).toEqual(['a-only']);
    expect(b).toEqual(['b-only']);
    await page.close();
  });

  test('GM.setValue (promise form) resolves with the value', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GMDot',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        // GM. forms return Promises for storage. Verify both set + get.
        (async () => {
          await GM.setValue('promised', 'yes');
          const v = await GM.getValue('promised');
          document.body.dataset.smProbe = String(v);
        })();
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', 'yes');
    await page.close();
  });
});
