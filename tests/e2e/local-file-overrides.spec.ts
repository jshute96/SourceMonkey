// End-to-end coverage of local stand-ins for `@require` / `@resource`
// files declared by absolute URL — see docs/local-file-overrides.md.
//
// The point of the feature is that a script can keep the portable,
// TM-compatible `@require https://…` form and STILL be developed against
// a copy on disk. So every test here declares an absolute URL and
// asserts on which body actually landed:
//
//   - a file next to the script wins over the published URL;
//   - a deeper `lib/` layout matches by path suffix, longest first, and
//     a `<host>/` directory under a root beats any bare path suffix;
//   - editing the local file surfaces on an opportunistic refresh (the
//     dev loop), while a remote dependency stays cached;
//   - the per-collection opt-out turns all of it off;
//   - `.js`-suffix and traversal rules still run on the DECLARED URL,
//     so a stand-in can't be used to get around them;
//   - `@resource` and `@icon` take the same rule, the latter through
//     its own fetch + cache in site-icon.ts;
//   - an SRI hash fragment is stripped from what the user reads.
//
// The remote side is a real HTTP server serving a DIFFERENT body from
// the local file, so "which one won" is never ambiguous.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('local file overrides', () => {
  let scriptsDir: ScriptsDir;
  let server: UserscriptServer;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    server = await UserscriptServer.start();
    server.setRoute('/lib/util.js', 'window.__SM_LOCAL = "remote";', {
      contentType: 'application/javascript',
    });
  });
  test.afterEach(async () => {
    scriptsDir.cleanup();
    await server.stop();
  });

  // Write a script whose `@require` is the server's absolute URL — the
  // form a published script would carry.
  function writeScript(extra: string[] = []): void {
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Local Files',
        match: ['https://example.com/*'],
        extra: [`// @require     ${server.baseUrl}/lib/util.js`, ...extra],
      },
      body: 'void window.__SM_LOCAL;',
    });
  }

  test('a file next to the script stands in for the declared URL', async ({ sm }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
    const req = data!.scripts[0].requires?.[0];
    expect(data!.scripts[0].status, data!.scripts[0].errorMessage).toBe('ok');
    expect(req?.source).toBe('window.__SM_LOCAL = "local";');
    // The declared URL stays the entry's identity — it's the dedup key
    // and what the script falls back to if the local file goes away.
    expect(req?.url).toBe(`${server.baseUrl}/lib/util.js`);
    expect(req?.localUrl).toMatch(/\/util\.js$/);
    // Nothing was fetched from the server: the stand-in is found before
    // the declared URL is ever reached for.
    expect(server.countResponses('/lib/util.js', 200)).toBe(0);
  });

  test('no local file means the declared URL is fetched as usual', async ({ sm }) => {
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
    const req = data!.scripts[0].requires?.[0];
    expect(req?.source).toBe('window.__SM_LOCAL = "remote";');
    expect(req?.localUrl).toBeUndefined();
    expect(server.countResponses('/lib/util.js', 200)).toBe(1);
  });

  test('a deeper path suffix beats a bare basename in the same root', async ({ sm }) => {
    // Both could match `…/lib/util.js`. The `lib/` layout is the
    // deliberate one, so it has to win over the loose file.
    fs.mkdirSync(path.join(scriptsDir.path, 'lib'));
    fs.writeFileSync(path.join(scriptsDir.path, 'lib', 'util.js'), 'window.__SM_LOCAL = "deep";');
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "shallow";');
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
    expect(data!.scripts[0].requires?.[0]?.source).toBe('window.__SM_LOCAL = "deep";');
  });

  // The layout a repo of userscripts actually uses: scripts nested
  // under `sites/<host>/`, shared libraries in `lib/` at the top. Only
  // the COLLECTION root can see that `lib/` — the script's own folder is
  // a floor, and the search never climbs out of it.
  test('a nested script finds a library at the collection root', async ({ sm }) => {
    fs.mkdirSync(path.join(scriptsDir.path, 'lib'));
    fs.writeFileSync(path.join(scriptsDir.path, 'lib', 'util.js'), 'window.__SM_LOCAL = "repo";');
    scriptsDir.write({
      relativePath: 'sites/example.com/main.user.js',
      meta: {
        name: 'Nested',
        match: ['https://example.com/*'],
        extra: [`// @require     ${server.baseUrl}/lib/util.js`],
      },
      body: 'void window.__SM_LOCAL;',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const data = await sm.getCollectionWithScripts(collection!.id);
    const req = data!.scripts[0].requires?.[0];
    expect(data!.scripts[0].status, data!.scripts[0].errorMessage).toBe('ok');
    expect(req?.source).toBe('window.__SM_LOCAL = "repo";');
    expect(server.countResponses('/lib/util.js', 200)).toBe(0);
  });

  // The dev loop: edit the library, reload the page, see the change.
  // An opportunistic refresh is what a navigation triggers, and it
  // normally reuses every cached dependency verbatim.
  test('editing the local file surfaces on an opportunistic refresh', async ({ sm }) => {
    const libPath = path.join(scriptsDir.path, 'util.js');
    fs.writeFileSync(libPath, 'window.__SM_LOCAL = "v1";');
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    let data = await sm.getCollectionWithScripts(collection!.id);
    expect(data!.scripts[0].requires?.[0]?.source).toBe('window.__SM_LOCAL = "v1";');

    fs.writeFileSync(libPath, 'window.__SM_LOCAL = "v2";');
    await sm.updateCollection(collection!.id, 'opportunistic');
    data = await sm.getCollectionWithScripts(collection!.id);
    expect(data!.scripts[0].requires?.[0]?.source).toBe('window.__SM_LOCAL = "v2";');
  });

  // The other half of that policy: a REMOTE dependency is still left
  // alone on the opportunistic path, which is what keeps per-navigation
  // cost bounded for a user with many requires.
  test('a remote dependency is still not refetched opportunistically', async ({ sm }) => {
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    expect(server.countResponses('/lib/util.js', 200)).toBe(1);
    await sm.updateCollection(collection!.id, 'opportunistic');
    expect(server.countResponses('/lib/util.js', 200)).toBe(1);
  });

  test('the local file going away falls back to the declared URL', async ({ sm }) => {
    const libPath = path.join(scriptsDir.path, 'util.js');
    fs.writeFileSync(libPath, 'window.__SM_LOCAL = "local";');
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0]?.localUrl)
      .toBeTruthy();

    fs.rmSync(libPath);
    await sm.updateCollection(collection!.id, 'opportunistic');
    const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
    expect(req?.source).toBe('window.__SM_LOCAL = "remote";');
    expect(req?.localUrl).toBeUndefined();
  });

  test('the per-collection opt-out turns substitution off', async ({ sm }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0]?.localUrl)
      .toBeTruthy();

    await sm.setCollectionLocalFiles(collection!.id, false);
    await sm.updateCollection(collection!.id, 'manual');
    const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
    expect(req?.source).toBe('window.__SM_LOCAL = "remote";');
    expect(req?.localUrl).toBeUndefined();
  });

  // The `.js` gate runs on the declared URL before any stand-in is
  // considered, so a local `.js` file can't launder a non-JS ref.
  test('a non-.js declared URL is still rejected, local file or not', async ({ sm }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'data.json'), '{"x":1}');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Bad Suffix',
        match: ['https://example.com/*'],
        extra: [`// @require     ${server.baseUrl}/data.json`],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('invalid');
    expect(script.errorMessage).toMatch(/must end in \.js/);
  });

  // Candidates are built from the declared URL's NORMALIZED pathname, so
  // a `..`-laden URL can't name a file above the script's folder. The
  // planted file is one level up; finding it would be the bug.
  test('a declared URL full of .. cannot reach outside the script folder', async ({ sm }) => {
    const parent = path.dirname(scriptsDir.path);
    const secret = path.join(parent, 'sm-local-secret.js');
    fs.writeFileSync(secret, 'window.__SM_LOCAL = "escaped";');
    try {
      scriptsDir.write({
        relativePath: 'main.user.js',
        meta: {
          name: 'Climber',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/a/../../sm-local-secret.js`],
        },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      // Either the declared URL 404s or it serves something — but under
      // no circumstance is it the planted file.
      expect(req?.source).not.toBe('window.__SM_LOCAL = "escaped";');
      expect(req?.localUrl).toBeUndefined();
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  // The collection root is a floor too, and it is the OUTERMOST implicit
  // root — so this is the case the test above no longer covers now that
  // a nested script has two roots (its own folder, then the
  // collection's). The planted file is one level above the collection.
  test('a nested script cannot reach outside the collection root', async ({ sm }) => {
    const parent = path.dirname(scriptsDir.path);
    const secret = path.join(parent, 'sm-local-secret.js');
    fs.writeFileSync(secret, 'window.__SM_LOCAL = "escaped";');
    try {
      scriptsDir.write({
        relativePath: 'sites/example.com/main.user.js',
        meta: {
          name: 'Nested Climber',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/a/../../../sm-local-secret.js`],
        },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      expect(req?.source).not.toBe('window.__SM_LOCAL = "escaped";');
      expect(req?.localUrl).toBeUndefined();
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  // A manifest names a file, so the root its scripts share is the
  // manifest's own directory — the same `lib/` reach a directory
  // collection gets, through a different derivation.
  test('a manifest collection roots its scripts at the manifest directory', async ({ sm }) => {
    fs.mkdirSync(path.join(scriptsDir.path, 'lib'));
    fs.writeFileSync(path.join(scriptsDir.path, 'lib', 'util.js'), 'window.__SM_LOCAL = "manifest";');
    scriptsDir.write({
      relativePath: 'sites/example.com/main.user.js',
      meta: {
        name: 'Manifest Nested',
        match: ['https://example.com/*'],
        extra: [`// @require     ${server.baseUrl}/lib/util.js`],
      },
      body: '',
    });
    const manifest = path.join(scriptsDir.path, 'script_manifest.json');
    fs.writeFileSync(manifest, JSON.stringify(['sites/example.com/main.user.js']));
    const collection = await sm.addCollection(manifest);
    const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
    expect(req?.source).toBe('window.__SM_LOCAL = "manifest";');
    expect(server.countResponses('/lib/util.js', 200)).toBe(0);
  });

  // Substitution must never be silent. One line when it starts, one per
  // edit, one when it stops — and nothing in between, or the many
  // opportunistic refreshes between edits would bury the log.
  test('the Log records a stand-in starting, changing, and stopping', async ({ sm }) => {
    const libPath = path.join(scriptsDir.path, 'util.js');
    fs.writeFileSync(libPath, 'window.__SM_LOCAL = "v1";');
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    const localLines = async () =>
      (await sm.getScriptLog(scriptId))
        .filter((e) => /is (loading from file:|no longer loading)/.test(e.message))
        .map((e) => e.message);

    expect(await localLines()).toEqual([
      expect.stringMatching(/^@require .* is loading from file:\/\/.*\/util\.js$/),
    ]);

    // Manual refreshes here, not opportunistic ones: opportunistic
    // checks are rate-limited to one per `UPDATE_MIN_INTERVAL_MS` per
    // collection, so a test that fired several in a row would be asserting
    // on refreshes that never ran. The log diff doesn't depend on the
    // mode — the live-re-read behavior it rests on is covered above.

    // An unchanged stand-in says nothing, however many times we look.
    await sm.updateCollection(collection!.id, 'manual');
    await sm.updateCollection(collection!.id, 'manual');
    expect(await localLines()).toHaveLength(1);

    // An edit is news.
    fs.writeFileSync(libPath, 'window.__SM_LOCAL = "v2";');
    await sm.updateCollection(collection!.id, 'manual');
    expect(await localLines()).toHaveLength(2);

    // So is losing it.
    fs.rmSync(libPath);
    await sm.updateCollection(collection!.id, 'manual');
    const lines = await localLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/is no longer loading from a local file$/);
  });

  // A `@require` may carry its expected hash in the URL fragment
  // (Tampermonkey's SRI form). It's part of the ref everywhere that
  // matters — resolution, dedup, storage — but it is pure noise in a
  // tooltip, a Log line, or a details row, so every human-facing
  // surface drops it.
  test('an SRI hash fragment is stripped from what the user reads', async ({
    sm, extensionContext, extensionId,
  }) => {
    const hash = '#md5=c45f9b0d19ba69bb2d44918746c4d7ae';
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    writeScript([]);
    // Rewrite the declaration to carry the fragment.
    const scriptPath = path.join(scriptsDir.path, 'main.user.js');
    fs.writeFileSync(
      scriptPath,
      fs.readFileSync(scriptPath, 'utf8').replace('/lib/util.js', `/lib/util.js${hash}`),
    );
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    // Stored verbatim: the fragment is part of the ref, and stripping it
    // at the storage layer would lose what the author wrote.
    expect(script.requires?.[0]?.ref).toContain(hash);

    const log = (await sm.getScriptLog(script.id))
      .map((e) => e.message)
      .filter((m) => /is loading from file:/.test(m));
    expect(log).toHaveLength(1);
    expect(log[0]).not.toContain(hash);
    expect(log[0]).toContain('/lib/util.js is loading from file://');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await page.waitForSelector('.tab');
    const title = await page.locator('.tab').nth(1).getAttribute('title');
    expect(title).not.toContain(hash);
    expect(title).toContain(`${server.baseUrl}/lib/util.js\n\nLoaded from file://`);
    await page.close();
  });

  // `@icon` is the third file reference a script can declare, and it
  // goes through its own fetch + cache in site-icon.ts rather than
  // `attachFiles`. It gets the same rule anyway — a script whose icon
  // ignored the copy on disk while its libraries used it would read as
  // a gap, not a policy.
  test('@icon takes stand-ins under the same rule', async ({
    sm, extensionContext, extensionId,
  }) => {
    // A real 1x1 PNG on disk, and a DIFFERENT one served at the URL the
    // script declares, so which one painted is unambiguous.
    const localPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    fs.writeFileSync(path.join(scriptsDir.path, 'logo.png'), localPng);
    server.setRoute('/assets/logo.png', 'not-a-png-at-all', { contentType: 'image/png' });
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Icon',
        match: ['https://example.com/*'],
        extra: [`// @icon        ${server.baseUrl}/assets/logo.png`],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const img = page
      .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
      .first()
      .locator('.site-icon a.site-icon-inner img');
    // The painted data: URL carries the LOCAL file's bytes.
    await expect(img).toHaveAttribute('src', `data:image/png;base64,${localPng.toString('base64')}`);
    // And the declared URL was never fetched.
    expect(server.countResponses('/assets/logo.png', 200)).toBe(0);
    await page.close();
  });

  test('@icon falls back to the declared URL with no local file', async ({
    sm, extensionContext, extensionId,
  }) => {
    const remotePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    server.setRoute('/assets/logo.png', remotePng, { contentType: 'image/png' });
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Icon',
        match: ['https://example.com/*'],
        extra: [`// @icon        ${server.baseUrl}/assets/logo.png`],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const img = page
      .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
      .first()
      .locator('.site-icon a.site-icon-inner img');
    await expect(img).toHaveAttribute('src', `data:image/png;base64,${remotePng.toString('base64')}`);
    await page.close();
  });

  // The collections page only rebuilds a Filename cell when its cache key
  // moved — otherwise every unrelated repaint would re-run the favicon
  // fetch and flash the globe placeholder. The local-files setting has
  // to be part of that key, or flipping the switch leaves the old icon
  // painted until something unrelated happens to rebuild the row.
  test('toggling the opt-out repaints the @icon', async ({
    sm, extensionContext, extensionId,
  }) => {
    // Two visibly different 1x1 PNGs so "which one is painted" is exact.
    const localPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const remotePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(path.join(scriptsDir.path, 'logo.png'), localPng);
    server.setRoute('/assets/logo.png', remotePng, { contentType: 'image/png' });
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Icon',
        match: ['https://example.com/*'],
        extra: [`// @icon        ${server.baseUrl}/assets/logo.png`],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const img = page
      .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
      .first()
      .locator('.site-icon a.site-icon-inner img');
    await expect(img).toHaveAttribute('src', `data:image/png;base64,${localPng.toString('base64')}`);

    await page.locator('.local-files-toggle input').click();
    await expect(img).toHaveAttribute('src', `data:image/png;base64,${remotePng.toString('base64')}`);
    await page.close();
  });

  // THE security property, end to end. An http-sourced script reaches
  // the same pipeline with local files enabled — the http container
  // carries no opt-out, so the flag defaults on — and must still get no
  // stand-in, because the gate is the host script's own scheme. This is
  // where `@resource file:///home/you/.ssh/id_rsa` + GM_getResourceText
  // would matter, so it is worth an e2e and not just the unit test on
  // `localSearchRoots`.
  test('an http-sourced script never gets a stand-in', async ({ sm }) => {
    // A file on disk that WOULD match the declared URL's basename if
    // roots were ever computed from anything but the script's own URL.
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    server.setRoute('/remote.user.js', [
      '// ==UserScript==',
      '// @name        Remote',
      '// @match       https://example.com/*',
      `// @require     ${server.baseUrl}/lib/util.js`,
      '// ==/UserScript==',
      '',
    ].join('\n'));
    const collection = await sm.addCollection(`${server.baseUrl}/remote.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts
      .find((s) => s.relativePath.includes('remote.user.js'));
    const req = script!.requires?.[0];
    expect(req?.source).toBe('window.__SM_LOCAL = "remote";');
    expect(req?.localUrl).toBeUndefined();
  });

  // The `Local overrides` details row is the disclosure that covers what
  // the tab strip can't: `@resource` gets no code tab in either mode,
  // so before this row a resource stand-in was invisible in the install
  // preview (which also has no Log tab).
  test('the Local overrides row lists both @require and @resource stand-ins', async ({
    sm, extensionContext, extensionId,
  }) => {
    server.setRoute('/assets/style.css', '.remote{}', { contentType: 'text/css' });
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    fs.writeFileSync(path.join(scriptsDir.path, 'style.css'), '.local{}');
    writeScript([`// @resource    css ${server.baseUrl}/assets/style.css`]);
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status, script.errorMessage).toBe('ok');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const items = page.locator('#header-summary dt', { hasText: 'Local overrides' })
      .locator('+ dd').locator('li');
    await expect(items).toHaveCount(2);
    // Each entry names the kind it stood in for and the file we read.
    await expect(items.nth(0)).toContainText('@require');
    await expect(items.nth(0)).toContainText(path.join(scriptsDir.path, 'util.js'));
    await expect(items.nth(1)).toContainText('@resource');
    await expect(items.nth(1)).toContainText(path.join(scriptsDir.path, 'style.css'));
    // A BARE filesystem path, not the `file://` URL — the Location row
    // renders its own local collection the same way, and two path styles in
    // one panel would read as two different kinds of thing.
    await expect(items.nth(0).locator('.local-override-path'))
      .toHaveText(path.join(scriptsDir.path, 'util.js'));
    // The declaration it replaced is the tooltip — the "asked for this,
    // got that" pairing, same as the code tab's.
    await expect(items.nth(1).locator('.local-override-path')).toHaveAttribute(
      'title', `Stands in for ${server.baseUrl}/assets/style.css`,
    );
    // And each carries its own copy button, like the Location row.
    await expect(items.locator('button.copy-btn')).toHaveCount(2);
    await page.close();
  });

  // The row's stated justification: a `@resource` gets no code tab in
  // either mode and the preview has no Log tab, so before install this
  // row is the ONLY place a resource stand-in is reported. Installed
  // mode is covered above; this is the case that motivated the row.
  test('the install preview surfaces a @resource stand-in in Local overrides', async ({
    extensionContext, extensionId,
  }) => {
    server.setRoute('/assets/style.css', '.remote{}', { contentType: 'text/css' });
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    fs.writeFileSync(path.join(scriptsDir.path, 'style.css'), '.local{}');
    writeScript([`// @resource    css ${server.baseUrl}/assets/style.css`]);
    const file = path.join(scriptsDir.path, 'main.user.js');

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // Nothing has run, so there is no Log tab to fall back on…
    await expect(page.locator('.tab', { hasText: 'Log' })).toHaveCount(0);
    // …and the resource has no tab of its own either: the script plus
    // its one @require, and that's all.
    await expect(page.locator('.tab')).toHaveCount(2);
    // The row lands once the parse check resolves the declared files.
    const items = page.locator('#header-summary dt', { hasText: 'Local overrides' })
      .locator('+ dd').locator('li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText('@resource');
    await expect(items.nth(1)).toContainText(path.join(scriptsDir.path, 'style.css'));
    await page.close();
  });

  test('a script with no stand-ins has no Local overrides row', async ({
    sm, extensionContext, extensionId,
  }) => {
    // No local `util.js`, so the declared URL is what gets fetched.
    writeScript();
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.requires?.[0]?.localUrl).toBeUndefined();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    // The panel painted (so this isn't an empty-page false negative)…
    await expect(page.locator('#header-summary dt', { hasText: 'Location' })).toHaveCount(1);
    // …and the row is absent, which is the common case.
    await expect(page.locator('#header-summary dt', { hasText: 'Local overrides' })).toHaveCount(0);
    await page.close();
  });

  // The install preview resolves stand-ins too — and it matters most
  // there, since a not-yet-published `@require` URL is exactly what a
  // script being written for the first time carries. The preview keeps
  // its own state (its own roots, its own fetch cache, its own
  // ref→localUrl map), so it needs its own coverage.
  test('the install preview shows a stand-in on its tab, and counts its bytes', async ({
    extensionContext, extensionId,
  }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    writeScript();
    const file = path.join(scriptsDir.path, 'main.user.js');

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // The chip lands once the parse check resolves the declared files,
    // which is after the first tab paint — hence the poll.
    const requireTab = page.locator('.tab').nth(1);
    await expect(requireTab.locator('.tab-mark')).toHaveText('local');
    await expect(requireTab).toHaveAttribute('title', /Loaded from file:\/\/.*\/util\.js$/);
    // The stand-in's bytes are what the Size row totals — the panel and
    // the strip are describing the same resolved file.
    await expect(page.locator('#header-summary dt', { hasText: 'Size' })
      .locator('xpath=following-sibling::dd[1]'))
      .toContainText('(plus 1 @require file: 28 B)');
    await page.close();
  });

  // A broken dependency must not take the other declarations down with
  // it. `attachFiles` reports a failure with EMPTY lists, so there is
  // nothing resolved to show — but every declaration the script makes
  // still has to get its own tab, including the broken one, whose tab
  // is where its rejection gets reported.
  test('a broken dependency does not strip the preview\'s require tabs', async ({
    extensionContext, extensionId,
  }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "local";');
    writeScript([`// @require     ${server.baseUrl}/missing/gone.js`]);
    const file = path.join(scriptsDir.path, 'main.user.js');

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // The failure is surfaced…
    await expect(page.locator('#banner-slot')).toContainText(/could not be checked/);
    // …and BOTH declarations still keep a tab — the script's own, plus
    // one each — so the reader can still open the one that loaded.
    await expect(page.locator('.tab')).toHaveCount(3);
    await expect(page.locator('.tab').nth(1)).toContainText('util.js');
    await expect(page.locator('.tab').nth(2)).toContainText('gone.js');
    await page.close();
  });

  test('@resource takes stand-ins under the same rule', async ({ sm }) => {
    server.setRoute('/assets/style.css', '.remote{}', { contentType: 'text/css' });
    fs.writeFileSync(path.join(scriptsDir.path, 'style.css'), '.local{}');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Res',
        match: ['https://example.com/*'],
        extra: [`// @resource    css ${server.baseUrl}/assets/style.css`],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const res = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].resources?.[0];
    expect(res?.localUrl).toMatch(/\/style\.css$/);
    expect(Buffer.from(res!.bytesBase64, 'base64').toString()).toBe('.local{}');
  });

  // ---------- Configured search roots (options page) ----------
  //
  // The motivating layout: a shared library directory that is NOT the
  // script's own folder, so the implicit root can't reach it. These
  // drive the real setting through the SW, so what's under test is the
  // storage read plus the ordering, not just the pure rule.
  test.describe('configured roots', () => {
    let libDir: ScriptsDir;

    test.beforeEach(() => {
      libDir = ScriptsDir.create('sourcemonkey-lib-');
    });
    test.afterEach(() => {
      libDir.cleanup();
    });

    // Write `<libDir>/<relative>` with the given body, creating parents.
    function writeLib(relative: string, body: string): void {
      const full = path.join(libDir.path, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }

    test('a configured root resolves what the script folder cannot', async ({ sm }) => {
      // Matches the declared URL's `lib/util.js` suffix, one directory
      // up from anything the implicit root can see.
      writeLib('lib/util.js', 'window.__SM_LOCAL = "configured";');
      await sm.setLocalRoots([libDir.path]);
      writeScript();
      const collection = await sm.addCollection(scriptsDir.path);
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      expect(req?.source).toBe('window.__SM_LOCAL = "configured";');
      expect(req?.localUrl).toBe(`file://${libDir.path}/lib/util.js`);
      expect(server.countResponses('/lib/util.js', 200)).toBe(0);
    });

    // The implicit root is prepended, so a file sitting next to the
    // script beats the shared library — the local edit you are looking
    // at wins over the one you forgot about.
    test('the script\'s own folder still wins over a configured root', async ({ sm }) => {
      fs.writeFileSync(path.join(scriptsDir.path, 'util.js'), 'window.__SM_LOCAL = "own-folder";');
      writeLib('lib/util.js', 'window.__SM_LOCAL = "configured";');
      await sm.setLocalRoots([libDir.path]);
      writeScript();
      const collection = await sm.addCollection(scriptsDir.path);
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      expect(req?.source).toBe('window.__SM_LOCAL = "own-folder";');
    });

    // The mirror layout: one directory per site under a shared root, as
    // a scraped copy of a set of CDN files is organized. The host-
    // qualified form is the longest suffix, so it beats the same path
    // sitting loose in the root.
    test('a site directory under a configured root wins over a bare path', async ({ sm }) => {
      const host = new URL(server.baseUrl).host;
      writeLib(`${host}/lib/util.js`, 'window.__SM_LOCAL = "mirror";');
      writeLib('lib/util.js', 'window.__SM_LOCAL = "configured";');
      await sm.setLocalRoots([libDir.path]);
      writeScript();
      const collection = await sm.addCollection(scriptsDir.path);
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      expect(req?.source).toBe('window.__SM_LOCAL = "mirror";');
      expect(req?.localUrl).toBe(`file://${libDir.path}/${host}/lib/util.js`);
      expect(server.countResponses('/lib/util.js', 200)).toBe(0);
    });

    test('roots are searched in the order listed', async ({ sm }) => {
      const second = ScriptsDir.create('sourcemonkey-lib2-');
      try {
        writeLib('lib/util.js', 'window.__SM_LOCAL = "first";');
        fs.mkdirSync(path.join(second.path, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(second.path, 'lib/util.js'), 'window.__SM_LOCAL = "second";');
        await sm.setLocalRoots([libDir.path, second.path]);
        writeScript();
        const collection = await sm.addCollection(scriptsDir.path);
        const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
        expect(req?.source).toBe('window.__SM_LOCAL = "first";');
      } finally {
        second.cleanup();
      }
    });

    // The safety floor, now that a root is a directory the script had no
    // other way to reach: a declared URL cannot walk out of one.
    test('a configured root cannot be climbed out of', async ({ sm }) => {
      // `secret.js` is a sibling of the root, reachable only by going up.
      fs.writeFileSync(path.join(path.dirname(libDir.path), 'sm-secret.js'), 'window.__SM_LOCAL = "leaked";');
      await sm.setLocalRoots([path.join(libDir.path, 'lib')]);
      scriptsDir.write({
        relativePath: 'main.user.js',
        meta: {
          name: 'Climb',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/..%2f..%2fsm-secret.js`],
        },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      expect(req?.localUrl).toBeUndefined();
      expect(req?.source ?? '').not.toContain('leaked');
    });

    // The `file://`-host gate covers configured roots too: a script
    // installed from the web resolves nothing out of a dev directory.
    test('an http-sourced script ignores configured roots', async ({ sm }) => {
      writeLib('lib/util.js', 'window.__SM_LOCAL = "configured";');
      await sm.setLocalRoots([libDir.path]);
      server.setRoute('/remote.user.js', [
        '// ==UserScript==',
        '// @name        Remote Roots',
        '// @match       https://example.com/*',
        `// @require     ${server.baseUrl}/lib/util.js`,
        '// ==/UserScript==',
        '',
      ].join('\n'));
      const collection = await sm.addCollection(`${server.baseUrl}/remote.user.js`);
      const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts
        .find((s) => s.relativePath.includes('remote.user.js'));
      const req = script!.requires?.[0];
      expect(req?.source).toBe('window.__SM_LOCAL = "remote";');
      expect(req?.localUrl).toBeUndefined();
    });

    test('the per-collection opt-out also disables configured roots', async ({ sm }) => {
      writeLib('lib/util.js', 'window.__SM_LOCAL = "configured";');
      await sm.setLocalRoots([libDir.path]);
      writeScript();
      const collection = await sm.addCollection(scriptsDir.path);
      await sm.setCollectionLocalFiles(collection!.id, false);
      await sm.updateCollection(collection!.id, 'manual');
      const req = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].requires?.[0];
      expect(req?.source).toBe('window.__SM_LOCAL = "remote";');
      expect(req?.localUrl).toBeUndefined();
    });
  });
});
