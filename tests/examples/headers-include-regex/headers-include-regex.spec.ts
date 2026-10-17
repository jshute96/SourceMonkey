// E2E coverage for the regex @include example: which variants run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A regex and a glob ignore case in every manager, and slashes inside a
// regex need no escaping. A flag after the closing slash makes it no
// regex at all, so it matches nothing: the `i` variant doesn't run, and
// the `@exclude` with one excludes nothing.
const EXPECTED = ['exclude-flag-i', 'glob-case', 'regex-case', 'regex-escaped', 'regex-slashes'];

test.describe('examples / headers-include-regex', () => {
  test('which regex rules match', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/headers-include-regex/headers-include-regex.html`);
    const ran = () => page.locator('#log li').evaluateAll((lis) => lis.map((li) => (li as HTMLElement).dataset.script).sort());
    await expect.poll(ran).toEqual(EXPECTED);
    // Again once the page is done loading, so a script that shouldn't
    // run but starts after the others still fails.
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    expect(await ran()).toEqual(EXPECTED);
    await page.close();
  });
});
