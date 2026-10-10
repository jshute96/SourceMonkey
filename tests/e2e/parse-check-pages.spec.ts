// The parse check has to hold on the paths a USER actually drives.
//
// Pages used to run `addCollection` / `updateCollection` /
// `updateScript` themselves, with no checker installed: a viewer
// Refresh CLEARED a prior `invalid` verdict, and Install landed a broken
// script as `ok`. They now ask the service worker, which checks through
// the offscreen document (docs/worker-writes.md); the install preview
// still checks in the page (src/extension/parse-check-client.ts). These
// cases drive the real buttons, because the bug lived in which context
// ran the pipeline: `sm.*` helpers run in the SW and cannot see it.
//
// The verdict machinery itself is covered by parse-check.spec.ts, and
// what the check reports by parse-check-install.spec.ts.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

const BROKEN_BODY = 'const x = (;';
const GOOD_BODY = 'const x = 1;\nvoid x;';

test.describe('parse check on page-driven paths', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  function writeMain(body: string): string {
    return scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'PageDriven', match: ['https://example.com/*'] },
      body,
    });
  }

  test('a viewer Refresh keeps a broken script invalid', async ({
    extensionContext, extensionId, sm,
  }) => {
    writeMain(BROKEN_BODY);
    await sm.addCollection(scriptsDir.path);
    const collections = await sm.getCollections();
    const script = (await sm.getCollectionWithScripts(collections[0].id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await page.locator('#refresh-btn').click();

    // Wait for the refresh to REPORT, not just to have been clicked.
    // The row is already `invalid` going in, so polling its status
    // would succeed on the first read — before the click's async work
    // had written anything — and pass just as happily with the fix
    // reverted. The manual-refresh log line is the completion signal:
    // this row can't take the unchanged-content shortcut (an `invalid`
    // row always re-fetches and re-validates), so the pass always
    // writes one, saying either what's still wrong or that it
    // recovered.
    await expect.poll(async () => {
      const log = await sm.getScriptLog(script.id);
      return log.filter((e) => e.source === 'manual-refresh').length;
    }, { message: 'the refresh never reported an outcome' }).toBeGreaterThan(0);

    const after = (await sm.getCollectionWithScripts(collections[0].id))!.scripts[0];
    expect(after.status, 'a page-driven refresh must re-derive the verdict, not drop it')
      .toBe('invalid');
    // ...and it must not have claimed a recovery on the way.
    const log = await sm.getScriptLog(script.id);
    expect(log.map((e) => e.message).join('\n')).not.toMatch(/Loads cleanly again/);
    await page.close();
  });

  test('a viewer Refresh still lets a fixed script recover', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The accept side of the case above: routing the check through the
    // service worker must not leave a repaired script stuck at
    // `invalid`.
    writeMain(BROKEN_BODY);
    await sm.addCollection(scriptsDir.path);
    const collections = await sm.getCollections();
    const script = (await sm.getCollectionWithScripts(collections[0].id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    writeMain(GOOD_BODY);
    await page.locator('#refresh-btn').click();

    await expect.poll(async () => {
      const after = (await sm.getCollectionWithScripts(collections[0].id))!.scripts[0];
      return after.status;
    }).toBe('ok');
    await page.close();
  });

  test('installing from the viewer preview catches a syntax error', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Install runs the same pipeline in the same page context, so it
    // had the same hole — and here the row is being created, not
    // re-derived, so nothing downstream would have re-checked it until
    // the next background refresh.
    const file = writeMain(BROKEN_BODY);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // Let the preview's own check finish first. What's under test is
    // the INSTALL's check, and clicking mid-check would have the two
    // racing on the same file — a pass would no longer say which one
    // produced the verdict.
    await expect(page.locator('#banner-slot[data-parse-check="done"]')).toBeAttached();
    await page.locator('#install-btn').click();
    await page.waitForURL(/userscript\.html\?script=/);

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    const installed = (await sm.getCollectionWithScripts(collections[0].id))!.scripts[0];
    expect(installed.status).toBe('invalid');
    expect(installed.errorMessage).toMatch(/syntax error/i);
    await page.close();
  });

  test('the preview warns about a syntax error before Install is clicked', async ({
    extensionContext, extensionId,
  }) => {
    const file = writeMain(BROKEN_BODY);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot')).toContainText('syntax error');
    // Warning, not a gate: a syntax error is a property of code the
    // user may still want installed. Only "this isn't an installable
    // userscript at all" hides the button.
    await expect(page.locator('#install-btn')).toBeVisible();
    await expect(page.locator('#install-btn')).toBeEnabled();
    // The install callout is still on screen alongside the warning.
    await expect(page.locator('#install-callout')).toBeVisible();
    await page.close();
  });

  test('the Update preview warns too, and says "updating"', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Previewing a location we already hold puts an Update on that
    // copy's row, and it rebuilds the row just the same — so the same
    // warning is owed. The wording has to follow the button: "installing
    // it will store it as INVALID" beside an **Update** button reads
    // as being about some other action.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Updatable', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet;',
    });
    await sm.addCollection(file);

    // The upstream copy goes bad after we installed a working one.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = (;');

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#other-versions td.col-actions button', { hasText: 'Update' })).toBeVisible();
    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#banner-slot')).toContainText('syntax error');
    await expect(page.locator('#banner-slot')).toContainText('Updating it will store it as INVALID');
    await page.close();
  });

  test('an http Update over a working copy says the copy keeps running', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The branch with the non-obvious semantics. `rebuildCollection` treats
    // an http(s) refresh that doesn't parse as a bad RESPONSE — a login
    // page served in place of the script — and keeps the prior working
    // body running rather than disabling it. Promising INVALID here
    // would be simply false.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/main.user.js', userscriptText('HttpUpdatable'));
      const url = `${server.baseUrl}/main.user.js`;
      await sm.addCollection(url);
      const collections = await sm.getCollections();
      expect((await sm.getCollectionWithScripts(collections[0].id))!.scripts[0].status).toBe('ok');

      server.setRoute('/main.user.js', `${userscriptText('HttpUpdatable')}\nconst x = (;`);
      const page = await extensionContext.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(url)}`,
      );
      await expect(page.locator('#other-versions td.col-actions button', { hasText: 'Update' })).toBeVisible();
      await expect(page.locator('#banner-slot')).toContainText('syntax error');
      await expect(page.locator('#banner-slot')).toContainText(
        'leave the installed copy running',
      );
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('an http Update over an already-invalid copy says INVALID', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The preservation above is gated on the installed row being `ok`,
    // not on it merely existing — there is nothing worth keeping about
    // a copy that already doesn't parse, so the store writes the new
    // INVALID like any other. Reading the outcome off the URL scheme
    // alone gets this case backwards.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/broken.user.js', `${userscriptText('HttpBroken')}\nconst x = (;`);
      const url = `${server.baseUrl}/broken.user.js`;
      await sm.addCollection(url);
      const collections = await sm.getCollections();
      expect((await sm.getCollectionWithScripts(collections[0].id))!.scripts[0].status).toBe('invalid');

      const page = await extensionContext.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(url)}`,
      );
      await expect(page.locator('#other-versions td.col-actions button', { hasText: 'Update' })).toBeVisible();
      await expect(page.locator('#banner-slot')).toContainText('syntax error');
      await expect(page.locator('#banner-slot')).toContainText('Updating it will store it as INVALID');
      await expect(page.locator('#banner-slot')).not.toContainText('keeps running');
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('the preview fails open when the check is unavailable', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The invariant the whole feature rests on: machinery that cannot
    // answer must say nothing, never accuse. `setParseCheckEnabled`
    // stands in for a wedged sandbox — it's the same `null` verdict the
    // real failure paths produce, and since the off-switch moved into
    // session storage it reaches the page's checker too.
    await sm.setParseCheckEnabled(false);
    const file = writeMain(BROKEN_BODY);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot[data-parse-check="done"]')).toBeAttached();
    await expect(page.locator('#banner-slot')).not.toContainText('syntax error');
    await expect(page.locator('#install-btn')).toBeEnabled();
    await page.close();
  });

  test('the preview checks @require bodies, not just the script', async ({
    extensionContext, extensionId,
  }) => {
    // The case that prompted this: the body is fine and the library
    // isn't. Catching it means the preview has to fetch the `@require`
    // it would otherwise leave until its tab is opened.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'function ok() {\n/* unterminated');
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'PreviewReq', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'ok();',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot')).toContainText('syntax error');
    await page.close();
  });

  test('the preview names the @require the error is in', async ({
    extensionContext, extensionId,
  }) => {
    // The page route runs its OWN checker in its own sandbox frame, so
    // the location machinery has to work there too — a regression that
    // only broke the page route would be invisible to the
    // service-worker tests.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      'function ok() {\n  return 1;\n}\nlet broken = ;\n',
    );
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'PreviewWhere', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'ok();',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    const banner = page.locator('#banner-slot');
    await expect(banner).toContainText('lib.js');
    await expect(banner).toContainText('line 4');
    await page.close();
  });

  test('a library declared twice is not reported as a duplicate declaration', async ({
    extensionContext, extensionId,
  }) => {
    // The preview must compose the program the way an INSTALL does.
    // `attachFiles` dedups `@require`s by canonical URL, so a library
    // listed twice is loaded once; fetching per declared ref instead
    // concatenates it twice, and any top-level `const` in it becomes
    // "already been declared" — a syntax error reported against a
    // script that installs and runs perfectly.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'DoubleDeclared',
        match: ['https://example.com/*'],
        extra: ['// @require     lib.js', '// @require     ./lib.js'],
      },
      body: 'void greet;',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot[data-parse-check="done"]')).toBeAttached();
    await expect(page.locator('#banner-slot')).not.toContainText('syntax error');
    await expect(page.locator('#banner-slot')).not.toContainText('already been declared');
    await page.close();
  });

  test('the preview says so when a @require cannot be loaded at all', async ({
    extensionContext, extensionId,
  }) => {
    // Same surprise, different cause: this one installs as `invalid`
    // for a failed dependency fetch rather than a syntax error, and
    // fetching the requires for the check is what makes it visible
    // here.
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'PreviewMissingReq',
        match: ['https://example.com/*'],
        extra: ['// @require     ./does-not-exist.js'],
      },
      body: 'void 0;',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot')).toContainText('could not be checked');
    // Deliberately not a claim about what installing would do: a dep
    // that won't load is usually a flaky host, and an Update keeps the
    // installed copy running rather than disabling it.
    await expect(page.locator('#banner-slot')).not.toContainText('INVALID');
    await page.close();
  });

  test('a healthy preview shows no warning', async ({ extensionContext, extensionId }) => {
    // The accept side. A preview that cried wolf on working scripts
    // would be worse than no warning at all.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'PreviewGood', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet;',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#install-callout')).toBeVisible();
    await expect(page.locator('#install-btn')).toBeEnabled();
    // Anchored on the check finishing, not on a guessed delay: a
    // negative assertion that runs before the fetches and the compile
    // are done would pass no matter what the check would have said.
    await expect(page.locator('#banner-slot[data-parse-check="done"]')).toBeAttached();
    await expect(page.locator('#banner-slot')).not.toContainText('syntax error');
    await expect(page.locator('#banner-slot')).not.toContainText('could not be checked');
    await page.close();
  });

  test('a collections-page Refresh All catches a newly-broken @require', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Same delegation, driven from the other page — and through a
    // `@require`, whose body is the half of the composed program the
    // viewer never shows as the script's own collection.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'PageReq', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet;',
    });
    await sm.addCollection(scriptsDir.path);
    const collections = await sm.getCollections();
    expect((await sm.getCollectionWithScripts(collections[0].id))!.scripts[0].status).toBe('ok');

    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = (;');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await page.locator('#refresh-all').click();

    await expect.poll(async () => {
      const after = (await sm.getCollectionWithScripts(collections[0].id))!.scripts[0];
      return after.status;
    }).toBe('invalid');
    await page.close();
  });
});
