// End-to-end coverage of the "Other versions" / "Existing versions"
// panel (`#other-versions`, src/related-versions.ts) and the lookup
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

  // Every stored script, across every collection. The SW test surface
  // exposes collections and their scripts, not a flat list.
  async function allScripts(sm: { getCollections: () => Promise<{ id: string }[]>;
    getCollectionWithScripts: (id: string) => Promise<{ scripts: unknown[] } | null> }):
    Promise<{ id: string; relativePath: string; enabled?: boolean }[]> {
    const collections = await sm.getCollections();
    const out: { id: string; relativePath: string; enabled?: boolean }[] = [];
    for (const src of collections) {
      const withScripts = await sm.getCollectionWithScripts(src.id);
      for (const script of withScripts?.scripts ?? []) {
        out.push(script as { id: string; relativePath: string; enabled?: boolean });
      }
    }
    return out;
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

    // The other copy links to its own viewer tab.
    const other = scripts.find((s) => s.relativePath === b)!;
    await expect(
      page.locator(`${PANEL} td.col-location a[href*="${other.id}"]`),
    ).toHaveCount(1);

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

    // Status sits between Location and Version.
    const headings = await page.locator(`${PANEL} thead th`).allTextContents();
    expect(headings.slice(2, 5)).toEqual(['Location', 'Status', 'Version']);

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

  // Removing the row you are standing on is allowed, and the page says
  // so rather than reporting a store that lost your script.
  test('removing the script being viewed reports it as removed', async ({
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
    await page.locator(`${PANEL} tr.is-current .versions-remove`).click();

    await expect(page.locator('#message')).toContainText('This script has been removed');
    // The panel goes with the rest of the page — its heading has
    // nothing left to be "other than".
    await expect(page.locator(PANEL)).toBeHidden();
    expect(await allScripts(sm)).toHaveLength(1);
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
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#open-btn')).toBeVisible();

    await page.locator(`${PANEL} .versions-remove`).click();

    // Nothing is installed anywhere now: Install comes back, the stale
    // Open/Update pointing at a dead id go away, and the panel — with
    // no existing versions left — hides itself.
    await expect(page.locator('#install-btn')).toBeVisible();
    await expect(page.locator('#open-btn')).toBeHidden();
    await expect(page.locator('#update-btn')).toBeHidden();
    await expect(page.locator('#banner-slot')).toContainText('This script is not installed yet');
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
    await expect(page.locator(`${PANEL} td.col-actions button`).first()).toHaveText('Refresh');
    // Every row in this section carries its own button, the current
    // one included.
    await expect(page.locator(`${PANEL} td.col-actions button`)).toHaveCount(2);
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
    // Two targets below — the installed copy and the offer — so
    // "…below" must not point past a row of buttons doing the same
    // three things.
    await expect(page.locator('#banner-slot'))
      .toContainText('Select which instance to open, update or install below');
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator('#open-btn')).toBeHidden();
    await expect(page.locator('#update-btn')).toBeHidden();
    // Cancel and View raw source are about the preview itself, not
    // about a copy, so they stay.
    await expect(page.locator('#cancel-btn')).toBeVisible();

    // Preview heading, and the offer row for the container that has no
    // copy yet.
    await expect(page.locator(PANEL)).toContainText('Existing versions');
    await expect(page.locator(PANEL)).not.toContainText('Other versions of this script');
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} tr.is-offer`)).toContainText('Not installed here yet');
    // The offer row borrows the previewed file's version rather than
    // reading as missing data.
    await expect(page.locator(`${PANEL} tr.is-offer td.col-version`)).toHaveText('1.0.0');
    // Every action the header gave up is present in the table.
    await expect(page.locator(`${PANEL} tr.is-offer button`)).toHaveText('Install');
    await expect(page.locator(`${PANEL} td.col-actions button`).first()).toHaveText('Update');
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

  // The deliberate asymmetry: a copy at a different URL is a different
  // subscription, so refetching it is not "bring this up to date".
  test('a different-URL copy gets no refresh button', async ({
    extensionContext, extensionId, sm,
  }) => {
    const ns = 'https://example.com/ns';
    const a = write('a.user.js', 'Twin Script', { namespace: ns });
    write('b.user.js', 'Twin Script', { namespace: ns });
    await sm.addCollection(a);
    await sm.addCollection(dir.path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === a)!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    // Rows under "This URL" carry Refresh; the different-URL row does
    // not. Two tables, so index the second one's body.
    const tables = page.locator(`${PANEL} table`);
    await expect(tables).toHaveCount(2);
    await expect(tables.nth(1).locator('tbody tr')).toHaveCount(1);
    await expect(tables.nth(1).locator('td.col-actions button')).toHaveCount(0);
    await expect(tables.nth(0).locator('td.col-actions button').first()).toHaveText('Refresh');
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

  test('preview of a file already installed standalone offers no second install', async ({
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
    // The container already holds this URL, so there is nothing to add.
    await expect(page.locator('#install-btn')).toBeHidden();
    // One copy, at this very URL: the buttons above are unambiguous, so
    // the banner does not send the user to the table to pick.
    await expect(page.locator('#banner-slot')).not.toContainText('Select which instance');
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
    await expect(page.locator('#banner-slot')).toContainText('This script is not installed yet');
    await expect(page.locator('#install-btn')).toBeVisible();
    await expect(page.locator(PANEL)).toBeHidden();
    expect(await allScripts(sm)).toHaveLength(0);
    await page.close();
  });

  // The banner says WHICH copies exist, because the buttons beside it
  // only ever act on the one at this URL.
  test('the preview banner names the multiple-copy case', async ({
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
      .toContainText('This script is already installed multiple times');
    await expect(page.locator('#banner-slot'))
      .toContainText('Select which instance to open, update or install below');
    await expect(page.locator(ROWS)).toHaveCount(2);
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
    // so `installTarget` — and with it the offer row — is undefined.
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
    // Two same-identity rows below, and no offer row to install from.
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(0);
    await expect(page.locator(ROWS)).toHaveCount(2);
    await expect(page.locator('#install-btn')).toBeVisible();
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
      .toContainText('This script is already installed from a different URL');
    await expect(page.locator('#banner-slot')).toContainText('Select which instance');
    // Nothing installed at THIS url, so nothing for Open/Update to act
    // on; Install has two targets counting the twin's row, so it too
    // defers to the table.
    await expect(page.locator('#open-btn')).toBeHidden();
    await expect(page.locator('#update-btn')).toBeHidden();
    await expect(page.locator('#install-btn')).toBeHidden();
    await expect(page.locator(PANEL)).toContainText('Same script from a different URL');
    await expect(page.locator(`${PANEL} tr.is-offer button`)).toHaveText('Install');
    await page.close();
  });
});
