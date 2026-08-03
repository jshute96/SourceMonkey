// End-to-end @grant gating tests for the GM_* / GM.* compile-in
// surface (Phase 2). Validates that:
//
//   1. Granted GM_x names are defined in the script's scope.
//   2. Ungranted GM_x names are NOT defined (typeof === 'undefined').
//   3. GM_info is exposed implicitly — matches TM/VM, so even
//      `@grant none` and scripts with no @grant line at all get it.
//   4. GM. (GM4 alias namespace) is exposed alongside GM_, with at
//      least `GM.info` whenever GM_info is in scope.
//   5. `@grant none` lands the script in MAIN world. Today that
//      means only GM_info and the GM alias are reachable (the
//      USER_SCRIPT-world `__SM_GM__` runtime isn't visible from
//      MAIN); the other GM_x names are undefined.
//
// Phase 2 doesn't implement any actual API behavior — calling any
// granted API just throws "not implemented yet". Tests assert on the
// binding *shape*, not behavior. Behavior tests come in later phases.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_* @grant gating (Phase 2)', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  // Script body that probes its scope for granted/ungranted names and
  // surfaces the result on a known DOM node so the test can read it.
  // Using a DOM element rather than `window.X` because USER_SCRIPT
  // world has its own `window`, not visible to page.evaluate.
  const probeBody = `
    function probe() {
      const got = {
        GM_setValue: typeof GM_setValue,
        GM_getValue: typeof GM_getValue,
        GM_xmlhttpRequest: typeof GM_xmlhttpRequest,
        GM_info: typeof GM_info,
        GM: typeof GM,
      };
      // Try probing GM_info structure if it exists.
      if (typeof GM_info === 'object' && GM_info !== null) {
        got.gmInfoName = GM_info.script && GM_info.script.name;
        got.gmInfoHandler = GM_info.scriptHandler;
        got.gmInfoGrants = GM_info.script && GM_info.script.grant && GM_info.script.grant.join(',');
      }
      // Try GM. alias if granted.
      if (typeof GM === 'object' && GM !== null) {
        got.GMsetValue = typeof GM.setValue;
        got.GMinfo = typeof GM.info;
      }
      // Granted sync API should be callable without throwing
      // (Phase 3+ — storage is wired up). Calling GM_setValue
      // returns undefined and queues a batched write.
      if (typeof GM_setValue === 'function') {
        try { GM_setValue('k', 'v'); got.GM_setValueCall = 'ok'; }
        catch (e) { got.GM_setValueCall = String(e.message || e); }
      }
      // GM.setValue (promise form) should resolve, not reject.
      if (typeof GM === 'object' && GM && typeof GM.setValue === 'function') {
        GM.setValue('k2', 'v2').then(
          () => { document.body.dataset.gmPromiseResolve = 'yes'; },
          (e) => { document.body.dataset.gmPromiseReject = String(e.message || e); }
        );
      }
      document.body.dataset.smProbe = JSON.stringify(got);
    }
    probe();
  `;

  test('granted GM_setValue defined; ungranted GM_xmlhttpRequest undefined', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'probe.user.js',
      meta: {
        name: 'Grant Probe',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: probeBody,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /GM_setValue/);

    const probeJson = await page.locator('body').getAttribute('data-sm-probe');
    const probe = JSON.parse(probeJson!);
    expect(probe.GM_setValue).toBe('function');
    expect(probe.GM_xmlhttpRequest).toBe('undefined');
    expect(probe.GM_getValue).toBe('undefined');
    expect(probe.GM_info).toBe('object');
    expect(probe.GM).toBe('object');
    // GM_info introspection — name and handler should be set.
    expect(probe.gmInfoName).toBe('Grant Probe');
    expect(probe.gmInfoHandler).toBe('SourceMonkey');
    expect(probe.gmInfoGrants).toBe('GM_setValue');
    // GM. namespace exposes the granted API + .info.
    expect(probe.GMsetValue).toBe('function');
    expect(probe.GMinfo).toBe('object');
    // Calling the granted sync API runs cleanly (Phase 3 storage wired).
    expect(probe.GM_setValueCall).toBe('ok');

    // GM.setValue (promise form) resolves now that storage is real.
    await expect(page.locator('body')).toHaveAttribute('data-gm-promise-resolve', 'yes');
    await page.close();
  });

  test('@grant none → only GM_info / GM emitted (others undefined)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // @grant none makes the script MAIN-world, so __SM_GM__ isn't
    // reachable — but GM_info is implicit (matches TM/VM) and is
    // emitted as a baked literal with no runtime dependency. The
    // GM4 alias `GM` is also emitted with at least `GM.info`.
    // Everything else should still be undefined.
    scriptsDir.write({
      relativePath: 'probe.user.js',
      meta: {
        name: 'No Grant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['none'],
      },
      body: probeBody,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /GM_info/);

    const probeJson = await page.locator('body').getAttribute('data-sm-probe');
    const probe = JSON.parse(probeJson!);
    expect(probe.GM_setValue).toBe('undefined');
    expect(probe.GM_xmlhttpRequest).toBe('undefined');
    expect(probe.GM_info).toBe('object');
    expect(probe.GM).toBe('object');
    await page.close();
  });

  test('multiple grants emit multiple bindings; ungranted still undefined', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'multi.user.js',
      meta: {
        name: 'Multi Grant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_addStyle'],
      },
      body: probeBody,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /GM_setValue/);

    const probeJson = await page.locator('body').getAttribute('data-sm-probe');
    const probe = JSON.parse(probeJson!);
    expect(probe.GM_setValue).toBe('function');
    expect(probe.GM_getValue).toBe('function');
    expect(probe.GM_xmlhttpRequest).toBe('undefined');
    expect(probe.gmInfoGrants).toContain('GM_setValue');
    expect(probe.gmInfoGrants).toContain('GM_getValue');
    expect(probe.gmInfoGrants).toContain('GM_addStyle');
    await page.close();
  });

  test('GM.xmlHttpRequest alias works for the GM4 form', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Granting the legacy `GM_xmlhttpRequest` should ALSO expose
    // `GM.xmlHttpRequest` (camelCase). The body verifies both names
    // resolve to functions.
    scriptsDir.write({
      relativePath: 'gm4.user.js',
      meta: {
        name: 'GM4 alias',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
      },
      body: `
        document.body.dataset.gmXhrType = typeof GM_xmlhttpRequest;
        document.body.dataset.gmDotXhrType = typeof (GM && GM.xmlHttpRequest);
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-gm-xhr-type', 'function');
    await expect(page.locator('body')).toHaveAttribute('data-gm-dot-xhr-type', 'function');
    await page.close();
  });

  test('@require sees GM_info and granted GM_* (gm4-polyfill-style use)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The injector concatenates each @require into the script's own
    // entry, ahead of the body but AFTER the GM binding block, so
    // library top-level code sees `GM_info` / `GM_setValue` in scope.
    // This test exercises the polyfill-style use case (a shared
    // library that depends on those bindings being live when the
    // require's top-level code runs).
    const requireBody = `
      // Probe GM_info / GM_setValue from inside the require's own
      // top-level scope (NOT from a function defined here and
      // called later by the main body).
      var reqGmInfo = typeof GM_info;
      var reqGmInfoName = (typeof GM_info === 'object' && GM_info && GM_info.script && GM_info.script.name) || '';
      var reqGmSetValue = typeof GM_setValue;
      window.__SM_REQ_PROBE = JSON.stringify({
        gmInfo: reqGmInfo,
        gmInfoName: reqGmInfoName,
        gmSetValue: reqGmSetValue,
      });
    `;
    fs.writeFileSync(path.join(scriptsDir.path, 'helper.js'), requireBody);
    scriptsDir.write({
      relativePath: 'host.user.js',
      meta: {
        name: 'RequireHost',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
        extra: ['// @require     helper.js'],
      },
      body: `
        // Surface the require's probe on the DOM so the test can read it.
        document.body.dataset.reqProbe = window.__SM_REQ_PROBE || 'missing';
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-req-probe', /gmInfo/);
    const probeJson = await page.locator('body').getAttribute('data-req-probe');
    const probe = JSON.parse(probeJson!);
    expect(probe.gmInfo).toBe('object');
    expect(probe.gmInfoName).toBe('RequireHost');
    expect(probe.gmSetValue).toBe('function');
    await page.close();
  });

  test('granting via GM.setValue (dot form) canonicalizes to GM_setValue', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The script declares `@grant GM.setValue`. Our catalog
    // canonicalizes that to GM_setValue, so BOTH names should be
    // exposed (just like granting the legacy form).
    scriptsDir.write({
      relativePath: 'dotgrant.user.js',
      meta: {
        name: 'Dot Grant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM.setValue'],
      },
      body: `
        document.body.dataset.legacy = typeof GM_setValue;
        document.body.dataset.dot = typeof (GM && GM.setValue);
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-legacy', 'function');
    await expect(page.locator('body')).toHaveAttribute('data-dot', 'function');
    await page.close();
  });
});
