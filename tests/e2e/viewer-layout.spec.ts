// Viewer page height: the code box / Log pane take the viewport height
// left under the details panel and scroll inside it, but never drop
// below their minimum (`--code-box-min`, 20 lines). When a details
// panel is too tall to leave that much, the page itself scrolls — with
// `.page-main`'s bottom inset still below the box.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const VIEWPORT = { width: 1200, height: 800 };
const PAGE_INSET = 16;

test.describe('viewer layout', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  async function openViewer(
    extensionContext: import('@playwright/test').BrowserContext,
    extensionId: string,
    sm: { addCollection: (p: string) => Promise<unknown>;
          getCollectionWithScripts: (id: string) => Promise<{ scripts: { id: string }[] } | null> },
  ) {
    const collection = await sm.addCollection(scriptsDir.path) as { id: string };
    const id = (await sm.getCollectionWithScripts(collection.id))!.scripts[0].id;
    const page = await extensionContext.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${id}`);
    await page.waitForSelector('pre.code-box .token');
    return page;
  }

  const measure = (page: import('@playwright/test').Page, selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)!.getBoundingClientRect();
      const main = document.querySelector('.page-main')!.getBoundingClientRect();
      return {
        pageScrollHeight: document.scrollingElement!.scrollHeight,
        viewportHeight: innerHeight,
        height: el.height,
        bottom: el.bottom,
        mainBottom: main.bottom,
        minHeight: parseFloat(getComputedStyle(document.querySelector(sel)!).minHeight),
        innerHeight: (document.querySelector(sel) as HTMLElement).clientHeight
          - parseFloat(getComputedStyle(document.querySelector(sel)!).paddingTop)
          - parseFloat(getComputedStyle(document.querySelector(sel)!).paddingBottom),
        lineHeight: parseFloat(
          getComputedStyle(document.querySelector('pre.code-box > code') ?? document.body).lineHeight,
        ),
      };
    }, selector);

  test('a long script fills the viewport and scrolls inside the box', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'long.user.js',
      meta: { name: 'Long', match: ['https://a.example/*'] },
      body: Array.from({ length: 300 }, (_, i) => `// line ${i}`).join('\n'),
    });
    const page = await openViewer(extensionContext, extensionId, sm);

    const box = await measure(page, 'pre.code-box');
    expect(box.pageScrollHeight).toBe(box.viewportHeight);
    expect(box.bottom).toBeCloseTo(VIEWPORT.height - PAGE_INSET, 0);

    await page.click('#tabs .tab:has-text("Log")');
    const pane = await measure(page, '.log-pane');
    expect(pane.pageScrollHeight).toBe(pane.viewportHeight);
    expect(pane.bottom).toBeCloseTo(VIEWPORT.height - PAGE_INSET, 0);
    await page.close();
  });

  test('a tall details panel keeps the minimum and scrolls the page', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'tall.user.js',
      meta: {
        name: 'Tall',
        match: Array.from({ length: 60 }, (_, i) => `https://h${i}.example/*`),
      },
      body: Array.from({ length: 100 }, (_, i) => `// line ${i}`).join('\n'),
    });
    const page = await openViewer(extensionContext, extensionId, sm);

    const box = await measure(page, 'pre.code-box');
    expect(box.pageScrollHeight).toBeGreaterThan(box.viewportHeight);
    // Exactly the minimum: border-box, so it is the outer height — and
    // 20 lines of code fit inside it at the rendered line height.
    expect(box.height).toBeCloseTo(box.minHeight, 0);
    expect(box.innerHeight).toBeGreaterThanOrEqual(20 * box.lineHeight);
    // The Log pane mirrors it, so switching tabs doesn't reflow.
    await page.click('#tabs .tab:has-text("Log")');
    const pane = await measure(page, '.log-pane');
    expect(pane.height).toBeCloseTo(box.height, 0);
    // The page's bottom inset sits below the box, not lost above it.
    expect(box.mainBottom - box.bottom).toBeCloseTo(PAGE_INSET, 0);
    // scrollHeight is an integer; the rect is not.
    expect(Math.abs(box.mainBottom - box.pageScrollHeight)).toBeLessThanOrEqual(1);
    await page.close();
  });
});
