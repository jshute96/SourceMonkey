// Clicking a diagnostic's location to get to the code it is about.
//
// Everything SourceMonkey concludes from a script's *content* — a
// metadata block that never closes, a missing `@match`, an unsupported
// `@grant`, a `@require` that won't load, a syntax error — carries a
// `DiagnosticLocation`, and every surface that shows one renders it as
// a link into the matching code tab. This file drives that end to end
// in the two modes the viewer has:
//
//   - installed (`?script=<id>`), where the message bar explains why a
//     row is INVALID, and the Log tab carries the same verdict
//   - preview (`?preview=<url>`), where the warning describes what
//     installing WOULD produce, against tabs built from a file that
//     isn't installed yet
//
// The URL hash is the assertion of record for "which tab, which line":
// it is the viewer's own single source of truth for view state (see
// src/extension/script-url-hash.ts), so checking it can't pass while the pane
// shows something else.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('diagnostic location links', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // The one link class every diagnostic location renders as, in the
  // message bar, in a banner, and in the Log tab alike.
  const LINK = 'a.diagnostic-link';

  async function installAndOpen(
    extensionContext: import('@playwright/test').BrowserContext,
    extensionId: string,
    sm: { addCollection: (p: string) => Promise<unknown>; getCollections: () => Promise<{ id: string }[]>;
          getCollectionWithScripts: (id: string) => Promise<{ scripts: { id: string; relativePath: string }[] } | null> },
    relativePath: string,
  ) {
    await sm.addCollection(scriptsDir.path);
    const collections = await sm.getCollections();
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    const script = withScripts!.scripts.find((s) => s.relativePath === relativePath)!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    // The suffix render() writes, not just the separator — the page's
    // static title already has one, so `includes('|')` waits for
    // nothing.
    await page.waitForFunction(() => document.title.endsWith('| SourceMonkey'));
    return { page, scriptId: script.id };
  }

  test('a syntax error in a @require links to that library at its line', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The case the whole feature exists for: the broken code is in a
    // file the user never opened, and the message is the only thing
    // that knows which one.
    scriptsDir.writeRaw('lib.js', 'function ok() {\n  return 1;\n}\nlet broken = ;\n');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'BadRequire', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'ok();',
    });
    const { page } = await installAndOpen(extensionContext, extensionId, sm, 'main.user.js');

    const link = page.locator(`#message ${LINK}`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/lib\.js, line 4, column \d+$/);

    await link.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#lib\.js:4:\d+$/);
    await expect(page.locator('#tabs .tab.active')).toHaveText('lib.js');
    await expect(page.locator('.line-flash')).toBeVisible();

    await page.close();
  });

  test('a header problem links to the metadata block it belongs in', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A missing @match is about a tag that ISN'T there, so
    // there is no offending line — it points at the `==UserScript==`
    // marker, which is where the reader has to add one.
    scriptsDir.writeRaw(
      'nomatch.user.js',
      '// ==UserScript==\n// @name No Match\n// ==/UserScript==\nbody();\n',
    );
    const { page } = await installAndOpen(extensionContext, extensionId, sm, 'nomatch.user.js');

    const link = page.locator(`#message ${LINK}`);
    // No column: only the parse check knows one, and inventing a
    // column for a header problem would be a made-up precision.
    await expect(link).toHaveText('nomatch.user.js, line 1');
    await expect(page.locator('#message')).toContainText('No @match or @include in the metadata block');

    await link.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#nomatch.user.js:1');
    await expect(page.locator('.line-flash')).toBeVisible();

    await page.close();
  });

  test('a file with no metadata block links to the file and highlights nothing', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Nowhere in particular to point, so the location is the file
    // alone. Clicking still gets the reader to the collection — and must
    // NOT leave a highlight claiming a line we never chose.
    scriptsDir.writeRaw('plain.user.js', "console.log('no metadata block here');\n");
    const { page } = await installAndOpen(extensionContext, extensionId, sm, 'plain.user.js');

    const link = page.locator(`#message ${LINK}`);
    await expect(link).toHaveText('plain.user.js');
    await expect(page.locator('#message')).toContainText('No // ==UserScript== metadata block');

    await link.click();
    // The main tab with no highlight is the viewer's default landing,
    // which `buildHash` spells as an empty fragment.
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    await expect(page.locator('.line-flash')).toHaveCount(0);

    await page.close();
  });

  test('a @require that will not load links to the line that declared it', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Nothing was fetched, so there is no library content to point
    // into. The `@require` line is the only place the reader can act,
    // and it is in the script's own file.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'GoneRequire',
        match: ['https://example.com/*'],
        extra: ['// @require     ./does-not-exist.js'],
      },
      body: 'noop();',
    });
    const { page } = await installAndOpen(extensionContext, extensionId, sm, 'main.user.js');

    const link = page.locator(`#message ${LINK}`);
    await expect(link).toHaveText(/^main\.user\.js, line \d+$/);
    // The `@require` line, wherever the metadata renderer put it.
    const expected = await page.evaluate(() => {
      const text = document.querySelector('#content')?.textContent ?? '';
      return text.split('\n').findIndex((l) => l.includes('@require')) + 1;
    });
    expect(expected).toBeGreaterThan(0);
    await expect(link).toHaveText(`main.user.js, line ${expected}`);

    await page.close();
  });

  test('an unsupported @grant links from the Log tab to the grant line', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A WARNING, not a failure: the script still runs. It is the one
    // located diagnostic that arrives through the Log rather than the
    // message bar, so it exercises a different renderer.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'BadGrant',
        match: ['https://example.com/*'],
        grant: ['GM_setValue', 'GM_notARealApi'],
      },
      body: "console.log('runs anyway');",
    });
    const { page, scriptId } = await installAndOpen(
      extensionContext, extensionId, sm, 'main.user.js',
    );

    // The row is healthy — the diagnostic is a Log warning, not an
    // error next to the script.
    await expect(page.locator('#message')).toHaveText('');

    // `startupLogs` are persisted at build time and logged when the
    // script is installed.
    const logged = await sm.getScriptLog(scriptId);
    const warning = logged.find((e) => /Ignoring unsupported @grant/.test(e.message));
    expect(warning, 'the unknown grant should be logged').toBeTruthy();
    // The line the offending grant is written on, read off the file the
    // fixture rendered rather than assumed from the metadata order. Waited
    // for: a read mid-render finds the pane empty.
    await expect(page.locator('#content')).toContainText('GM_notARealApi');
    const src = await page.evaluate(() => document.querySelector('#content')?.textContent ?? '');
    const grantLine = src.split('\n').findIndex((l) => l.includes('GM_notARealApi')) + 1;
    expect(grantLine).toBeGreaterThan(1);
    expect(warning!.location).toEqual({ file: 'main.user.js', line: grantLine });

    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`,
    );
    await page.waitForFunction(() => document.title.endsWith('| SourceMonkey'));

    const row = page.locator('#log-pane tr', { hasText: 'Ignoring unsupported @grant' });
    await expect(row).toBeVisible();
    await expect(row.locator(LINK)).toHaveText(`main.user.js, line ${grantLine}`);

    await row.locator(LINK).click();
    await expect.poll(() => page.evaluate(() => location.hash))
      .toBe(`#main.user.js:${grantLine}`);
    await expect(page.locator('#tabs .tab.active')).toHaveText('main.user.js');
    await expect(page.locator('.line-flash')).toBeVisible();

    await page.close();
  });

  test('the install preview links a syntax error into its @require tab', async ({
    extensionContext, extensionId,
  }) => {
    // Preview mode builds a tab per declared `@require` even though
    // nothing is installed, so a library error is reachable before the
    // user commits to anything.
    scriptsDir.writeRaw('lib.js', '// pad\n// pad\nlet broken = ;\n');
    const file = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'PreviewBad', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'ok();',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // The check is asynchronous (it fetches every `@require` first);
    // the banner slot flags when it has finished either way.
    await expect(page.locator('#banner-slot[data-parse-check="done"]')).toBeAttached();

    const link = page.locator(`#banner-slot ${LINK}`);
    await expect(link).toHaveText(/lib\.js, line 3, column \d+$/);
    // The sentence continues after the location — the warning says
    // what installing will do, and that has to survive the link.
    await expect(page.locator('#banner-slot')).toContainText('store it as INVALID');

    await link.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#lib\.js:3:\d+$/);
    await expect(page.locator('#tabs .tab.active')).toHaveText('lib.js');
    await expect(page.locator('#content')).toContainText('let broken = ;');

    await page.close();
  });

  test('the install preview links a header problem to the previewed file', async ({
    extensionContext, extensionId,
  }) => {
    // The refusal path, not the warning path: this file can't be
    // installed at all, so the banner replaces the install offer. It
    // still has to say where to look.
    const file = scriptsDir.writeRaw(
      'nomatch.user.js',
      '// ==UserScript==\n// @name No Match\n// ==/UserScript==\nbody();\n',
    );

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    const link = page.locator(`#banner-slot ${LINK}`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/nomatch\.user\.js, line 1$/);
    await expect(page.locator('#install-btn')).toBeHidden();

    await link.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/:1$/);
    await expect(page.locator('.line-flash')).toBeVisible();

    await page.close();
  });
});
