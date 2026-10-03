// Coverage for the "File access is disabled." banner — the only thing
// that tells a user why a local file wouldn't read.
//
// Chrome grants "Allow access to file URLs" unconditionally to
// `--load-extension` builds, and writing `allow_file_access: false`
// into Preferences does not override it, so the real toggle can't be
// turned off in this harness (see docs/testing.md).
//
// What CAN be faked is the probe the pages branch on. `addInitScript`
// replaces `chrome.extension.isAllowedFileSchemeAccess` before any page
// script runs, so the page under test believes the toggle is off while
// the browser keeps reading files normally. That covers the branch, the
// shared renderer in `src/extension/file-access.ts`, and the shared banner CSS —
// everything except Chrome's own enforcement, which stays a manual
// check.
//
// The grant-ON half — a failed read that must NOT raise the banner —
// lives in `install-capture-file.spec.ts`, where the probe is real.
//
// One coupling to know about: the stub below hard-codes the callback
// form of the API. If `isFileSchemeAccessAllowed` were ever rewritten
// against the promise overload, the stub would return `undefined` and
// these would go green while testing nothing.

import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const BANNER = 'File access is disabled';

// Make every page this test opens believe the toggle is off. Must be
// installed before the first navigation — the viewer probes once at
// load, not per failure.
async function denyFileAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Only the callback overload is used by the code under test; the
    // real signature also has a promise form, so the stub is narrower
    // than the type it replaces.
    chrome.extension.isAllowedFileSchemeAccess = ((
      callback: (allowed: boolean) => void,
    ) => { callback(false); }) as typeof chrome.extension.isAllowedFileSchemeAccess;
  });
}

// Some tests take the `sm` fixture without calling it: `sm` is what
// runs `resetAllState()` around each test.
test.describe('file-access banner', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  test('the collections page says so up front', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Not tied to any failure: with the toggle off every fetch this
    // page could make is already doomed, so it leads with the reason.
    const page = await extensionContext.newPage();
    await denyFileAccess(page);
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    // Scoped to this banner, not the slot: the slot can also hold the
    // "Allow User Scripts" banner, which carries its own chrome-link.
    const banner = page.locator('#banner-slot div.banner').filter({ hasText: BANNER });
    await expect(banner).toContainText('Allow access to file URLs');
    // The click-through that fixes it. `chrome://` can't be an <a>
    // navigation, so the href is decorative and a handler does the
    // work — but the address still has to be the right one.
    await expect(banner.locator('a.chrome-link')).toHaveText(
      `chrome://extensions/?id=${extensionId}`,
    );
    await page.close();
  });

  test('a preview that could not read a local file says so', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The install page. The fetch below fails for the ordinary reason
    // (the file is really missing) — what puts the banner up is the
    // probe, which is the only thing that can tell the two apart.
    const page = await extensionContext.newPage();
    await denyFileAccess(page);
    const missing = `file://${dir.path}/gone.user.js`;
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(missing)}`,
    );

    await expect(page.locator('#message')).toContainText('Could not fetch this script');
    await expect(page.locator('#banner-slot')).toContainText(BANNER);
    await page.close();
  });

  test('a Refresh that fails on an installed local script says so', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Same question from the other mode: the script is installed and
    // running off its cached body, and the user clicks Refresh to pick
    // up an edit that can no longer be read.
    const filePath = dir.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/*'] },
      body: 'console.log("hi");\n',
    });
    const collection = await sm.addCollection(filePath);
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await denyFileAccess(page);
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${scriptId}`,
    );
    // Nothing has failed yet, so nothing to explain. Anchored behind a
    // positive assertion first: `.not` resolves the instant it holds,
    // and the empty `<div>` straight from the HTML would satisfy it
    // before the viewer's async load() has rendered anything at all.
    await expect(page.locator('#filename')).toHaveText('SourceMonkey | Hello');
    await expect(page.locator('#banner-slot')).not.toContainText(BANNER);

    dir.remove('hello.user.js');
    await page.locator('#refresh-btn').click();

    await expect(page.locator('#message')).toContainText('Refresh failed');
    await expect(page.locator('#banner-slot')).toContainText(BANNER);
    // Reload is the wrong advice for a stored row — re-opening the page
    // replays the same cached copy and the same error.
    await expect(page.locator('#banner-slot')).toContainText('then click Refresh');

    // And it goes away again once the read works, which is what the
    // unconditional clear at the top of render() is for.
    dir.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/*'] },
      body: 'console.log("back");\n',
    });
    await page.locator('#refresh-btn').click();
    await expect(page.locator('#message')).toBeEmpty();
    await expect(page.locator('#banner-slot')).not.toContainText(BANNER);
    await page.close();
  });

  test('a parse error on a local script is not blamed on the toggle', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The toggle is off and the script is local, but what's wrong with
    // it is its content — we read the file fine, it just isn't a
    // userscript. Printing "File access is disabled." under that
    // message would offer an unrelated setting as the explanation.
    const filePath = `${dir.path}/broken.user.js`;
    fs.writeFileSync(filePath, 'console.log("no metadata block here");\n');
    const collection = await sm.addCollection(filePath);
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await denyFileAccess(page);
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${scriptId}`,
    );

    await expect(page.locator('#message')).toContainText('metadata block');
    await expect(page.locator('#banner-slot')).not.toContainText(BANNER);
    await page.close();
  });

  test('an http fetch failure is not blamed on the toggle', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The other half of the gate. This preview fails to fetch just like
    // the local one above, and the toggle really is off — but turning it
    // on would not have helped a URL, so the banner must stay away.
    const page = await extensionContext.newPage();
    await denyFileAccess(page);
    const unreachable = 'http://127.0.0.1:9/nope.user.js';
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(unreachable)}`,
    );

    await expect(page.locator('#message')).toContainText('Could not fetch this script');
    await expect(page.locator('#banner-slot')).not.toContainText(BANNER);
    await page.close();
  });
});
