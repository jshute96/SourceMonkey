// A regex `@include` registers as globs derived from it (see
// `regexIncludeGlobs` in src/regex-to-glob.ts) rather than `<all_urls>`,
// so Chrome injects only where the regex could match.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('regex @include as globs', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('registers its globs, not <all_urls>, and runs where the regex matches', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const port = new URL(fixtureServer.baseUrl).port;
    // The host spelled in another case: the regex ignores case, and the
    // glob's lowercased host still lets Chrome inject.
    scriptsDir.write({
      relativePath: 'regex.user.js',
      meta: { name: 'Regex', include: [`/^http:\\/\\/LocalHost:${port}\\/other\\.html/`], runAt: 'document-end' },
      body: `document.getElementById('target').textContent = 'regex ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const sw = await getServiceWorker();
    // The script, and the GM runtime that follows its patterns.
    const registered = await sw.evaluate(async () => (await chrome.userScripts.getScripts())
      .map((s) => ({ matches: s.matches, includeGlobs: s.includeGlobs })));
    expect(registered).toContainEqual({
      matches: ['*://*/__sourcemonkey_no_page__/*', 'file:///__sourcemonkey_no_page__/*', 'ftp://*/__sourcemonkey_no_page__/*'],
      includeGlobs: [`http://localhost:${port}/?????.????*`],
    });
    expect(registered.flatMap((r) => r.matches ?? [])).not.toContain('<all_urls>');

    const page = await extensionContext.newPage();
    await page.goto(`http://localhost:${port}/other.html`);
    await expect(page.locator('#target')).toHaveText('regex ran');
    // Same server, a host the regex doesn't name: the script doesn't run.
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await page.waitForLoadState('load');
    await expect(page.locator('#target')).not.toHaveText('regex ran');
    await page.close();
  });

  // The derivation assumes a glob sees the same string the wrapper
  // tests the regex against: the whole URL, query and fragment
  // included. And that `\` in a glob may escape the next character,
  // which is why a literal `\` is rendered as `?`.
  test('Chrome matches includeGlobs against the query and fragment, and reads \\ in them', async ({
    extensionContext, fixtureServer, getServiceWorker, sm,
  }) => {
    // SourceMonkey's sync removes registrations it doesn't know; let the
    // one the fixture's reset scheduled run before registering a probe.
    await sm.syncNow();
    const sw = await getServiceWorker();
    await sw.evaluate(async () => {
      const probe = (id: string, glob: string) => ({
        id,
        matches: ['*://*/__sourcemonkey_no_page__/*'],
        includeGlobs: [glob],
        runAt: 'document_end' as const,
        js: [{ code: `document.body.dataset['${id.replace(/-/g, '')}'] = 'yes';` }],
      });
      await chrome.userScripts.register([
        probe('glob-query', '*/other.html?q=1#*'),
        probe('glob-fragment', '*#frag'),
        // `\*` as an escaped `*`: matches the URL's literal `*` only.
        probe('glob-escape', '*/other.html?s=\\*'),
      ]);
    });
    try {
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/other.html?q=1#frag`);
      const body = page.locator('body');
      await expect(body).toHaveAttribute('data-globquery', 'yes');
      await expect(body).toHaveAttribute('data-globfragment', 'yes');
      await page.goto(`${fixtureServer.baseUrl}/other.html?s=xyz`);
      await page.waitForLoadState('load');
      const escapeOnPlain = await body.getAttribute('data-globescape');
      await page.goto(`${fixtureServer.baseUrl}/other.html?s=*`);
      await page.waitForLoadState('load');
      const escapeOnStar = await body.getAttribute('data-globescape');
      // `\\*` is a literal `*`, not "anything".
      expect(escapeOnPlain).toBeNull();
      expect(escapeOnStar).toBe('yes');
      await page.close();
    } finally {
      const cleanupSw = await getServiceWorker();
      await cleanupSw.evaluate(() => chrome.userScripts.unregister({ ids: ['glob-query', 'glob-fragment', 'glob-escape'] }));
    }
  });

  // What the derivation rests on: Chrome matches `includeGlobs` against
  // the URL with its scheme and host already lowercased, so a glob of
  // lowercased host literals covers a case-insensitive regex.
  test('Chrome lowercases the host before matching includeGlobs', async ({
    extensionContext, fixtureServer, getServiceWorker, sm,
  }) => {
    await sm.syncNow();
    const port = new URL(fixtureServer.baseUrl).port;
    const sw = await getServiceWorker();
    await sw.evaluate(async (p) => {
      await chrome.userScripts.register([{
        id: 'glob-case-probe',
        matches: ['*://*/__sourcemonkey_no_page__/*'],
        includeGlobs: [`http://localhost:${p}/other*`],
        runAt: 'document_end',
        js: [{ code: `const el = document.getElementById('target'); if (el) el.textContent = 'probe';` }],
      }]);
    }, port);
    try {
      const page = await extensionContext.newPage();
      await page.goto(`HTTP://LocalHost:${port}/other.html`);
      expect(page.url()).toBe(`http://localhost:${port}/other.html`);
      await expect(page.locator('#target')).toHaveText('probe');
      await page.close();
    } finally {
      const cleanupSw = await getServiceWorker();
      await cleanupSw.evaluate(() => chrome.userScripts.unregister({ ids: ['glob-case-probe'] }));
    }
  });
});
