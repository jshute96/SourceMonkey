// E2E coverage for the @grant name-casing example.
//
// The example exists partly so it can be run under Tampermonkey
// (`npm run test:e2e:tm -- tests/examples/grant-case/`) to check what
// TM does with the same three headers. What's asserted:
//
//   - canonical spellings bind (control) — true in every manager.
//   - mis-capitalised legacy `GM_` names bind nothing — also true in
//     every manager; grant matching is byte-exact everywhere.
//   - the `GM.` prefix-rewrite spellings bind. True in VM (which
//     resolves `GM.foo` by rewriting it to `GM_foo`) and here.
//     **Expected to FAIL under Tampermonkey**, whose grant table is a
//     fixed list of exact names with no rewrite. That failure is the
//     informative result, not a regression — see the PR / TODO note
//     about running this under TM.
//
// Only the granted spellings are asserted, so this stays quiet about
// the one place we're looser than VM: we expose *both* `GM.`
// spellings when either is granted, where VM binds only the one the
// script wrote. That's covered in tests/e2e/gm-grants.spec.ts.

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
