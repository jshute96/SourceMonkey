// End-to-end coverage of the `.user.js` link capture.
//
// Chrome never renders a `.user.js` URL as an installable page (see
// src/install-capture.ts for the version-by-version detail), so the
// extension intercepts the navigation and lands the tab on its own
// install prompt. These tests drive that from a real navigation:
// point a tab at a `.user.js` URL and assert where it ends up, what
// the prompt says, and what Install actually registers.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test, and this file writes
// both a settings row (`smCaptureUserJsLinks`) and userscript sources.

import type { Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

const CAPTURE_KEY = 'smCaptureUserJsLinks';

// The Chrome milestone that removed `.user.js` download special-casing;
// mirrors CHROME_USERJS_FIX_VERSION in src/install-capture.ts. Several
// behaviors legitimately differ across it, so the tests branch on the
// browser they actually got rather than pinning today's Chromium.
const CHROME_USERJS_FIX_VERSION = 152;

function chromeMajor(page: Page): Promise<number> {
  return page.evaluate(() => Number(/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0));
}

// `page.waitForURL` rejects here: the captured navigation ends in
// net::ERR_ABORTED (Chrome was mid-download when the tab was pointed
// elsewhere), and Playwright surfaces that as the navigation's result
// even though the tab goes on to load the install page. Poll the tab's
// URL instead, then wait for the prompt itself to be interactive.
async function waitForInstallPrompt(page: Page): Promise<void> {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('install.html');
  await expect(page.locator('#title')).toBeVisible();
}

// Read back the download-workaround rule the SW registered, if any.
interface SessionRule {
  id: number;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
}
async function workaroundRules(getServiceWorker: () => Promise<Worker>): Promise<SessionRule[]> {
  const sw = await getServiceWorker();
  return sw.evaluate(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return JSON.parse(JSON.stringify(rules));
  });
}

test.describe('.user.js link capture', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('navigating to a .user.js URL lands on the install prompt', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const page = await extensionContext.newPage();
    // The capture aborts this navigation mid-flight, which surfaces to
    // Playwright as a failed goto; the tab redirect is what we assert.
    await page.goto(scriptUrl).catch(() => {});
    await waitForInstallPrompt(page);

    // The prompt carries the clicked URL and describes the script.
    expect(new URL(page.url()).searchParams.get('url')).toBe(scriptUrl);
    await expect(page.locator('#title')).toHaveText('Hello From The Web');
    await expect(page.locator('#details')).toContainText('https://example.com/*');
    await expect(page.locator('#code')).toContainText('==UserScript==');
    await expect(page.locator('#install-btn')).toBeEnabled();
    await page.close();
  });

  test('Install registers the script and opens its viewer', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const page = await extensionContext.newPage();
    await page.goto(scriptUrl).catch(() => {});
    await waitForInstallPrompt(page);
    await page.locator('#install-btn').click();
    await page.waitForURL(/userscript\.html/);

    // Installed as a normal http source, exactly as if the URL had
    // been typed into the sources page.
    const sources = await sm.getSources();
    expect(sources).toHaveLength(1);
    const withScripts = await sm.getSourceWithScripts(sources[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    const script = withScripts!.scripts[0];
    expect(script.status).toBe('ok');
    expect(script.relativePath).toBe(scriptUrl);
    expect(script.bodyText).toContain('Hello From The Web');
    await page.close();
  });

  test('a second install joins the existing container and opens the new script', async ({
    extensionContext, sm,
  }) => {
    // Exercises addSource's `existingContainer` branch — the one that
    // has to pick the newly added script's id, not the container's
    // first. A single-install test can't tell those apart.
    server.setRoute('/first.user.js', userscriptText('First Script'));
    server.setRoute('/second.user.js', userscriptText('Second Script'));
    await sm.addSource(`${server.baseUrl}/first.user.js`);

    const page = await extensionContext.newPage();
    await page.goto(`${server.baseUrl}/second.user.js`).catch(() => {});
    await waitForInstallPrompt(page);
    await page.locator('#install-btn').click();
    await page.waitForURL(/userscript\.html/);

    const sources = await sm.getSources();
    expect(sources).toHaveLength(1);
    const withScripts = await sm.getSourceWithScripts(sources[0].id);
    expect(withScripts!.scripts).toHaveLength(2);
    // The viewer opened on the script just installed, not the first one.
    const openedId = new URL(page.url()).searchParams.get('script');
    const opened = withScripts!.scripts.find((s) => s.id === openedId);
    expect(opened?.relativePath).toBe(`${server.baseUrl}/second.user.js`);
    await page.close();
  });

  test('an already-installed script offers Open / Update instead of Install', async ({
    extensionContext, sm,
  }) => {
    server.setRoute('/hello.user.js', userscriptText('Hello From The Web'));
    const scriptUrl = `${server.baseUrl}/hello.user.js`;
    await sm.addSource(scriptUrl);

    const page = await extensionContext.newPage();
    await page.goto(scriptUrl).catch(() => {});
    await waitForInstallPrompt(page);

    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#open-btn')).toBeVisible();
    await expect(page.locator('#update-btn')).toBeVisible();
    await page.close();
  });

  test('a .user.js URL that is not a userscript cannot be installed', async ({
    extensionContext, sm,
  }) => {
    // A login / error page served in place of the script — the exact
    // case that must not silently become an `invalid` stored row.
    server.setRoute('/broken.user.js', 'alert("no metadata block here");');

    const page = await extensionContext.newPage();
    await page.goto(`${server.baseUrl}/broken.user.js`).catch(() => {});
    await waitForInstallPrompt(page);

    await expect(page.locator('#banner-slot')).toContainText('not an installable userscript');
    await expect(page.locator('#install-btn')).toBeHidden();
    // The source is still shown, so the user can see what they got.
    await expect(page.locator('#code')).toContainText('no metadata block here');
    await page.close();
  });

  test('Continue to page bypasses the capture and reaches the real URL', async ({
    extensionContext, sm,
  }) => {
    // The forge-blob-view case: a path ending in `.user.js` that is
    // really an HTML page. The capture can't know that before the
    // response arrives, so the prompt has to offer a way through to the
    // page — and that way must not be re-captured back into the prompt.
    server.setRoute(
      '/page.user.js',
      '<!doctype html><title>Blob view</title><p id="page">a web page</p>',
      { contentType: 'text/html; charset=utf-8' },
    );
    const pageUrl = `${server.baseUrl}/page.user.js`;

    const page = await extensionContext.newPage();
    await page.goto(pageUrl).catch(() => {});
    await waitForInstallPrompt(page);
    await expect(page.locator('#continue-btn')).toBeVisible();
    await page.locator('#continue-btn').click();

    await page.waitForURL(pageUrl);
    await expect(page.locator('#page')).toHaveText('a web page');
    await page.close();
  });

  test('View raw source opens the unprocessed file in a new tab', async ({
    extensionContext, sm,
  }) => {
    const body = userscriptText('Hello From The Web');
    server.setRoute('/hello.user.js', body);
    const scriptUrl = `${server.baseUrl}/hello.user.js`;

    const page = await extensionContext.newPage();
    await page.goto(scriptUrl).catch(() => {});
    await waitForInstallPrompt(page);

    const [rawPage] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#view-source-btn').click(),
    ]);
    await rawPage.waitForLoadState();

    if (await chromeMajor(page) < CHROME_USERJS_FIX_VERSION) {
      // The browser can't render a `.user.js` response as text on these
      // versions, so the prompt shows its own fetched copy on raw.html,
      // titled with the filename rather than an opaque URL.
      expect(rawPage.url()).toContain('raw.html');
      await expect(rawPage).toHaveTitle('hello.user.js');
      expect(await rawPage.locator('#raw').innerText()).toBe(body);
    } else {
      // Chrome renders it itself here, so the raw view navigates for
      // real — which also proves the bypass held and the capture didn't
      // pull the tab back to the prompt.
      await rawPage.waitForURL(scriptUrl);
      expect(await rawPage.locator('body').innerText()).toContain('==UserScript==');
    }
    // Either way the file arrives line-for-line, not collapsed onto one.
    expect((await rawPage.locator('body').innerText()).split('\n').length).toBeGreaterThan(3);
    // The prompt stays open behind it.
    expect(page.url()).toContain('install.html');
    await rawPage.close();
    await page.close();
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
    // The workaround rule is synced by that same code path, which makes
    // its removal an observable proxy for "the toggle has landed".
    // (Skipped past Chrome 152, where the rule is never registered.)
    const page = await extensionContext.newPage();
    if (await chromeMajor(page) < CHROME_USERJS_FIX_VERSION) {
      await expect.poll(() => workaroundRules(getServiceWorker)).toHaveLength(0);
    }

    await page.goto(scriptUrl).catch(() => {});
    // With capture off Chrome does its own thing (download, or render
    // as text depending on version) — either way the tab must not end
    // up on the install prompt.
    await page.waitForTimeout(500);
    expect(page.url()).not.toContain('install.html');
    await page.close();
  });

  test('the download workaround rule is path-anchored, and absent past Chrome 152', async ({
    extensionContext, getServiceWorker, sm,
  }) => {
    const page = await extensionContext.newPage();
    const major = await chromeMajor(page);
    await page.close();

    const rules = await workaroundRules(getServiceWorker);
    if (major >= CHROME_USERJS_FIX_VERSION) {
      // Past the fix the rewrite would garble a perfectly good source
      // view, so it must not be registered at all.
      expect(rules).toHaveLength(0);
      return;
    }
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    expect(rule.condition.requestMethods).toEqual(['get']);
    expect(rule.condition.isUrlFilterCaseSensitive).toBe(true);
    // Anchored to the path: `…/view?f=a.user.js` is a page that links to
    // a script, and rewriting its Content-Type would HTML-parse it.
    const regex = new RegExp(rule.condition.regexFilter as string);
    expect(regex.test('https://host/foo.user.js')).toBe(true);
    expect(regex.test('https://host/foo.user.js?v=2')).toBe(true);
    expect(regex.test('https://host/view?f=a.user.js')).toBe(false);
    // The rewrite keeps a charset so a UTF-8 script isn't mojibaked.
    expect(JSON.stringify(rule.action)).toContain('charset=utf-8');
  });
});
