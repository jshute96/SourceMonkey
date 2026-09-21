// E2E coverage for the unsafeWindow example.
//
// Written to hold under any userscript manager: it asserts the
// *observable contract* of `@grant unsafeWindow` (the page's globals
// are reachable, and what the script writes there is visible to the
// page) rather than SourceMonkey's mechanism for getting there.
//
// Two things are manager-specific, and measured rather than assumed
// (see docs/cross-manager-test-results.md):
//
//   - **Whether `unsafeWindow === window`.** SourceMonkey is the only
//     one where it is: it binds `unsafeWindow = window` in MAIN world,
//     with no wrapper in between. TM and VM both hand out a wrapper on
//     Chrome (measured), so both answer `false` — including VM in its
//     isolated mode, where it is still not a way into the page.
//     All of them meet the contract that matters — the page's globals
//     are reachable — which is why the `read` / `call` / write
//     assertions are unconditional and this one is SM-only.
//   - **The starting value of the GM storage counter.** SourceMonkey's
//     fixture wipes storage per test; TM keeps the installed script's
//     stored values across runs. So the counter is asserted as
//     counting up, never as starting from 0.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / unsafe-window', () => {
  test('unsafeWindow reaches the page realm, and GM storage still works', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);

    // Read: the page-defined app object is visible.
    await expect(page.locator('#log li[data-script="read"]'))
      .toContainText('"name":"page-app"');
    // Call: a page-defined function runs and returns the page's answer.
    await expect(page.locator('#log li[data-script="call"]'))
      .toContainText('hello userscript from the page');
    // Identity: SM-only. SM runs the script in the page realm and
    // aliases `unsafeWindow` to `window`; TM and VM both wrap. The row
    // is still required to exist everywhere — what it says there is a
    // report, not a contract. See the header comment.
    if (setup.manager === 'sourcemonkey') {
      await expect(page.locator('#log li[data-script="identity"]'))
        .toContainText('unsafeWindow === window: true');
    } else {
      await expect(page.locator('#log li[data-script="identity"]')).toHaveCount(1);
    }
    // Storage still works from a script that also reaches the page.
    // The value is whatever this profile has accumulated; that it
    // advances is the next test's job.
    await expect(page.locator('#log li[data-script="gm"]'))
      .toContainText(/GM_getValue\('visits'\) = \d+/);

    // Write: the page's own polling loop read back what the script put
    // on the page's window. This is checked from the page's side, so it
    // can't be satisfied by an isolated-world write.
    await expect(page.locator('#pageSees'))
      .toHaveAttribute('data-value', 'written-by-userscript');

    await page.close();
  });

  test('@inject-into content keeps unsafeWindow isolated from the page', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);

    // The isolated variant sees nothing of the page's realm — the
    // failure mode the grant exists to avoid, made explicit.
    //
    // Not asserted under TM, which doesn't implement `@inject-into` at
    // all (it's a Violentmonkey/SourceMonkey header; TM's equivalent is
    // `@sandbox`). TM ignores the header and honours the
    // `@grant unsafeWindow`, so the script legitimately reaches the
    // page there and this variant stops being the isolated case. A
    // difference in what the header means, not an isolation bug. VM does
    // implement the header, so it is held to this assertion.
    if (setup.manager !== 'tampermonkey') {
      await expect(page.locator('#log li[data-script="isolated-read"]'))
        .toContainText('unsafeWindow.__PAGE_APP__ = undefined');
    } else {
      await expect(page.locator('#log li[data-script="isolated-read"]')).toHaveCount(1);
    }
    // It is still a window, just not the page's — and under SM it is
    // this script's own, since SM has no wrapper to put in between. VM
    // answers false even here, and its read above still came back
    // undefined, so its unsafeWindow is neither this window nor the
    // page's. SM-only for the same reason as in the first test.
    if (setup.manager === 'sourcemonkey') {
      await expect(page.locator('#log li[data-script="isolated-identity"]'))
        .toContainText('unsafeWindow === window: true');
    } else {
      await expect(page.locator('#log li[data-script="isolated-identity"]')).toHaveCount(1);
    }

    await page.close();
  });

  test('unsafeWindow with no grant line for it still reaches the page', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // The premise of SourceMonkey's implicit handling, measured rather
    // than assumed: TM and VM don't key `unsafeWindow` off `@grant`, so
    // a script can use it undeclared — and many do. SourceMonkey finds
    // the reference by scanning the body and treats the script as
    // though it had granted it.
    //
    // Asserted unconditionally: if any manager here left the name
    // undeclared, a script written against another would throw a
    // ReferenceError on it, which is the failure this exists to remove.
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);

    await expect(page.locator('#log li[data-script="ungranted-defined"]'))
      .toContainText('typeof unsafeWindow = object');
    await expect(page.locator('#log li[data-script="ungranted-read"]'))
      .toContainText('"name":"page-app"');
    // And the script keeps the grants it did declare.
    await expect(page.locator('#log li[data-script="ungranted-gm"]'))
      .toContainText(/GM_getValue\('ungrantedVisits'\) = \d+/);

    await page.close();
  });

  test('GM storage persists across reloads for a page-realm script', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // The regression this guards: moving unsafeWindow scripts into the
    // page realm must not cost them their GM_* surface. Under
    // SourceMonkey the value round-trips over the MAIN-world bridge.
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/unsafe-window/unsafe-window.html`);
    // Read the starting value instead of assuming 0: TM keeps an
    // installed script's stored values across runs, so only the
    // increment is portable.
    const first = await page.locator('#log li[data-script="gm"]').textContent();
    const start = Number(/GM_getValue\('visits'\) = (\d+)/.exec(first ?? '')?.[1]);
    expect(Number.isNaN(start)).toBe(false);

    // Give the manager's debounced write a chance to persist.
    await page.waitForTimeout(600);
    await page.reload();

    await expect(page.locator('#log li[data-script="gm"]'))
      .toContainText(`GM_getValue('visits') = ${start + 1}`);

    await page.close();
  });
});
