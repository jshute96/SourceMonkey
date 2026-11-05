// E2E coverage for the resource-missing example: a @resource whose URL
// doesn't exist, under each manager. The script runs in all three; they
// differ in what the getters give. See docs/resources.md#failure-handling.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../../tests/fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL_OF_MISSING = 'https://jshute96.github.io/SourceMonkey/userscripts/examples/resource-missing/no-such-file.css';

// What each getter gives for the missing resource.
const MISSING_GIVES = {
  sourcemonkey: '',
  tampermonkey: '',
  // Its fallback for a resource it doesn't hold, in both getters.
  violentmonkey: URL_OF_MISSING,
};

test.describe('examples / resource-missing', () => {
  test('the script runs, and each getter gives what its manager gives for a missing resource', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/resource-missing/resource-missing.html`);
    await expect(page.locator('#runStatus')).toHaveAttribute('data-done', 'true');

    const gave = async (call: string): Promise<unknown> =>
      JSON.parse(await page.locator(`td[data-call="${call}"]`).innerText());
    const expected = MISSING_GIVES[setup.manager];
    for (const call of ['GM_getResourceText', 'GM_getResourceURL', 'GM.getResourceText', 'GM.getResourceUrl']) {
      expect(await gave(call), call).toBe(expected);
    }
    // The other resource isn't affected, and the missing one is still declared.
    expect(await gave('GM_getResourceText, working resource')).toBe('hello');
    expect(await gave('GM_info.script.resources lists it')).toBe(true);
    await page.close();
  });
});
