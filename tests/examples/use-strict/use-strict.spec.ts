// A `'use strict'` at the top of a script (right after the metadata
// block) puts the whole script in strict mode, in both worlds, as in
// Tampermonkey and Violentmonkey. With a `@require`, the first file's
// directive is the one that counts, as if the files were concatenated:
// a library that starts with one makes the script strict, and the
// script's own after a library does nothing (as in TM and VM).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function strictness(page: import('@playwright/test').Page, scripts: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const s of scripts) {
    const row = page.locator(`#log li[data-script="${s}"]`);
    await expect(row).toHaveCount(1);
    out[s] = await row.getAttribute('data-strict');
  }
  return out;
}

// The `@require` pair lives in `with-require/` so it can be installed
// on its own. SM's directory scan recurses, so
// under SM the first test installs it too; each test only reads its
// own rows.
test.describe('examples / use-strict', () => {
  test('a top-level \'use strict\' applies to the script', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/use-strict/use-strict.html`);
    expect(await strictness(page, ['page', 'content'])).toEqual({ page: 'true', content: 'true' });
    await page.close();
  });

  test('with a @require, the first file\'s \'use strict\' applies', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(path.join(__dirname, 'with-require'));
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/use-strict/use-strict.html`);
    expect(await strictness(page, ['strict-lib', 'own-after-lib'])).toEqual({ 'strict-lib': 'true', 'own-after-lib': 'false' });
    await page.close();
  });
});
