// End-to-end coverage of the `.user.js` link capture.
//
// Chrome never renders a `.user.js` URL as an installable page — it is
// just source text — so the extension intercepts the navigation and
// lands the tab on the userscript viewer in preview mode. These tests drive that from a
// real navigation: point a tab at a `.user.js` URL and assert where it
// ends up, what the preview says, and what Install actually registers.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test, and this file writes
// both a settings row (`smCaptureUserJsLinks`) and userscript collections.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';
import { expectNoNewPreview, openCaptured, startCapturedNavigation, trackNewPreviews, waitForInstallPrompt } from '../fixtures/capture-nav';
import { LOCATION_ROW } from '../fixtures/viewer-selectors';

const CAPTURE_KEY = 'smCaptureUserJsLinks';

// The viewer URL an Install / Update lands on, as distinct from the
// preview URL the tab is already sitting at.
const INSTALLED_VIEWER_URL = /userscript\.html\?script=/;

test.describe('.user.js link capture', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('navigating to a .user.js URL lands on the preview', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, scriptUrl);
    await source.close();

    // The preview carries the clicked URL and describes the script,
    // using the same panels an installed script gets. The heading is the
    // script's `@name`; the URL is the Location row's job.
    expect(new URL(page.url()).searchParams.get('preview')).toBe(scriptUrl);
    await expect(page.locator('h1#filename')).toHaveText('SourceMonkey | Install | Hello From The Web');
    await expect(page.locator(LOCATION_ROW)).toHaveText(scriptUrl);
    await expect(page.locator('#header-summary')).toContainText('Hello From The Web');
    await expect(page.locator('#header-summary')).toContainText('https://example.com/*');
    await expect(page.locator('#content')).toContainText('==UserScript==');
    await expect(page.locator('#install-callout')).toBeVisible();
    await expect(page.locator('#install-target option:checked')).toHaveText('Scripts from web (new)');
    await expect(page.locator('#install-btn')).toBeEnabled();
    // Nothing has run, so there is no Log tab to offer.
    await expect(page.locator('#tabs')).not.toContainText('Log');
    await page.close();
  });

  test('Install registers the script and opens its viewer', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, scriptUrl);
    await source.close();
    await page.locator('#install-btn').click();
    await page.waitForURL(INSTALLED_VIEWER_URL);

    // Installed as a normal http collection, exactly as if the URL had
    // been typed into the collections page.
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    const script = withScripts!.scripts[0];
    expect(script.status).toBe('ok');
    expect(script.relativePath).toBe(scriptUrl);
    expect(script.bodyText).toContain('Hello From The Web');
    await page.close();
  });

  test('a percent-encoded script name reads as plain text everywhere it is shown', async ({
    extensionContext, sm,
  }) => {
    // GreasyFork puts the script's human name in the URL path, so the
    // stored location is a wall of escapes. Every surface that shows
    // it to a human decodes; the stored value and the links do not.
    // See docs/names-and-paths.md.
    // Emoji on purpose: they're surrogate pairs, and a per-code-unit
    // re-encoder blows up on them halfway through building the
    // script's `sourcemonkey://` URL — which blanks the whole viewer.
    const encodedPath = '/My%20Script%E2%84%A2%20%F0%9F%9A%80%20%7C%20Ad-Free%20%2B%20More.user.js';
    const decodedName = 'My Script™ 🚀 | Ad-Free + More.user.js';
    server.setRoute(encodedPath, userscriptText('Encoded Name'));
    const scriptUrl = `${server.baseUrl}${encodedPath}`;

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, scriptUrl);
    await source.close();
    // The preview's Location row reads plainly, but the href is still
    // the URL the browser would request.
    await expect(page.locator(LOCATION_ROW)).toContainText(decodedName);
    expect(await page.locator(LOCATION_ROW).getAttribute('href')).toBe(scriptUrl);

    await page.locator('#install-btn').click();
    await page.waitForURL(INSTALLED_VIEWER_URL);

    // The code tab's label shows the decoded name…
    await expect(page.locator('#tabs')).toContainText(decodedName);
    // …and so does the Location row, while its href stays encoded.
    const location = page.locator(LOCATION_ROW);
    await expect(location).toHaveText(scriptUrl.replace(encodedPath, `/${decodedName}`));
    expect(await location.getAttribute('href')).toBe(scriptUrl);
    // What we stored — and would refetch — is the real URL.
    const collections = await sm.getCollections();
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    expect(withScripts!.scripts[0].relativePath).toBe(scriptUrl);
    await page.close();
  });

  test('a second install joins the existing container and opens the new script', async ({
    extensionContext, sm,
  }) => {
    // Exercises the store's `existingContainer` branch — the one that
    // has to pick the newly added script's id, not the container's
    // first. A single-install test can't tell those apart.
    server.setRoute('/first.user.js', userscriptText('First Script'));
    server.setRoute('/second.user.js', userscriptText('Second Script'));
    await sm.addCollection(`${server.baseUrl}/first.user.js`);

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, `${server.baseUrl}/second.user.js`);
    await source.close();
    await page.locator('#install-btn').click();
    await page.waitForURL(INSTALLED_VIEWER_URL);

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    expect(withScripts!.scripts).toHaveLength(2);
    // The viewer opened on the script just installed, not the first one.
    const openedId = new URL(page.url()).searchParams.get('script');
    const opened = withScripts!.scripts.find((s) => s.id === openedId);
    expect(opened?.relativePath).toBe(`${server.baseUrl}/second.user.js`);
    await page.close();
  });

  test('an already-installed script offers its copy in the table instead of Install', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;
    await sm.addCollection(scriptUrl);

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, scriptUrl);
    await source.close();

    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-callout')).toBeHidden();
    await expect(page.locator('#other-versions td.col-actions button', { hasText: 'Update' })).toHaveCount(1);
    await expect(page.locator('#other-versions tr.is-offer button')).toBeDisabled();
    await page.close();
  });

  test('a .user.js URL that is not a userscript cannot be installed', async ({
    extensionContext, sm,
  }) => {
    // A login / error page served in place of the script — the exact
    // case that must not silently become an `invalid` stored row.
    server.setRoute('/broken.user.js', 'alert("no metadata block here");');

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, `${server.baseUrl}/broken.user.js`);
    await source.close();

    await expect(page.locator('#banner-slot')).toContainText('No // ==UserScript== metadata block');
    await expect(page.locator('#install-btn')).toBeHidden();
    // The collection is still shown, so the user can see what they got.
    await expect(page.locator('#content')).toContainText('no metadata block here');
    await page.close();
  });

  // The tab that navigated to a captured web page stays there, past the
  // delay before a tab showing a raw script goes back, and the preview
  // opened beside it closes.
  async function expectStaysOnPage(page: import('@playwright/test').Page, url: string, newPreviews: () => number): Promise<void> {
    await expect.poll(() => page.url()).toBe(url);
    await expect.poll(newPreviews).toBe(0);
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(url);
  }

  test('a captured URL that answers with a web page continues on its own', async ({
    extensionContext, sm,
  }) => {
    // The forge-blob-view case for a host we don't know in advance: a
    // path ending in `.user.js` that is really an HTML page. The
    // capture can't know that before the response arrives, so it fires
    // and then undoes itself once the response says otherwise, with no
    // banner and no click: the tab that navigated stays on the page,
    // and the preview beside it closes.
    server.setRoute(
      '/page.user.js',
      '<!doctype html><title>Blob view</title><p id="page">a web page</p>',
      { contentType: 'text/html; charset=utf-8' },
    );
    const pageUrl = `${server.baseUrl}/page.user.js`;

    const page = await extensionContext.newPage();
    const newPreviews = trackNewPreviews(extensionContext);
    await startCapturedNavigation(page, pageUrl);
    await expectStaysOnPage(page, pageUrl, newPreviews);
    await expect(page.locator('#page')).toHaveText('a web page');
    await page.close();
  });

  test('a mislabelled web page is recognized by its body, not its Content-Type', async ({
    extensionContext, sm,
  }) => {
    // Same escape, proved through the other half of the gate: the
    // server claims JavaScript, so only the leading `<` gives it away.
    server.setRoute(
      '/liar.user.js',
      '<!doctype html><title>Blob view</title><p id="page">a mislabelled page</p>',
      { contentType: 'text/javascript; charset=utf-8' },
    );
    const pageUrl = `${server.baseUrl}/liar.user.js`;

    const page = await extensionContext.newPage();
    const newPreviews = trackNewPreviews(extensionContext);
    await startCapturedNavigation(page, pageUrl);
    // Staying on the URL is the whole assertion; what the tab renders
    // is Chrome's business (source text, since the response claims
    // JavaScript).
    await expectStaysOnPage(page, pageUrl, newPreviews);
    await page.close();
  });

  test('Continue to page reaches a location that is not a script but not a page either', async ({
    extensionContext, sm,
  }) => {
    // What is left for the button once markup leaves on its own: real
    // text that simply isn't a userscript. Nothing about the response
    // says "get out of the way", so the user is asked — and that way
    // through must not be re-captured back into the preview.
    server.setRoute('/plain.user.js', 'alert("no metadata block here");');
    const pageUrl = `${server.baseUrl}/plain.user.js`;

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, pageUrl);
    await source.close();
    await expect(page.locator('#continue-btn')).toBeVisible();
    const newPreviews = trackNewPreviews(extensionContext);
    await page.locator('#continue-btn').click();

    await page.waitForURL(pageUrl);
    await expectNoNewPreview(newPreviews, page, pageUrl);
    await page.close();
  });

  test('View raw source opens the unprocessed file in a new tab', async ({
    extensionContext, sm,
  }) => {
    const body = userscriptText('Hello From The Web');
    server.setRoute('/hello.user.js', body);
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, scriptUrl);
    await source.close();

    const newPreviews = trackNewPreviews(extensionContext);
    const [rawPage] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#view-source-btn').click(),
    ]);

    // Chrome renders a `.user.js` response as source text itself, so
    // View raw source navigates for real. The bypass held: no second
    // preview, and the tab stays on the script.
    await rawPage.waitForURL(scriptUrl);
    await expectNoNewPreview(newPreviews, rawPage, scriptUrl);
    expect(await rawPage.locator('body').innerText()).toContain('==UserScript==');
    // The file arrives line-for-line, not collapsed onto one.
    expect((await rawPage.locator('body').innerText()).split('\n').length).toBeGreaterThan(3);
    // The preview stays open behind it.
    expect(page.url()).toContain('userscript.html?preview=');
    await rawPage.close();
    await page.close();
  });

  // A page with a link to the script, standing in for a script site's
  // listing page.
  function serveListing(scriptPath: string): string {
    server.setRoute(
      '/listing.html',
      `<!doctype html><title>Listing</title><a id="install" href="${scriptPath}">Install</a>`,
      { contentType: 'text/html; charset=utf-8' },
    );
    return `${server.baseUrl}/listing.html`;
  }

  test('a link clicked on a page opens the preview in a new tab and keeps the page', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const listingUrl = serveListing('/hello.user.js');

    const page = await extensionContext.newPage();
    await page.goto(listingUrl);
    const historyBefore = await page.evaluate(() => history.length);
    const [preview] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#install').click(),
    ]);
    await waitForInstallPrompt(preview);

    // The listing's own navigation committed to the script and, a moment
    // later, was sent back: the script is a forward entry in the tab's
    // history, and the listing is what the tab shows.
    await expect.poll(() => page.evaluate(() => history.length).catch(() => 0)).toBe(historyBefore + 1);
    await expect.poll(() => page.url()).toBe(listingUrl);
    await expect(page.locator('#install')).toBeVisible();
    // Cancel closes the preview's tab, which has no history of its own.
    await preview.locator('#cancel-btn').click();
    await expect.poll(() => preview.isClosed()).toBe(true);
    await page.close();
  });

  test('a link middle-clicked into a new tab gets the preview in its own tab', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const listingUrl = serveListing('/hello.user.js');
    const isPreview = (p: import('@playwright/test').Page) => p.url().includes('userscript.html?preview=');

    const page = await extensionContext.newPage();
    await page.goto(listingUrl);
    const before = new Set(extensionContext.pages());
    const newTabs = () => extensionContext.pages().filter((p) => !before.has(p));
    await page.locator('#install').click({ button: 'middle' });
    // The preview opens beside the tab Chrome opened, which shows the
    // raw script until nobody else takes it and then closes, having no
    // history to go back to. So the preview is the only new tab left.
    await expect.poll(() => newTabs().filter(isPreview).length).toBe(1);
    await expect.poll(() => newTabs().length).toBe(1);
    const preview = newTabs().find(isPreview)!;
    await waitForInstallPrompt(preview);
    expect(page.url()).toBe(listingUrl);
    await preview.close();
    await page.close();
  });

  test('a URL entered in a blank tab leaves no blank tab behind', async ({
    extensionContext, sm,
  }) => {
    // Going back would land on the blank page, so the tab closes instead,
    // leaving only the preview.
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const source = await extensionContext.newPage();
    const preview = await openCaptured(source, `${server.baseUrl}/hello.user.js`);
    await expect.poll(() => source.isClosed()).toBe(true);
    await preview.close();
  });

  test('a second click on a script link while it loads opens no second preview', async ({
    extensionContext, sm,
  }) => {
    // A slow server, so the two navigations overlap and the first
    // navigation's abort arrives while the second's watch is live. The
    // clicks come from the page itself: Chrome starts only one
    // navigation for a real double-click on a link, and Playwright's
    // `click` waits for the first navigation to finish.
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'), { delayMs: 1500 });
    const listingUrl = serveListing('/hello.user.js');
    const page = await extensionContext.newPage();
    await page.goto(listingUrl);
    const newPreviews = trackNewPreviews(extensionContext);
    await page.evaluate(() => {
      const link = document.getElementById('install')!;
      link.click();
      setTimeout(() => link.click(), 200);
    });
    await expect.poll(newPreviews).toBe(1);
    // The script commits after the server's delay, and a second later
    // the tab goes back to the listing, so the watch survived the first
    // navigation's abort. Still one preview.
    await expect.poll(() => page.evaluate(() => history.length).catch(() => 0), { timeout: 10_000 }).toBeGreaterThan(2);
    await expect.poll(() => page.url(), { timeout: 10_000 }).toBe(listingUrl);
    expect(newPreviews()).toBe(1);
    for (const p of extensionContext.pages()) if (p.url().includes('userscript.html?preview=')) await p.close();
    await page.close();
  });

  test('a script served as an attachment is previewed, not downloaded', async ({
    extensionContext, getServiceWorker, sm,
  }) => {
    server.setRoute('/dl.user.js', userscriptText('Attached Script'), {
      contentDisposition: 'attachment; filename="dl.user.js"',
    });
    const listingUrl = serveListing('/dl.user.js');
    const scriptUrl = `${server.baseUrl}/dl.user.js`;

    // Counts erased downloads, to prove one was made and then removed.
    const sw = await getServiceWorker();
    type Counter = { smErased: number; smOnErased?: () => void };
    await sw.evaluate(() => {
      const g = self as unknown as Counter;
      g.smErased = 0;
      g.smOnErased = () => { g.smErased++; };
      chrome.downloads.onErased.addListener(g.smOnErased);
    });

    const page = await extensionContext.newPage();
    await page.goto(listingUrl);
    const [preview] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#install').click(),
    ]);
    await waitForInstallPrompt(preview);
    await expect(preview.locator('#header-summary')).toContainText('Attached Script');

    // The listing never left, and the download its navigation became
    // was cancelled and erased.
    expect(page.url()).toBe(listingUrl);
    await expect.poll(() => sw.evaluate(() => (self as unknown as Counter).smErased)).toBe(1);
    expect(await sw.evaluate(
      async (url) => (await chrome.downloads.search({ url })).length,
      scriptUrl,
    )).toBe(0);
    await sw.evaluate(() => {
      const g = self as unknown as Counter;
      if (g.smOnErased) chrome.downloads.onErased.removeListener(g.smOnErased);
    });
    await preview.close();
    await page.close();
  });

  test('View raw source of a script served as an attachment still downloads it', async ({
    extensionContext, getServiceWorker, sm,
  }) => {
    // The capture cancels the download a captured navigation turns
    // into, but not one the person asked for from the preview.
    server.setRoute('/dl.user.js', userscriptText('Attached Script'), {
      contentDisposition: 'attachment; filename="dl.user.js"',
    });
    const scriptUrl = `${server.baseUrl}/dl.user.js`;

    const source = await extensionContext.newPage();
    const page = await openCaptured(source, scriptUrl);
    await source.close();
    await page.locator('#view-source-btn').click();

    const sw = await getServiceWorker();
    await expect.poll(() => sw.evaluate(
      async (url) => (await chrome.downloads.search({ url, state: 'complete' })).length,
      scriptUrl,
    )).toBe(1);
    await page.close();
  });

  test('another manager taking the navigating tab is left alone', async ({
    extensionContext, getServiceWorker, sm,
  }) => {
    // Another script manager rewriting the tab to its own page, played by
    // Tampermonkey's capture page (served locally by a route).
    const tmPage = 'https://www.tampermonkey.net/script_installation.php';
    const tmRoute = `${tmPage}*`;
    await extensionContext.route(tmRoute, (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Other manager</title>',
    }));
    // A path of its own, and the listener and route removed after: the
    // service worker and context are shared with later tests.
    server.setRoute('/other-manager.user.js', userscriptText('Hello From The Web'));
    const sw = await getServiceWorker();
    type Hook = { smOtherManager?: (d: chrome.webNavigation.WebNavigationParentedCallbackDetails) => void };
    await sw.evaluate((other) => {
      const g = self as unknown as Hook;
      g.smOtherManager = (d) => {
        if (d.frameId === 0 && d.url.endsWith('/other-manager.user.js')) {
          void chrome.tabs.update(d.tabId, { url: `${other}#url=x` });
        }
      };
      chrome.webNavigation.onBeforeNavigate.addListener(g.smOtherManager);
    }, tmPage);
    try {
      const source = await extensionContext.newPage();
      const preview = await openCaptured(source, `${server.baseUrl}/other-manager.user.js`);
      // Past the delay before a tab showing the raw script goes back.
      await source.waitForTimeout(1500);
      expect(source.url()).toContain(tmPage);
      await preview.close();
      await source.close();
    } finally {
      await sw.evaluate(() => {
        const g = self as unknown as Hook;
        if (g.smOtherManager) chrome.webNavigation.onBeforeNavigate.removeListener(g.smOtherManager);
      });
      await extensionContext.unroute(tmRoute);
    }
  });

  test('capture can be turned off', async ({ extensionContext, getServiceWorker, sm }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const sw = await getServiceWorker();
    await sw.evaluate(async (key) => {
      await chrome.storage.local.set({ [key]: false });
    }, CAPTURE_KEY);
    // The SW mirrors the flag through a storage.onChanged listener, so
    // the write resolving is not the same as the mirror being updated.
    // Poll the mirror itself before navigating.
    await expect.poll(() => sm.isCaptureEnabled()).toBe(false);

    const page = await extensionContext.newPage();
    const newPreviews = trackNewPreviews(extensionContext);
    await startCapturedNavigation(page, scriptUrl);
    // With capture off Chrome renders the script as source text: no
    // preview opens, and the tab stays on the script.
    await expectNoNewPreview(newPreviews, page, scriptUrl);
    await page.close();
  });
});
