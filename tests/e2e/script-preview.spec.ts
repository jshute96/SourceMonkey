// The viewer's preview mode (`userscript.html?preview=<url>`), reached
// from the sources page's Add Source field for a single script.
//
// The capture route into the same page is covered by
// install-capture.spec.ts; this file covers what's specific to Add
// Source and to preview mode itself: local files, `@require` tabs, and
// the refusal to offer Install for something that would land as an
// `invalid` row.
//
// The preview's parse-check warning is in parse-check-pages.spec.ts —
// it warns rather than refusing, so it belongs with the other paths
// that run the check, not with the install gate.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('script preview', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('Add Source with one local script previews it, and Install adds it', async ({
    extensionContext, extensionId, sm,
  }) => {
    const file = scriptsDir.write({
      relativePath: 'local.user.js',
      meta: { name: 'Local Script', match: ['https://example.com/*'] },
      body: "console.log('local');\n",
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    await page.locator('#add-path').fill(file);
    await page.locator('#add-form button[type="submit"]').click();

    // Nothing is added yet — the field routed us to the preview.
    await page.waitForURL(/userscript\.html\?preview=/);
    await expect(page.locator('#header-summary')).toContainText('Local Script');
    await expect(page.locator('#content')).toContainText("console.log('local')");
    await expect(page.locator('#banner-slot')).toContainText('not installed yet');
    expect(await sm.getSources()).toHaveLength(0);

    await page.locator('#install-btn').click();
    await page.waitForURL(/userscript\.html\?script=/);

    const sources = await sm.getSources();
    expect(sources).toHaveLength(1);
    const withScripts = await sm.getSourceWithScripts(sources[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    expect(withScripts!.scripts[0].status).toBe('ok');
    await page.close();
  });

  test('previewing a script we already have offers Update, not Install', async ({
    extensionContext, extensionId, sm,
  }) => {
    const file = scriptsDir.write({
      relativePath: 'local.user.js',
      meta: { name: 'Local Script', match: ['https://example.com/*'] },
      body: '',
    });
    await sm.addSource(file);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#update-btn')).toBeVisible();

    await page.locator('#update-btn').click();
    await page.waitForURL(/userscript\.html\?script=/);
    // Still one script — Update refreshed the existing row rather than
    // adding a second copy.
    const sources = await sm.getSources();
    const withScripts = await sm.getSourceWithScripts(sources[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    await page.close();
  });

  test('a script missing @match is previewed but cannot be installed', async ({
    extensionContext, extensionId, sm,
  }) => {
    // It parses as a userscript, so the "no metadata block" branch
    // doesn't fire — this is the validateHeader branch, which must
    // refuse just as firmly rather than letting addSource create an
    // `invalid` row.
    const file = scriptsDir.write({
      relativePath: 'nomatch.user.js',
      meta: { name: 'No Match Anywhere' },
      body: "console.log('unreachable');\n",
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot')).toContainText('No @match or @include in the metadata block');
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#update-btn')).toBeHidden();
    // Local `.user.js` navigations are captured too, so this file needs
    // the same way out an http one gets — pointed at the `file://` form,
    // since the bare path the preview was opened with isn't navigable.
    await expect(page.locator('#continue-btn')).toBeVisible();
    await expect(page.locator('#continue-btn')).toHaveText('Continue to file');
    // The source is still on screen — seeing what you actually got is
    // the point when a file isn't what you expected.
    await expect(page.locator('#content')).toContainText("console.log('unreachable')");
    expect(await sm.getSources()).toHaveLength(0);
    await page.close();
  });

  test('a location we can never fetch is reported as a bad location, not a failed fetch', async ({
    extensionContext, extensionId,
  }) => {
    // `?preview=` is reachable by hand and by the capture route, so the
    // input isn't always something the Add Source field validated. An
    // `ftp://` URL is rejected on shape before any fetch is attempted,
    // and saying "Could not fetch" there would send the reader looking
    // at their network for a problem that's in the address.
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${
        encodeURIComponent('ftp://example.com/thing.user.js')}`,
    );
    const message = page.locator('#message');
    await expect(message).toContainText('This is not a script location');
    await expect(message).toContainText('http(s):// or file:// URL');
    await expect(message).not.toContainText('Could not fetch');
    await expect(page.locator('#install-btn')).toBeHidden();
    await page.close();
  });

  test('@require bodies are fetched once up front, and the tab reuses them', async ({
    extensionContext, extensionId, sm,
  }) => {
    // This used to assert the opposite — that previewing a script never
    // pulled its dependencies off third-party hosts, since the user
    // hadn't agreed to anything yet. The preview's parse check judges
    // the composed program, and a broken library is the common case, so
    // the bodies are now fetched as soon as the preview renders. See
    // docs/script-viewer.md; the trade is a fetch you didn't ask for
    // against learning the script won't run before you install it.
    //
    // The tabs are still thunks, and still share `previewFetchCache`
    // with the check — so "fetched exactly once" is the assertion that
    // matters either way.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/lib.js', "window.libLoaded = 'yes';\n", {
        contentType: 'application/javascript',
      });
      const file = scriptsDir.write({
        relativePath: 'withreq.user.js',
        meta: {
          name: 'With Require',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/lib.js`],
        },
        body: '',
      });

      const page = await extensionContext.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
      );
      // The tab is listed from the header alone…
      await expect(page.locator('#tabs')).toContainText('lib.js');
      await expect(page.locator('#content')).toContainText('@require');

      // …and the body arrives on its own, pulled by the parse check.
      await expect
        .poll(() => server.requestLog.filter((e) => e.path === '/lib.js').length)
        .toBe(1);

      // Opening the tab serves the cached body rather than re-fetching.
      await page.locator('#tabs button', { hasText: 'lib.js' }).click();
      await expect(page.locator('#content')).toContainText('window.libLoaded');
      expect(server.requestLog.filter((e) => e.path === '/lib.js')).toHaveLength(1);

      // Switching away and back reuses it too.
      await page.locator('#tabs button').first().click();
      await page.locator('#tabs button', { hasText: 'lib.js' }).click();
      await expect(page.locator('#content')).toContainText('window.libLoaded');
      expect(server.requestLog.filter((e) => e.path === '/lib.js')).toHaveLength(1);
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('a #file:line deep link highlights the line, even in a lazily-loaded tab', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A preview URL is as shareable as an installed-viewer URL, so the
    // fragment has to land the same way. The require tab is the hard
    // case: its body is still being fetched when the hash is applied,
    // so the highlight has to survive the wait rather than being
    // dropped (and silently stripped from the URL with it).
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/lib.js', 'line1\nline2\nline3\nline4\n', {
        contentType: 'application/javascript',
      });
      const file = scriptsDir.write({
        relativePath: 'withreq.user.js',
        meta: {
          name: 'With Require',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/lib.js`],
        },
        body: '',
      });

      const page = await extensionContext.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}#lib.js:3`,
      );
      await expect(page.locator('#content')).toContainText('line3');
      await expect(page.locator('.line-flash')).toBeVisible();
      // The fragment survives the load rather than collapsing to the
      // bare filename.
      expect(new URL(page.url()).hash).toBe('#lib.js:3');
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('a @require that would be rejected at install time says so in its tab', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The preview routes through the same loadRequire an install uses,
    // so the wording a user sees here is the wording they'd get in the
    // script's error message afterwards.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/login.js', '<!doctype html><p>log in first</p>', {
        contentType: 'text/html; charset=utf-8',
      });
      const file = scriptsDir.write({
        relativePath: 'badreq.user.js',
        meta: {
          name: 'Bad Require',
          match: ['https://example.com/*'],
          extra: [`// @require     ${server.baseUrl}/login.js`],
        },
        body: '',
      });

      const page = await extensionContext.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
      );
      await page.locator('#tabs button', { hasText: 'login.js' }).click();
      await expect(page.locator('#content')).toContainText('returned an HTML page');
      await page.close();
    } finally {
      await server.stop();
    }
  });
});
