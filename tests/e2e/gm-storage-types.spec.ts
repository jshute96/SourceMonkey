// End-to-end tests for stored-value type fidelity.
//
// Everything between GM_setValue and chrome.storage.local serializes
// JSON-style, which used to rewrite values a userscript is entitled to
// store: a Date came back an ISO string, NaN came back null, a Map came
// back {}. The page-side codec in wrapper-gm-runtime.js tags those on
// the way out and revives them on the way in — but only the FIRST load
// reads from its own in-page cache, so the tags only earn their keep on
// the SECOND load, which is what these tests drive.
//
// Also pinned here: rows written before the codec existed (plain,
// untagged values sitting in chrome.storage.local) still read back
// correctly.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForGmValues } from '../fixtures/sw-api';

test.describe('GM_* stored-value type fidelity', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('Date / Map / Set / NaN / undefined / binary / Error survive a page reload', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'TypeRoundTrip',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      // First load writes the values; every load reports what it read
      // BEFORE writing, so the second load's report describes what came
      // back off disk.
      body: `
        const d = GM_getValue('date');
        const m = GM_getValue('map');
        const s = GM_getValue('set');
        const n = GM_getValue('nan', 'MISSING');
        const u = GM_getValue('undef', 'MISSING');
        const b = GM_getValue('bytes');
        const e = GM_getValue('err');
        document.body.dataset.smProbe = JSON.stringify({
          dateType: Object.prototype.toString.call(d),
          dateMs: d instanceof Date ? d.getTime() : null,
          mapType: Object.prototype.toString.call(m),
          mapEntries: m instanceof Map ? [...m.entries()] : null,
          setItems: s instanceof Set ? [...s].sort() : null,
          nanIsNaN: typeof n === 'number' && Number.isNaN(n),
          undefIsUndefined: u === undefined,
          bytesType: Object.prototype.toString.call(b),
          bytes: b instanceof Uint8Array ? [...b] : null,
          errIsTypeError: e instanceof TypeError,
          errMessage: e instanceof Error ? e.message : null,
          errCode: e instanceof Error ? e.code : null,
        });
        GM_setValue('date', new Date(1700000000000));
        GM_setValue('map', new Map([['k', 1]]));
        GM_setValue('set', new Set(['x', 'y']));
        GM_setValue('nan', NaN);
        GM_setValue('undef', undefined);
        GM_setValue('bytes', new Uint8Array([0, 127, 255]));
        const boom = new TypeError('boom');
        boom.code = 42;
        GM_setValue('err', boom);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // First load: nothing stored yet, then the writes go out.
    const page1 = await extensionContext.newPage();
    await page1.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page1.locator('body')).toHaveAttribute('data-sm-probe', /dateType/);
    // The writes are batched 150ms after the fact; the second load is
    // only meaningful once they are on disk.
    await waitForGmValues(sm, (values) => 'err' in values, 'all seven keys persisted');
    await page1.close();

    // Second load: the values come back from chrome.storage.local via
    // the check-pending snapshot, with their types intact.
    const page2 = await extensionContext.newPage();
    await page2.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page2.locator('body')).toHaveAttribute('data-sm-probe', /dateType/);
    const got = JSON.parse((await page2.locator('body').getAttribute('data-sm-probe'))!);
    expect(got.dateType).toBe('[object Date]');
    expect(got.dateMs).toBe(1700000000000);
    expect(got.mapType).toBe('[object Map]');
    expect(got.mapEntries).toEqual([['k', 1]]);
    expect(got.setItems).toEqual(['x', 'y']);
    expect(got.nanIsNaN).toBe(true);
    expect(got.undefIsUndefined).toBe(true);
    expect(got.bytesType).toBe('[object Uint8Array]');
    expect(got.bytes).toEqual([0, 127, 255]);
    expect(got.errIsTypeError).toBe(true);
    expect(got.errMessage).toBe('boom');
    expect(got.errCode).toBe(42);
    await page2.close();
  });

  test('plain values are still stored untagged', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The backwards-compatibility contract runs both ways: a value JSON
    // round-trips exactly must land in chrome.storage.local as itself,
    // so a build without the codec could still read it.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'PlainWrite',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `GM_setValue('plain', { a: 1, b: ['two', null, true] });`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const values = await waitForGmValues(sm, (v) => 'plain' in v, 'plain value persisted');
    expect(values.plain).toEqual({ a: 1, b: ['two', null, true] });
    await page.close();
  });

  test('values written before the codec existed still read back', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'LegacyRead',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_getValue'],
      },
      body: `
        document.body.dataset.smProbe = JSON.stringify({
          str: GM_getValue('str'),
          num: GM_getValue('num'),
          obj: GM_getValue('obj'),
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const scriptId = (await sm.getCollections()).flatMap((c) => c.scriptIds)[0];

    // Write the rows the way a pre-codec build would have: the raw
    // value straight into `gmval:<scriptId>:<key>`, no envelope.
    const sw = await getServiceWorker();
    await sw.evaluate(async (id) => {
      await chrome.storage.local.set({
        [`gmval:${id}:str`]: 'hello',
        [`gmval:${id}:num`]: 7,
        [`gmval:${id}:obj`]: { nested: [1, 2] },
      });
    }, scriptId);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /hello/);
    const got = JSON.parse((await page.locator('body').getAttribute('data-sm-probe'))!);
    expect(got).toEqual({ str: 'hello', num: 7, obj: { nested: [1, 2] } });
    await page.close();
  });
});
