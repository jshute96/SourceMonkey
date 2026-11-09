// E2E coverage for the dialogs example, under each manager.
//
// Each button opens one kind of dialog box, and the script logs what it
// got back as `data-kind` / `data-result` on a `#log li`. Playwright
// answers the dialogs here, the way a person would in the browser.
// tests/harness/dialogs.spec.ts answers the same page with sm-dev's
// `dialog` command.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../../../tests/fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// What the newest log entry for `kind` shows.
const result = (page: Page, kind: string) => page.locator(`#log li[data-kind="${kind}"]`).first();

test.describe('examples / dialogs', () => {
  test('alert, confirm, prompt and Leave site reach the script, as answered', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/dialogs/dialogs.html`);
    await expect(page.locator('#runStatus')).toHaveClass(/ran/);

    // Each dialog is answered as it opens, in order.
    const answers: ((d: import('@playwright/test').Dialog) => Promise<void>)[] = [];
    const seen: string[] = [];
    page.on('dialog', (d) => {
      seen.push(`${d.type()}: ${d.message()}`);
      void answers.shift()?.(d);
    });

    answers.push((d) => d.accept());
    await page.click('#btn-alert');
    await expect(result(page, 'alert')).toHaveAttribute('data-result', 'closed');

    answers.push((d) => d.dismiss());
    await page.click('#btn-confirm');
    await expect(result(page, 'confirm')).toHaveAttribute('data-result', 'false');

    answers.push((d) => d.accept('Bob'));
    await page.click('#btn-prompt');
    await expect(result(page, 'prompt')).toHaveAttribute('data-result', 'Bob');

    answers.push((d) => d.accept(), (d) => d.dismiss());
    await page.click('#btn-two-confirms');
    await expect(result(page, 'two-confirms')).toHaveAttribute('data-result', 'true,false');

    expect(seen).toEqual([
      'alert: Hello from the dialogs example',
      "confirm: Delete the sample item?\n\nThis can't be undone.",
      'prompt: Your name?',
      'confirm: First of two: go on?',
      'confirm: Second of two: really?',
    ]);

    // Leave site, after a click on the page. Cancel keeps the page.
    await page.check('#leave');
    const leave = page.waitForEvent('dialog');
    void page.reload().catch(() => undefined);
    const dialog = await leave;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    // The page stayed: a reload would have cleared its log.
    await expect(result(page, 'two-confirms')).toHaveAttribute('data-result', 'true,false');
    await page.close();
  });

  test('a file chooser gets the files chosen', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/dialogs/dialogs.html`);
    await expect(page.locator('#runStatus')).toHaveClass(/ran/);

    const one = page.waitForEvent('filechooser');
    await page.click('#btn-file');
    const chooser = await one;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles({ name: 'a.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
    await expect(result(page, 'file')).toHaveAttribute('data-result', '1');
    await expect(result(page, 'file')).toContainText('a.json (7 bytes)');

    const many = page.waitForEvent('filechooser');
    await page.click('#btn-files');
    const multiple = await many;
    expect(multiple.isMultiple()).toBe(true);
    await multiple.setFiles([
      { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('bb') },
    ]);
    await expect(result(page, 'files')).toHaveAttribute('data-result', '2');
    await page.close();
  });

  test('a request to an undeclared site asks under SourceMonkey, and goes without asking under Violentmonkey', async ({ extensionContext, fixtureServer, setup }) => {
    // Tampermonkey asks on a page of its own that this test doesn't
    // drive, and refuses the request when nobody answers.
    test.skip(setup.manager === 'tampermonkey', 'Tampermonkey asks on its own page');
    await setup.installScriptsFrom(__dirname);
    const sent: string[] = [];
    await extensionContext.route('https://example.com/', (route) => {
      sent.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'stub' });
    });
    extensionContext.on('page', (p) => {
      if (p.url().includes('connect-prompt.html')) void p.locator('#deny').click().catch(() => undefined);
    });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/dialogs/dialogs.html`);
    await expect(page.locator('#runStatus')).toHaveClass(/ran/);
    await page.click('#btn-connect');
    if (setup.manager === 'sourcemonkey') {
      await expect(result(page, 'connect')).toHaveAttribute('data-result', 'onerror', { timeout: 15_000 });
      expect(sent).toEqual([]);
    } else {
      await expect(result(page, 'connect')).toHaveAttribute('data-result', 'onload', { timeout: 15_000 });
    }
    await page.close();
  });
});
