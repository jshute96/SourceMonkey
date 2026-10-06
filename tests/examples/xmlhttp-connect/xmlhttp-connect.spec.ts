// E2E coverage for the xmlhttp-connect example.
//
// Each of the three userscripts adds a row of buttons to the page,
// one per target site, and logs each request's outcome with
// `data-script` / `data-target` / `data-outcome` attributes.
//
// The spec answers every connection prompt with Deny, and stays
// offline: the "This page" target is the local fixture server, and
// requests to the example sites are answered by a route stub (which
// sees the extension's own fetches too). The stub also records what
// it was asked for, so the spec can check a denied request never
// left the browser.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/manager';
import { connectDeniedMessage } from '../../../lib/gm-connect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Click one script's button for one target and return its log entry.
async function send(page: Page, script: string, target: string) {
  await page.locator(`#scripts section[data-script="${script}"] button[data-target="${target}"]`).click();
  const entry = page.locator(`#log li[data-script="${script}"][data-target="${target}"]`);
  await expect(entry).toHaveCount(1, { timeout: 15_000 });
  return entry;
}

test.describe('examples / xmlhttp-connect', () => {
  test('@connect: the own site and declared sites go, other sites ask, and Deny blocks them', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    // TM's and VM's @connect UX both differ from SourceMonkey's: TM
    // prompts in its own way, VM doesn't check at all, and each has
    // its own messages. The prompt window and the denial message this
    // test drives are SM-only.
    test.skip(setup.manager !== 'sourcemonkey', `${setup.manager} uses its own @connect UX (prompts, different message)`);

    await setup.installScriptsFrom(__dirname);

    const sent: string[] = [];
    await extensionContext.route(/^https:\/\/example\.(com|org|net)\//, (route) => {
      sent.push(new URL(route.request().url()).hostname);
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'stub' });
    });

    extensionContext.on('page', (p) => {
      if (!p.url().includes('connect-prompt.html')) return;
      void p.locator('#deny').click().catch(() => undefined);
    });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/xmlhttp-connect/xmlhttp-connect.html`);
    await expect(page.locator('#scripts section')).toHaveCount(3);

    // The page's own site needs no @connect.
    await expect(await send(page, 'connect-none', 'self')).toHaveAttribute('data-outcome', 'onload');

    // Undeclared sites ask, and the spec denies them: nothing is sent.
    for (const [script, host] of [['connect-none', 'example.org'], ['connect-example-com', 'example.net']]) {
      const entry = await send(page, script, host);
      await expect(entry).toHaveAttribute('data-outcome', 'onerror');
      await expect(entry).toContainText(connectDeniedMessage(host));
    }
    expect(sent).toEqual([]);

    // A declared site, and any site under `@connect *`, goes without
    // asking.
    await expect(await send(page, 'connect-example-com', 'example.com')).toHaveAttribute('data-outcome', 'onload');
    await expect(await send(page, 'connect-any', 'example.org')).toHaveAttribute('data-outcome', 'onload');
    expect(sent).toEqual(['example.com', 'example.org']);

    await page.close();
  });
});
