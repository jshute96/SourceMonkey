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
//
// Runs under every manager, with a deliberately different expected
// count each:
//
//   - `page-world` / `content-world` `@require` lib.js by absolute
//     raw.githubusercontent.com URL, the only form TM/VM/GM accept.
//   - `relative-require` uses a relative ref. SM resolves it against
//     the script's own URL and VM against the install URL (3 of 3);
//     TM cannot (2 of 3).
//
// NETWORK DEPENDENCY: because the portable pair name an absolute URL,
// every manager now fetches lib.js from raw.githubusercontent.com at
// install time. This spec fails offline, and it fails while the repo
// is private — the raw URL 404s without a token. SourceMonkey treats
// an unfetchable @require as fatal (the script is marked invalid and
// never registered), so the symptom is a low count, not a partial run:
// under SM the page reads `1 of 3`, because only the relative-require
// script survives.
//
// That is why the test is currently `fixme`-d. See the "Cross-manager
// coverage" entry in TODO.md; drop the fixme once the repo is public
// (or the URL moves to a public host) and this should go green.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / require-scope', () => {
  test('a @require\'d class/const/function reaches both worlds, by absolute URL and by relative path', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // Blocked on repo visibility, not on anything in this tree: the
    // absolute @require 404s while jshute96/SourceMonkey is private,
    // which takes the two portable scripts down under every manager.
    // Verified by control run — point the requires back at `./lib.js`
    // and every assertion below passes at 3 of 3.
    test.fixme(true, 'Absolute @require 404s until the repo is public — see TODO.md, Cross-manager coverage');

    // Relative `@require` refs resolve against the script's own URL
    // under SM, and against the install URL under VM — the harness
    // installs into VM from the fixture server, so VM fetches the
    // library for real. TM takes absolute URLs only, and installs
    // these examples from a local file, so it has no base URL to
    // resolve against even in principle.
    const resolvesRelative = setup.manager !== 'tampermonkey';

    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/require-scope/require-scope.html`);

    // The two portable scripts ran under every manager.
    await expect(page.locator('#log li[data-script="page"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="content"]')).toHaveCount(1);

    // The status line counts the rows. It's driven by a helper in
    // lib.js, so it doubles as proof the require reached each script —
    // the page's own initial text reads "0 of 3", and only a script
    // that successfully called into the library can change it.
    const expectedRan = resolvesRelative ? 3 : 2;
    await expect(page.locator('#runStatus'))
      .toHaveText(`${expectedRan} of 3 userscripts ran. See log below.`);
    await expect(page.locator('#runStatus')).toHaveClass(/\bran\b/);

    // The relative-require script is the manager-dependent one: it's
    // the whole reason the counts differ. Asserted AFTER the status
    // line on purpose — under TM this is a toHaveCount(0), which would
    // pass vacuously at t=0 if it ran before anything had a chance to
    // execute. The status assertion above is what waits.
    await expect(page.locator('#log li[data-script="relative"]'))
      .toHaveCount(resolvesRelative ? 1 : 0);

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

    // SM and VM: the relative-require script resolved BOTH of its
    // refs — `./lib.js` (the same library the portable pair reach by
    // absolute URL) and `./relative-lib.js` (reachable no other way)
    // — and both landed in one scope with the body.
    if (resolvesRelative) {
      const relativeRow = page.locator('#log li[data-script="relative"]');
      await expect(relativeRow).toContainText('"fromSharedConst":"const from lib.js"');
      await expect(relativeRow).toContainText('class RequireScopeGreeter reached the relative-require world');
      await expect(relativeRow).toContainText('function from lib.js, called in the relative-require world');
      await expect(relativeRow).toContainText('function from relative-lib.js, called in the relative-require world');
      // relative-lib.js embeds lib.js's const in its own top-level
      // initializer, so this string only exists if `./lib.js` was
      // concatenated FIRST — the require-order proof.
      await expect(relativeRow).toContainText(
        'const from relative-lib.js, which already saw \\"const from lib.js\\"',
      );
    }

    await page.close();
  });
});
