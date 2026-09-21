// Ctrl-A on the viewer selects the file content (or the Log table)
// rather than the whole page, so Ctrl-A, Ctrl-C copies the script from
// wherever focus happens to be.

import fs from 'node:fs';

import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('viewer select-all', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  async function openViewer(extensionContext: BrowserContext, extensionId: string, scriptId: string) {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    await expect(page.locator('#content')).not.toHaveText(/^Loading/);
    return page;
  }

  function selectedText(page: Page): Promise<string> {
    return page.evaluate(() => window.getSelection()?.toString() ?? '');
  }

  test('selects exactly the file from anywhere on the page', async ({
    extensionContext, extensionId, sm,
  }) => {
    const fullPath = scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'const x = 1;\n\tconsole.log(x);\n',
    });
    // `Selection.toString()` drops the file's final newline (a <pre>'s
    // trailing line break is not rendered text); a paste still ends
    // the last line.
    const source = fs.readFileSync(fullPath, 'utf8').replace(/\n$/, '');
    const collection = await sm.addCollection(scriptsDir.path);
    const got = await sm.getCollectionWithScripts(collection!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'a.user.js')!;
    const page = await openViewer(extensionContext, extensionId, script.id);

    // From inside the code box …
    await page.locator('#code-pane').click();
    await page.keyboard.press('ControlOrMeta+a');
    expect(await selectedText(page)).toBe(source);

    // … and from an unrelated spot — a details-row label — the same text.
    await page.locator('#header-summary dt').first().click();
    await page.keyboard.press('ControlOrMeta+a');
    expect(await selectedText(page)).toBe(source);

    await page.close();
  });

  test('on the Log tab selects the table, not the toolbar', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const got = await sm.getCollectionWithScripts(collection!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'b.user.js')!;
    await sm.appendScriptLog(script.id, { level: 'info', source: 'test', message: 'hello log' });
    const page = await openViewer(extensionContext, extensionId, script.id);

    await page.click('#tabs .tab:has-text("Log")');
    await expect(page.locator('#log-pane table')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+a');
    const text = await selectedText(page);
    expect(text).toContain('Time');
    expect(text).toContain('hello log');
    expect(text).not.toContain('Clear log');
    expect(text).not.toContain('Location');

    // Cleared, the pane has only its placeholder line — Ctrl-A takes
    // that rather than falling through to the whole page.
    await page.click('#log-pane button:has-text("Clear log")');
    await expect(page.locator('#log-pane .log-empty')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+a');
    const emptyText = await selectedText(page);
    expect(emptyText).toContain('No log entries yet');
    expect(emptyText).not.toContain('Clear log');
    expect(emptyText).not.toContain('Location');

    await page.close();
  });
});
