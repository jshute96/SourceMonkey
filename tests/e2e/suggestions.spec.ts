// The collections page's suggestion box (src/suggestions.ts):
// what it lists, closing it, and the Options checkbox that mirrors it.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const KEY = 'smShowSuggestions';
const EXAMPLES = 'sourcemonkey-examples';
const STATUS = 'greasyfork-test-status';

test.describe('suggestion box', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('lists every suggestion on a fresh profile, and the script one opens its install page', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const items = page.locator('.suggestions .suggestion');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute('data-suggestion-id', EXAMPLES);
    await expect(items.nth(1)).toHaveAttribute('data-suggestion-id', STATUS);

    const opened = extensionContext.waitForEvent('page');
    await items.nth(1).locator('button').click();
    const preview = await opened;
    await preview.waitForURL(/userscript\.html\?preview=/);
    expect(new URL(preview.url()).searchParams.get('preview'))
      .toBe('https://jshute96.github.io/SourceMonkey/tests/greasyfork-examples/show-on-GreasyFork.user.js');
    await preview.close();
    await page.close();
  });

  test('leaves out a script installed from anywhere, by @namespace and @name', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator('.suggestions .suggestion')).toHaveCount(2);

    scriptsDir.write({
      relativePath: 'status.user.js',
      meta: {
        name: 'Show SourceMonkey test status on Greasy Fork',
        match: ['https://greasyfork.org/*'],
        extra: ['// @namespace   https://github.com/jshute96/SourceMonkey'],
      },
      body: '',
    });
    await sm.addCollection(scriptsDir.path);
    await expect(page.locator('.suggestions .suggestion')).toHaveCount(1);
    await expect(page.locator('.suggestions .suggestion')).toHaveAttribute('data-suggestion-id', EXAMPLES);
    await page.close();
  });

  test('closing is remembered, and the Options checkbox is the same setting', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await page.locator('.suggestions .suggestions-close').click();
    await expect(page.locator('.suggestions')).toHaveCount(0);
    await expect.poll(() => page.evaluate((k) => chrome.storage.local.get(k).then((g) => g[k]), KEY))
      .toBe(false);
    await page.reload();
    await expect(page.locator('#collections .empty-placeholder')).toBeVisible();
    await expect(page.locator('.suggestions')).toHaveCount(0);

    const options = await extensionContext.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    const cb = options.locator('#show-suggestions');
    await expect(cb).not.toBeChecked();
    await cb.check();
    await expect(page.locator('.suggestions .suggestion')).toHaveCount(2);
    await cb.uncheck();
    await expect(page.locator('.suggestions')).toHaveCount(0);
    await options.close();
    await page.close();
  });
});
