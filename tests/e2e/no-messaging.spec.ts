// A tab whose isolated world can't message the extension (see
// src/extension/tab-messaging.ts). Here one document loads that way, with
// messaging turned off by `configureWorld` while it loads.
//   - The bridge answers each script's decision request at once, so
//     the script says why it didn't run instead of waiting out its
//     timeout, and says when a script that ran couldn't report it.
//   - The worker asks the tab once the document is parsed, and says so
//     for the whole page: a red badge, a tooltip line, and a popup
//     banner with Reload and Open in new tab. The rows keep their own
//     statuses (MISSING).
//   - The never-started check logs a transient error for each script,
//     which leaves no lasting ERROR on the collections page.

import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId, allScripts, hasBadgeColor, waitFor } from '../fixtures/sw-api';

const DID_NOT_RUN = 'Idle: Script did not run. SourceMonkey\'s isolated world in this tab has no messaging';
const RAN = 'Early: Script ran, but couldn\'t report status to SourceMonkey.';
const HEADING = 'SourceMonkey can\'t reach this tab\'s scripts.';
const NO_STATUS = 'SourceMonkey can\'t get script status';

test.describe('a tab with no messaging', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('scripts say what happened, and the page shows the error with its fixes', async ({
    extensionContext, extensionId, fixtureServer, sm, getServiceWorker,
  }) => {
    // The never-started check waits out the load plus the decision timeout.
    test.setTimeout(60_000);
    const base = fixtureServer.baseUrl;
    const url = `${base}/target.html`;
    scriptsDir.write({
      relativePath: 'main/idle.user.js',
      meta: { name: 'Idle', match: [url], grant: ['none'], runAt: 'document-idle' },
      body: `document.documentElement.dataset.ran = 'yes';`,
    });
    // On a first load, a document-start script runs without asking, so
    // only its start report is lost.
    scriptsDir.write({
      relativePath: 'main/early.user.js',
      meta: { name: 'Early', match: [url], grant: ['none'], runAt: 'document-start' },
      body: `document.documentElement.dataset.early = 'yes';`,
    });
    await sm.addCollection(path.join(scriptsDir.path, 'main'));
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const ids = ['idle.user.js', 'early.user.js'].map((f) => scripts.find((r) => r.relativePath.endsWith(f))!.id);
    const sw = await getServiceWorker();
    // After the tab opens: opening it has the worker check the world's
    // settings and put messaging back. It does so again at the commit,
    // too late for the document already loading, which keeps none, as a
    // stale tab does.
    const page = await extensionContext.newPage();
    await sw.evaluate(() => chrome.userScripts.configureWorld({ messaging: false }));
    try {
      const said: string[] = [];
      page.on('console', (m) => { said.push(m.text()); });
      const loadedAt = Date.now();
      await page.goto(url);
      // Well inside the 10s the script would otherwise wait.
      await waitFor(() => Promise.resolve(said.find((t) => t.includes(DID_NOT_RUN))), Boolean,
        { label: 'Idle says it did not run', timeoutMs: 5_000 });
      expect(Date.now() - loadedAt).toBeLessThan(5_000);
      await expect(page.locator('html')).not.toHaveAttribute('data-ran', 'yes');
      await expect(page.locator('html')).toHaveAttribute('data-early', 'yes');
      expect(said.filter((t) => t.includes(RAN))).toHaveLength(1);

      // The page-level error, well before the never-started check.
      const tabId = await activeTabId(getServiceWorker);
      const snap = await waitFor(() => sm.getTabState(tabId), (s) => s.title.includes(HEADING),
        { label: 'tooltip names the error', timeoutMs: 5_000 });
      expect(Date.now() - loadedAt).toBeLessThan(10_000);
      expect(hasBadgeColor(snap, '#d32f2f')).toBe(true);

      const popup = await extensionContext.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
      await expect(popup.locator('body[data-ready="true"]')).toBeAttached();
      const bar = popup.locator('.banner-row.no-messaging');
      await expect(bar.locator('strong')).toHaveText(HEADING);
      await expect(bar.locator('button')).toHaveText(['Reload', 'Open in new tab']);
      await expect(popup.locator('.banner-row.reload')).toHaveCount(0);

      // Open in new tab: the same URL, just to the right of the page.
      const opened = extensionContext.waitForEvent('page');
      await bar.locator('button', { hasText: 'Open in new tab' }).click();
      const copy = await opened;
      await copy.waitForURL(url);
      const [pageAt, copyAt] = await sw.evaluate(async ({ id, u }) => {
        const tabs = await chrome.tabs.query({});
        const at = tabs.find((t) => t.id === id)!;
        const other = tabs.find((t) => t.id !== id && t.url === u)!;
        return [[at.windowId, at.index], [other.windowId, other.index]];
      }, { id: tabId, u: url });
      expect(copyAt).toEqual([pageAt[0], pageAt[1] + 1]);
      await copy.close();
      await popup.close();

      // The never-started check, after the load and its grace period:
      // rows stay MISSING, and each Log gets a transient error, which
      // doesn't count toward the script's level.
      await waitFor(() => sm.getTabState(tabId), (s) => s.rows.includes('Idle | MISSING') && s.rows.includes('Early | MISSING'),
        { label: 'Idle and Early MISSING', timeoutMs: 30_000 });
      for (const id of ids) {
        await waitFor(() => sm.getScriptLog(id),
          (log) => log.some((e) => e.level === 'error' && e.transient === true && e.message.startsWith(NO_STATUS)),
          { label: 'a transient error in the Log', timeoutMs: 20_000 });
        expect(['info', undefined]).toContain(await sm.getMaxLogLevel(id));
      }
      await page.close();
    } finally {
      await sw.evaluate(() => chrome.userScripts.configureWorld({ messaging: true }));
    }
  });
});
