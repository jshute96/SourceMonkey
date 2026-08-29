// E2E coverage for `@require` scope, in both injection worlds.
//
// Two things this pins that nothing else does:
//
//   1. A require's top-level `class` / `const` reach the script body.
//      Those are script-scoped, so they only work because requires are
//      concatenated into the body's own injected entry — see
//      docs/injection-modes.md. `function` / `var` would leak through
//      globalThis under any arrangement, so they're the control.
//   2. It works the same in MAIN world as in USER_SCRIPT world. The
//      rest of the `@require` suite runs in USER_SCRIPT only, and
//      MAIN world differs in what `window` is and in which GM
//      bindings get emitted.
//
// Plus the negative: even in MAIN world, where the script shares
// `window` with the page, the library must stay a local of the wrap
// function and not leak onto the page's global object.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / require-scope', () => {
  test('a @require\'d class/const/function reaches both the page and content worlds', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // Relative `@require` paths resolve against the script's own URL
    // under SM, and against the install URL under VM — the harness
    // installs into VM from the fixture server, so VM fetches the
    // library for real. TM takes absolute URLs only, and installs
    // these examples from a local file, so it has no base URL to
    // resolve against even in principle; the fixture server's port is
    // random, so an absolute URL can't be baked into the file either.
    // Same reason gm-resource skips under TM.
    test.skip(setup.manager === 'tampermonkey', 'TM requires absolute @require URLs; this example uses a relative ref');

    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/require-scope/require-scope.html`);

    // Both scripts ran.
    await expect(page.locator('#log li[data-script="page"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="content"]')).toHaveCount(1);

    // The status line counts them. It's driven by a helper in lib.js,
    // so it doubles as proof the require reached BOTH scripts — the
    // page's own initial text reads "0 of 2", and only a script that
    // successfully called into the library can change it.
    await expect(page.locator('#runStatus')).toHaveText('2 of 2 userscripts ran. See log below.');
    await expect(page.locator('#runStatus')).toHaveClass(/\bran\b/);

    // MAIN world: the require's bindings are all in scope, and the
    // script really is in the page's world.
    const fromPage = await page.evaluate(
      () => (window as unknown as { __SM_REQUIRE_SCOPE_FROM_PAGE__?: Record<string, string> })
        .__SM_REQUIRE_SCOPE_FROM_PAGE__,
    );
    expect(fromPage).toEqual({
      world: 'page',
      fromClass: 'class RequireScopeGreeter reached the page world',
      fromConst: 'const from lib.js',
      fromFunction: 'function from lib.js, called in the page world',
      leakedToWindow: 'no',
      seesPageGlobal: 'i-am-the-page-world',
    });

    // USER_SCRIPT world: same library, plus the GM binding emitted
    // into the same scope without colliding with it.
    const contentRow = page.locator('#log li[data-script="content"]');
    await expect(contentRow).toContainText('class RequireScopeGreeter reached the content world');
    await expect(contentRow).toContainText('const from lib.js');
    await expect(contentRow).toContainText('function from lib.js, called in the content world');
    await expect(contentRow).toContainText('@require in the content (USER_SCRIPT) world');
    // Isolated world — the page's global is not visible from here.
    await expect(contentRow).toContainText('"seesPageGlobal":"(not visible)"');

    await page.close();
  });
});
