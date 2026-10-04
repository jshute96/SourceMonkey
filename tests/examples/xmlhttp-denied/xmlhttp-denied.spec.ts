// E2E coverage for the xmlhttp-denied example.
//
// The three userscripts in this directory all auto-fire a single
// GM_xmlhttpRequest at http://127.0.0.1:1/ when they run. The
// spec only asserts on the @connect *policy* outcome, not on the
// network call itself — the policy gate runs in the SW before any
// fetch, so a denied request never leaves the browser; the allowed
// case still fires a real fetch but the loopback port refuses
// immediately, so we don't rely on external network.
//
// The two scripts whose rules don't cover the host each open
// SourceMonkey's connection prompt, which the spec answers with Deny.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / xmlhttp-denied', () => {
  test('@connect denial covers the no-connect and mismatched-host cases; @connect 127.0.0.1 lets the request through', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // TM's and VM's @connect UX both differ from SourceMonkey's: TM
    // prompts in its own way, VM doesn't check at all, and each has
    // its own messages. The prompt window and the "was denied for this
    // script" message this test drives are SM-only. Skip on both and
    // treat their behaviour as out-of-scope here.
    test.skip(setup.manager !== 'sourcemonkey', `${setup.manager} uses its own @connect UX (prompts, different message)`);

    await setup.installScriptsFrom(__dirname);

    // Deny each prompt as it opens: one per script that asks.
    extensionContext.on('page', (p) => {
      if (!p.url().includes('connect-prompt.html')) return;
      void p.locator('#deny').click().catch(() => undefined);
    });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/xmlhttp-denied/xmlhttp-denied.html`);

    // Wait for all three userscripts' results.
    await expect(page.locator('#log li[data-script="no-connect"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="connect-mismatch"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="connect-allowed"]')).toHaveCount(1);

    // The two denied scripts should fire onerror with the denial
    // message.
    const noConnect = page.locator('#log li[data-script="no-connect"]');
    await expect(noConnect).toHaveAttribute('data-outcome', 'onerror');
    await expect(noConnect).toContainText('was denied for this script');

    const mismatch = page.locator('#log li[data-script="connect-mismatch"]');
    await expect(mismatch).toHaveAttribute('data-outcome', 'onerror');
    await expect(mismatch).toContainText('was denied for this script');

    // The allowed script must NOT see a denial. It may onload
    // (network reachable) or onerror with a non-policy error
    // (network unreachable in CI), but the substring must not appear.
    const allowed = page.locator('#log li[data-script="connect-allowed"]');
    await expect(allowed).not.toContainText('was denied for this script');

    await page.close();
  });
});
