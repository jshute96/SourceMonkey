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
//   - Shared scope: requires are concatenated ahead of the body in a
//     single injected entry, so a library's top-level `const`/`class`
//     is simply visible to the script — including the minified,
//     directive-free, `GM_`-prefixed shape that motivated the design.
//     Requires also see each other and the GM bindings, and run inside
//     the @run-at gate rather than at document_start.
//   - Manual refresh picks up remote require changes; the
//     opportunistic path (background update on navigation) does NOT —
//     a manual click is needed to surface remote require updates.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor } from '../fixtures/sw-api';
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
      // Names the containment rule specifically — a `../` ref and an
      // unsupported scheme are different mistakes and used to share
      // one message that stated neither.
      expect(data!.scripts[0].errorMessage)
        .toMatch(/points outside the script's own folder/);
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

  test('require fetch failure on a working script keeps it running (refresh-failed)', async ({ sm }) => {
    // First refresh: require fetches cleanly, script is `ok`. Server
    // then 404s the dependency. The next manual refresh sees the
    // require fail — but the script must keep running on its cached
    // deps: a flaky dep host must not disable a working script. It stays
    // `ok` (still injectable) and surfaces `refreshError` instead.
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
      // Still OK + injectable, but flagged: refreshError names the URL.
      expect(after!.scripts[0].status).toBe('ok');
      expect(after!.scripts[0].errorMessage).toBeUndefined();
      expect(after!.scripts[0].refreshError).toMatch(/dep\.js/);
      // And the prior require body is still there — we didn't clobber it.
      expect(after!.scripts[0].requires?.[0]?.source).toBe(requireBody);
    } finally {
      await server.stop();
    }
  });

  test('a @require top-level const is visible to the main body', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Under separate entries this needed a `/* exported */` directive
    // and a name-forwarding bridge. Concatenated, the binding is
    // simply in scope.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), [
      'const tag = (suffix) => "from-require:" + suffix;',
    ].join('\n'));
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'SharedScope',
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

  test('a minified @require exposing one top-level class reaches the main body', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The script that prompted Mode A (the concatenated arrangement;
    // see docs/injection-modes.md): PRO-2684/GM_config is minified,
    // ships no `/* exported */` directive, puts its whole program on
    // one physical line, and names its class `GM_config` — every one
    // of which defeated some part of the name bridge. Nothing here is
    // a special case now.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), [
      '// ==UserScript==',
      '// @name  Fake Config',
      '// ==/UserScript==',
      'class GM_config{static label(s){return "from-class:"+s}}',
    ].join('\n'));
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'InferredClass',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        // A real grant, so the GM binding block is emitted alongside —
        // `const GM_setValue` and the library's `GM_config` now share
        // one scope without colliding.
        grant: ['GM_setValue'],
        extra: ['// @require     lib.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = GM_config.label('ok');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('from-class:ok');
    await page.close();
  });

  test('a later @require sees an earlier one, and both see the GM bindings', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // One scope, in declaration order — the TM/VM arrangement. The GM
    // binding block is emitted once, ahead of the first require, so
    // library top-level code sees it too.
    fs.writeFileSync(path.join(scriptsDir.path, 'a.js'), 'const first = GM_info.script.name;');
    fs.writeFileSync(path.join(scriptsDir.path, 'b.js'), 'const second = first + ":second";');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Chain',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @require     a.js', '// @require     b.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = second;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('Chain:second');
    await page.close();
  });

  test('@require top-level GM_setValue sees a live storage cache', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Fidelity win that falls out of concatenation. Require entries
    // used to fire in Chrome's document_start burst, before the GM
    // prelude ran storage.init — so a library writing a value at
    // top level hit an uninitialized cache. Now they run inside the
    // @run-at gate with the body.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'GM_setValue("fromRequire", "stored");');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'RequireStorage',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
        extra: ['// @require     lib.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = GM_getValue('fromRequire', 'MISSING');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('stored');
    await page.close();
  });

  test('@require code runs inside the @run-at gate, not at document_start', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Fidelity win the docs advertise, asserted directly. Under the
    // previous separate-entries arrangement a require was its own
    // js[] entry and fired in Chrome's document_start burst
    // regardless of the script's declared @run-at; concatenated, it
    // runs with the body inside the gate.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      'const readyAtRequire = document.readyState;',
    );
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'RequireTiming',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-idle',
        extra: ['// @require     lib.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = readyAtRequire;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // document-idle waits for `load`, so the require observed a
    // fully-loaded document — not the `loading` it would have seen
    // firing at document_start.
    await expect(page.locator('#target')).toHaveText('complete');
    await page.close();
  });

  test('a @require with a syntax error is reported, not silently fatal', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Everything the user wrote is ONE V8 script now, so an
    // unterminated block comment in a require makes the whole entry
    // fail to parse and `__smRun` is never reached. Without the
    // trailing sentinel entry that failure is completely invisible —
    // no error, no log, no badge, script just does nothing forever.
    // (Under separate entries the broken require died alone and the
    // body still ran.)
    //
    // The install-time parse check normally catches this first and the
    // script never registers at all — see parse-check-install.spec.ts.
    // Turn it off here so the run-time backstop is still exercised: it
    // is what covers a browser without `chrome.offscreen`, a check that
    // times out, and rows stored before the check existed.
    await sm.setParseCheckEnabled(false);
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const ok = 1;\n/* unterminated');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'BrokenRequire',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = 'ran';
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // The body genuinely does not run — that part matches TM.
    await page.waitForTimeout(500);
    await expect(page.locator('#target')).not.toHaveText('ran');

    // But the failure IS reported: the sentinel entry is its own
    // script, so it parses and runs even though the one before it
    // didn't.
    const sources = await sm.getSources();
    const scriptIds = sources.flatMap((s) => s.scriptIds);
    expect(scriptIds.length).toBe(1);
    // The sentinel reports from the page, so the entry lands some time
    // after the navigation settles — wait for it rather than reading
    // once and hoping the 500 ms above was enough.
    const log = await waitFor(
      () => sm.getScriptLog(scriptIds[0]),
      (entries) => entries.some((e) => e.level === 'error' && /failed to parse/i.test(e.message)),
      { label: 'parse failure reaches the script log' },
    );
    const errors = log.filter((e) => e.level === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/failed to parse/i);
    await page.close();
  });

  test('the parse-failure sentinel stays quiet on pages the script does not match', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Same reason as the test above: exercise the backstop, not the
    // install-time check that would otherwise stop this script from
    // registering.
    await sm.setParseCheckEnabled(false);
    // The sentinel infers "js[2] failed to parse" from __smRun never
    // being called. But the prelude registers a script's entry BEFORE
    // running the in-page matcher, so on a non-matching page __smRun
    // is legitimately never called either. Without a `matched` check
    // the sentinel can't tell those apart.
    //
    // A regex @include is the case that makes this visible: it can't
    // be expressed as a Chrome match pattern, so the script registers
    // at <all_urls> and is filtered in-page. A broken one would then
    // log an error and turn the badge red on EVERY page the user
    // visits, not just its own.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const ok = 1;\n/* unterminated');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'RegexFiltered',
        // No @match — a regex @include only, so needsWrapperFilter is
        // true and the wrapper-side matcher decides.
        include: ['/^https?:\\/\\/[^/]+\\/target\\.html$/'],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      body: `document.title = 'ran';`,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const sources = await sm.getSources();
    const scriptIds = sources.flatMap((s) => s.scriptIds);
    expect(scriptIds.length).toBe(1);

    // A page the regex does NOT match. The script is registered here
    // (<all_urls>) but the in-page matcher rejects it.
    const other = await extensionContext.newPage();
    await other.goto(`${fixtureServer.baseUrl}/other.html`);
    await other.waitForTimeout(500);
    const quiet = await sm.getScriptLog(scriptIds[0]);
    expect(
      quiet.filter((e) => e.level === 'error'),
      'sentinel fired on a page the script does not match',
    ).toEqual([]);
    await other.close();

    // ...and it still reports on a page the script DOES match, so the
    // guard didn't just silence the sentinel outright.
    const target = await extensionContext.newPage();
    await target.goto(`${fixtureServer.baseUrl}/target.html`);
    await target.waitForTimeout(500);
    const log = await sm.getScriptLog(scriptIds[0]);
    const errors = log.filter((e) => e.level === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/failed to parse/i);
    await target.close();
  });

  test('a @require that throws aborts the script, and is reported with a stack', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The pair to the unparsable case above. This library parses, so
    // our error path actually sees the throw and can report a real
    // message and stack — but the body still never runs, because
    // requires execute ahead of it in the same wrap function. TM/VM
    // abort the same way; the previous separate-entries arrangement
    // let the body run anyway.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      'throw new Error("lib-exploded: intentional top-level failure");',
    );
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'ThrowingRequire',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = 'ran';
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.waitForTimeout(500);
    await expect(page.locator('#target')).not.toHaveText('ran');

    const sources = await sm.getSources();
    const scriptIds = sources.flatMap((s) => s.scriptIds);
    expect(scriptIds.length).toBe(1);
    const log = await sm.getScriptLog(scriptIds[0]);
    const errors = log.filter((e) => e.level === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/lib-exploded/);
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
