// End-to-end coverage of the `.user.js` capture for LOCAL files.
//
// The http(s) half lives in `install-capture.spec.ts`; this file covers
// only what `file://` adds:
//   - `webNavigation` fires for `file://` at all, so the capture works
//   - the preview can read a local file from an extension page
//   - Install lands in the file container under the same bare path the
//     collections page's path field produces, and Refresh works afterwards
//   - the bypass lets the user reach the file they meant to read
//
// Environment note: Chrome grants "Allow access to file URLs"
// unconditionally to extensions loaded with `--load-extension`, so the
// fixture always runs with it ON — writing `allow_file_access: false`
// into Preferences does not override it (verified). The
// file-access-OFF behavior is therefore a manual-test item, not
// something these tests can reach.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { startCapturedNavigation, waitForInstallPrompt } from '../fixtures/capture-nav';

const CAPTURE_KEY = 'smCaptureUserJsLinks';

// Mirrors CHROME_USERJS_FIX_VERSION in src/install-capture.ts. Below
// it, a `.user.js` navigation is forced into a download on every
// scheme — including `file://` (verified on Chrome 148), which is
// exactly why a local script needs the capture too.
const CHROME_USERJS_FIX_VERSION = 152;

function chromeMajor(page: Page): Promise<number> {
  return page.evaluate(() => Number(/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0));
}

const INSTALLED_VIEWER_URL = /userscript\.html\?script=/;

test.describe('.user.js capture for local files', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  // Write a script and return both spellings of its location: the bare
  // filesystem path (what the collections page's field takes, and what the
  // store holds) and the `file://` URL (what a browser navigates to).
  function writeScript(name: string, scriptName: string, body = 'console.log("local");\n'): {
    path: string;
    url: string;
  } {
    const path = dir.write({
      relativePath: name,
      meta: { name: scriptName, match: ['https://example.com/*'] },
      body,
    });
    return { path, url: `file://${path}` };
  }

  test('opening a local .user.js lands on the preview', async ({ extensionContext, sm }) => {
    const { url } = writeScript('hello.user.js', 'Hello From Disk');

    const page = await extensionContext.newPage();
    await startCapturedNavigation(page, url);
    await waitForInstallPrompt(page);

    // The clicked URL travels verbatim in `?preview=` — a bypass has to
    // be keyed on the URL the browser would actually navigate to.
    expect(new URL(page.url()).searchParams.get('preview')).toBe(url);
    // …but everything user-facing shows the bare path.
    await expect(page.locator('h1#filename')).toContainText('/hello.user.js');
    await expect(page.locator('h1#filename')).not.toContainText('file://');
    await expect(page.locator('#header-summary')).toContainText('Hello From Disk');
    await expect(page.locator('#content')).toContainText('==UserScript==');
    await expect(page.locator('#banner-slot')).toContainText('not installed yet');
    await expect(page.locator('#install-btn')).toBeEnabled();
    await page.close();
  });

  test('Install stores the bare path, and Refresh picks up an edit', async ({
    extensionContext, sm,
  }) => {
    const { path, url } = writeScript('hello.user.js', 'Hello From Disk');

    const page = await extensionContext.newPage();
    await startCapturedNavigation(page, url);
    await waitForInstallPrompt(page);
    await page.locator('#install-btn').click();
    await page.waitForURL(INSTALLED_VIEWER_URL);

    // Registered exactly as the collections page's path field would have:
    // into the local-file container, keyed by the absolute path.
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0].path).toBe('container:file');
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);
    expect(withScripts!.scripts).toHaveLength(1);
    const script = withScripts!.scripts[0];
    expect(script.status).toBe('ok');
    expect(script.relativePath).toBe(path);
    expect(script.bodyText).toContain('console.log("local")');

    // A source that can never refresh would be worse than no install at
    // all, so prove the round trip: edit on disk, click Refresh, see it.
    dir.rewriteBody('hello.user.js', 'console.log("edited on disk");\n');
    await page.locator('#refresh-btn').click();
    await expect(page.locator('#content')).toContainText('edited on disk');
    const after = await sm.getCollectionWithScripts(collections[0].id);
    expect(after!.scripts[0].bodyText).toContain('edited on disk');
    await page.close();
  });

  test('a file already added by path is recognised as installed', async ({
    extensionContext, sm,
  }) => {
    // The collections page stores a bare path; the capture hands over a
    // `file://` URL. If the preview didn't collapse one to the other the
    // user would be offered Install and end up with two rows for one
    // file.
    const { path, url } = writeScript('hello.user.js', 'Hello From Disk');
    await sm.addCollection(path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await startCapturedNavigation(page, url);
    await waitForInstallPrompt(page);

    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#open-btn')).toBeVisible();
    await expect(page.locator('#update-btn')).toBeVisible();
    await page.close();
  });

  test('View raw source shows the local file without navigating', async ({
    extensionContext, sm,
  }) => {
    const { url } = writeScript('hello.user.js', 'Hello From Disk');

    const page = await extensionContext.newPage();
    await startCapturedNavigation(page, url);
    await waitForInstallPrompt(page);

    const [rawPage] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#view-source-btn').click(),
    ]);
    await rawPage.waitForLoadState();

    // We already hold a copy, so it renders on raw.html — titled with
    // the filename, and line-for-line rather than collapsed.
    expect(rawPage.url()).toContain('raw.html');
    await expect(rawPage).toHaveTitle('hello.user.js');
    const text = await rawPage.locator('#raw').innerText();
    expect(text).toContain('==UserScript==');
    expect(text.split('\n').length).toBeGreaterThan(3);
    // The preview stays open behind it.
    expect(page.url()).toContain('userscript.html?preview=');
    await rawPage.close();
    await page.close();
  });

  test('Continue to file bypasses the capture for a local non-userscript', async ({
    extensionContext, sm,
  }) => {
    // The cost of capturing `file://`: a local file that merely ends in
    // `.user.js` gets hijacked. The way out has to actually work, or the
    // only escape would be turning the option off.
    const path = `${dir.path}/notes.user.js`;
    fs.writeFileSync(path, 'not a userscript at all\n');
    const url = `file://${path}`;

    const page = await extensionContext.newPage();
    await startCapturedNavigation(page, url);
    await waitForInstallPrompt(page);
    await expect(page.locator('#banner-slot')).toContainText('No // ==UserScript== metadata block');
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#continue-btn')).toHaveText('Continue to file');
    // Read before the click: a lost bypass re-navigates this tab, and
    // the resulting "execution context destroyed" would mask the real
    // assertion.
    const major = await chromeMajor(page);

    // Stamp the document so a re-capture (which re-navigates this tab to
    // the preview URL it is already on) is distinguishable from the
    // browser simply handling the file itself.
    await page.evaluate(() => { (window as Window & { __mark?: number }).__mark = 1; });
    await page.locator('#continue-btn').click();

    if (major >= CHROME_USERJS_FIX_VERSION) {
      // The browser renders the file as text, so the tab really lands
      // on it — proof enough that the capture stood down.
      await page.waitForURL(url);
      expect(await page.locator('body').innerText()).toContain('not a userscript');
    } else {
      // The legacy path downloads the file instead, leaving this
      // document in place. A capture would have replaced it — so a
      // surviving stamp is what proves the bypass held.
      await page.waitForTimeout(1500);
      const mark = await page
        .evaluate(() => (window as Window & { __mark?: number }).__mark)
        .catch(() => undefined);
      expect(mark).toBe(1);
    }
    await page.close();
  });

  test('a row stored under the file:// spelling is still recognised', async ({
    extensionContext, getServiceWorker, sm,
  }) => {
    // Rows added before `addCollection` canonicalized `file://` inputs (and
    // any added by pasting a `file://` URL into the Add field) carry the
    // URL spelling. The already-installed check has to canonicalize the
    // STORED value too, or those users get offered a duplicate install.
    const { path, url } = writeScript('hello.user.js', 'Hello From Disk');
    await sm.addCollection(path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const before = await sm.getCollectionWithScripts(collections[0].id);
    // Rewrite the stored row to the old spelling. No test-surface call
    // for this on purpose — it's a shape production code no longer
    // writes, only reads.
    const sw = await getServiceWorker();
    await sw.evaluate(async ([id, oldSpelling]) => {
      const key = `script:${id}`;
      const got = await chrome.storage.local.get(key);
      got[key].relativePath = oldSpelling;
      await chrome.storage.local.set({ [key]: got[key] });
    }, [before!.scripts[0].id, url]);

    const page = await extensionContext.newPage();
    await startCapturedNavigation(page, url);
    await waitForInstallPrompt(page);

    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-btn')).toBeHidden();
    await page.close();
  });

  test('View raw source falls back to the file itself when the fetch failed', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Nothing to render locally, so the raw view navigates for real —
    // the one path that reaches `navigateRaw` with a `file://` URL. It
    // must carry a bypass, or the new tab is captured straight back
    // into another preview.
    const missing = `file://${dir.path}/gone.user.js`;
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(missing)}`,
    );
    await expect(page.locator('#message')).toContainText('Could not fetch this script');
    // A local read that failed asks whether the file-access toggle is
    // to blame, and here it isn't — the grant is on, the file is just
    // missing. The banner must stay away, or every typo'd path starts
    // telling the user to go change a setting that is already right.
    // (The toggle-OFF half of this is the manual check in
    // docs/testing.md — Chrome won't let a `--load-extension` build
    // turn the grant off.)
    await expect(page.locator('#banner-slot')).not.toContainText('File access is disabled');

    const [rawPage] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('#view-source-btn').click(),
    ]);
    // Chrome can't render the missing file either, but the tab must be
    // pointed at it rather than yanked back to a preview.
    // Give a lost bypass time to pull the tab back — without the
    // bypass this URL becomes `userscript.html?preview=…` within a
    // second (checked against a deliberately broken build). With it,
    // the tab is left wherever the browser lands on a missing file
    // (`chrome-error://chromewebdata/` today) — the point is only that
    // it was not yanked into a second preview.
    await page.waitForTimeout(1500);
    expect(rawPage.url()).not.toContain('userscript.html');
    await rawPage.close();
    await page.close();
  });

  test('the installed viewer\'s Location link opens the file, not a preview', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The installed row's Location href IS a `.user.js` URL, so a plain
    // navigation would be captured and land the user on a preview of
    // the script they are already looking at.
    const { path, url } = writeScript('hello.user.js', 'Hello From Disk');
    await sm.addCollection(path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const withScripts = await sm.getCollectionWithScripts(collections[0].id);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${withScripts!.scripts[0].id}`,
    );
    const [opened] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator('.filename-text').click(),
    ]);
    await page.waitForTimeout(1000);
    expect(opened.url()).not.toContain('userscript.html');
    await opened.close();
    await page.close();
  });

  test('capture off leaves local files to the browser', async ({
    extensionContext, getServiceWorker, sm,
  }) => {
    const { url } = writeScript('hello.user.js', 'Hello From Disk');
    const sw = await getServiceWorker();
    await sw.evaluate(async (key) => {
      await chrome.storage.local.set({ [key]: false });
    }, CAPTURE_KEY);

    const page = await extensionContext.newPage();
    // The SW mirrors the flag through a storage.onChanged listener, so
    // the write resolving isn't the same as the mirror being updated.
    // Below Chrome 152 the download-workaround rule is synced by that
    // same code path, which makes its removal an observable proxy.
    if (await chromeMajor(page) < CHROME_USERJS_FIX_VERSION) {
      await expect.poll(async () => {
        const worker = await getServiceWorker();
        return worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules().then((r) => r.length));
      }).toBe(0);
    }

    await startCapturedNavigation(page, url);
    await page.waitForTimeout(500);
    expect(page.url()).not.toContain('userscript.html');
    await page.close();
  });
});
