// Whole-pixel vertical metrics on the pages that show a column of
// checkboxes: collections, the viewer's "Other versions" panel, and
// Options. See docs/architecture.md, "Extension-page styling".
//
// Those pages' row and card heights used to be em-derived, so every row
// started at a different fractional offset and the 13px checkboxes
// rasterized a device pixel larger or smaller depending on which row
// they landed in — invisible to any assertion that doesn't measure.
//
// What each test pins is that one column's checkboxes share ONE offset,
// so they all rasterize alike. Collections and Options reach a whole
// pixel outright; the viewer's panel shares a fractional one, which is
// equally uniform (the cards above it are still em-derived).

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Fractional part of each matched element's top edge, in CSS pixels.
// Layout is in 1/64px, hence the rounding.
async function offsets(page: Page, selector: string): Promise<number[]> {
  return page.evaluate(
    (sel: string) =>
      Array.from(document.querySelectorAll(sel)).map(
        (el) => +(el.getBoundingClientRect().top % 1).toFixed(3),
      ),
    selector,
  );
}

// Copies of one script under one name+namespace, so the viewer's
// versions panel lists them all with an enable checkbox each.
function writeCopies(dir: ScriptsDir, count: number): void {
  for (let i = 0; i < count; i++) {
    dir.write({
      relativePath: `copy${i}/same.user.js`,
      meta: {
        name: 'Same Script',
        match: ['https://example.com/*'],
        extra: ['// @namespace   ns'],
      },
      body: 'console.log(1);\n',
    });
  }
}

test.describe('layout metrics', () => {
  let dirs: ScriptsDir[];
  test.beforeEach(() => { dirs = []; });
  test.afterEach(() => { for (const dir of dirs) dir.cleanup(); });

  function makeDir(): ScriptsDir {
    const dir = ScriptsDir.create();
    dirs.push(dir);
    return dir;
  }

  test('collections: every script checkbox sits at a whole-pixel offset', async ({
    sm,
    extensionId,
    extensionContext,
  }) => {
    // Two collections, so a fractional card height would show up as a
    // second offset rather than shifting the whole page uniformly.
    for (let d = 0; d < 2; d++) {
      const dir = makeDir();
      for (let i = 0; i < 4; i++) {
        dir.write({
          relativePath: `s${d}${i}.user.js`,
          meta: { name: `Script ${d}-${i}`, match: ['https://example.com/*'] },
          body: '// x\n'.repeat(i * 3),
        });
      }
    }
    // A name long enough to wrap, so a two-line row is covered too.
    dirs[0].write({
      relativePath: 'long.user.js',
      meta: {
        name: 'A deliberately very long script name that has to wrap onto a second line in the name column',
        match: ['https://example.com/*'],
      },
      body: '',
    });
    for (const dir of dirs) await sm.addCollection(dir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await page.waitForSelector('tbody .toggle input');

    const tops = await offsets(page, 'tbody .toggle input');
    expect(tops.length).toBeGreaterThan(5);
    expect(new Set(tops).size).toBe(1);
    expect(tops[0]).toBe(0);

    // The wrapped row is only coverage while it really wraps.
    const heights = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.getBoundingClientRect().height),
    );
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
    await page.close();
  });

  test('viewer: every versions-panel checkbox shares one offset', async ({
    sm,
    extensionId,
    extensionContext,
  }) => {
    const dir = makeDir();
    writeCopies(dir, 5);
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts as { id: string }[];

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${encodeURIComponent(scripts[0].id)}`,
    );
    await page.waitForSelector('#other-versions tbody input[type=checkbox]');

    const tops = await offsets(page, '#other-versions tbody input[type=checkbox]');
    expect(tops.length).toBeGreaterThan(3);
    expect(new Set(tops).size).toBe(1);
    await page.close();
  });

  test('options: the settings checkboxes sit at a whole-pixel offset', async ({
    extensionId,
    extensionContext,
    sm,
  }) => {
    void sm; // resets state between tests
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForSelector('.settings-row input[type=checkbox]');

    const tops = await offsets(page, '.settings-row input[type=checkbox]');
    expect(tops.length).toBeGreaterThan(1);
    expect(new Set(tops).size).toBe(1);
    expect(tops[0]).toBe(0);
    await page.close();
  });
});
