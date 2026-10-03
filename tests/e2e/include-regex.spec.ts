// A userscript with a regex `@include` beside its `@match`. Chrome can't
// read a regex, so `buildRegistrationSpec` registers `<all_urls>` and
// the wrapper's in-page matcher holds the script to its rules. With
// only the `@match` registered, Chrome never injected on a page just
// the regex covers.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('regex @include', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('runs on the pages its regex covers, beside its @match, and nowhere else', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'regex.user.js',
      meta: {
        name: 'Regex Include',
        match: [`${fixtureServer.baseUrl}/other.html`],
        include: ['/\\/TARGET\\.html$/'],
        runAt: 'document-end',
      },
      body: `document.documentElement.dataset.ran = '1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const ran = () => page.evaluate(() => document.documentElement.dataset.ran === '1');
    // The regex's page, matched ignoring case.
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(ran).toBe(true);
    // The @match's page.
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await expect.poll(ran).toBe(true);
    // Neither: `<all_urls>` only carries it there, and the wrapper stops it.
    await page.goto(`${fixtureServer.baseUrl}/blank.html`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(300);
    expect(await ran()).toBe(false);
    await page.close();
  });
});
