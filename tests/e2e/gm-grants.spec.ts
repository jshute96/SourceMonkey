// End-to-end @grant gating tests for the GM_* / GM.* compile-in
// surface (Phase 2). Validates that:
//
//   1. Granted GM_x names are defined in the script's scope.
//   2. Ungranted GM_x names are NOT defined (typeof === 'undefined').
//   3. GM_info is exposed when any grant is present, with the expected
//      metadata fields.
//   4. GM. (GM4 alias namespace) is exposed alongside GM_.
//   5. @grant none results in NO GM_* bindings (USER_SCRIPT-world
//      isolation aside — the script runs in MAIN, so it can't see
//      __SM_GM__ either, but the binding emitter should still emit
//      nothing).
//
// Phase 2 doesn't implement any actual API behavior — calling any
// granted API just throws "not implemented yet". Tests assert on the
// binding *shape*, not behavior. Behavior tests come in later phases.

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
      // Try calling a granted sync API — Phase 2 should throw
      // "not implemented".
      if (typeof GM_setValue === 'function') {
        try { GM_setValue('k', 'v'); got.GM_setValueCall = 'no-throw'; }
        catch (e) { got.GM_setValueCall = String(e.message || e); }
      }
      // Same with GM.setValue (returns a Promise that rejects).
      if (typeof GM === 'object' && GM && typeof GM.setValue === 'function') {
        // Synchronously capture rejection — Phase 2 wraps the sync
        // throw in Promise.reject.
        GM.setValue('k', 'v').then(
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
    // Calling the not-implemented sync API throws the expected message.
    expect(probe.GM_setValueCall).toMatch(/GM_setValue is not implemented yet/);

    // GM.setValue is the promised form — give it a tick to settle.
    await expect(page.locator('body')).toHaveAttribute('data-gm-promise-reject', /not implemented yet/);
    await page.close();
  });

  test('@grant none → no GM_* bindings emitted', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // @grant none makes the script MAIN-world, so __SM_GM__ isn't even
    // reachable. Verify the binding emitter compiles in nothing and
    // every probed name comes back undefined.
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
    await expect(page.locator('body')).toHaveAttribute('data-sm-probe', /undefined/);

    const probeJson = await page.locator('body').getAttribute('data-sm-probe');
    const probe = JSON.parse(probeJson!);
    expect(probe.GM_setValue).toBe('undefined');
    expect(probe.GM_xmlhttpRequest).toBe('undefined');
    expect(probe.GM_info).toBe('undefined');
    expect(probe.GM).toBe('undefined');
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
