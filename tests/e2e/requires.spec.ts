// End-to-end coverage of the `@require` pipeline.
//
//   - A `@require` declared on a userscript is prefetched at addCollection
//     time and concatenated before the body when chrome.userScripts
//     registers the script. The DOM mutation is the proof: it only
//     runs if the require's exported function survived the prepend.
//   - Relative `@require` paths resolve against the script's parent
//     dir (the same file-loader rule `@icon` uses) — works for both
//     file:// and HTTP collections.
//   - Refusing dangerous refs (path traversal, non-`.js` suffix,
//     absolute file://) flips the script to status: 'invalid' and the
//     injection never happens.
//   - Cross-script dedup: two scripts requiring the same canonical URL
//     share one fetch in a refreshAllCollections pass.
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
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
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
      const collection = await sm.addCollection(`${server.baseUrl}/pkg/main.user.js`);
      const data = await sm.getCollectionWithScripts(collection!.id);
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

  test('HTTP @require may climb out of the script\'s own directory', async ({ sm }) => {
    // The published shape of a userscript repo: scripts nested under
    // `pkg/`, shared libraries one level up. Violentmonkey resolves
    // this; containment only applies to a local script (see
    // file-loader.ts).
    const server = await UserscriptServer.start();
    try {
      const requireBody = 'window.__SM_HTTP_UP = "up-one-level";';
      server.setRoute('/lib/shared.js', requireBody, {
        contentType: 'application/javascript; charset=utf-8',
      });
      server.setRoute('/pkg/main.user.js', [
        '// ==UserScript==',
        '// @name        HttpUp',
        '// @match       https://example.com/*',
        '// @require     ../lib/shared.js',
        '// ==/UserScript==',
        '',
      ].join('\n'));
      const collection = await sm.addCollection(`${server.baseUrl}/pkg/main.user.js`);
      const data = await sm.getCollectionWithScripts(collection!.id);
      expect(data!.scripts[0].status, data!.scripts[0].errorMessage).toBe('ok');
      expect(data!.scripts[0].requires?.[0]?.url).toBe(`${server.baseUrl}/lib/shared.js`);
      expect(data!.scripts[0].requires?.[0]?.source).toBe(requireBody);
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
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
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
      const collection = await sm.addCollection(child);
      const data = await sm.getCollectionWithScripts(collection!.id);
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
      await sm.addCollection(`${server.baseUrl}/pkg/script_manifest.json`);
      // Both scripts' requires resolve to the same URL — must hit it
      // exactly once during the addCollection refresh pass.
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
      const collection = await sm.addCollection(`${server.baseUrl}/main.user.js`);
      const before = await sm.getCollectionWithScripts(collection!.id);
      expect(before!.scripts[0].status).toBe('ok');
      expect(before!.scripts[0].requires?.[0]?.source).toBe(requireBody);

      // Pull the dependency from the server. Next refresh: require
      // can't be fetched.
      server.removeRoute('/dep.js');
      await sm.updateCollection(collection!.id, 'manual');
      const after = await sm.getCollectionWithScripts(collection!.id);
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
    await sm.addCollection(scriptsDir.path);
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
    await sm.addCollection(scriptsDir.path);
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
    await sm.addCollection(scriptsDir.path);
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
    await sm.addCollection(scriptsDir.path);
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // document-idle waits for readyState complete, so the require observed a
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
    // fail to parse and the registry's `run` is never reached. Without the
    // trailing sentinel entry that failure is completely invisible —
    // no error, no log, no badge, script just does nothing forever.
    // (Under separate entries the broken require died alone and the
    // body still ran.)
    //
    // The install-time parse check normally catches this first and the
    // script never registers at all — see parse-check-install.spec.ts.
    // Turn it off here so the run-time backstop is still exercised: it
    // is what covers a browser without `chrome.offscreen` and a check
    // that times out. (A row that dodged the check at install time is
    // now caught by the re-check in `runSync` before it registers.)
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // The body genuinely does not run — that part matches TM.
    await page.waitForTimeout(500);
    await expect(page.locator('#target')).not.toHaveText('ran');

    // But the failure IS reported: the sentinel entry is its own
    // script, so it parses and runs even though the one before it
    // didn't.
    const collections = await sm.getCollections();
    const scriptIds = collections.flatMap((s) => s.scriptIds);
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
    // The sentinel infers "js[2] failed to parse" from `run` never
    // being called. But the prelude registers a script's entry BEFORE
    // running the in-page matcher, so on a non-matching page `run`
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const collections = await sm.getCollections();
    const scriptIds = collections.flatMap((s) => s.scriptIds);
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
    // Positive case, so wait for the entry rather than pausing: the
    // sentinel reports from the page and the wait ends as soon as it
    // lands. (The negative case above has to pause — there is no event
    // to wait for when the point is that nothing was reported.)
    const log = await waitFor(
      () => sm.getScriptLog(scriptIds[0]),
      (entries) => entries.some((e) => e.level === 'error' && /failed to parse/i.test(e.message)),
      { label: 'sentinel reports on a matching page' },
    );
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await page.waitForTimeout(500);
    await expect(page.locator('#target')).not.toHaveText('ran');

    const collections = await sm.getCollections();
    const scriptIds = collections.flatMap((s) => s.scriptIds);
    expect(scriptIds.length).toBe(1);
    // The pause above is for the negative assertion (the body must not
    // run). This read is a positive one, so wait for the entry — same
    // shape as the sentinel case earlier in this file.
    const log = await waitFor(
      () => sm.getScriptLog(scriptIds[0]),
      (entries) => entries.some((e) => e.level === 'error' && /lib-exploded/.test(e.message)),
      { label: 'the require throw reaches the script log' },
    );
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
      const collection = await sm.addCollection(`${server.baseUrl}/main.user.js`);
      const before = await sm.getCollectionWithScripts(collection!.id);
      expect(before!.scripts[0].requires?.[0]?.source).toBe('/* v1 */');

      // Server replaces the dependency.
      server.setRoute('/dep.js', '/* v2 */', { contentType: 'application/javascript' });

      // Opportunistic refresh: must NOT re-pull the require, even
      // though the underlying body could've changed. The cached
      // version persists.
      await sm.updateCollection(collection!.id, 'opportunistic');
      const afterOpp = await sm.getCollectionWithScripts(collection!.id);
      expect(afterOpp!.scripts[0].requires?.[0]?.source).toBe('/* v1 */');

      // Manual refresh: re-checks remote requires and surfaces v2.
      await sm.updateCollection(collection!.id, 'manual');
      const afterManual = await sm.getCollectionWithScripts(collection!.id);
      expect(afterManual!.scripts[0].requires?.[0]?.source).toBe('/* v2 */');
    } finally {
      await server.stop();
    }
  });
  // A manual Refresh rebuilds dependencies from scratch so a user can
  // pick up a library update without touching the script — which meant
  // re-downloading every `@require` and `@resource` body on every click,
  // measured at ~1.3s of a Refresh All on a real profile even when
  // nothing had changed.
  //
  // Now the refetch is conditional. The point of the test is that BOTH
  // halves hold: the request really is conditional (the server saw the
  // validator and answered 304, not a fresh 200), and the entry survives
  // a response that carried no body at all.
  test('a manual refresh re-checks requires conditionally and keeps the body on 304', async ({ sm }) => {
    const server = await UserscriptServer.start();
    try {
      const LIB = 'function libFn() { return 42; }\n';
      server.setRoute('/lib.js', LIB, { etag: '"lib-v1"' });
      scriptsDir.writeRaw('uses-lib.user.js', [
        '// ==UserScript==',
        '// @name        Uses Lib',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/lib.js`,
        '// ==/UserScript==',
        'void libFn;',
      ].join('\n') + '\n');

      const collection = await sm.addCollection(scriptsDir.path);
      await sm.syncNow();
      const first = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      expect(first.status).toBe('ok');
      expect(first.requires![0].source).toBe(LIB);
      // The validator has to be stored, or the next request can't be
      // conditional and the whole optimisation silently does nothing.
      expect(first.requires![0].httpEtag).toBe('"lib-v1"');

      const before = server.requestLog.filter((e) => e.path === '/lib.js').length;
      await sm.updateCollection(collection!.id, 'manual');

      // The refresh asked again — this is a manual click, which
      // deliberately re-checks dependencies — but conditionally.
      const hits = server.requestLog.filter((e) => e.path === '/lib.js');
      expect(hits.length).toBe(before + 1);
      const latest = hits[hits.length - 1];
      expect(latest.ifNoneMatch).toBe('"lib-v1"');
      expect(latest.status).toBe(304);

      // A 304 sends no body. The entry has to come back whole anyway,
      // rebuilt from the copy we already held — and `loadedAt` must not
      // move, since the content did not.
      const after = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      expect(after.status).toBe('ok');
      expect(after.requires![0].source).toBe(LIB);
      expect(after.requires![0].contentHash).toBe(first.requires![0].contentHash);
      expect(after.requires![0].loadedAt).toBe(first.requires![0].loadedAt);
      expect(after.requires![0].httpEtag).toBe('"lib-v1"');

      // And a real change still lands: the validator moves, the server
      // answers 200, and the new body replaces the old.
      server.setRoute('/lib.js', 'function libFn() { return 43; }\n', { etag: '"lib-v2"' });
      await sm.updateCollection(collection!.id, 'manual');
      const updated = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      expect(updated.requires![0].source).toContain('43');
      expect(updated.requires![0].httpEtag).toBe('"lib-v2"');
      expect(updated.requires![0].loadedAt).not.toBe(first.requires![0].loadedAt);
    } finally {
      await server.stop();
    }
  });
  // The same conditional re-check, driven from the collections PAGE.
  //
  // Not redundant with the test above, which drives the service worker
  // through the test surface. The refresh pipeline runs in whichever
  // context calls it, and a page-initiated http read is handed to the
  // worker over `chrome.runtime` (see src/http-read.ts) rather than
  // fetched locally. That hop carries a headers field, and a conditional
  // re-check that forgot to populate it would still 200 happily —
  // correct, silently unconditional, and green in every worker-driven
  // test. Which is where the real Refresh button lives.
  test('the conditional re-check survives the page → worker fetch hop', async ({
    sm, extensionContext, extensionId,
  }) => {
    const server = await UserscriptServer.start();
    const page = await extensionContext.newPage();
    try {
      server.setRoute('/hop-lib.js', 'function hopFn() {}\n', { etag: '"hop-v1"' });
      scriptsDir.writeRaw('hop.user.js', [
        '// ==UserScript==',
        '// @name        Hop',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/hop-lib.js`,
        '// ==/UserScript==',
        'void hopFn;',
      ].join('\n') + '\n');
      const collection = await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const card = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
      await expect(card).toBeVisible();

      const before = server.requestLog.filter((e) => e.path === '/hop-lib.js').length;
      await card.getByRole('button', { name: 'Refresh this collection' }).click();
      await expect.poll(
        () => server.requestLog.filter((e) => e.path === '/hop-lib.js').length,
      ).toBeGreaterThan(before);

      const hits = server.requestLog.filter((e) => e.path === '/hop-lib.js');
      const latest = hits[hits.length - 1];
      expect(latest.ifNoneMatch).toBe('"hop-v1"');
      expect(latest.status).toBe(304);

      // And the body survived a response that carried none.
      await expect.poll(async () => {
        const s = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
        return s.requires?.[0]?.source;
      }).toBe('function hopFn() {}\n');
    } finally {
      await page.close();
      await server.stop();
    }
  });
  // `@resource` shares the conditional path with `@require` but not the
  // reconstruction: its prior body round-trips through base64 rather
  // than a UTF-8 re-encode, and its bytes are arbitrary — a corrupted
  // one doesn't fail loudly, it just renders wrong. Binary content on
  // purpose, since that is where a text-shaped bug would hide.
  //
  // Also pins the shared-cache claim: a second script declaring the same
  // URL, added AFTER the first stored a validator, still ends up with
  // the bytes even though the 304 was answered against someone else's
  // copy and carried no body of its own.
  test('a @resource re-checks conditionally, and a co-declaring script still gets the bytes', async ({ sm }) => {
    const server = await UserscriptServer.start();
    try {
      // Includes a 0x00 and a byte that is not valid UTF-8 on its own.
      const BODY = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x41, 0x42]);
      server.setRoute('/blob.bin', BODY, {
        etag: '"blob-v1"',
        contentType: 'application/octet-stream',
      });
      const script = (name: string) => [
        '// ==UserScript==',
        `// @name        ${name}`,
        '// @match       https://example.com/*',
        `// @resource    payload ${server.baseUrl}/blob.bin`,
        '// ==/UserScript==',
        'void 0;',
      ].join('\n') + '\n';

      scriptsDir.writeRaw('res-a.user.js', script('Res A'));
      const collection = await sm.addCollection(scriptsDir.path);
      await sm.syncNow();
      const firstA = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      expect(firstA.status).toBe('ok');
      const expected = BODY.toString('base64');
      expect(firstA.resources![0].bytesBase64).toBe(expected);
      expect(firstA.resources![0].httpEtag).toBe('"blob-v1"');

      // A second script on the same URL, with no stored copy of its own.
      scriptsDir.writeRaw('res-b.user.js', script('Res B'));
      const before = server.requestLog.filter((e) => e.path === '/blob.bin').length;
      await sm.updateCollection(collection!.id, 'manual');

      const hits = server.requestLog.filter((e) => e.path === '/blob.bin');
      // One fetch for the pair — the cross-script cache — and conditional.
      expect(hits.length).toBe(before + 1);
      expect(hits[hits.length - 1].ifNoneMatch).toBe('"blob-v1"');
      expect(hits[hits.length - 1].status).toBe(304);

      const after = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
      expect(after).toHaveLength(2);
      for (const s of after) {
        expect(s.status).toBe('ok');
        // Byte-exact through the 304, for the script that had a prior
        // AND the one that never fetched this URL before.
        expect(s.resources![0].bytesBase64).toBe(expected);
        expect(s.resources![0].contentType).toContain('application/octet-stream');
      }
      // The one that did have a prior kept its identity untouched.
      const a = after.find((s) => s.relativePath === 'res-a.user.js')!;
      expect(a.resources![0].contentHash).toBe(firstA.resources![0].contentHash);
      expect(a.resources![0].loadedAt).toBe(firstA.resources![0].loadedAt);
      expect(a.resources![0].size).toBe(firstA.resources![0].size);
    } finally {
      await server.stop();
    }
  });
});
