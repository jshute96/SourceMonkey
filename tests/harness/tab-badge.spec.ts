// The favicon badge `sm-dev run` puts on the tabs it controls: the
// script count in the extension's toolbar-badge colors, the site's own
// icon underneath, and grey once the run lets go of the tab.

import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';
import { attachPage } from '../../lib/harness/inject.js';
import { badgeState } from '../../lib/harness/tab-badge.js';
import { BADGE_GREEN, BADGE_GREY, BADGE_ORANGE, BADGE_RED } from '../../lib/tab-status.js';

// What the badge shows, as `<count> <color>`, from the icon link it adds.
function badge(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('link[data-sm-badge]')?.getAttribute('data-sm-badge') ?? null);
}

// The color of one pixel of the badge's icon, as `r,g,b,a`.
function pixel(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(async ([px, py]) => {
    const href = (document.querySelector('link[data-sm-badge]') as HTMLLinkElement | null)?.href;
    if (!href) return 'none';
    const img = new Image();
    img.src = href;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(px, py, 1, 1).data.join(',');
  }, [x, y] as const);
}

// A page on another origin than the fixture server, with the server's
// wide SVG as its icon, so the icon has to come through the run.
async function pageWithIcon(page: Page, iconBase: string): Promise<void> {
  await page.route('http://badge.sm-test.invalid/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<html><head><link rel="icon" href="${iconBase}/wide-icon.svg"></head><body>page</body></html>`,
  }));
  await page.goto('http://badge.sm-test.invalid/page.html');
}

const RED_PIXEL = '255,0,0,255';

test('a controlled tab shows its script count, turns red on an error, and grey when released', async ({ page, fixtureServer, attachment, loadScript }) => {
  await attachment.showBadge();
  await loadScript({
    relativePath: 'fine.user.js',
    meta: { name: 'Fine', match: ['*://*/target.html', '*://*/other.html'], grant: ['none'] },
    body: `console.log('fine');`,
  });
  await loadScript({
    relativePath: 'thrower.user.js',
    meta: { name: 'Thrower', match: ['*://*/other.html'], grant: ['none'] },
    body: `throw new Error('boom');`,
  });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect.poll(() => badge(page)).toBe(`1 ${BADGE_GREEN}`);

  await page.goto(`${fixtureServer.baseUrl}/other.html`);
  await expect.poll(() => badge(page)).toBe(`2 ${BADGE_RED}`);

  await attachment.dispose();
  await expect.poll(() => badge(page)).toBe(`2 ${BADGE_GREY}`);
});

test('a controlled tab with no scripts shows 0', async ({ page, fixtureServer, attachment }) => {
  await attachment.showBadge();
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect.poll(() => badge(page)).toBe(`0 ${BADGE_GREEN}`);
});

test('the badge goes grey by itself when the pings stop', async ({ page, fixtureServer, attachment }) => {
  // One ping at the start, and none after: a run killed outright.
  await attachment.showBadge({ pingMs: 600000, staleMs: 1500 });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect.poll(() => badge(page)).toBe(`0 ${BADGE_GREEN}`);
  await expect.poll(() => badge(page), { timeout: 5000 }).toBe(`0 ${BADGE_GREY}`);
});

test('the site\'s cross-origin icon is drawn under the badge, fitted, and its link set aside', async ({ page, fixtureServer, attachment }) => {
  await attachment.showBadge();
  await pageWithIcon(page, fixtureServer.baseUrl);
  await expect.poll(() => badge(page)).toBe(`0 ${BADGE_GREEN}`);
  // The wide icon keeps its shape: red across the middle, clear above.
  expect(await pixel(page, 4, 12)).toBe(RED_PIXEL);
  expect(await pixel(page, 4, 2)).toBe('0,0,0,0');
  // Only the badge is an icon now; the site's link is still there.
  expect(await page.evaluate(() => [...document.querySelectorAll('link')].map((l) => `${l.rel}${l.dataset.smBadge ? ' badge' : ''}`)))
    .toEqual(['sm-set-aside-icon', 'icon badge']);
});

test('site code that sets "the" icon link\'s href gets its icon drawn under the badge', async ({ page, fixtureServer, attachment }) => {
  await attachment.showBadge();
  await pageWithIcon(page, fixtureServer.baseUrl);
  await expect.poll(() => pixel(page, 4, 12)).toBe(RED_PIXEL);
  // What favicon-updating code does: find the icon link and set it.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 0, 32, 32);
    (document.querySelector('link[rel~="icon"]') as HTMLLinkElement).href = canvas.toDataURL();
  });
  await expect.poll(() => pixel(page, 4, 4)).toBe('0,0,255,255');
  expect(await badge(page)).toBe(`0 ${BADGE_GREEN}`);
});

test('without showBadge the site\'s icon is left alone', async ({ page, fixtureServer, attachment }) => {
  void attachment;
  await pageWithIcon(page, fixtureServer.baseUrl);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => [...document.querySelectorAll('link')].map((l) => l.rel))).toEqual(['icon']);
});

test('a later run taking over the tab gets one badge back to its colors, not redrawn over and over', async ({ page, fixtureServer, host, attachment }) => {
  await attachment.showBadge();
  await pageWithIcon(page, fixtureServer.baseUrl);
  await expect.poll(() => badge(page)).toBe(`0 ${BADGE_GREEN}`);
  await attachment.dispose();
  await expect.poll(() => badge(page)).toBe(`0 ${BADGE_GREY}`);

  const next = await attachPage(page, host);
  try {
    await next.showBadge();
    await expect.poll(() => badge(page)).toBe(`0 ${BADGE_GREEN}`);
    // Settled: one badge, still over the site's icon, and not redrawn.
    const redraws = await page.evaluate(() => new Promise<number>((resolve) => {
      let added = 0;
      new MutationObserver((records) => {
        for (const r of records) added += [...r.addedNodes].filter((n) => n instanceof HTMLLinkElement).length;
      }).observe(document.head, { childList: true });
      setTimeout(() => resolve(added), 2500);
    }));
    expect(redraws).toBe(0);
    expect(await page.evaluate(() => document.querySelectorAll('link[data-sm-badge]').length)).toBe(1);
    expect(await pixel(page, 4, 12)).toBe(RED_PIXEL);
  } finally {
    await next.dispose();
  }
});

test('badgeState: orange until expected scripts start, and a restored document keeps its own reports', async ({ host, loadScript }) => {
  const script = await loadScript({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: ['*://*/target.html'], grant: ['none'] },
    body: '',
  });
  const id = script.spec!.id;
  const link = { push: async () => undefined, url: () => 'http://x/target.html' };
  const doc = { url: 'http://x/target.html', spans: [[0, Infinity]] as [number, number][] };
  expect(badgeState(host, link, [script], doc)).toEqual({ count: 1, color: BADGE_ORANGE });
  await host.handle({ type: 'sm:start', id, name: 'A', url: doc.url }, link, 'isolated');
  expect(badgeState(host, link, [script], doc)).toEqual({ count: 1, color: BADGE_GREEN });
  // The start came during an earlier stretch of this document, before
  // it went into the back/forward cache: still counted.
  const at = host.reports.started[0].at;
  expect(badgeState(host, link, [script], { ...doc, spans: [[at, at + 1], [at + 1000, Infinity]] }).color).toBe(BADGE_GREEN);
  // A start from another document of the tab isn't this one's.
  expect(badgeState(host, link, [script], { ...doc, spans: [[at + 1, Infinity]] }).color).toBe(BADGE_ORANGE);
});
