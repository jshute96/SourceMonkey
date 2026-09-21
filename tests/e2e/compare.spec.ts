// End-to-end coverage of the compare page (`compare.html`,
// src/compare.ts): two copies of a script, their header fields in one
// table and a diff per file.
//
// The diff itself is unit-tested (tests/unit/line-diff.test.mjs); what
// only a real run proves is that the page reads the right two copies
// out of the store, fetches a preview the way the preview page does,
// and that the swap and the view controls redraw what they should.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts } from '../fixtures/sw-api';

const ROWS = '#fields tbody tr';

test.describe('compare page', () => {
  let dir: ScriptsDir;
  let other: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); other = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); other.cleanup(); });

  const NS = 'https://example.com/ns';

  function write(into: ScriptsDir, opts: {
    version: string;
    body?: string;
    match?: string[];
    require?: string[];
  }): string {
    const extra = [`// @namespace   ${NS}`, `// @version     ${opts.version}`];
    for (const ref of opts.require ?? []) extra.push(`// @require     ${ref}`);
    return into.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Shared Script', match: opts.match ?? ['https://example.com/*'], extra },
      body: opts.body ?? 'console.log("hi");\n',
    });
  }

  function comparePage(extensionId: string, base: string, other: string): string {
    return `chrome-extension://${extensionId}/compare.html?script=${base}&other=${other}`;
  }

  // The field row with this label.
  function row(page: import('@playwright/test').Page, label: string) {
    return page.locator(ROWS).filter({ has: page.locator(`th:text-is("${label}")`) });
  }

  test('shows the two copies’ fields and a diff of the script', async ({
    extensionContext, extensionId, sm,
  }) => {
    write(dir, { version: '1.0.0', body: 'console.log("one");\nconsole.log("two");\n' });
    write(other, {
      version: '1.1.0',
      match: ['https://example.com/*', 'https://example.org/*'],
      body: 'console.log("one");\nconsole.log("TWO");\n',
    });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    await expect(page).toHaveTitle('Compare: Shared Script | SourceMonkey');
    await expect(page.locator('h1')).toHaveText('SourceMonkey | Compare | Shared Script');
    // The favicon slot, as the viewer's heading has it, painted from
    // the LEFT copy's @match sites: example.org among them here, and
    // not once a swap brings the older copy across. (By the tooltip,
    // not the icon count: two sites whose icons resolve the same are
    // folded into one icon naming both.)
    const icons = page.locator('h1 .site-icon');
    await expect(icons.locator('[title*="example.org"]')).not.toHaveCount(0);
    await page.locator('#swap').click();
    await expect(icons.locator('[title*="example.com"]')).not.toHaveCount(0);
    await expect(icons.locator('[title*="example.org"]')).toHaveCount(0);
    await page.locator('#swap').click();

    // The script the page was opened for on the left, the other copy
    // on the right, each named by its location.
    const sides = page.locator('#fields thead tr.side-location td.value');
    await expect(sides).toHaveCount(2);
    await expect(sides.nth(0)).toContainText(other.path);
    await expect(sides.nth(1)).toContainText(dir.path);
    // Two collections and two locations: both head rows are tinted.
    await expect(page.locator('#fields thead tr.side-collection')).toHaveClass(/\bdiffers\b/);
    await expect(page.locator('#fields thead tr.side-location')).toHaveClass(/\bdiffers\b/);

    // A row whose values differ is marked; one whose values agree is not.
    await expect(row(page, 'Name')).toHaveClass('same');
    await expect(row(page, 'Version')).toHaveClass('differs');
    await expect(row(page, 'Version').locator('td.value.left')).toHaveText('1.1.0');
    await expect(row(page, 'Version').locator('td.value.right')).toHaveText('1.0.0');
    // A list value marks the item the other side lacks.
    await expect(row(page, 'Match')).toHaveClass('differs');
    await expect(row(page, 'Match').locator('td.value.left li.only')).toHaveText('https://example.org/*');
    await expect(row(page, 'Match').locator('td.value.right li.only')).toHaveCount(0);
    // Neither declares a homepage, so there is no row for it.
    await expect(row(page, 'Homepage')).toHaveCount(0);

    // One tab, for the script itself, wearing its verdict.
    const tabs = page.locator('#tabs .tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText('hello.user.js');
    await expect(tabs.first().locator('.chip')).toHaveText('different');

    // Read left to right, the older copy dropped a match line and
    // changed the version and a body line: three out, two in. One hunk
    // — in a file this short the header change and the body change
    // are within context of each other.
    await expect(page.locator('.diff-counts')).toHaveText('−3 +2 lines');
    const unified = page.locator('table.diff.unified');
    await expect(unified.locator('tr.del')).toHaveCount(3);
    await expect(unified.locator('tr.add')).toHaveCount(2);
    await expect(unified.locator('tr.del').filter({ hasText: '1.1.0' })).toHaveCount(1);
    await expect(unified.locator('tr.add').filter({ hasText: '1.0.0' })).toHaveCount(1);
    await expect(unified.locator('tr.hunk')).toHaveCount(1);
    await page.close();
  });

  test('the view controls switch layout and scope, and are remembered', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A body long enough that the hunk's context does not reach its
    // end and the panes have something to scroll; the base also gains a line right under the header, so one
    // side has a line the other lacks.
    const body = Array.from({ length: 60 }, (_, i) => `console.log(${i});`).join('\n') + '\n';
    write(dir, { version: '1.0.0', body });
    write(other, { version: '1.1.0', body: 'setup();\n' + body });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    await expect(page.locator('table.diff.unified tr.hunk')).toHaveCount(1);
    const hunkRows = await page.locator('table.diff.unified tr').count();

    // Whole file: every line, no seams — more rows than the one hunk
    // had, and none of them a seam.
    await page.locator('.seg button[data-value="whole"]').click();
    await expect(page.locator('table.diff.unified tr.hunk')).toHaveCount(0);
    expect(await page.locator('table.diff.unified tr').count()).toBeGreaterThan(hunkRows);

    // Side by side: a pane per side with the same rows, the changed
    // line in one beside what replaced it in the other.
    await page.locator('.seg button[data-value="split"]').click();
    const panes = page.locator('.diff-body.split .pane');
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(0).locator('tr')).toHaveCount(await panes.nth(1).locator('tr').count());
    const leftRows = panes.nth(0).locator('tr');
    const rightRows = panes.nth(1).locator('tr');
    const at = (await leftRows.allTextContents()).findIndex((t) => t.includes('1.1.0'));
    await expect(leftRows.nth(at)).toHaveClass(/\bdel\b/);
    await expect(rightRows.nth(at)).toHaveClass(/\badd\b/);
    await expect(rightRows.nth(at)).toContainText('1.0.0');
    // The left side's `setup();` has a filler across from it, as tall
    // as a line, so the panes stay in step past it: the two tables are
    // the same height.
    const filler = panes.nth(1).locator('tr.filler');
    await expect(filler).toHaveCount(1);
    const height = (loc: import('@playwright/test').Locator) =>
      loc.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(await height(filler)).toBeGreaterThan(10);
    expect(await height(panes.nth(0).locator('table'))).toBe(await height(panes.nth(1).locator('table')));

    // The panes scroll together, and following one is not mistaken
    // for a later scroll of the user's own to the same place: after
    // right goes to 500 and back to 300, left is at 300 too.
    const scrollTo = async (which: 'left' | 'right', top: number) => {
      await page.locator(`.pane.${which}`).evaluate((el, y) => { el.scrollTop = y; }, top);
      // A scroll event is dispatched on the next frame; give the
      // follower its own frame after that.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    const tops = () => page.evaluate(() => [
      document.querySelector('.pane.left')!.scrollTop,
      document.querySelector('.pane.right')!.scrollTop,
    ]);
    await page.setViewportSize({ width: 1000, height: 400 });
    await scrollTo('left', 30);
    expect(await tops()).toEqual([30, 30]);
    await scrollTo('right', 50);
    expect(await tops()).toEqual([50, 50]);
    await scrollTo('right', 30);
    expect(await tops()).toEqual([30, 30]);

    // Both choices survive a reload.
    await page.reload();
    await expect(page.locator('.seg button[data-value="split"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('.seg button[data-value="whole"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('.diff-body.split tr.hunk')).toHaveCount(0);
    await page.close();
  });

  test('the swap button turns the comparison around', async ({
    extensionContext, extensionId, sm,
  }) => {
    write(dir, { version: '1.0.0' });
    write(other, { version: '1.1.0' });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    const sides = page.locator('#fields thead tr.side-location td.value');
    await expect(sides.nth(0)).toContainText(other.path);
    await page.locator('#swap').click();
    await expect(sides.nth(0)).toContainText(dir.path);
    await expect(sides.nth(1)).toContainText(other.path);
    await expect(row(page, 'Version').locator('td.value.left')).toHaveText('1.0.0');
    // The diff reads the other way now: 1.0.0 is what was removed.
    await expect(page.locator('table.diff tr.del')).toContainText('1.0.0');
    await expect(page.locator('table.diff tr.add')).toContainText('1.1.0');
    await page.close();
  });

  test('@require files get a tab each, paired by ref', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Both declare lib.js, with different contents; only the base
    // declares extra.js.
    dir.writeRaw('lib.js', 'window.__lib = 1;\n');
    other.writeRaw('lib.js', 'window.__lib = 2;\n');
    other.writeRaw('extra.js', 'window.__extra = true;\n');
    write(dir, { version: '1.0.0', require: ['lib.js'] });
    write(other, { version: '1.0.0', require: ['lib.js', 'extra.js'] });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    const tabs = page.locator('#tabs .tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0).locator('.chip')).toHaveText('different');
    await expect(tabs.nth(1)).toContainText('lib.js');
    await expect(tabs.nth(1).locator('.chip')).toHaveText('different');
    await expect(tabs.nth(2)).toContainText('extra.js');
    // Only the left side (the script the page is for) declares it.
    await expect(tabs.nth(2).locator('.chip')).toHaveText('removed');
    // The Require row lists the extra declaration as the left side's alone.
    await expect(row(page, 'Require').locator('td.value.left li.only')).toHaveText('extra.js');

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveClass(/\bactive\b/);
    await expect(page.locator('.diff-counts')).toHaveText('−1 +1 lines');
    await expect(page.locator('table.diff tr.del')).toContainText('__lib = 2');

    // A file only one side has is all removals — or, after a swap,
    // all additions.
    await tabs.nth(2).click();
    await expect(page.locator('.diff-counts')).toHaveText('−1 line');
    await expect(page.locator('table.diff tr.del')).toHaveCount(1);
    await page.locator('#swap').click();
    await expect(tabs.nth(2).locator('.chip')).toHaveText('added');
    await expect(tabs.nth(2)).toHaveClass(/\bactive\b/);
    await expect(page.locator('.diff-counts')).toHaveText('+1 line');
    await page.close();
  });

  test('@require files whose URLs moved are paired by basename', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The same library under two paths — as when a copy's libraries
    // moved from one host to another — with one line changed.
    dir.writeRaw('old/lib.js', 'window.__lib = 1;\nwindow.__more = 2;\n');
    other.writeRaw('new/lib.js', 'window.__lib = 1;\nwindow.__more = 3;\n');
    write(dir, { version: '1.0.0', require: ['old/lib.js'] });
    write(other, { version: '1.0.0', require: ['new/lib.js'] });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    const tabs = page.locator('#tabs .tab');
    // One lib.js tab, not an ADDED and a REMOVED.
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText('lib.js');
    await expect(tabs.nth(1).locator('.chip')).toHaveText('different');
    await tabs.nth(1).click();
    await expect(page.locator('.diff-counts')).toHaveText('\u22121 +1 lines');
    await page.close();
  });

  test('a basename declared twice on one side is not paired by name', async ({
    extensionContext, extensionId, sm,
  }) => {
    dir.writeRaw('a/util.js', 'window.__a = 1;\n');
    dir.writeRaw('b/util.js', 'window.__b = 1;\n');
    other.writeRaw('c/util.js', 'window.__a = 1;\n');
    write(dir, { version: '1.0.0', require: ['a/util.js', 'b/util.js'] });
    write(other, { version: '1.0.0', require: ['c/util.js'] });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    const chips = page.locator('#tabs .tab .chip');
    // Which util.js the left side's would pair with is a guess, so
    // none is made. (The scripts themselves differ in their @require
    // lines.)
    await expect(chips).toHaveText(['different', 'removed', 'added', 'added']);
    await page.close();
  });

  test('an identical file is shown once, with no differences', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The same lines; only the final newline differs, which the diff
    // does not count and so the chip must not either.
    dir.writeRaw('lib.js', 'window.__lib = 1;\nwindow.__more = 2;\n');
    other.writeRaw('lib.js', 'window.__lib = 1;\nwindow.__more = 2;');
    write(dir, { version: '1.0.0', require: ['lib.js'] });
    write(other, { version: '1.1.0', require: ['lib.js'] });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    const tabs = page.locator('#tabs .tab');
    await expect(tabs.nth(1).locator('.chip')).toHaveText('same');
    await tabs.nth(1).click();
    await expect(page.locator('.diff-counts')).toHaveText('No differences');
    // The whole file, as one copy, whatever the view says.
    await page.locator('.seg button[data-value="split"]').click();
    await expect(page.locator('table.diff.unified tr')).toHaveCount(2);
    await expect(page.locator('.diff-body.split')).toHaveCount(0);
    await expect(page.locator('table.diff tr.del, table.diff tr.add, table.diff tr.hunk')).toHaveCount(0);
    await page.close();
  });

  test('the arrows jump between change blocks and stop at the ends', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Three changes far enough apart that, whole file, each block is
    // its own screenful: the header's version line, then two body
    // lines. (The version differs in every test; here it is the first
    // block.)
    const lines = Array.from({ length: 300 }, (_, i) => `console.log(${i});`);
    const edited = [...lines];
    edited[100] = 'console.log("a");';
    edited[200] = 'console.log("b");';
    write(dir, { version: '1.0.0', body: lines.join('\n') + '\n' });
    write(other, { version: '1.1.0', body: edited.join('\n') + '\n' });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    await page.locator('.seg button[data-value="whole"]').click();
    await page.locator('.seg button[data-value="unified"]').click();
    const body = page.locator('.diff-body');
    const starts = body.locator('tr.block-start');
    await expect(starts).toHaveCount(3);
    const prev = page.locator('.diff-summary .block-prev');
    const next = page.locator('.diff-summary .block-next');
    // Each click lands the block's first row at the top of the box —
    // the first block too, a few header lines down from the top.
    // (Within a pixel: rows are 19.5px tall, so half the offsets are
    // fractional, and the box lands on a whole pixel.)
    const rowTop = (i: number) => starts.nth(i).evaluate((tr) => (tr as HTMLElement).offsetTop);
    const scrollTop = () => body.evaluate((el) => el.scrollTop);
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await next.click();
    expect(await scrollTop()).toBeCloseTo(await rowTop(0), 0);
    await expect(prev).toBeDisabled();
    await next.click();
    expect(await scrollTop()).toBeCloseTo(await rowTop(1), 0);
    await expect(prev).toBeEnabled();
    await next.click();
    expect(await scrollTop()).toBeCloseTo(await rowTop(2), 0);
    await expect(next).toBeDisabled();
    await prev.click();
    expect(await scrollTop()).toBeCloseTo(await rowTop(1), 0);
    await prev.click();
    expect(await scrollTop()).toBeCloseTo(await rowTop(0), 0);
    await expect(prev).toBeDisabled();
    // Scrolled by hand past the last block, Down has nowhere to go.
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();

    // Side by side the left pane is the one the arrows drive, and the
    // right follows it.
    await page.locator('.seg button[data-value="split"]').click();
    const left = page.locator('.diff-body .pane.left');
    const right = page.locator('.diff-body .pane.right');
    await expect(left.locator('tr.block-start')).toHaveCount(3);
    await page.locator('.diff-summary .block-next').click();
    const leftTop = await left.evaluate((el) => el.scrollTop);
    expect(leftTop).toBeGreaterThan(0);
    await expect.poll(() => right.evaluate((el) => el.scrollTop)).toBe(leftTop);
    await page.close();
  });

  test('a preview is fetched and compared as the base', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write(dir, { version: '1.0.0' });
    await sm.addCollection(dir.path);
    await sm.syncNow();
    const [installed] = await allScripts(sm);
    // The file moves on after it was stored.
    write(dir, { version: '1.0.1' });

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/compare.html?preview=${encodeURIComponent(path)}&other=${installed.id}`,
    );
    const sides = page.locator('#fields thead tr.side-location td.value');
    await expect(sides.nth(0)).toContainText(dir.path);
    await expect(page.locator('#fields thead tr.side-collection td.value').nth(1)).toHaveText('Not installed');
    await expect(sides.nth(1)).toContainText(path);
    await expect(row(page, 'Version').locator('td.value.left')).toHaveText('1.0.0');
    await expect(row(page, 'Version').locator('td.value.right')).toHaveText('1.0.1');
    await expect(page.locator('.diff-counts')).toHaveText('−1 +1 lines');
    await page.close();
  });

  test('Ctrl-A selects the diff on screen, or the pane focus is in', async ({
    extensionContext, extensionId, sm,
  }) => {
    write(dir, { version: '1.0.0' });
    write(other, { version: '1.1.0' });
    await sm.addCollection(dir.path);
    await sm.addCollection(other.path);
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const base = scripts.find((s) => s.fileUrl.includes(other.path))!;
    const older = scripts.find((s) => s.fileUrl.includes(dir.path))!;
    const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? '');

    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, base.id, older.id));
    // The view is remembered across pages, so start from a known one.
    await page.locator('.seg button[data-value="unified"]').click();
    await expect(page.locator('table.diff')).toBeVisible();
    // One pane: its lines, and nothing from the page around it — no
    // line numbers, no field labels.
    await page.keyboard.press('Control+a');
    let text = await selected();
    expect(text).toContain('@version     1.0.0');
    expect(text).toContain('@version     1.1.0');
    expect(text).not.toContain('Collection');
    expect(text).not.toMatch(/^\s*\d+\s/m);

    // Side by side with focus nowhere in particular: the left pane.
    await page.locator('.seg button[data-value="split"]').click();
    await page.locator('h1').click();
    await page.keyboard.press('Control+a');
    text = await selected();
    expect(text).toContain('1.1.0');
    expect(text).not.toContain('1.0.0');

    // Focus in the right pane: that pane.
    await page.locator('.pane.right').focus();
    await page.keyboard.press('Control+a');
    text = await selected();
    expect(text).toContain('1.0.0');
    expect(text).not.toContain('1.1.0');
    await page.close();
  });

  test('a copy that is gone is reported, not diffed', async ({
    extensionContext, extensionId, sm,
  }) => {
    write(dir, { version: '1.0.0' });
    await sm.addCollection(dir.path);
    await sm.syncNow();
    const [installed] = await allScripts(sm);
    const page = await extensionContext.newPage();
    await page.goto(comparePage(extensionId, installed.id, 'no-such-id'));
    await expect(page.locator('#message')).toHaveText('The other copy is no longer installed');
    await expect(page.locator('#message')).toHaveClass(/\berror\b/);
    await expect(page.locator('#tabs')).toBeHidden();
    await page.close();
  });
});
