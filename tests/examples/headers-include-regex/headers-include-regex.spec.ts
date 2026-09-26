// E2E coverage for the regex @include example: which variants run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A regex ignores case in every manager, and slashes inside one need no
// escaping. A flag after the closing slash makes it no regex at all, so
// it matches nothing: the `i` variant doesn't run, and the `@exclude`
// with one excludes nothing.
const EXPECTED = ['exclude-flag-i', 'regex-case', 'regex-escaped', 'regex-slashes'];

// Tampermonkey and Violentmonkey also ignore case in a glob. Chrome
// evaluates globs for SourceMonkey, case-sensitively.
const WITH_GLOB_CASE = [...EXPECTED, 'glob-case'].sort();
const BY_MANAGER: Record<string, string[]> = { tampermonkey: WITH_GLOB_CASE, violentmonkey: WITH_GLOB_CASE };

test.describe('examples / headers-include-regex', () => {
  test('which regex rules match', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/headers-include-regex/headers-include-regex.html`);
    const ran = () => page.locator('#log li').evaluateAll((lis) => lis.map((li) => (li as HTMLElement).dataset.script).sort());
    const expected = BY_MANAGER[setup.manager] ?? EXPECTED;
    await expect.poll(ran).toEqual(expected);
    // Again once the page is done loading, so a script that shouldn't
    // run but starts after the others still fails.
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    expect(await ran()).toEqual(expected);
    await page.close();
  });
});
