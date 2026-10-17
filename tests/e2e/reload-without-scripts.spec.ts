// "Reload page with no userscripts", from the popup's page menu, and
// its per-script forms "with only this script" / "without this script".
// One reload during which some or all wrappers on the tab are told to
// skip; the registrations stay put and the next ordinary reload runs
// them again. Drives the SW's `reloadWithoutScripts` test surface, and
// the popup's own reload message for the per-script forms.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts, waitFor, waitForTabState, activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const GREEN = '#2e7d32';
const GREY = '#757575';

test.describe('reload with no userscripts', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('skips every script once, then a plain reload runs them again', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // One script per gate that matters: document-start has no
    // lifecycle wait to hide behind, so the skip decision is its only
    // gate; document-end is the ordinary case.
    scriptsDir.write({
      relativePath: 'early.user.js',
      meta: { name: 'Early', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-start' },
      body: `document.documentElement.dataset.early = 'ran';`,
    });
    scriptsDir.write({
      relativePath: 'late.user.js',
      meta: { name: 'Late', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.title = 'late ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('late ran');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '2' && hasBadgeColor(s, GREEN),
      'green before the skip reload',
    );
    // The popup offers the reload on this tab.
    expect((await sm.getPopupView(tabId)).perScriptReload).toBe(true);

    await sm.reloadWithoutScripts(tabId);

    // Neither body ran on the reloaded document…
    await expect(page).toHaveTitle('target');
    expect(await page.evaluate(() => document.documentElement.dataset.early ?? null)).toBeNull();
    // …and the badge says so in grey, with the count intact, rather
    // than painting the scripts as MISSING.
    const snap = await waitForTabState(
      sm, tabId,
      (s) => hasBadgeColor(s, GREY)
        && s.rows.includes('Early | NOT_LOADED') && s.rows.includes('Late | NOT_LOADED'),
      'grey + NOT_LOADED after the skip reload',
    );
    expect(snap.badgeText).toBe('2');

    // The skip is recorded on each script's Log as information, not a
    // warning — the user asked for it.
    const late = (await allScripts(sm)).find((s) => s.relativePath === 'late.user.js')!;
    const entry = await waitFor(
      async () => (await sm.getScriptLog(late.id)).find((e) => e.message.includes('Did not run')),
      (e) => e != null,
      { label: 'abandoned Log entry' },
    );
    expect(entry!.level).toBe('info');
    expect(entry!.message).toBe('Did not run on this page (reload with no userscripts)');

    // One-shot: the next ordinary reload runs both scripts again.
    await page.reload();
    await expect(page).toHaveTitle('late ran');
    expect(await page.evaluate(() => document.documentElement.dataset.early)).toBe('ran');
    await waitForTabState(
      sm, tabId,
      (s) => s.badgeText === '2' && hasBadgeColor(s, GREEN) && s.rows.includes('Late | OK'),
      'green again after a plain reload',
    );
    await page.close();
  });

  test('with only this script, and without it', async ({
    extensionContext, fixtureServer, sm, getServiceWorker, extensionId,
  }) => {
    scriptsDir.write({
      relativePath: 'one.user.js',
      meta: { name: 'One', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.documentElement.dataset.one = 'ran';`,
    });
    scriptsDir.write({
      relativePath: 'two.user.js',
      meta: { name: 'Two', match: [`${fixtureServer.baseUrl}/*`], runAt: 'document-end' },
      body: `document.documentElement.dataset.two = 'ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const one = (await allScripts(sm)).find((s) => s.relativePath === 'one.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('One | OK') && s.rows.includes('Two | OK'), 'both ran');
    // Null while a reload is replacing the document, too.
    const ran = (key: string) => page.evaluate((k) => document.documentElement.dataset[k] ?? null, key).catch(() => null);

    // The popup page sends the reload, as a click in it would.
    const popup = await extensionContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    const reload = (mode: object) => popup.evaluate(
      (m) => chrome.runtime.sendMessage({ type: 'sm:popup-reload', tabId: Number(new URLSearchParams(location.search).get('tab')), mode: m }),
      mode,
    );

    await reload({ kind: 'only', scriptId: one.id });
    await expect.poll(() => ran('one')).toBe('ran');
    await waitForTabState(sm, tabId, (s) => s.rows.includes('One | OK') && s.rows.includes('Two | NOT_LOADED'), 'only One');
    expect(await ran('two')).toBeNull();
    // The popup says why Two didn't run.
    const kept = (await sm.getPopupView(tabId)).enabled.flatMap((g) => g.rows).find((r) => r.name === 'Two')!;
    expect(kept.status).toBe('NOT_LOADED');
    expect(kept.tooltip).toContain('Not run: the page was reloaded with only One');

    await reload({ kind: 'without', scriptId: one.id });
    await expect.poll(() => ran('two')).toBe('ran');
    await waitForTabState(sm, tabId, (s) => s.rows.includes('One | NOT_LOADED') && s.rows.includes('Two | OK'), 'all but One');
    expect(await ran('one')).toBeNull();

    // The skip is information in One's Log, as a skip asked for.
    const entry = await waitFor(
      async () => (await sm.getScriptLog(one.id)).find((e) => e.message.includes('reload without this userscript')),
      (e) => e != null,
      { label: 'without-this Log entry' },
    );
    expect(entry!.level).toBe('info');
    await popup.close();
    await page.close();
  });

  test('the popup lists nothing on a page no script matches', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'elsewhere.user.js',
      meta: { name: 'Elsewhere', match: ['https://example.invalid/*'], runAt: 'document-end' },
      body: ``,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const view = await sm.getPopupView(tabId);
    expect(view.enabled).toEqual([]);
    expect(view.disabled).toEqual([]);
    await page.close();
  });
});
