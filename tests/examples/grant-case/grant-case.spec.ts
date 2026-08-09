// E2E coverage for the @grant name-casing example.
//
// Split into two tests along the manager boundary, because the three
// userscripts on this page deliberately straddle it:
//
//   - Universal — the canonical spellings bind, and mis-capitalised
//     legacy `GM_` names bind nothing. Grant matching is byte-exact in
//     TM and VM alike, so this holds everywhere and runs under every
//     manager project.
//   - SourceMonkey / VM only — the `GM.` prefix-rewrite spellings bind
//     (`GM.xmlhttpRequest`, `GM.getResourceURL`). VM resolves those by
//     rewriting `GM.foo` → `GM_foo`; TM's grant table is a fixed list
//     of exact names with no rewrite, so it rejects them. Skipped under
//     TM rather than left to fail, so `test:e2e:tm` stays a signal.
//
// To see the TM behaviour by hand, serve the examples
// (`node scripts/serve-examples.mjs`), install the three scripts into
// TM, and read the three `#log` rows on the page. See
// docs/cross-manager-test-results.md.

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
  test('canonical grants bind; mis-cased legacy GM_ grants bind nothing', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/grant-case/grant-case.html`);

    // Control: the legacy spellings TM/VM document all bind. Only the
    // `GM_x` names are asserted — whether the `GM.` aliases come along
    // for free is a per-manager choice (TM's group model says yes,
    // VM's exact-spelling model says no).
    const canonical = await readProbe(page, 'canonical');
    expect(canonical['GM_log']).toBe('function');
    expect(canonical['GM_xmlhttpRequest']).toBe('function');
    expect(canonical['GM_getResourceURL']).toBe('function');

    // `@grant GM_xmlHttpRequest` / `GM_Log` / `GM_getResourceUrl` —
    // nothing binds anywhere. Grant matching is byte-exact in every
    // manager. ('no-GM' is accepted for the dotted spellings: a
    // manager that binds no GM_* at all may not define `GM` either.)
    const legacy = await readProbe(page, 'legacy-case');
    for (const [name, seen] of Object.entries(legacy)) {
      expect(['undefined', 'no-GM'], `${name} should not be bound (saw ${seen})`).toContain(seen);
    }

    await page.close();
  });

  test('GM. prefix-rewrite grants bind, and expose every spelling of the API', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    test.skip(
      setup.manager === 'tampermonkey',
      'TM has no GM. prefix rewrite — it rejects @grant GM.xmlhttpRequest / GM.getResourceURL',
    );
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/grant-case/grant-case.html`);

    // The granted spelling must be callable...
    const rewrite = await readProbe(page, 'rewrite-case');
    expect(rewrite['GM.xmlhttpRequest']).toBe('function');
    expect(rewrite['GM.getResourceURL']).toBe('function');
    expect(rewrite['GM.log']).toBe('function');

    // ...and so must the legacy binding behind it. VM would leave
    // these undefined (it binds only the exact spelling written); we
    // expose the API's whole spelling group, TM-style.
    expect(rewrite['GM_xmlhttpRequest']).toBe('function');
    expect(rewrite['GM_getResourceURL']).toBe('function');
    expect(rewrite['GM_log']).toBe('function');

    // Same group seen from the other side: granting the canonical
    // legacy name also yields both `GM.` spellings.
    const canonical = await readProbe(page, 'canonical');
    expect(canonical['GM.xmlHttpRequest']).toBe('function');
    expect(canonical['GM.xmlhttpRequest']).toBe('function');
    expect(canonical['GM.getResourceUrl']).toBe('function');
    expect(canonical['GM.getResourceURL']).toBe('function');

    await page.close();
  });
});
