// Shared waits for the `.user.js` link capture, used by both capture
// specs (`install-capture.spec.ts` for http(s), `install-capture-file.spec.ts`
// for `file://`). They drive the same two-leg navigation, so the waits
// live here rather than being written twice.

import { expect, type Page } from '@playwright/test';

// How long we are willing to sit in the aborted first leg. See
// `startCapturedNavigation` for why this is bounded well under the
// 30s test timeout.
const CAPTURED_GOTO_TIMEOUT = 10_000;

// Point a tab at a captured `.user.js` URL.
//
// The first leg never completes normally: the capture aborts it (or
// Chrome turns it into a download) and the tab is sent to the viewer's
// preview instead, so `goto` rejects with ERR_ABORTED. Callers only
// want the navigation *started* — the assertion is always about where
// the tab ends up, which `waitForInstallPrompt` covers.
//
// The bounded timeout is the point. An unbounded `goto` inherits the
// test timeout, so a first leg that hangs eats the whole budget and the
// test reports a bare "Test timeout of 30000ms exceeded" — no failing
// step, no expected-vs-actual. Capping it leaves room for the wait
// below to fail with something a reader can act on. Abandoning the
// `goto` does not cancel the navigation; the tab keeps going and the
// poll still sees it arrive.
export async function startCapturedNavigation(page: Page, url: string): Promise<void> {
  await page.goto(url, { timeout: CAPTURED_GOTO_TIMEOUT }).catch(() => {});
}

// Wait for the tab to land on the preview and become interactive.
//
// `page.waitForURL` rejects here: the captured navigation ends in
// net::ERR_ABORTED (Chrome was mid-download when the tab was pointed
// elsewhere), and Playwright surfaces that as the navigation's result
// even though the tab goes on to load the preview. Poll the tab's URL
// instead, then wait for the preview itself.
export async function waitForInstallPrompt(page: Page): Promise<void> {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('userscript.html?preview=');
  await expect(page.locator('#preview-actions')).toBeVisible();
}
