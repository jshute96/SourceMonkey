// The Log pane's Save and Copy buttons.
//
// The CSV rendering itself is covered by tests/unit/log-format.test.mjs.
// What needs a browser is the wiring: that Save reaches a save dialog
// (and a plain download where there is none) carrying that text under
// the script's own name, that Copy reports success rather than
// silently failing, and that neither offers to hand out an empty log.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import type { SmApi } from '../fixtures/sw-api';

// Fixed timestamps so the expected rows can be spelled out. Local time
// (the pane's spelling), built from a local-time Date.
const AT = new Date(2026, 7, 5, 14, 3, 22, 17).getTime();

// What both buttons hand out for the log `installWithLog` seeds:
// header row, then the entries newest-first, matching the table.
const EXPECTED_CSV = [
  'Time,Status,Source,Message',
  `"2026-08-05 14:03:23.017",error,"tab 4 · script-wrapper","Boom, it ""broke"""`,
  '"2026-08-05 14:03:22.017",info,manual-refresh,Loaded',
  '',
].join('\n');

test.describe('log export', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // The clipboard grant in the Copy test lands on the worker-scoped
  // context, so without this it would persist for every later test
  // sharing that worker — and which tests those are is
  // scheduling-dependent under parallelism.
  test.afterEach(async ({ extensionContext }) => {
    await extensionContext.clearPermissions();
  });

  async function installWithLog(sm: SmApi): Promise<string> {
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'LogExport', match: ['https://example.com/*'] },
      body: "console.log('hi');",
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const collections = await sm.getCollections();
    const scriptId = collections.flatMap((s) => s.scriptIds)[0];

    // Clear first: installing already logs, and the assertions below
    // name every row of the exported file. The read is what drains the
    // append queue (see `_flushScriptLogQueueForTests`) — a fire-and-
    // forget append still in flight would land after the clear.
    await sm.getScriptLog(scriptId);
    await sm.clearScriptLog(scriptId);
    await sm.appendScriptLog(scriptId, {
      level: 'info', source: 'manual-refresh', message: 'Loaded', timestamp: AT,
    });
    await sm.appendScriptLog(scriptId, {
      level: 'error', source: 'script-wrapper', tabId: 4,
      message: 'Boom, it "broke"', timestamp: AT + 1000,
    });
    return scriptId;
  }

  test('Save offers a save dialog, named after the script, holding the CSV', async ({
    extensionContext, extensionId, sm,
  }) => {
    const scriptId = await installWithLog(sm);
    const page = await extensionContext.newPage();
    // The real picker is a native dialog Playwright can't drive, so the
    // API is stubbed and its arguments captured. What that leaves under
    // test is everything on our side of it: the suggested name, the
    // bytes written, and that the click reaches the picker at all
    // rather than silently downloading.
    await page.addInitScript(() => {
      (window as unknown as { __picked?: { name?: string; written: string[] } }).__picked =
        { written: [] };
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker =
        async (options: { suggestedName?: string }) => {
          const picked = (window as unknown as {
            __picked: { name?: string; written: string[] };
          }).__picked;
          picked.name = options.suggestedName;
          return {
            createWritable: async () => ({
              write: async (data: string) => { picked.written.push(data); },
              close: async () => {},
            }),
          };
        };
    });
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('#log-pane table')).toBeVisible();

    const saveBtn = page.locator('.log-toolbar button', { hasText: /^Save/ });
    await saveBtn.click();
    await expect(saveBtn).toHaveText('Saved');

    const picked = await page.evaluate(() => (window as unknown as {
      __picked: { name?: string; written: string[] };
    }).__picked);
    // `main.user.js` → `main.log`: the script's log ID with the
    // userscript extension swapped out.
    expect(picked.name).toMatch(/^main#E\d+\.log$/);
    expect(picked.written).toEqual([EXPECTED_CSV]);

    await page.close();
  });

  test('Cancelling the save dialog writes nothing', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The branch that matters most: a cancelled dialog must not fall
    // through to the download path, which would drop the file the user
    // just declined into their downloads folder.
    const scriptId = await installWithLog(sm);
    const page = await extensionContext.newPage();
    await page.addInitScript(() => {
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker =
        async () => { throw new DOMException('The user aborted a request.', 'AbortError'); };
    });
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('#log-pane table')).toBeVisible();

    let downloads = 0;
    page.on('download', () => { downloads++; });
    const saveBtn = page.locator('.log-toolbar button', { hasText: /^Save/ });
    await saveBtn.click();

    // Nothing downloaded, and nothing claimed: a cancel is not a
    // failure to report either.
    await expect(saveBtn).toHaveText('Save');
    expect(downloads).toBe(0);

    await page.close();
  });

  test('A failed write is reported rather than silently re-downloaded', async ({
    extensionContext, extensionId, sm,
  }) => {
    const scriptId = await installWithLog(sm);
    const page = await extensionContext.newPage();
    await page.addInitScript(() => {
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker =
        async () => ({
          createWritable: async () => { throw new DOMException('nope', 'NotAllowedError'); },
        });
    });
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('#log-pane table')).toBeVisible();

    let downloads = 0;
    page.on('download', () => { downloads++; });
    const saveBtn = page.locator('.log-toolbar button', { hasText: /^Save/ });
    await saveBtn.click();

    await expect(saveBtn).toHaveText('Save failed');
    // The user already chose a destination; a download elsewhere would
    // be a second file they never asked for.
    expect(downloads).toBe(0);

    await page.close();
  });

  test('Save falls back to a plain download where there is no picker', async ({
    extensionContext, extensionId, sm,
  }) => {
    const scriptId = await installWithLog(sm);
    const page = await extensionContext.newPage();
    // Headless Chromium has `showSaveFilePicker`, so the fallback only
    // becomes reachable once it's taken away — which is the shape of
    // the browsers that lack it.
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('#log-pane table')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.log-toolbar button', { hasText: 'Save' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^main#E\d+\.log$/);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(EXPECTED_CSV);

    await page.close();
  });

  test('Copy puts the same CSV on the clipboard, and both actions go quiet on an empty log', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Without this the clipboard write sits pending on a permission
    // prompt headless Chrome never shows.
    await extensionContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    const scriptId = await installWithLog(sm);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await expect(page.locator('#log-pane table')).toBeVisible();

    const copyBtn = page.locator('.log-toolbar button', { hasText: /^Cop/ });
    await copyBtn.click();
    // Asserted first, because the label reverts after ~1.2s. It reads
    // "Copy failed" when the write is refused, so it is a real report
    // and not a fixed label.
    await expect(copyBtn).toHaveText('Copied');
    // Polled rather than read once: the write is async, and the click
    // returns before it lands.
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(EXPECTED_CSV);

    // Nothing to hand out once the log is empty.
    await page.locator('.log-toolbar button', { hasText: 'Clear log' }).click();
    await expect(page.locator('.log-empty')).toBeVisible();
    await expect(page.locator('.log-toolbar button', { hasText: 'Save' })).toBeDisabled();
    await expect(page.locator('.log-toolbar button', { hasText: /^Copy/ })).toBeDisabled();

    await page.close();
  });
});
