// E2E coverage for the gm-log userscript example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('examples / gm-log', () => {
  test('clicking the simple button emits a prefixed console line', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    const logged: string[] = [];
    page.on('console', (msg) => { logged.push(msg.text()); });

    await page.goto(`${fixtureServer.baseUrl}/gm-log/gm-log.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);

    await page.locator('#btn-simple').click();
    await expect(page.locator('#log')).toContainText('hello from a userscript');

    // The console line should carry SourceMonkey's per-script prefix
    // and the message we passed.
    await expect.poll(() =>
      logged.find((l) => l.includes('[SourceMonkey:') && l.includes('hello from a userscript')) ?? null
    ).not.toBeNull();

    await page.close();
  });
});
