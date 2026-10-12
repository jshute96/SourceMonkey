// A GM value that can't be saved because storage is full puts an error
// on the script's Log, once, naming how full storage is.

import { expect, test } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM value saves on a full storage quota', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('a save refused for quota is logged on the script, once', async ({
    extensionContext, fixtureServer, getServiceWorker, sm,
  }) => {
    // Two writes of a 300 KB value, a moment apart.
    scriptsDir.write({
      relativePath: 'big.user.js',
      meta: {
        name: 'BigValue',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        GM_setValue('big', 'a'.repeat(300 * 1024));
        setTimeout(() => {
          GM_setValue('big', 'b'.repeat(300 * 1024));
          document.body.dataset.smDone = '1';
        }, 300);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = (await sm.getCollections()).flatMap((c) => c.scriptIds)[0];

    // Fill storage to within 100 KB of the quota.
    const sw = await getServiceWorker();
    await sw.evaluate(async () => {
      const used = await chrome.storage.local.getBytesInUse(null);
      const room = chrome.storage.local.QUOTA_BYTES - used - 100 * 1024;
      await chrome.storage.local.set({ 'test-filler': 'x'.repeat(room) });
    });

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '1');
    // Also waits for the failure's Log entry, which follows the save.
    await sm.gmValuesSaved();

    const errors = (await sm.getScriptLog(id)).filter((e) => e.source === 'gm-storage');
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe('error');
    expect(errors[0].message).toMatch(
      /^This script's stored values could not be saved, because SourceMonkey's storage is nearly full: \d+\.\d MB of 10 MB \(\d+%\)\. The values that could not be saved are kept only in memory, and will be lost\.$/,
    );
    expect(await sm.getMaxLogLevel(id)).toBe('error');
    await page.close();
  });
});
