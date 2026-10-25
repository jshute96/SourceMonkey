// Coverage for the "User scripts are not allowed yet." banner on the
// collections page, and the popup's bar of the same name, driven by the real "Allow User Scripts" toggle on
// chrome://extensions.
//
// The fixture turns the toggle on in Preferences. Each test turns it off
// on the extension's details page, and back on before it ends: the
// browser is shared by the tests in a worker. Turning it off makes
// `chrome.userScripts` undefined in open pages too, and turning it on
// brings it back, without a reload.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { activeTabId, hasBadgeColor } from '../fixtures/sw-api';

const BANNER = 'User scripts are not allowed yet';

// The details page's switch. Playwright's CSS locators reach into its
// shadow roots.
// Returns `flip`, and `restore`, which turns it back on if it's off: the
// fixture's state, which later tests in the worker rely on. The row's
// state is its `checked` property.
async function openToggle(page: Page, extensionId: string): Promise<{ flip: () => Promise<void>; restore: () => Promise<void> }> {
  await page.goto(`chrome://extensions/?id=${extensionId}`);
  const toggle = page.locator('#allow-user-scripts');
  const isOn = (): Promise<boolean> => toggle.evaluate((e) => (e as HTMLElement & { checked: boolean }).checked);
  await expect.poll(isOn).toBe(true);
  const flip = async (): Promise<void> => {
    const was = await isOn();
    await toggle.click();
    await expect.poll(isOn).toBe(!was);
  };
  const restore = async (): Promise<void> => {
    if (!(await isOn())) await flip();
  };
  return { flip, restore };
}

// Headless tabs stay visible and focused, so send the event coming back
// would: `visibilitychange` from another tab, window `focus` from
// another window.
async function returnToTab(page: Page): Promise<void> {
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

async function returnToWindow(page: Page): Promise<void> {
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
}

// Some tests take the `sm` fixture without calling it: `sm` is what
// runs `resetAllState()` around each test.
test.describe('user-scripts banner', () => {
  test('shows the error and links to the extension settings', async ({
    extensionContext, extensionId, sm: _sm,
  }) => {
    const settings = await extensionContext.newPage();
    const { flip, restore } = await openToggle(settings, extensionId);
    try {
      await flip();
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);

      const banner = page.locator('#user-scripts-banner');
      await expect(banner).toContainText(BANNER);
      await expect(banner.locator('.banner-detail')).toHaveText(
        'Chrome reported: chrome.userScripts is not available',
      );
      await expect(banner.locator('p').last()).toHaveText(
        'Open extension settings and enable "Allow User Scripts" for SourceMonkey.',
      );
      // `chrome://` can't be an <a> navigation, so a handler opens it,
      // but the address still has to be the right one.
      await expect(banner.locator('a.chrome-text-link')).toHaveAttribute(
        'href', `chrome://extensions/?id=${extensionId}`,
      );
      await page.close();
    } finally {
      await restore();
      await settings.close();
    }
  });

  test('returning to the tab or window rechecks, and registers scripts once allowed', async ({
    extensionContext, extensionId, getServiceWorker, sm,
  }) => {
    const dir = ScriptsDir.create();
    const settings = await extensionContext.newPage();
    const { flip, restore } = await openToggle(settings, extensionId);
    try {
      await flip();
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const banner = page.locator('#user-scripts-banner');
      await expect(banner).toContainText(BANNER);

      // Added while the toggle is off: the worker's sync registers
      // nothing.
      dir.write({ relativePath: 'a.user.js', meta: { name: 'A', match: ['https://e.com/*'] }, body: 'void 0;' });
      await sm.addCollection(dir.path);
      // Run that sync now, before the toggle goes back on. `syncNow`
      // then fails reading back the registrations, which is expected
      // with the API gone.
      await expect(sm.syncNow()).rejects.toThrow('userScripts.getScripts');

      await flip();
      await returnToTab(page);
      await expect(banner).toHaveCount(0);
      // The page asked the worker to sync, so the script is registered
      // with no other change to set that off.
      const sw = await getServiceWorker();
      await expect.poll(() => sw.evaluate(async () => (
        (await chrome.userScripts.getScripts()).some((s) => s.js?.some((j) => j.code?.includes('void 0;')))
      ))).toBe(true);

      // And the banner comes back if the toggle is turned off again,
      // this time on returning from another window.
      await flip();
      await returnToWindow(page);
      await expect(banner).toContainText(BANNER);
      await page.close();
    } finally {
      await restore();
      await settings.close();
      dir.cleanup();
    }
  });

  test('a page loaded while disabled is red until they are enabled, then asks for a reload', async ({
    extensionContext, extensionId, fixtureServer, getServiceWorker, sm,
  }) => {
    // Registered first: turning the toggle off keeps registrations, and
    // turning it on brings them back.
    const dir = ScriptsDir.create();
    dir.write({ relativePath: 'a.user.js', meta: { name: 'Alpha', match: [`${fixtureServer.baseUrl}/*`] }, body: 'void 0;' });
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const settings = await extensionContext.newPage();
    const { flip, restore } = await openToggle(settings, extensionId);
    const openPopup = async (tabId: number): Promise<Page> => {
      const popup = await extensionContext.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
      await expect(popup.locator('body[data-ready="true"]')).toBeAttached();
      return popup;
    };
    try {
      await flip();
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      const tabId = await activeTabId(getServiceWorker);
      // Nothing was injected, and a reload wouldn't run anything yet:
      // Not loaded, a red badge saying why, and no reload asked for.
      await expect.poll(async () => (await sm.getTabState(tabId)).rows).toContain('Alpha | NOT_LOADED');
      let snap = await sm.getTabState(tabId);
      expect(hasBadgeColor(snap, '#d32f2f')).toBe(true);
      expect(snap.title).toContain('SourceMonkey\nUser scripts are not allowed yet.\nClick');
      let popup = await openPopup(tabId);
      expect(await popup.evaluate((req) => chrome.runtime.sendMessage(req)
        .then((v: { banner: string | null }) => v.banner), { type: 'sm:popup-view', tabId })).toBeNull();
      const pill = popup.locator('.row', { hasText: 'Alpha' }).locator('.pill');
      await expect(pill).toHaveText('Not loaded');
      await expect(pill).toHaveAttribute('title', /^Not run: user scripts are disabled\n/);
      const bar = popup.locator('.banner-row.user-scripts-off');
      await expect(bar).toHaveText(
        'User scripts are not allowed yet.Open extension settings and enable "Allow User Scripts" for SourceMonkey.',
      );
      await expect(bar.locator('a.chrome-text-link')).toHaveAttribute('href', `chrome://extensions/?id=${extensionId}`);
      await expect(popup.locator('.banner-row.reload')).toHaveCount(0);
      await popup.close();

      // Enabled, then back to the page: its badge is redrawn, purple.
      await flip();
      // Switched to from another tab, through Chrome's own API: a
      // Playwright `bringToFront` raises no `tabs.onActivated`.
      const other = await extensionContext.newPage();
      await (await getServiceWorker()).evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
      await expect.poll(async () => hasBadgeColor(await sm.getTabState(tabId), '#d500f9')).toBe(true);
      snap = await sm.getTabState(tabId);
      expect(snap.rows).toContain('Alpha | UNTRACKED');
      expect(snap.title).toContain('Page loaded while user scripts were disabled. Reload needed for 1 script.');
      popup = await openPopup(tabId);
      await expect(popup.locator('.banner-row.reload')).toContainText('Reload required: Page loaded while user scripts were disabled');
      await expect(popup.locator('.banner-row.user-scripts-off')).toHaveCount(0);
      await popup.close();

      await other.close();

      // And the reload runs it.
      await page.reload();
      await expect.poll(async () => (await sm.getTabState(tabId)).rows).toContain('Alpha | OK');
      await page.close();
    } finally {
      await restore();
      await settings.close();
      dir.cleanup();
    }
  });

  test('a page load puts back the user script world settings if Chrome lost them', async ({
    extensionContext, fixtureServer, getServiceWorker, sm,
  }) => {
    // A page-world script reaches the worker through the bridge, which
    // needs the world's messaging. Seen lost after user scripts were
    // disabled and enabled again, with registrations still in place:
    // then no script got its run decision, and none ran.
    const dir = ScriptsDir.create();
    dir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Alpha', match: [`${fixtureServer.baseUrl}/*`], grant: ['none'] },
      body: `document.documentElement.dataset.alpha = 'ran';`,
    });
    await sm.addCollection(dir.path);
    await sm.syncNow();
    const sw = await getServiceWorker();
    // Neither call is in this @types/chrome version yet.
    type WorldApi = { getWorldConfigurations(): Promise<unknown[]>; resetWorldConfiguration(): Promise<void> };
    const worlds = () => sw.evaluate(async () =>
      JSON.stringify(await (chrome.userScripts as unknown as WorldApi).getWorldConfigurations()));
    try {
      await sw.evaluate(() => (chrome.userScripts as unknown as WorldApi).resetWorldConfiguration());
      expect(await worlds()).toBe('[]');

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect.poll(() => worlds()).toContain('"messaging":true');
      // The load's own scripts may race the repair; the next load runs.
      await page.reload();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.alpha)).toBe('ran');
      await page.close();
    } finally {
      // Put the settings back should the repair have failed, for the
      // tests that follow in this worker.
      if (!(await worlds()).includes('"messaging":true')) {
        await sw.evaluate(() => chrome.userScripts.configureWorld({
          messaging: true, csp: "script-src 'self' 'unsafe-eval' 'unsafe-inline' *",
        }));
      }
      dir.cleanup();
    }
  });
});
