// End-to-end coverage of the "Other versions" panel (`#other-versions`,
// src/related-versions.ts) and the lookup
// behind it (src/script-identity.ts).
//
// The unit tests cover the matching rules against fabricated rows;
// what only a real run can prove is that the absolute URLs the store
// actually writes line up — a directory collection's `fileUrl` really does
// canonicalize to the same string as a standalone install's, through
// the production scan + fetch pipeline.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts, type SmApi } from '../fixtures/sw-api';

const PANEL = '#other-versions';
const ROWS = `${PANEL} tbody tr`;

test.describe('other-versions panel', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  function write(relativePath: string, name: string, opts: {
    namespace?: string;
    version?: string;
  } = {}): string {
    const extra: string[] = [];
    if (opts.namespace) extra.push(`// @namespace   ${opts.namespace}`);
    if (opts.version) extra.push(`// @version     ${opts.version}`);
    return dir.write({
      relativePath,
      meta: { name, match: ['https://example.com/*'], extra },
      body: 'console.log("hi");\n',
    });
  }

  function viewer(scriptId: string): string {
    return `userscript.html?script=${encodeURIComponent(scriptId)}`;
  }

  // The case the whole feature exists for. The directory collection stores
  // `hello.user.js`; the standalone install stores the absolute path.
  // Only their `fileUrl`s agree, and this proves they do in production.
  test('a directory copy and a standalone copy of one file share a section', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script', { version: '1.0.0' });
    await sm.addCollection(dir.path);   // the folder
    await sm.addCollection(path);       // the same file, on its own
    await sm.syncNow();

    const scripts = await allScripts(sm);
    expect(scripts).toHaveLength(2);
    // Open the standalone copy specifically — `allScripts` returns
    // source order, so indexing blindly makes a failure hard to read.
    const standalone = scripts.find((s) => s.relativePath === path)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    await expect(page.locator(PANEL)).toContainText('Other versions of this script');
    await expect(page.locator(PANEL)).toContainText('This URL');
    await expect(page.locator(PANEL)).not.toContainText('different URL');
    await expect(page.locator(ROWS)).toHaveCount(2);

    // The row for the page we are on is marked, not linked.
    await expect(page.locator(`${PANEL} tr.is-current`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} .versions-this-page`)).toHaveText('(this page)');

    // Each row shows its OWN stored spelling — the directory copy stays
    // relative even though the match ran on the absolute form.
    const locations = await page.locator(`${PANEL} td.col-location`).allTextContents();
    expect(locations.some((t) => t.includes(path))).toBe(true);
    expect(locations.some((t) => t.trim().startsWith('hello.user.js'))).toBe(true);

    await page.close();
  });

  test('same @name and @namespace at different paths lands in the second section', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns, version: '1.0.0' });
    const b = write('b.user.js', 'Twin Script', { namespace: ns, version: '2.0.0' });
    await sm.addCollection(a);
    await sm.addCollection(b);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const first = scripts.find((s) => s.relativePath === a)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(first.id)}`);

    await expect(page.locator(PANEL)).toContainText('Same script from a different URL');
    await expect(page.locator(PANEL)).toContainText('same @name and @namespace');
    // One row per section: this page under "This URL", the twin below.
    await expect(page.locator(ROWS)).toHaveCount(2);
    await expect(page.locator(PANEL)).toContainText('2.0.0');

    // The other copy's row is what opens it — no link inside the cell,
    // which would only offer the row's own destination twice. See
    // versions-navigation.spec.ts for the navigation itself.
    const other = scripts.find((s) => s.relativePath === b)!;
    await expect(page.locator(`${ROWS}[data-script-id="${other.id}"]`))
      .toHaveClass(/is-navigable/);
    await expect(page.locator(`${PANEL} td.col-location a`)).toHaveCount(0);

    await page.close();
  });

  test('a different @namespace keeps two same-named scripts apart', async ({
    extensionContext, extensionId, sm,
  }) => {
    write('a.user.js', 'Twin Script', { namespace: 'https://one.example/' });
    write('b.user.js', 'Twin Script', { namespace: 'https://two.example/' });
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const first = scripts.find((s) => s.relativePath.endsWith('a.user.js'))!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(first.id)}`);
    // Nothing relates, so the panel stays empty and the :empty rule
    // hides it.
    await expect(page.locator(PANEL)).toBeHidden();
    await page.close();
  });

  test('the panel stays hidden when the only copy is the one on screen', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('lonely.user.js', 'Lonely Script');
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(scripts[0].id)}`);
    await expect(page.locator('#header-summary')).toContainText('Lonely Script');
    await expect(page.locator(PANEL)).toBeHidden();
    await page.close();
  });

  // Status is the column that says whether a copy actually works, and
  // it is the route to that copy's log.
  test('each row shows its status, linked to that copy\'s log', async ({
    extensionContext, extensionId, sm,
  }) => {
    const good = write('hello.user.js', 'Shared Script');
    // Same file installed twice — once through the folder, once on its
    // own — so both rows describe a script that loaded fine.
    await sm.addCollection(dir.path);
    await sm.addCollection(good);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === good)!;
    const inFolder = scripts.find((s) => s.id !== standalone.id)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    // Status sits between Location and Version; Content follows.
    const headings = await page.locator(`${PANEL} thead th`).allTextContents();
    expect(headings.slice(2, 6)).toEqual(['Location', 'Status', 'Version', 'Content']);

    const cell = page.locator(`${PANEL} tr[data-script-id="${inFolder.id}"] td.col-status a`);
    await expect(cell).toHaveText('OK');
    // Links to that copy's OWN log, not to the page we are standing on.
    await expect(cell).toHaveAttribute(
      'href', `userscript.html?script=${encodeURIComponent(inFolder.id)}#Log`,
    );
    await page.close();
  });

  // The Status column speaks for every copy, so it has to move when
  // another copy's log escalates — not only when this one's does.
  test('another copy\'s status updates without a reload', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const inFolder = scripts.find((s) => s.id !== standalone.id)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    const cell = page.locator(`${PANEL} tr[data-script-id="${inFolder.id}"] td.col-status a`);
    await expect(cell).toHaveText('OK');

    // The OTHER copy hits a runtime error while this page sits open.
    await sm.appendScriptLog(inFolder.id, {
      level: 'error',
      source: 'test',
      message: 'boom',
    });

    await expect(cell).toHaveText('ERROR');
    // This page's own row is about a different copy, so it stays put.
    await expect(
      page.locator(`${PANEL} tr[data-script-id="${standalone.id}"] td.col-status a`),
    ).toHaveText('OK');
    await page.close();
  });

  // The preview's panel is live too — its own listener branch runs
  // before the installed-script gate that the rest of the page's
  // storage handling sits behind.
  test('a preview\'s panel tracks another copy\'s status', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const inFolder = (await allScripts(sm))[0];
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    const cell = page.locator(`${PANEL} tr[data-script-id="${inFolder.id}"] td.col-status a`);
    await expect(cell).toHaveText('OK');

    await sm.appendScriptLog(inFolder.id, {
      level: 'warning',
      source: 'test',
      message: 'careful',
    });
    await expect(cell).toHaveText('WARNING');
    await page.close();
  });

  // A copy that can't run says so from the panel, without the user
  // having to open it.
  test('a broken copy reports its status in the panel', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const good = write('good.user.js', 'Twin Script', { namespace: ns });
    // Parses, carries the same identity, but declares no @match — so it
    // fails validation and lands `invalid`.
    const broken = dir.writeRaw(
      'broken.user.js',
      [
        '// ==UserScript==',
        '// @name        Twin Script',
        `// @namespace   ${ns}`,
        '// ==/UserScript==',
        '',
        'console.log("hi");',
        '',
      ].join('\n'),
    );
    await sm.addCollection(good);
    await sm.addCollection(broken);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const goodScript = scripts.find((s) => s.relativePath === good)!;
    const brokenScript = scripts.find((s) => s.relativePath === broken)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(goodScript.id)}`);
    const cell = page.locator(`${PANEL} tr[data-script-id="${brokenScript.id}"] td.col-status a`);
    await expect(cell).toHaveText('INVALID');
    // The hover text carries the REASON, not just any string: the
    // point of the column is that the user knows what to fix before
    // clicking through.
    await expect(cell).toHaveAttribute('title', /@match|@include/);
    await page.close();
  });

  // The offer row is not a copy: nothing has been loaded, registered,
  // or logged, so it has no status to report.
  test('the not-installed-yet offer row shows no status', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script', { version: '1.0.0' });
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} tr.is-offer td.col-status`)).toHaveText('\u2014');
    await expect(page.locator(`${PANEL} tr.is-offer td.col-status a`)).toHaveCount(0);
    await page.close();
  });

  test('the per-row toggle disables that copy and only that copy', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(scripts[0].id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    // Flip the row that is NOT the current page.
    const otherRow = page.locator(`${PANEL} tbody tr:not(.is-current)`);
    const otherId = await otherRow.getAttribute('data-script-id');
    await otherRow.locator('input[type=checkbox]').uncheck();

    await expect.poll(async () => {
      const all = await allScripts(sm);
      return all.find((s) => s.id === otherId)!.enabled;
    }).toBe(false);

    const all = await allScripts(sm);
    expect(all.find((s) => s.id !== otherId)!.enabled).not.toBe(false);
    await page.close();
  });

  // Two enabled copies of one script both register and both run, so
  // enabling one turns the rest off. Disabling is not exclusive —
  // "none of them" is an ordinary thing to want.
  test('enabling one copy disables the others; disabling one leaves them alone', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const other = scripts.find((s) => s.id !== standalone.id)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    const box = (id: string) =>
      page.locator(`${PANEL} tr[data-script-id="${id}"] input[type=checkbox]`);
    const enabledOf = async (id: string) =>
      (await allScripts(sm)).find((s) => s.id === id)!.enabled;

    // Turn this one off. The other must NOT be promoted in its place.
    await box(standalone.id).uncheck();
    await expect.poll(() => enabledOf(standalone.id)).toBe(false);
    expect(await enabledOf(other.id)).not.toBe(false);

    // Turn it back on: now the other one gives way.
    await box(standalone.id).check();
    await expect.poll(() => enabledOf(other.id)).toBe(false);
    expect(await enabledOf(standalone.id)).not.toBe(false);

    await page.close();
  });

  test('ctrl-click enables a copy without disabling the others', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const other = scripts.find((s) => s.id !== standalone.id)!;
    await sm.setScriptEnabled(other.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    await page
      .locator(`${PANEL} tr[data-script-id="${other.id}"] input[type=checkbox]`)
      .click({ modifiers: ['Control'] });

    await expect.poll(async () =>
      (await allScripts(sm)).find((s) => s.id === other.id)!.enabled,
    ).not.toBe(false);
    // The one that was already on stayed on — the whole point of the
    // modifier.
    expect((await allScripts(sm)).find((s) => s.id === standalone.id)!.enabled).not.toBe(false);
    await page.close();
  });

  // A single-file install can be taken back out from here. A script
  // that came in with a collection cannot: the collection's next refresh
  // would scan it straight back in, so the button says where the
  // removal actually lives instead of pretending to work.
  test('the trash can removes a single-file copy and is disabled for directory copies', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const inFolder = scripts.find((s) => s.id !== standalone.id)!;

    const page = await extensionContext.newPage();
    // View the folder copy, so the row being removed is NOT this page.
    await page.goto(`chrome-extension://${extensionId}/${viewer(inFolder.id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    const trash = (id: string) =>
      page.locator(`${PANEL} tr[data-script-id="${id}"] .versions-remove`);

    await expect(trash(inFolder.id)).toBeDisabled();
    await expect(trash(inFolder.id))
      .toHaveAttribute(
        'title',
        'Script from directory collection can only be removed by removing the collection',
      );
    await expect(trash(standalone.id)).toBeEnabled();

    await trash(standalone.id).click();
    await expect.poll(async () => (await allScripts(sm)).length).toBe(1);
    // With the standalone gone the folder copy stands alone, so the
    // panel has nothing left to compare and hides itself.
    await expect(page.locator(PANEL)).toBeHidden();
    await page.close();
  });

  // The tooltip names the kind of collection the copy came in with, using
  // the words the collections page already uses for how it was added.
  test('a manifest copy says "manifest collection", not "directory collection"', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    dir.writeRaw('script_manifest.json', JSON.stringify(['hello.user.js']));
    await sm.addCollection(`${dir.path}/script_manifest.json`);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const inManifest = scripts.find((s) => s.id !== standalone.id)!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);
    await expect(
      page.locator(`${PANEL} tr[data-script-id="${inManifest.id}"] .versions-remove`),
    ).toHaveAttribute(
      'title',
      'Script from manifest collection can only be removed by removing the collection',
    );
    await page.close();
  });

  // The controls-row toggle is the same radio button as a panel row's,
  // and both flip on screen together rather than one lagging a round
  // trip through storage behind the other.
  test('the page toggle applies the exclusive rule, and both boxes move at once', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const inFolder = scripts.find((s) => s.id !== standalone.id)!;
    await sm.setScriptEnabled(standalone.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);

    const otherBox = page.locator(
      `${PANEL} tr[data-script-id="${inFolder.id}"] input[type=checkbox]`,
    );
    await expect(otherBox).toBeChecked();
    // The tooltip mentions the modifier only where a sweep can fire —
    // on this script's own controls, since the other copy is running.
    // The panel row for the same script reads identically: they are the
    // same control in two places.
    const hinted = 'Enable this script (Ctrl-click for multi-enable)';
    await expect(page.locator('#enable-label')).toHaveAttribute('title', hinted);
    await expect(page.locator(`${PANEL} tr.is-current label.toggle`))
      .toHaveAttribute('title', hinted);
    // …and not on the running copy's own row: clicking that one turns
    // it off, which sweeps nothing.
    await expect(otherBox.locator('xpath=..'))
      .toHaveAttribute('title', 'Enable this script');

    await page.locator('#enable-checkbox').check();
    // Painted before the write lands, so no poll: if this needed one,
    // the lag being fixed here would be back.
    await expect(otherBox).not.toBeChecked();

    await expect.poll(async () =>
      (await allScripts(sm)).find((s) => s.id === inFolder.id)!.enabled,
    ).toBe(false);
    await page.close();
  });

  test('ctrl-clicking the page toggle leaves the other copies alone', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const inFolder = scripts.find((s) => s.id !== standalone.id)!;
    await sm.setScriptEnabled(standalone.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await page.locator('#enable-checkbox').click({ modifiers: ['Control'] });

    await expect.poll(async () =>
      (await allScripts(sm)).find((s) => s.id === standalone.id)!.enabled,
    ).not.toBe(false);
    expect((await allScripts(sm)).find((s) => s.id === inFolder.id)!.enabled).not.toBe(false);
    await page.close();
  });

  // Each row's handler closes over the row list as it was drawn, so a
  // panel that doesn't repaint after a write computes the SECOND
  // click's sweep from pre-first-click data and sweeps nothing. A
  // preview is where this bites: it has no storage listener to repaint
  // it, so the panel's own action has to.
  test('a second exclusive toggle on a preview still sweeps', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns });
    const b = write('b.user.js', 'Twin Script', { namespace: ns });
    await sm.addCollection(a);
    await sm.addCollection(b);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const first = scripts.find((s) => s.relativePath === a)!;
    const second = scripts.find((s) => s.relativePath === b)!;
    await sm.setScriptEnabled(first.id, false);
    await sm.syncNow();

    const c = write('c.user.js', 'Twin Script', { namespace: ns });
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${c}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    const box = (id: string) =>
      page.locator(`${PANEL} tr[data-script-id="${id}"] input[type=checkbox]`);
    const enabledOf = async (id: string) =>
      (await allScripts(sm)).find((s) => s.id === id)!.enabled;

    await box(first.id).check();
    await expect.poll(() => enabledOf(second.id)).toBe(false);

    // The one that matters: flip it back the other way.
    await box(second.id).check();
    await expect.poll(() => enabledOf(first.id)).toBe(false);
    expect(await enabledOf(second.id)).not.toBe(false);
    await page.close();
  });

  // Same panel, same actions — so the preview's rows get the rule too.
  test('the preview panel checkboxes are exclusive as well', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns });
    const b = write('b.user.js', 'Twin Script', { namespace: ns });
    await sm.addCollection(a);
    await sm.addCollection(b);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const first = scripts.find((s) => s.relativePath === a)!;
    const second = scripts.find((s) => s.relativePath === b)!;
    await sm.setScriptEnabled(first.id, false);
    await sm.syncNow();

    // Preview a third file that is the same script again, so both
    // installed copies show up in the panel below the banner.
    const c = write('c.user.js', 'Twin Script', { namespace: ns });
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${c}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator(ROWS)).toHaveCount(3);   // two copies + the install offer

    const secondBox = page.locator(
      `${PANEL} tr[data-script-id="${second.id}"] input[type=checkbox]`,
    );
    await page.locator(`${PANEL} tr[data-script-id="${first.id}"] input[type=checkbox]`).check();
    await expect(secondBox).not.toBeChecked();

    await expect.poll(async () =>
      (await allScripts(sm)).find((s) => s.id === second.id)!.enabled,
    ).toBe(false);
    await page.close();
  });

  // A copy that cannot run is not competing with the one being
  // enabled — and its own box is disabled, so a flip made here could
  // not be undone from this panel at all.
  test('the exclusive sweep spares a copy whose collection is disabled', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const collections = await sm.getCollections();
    const folder = collections.find((s) => s.path === dir.path)!;
    await sm.setCollectionEnabled(folder.id, false);

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const inFolder = scripts.find((s) => s.id !== standalone.id)!;
    // Off, then on again: the second click is the exclusive one.
    await sm.setScriptEnabled(standalone.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);
    await page
      .locator(`${PANEL} tr[data-script-id="${standalone.id}"] input[type=checkbox]`)
      .check();

    await expect.poll(async () =>
      (await allScripts(sm)).find((s) => s.id === standalone.id)!.enabled,
    ).not.toBe(false);
    // Untouched: its stored intent survives for whenever the collection
    // comes back on.
    expect((await allScripts(sm)).find((s) => s.id === inFolder.id)!.enabled).not.toBe(false);
    await page.close();
  });

  // The sweep spans both sections — the point is that one copy of this
  // script runs, not one copy per section.
  test('enabling a copy also disables a same-identity copy at another URL', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns });
    const b = write('b.user.js', 'Twin Script', { namespace: ns });
    await sm.addCollection(a);
    await sm.addCollection(b);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const first = scripts.find((s) => s.relativePath === a)!;
    const second = scripts.find((s) => s.relativePath === b)!;
    await sm.setScriptEnabled(first.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(first.id)}`);
    await page
      .locator(`${PANEL} tr[data-script-id="${first.id}"] input[type=checkbox]`)
      .check();

    await expect.poll(async () =>
      (await allScripts(sm)).find((s) => s.id === second.id)!.enabled,
    ).toBe(false);
    await page.close();
  });

  // Installing is an enable, so it sweeps too: after Install the copy
  // just added is the only one running.
  test('installing from a preview disables the copies already installed', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns, version: '1.0.0' });
    const b = write('b.user.js', 'Twin Script', { namespace: ns, version: '2.0.0' });
    await sm.addCollection(a);
    await sm.syncNow();
    // The copy the sweep has to switch off starts ON — without this the
    // assertion below passes for a copy that was never enabled at all.
    expect((await allScripts(sm)).find((s) => s.relativePath === a)!.enabled).not.toBe(false);

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${b}`)}`,
    );
    // Two targets (the installed twin and the offer), so the header
    // Install defers to the table's offer row.
    await page.locator(`${PANEL} tr.is-offer button`).click();
    // Install navigates to the new script's own page.
    await page.waitForURL(/userscript\.html\?script=/);

    await expect.poll(async () => {
      const scripts = await allScripts(sm);
      return {
        old: scripts.find((s) => s.relativePath === a)?.enabled,
        installed: scripts.find((s) => s.relativePath === b)?.enabled,
      };
    }).toEqual({ old: false, installed: true });
    await page.close();
  });

  // The install sweep asks the same "is it running" question of the new
  // copy that it asks of the ones it switches off. A container the user
  // has turned off means the new copy can't run, so switching the
  // working one off would leave nothing running.
  test('installing into a disabled container sweeps nothing', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    write('a.user.js', 'Twin Script', { namespace: ns });
    const b = write('b.user.js', 'Twin Script', { namespace: ns });
    // A third file, installed on its own purely to create the container
    // collection so there is something to disable before installing `b`.
    await sm.addCollection(write('other.user.js', 'Unrelated Script'));
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const container = (await sm.getCollections()).find((s) => s.path !== dir.path)!;
    await sm.setCollectionEnabled(container.id, false);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${b}`)}`,
    );
    await page.locator(`${PANEL} tr.is-offer button`).click();
    await page.waitForURL(/userscript\.html\?script=/);

    // The install itself landed — otherwise there would be no sweep to
    // skip and the assertions below would prove nothing.
    const after = await allScripts(sm);
    expect(after.some((s) => s.relativePath === b)).toBe(true);
    // Both directory copies keep their stored intent: the same-identity
    // twin and the directory's own copy of the file just installed.
    expect(after.find((s) => s.relativePath === 'a.user.js')!.enabled).not.toBe(false);
    expect(after.find((s) => s.relativePath === 'b.user.js')!.enabled).not.toBe(false);
    await page.close();
  });

  // Removing the row you are standing on is allowed, and the page moves
  // to another copy rather than stranding itself on the not-found line.
  //
  // Three containers, named so their display-name sort is A / M / Z:
  // that fixes the table order, which is the order these two tests are
  // about. Returns the script id of the copy in each, in that order.
  async function threeCopies(sm: SmApi, path: string): Promise<[string, string, string]> {
    const collectionIds: string[] = [];
    for (const name of ['A first', 'M middle', 'Z last']) {
      const collection = await sm.createCollection({ kind: 'scripts', name });
      await sm.installScript(`file://${path}`, { collectionId: collection!.id });
      collectionIds.push(collection!.id);
    }
    await sm.syncNow();
    const scripts = await allScripts(sm);
    const [a, m, z] = collectionIds.map((id) => scripts.find((s) => s.collectionId === id)!.id);
    return [a, m, z];
  }

  test('removing the script being viewed switches to the next copy', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    const [, middle, last] = await threeCopies(sm, path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(middle)}`);
    await page.locator(`${PANEL} tr.is-current .versions-remove`).click();

    // The row below the one that went away — the whole page, not just
    // the URL: the title is the successor's and the not-found state
    // never appears.
    await page.waitForURL(`**/${viewer(last)}`);
    await expect(page.locator(`${PANEL} tr.is-current`)).toHaveAttribute('data-script-id', last);
    await expect(page.locator('h1')).not.toHaveText('Not available');
    await expect(page.locator(ROWS)).toHaveCount(2);
    expect(await allScripts(sm)).toHaveLength(2);
    await page.close();
  });

  // The switch above has to be ONE paint. The removal's own storage
  // event lands while the page still points at the deleted row, and the
  // listener's not-found paint would blank the heading, the details and
  // the panel before the swap builds them back — a flash that reads as a
  // page load. Only a recording made across the transition can catch it:
  // by the time the swap has landed the page looks right either way.
  test('the switch never paints the not-found state on the way', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    const [, middle, last] = await threeCopies(sm, path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(middle)}`);
    await page.locator(`${PANEL} tr.is-current`).waitFor();
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { smHeadings: string[] }).smHeadings = seen;
      const h1 = document.querySelector('h1')!;
      new MutationObserver(() => seen.push(h1.textContent ?? '')).observe(h1, {
        childList: true, subtree: true, characterData: true,
      });
    });

    await page.locator(`${PANEL} tr.is-current .versions-remove`).click();
    await page.waitForURL(`**/${viewer(last)}`);
    await expect(page.locator(`${PANEL} tr.is-current`)).toHaveAttribute('data-script-id', last);

    const headings = await page.evaluate(
      () => (window as unknown as { smHeadings: string[] }).smHeadings,
    );
    expect(headings.join(' | ')).not.toContain('Not available');
    await page.close();
  });

  test('removing the last copy in the table wraps to the first', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    const [first, middle, last] = await threeCopies(sm, path);

    const page = await extensionContext.newPage();
    // Arrive at the last copy from the middle one, so there is a
    // history entry to go back to.
    await page.goto(`chrome-extension://${extensionId}/${viewer(middle)}`);
    await page.locator(`${PANEL} tr[data-script-id="${last}"]`).click();
    await page.waitForURL(`**/${viewer(last)}`);

    await page.locator(`${PANEL} tr.is-current .versions-remove`).click();
    await page.waitForURL(`**/${viewer(first)}`);

    // The entry for the removed copy was replaced, not stacked on top
    // of: Back goes to where the user came from, not to a not-found
    // page for a script that no longer exists.
    await page.goBack();
    await page.waitForURL(`**/${viewer(middle)}`);
    await expect(page.locator(`${PANEL} tr.is-current`)).toHaveAttribute('data-script-id', middle);
    await page.close();
  });

  // A preview has no storage listener, so the buttons around the panel
  // only catch up because the panel's actions re-wire them.
  test('removing the installed copy from a preview re-offers Install', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    // A copy exists, so the table carries every action and the callout
    // stays down.
    await expect(page.locator('#install-callout')).toBeHidden();
    await expect(page.locator('#banner-slot')).toContainText('already installed');

    await page.locator(`${PANEL} .versions-remove`).click();

    // Nothing is installed anywhere now: the install callout comes
    // back in place of the banner, and the panel — with no existing
    // versions left — hides itself.
    await expect(page.locator('#install-callout')).toBeVisible();
    await expect(page.locator('#install-btn')).toBeEnabled();
    await expect(page.locator('#open-btn')).toBeHidden();
    await expect(page.locator('#banner-slot')).not.toContainText('already installed');
    await expect(page.locator(PANEL)).toBeHidden();
    await page.close();
  });

  test('Refresh all appears only when more than one row can be refreshed', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(path);
    await sm.syncNow();

    let scripts = await allScripts(sm);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(scripts[0].id)}`);
    // One copy: the panel is hidden entirely, so no Update all either.
    await expect(page.locator(PANEL)).toBeHidden();

    await sm.addCollection(dir.path);
    await sm.syncNow();
    scripts = await allScripts(sm);
    await page.goto(`chrome-extension://${extensionId}/${viewer(scripts[0].id)}`);
    await expect(page.locator(ROWS)).toHaveCount(2);
    // The viewer calls this operation Refresh, so the panel does too.
    await expect(page.locator(`${PANEL} th.col-actions button`)).toHaveText('Refresh all');
    // Icon-only rows: the verb that used to be the label is now the
    // accessible name, and it is still Refresh rather than Update.
    await expect(page.locator(`${PANEL} td.col-actions button`).first())
      .toHaveAttribute('aria-label', /^Refresh /);
    // Every row in this section carries its own button, the current
    // one included.
    await expect(page.locator(`${PANEL} td.col-actions button`)).toHaveCount(2);
    // It spans the actions and removal columns, so it ends flush with
    // the removal buttons under it — neither short of them nor hanging
    // off the table.
    const headRight = (await page.locator(`${PANEL} th.col-actions button`).boundingBox())!;
    const canRight = (await page.locator(`${PANEL} td.col-remove button`).first().boundingBox())!;
    expect(Math.abs((headRight.x + headRight.width) - (canRight.x + canRight.width)))
      .toBeLessThanOrEqual(1);
    await page.close();
  });

  // A copy inside a collection collection is not a copy of your own, so
  // both installing and opening are meaningful — but there are two
  // targets, so the header buttons stand down and the table carries
  // them per-row.
  test('preview of a file a directory collection already covers defers to the table', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script', { version: '1.0.0' });
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();

    await expect(page.locator('#banner-slot')).toContainText('already installed');
    // The table carries every action, so the banner's one line says so
    // and the header keeps no button that acts on a copy.
    await expect(page.locator('#banner-slot'))
      .toContainText('This script is already installed. Select which instance to update or install.');
    await expect(page.locator('#install-callout')).toBeHidden();
    await expect(page.locator('#open-btn')).toBeHidden();
    // Cancel and View raw source are about the preview itself, not
    // about a copy, so they stay.
    await expect(page.locator('#cancel-btn')).toBeVisible();

    // No heading of its own — the banner line above the table is the
    // heading in a preview. Then the install-offer section, with the
    // local default — which has no row yet — pre-selected and nothing
    // saying Install is blocked.
    await expect(page.locator(`${PANEL} h2`)).toHaveCount(0);
    await expect(page.locator(`${PANEL} .versions-section-heading`).last())
      .toHaveText('Install another copy of this script');
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} .install-offer-note`)).toHaveText('');
    await expect(page.locator(`${PANEL} tr.is-offer select option:checked`))
      .toHaveText('Scripts from local disk (new)');
    // The offer row borrows the previewed file's version rather than
    // reading as missing data.
    await expect(page.locator(`${PANEL} tr.is-offer td.col-version`)).toHaveText('1.0.0');
    // The offer's Location is ABSOLUTE, which is not how the directory
    // collection's own row spells the same file — that one stores a
    // path under the collection root. Absolute because it is what
    // installing from here would store; the column lines the two up
    // without claiming they read alike.
    await expect(page.locator(`${PANEL} tr.is-offer td.col-location`)).toHaveText(path);
    await expect(page.locator(`${PANEL} tbody td.col-location`).first()).toHaveText('hello.user.js');
    // The offer's table keeps a heading row for a screen reader — the
    // labelling of the section above does not reach across tables —
    // and takes it off screen, rather than dropping it.
    const offerHead = page.locator(`${PANEL} table`).last().locator('thead');
    await expect(offerHead).toHaveClass(/visually-hidden/);
    await expect(offerHead.locator('th')).toHaveCount(8);
    await expect(offerHead).not.toBeInViewport();
    // The dropdown is labelled, and the callout's own copy of it is not
    // in the document twice over.
    await expect(page.locator('label[for="install-target-offer"]')).toHaveText('into');
    await expect(page.locator('#install-target')).toHaveCount(0);
    // Every action the header gave up is present in the table.
    await expect(page.locator(`${PANEL} tr.is-offer button`)).toHaveText('Install');
    // A preview's button keeps its word: it is not the refetch the
    // installed page does, so it does not wear the refresh arrow.
    await expect(page.locator(`${PANEL} td.col-actions button`).first()).toHaveText('Update');
    // A preview's Location IS a link — its rows are not clickable, so
    // this is the only way to reach that copy from here.
    await expect(page.locator(`${PANEL} td.col-location a`)).toHaveCount(1);

    await page.close();
  });

  // An invalid preview hides its own Install button; the panel must not
  // put one back. The banner says the file cannot be installed, so an
  // Install in the offer row would contradict the page around it.
  //
  // The invalid file must still PARSE — a file with no metadata block
  // has no `@name`, so it would match nothing and the panel would be
  // empty for that reason instead of the one under test. A header that
  // parses but declares no `@match`/`@include` fails `validateHeader`
  // while still carrying the identity that finds the good copy.
  test('an invalid preview shows existing copies but offers no install', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const good = write('good.user.js', 'Broken Twin', { namespace: ns, version: '1.0.0' });
    await sm.addCollection(good);
    await sm.syncNow();

    const bad = dir.writeRaw(
      'bad.user.js',
      [
        '// ==UserScript==',
        '// @name        Broken Twin',
        `// @namespace   ${ns}`,
        '// ==/UserScript==',
        '',
        'console.log("no @match, so this cannot be installed");',
        '',
      ].join('\n'),
    );

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${bad}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator('#install-btn')).toBeHidden();

    // The panel IS shown — the identity match found the good copy, so
    // the assertions below are about a rendered panel, not an empty one.
    await expect(page.locator(PANEL)).toContainText('Same script from a different URL');
    await expect(page.locator(`${PANEL} td.col-location`)).toContainText('good.user.js');
    // …but no offer row, and so no Install button anywhere in it.
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(0);
    await expect(page.locator(`${PANEL} button`).filter({ hasText: 'Install' })).toHaveCount(0);
    await page.close();
  });

  // The refetch is per row — each copy re-reads from its own
  // collection — so a different-URL copy gets the button too, and
  // Refresh all covers both sections. (Not in a preview, which offers
  // Update on same-URL rows only.)
  test('a different-URL copy gets a refresh button, and Refresh all reaches it', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns, version: '1.0' });
    write('b.user.js', 'Twin Script', { namespace: ns, version: '1.0' });
    await sm.addCollection(a);
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === a)!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    // Two tables; the different-URL row in the second carries Refresh
    // like the rows in the first.
    const tables = page.locator(`${PANEL} table`);
    await expect(tables).toHaveCount(2);
    await expect(tables.nth(1).locator('tbody tr')).toHaveCount(1);
    await expect(tables.nth(1).locator('td.col-actions button'))
      .toHaveAttribute('aria-label', 'Refresh this copy from its collection');
    // Two refreshable rows across the two sections, so Refresh all
    // appears, scoped to the whole panel.
    const all = page.locator(`${PANEL} th.col-actions button`);
    await expect(all).toHaveText('Refresh all');
    await expect(all).toHaveAttribute('title', 'Refresh all copies of this script');

    // It really does refresh the different-URL row: bump its file and
    // watch the stored version follow. A longer version, so the file's
    // size changes — a same-size edit inside the listing's one-second
    // mtime granularity is one the refresh is allowed to skip.
    write('b.user.js', 'Twin Script', { namespace: ns, version: '2.0.1' });
    await all.click();
    await expect.poll(async () => {
      const b = (await allScripts(sm)).find((s) => s.relativePath === 'b.user.js');
      return /@version\s+(\S+)/.exec(b?.headerText ?? '')?.[1];
    }).toBe('2.0.1');
    await page.close();
  });

  // The Content column says whether each other copy holds the same
  // loaded code as the copy on screen — body and `@require`s together.
  test('the Content column compares each copy against the one on screen', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns, version: '1.0' });
    // Same text at a different path: same content, different URL.
    write('b.user.js', 'Twin Script', { namespace: ns, version: '1.0' });
    await sm.addCollection(a);
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === a)!;
    const inFolder = scripts.find((s) => s.relativePath === 'a.user.js')!;
    const twin = scripts.find((s) => s.relativePath === 'b.user.js')!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    const content = (id: string) => page.locator(`${ROWS}[data-script-id="${id}"] td.col-content`);
    // The copy on screen is compared against, not with itself.
    await expect(content(standalone.id)).toHaveText('BASE');
    await expect(content(inFolder.id)).toHaveText('SAME');
    await expect(content(inFolder.id).locator('span')).toHaveClass('content-same');
    await expect(content(twin.id)).toHaveText('SAME');

    // The twin's file changes; the column follows the STORED copy, so
    // it says Same until a refresh loads the new text.
    write('b.user.js', 'Twin Script', { namespace: ns, version: '2.0.1' });
    await expect(content(twin.id)).toHaveText('SAME');
    await page.locator(`${PANEL} th.col-actions button`).click();
    await expect(content(twin.id)).toHaveText('DIFFERENT');
    await expect(content(twin.id).locator('span')).toHaveClass('content-different');
    await expect(content(inFolder.id)).toHaveText('SAME');

    // Switching copies in place moves the comparison with the page.
    await page.locator(`${ROWS}[data-script-id="${twin.id}"] td.col-version`).click();
    await expect(page.locator(`${PANEL} tr.is-current`)).toHaveAttribute('data-script-id', twin.id);
    await expect(content(twin.id)).toHaveText('BASE');
    await expect(content(standalone.id)).toHaveText('DIFFERENT');
    await expect(content(inFolder.id)).toHaveText('DIFFERENT');
    await page.close();
  });

  test('the Content column counts a differing @require', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two directories, each with an identical script that requires its
    // own `lib.js` — only the libraries differ.
    const other = ScriptsDir.create();
    try {
      const ns = 'https://example.com/ns';
      const spec = {
        relativePath: 'lib.user.js',
        meta: { name: 'Lib Script', match: ['https://example.com/*'], extra: [
          `// @namespace   ${ns}`,
          '// @require     lib.js',
        ] },
        body: 'console.log("hi");\n',
      };
      dir.writeRaw('lib.js', 'window.__lib = 1;\n');
      other.writeRaw('lib.js', 'window.__lib = 2;\n');
      dir.write(spec);
      other.write(spec);
      await sm.addCollection(dir.path);
      await sm.addCollection(other.path);
      await sm.syncNow();

      const scripts = await allScripts(sm);
      expect(scripts).toHaveLength(2);
      const [shown, rest] = scripts;
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/${viewer(shown.id)}`);
      await expect(page.locator(`${ROWS}[data-script-id="${rest.id}"] td.col-content`))
        .toHaveText('DIFFERENT');

      // Bring the libraries into line; the refresh picks the change up.
      other.writeRaw('lib.js', 'window.__lib = 1;\n');
      await page.locator(`${ROWS}[data-script-id="${rest.id}"] td.col-actions button`).click();
      await expect(page.locator(`${ROWS}[data-script-id="${rest.id}"] td.col-content`))
        .toHaveText('SAME');
      await page.close();
    } finally {
      other.cleanup();
    }
  });

  test('a copy whose @require did not load is not compared', async ({
    extensionContext, extensionId, sm,
  }) => {
    const other = ScriptsDir.create();
    try {
      const spec = {
        relativePath: 'lib.user.js',
        meta: { name: 'Lib Script', match: ['https://example.com/*'], extra: [
          '// @namespace   https://example.com/ns',
          '// @require     lib.js',
        ] },
        body: 'console.log("hi");\n',
      };
      dir.writeRaw('lib.js', 'window.__lib = 1;\n');
      dir.write(spec);
      other.write(spec);  // no lib.js beside it
      await sm.addCollection(dir.path);
      await sm.addCollection(other.path);
      await sm.syncNow();

      const scripts = await allScripts(sm);
      const healthy = scripts.find((s) => s.status === 'ok')!;
      const broken = scripts.find((s) => s.status !== 'ok')!;
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/${viewer(healthy.id)}`);
      // Body-only would call it DIFFERENT; with its library missing
      // there is nothing to compare, so the cell says so.
      await expect(page.locator(`${ROWS}[data-script-id="${broken.id}"] td.col-content`))
        .toHaveText('\u2014');
      // Standing on the broken copy, no row can be compared either.
      await page.goto(`chrome-extension://${extensionId}/${viewer(broken.id)}`);
      await expect(page.locator(`${ROWS}[data-script-id="${healthy.id}"] td.col-content`))
        .toHaveText('\u2014');
      await page.close();
    } finally {
      other.cleanup();
    }
  });

  test('a preview compares the installed copies against the download', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script', { version: '1.0.0' });
    await sm.addCollection(dir.path);
    await sm.syncNow();
    const [installed] = await allScripts(sm);

    const page = await extensionContext.newPage();
    const preview = `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`;
    await page.goto(preview);
    const content = page.locator(`${ROWS}[data-script-id="${installed.id}"] td.col-content`);
    await expect(content).toHaveText('SAME');
    // The offer row IS the download: the base the rest are compared with.
    await expect(page.locator(`${PANEL} tr.is-offer td.col-content`)).toHaveText('BASE');

    // The file moves on; a fresh preview shows the stored copy behind.
    write('hello.user.js', 'Shared Script', { version: '1.0.1' });
    await page.goto(preview);
    await expect(content).toHaveText('DIFFERENT');
    await page.close();
  });

  // A row under a disabled collection does not run. The box keeps showing
  // the script's OWN stored flag — same as the page's controls-row
  // toggle, which also stays checked and goes grey — and the disabled
  // state plus the label carry the collection override.
  test('a row under a disabled collection is greyed out and explains why', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const collections = await sm.getCollections();
    const folder = collections.find((s) => s.path === dir.path)!;
    await sm.setCollectionEnabled(folder.id, false);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    const offRow = page.locator(`${PANEL} tbody tr:not(.is-current)`);
    await expect(offRow.locator('input[type=checkbox]')).toBeDisabled();
    // The short tooltip says which state it is in; the accessible name
    // carries the explanation, since a screen reader has no Collection cell
    // to read across to.
    await expect(offRow.locator('label.toggle'))
      .toHaveAttribute('title', 'Collection is disabled');
    await expect(offRow.locator('input[type=checkbox]'))
      .toHaveAttribute('aria-label', /collection is disabled, so this copy does not run/);
    await expect(offRow.locator('label.toggle')).toHaveClass(/toggle-disabled/);
    // The current row's collection is still on, so it stays operable.
    await expect(page.locator(`${PANEL} tr.is-current input[type=checkbox]`)).toBeEnabled();
    await page.close();
  });

  test('preview of a file already installed in the default makes a second copy a deliberate pick', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-callout')).toBeHidden();
    // The offer row keeps the default first and selected even though it
    // already holds this script; Install waits for another pick.
    const offer = page.locator(`${PANEL} tr.is-offer`);
    await expect(offer.locator('select option:checked')).toHaveText('Scripts from local disk (already installed)');
    await expect(offer.locator('select option:checked')).toBeDisabled();
    await expect(offer.locator('button')).toBeDisabled();
    await expect(offer).toContainText('Choose another collection');
    await page.close();
  });

  // With nothing installed anywhere there are no *existing* versions to
  // head a panel with, and the offer row would only repeat the Install
  // button one line higher.
  test('a preview with nothing installed shows no panel', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('fresh.user.js', 'Fresh Script');
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator('#install-callout')).toBeVisible();
    await expect(page.locator('#install-btn')).toBeVisible();
    await expect(page.locator('#banner-slot')).not.toContainText('installed');
    await expect(page.locator(PANEL)).toBeHidden();
    expect(await allScripts(sm)).toHaveLength(0);
    await page.close();
  });

  // The banner says a copy exists and sends the reader to the table,
  // which is where every copy — and the offer — is.
  test('the preview banner covers the multiple-copy case', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator('#banner-slot'))
      .toContainText('This script is already installed');
    await expect(page.locator('#banner-slot'))
      .toContainText('Select which instance to update or install');
    // Two copies plus the offer row.
    await expect(page.locator(ROWS)).toHaveCount(3);
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(1);
    await page.close();
  });

  // The header only stands down for a table that carries the action.
  // A location with no single-file spelling gets no offer row, so its
  // Install has nowhere else to live and must stay in the header —
  // even with two rows below it.
  test('a location the table cannot offer to install keeps its header Install', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    // `.js`, not `.user.js`: previewable, but not a single-file input,
    // so `installOptions` — and with it the offer row — is undefined.
    const plain = dir.writeRaw(
      'plain.js',
      [
        '// ==UserScript==',
        '// @name        Twin Script',
        `// @namespace   ${ns}`,
        '// @match       https://example.com/*',
        '// ==/UserScript==',
        '',
        'console.log("hi");',
        '',
      ].join('\n'),
    );
    write('a.user.js', 'Twin Script', { namespace: ns });
    write('b.user.js', 'Twin Script', { namespace: ns });
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${plain}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    // Two same-identity rows below, and no offer row to install from —
    // so the callout stays, without a dropdown.
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(0);
    await expect(page.locator(ROWS)).toHaveCount(2);
    await expect(page.locator('#install-callout')).toBeVisible();
    await expect(page.locator('#install-btn')).toBeVisible();
    await expect(page.locator('#install-target')).toHaveCount(0);
    await page.close();
  });

  // Installed, but not from here. Open and Update would have nothing to
  // act on, so they stay hidden and the panel is the way across.
  test('the preview banner names the different-URL case', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns, version: '1.0.0' });
    const b = write('b.user.js', 'Twin Script', { namespace: ns, version: '2.0.0' });
    await sm.addCollection(a);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${b}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator('#banner-slot'))
      .toContainText('This script is already installed');
    await expect(page.locator('#banner-slot')).toContainText('Select which instance to update or install');
    // Nothing installed at THIS url, so nothing for Open to act on; the
    // table carries Install on its offer row.
    await expect(page.locator('#open-btn')).toBeHidden();
    await expect(page.locator('#install-callout')).toBeHidden();
    await expect(page.locator(PANEL)).toContainText('Same script from a different URL');
    await expect(page.locator(`${PANEL} tr.is-offer button`)).toHaveText('Install');
    // Nothing is installed at this URL, so there is no "This URL"
    // section at all — it lists copies, and there are none. The offer
    // is a section of its own below it either way.
    await expect(page.locator(PANEL)).not.toContainText('This URL');
    await expect(page.locator(`${PANEL} .versions-section-heading`)).toHaveCount(2);
    await page.close();
  });

  // The fold. Collapsed, the panel is its heading line and the button —
  // no rows, no tables. It lasts for the page only: a reload opens the
  // panel again, and so does a panel that appears after having gone
  // away, whatever the fold said before.
  test('the versions panel folds to its heading for the life of the page', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addCollection(dir.path);
    await sm.addCollection(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    const toggle = page.locator(`${PANEL} .versions-collapse`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(ROWS)).toHaveCount(2);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(ROWS)).toHaveCount(0);
    await expect(page.locator(`${PANEL} table`)).toHaveCount(0);
    // Still headed, and the button keeps focus so a second press undoes
    // the first.
    await expect(page.locator(PANEL)).toContainText('Other versions of this script');
    await expect(toggle).toBeFocused();
    // One sentence for the pointer and the screen reader both — the
    // glyph names nothing on its own.
    await expect(toggle).toHaveAttribute('title', 'Show the other versions');
    await expect(toggle).toHaveAttribute('aria-label', 'Show the other versions');

    // A repaint nobody asked for — the panel rebuilds on any drawn
    // copy's stored change — must not cost the button its focus.
    const other = scripts.find((s) => s.id !== standalone.id)!;
    await sm.setScriptEnabled(other.id, false);
    await sm.syncNow();
    await expect(page.locator(`${PANEL} .versions-collapse`)).toBeFocused();

    // A reload opens the panel again: the fold was this page's alone.
    await page.reload();
    await expect(page.locator(`${PANEL} .versions-collapse`))
      .toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(ROWS)).toHaveCount(2);

    // Folded, then the panel goes away (the other copy is removed) and
    // comes back (it is installed again): it comes back open.
    await page.goto(`chrome-extension://${extensionId}/${viewer(other.id)}`);
    await page.locator(`${PANEL} .versions-collapse`).click();
    await expect(page.locator(ROWS)).toHaveCount(0);
    await sm.removeScript(standalone.id);
    await expect(page.locator(PANEL)).toBeHidden();
    await sm.installScript(path, { schemeDefault: true });
    await expect(page.locator(`${PANEL} .versions-collapse`))
      .toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(ROWS)).toHaveCount(2);
    await page.close();
  });
});
