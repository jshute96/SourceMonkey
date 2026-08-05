// E2E coverage for the @grant name-casing example.
//
// The assertions here are deliberately manager-agnostic — this
// example exists partly so it can be run under Tampermonkey
// (`npm run test:e2e:tm -- tests/examples/grant-case/`) to check what
// TM does with the same three headers. So we only assert on the
// spellings every manager we care about agrees on:
//
//   - canonical spellings bind (control).
//   - the `GM.` prefix-rewrite spellings bind (VM resolves these by
//     rewriting `GM.foo` → `GM_foo`; SourceMonkey matches).
//   - mis-capitalised legacy `GM_` names bind nothing.
//
// SourceMonkey-specific extras — notably that we expose *both* `GM.`
// spellings when either is granted, where VM exposes only the one the
// script wrote — live in tests/e2e/gm-grants.spec.ts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Probe = Record<string, string>;

async function readProbe(
  page: import('@playwright/test').Page,
  script: string,
): Promise<Probe> {
  const row = page.locator(`#log li[data-script="${script}"]`);
  await expect(row).toHaveCount(1);
  const raw = await row.getAttribute('data-probe');
  return JSON.parse(raw ?? '{}') as Probe;
}

test.describe('examples / grant-case', () => {
  test('canonical grants bind; rewrite-form GM. grants bind; mis-cased GM_ grants do not', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/grant-case/grant-case.html`);

    // Control: the spellings TM/VM document all bind.
    const canonical = await readProbe(page, 'canonical');
    expect(canonical['GM_log']).toBe('function');
    expect(canonical['GM_xmlhttpRequest']).toBe('function');
    expect(canonical['GM_getResourceURL']).toBe('function');
    expect(canonical['GM.log']).toBe('function');
    expect(canonical['GM.xmlHttpRequest']).toBe('function');
    expect(canonical['GM.getResourceUrl']).toBe('function');

    // `@grant GM.xmlhttpRequest` / `@grant GM.getResourceURL` — the
    // literal `GM_` suffix moved onto the `GM.` namespace. The
    // granted spelling must be callable, and the legacy binding
    // behind it must exist too.
    const gm4 = await readProbe(page, 'gm4-case');
    expect(gm4['GM.xmlhttpRequest']).toBe('function');
    expect(gm4['GM.getResourceURL']).toBe('function');
    expect(gm4['GM.log']).toBe('function');
    expect(gm4['GM_xmlhttpRequest']).toBe('function');
    expect(gm4['GM_getResourceURL']).toBe('function');
    expect(gm4['GM_log']).toBe('function');

    // `@grant GM_xmlHttpRequest` / `GM_Log` / `GM_getResourceUrl` —
    // nothing binds. Grant matching is byte-exact everywhere.
    // ('no-GM' is accepted for the dotted spellings: a manager that
    // binds no GM_* at all may not define the `GM` object either.)
    const legacy = await readProbe(page, 'legacy-case');
    for (const [name, seen] of Object.entries(legacy)) {
      expect(['undefined', 'no-GM'], `${name} should not be bound (saw ${seen})`).toContain(seen);
    }

    await page.close();
  });
});
