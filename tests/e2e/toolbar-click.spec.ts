// Toolbar-icon double click → collections page. Playwright can't click
// chrome.action, so these drive the same `openCollectionsPage` the
// onClicked listener calls on a double click, through the SW test
// surface. Single vs double click is covered in popup.spec.ts.
//
// What matters here is that a repeat click reuses the window's existing
// collections tab: the reuse lookup can't use chrome.tabs.query({url})
// (no permission covers the chrome-extension: scheme), and getting it
// wrong stacks up a new tab on every click.

import { test, expect } from '../fixtures/extension';
import type { Worker } from '@playwright/test';

// Collections tabs in `windowId`, counted from the SW's own view of its
// extension contexts.
async function collectionsTabsInWindow(
  getServiceWorker: () => Promise<Worker>,
  windowId: number,
): Promise<number> {
  const sw = await getServiceWorker();
  return await sw.evaluate(async (wid) => {
    const prefix = chrome.runtime.getURL('collections.html');
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.TAB],
    });
    return contexts.filter((ctx) => (
      ctx.windowId === wid && (ctx.documentUrl ?? '').startsWith(prefix)
    )).length;
  }, windowId);
}

test.describe('toolbar click', () => {
  test('a second click reuses the window\'s collections tab', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);

    const sw = await getServiceWorker();
    const windowId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.windowId ?? chrome.windows.WINDOW_ID_NONE;
    });
    expect(windowId).toBeGreaterThan(0);

    await sm.openCollectionsPage(windowId);
    await expect.poll(
      () => collectionsTabsInWindow(getServiceWorker, windowId),
      { message: 'one collections tab after the first click' },
    ).toBe(1);

    await sm.openCollectionsPage(windowId);
    // Poll again rather than reading once: a duplicate tab would need a
    // moment to register as a context, so a single immediate read could
    // pass on a bug.
    await expect.poll(
      () => collectionsTabsInWindow(getServiceWorker, windowId),
      { message: 'still one collections tab after the second click' },
    ).toBe(1);

    await page.close();
  });
});
