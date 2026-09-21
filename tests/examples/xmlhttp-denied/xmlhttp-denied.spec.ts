// E2E coverage for the xmlhttp-denied example.
//
// The three userscripts in this directory all auto-fire a single
// GM_xmlhttpRequest at http://127.0.0.1:1/ when they run. The
// spec only asserts on the @connect *policy* outcome, not on the
// network call itself — the policy gate runs in the SW before any
// fetch, so a denied request never leaves the browser; the allowed
// case still fires a real fetch but the loopback port refuses
// immediately, so we don't rely on external network.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / xmlhttp-denied', () => {
  test('@connect denial covers the no-connect and mismatched-host cases; @connect 127.0.0.1 lets the request through', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // TM's and VM's @connect UX both differ from SourceMonkey's: each
    // may prompt the user interactively before allowing the request,
    // and each has its own denial message — the "blocked by this
    // script's @connect rules" substring this test asserts is a SM-only
    // string. Skip on both and treat their behaviour as out-of-scope
    // here.
    test.skip(setup.manager !== 'sourcemonkey', `${setup.manager} uses its own @connect UX (prompts, different message)`);

    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/xmlhttp-denied/xmlhttp-denied.html`);

    // Wait for all three userscripts' results.
    await expect(page.locator('#log li[data-script="no-connect"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="connect-mismatch"]')).toHaveCount(1);
    await expect(page.locator('#log li[data-script="connect-allowed"]')).toHaveCount(1);

    // The two denied scripts should fire onerror with the policy
    // block message.
    // The no-@connect script is told its own way: it wrote no rules,
    // so the message names the missing header rather than blaming
    // rules it never declared.
    const noConnect = page.locator('#log li[data-script="no-connect"]');
    await expect(noConnect).toHaveAttribute('data-outcome', 'onerror');
    await expect(noConnect).toContainText('blocked because this script declares no @connect');

    const mismatch = page.locator('#log li[data-script="connect-mismatch"]');
    await expect(mismatch).toHaveAttribute('data-outcome', 'onerror');
    await expect(mismatch).toContainText("blocked by this script's @connect rules");

    // The allowed script must NOT see a policy block. It may onload
    // (network reachable) or onerror with a non-policy error
    // (network unreachable in CI), but the substring must not appear.
    const allowed = page.locator('#log li[data-script="connect-allowed"]');
    await expect(allowed).not.toContainText('blocked b');

    await page.close();
  });
});
