// Tampermonkey's `.tld` host suffix ("any public suffix") in `@match`,
// `@include` and `@exclude`. Chrome's grammars can't say it, so
// `buildRegistrationSpec` registers a coarse glob (`.tld` as `.*`), the
// wrapper's in-page matcher reads `.tld` loosely, and the worker's
// check-pending reply applies the exact reading (the ICANN public
// suffix list). Only a real browser shows that the script then runs
// where its header says and nowhere else, in both worlds: a MAIN-world
// script asks through the bridge, a USER_SCRIPT-world one directly.
//
// The hosts are made up; Playwright answers for them (`route`), so no
// DNS is involved.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const HTML = '<!doctype html><html><body><div id="target">untouched</div></body></html>';

test.describe('.tld hosts', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  for (const grant of ['none', 'GM_setValue']) test(`@match, @include and @exclude read .tld as any public suffix (@grant ${grant})`, async ({
    extensionContext, sm,
  }) => {
    await extensionContext.route(/^https:\/\/[^/]*smtest[^/]*\//, (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: HTML,
    }));
    scriptsDir.write({
      relativePath: 'tld.user.js',
      meta: {
        name: 'TLD Hosts',
        match: ['https://*.smtest-match.tld/*'],
        include: ['https://www.smtest-include.tld/*'],
        exclude: ['https://www.smtest-include.tld/skip*'],
        grant: [grant],
        runAt: 'document-end',
      },
      body: `document.getElementById('target').textContent = 'injected';`,
    });
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('ok');
    expect(await sm.getRejections()).toEqual({});

    const page = await extensionContext.newPage();
    const expectations: Array<[string, string]> = [
      ['https://www.smtest-include.com/', 'injected'],
      ['https://www.smtest-include.co.uk/page', 'injected'],
      ['https://m.smtest-match.de/', 'injected'],
      ['https://www.smtest-include.co.uk/skip', 'untouched'],
      // The coarse glob reaches these; the worker's exact check doesn't.
      ['https://www.smtest-include.evil.com/', 'untouched'],
      ['https://www.smtest-include.blogspot.com/', 'untouched'],
      ['https://smtest-other.com/', 'untouched'],
    ];
    for (const [url, text] of expectations) {
      await page.goto(url);
      await page.waitForLoadState('load');
      if (text === 'untouched') {
        // Give a wrongly injected script time to show itself.
        await page.waitForTimeout(300);
      }
      await expect(page.locator('#target'), url).toHaveText(text);
    }
    await page.close();
  });
});
