// Selecting another copy from the versions panel navigates IN PAGE:
// the URL and everything below the panel change, the page does not
// reload, and the table itself holds still — same rows, same sections,
// same order, only the highlight moves.
//
// Also covers where the panel now SITS (above the controls row) and the
// preview's merged "already installed" box, both of which the same
// layout change produced.
//
// See docs/script-viewer.md, "Switching copies in place".

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts } from '../fixtures/sw-api';
import { LOCATION_ROW } from '../fixtures/viewer-selectors';

const PANEL = '#other-versions';
const ROWS = `${PANEL} tbody tr`;
const NS = 'https://example.com/ns';

test.describe('switching copies from the versions panel', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  function write(relativePath: string, body: string, version: string): string {
    return dir.write({
      relativePath,
      meta: {
        name: 'Twin Script',
        match: ['https://example.com/*'],
        extra: [`// @namespace   ${NS}`, `// @version     ${version}`],
      },
      body,
    });
  }

  // Two copies of one script at different paths — the second section's
  // case, which is where a re-anchor would be visible. Returns the
  // stored rows and the viewer open on the first.
  async function twoCopies(
    extensionContext: { newPage: () => Promise<Page> },
    extensionId: string,
    sm: Parameters<typeof allScripts>[0],
  ): Promise<{ page: Page; first: { id: string }; second: { id: string }; paths: string[] }> {
    const a = write('a.user.js', 'console.log("copy A");\n', '1.0.0');
    const b = write('b.user.js', 'console.log("copy B");\n', '2.0.0');
    await sm.addCollection(a);
    await sm.addCollection(b);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const first = scripts.find((s) => s.relativePath === a)!;
    const second = scripts.find((s) => s.relativePath === b)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${first.id}`);
    await expect(page.locator(ROWS)).toHaveCount(2);
    return { page, first, second, paths: [a, b] };
  }

  test('the panel sits above the controls row and the details panel', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page } = await twoCopies(extensionContext, extensionId, sm);
    // Document order, so a future edit can't quietly put the panel back
    // under the details panel.
    const order = await page.evaluate(() => {
      const ids = ['filename', 'other-versions', 'meta-row', 'header-summary', 'tabs'];
      return ids
        .map((id) => ({ id, el: document.getElementById(id)! }))
        .sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map((e) => e.id);
    });
    expect(order).toEqual(['filename', 'other-versions', 'meta-row', 'header-summary', 'tabs']);
    await page.close();
  });

  test('a Location link swaps the script below without reloading the page', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);

    // Survives an in-page navigation, dies on a reload — this is what
    // makes the assertion below about "no page load" mean something.
    await page.evaluate(() => { (window as unknown as { __alive?: number }).__alive = 1; });

    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-location`).click();

    // The URL moved to the copy that was picked...
    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));
    // ...and so did everything below the panel.
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');
    await expect(page.locator('#content')).toContainText('copy B');
    // The heading announces the new copy wherever focus parks on it —
    // a Back, or a reload — and the two copies share an `@name`, so
    // what it announces has to carry the location the visible text
    // drops.
    await expect(page.locator('h1#filename'))
      .toHaveAttribute('aria-label', /Twin Script, .*b\.user\.js$/);
    expect(await page.evaluate(
      () => (window as unknown as { __alive?: number }).__alive,
    )).toBe(1);

    await page.close();
  });

  test('the table keeps its sections and order; only the highlight moves', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);
    const rowIds = (p: Page): Promise<(string | undefined)[]> =>
      p.locator(ROWS).evaluateAll((rows: Element[]) =>
        rows.map((r) => (r as HTMLElement).dataset.scriptId));
    const orderBefore = await rowIds(page);

    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-location`).click();
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');

    // Anchored on the script the page was opened with: `b` is still
    // filed under "a different URL", not promoted to "This URL".
    expect(await rowIds(page)).toEqual(orderBefore);
    await expect(page.locator(PANEL)).toContainText('Same script from a different URL');

    // The highlight, and the "(this page)" marker with it, moved.
    await expect(page.locator(`${PANEL} tr.is-current`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} tr.is-current`))
      .toHaveAttribute('data-script-id', second.id);
    // No cell in the table is a link to a copy any more — the row is
    // what opens one.
    await expect(page.locator(`${PANEL} td.col-location a`)).toHaveCount(0);
    await expect(page.locator(`${ROWS}[data-script-id="${first.id}"]`))
      .toHaveClass(/is-navigable/);

    await page.close();
  });

  test('clicking the row body selects that copy', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);

    // The Version cell: no link, no control, just text in the row.
    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-version`).click();

    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');
    await expect(page.locator(`${PANEL} tr.is-current`))
      .toHaveAttribute('data-script-id', second.id);
    // The row it moved off is navigable again; the one it landed on
    // isn't, since it leads nowhere.
    await expect(page.locator(`${ROWS}[data-script-id="${second.id}"]`))
      .not.toHaveClass(/is-navigable/);

    await page.close();
  });

  test('the row\'s own controls still win over the row', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);
    const other = `${ROWS}[data-script-id="${second.id}"]`;

    // The enable checkbox toggles that copy and does NOT navigate.
    await page.locator(`${other} td.col-enabled input[type=checkbox]`).click();
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await expect(page.locator(LOCATION_ROW)).toContainText('a.user.js');

    // Nor does the Collection cell's link out to the collections page.
    // That one opens the collections page's named tab beside this one
    // (src/extension/page-links.ts), so the viewer is left showing the copy it
    // was already showing rather than the row that was clicked.
    const [collections] = await Promise.all([
      extensionContext.waitForEvent('page'),
      page.locator(`${other} .versions-collection-name`).click(),
    ]);
    await collections.waitForURL(/collections\.html/);
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await collections.close();

    await page.close();
  });

  test('the Refresh button in a same-URL row does not select it', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two rows at ONE URL — the only rows that carry a refetch button,
    // and so the only place this can be checked.
    const a = write('a.user.js', 'console.log("copy A");\n', '1.0.0');
    await sm.addCollection(dir.path);   // the folder
    await sm.addCollection(a);          // the same file, on its own
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === a)!;
    const inFolder = scripts.find((s) => s.relativePath === 'a.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${standalone.id}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    await page.locator(`${ROWS}[data-script-id="${inFolder.id}"] td.col-actions button`).click();
    await expect(page).toHaveURL(new RegExp(`script=${standalone.id}`));
    await expect(page.locator(`${PANEL} tr.is-current`))
      .toHaveAttribute('data-script-id', standalone.id);

    await page.close();
  });

  test('a preview\'s rows are not click-to-select', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, paths } = await twoCopies(extensionContext, extensionId, sm);
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(paths[0])}`,
    );
    await expect(page.locator(ROWS)).toHaveCount(3);
    // A preview has no script of its own to swap out — its links
    // navigate for real, and nothing pretends the row is clickable.
    await expect(page.locator(`${PANEL} tr.is-navigable`)).toHaveCount(0);

    await page.close();
  });

  test('Enter on a focused row selects that copy', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);

    // The row is the tab stop the Location link used to be.
    await page.locator(`${ROWS}[data-script-id="${second.id}"]`).focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');

    await page.close();
  });

  test('the selected row keeps focus, as the current row', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);

    // Standing on a row and picking it should leave the user standing
    // on it — not send them back to the heading to tab down again.
    await page.locator(`${ROWS}[data-script-id="${second.id}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));

    await expect(async () => {
      expect(await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          row: active?.tagName,
          id: active?.dataset.scriptId,
          current: active?.classList.contains('is-current'),
        };
      })).toEqual({ row: 'TR', id: second.id, current: true });
    }).toPass();

    await page.close();
  });

  test('a click keeps focus on the row too, and Back from elsewhere takes the heading', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);

    // Clicking a row focuses it — the row is a tab stop — so the same
    // rule applies as to Enter: the user is left standing on it.
    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-location`).click();
    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));
    await expect(page.locator(`${ROWS}[data-script-id="${second.id}"]`)).toBeFocused();

    // From outside the panel there is no place in it to keep, and Back
    // changes the whole page under a user who was not in the table.
    const enable = page.locator('#enable-checkbox');
    await enable.focus();
    // Settled before the Back: a panel repaint still in flight from the
    // click above restores focus to the row, which would make this
    // assert the previous case over again.
    await expect(enable).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await expect(page.locator('h1')).toBeFocused();

    await page.close();
  });

  test('a selection does not take focus back off something the user reached first', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);

    // Select, then land somewhere deliberately before the panel's
    // fire-and-forget paint gets there. The paint must leave it alone.
    await page.locator(`${ROWS}[data-script-id="${second.id}"]`).focus();
    await page.keyboard.press('Enter');
    await page.locator('#enable-checkbox').focus();

    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));
    await expect(page.locator('#enable-checkbox')).toBeFocused();
    // And it stays there once the paint has certainly landed.
    await expect(page.locator(`${PANEL} tr.is-current`))
      .toHaveAttribute('data-script-id', second.id);
    await expect(page.locator('#enable-checkbox')).toBeFocused();

    await page.close();
  });

  test('the current row is a tab stop, and activating it does nothing', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first } = await twoCopies(extensionContext, extensionId, sm);

    const current = page.locator(`${ROWS}[data-script-id="${first.id}"]`);
    await expect(current).toHaveClass(/is-current/);
    await expect(current).toHaveAttribute('tabindex', '0');
    // It is a plain `row` to a screen reader — no `role="link"` — since
    // there is nowhere for it to go.
    await expect(current).not.toHaveAttribute('role', 'link');

    await current.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await expect(current).toBeFocused();

    await page.close();
  });

  test('Up and Down walk the rows, landing on the row wherever they start', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);

    const focusedRow = () => page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const row = active?.closest('tr') as HTMLElement | null;
      return { id: row?.dataset.scriptId, onRow: active === row, tag: active?.tagName };
    });

    // Row to row.
    await page.locator(`${ROWS}[data-script-id="${first.id}"]`).focus();
    await page.keyboard.press('ArrowDown');
    expect(await focusedRow()).toEqual({ id: second.id, onRow: true, tag: 'TR' });
    await page.keyboard.press('ArrowUp');
    expect(await focusedRow()).toEqual({ id: first.id, onRow: true, tag: 'TR' });

    // Past the end, nothing moves.
    await page.keyboard.press('ArrowUp');
    expect(await focusedRow()).toEqual({ id: first.id, onRow: true, tag: 'TR' });

    // From a control inside a row, the walk still lands on the row —
    // not on that column's control in the next one, which for the
    // Collection cell's two links would be a coin toss.
    await page.locator(`${ROWS}[data-script-id="${first.id}"] input[type="checkbox"]`).focus();
    await page.keyboard.press('ArrowDown');
    expect(await focusedRow()).toEqual({ id: second.id, onRow: true, tag: 'TR' });

    await page.close();
  });

  test('Up and Down cross the two sections', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Three rows in two sections: one URL installed twice plus a
    // same-identity copy at another path. Arrowing between them crosses
    // from one section's table into the other's — separate tables, one
    // list to the user.
    const a = write('a.user.js', 'console.log("copy A");\n', '1.0.0');
    write('b.user.js', 'console.log("copy B");\n', '2.0.0');
    await sm.addCollection(dir.path);
    await sm.addCollection(a);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === a)!;
    const other = scripts.find((s) => s.relativePath === 'b.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${standalone.id}`);
    await expect(page.locator(ROWS)).toHaveCount(3);

    // Down from a control in the row just above the same-identity one.
    await page.evaluate((id) => {
      const rows = Array.from(document.querySelectorAll('#other-versions tbody tr'));
      const at = rows.findIndex((r) => (r as HTMLElement).dataset.scriptId === id);
      const above = rows[at - 1] as HTMLElement;
      above.querySelector<HTMLElement>('td.col-actions button')!.focus();
    }, other.id);

    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { tag: active?.tagName, id: active?.dataset.scriptId };
    })).toEqual({ tag: 'TR', id: other.id });

    await page.close();
  });

  test('Space on the current row does nothing, and does not scroll', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first } = await twoCopies(extensionContext, extensionId, sm);

    // The current row is a tab stop now, so Space reaches it — and left
    // to the browser it would scroll the page. Same assertion shape as
    // the navigable-row case: what the handler did with the event.
    await page.evaluate(() => {
      const w = window as unknown as { __defaulted?: boolean };
      window.addEventListener('keydown', (ev) => { w.__defaulted = ev.defaultPrevented; });
    });
    await page.locator(`${ROWS}[data-script-id="${first.id}"]`).focus();
    await page.keyboard.press(' ');

    expect(await page.evaluate(() => (window as unknown as { __defaulted?: boolean }).__defaulted))
      .toBe(true);
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));

    await page.close();
  });

  test('a modified arrow is left to the browser', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first } = await twoCopies(extensionContext, extensionId, sm);

    await page.locator(`${ROWS}[data-script-id="${first.id}"]`).focus();
    await page.keyboard.press('Control+ArrowDown');

    await expect(page.locator(`${ROWS}[data-script-id="${first.id}"]`)).toBeFocused();

    await page.close();
  });

  test('a preview has no walk, and the offer row is not arrowed into', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, paths } = await twoCopies(extensionContext, extensionId, sm);
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(paths[0])}`,
    );
    await expect(page.locator(ROWS)).toHaveCount(3);

    // Nothing to select here, so no row is a tab stop and there is
    // nothing for Up/Down to step between. In particular the walk can't
    // land in the offer row's collection <select>, where every further
    // arrow would silently re-target the install.
    await expect(page.locator(`${PANEL} tbody tr[tabindex]`)).toHaveCount(0);

    const box = page.locator(`${ROWS} input[type="checkbox"]:not([disabled])`).first();
    await box.focus();
    await page.keyboard.press('ArrowDown');
    await expect(box).toBeFocused();

    await page.close();
  });

  test('a selection whose row never arrives falls back to the heading', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);

    // Remove the copy out from under the selection — each copy here is
    // its own single-file collection — so the table the paint draws has
    // no row to restore to.
    const collections = await sm.getCollections();
    const holder = collections.find((c) => c.scriptIds.includes(second.id))!;

    await page.locator(`${ROWS}[data-script-id="${second.id}"]`).focus();
    await page.keyboard.press('Enter');
    await sm.removeCollection(holder.id);
    await sm.syncNow();

    // Either the panel came back without the row or the page went to
    // "Not available"; both are the fallback's job.
    await expect(page.locator('h1')).toBeFocused();

    await page.close();
  });

  test('the location tooltip carries the full path, and nothing when it would repeat itself', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A directory collection stores the path under its root, so the
    // cell shows a fragment and the tooltip completes it.
    write('a.user.js', 'console.log("copy A");\n', '1.0.0');
    const standalone = write('b.user.js', 'console.log("copy B");\n', '1.0.0');
    await sm.addCollection(dir.path);
    await sm.addCollection(standalone);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const inFolder = scripts.find((s) => s.relativePath === 'a.user.js')!;
    const onItsOwn = scripts.find((s) => s.relativePath === standalone)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${inFolder.id}`);
    await expect(page.locator(ROWS)).toHaveCount(3);

    const cell = (id: string): string => `${ROWS}[data-script-id="${id}"] td.col-location span`;
    await expect(page.locator(cell(inFolder.id)))
      .toHaveAttribute('title', `${dir.path}/a.user.js`);
    // The standalone copy already shows its whole path, so a tooltip
    // would only repeat the cell.
    await expect(page.locator(cell(onItsOwn.id))).not.toHaveAttribute('title', /./);

    await page.close();
  });

  test('a modified click is left to the browser, and opens a new tab', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);

    // Ctrl/Cmd-click on the row means "that copy, but not here". The
    // Location cell is plain text now, so the row is what has to carry
    // the gesture.
    const opened = extensionContext.waitForEvent('page');
    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-version`).click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`script=${second.id}`));

    // ...and this page stayed where it was.
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await expect(page.locator(LOCATION_ROW)).toContainText('a.user.js');

    await tab.close();
    await page.close();
  });

  test('Back returns to the copy the page was opened with', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);
    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-location`).click();
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await expect(page.locator(LOCATION_ROW)).toContainText('a.user.js');
    await expect(page.locator('#content')).toContainText('copy A');

    await page.close();
  });

  test('a Status link lands on the other copy\'s Log tab', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);
    await page.locator(`${PANEL} td.col-status a[href*="${second.id}"]`).click();

    await expect(page).toHaveURL(new RegExp(`script=${second.id}#Log`));
    await expect(page.locator('#log-pane')).toBeVisible();

    await page.close();
  });

  test('the removed anchor hands the table over to the copy on screen', async ({
    extensionContext, extensionId, sm,
  }) => {
    // THREE copies, so the re-anchor has something to prove: with two,
    // deleting one leaves a lone self-row that the suppression rule
    // empties either way.
    const a = write('a.user.js', 'console.log("copy A");\n', '1.0.0');
    const b = write('b.user.js', 'console.log("copy B");\n', '2.0.0');
    const c = write('c.user.js', 'console.log("copy C");\n', '3.0.0');
    await sm.addCollection(a);
    await sm.addCollection(b);
    await sm.addCollection(c);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const anchor = scripts.find((s) => s.relativePath === a)!;
    const shown = scripts.find((s) => s.relativePath === b)!;
    const third = scripts.find((s) => s.relativePath === c)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${anchor.id}`);
    await expect(page.locator(ROWS)).toHaveCount(3);
    await page.locator(`${ROWS}[data-script-id="${shown.id}"] td.col-location`).click();
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');
    // Still filed around `a`: the copy on screen is in the second
    // section, and `a` alone is under "This URL".
    await expect(page.locator(`${PANEL} .versions-this-page`)).toHaveCount(1);

    // Delete the copy the table was anchored to, from its own trash can.
    await page.locator(`${ROWS}[data-script-id="${anchor.id}"] td.col-remove button`).click();
    await expect(page.locator(ROWS)).toHaveCount(2);

    // Re-anchored on the copy on screen: it is now the "This URL"
    // section's own row rather than a stranger in the second section.
    const sections = await page.locator(`${PANEL} .versions-section-heading`)
      .evaluateAll((els) => els.map((e) => e.textContent?.split('(')[0].trim()));
    expect(sections).toEqual(['This URL', 'Same script from a different URL']);
    const firstSectionRow = page.locator(`${PANEL} table`).first().locator('tbody tr');
    await expect(firstSectionRow).toHaveCount(1);
    await expect(firstSectionRow).toHaveAttribute('data-script-id', shown.id);
    await expect(page.locator(`${ROWS}[data-script-id="${third.id}"]`)).toHaveCount(1);
    await expect(page.locator(LOCATION_ROW)).toContainText('b.user.js');

    await page.close();
  });

  test('a middle click opens the copy in a new tab', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);

    const opened = extensionContext.waitForEvent('page');
    await page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-version`)
      .click({ button: 'middle' });
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`script=${second.id}`));
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));

    await tab.close();
    await page.close();
  });

  test('Space activates a focused row without scrolling the page', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, second } = await twoCopies(extensionContext, extensionId, sm);
    // Bubble phase, so it runs AFTER the panel's own listener and sees
    // whether that called preventDefault — which is what stops Space
    // paging the document down under the navigation.
    await page.evaluate(() => {
      const w = window as unknown as { __spacePrevented?: boolean };
      window.addEventListener('keydown', (ev) => {
        if (ev.key === ' ') w.__spacePrevented = ev.defaultPrevented;
      });
    });
    await page.locator(`${ROWS}[data-script-id="${second.id}"]`).focus();
    await page.keyboard.press(' ');

    await expect(page).toHaveURL(new RegExp(`script=${second.id}`));
    expect(await page.evaluate(
      () => (window as unknown as { __spacePrevented?: boolean }).__spacePrevented,
    )).toBe(true);

    await page.close();
  });

  test('a click that ends a text selection does not select the copy', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, first, second } = await twoCopies(extensionContext, extensionId, sm);
    const cell = page.locator(`${ROWS}[data-script-id="${second.id}"] td.col-location`);
    const box = (await cell.boundingBox())!;

    // Drag across the path, then let go — the user is copying text.
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
    await expect(page).toHaveURL(new RegExp(`script=${first.id}`));
    await expect(page.locator(LOCATION_ROW)).toContainText('a.user.js');

    await page.close();
  });

  test('a warning about an installed preview lands inside the green box', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Installed AND unparseable. The parse check's warning is APPENDED
    // beside the "already installed" line rather than replacing it —
    // the script really is installed, and that is still the page's
    // subject — so the merged card stays and the warning sits in it.
    const broken = dir.write({
      relativePath: 'broken.user.js',
      meta: {
        name: 'Broken Script',
        match: ['https://example.com/*'],
        extra: ['// @namespace   https://ex/ns', '// @version     1.0.0'],
      },
      body: 'function (\n',
    });
    await sm.addCollection(broken);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(broken)}`,
    );

    await expect(page.locator('#banner-slot')).toContainText('This script is already installed.');
    await expect(page.locator('#banner-slot')).toContainText('syntax error');
    // Two banners in the slot: the green line, and the warning in its
    // own amber box beneath it.
    await expect(page.locator('#banner-slot .banner')).toHaveCount(2);
    await expect(page.locator('#status-box.merged')).toHaveCount(1);
    // …and the table is in the box with them, as it is for any other
    // already-installed preview.
    await expect(page.locator('#status-box.merged #other-versions')).toBeVisible();

    await page.close();
  });

  test('the preview draws the banner and the table as one box', async ({
    extensionContext, extensionId, sm,
  }) => {
    const { page, paths } = await twoCopies(extensionContext, extensionId, sm);
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(paths[0])}`,
    );

    // One line, and the table inside the same box under it — which is
    // why the banner no longer points "below" and the panel drops its
    // own heading.
    await expect(page.locator('#banner-slot'))
      .toHaveText('This script is already installed. Select which instance to update or install.');
    await expect(page.locator('#status-box.merged')).toHaveCount(1);
    await expect(page.locator('#status-box.merged #other-versions')).toBeVisible();
    await expect(page.locator(`${PANEL} h2`)).toHaveCount(0);

    await page.close();
  });

  test('a preview of a file installed nowhere gets no merged box', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('lonely.user.js', 'console.log("lonely");\n', '1.0.0');
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(path)}`,
    );

    await expect(page.locator('#install-callout')).toBeVisible();
    await expect(page.locator('#status-box.merged')).toHaveCount(0);

    await page.close();
  });
});
