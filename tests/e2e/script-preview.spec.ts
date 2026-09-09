// The viewer's preview mode (`userscript.html?preview=<url>`), reached
// from the collections page's Add field for a single script.
//
// The capture route into the same page is covered by
// install-capture.spec.ts; this file covers what's specific to Add
// Collection and to preview mode itself: local files, `@require` tabs, and
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

  test('Add with one local script previews it, and Install adds it', async ({
    extensionContext, extensionId, sm,
  }) => {
    const file = scriptsDir.write({
      relativePath: 'local.user.js',
      meta: { name: 'Local Script', match: ['https://example.com/*'] },
      body: "console.log('local');\n",
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await page.locator('#add-path').fill(file);
    // Nothing is added yet — the field routed the file to the preview,
    // in a NEW tab, so the collections page the user was adding from is
    // still there behind it.
    const [preview] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#add-form button[type="submit"]').click(),
    ]);
    await preview.waitForURL(/userscript\.html\?preview=/);
    await expect(page).toHaveURL(/collections\.html/);
    await expect(page.locator('#add-path')).toHaveValue('');

    await expect(preview.locator('#header-summary')).toContainText('Local Script');
    await expect(preview.locator('#content')).toContainText("console.log('local')");
    // Nothing installed anywhere: the install callout is the page's
    // question, with the local default pre-selected.
    await expect(preview.locator('#install-callout')).toBeVisible();
    await expect(preview.locator('#install-target option:checked')).toHaveText('Scripts from local disk (new)');
    expect(await sm.getCollections()).toHaveLength(0);

    await preview.locator('#install-btn').click();
    await preview.waitForURL(/userscript\.html\?script=/);

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    expect(withScripts!.scripts[0].status).toBe('ok');
    await preview.close();
    await page.close();
  });

  test('the heading and tab title name the script, and say which page this is', async ({
    extensionContext, extensionId,
  }) => {
    const file = scriptsDir.write({
      relativePath: 'named.user.js',
      meta: { name: 'Named Script', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // Preview mode says it is the install question, in both places.
    await expect(page.locator('h1#filename'))
      .toHaveText('SourceMonkey | Install | Named Script');
    await expect(page).toHaveTitle('Install script: Named Script | SourceMonkey');

    await page.locator('#install-btn').click();
    await page.waitForURL(/userscript\.html\?script=/);

    // Installed mode carries the same name, with no install wording.
    await expect(page.locator('h1#filename')).toHaveText('SourceMonkey | Named Script');
    await expect(page).toHaveTitle('Named Script | SourceMonkey');
    await page.close();
  });

  test('a script with no @name is headed by its location alone', async ({
    extensionContext, extensionId,
  }) => {
    const file = scriptsDir.write({
      relativePath: 'anon.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    // The location stands in for the name it doesn't have.
    await expect(page.locator('h1#filename')).toHaveText(`SourceMonkey | Install | ${file}`);
    await expect(page).toHaveTitle(`Install script: ${file} | SourceMonkey`);
    await page.close();
  });

  test('with no script to name, both the heading and the tab say so', async ({
    extensionContext, extensionId,
  }) => {
    const page = await extensionContext.newPage();
    // Neither `?script=` nor `?preview=`: nothing to name, and no mode
    // to flavor the wording with.
    await page.goto(`chrome-extension://${extensionId}/userscript.html`);
    await expect(page.locator('h1#filename')).toHaveText('SourceMonkey | Not available');
    // The title too — this state is also reached by removing the script
    // an open viewer is showing, where a stale title would keep
    // advertising it.
    await expect(page).toHaveTitle('Not available | SourceMonkey');
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
    await sm.addCollection(file);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-callout')).toBeHidden();
    const update = page.locator('#other-versions td.col-actions button', { hasText: 'Update' });
    await expect(update).toBeVisible();

    await update.click();
    await expect(update).toBeEnabled();
    // Still one script — Update refreshed the existing row rather than
    // adding a second copy.
    const collections = await sm.getCollections();
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    await page.close();
  });

  test('a script missing @match is previewed but cannot be installed', async ({
    extensionContext, extensionId, sm,
  }) => {
    // It parses as a userscript, so the "no metadata block" branch
    // doesn't fire — this is the validateHeader branch, which must
    // refuse just as firmly rather than letting addCollection create an
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
    // Local `.user.js` navigations are captured too, so this file needs
    // the same way out an http one gets — pointed at the `file://` form,
    // since the bare path the preview was opened with isn't navigable.
    await expect(page.locator('#continue-btn')).toBeVisible();
    await expect(page.locator('#continue-btn')).toHaveText('Continue to file');
    // The collection is still on screen — seeing what you actually got is
    // the point when a file isn't what you expected.
    await expect(page.locator('#content')).toContainText("console.log('unreachable')");
    expect(await sm.getCollections()).toHaveLength(0);
    await page.close();
  });

  test('a location we can never fetch is reported as a bad location, not a failed fetch', async ({
    extensionContext, extensionId,
  }) => {
    // `?preview=` is reachable by hand and by the capture route, so the
    // input isn't always something the Add field validated. An
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
    await expect(message).toContainText('must be a URL or absolute file path');
    await expect(message).not.toContainText('Could not fetch');
    await expect(page.locator('#install-btn')).toBeHidden();
    // The heading survives a location we never fetched: no header to
    // read a name from, so it is the raw input under the install
    // wording.
    await expect(page.locator('h1#filename'))
      .toHaveText('SourceMonkey | Install | ftp://example.com/thing.user.js');
    await expect(page)
      .toHaveTitle('Install script: ftp://example.com/thing.user.js | SourceMonkey');
    await page.close();
  });

  test('a preview the user asked for reports a web page instead of following it', async ({
    extensionContext, extensionId,
  }) => {
    // The other half of the capture's markup escape. A CAPTURED
    // preview navigates itself to the page (install-capture.spec.ts);
    // this one was asked for — by the collections page's Add field, or
    // by hand — so navigating the tab off SourceMonkey would be
    // answering a question with a disappearance. It reports instead,
    // and offers the same way through the invalid path offers.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/login.user.js', '<!doctype html><title>Please log in</title>', {
        contentType: 'text/html; charset=utf-8',
      });
      const pageUrl = `${server.baseUrl}/login.user.js`;

      const page = await extensionContext.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(pageUrl)}`,
      );
      await expect(page.locator('#message')).toContainText('HTML page, not JavaScript');
      await expect(page.locator('#install-btn')).toBeHidden();
      await expect(page.locator('#continue-btn')).toBeVisible();
      // Still here — the whole point.
      expect(page.url()).toContain('userscript.html?preview=');
      await page.close();
    } finally {
      await server.stop();
    }
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
