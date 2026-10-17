// E2E coverage for the #hash-in-matching example: which variants run
// on the page opened as `headers-match-hash.html#part`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Chrome's own rules, which SourceMonkey and the harness follow:
// `@match` ignores the hash, and `@include` / `@exclude` see it. By the
// hash the page is opened with.
const CHROME: Record<string, string[]> = {
  '': ['exclude-hash', 'include-exact', 'match-exact', 'match-regex'],
  '#part': ['include-hash', 'match-exact', 'match-regex'],
  '#other': ['exclude-hash', 'match-exact', 'match-regex'],
};

// The other managers each differ, as observed with `#part`:
// - Tampermonkey ignores the hash in every rule, so an `@include`
//   without it matches, and one with it, or an `@exclude` of it, don't.
// - Violentmonkey also matches an `@match` that names the hash.
const OTHERS_WITH_PART: Record<string, string[]> = {
  tampermonkey: ['exclude-hash', 'include-exact', 'match-exact', 'match-regex'],
  violentmonkey: ['include-hash', 'match-exact', 'match-hash', 'match-regex'],
};

test.describe('examples / headers-match-hash', () => {
  for (const hash of Object.keys(CHROME)) {
    test(`which rules match with ${hash || 'no hash'}`, async ({
      extensionContext, fixtureServer, setup,
    }) => {
      const others = OTHERS_WITH_PART[setup.manager];
      test.skip(others !== undefined && hash !== '#part', 'Only #part was observed in this manager');
      await setup.installScriptsFrom(__dirname);

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/headers-match-hash/headers-match-hash.html${hash}`);
      const ran = () => page.locator('#log li').evaluateAll((lis) => lis.map((li) => (li as HTMLElement).dataset.script).sort());
      const expected = others ?? CHROME[hash];
      await expect.poll(ran).toEqual(expected);
      // Again once the page is done loading, so a script that shouldn't
      // run but starts after the others still fails.
      await page.waitForLoadState('load');
      await page.waitForTimeout(500);
      expect(await ran()).toEqual(expected);
      // The page keeps the log sorted by text.
      const texts = await page.locator('#log li').allTextContents();
      expect(texts).toEqual([...texts].sort((a, b) => a.localeCompare(b)));

      await page.close();
    });
  }
});
