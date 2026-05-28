// End-to-end coverage of the `@require` pipeline.
//
//   - A `@require` declared on a userscript is prefetched at addSource
//     time and concatenated before the body when chrome.userScripts
//     registers the script. The DOM mutation is the proof: it only
//     runs if the require's exported function survived the prepend.
//   - Relative `@require` paths resolve against the script's parent
//     dir (the same file-loader rule `@icon` uses) — works for both
//     file:// and HTTP sources.
//   - Refusing dangerous refs (path traversal, non-`.js` suffix,
//     absolute file://) flips the script to status: 'invalid' and the
//     injection never happens.
//   - Cross-script dedup: two scripts requiring the same canonical URL
//     share one fetch in a refreshAllSources pass.
//   - Manual refresh picks up remote require changes; the
//     opportunistic path (background update on navigation) does NOT —
//     a manual click is needed to surface remote require updates.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('@require', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('relative file:// @require is prefetched and stored alongside the script', async ({
    fixtureServer, sm,
  }) => {
    // The require file is created as a sibling of the userscript on
    // disk. The store side must fetch it through file-loader and attach
    // it to the StoredScript so chrome.userScripts can prepend it at
    // injection time (the injection-side wiring is unit-covered in
    // tests/unit/injector.test.mjs because chrome.userScripts itself
    // isn't reliably available in the headless build).
    const requireBody = 'window.__SM_REQ_VALUE = "from-require";';
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), requireBody);
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Uses Require',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      body: 'void window.__SM_REQ_VALUE;',
    });
    const source = await sm.addSource(scriptsDir.path);
    const data = await sm.getSourceWithScripts(source!.id);
    expect(data!.scripts[0].status, data!.scripts[0].errorMessage).toBe('ok');
    expect(data!.scripts[0].requires).toHaveLength(1);
    expect(data!.scripts[0].requires?.[0]?.url).toMatch(/\/lib\.js$/);
    expect(data!.scripts[0].requires?.[0]?.source).toBe(requireBody);
    // contentHash bookkeeping enables explicit Refresh's change detect.
    expect(data!.scripts[0].requires?.[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('relative HTTP @require is prefetched against the script\'s parent dir', async ({ sm }) => {
    const server = await UserscriptServer.start();
    try {
      const requireBody = 'window.__SM_HTTP_REQ = "http-require-value";';
      server.setRoute('/pkg/lib.js', requireBody, {
        contentType: 'application/javascript; charset=utf-8',
      });
      server.setRoute('/pkg/main.user.js', [
        '// ==UserScript==',
        '// @name        HttpRel',
        '// @match       https://example.com/*',
        '// @require     lib.js',
        '// ==/UserScript==',
        '',
      ].join('\n'));
      const source = await sm.addSource(`${server.baseUrl}/pkg/main.user.js`);
      const data = await sm.getSourceWithScripts(source!.id);
      expect(data!.scripts[0].status, data!.scripts[0].errorMessage).toBe('ok');
      expect(data!.scripts[0].requires).toHaveLength(1);
      expect(data!.scripts[0].requires?.[0]?.url).toBe(`${server.baseUrl}/pkg/lib.js`);
      expect(data!.scripts[0].requires?.[0]?.source).toBe(requireBody);
      // The require was actually fetched over the wire.
      expect(server.countResponses('/pkg/lib.js', 200)).toBeGreaterThanOrEqual(1);
    } finally {
      await server.stop();
    }
  });

  test('non-.js @require URL flips the script to error', async ({ sm }) => {
    // Write a sibling JSON file so the only failure surface is the
    // suffix check (not "file missing").
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.json'), '{"x":1}');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Bad Suffix',
        match: ['https://example.com/*'],
        extra: ['// @require     lib.json'],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const data = await sm.getSourceWithScripts(source!.id);
    expect(data!.scripts[0].status).toBe('invalid');
    expect(data!.scripts[0].errorMessage).toMatch(/must end in \.js/);
  });

  test('@require traversal is rejected before any fetch', async ({ sm }) => {
    // Drop a real .js file ABOVE the script's dir — if the traversal
    // weren't blocked, the fetch would succeed and we'd see status 'ok'.
    const parent = fs.mkdtempSync(path.join(scriptsDir.path, '..', 'sm-req-'));
    try {
      fs.writeFileSync(path.join(parent, 'secret.js'), 'window.__SM_SECRET = 1;');
      const child = path.join(parent, 'child');
      fs.mkdirSync(child);
      fs.writeFileSync(
        path.join(child, 'main.user.js'),
        [
          '// ==UserScript==',
          '// @name        Trav',
          '// @match       https://example.com/*',
          '// @require     ../secret.js',
          '// ==/UserScript==',
          '',
        ].join('\n'),
      );
      const source = await sm.addSource(child);
      const data = await sm.getSourceWithScripts(source!.id);
      expect(data!.scripts[0].status).toBe('invalid');
      expect(data!.scripts[0].errorMessage).toMatch(/blocked or invalid/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('cross-script dedup: two scripts requiring the same URL share one fetch', async ({ sm }) => {
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/lib.js', 'window.__SM_SHARED = 1;', {
        contentType: 'application/javascript',
      });
      server.setRoute('/pkg/a.user.js', [
        '// ==UserScript==',
        '// @name        A',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/lib.js`,
        '// ==/UserScript==',
        '',
      ].join('\n'));
      server.setRoute('/pkg/b.user.js', [
        '// ==UserScript==',
        '// @name        B',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/lib.js`,
        '// ==/UserScript==',
        '',
      ].join('\n'));
      server.setManifest('/pkg/script_manifest.json', ['a.user.js', 'b.user.js']);
      await sm.addSource(`${server.baseUrl}/pkg/script_manifest.json`);
      // Both scripts' requires resolve to the same URL — must hit it
      // exactly once during the addSource refresh pass.
      expect(server.countResponses('/lib.js', 200)).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test('require fetch failure on a working script preserves the prior version', async ({ sm }) => {
    // First refresh: require fetches cleanly, script is `ok`. Server
    // then 404s the dependency. The next manual refresh sees the
    // require fail — but the script must NOT lose its prior body or
    // its prior cached require source, just surface the error.
    const server = await UserscriptServer.start();
    try {
      const requireBody = '/* v1 */';
      server.setRoute('/dep.js', requireBody, { contentType: 'application/javascript' });
      server.setRoute('/main.user.js', [
        '// ==UserScript==',
        '// @name        ReqPreserve',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/dep.js`,
        '// ==/UserScript==',
        '',
      ].join('\n'));
      const source = await sm.addSource(`${server.baseUrl}/main.user.js`);
      const before = await sm.getSourceWithScripts(source!.id);
      expect(before!.scripts[0].status).toBe('ok');
      expect(before!.scripts[0].requires?.[0]?.source).toBe(requireBody);

      // Pull the dependency from the server. Next refresh: require
      // can't be fetched.
      server.removeRoute('/dep.js');
      await sm.updateSource(source!.id, 'manual');
      const after = await sm.getSourceWithScripts(source!.id);
      // Status flipped to error, errorMessage names the URL.
      expect(after!.scripts[0].status).toBe('invalid');
      expect(after!.scripts[0].errorMessage).toMatch(/dep\.js/);
      // But the prior require body is still there — we didn't clobber it.
      expect(after!.scripts[0].requires?.[0]?.source).toBe(requireBody);
    } finally {
      await server.stop();
    }
  });

  test('/* exported */ in @require makes top-level const visible to the main body', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Regression for the github-html-preview bug: a @require library
    // declares cross-piece helpers as top-level `const`s and lists them
    // in a JSHint `/* exported */` directive. Without forwarding, the
    // main body's call to one of those helpers throws ReferenceError
    // because each js[] entry is its own V8 top-level scope. With
    // forwarding, the require's top-level binding flows through
    // self.__smReqScope[<id>] into the main body's destructure.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), [
      '/* exported tag */',
      'const tag = (suffix) => "from-require:" + suffix;',
    ].join('\n'));
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'ExportedConst',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = tag('ok');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('from-require:ok');
    await page.close();
  });

  test('manual refresh picks up remote require changes; opportunistic does not', async ({ sm }) => {
    const server = await UserscriptServer.start();
    try {
      const scriptBody = [
        '// ==UserScript==',
        '// @name        ReqRefresh',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/dep.js`,
        '// ==/UserScript==',
        '',
      ].join('\n');
      server.setRoute('/dep.js', '/* v1 */', { contentType: 'application/javascript' });
      server.setRoute('/main.user.js', scriptBody);
      const source = await sm.addSource(`${server.baseUrl}/main.user.js`);
      const before = await sm.getSourceWithScripts(source!.id);
      expect(before!.scripts[0].requires?.[0]?.source).toBe('/* v1 */');

      // Server replaces the dependency.
      server.setRoute('/dep.js', '/* v2 */', { contentType: 'application/javascript' });

      // Opportunistic refresh: must NOT re-pull the require, even
      // though the underlying body could've changed. The cached
      // version persists.
      await sm.updateSource(source!.id, 'opportunistic');
      const afterOpp = await sm.getSourceWithScripts(source!.id);
      expect(afterOpp!.scripts[0].requires?.[0]?.source).toBe('/* v1 */');

      // Manual refresh: re-checks remote requires and surfaces v2.
      await sm.updateSource(source!.id, 'manual');
      const afterManual = await sm.getSourceWithScripts(source!.id);
      expect(afterManual!.scripts[0].requires?.[0]?.source).toBe('/* v2 */');
    } finally {
      await server.stop();
    }
  });
});
