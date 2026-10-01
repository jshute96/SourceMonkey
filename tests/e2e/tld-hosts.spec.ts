// Tampermonkey's `.tld` host suffix ("any top-level domain") in
// `@match`, `@include` and `@exclude`. Chrome's grammars can't say it,
// so `buildRegistrationSpec` registers such a script for every page and
// the wrapper's in-page matcher decides. Only a real browser shows that
// the script then runs where its header says and nowhere else.
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

  test('@match, @include and @exclude read .tld as any top-level domain', async ({
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
      ['https://www.smtest-include.evil.com/', 'untouched'],
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
