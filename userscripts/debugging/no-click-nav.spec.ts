// Spec for no-click-nav.user.js, on made-up pages at example.test.
//
// The script's label sits in a closed shadow root, which Playwright's
// locators can't reach, so `inLabel` reads it over CDP (Chrome DevTools
// Protocol): `DOM.getDocument` with `pierce` lists closed shadow roots too.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { test, expect } from '../../lib/harness/index.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-click-nav.user.js');
const ORIGIN = 'https://example.test';

const pageHtml = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title></head>
<body style="margin:0">
  <h1>${title}</h1>
  <p><a id="to-two" href="/two" style="display:inline-block;padding:20px">Go to two</a></p>
  <p id="plain" style="padding:20px">Plain text</p>
</body></html>`;

type CdpNode = { nodeName: string; backendNodeId: number; children?: CdpNode[]; shadowRoots?: CdpNode[] };

// Runs `fn` on the script's shadow root and returns its result.
async function inLabel<T>(page: Page, fn: string): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: CdpNode };
    const find = (n: CdpNode): CdpNode | undefined => {
      if (n.nodeName === 'SM-NO-CLICK-NAV') return n.shadowRoots?.[0];
      for (const c of n.children ?? []) { const hit = find(c); if (hit) return hit; }
      return undefined;
    };
    const shadow = find(root);
    if (!shadow) throw new Error('The script\'s label is not on the page');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId!, functionDeclaration: fn, returnByValue: true,
    });
    return result.value as T;
  } finally {
    await cdp.detach();
  }
}

const badgeText = (page: Page) =>
  inLabel<string>(page, 'function () { return this.getElementById("badge").textContent; }');

async function hoverBack(page: Page) {
  const box = await inLabel<{ x: number; y: number }>(page, `function () {
    const r = this.getElementById('back').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }`);
  await page.mouse.move(box.x, box.y);
}

test.describe('no-click-nav', () => {
  test.beforeEach(async ({ page, loadUserscript }) => {
    await page.route(/^https?:\/\/example\.test\//, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'home';
      return route.fulfill({ contentType: 'text/html', body: pageHtml(name) });
    });
    await page.clock.install();
    await loadUserscript(SCRIPT, { url: `${ORIGIN}/one` });
    await page.goto(`${ORIGIN}/one`);
    await expect.poll(() => badgeText(page)).toContain('Hover a link 2s');
    await page.mouse.move(400, 400);
  });

  test('hovering a link for 2s follows it', async ({ page, reports }) => {
    await page.hover('#to-two');
    await expect.poll(() => badgeText(page)).toBe(`Following ${ORIGIN}/two in 2s`);
    await page.clock.runFor(1000);
    await expect.poll(() => badgeText(page)).toBe(`Following ${ORIGIN}/two in 1s`);
    expect(page.url()).toBe(`${ORIGIN}/one`);
    await page.clock.runFor(1000);
    await page.waitForURL(`${ORIGIN}/two`);
    expect(reports.errors()).toEqual([]);
  });

  test('moving off the link cancels the countdown', async ({ page }) => {
    await page.hover('#to-two');
    await expect.poll(() => badgeText(page)).toContain('in 2s');
    await page.hover('#plain');
    await expect.poll(() => badgeText(page)).toContain('Hover a link 2s');
    await page.clock.runFor(3000);
    expect(page.url()).toBe(`${ORIGIN}/one`);
  });

  test('hovering Back goes back, and moving off it cancels', async ({ page }) => {
    await page.goto(`${ORIGIN}/two`);
    await expect.poll(() => badgeText(page)).toContain('Hover a link 2s');
    await hoverBack(page);
    await expect.poll(() => badgeText(page)).toBe('Going back in 2s');
    await page.mouse.move(400, 400);
    await expect.poll(() => badgeText(page)).toContain('Hover a link 2s');
    await page.clock.runFor(3000);
    expect(page.url()).toBe(`${ORIGIN}/two`);

    await hoverBack(page);
    await expect.poll(() => badgeText(page)).toBe('Going back in 2s');
    await page.clock.runFor(2000);
    await page.waitForURL(`${ORIGIN}/one`);
  });

  test('Alt-C follows the hovered link after 3s, even off the link', async ({ page }) => {
    await page.hover('#to-two');
    await page.keyboard.press('Alt+c');
    await expect.poll(() => badgeText(page)).toBe(`Following ${ORIGIN}/two in 3s`);
    // A key's countdown survives moving off the link.
    await page.hover('#plain');
    await page.clock.runFor(2000);
    await expect.poll(() => badgeText(page)).toBe(`Following ${ORIGIN}/two in 1s`);
    await page.clock.runFor(1000);
    await page.waitForURL(`${ORIGIN}/two`);
  });

  test('Alt-B goes back after 3s', async ({ page }) => {
    await page.goto(`${ORIGIN}/two`);
    await expect.poll(() => badgeText(page)).toContain('Hover a link 2s');
    await page.keyboard.press('Alt+b');
    await expect.poll(() => badgeText(page)).toBe('Going back in 3s');
    await page.clock.runFor(2000);
    expect(page.url()).toBe(`${ORIGIN}/two`);
    await page.clock.runFor(1000);
    await page.waitForURL(`${ORIGIN}/one`);
  });

  test('Alt-L asks for a URL and opens it after 3s', async ({ page }) => {
    let offered = '';
    page.once('dialog', async (dialog) => {
      offered = dialog.defaultValue();
      await dialog.accept('example.test/three');
    });
    await page.keyboard.press('Alt+l');
    // With no hovered link, the prompt offers the current URL.
    await expect.poll(() => offered).toBe(`${ORIGIN}/one`);
    // A URL without a scheme gets http:// added.
    await expect.poll(() => badgeText(page)).toBe('Opening http://example.test/three in 3s');
    // Cancelling the prompt does nothing.
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.keyboard.press('Alt+l');
    await page.clock.runFor(3000);
    await page.waitForURL('http://example.test/three');
  });
});
