// Shared helpers for the `.user.js` link capture, used by both capture
// specs (`install-capture.spec.ts` for http(s), `install-capture-file.spec.ts`
// for `file://`). The capture opens its preview in a tab of its own,
// beside the tab that navigated.

import { expect, type BrowserContext, type Page } from '@playwright/test';

// How long we wait on the tab's own navigation. See
// `startCapturedNavigation` for why this is bounded well under the
// 30s test timeout.
const CAPTURED_GOTO_TIMEOUT = 10_000;

// Point a tab at a captured `.user.js` URL.
//
// The tab's own navigation may not complete normally: the tab can be
// sent back or closed, or another manager can rewrite it, so `goto`'s
// result is ignored. Callers only want the navigation *started*; the
// assertion is about where the tabs end up.
//
// The bounded timeout is the point. An unbounded `goto` inherits the
// test timeout, so a navigation that hangs eats the whole budget and
// the test reports a bare "Test timeout of 30000ms exceeded", with no
// failing step. Capping it leaves room for the waits after it to fail
// with something a reader can act on. Abandoning the `goto` does not
// cancel the navigation.
export async function startCapturedNavigation(page: Page, url: string): Promise<void> {
  await page.goto(url, { timeout: CAPTURED_GOTO_TIMEOUT }).catch(() => {});
}

// Wait for a tab to show the preview and become interactive. Polls the
// URL rather than `waitForURL`, which can report an earlier navigation's
// failure in that tab.
export async function waitForInstallPrompt(page: Page): Promise<void> {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('userscript.html?preview=');
  await expect(page.locator('#preview-actions')).toBeVisible();
}

// Point `page` at a captured `.user.js` URL and return the tab the
// preview opens in, beside `page`, once the preview is ready.
export async function openCaptured(page: Page, url: string): Promise<Page> {
  const [preview] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }),
    startCapturedNavigation(page, url),
  ]);
  await waitForInstallPrompt(preview);
  return preview;
}

const isPreviewUrl = (url: string) => url.includes('userscript.html?preview=');

// Counts the preview tabs opened in `context` from now on. With
// `expectNoNewPreview`, checks a navigation the capture should stand
// down for (a bypass, or capture off).
export function trackNewPreviews(context: BrowserContext): () => number {
  const before = new Set(context.pages());
  return () => context.pages().filter((p) => !before.has(p) && isPreviewUrl(p.url())).length;
}

// The capture opens its preview in a tab of its own and leaves the tab
// that navigated alone for a second before sending it back, so standing
// down shows only after that: no preview opened, and `page` still on
// `url` (when given; a missing file lands on Chrome's error page).
export async function expectNoNewPreview(newPreviews: () => number, page: Page, url?: string): Promise<void> {
  await page.waitForTimeout(1500);
  expect(newPreviews()).toBe(0);
  if (url !== undefined) expect(page.url()).toBe(url);
}
