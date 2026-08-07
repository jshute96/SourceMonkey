// End-to-end coverage of the "Other versions" / "Existing versions"
// panel (`#other-versions`, src/related-versions.ts) and the lookup
// behind it (src/script-identity.ts).
//
// The unit tests cover the matching rules against fabricated rows;
// what only a real run can prove is that the absolute URLs the store
// actually writes line up — a directory source's `fileUrl` really does
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

  // Every stored script, across every source. The SW test surface
  // exposes sources and their scripts, not a flat list.
  async function allScripts(sm: { getSources: () => Promise<{ id: string }[]>;
    getSourceWithScripts: (id: string) => Promise<{ scripts: unknown[] } | null> }):
    Promise<{ id: string; relativePath: string; enabled?: boolean }[]> {
    const sources = await sm.getSources();
    const out: { id: string; relativePath: string; enabled?: boolean }[] = [];
    for (const src of sources) {
      const withScripts = await sm.getSourceWithScripts(src.id);
      for (const script of withScripts?.scripts ?? []) {
        out.push(script as { id: string; relativePath: string; enabled?: boolean });
      }
    }
    return out;
  }

  // The case the whole feature exists for. The directory source stores
  // `hello.user.js`; the standalone install stores the absolute path.
  // Only their `fileUrl`s agree, and this proves they do in production.
  test('a directory copy and a standalone copy of one file share a section', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script', { version: '1.0.0' });
    await sm.addSource(dir.path);   // the folder
    await sm.addSource(path);       // the same file, on its own
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
    await sm.addSource(a);
    await sm.addSource(b);
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
    await sm.addSource(dir.path);
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
    await sm.addSource(path);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(scripts[0].id)}`);
    await expect(page.locator('#header-summary')).toContainText('Lonely Script');
    await expect(page.locator(PANEL)).toBeHidden();
    await page.close();
  });

  test('the per-row toggle disables that copy and only that copy', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addSource(dir.path);
    await sm.addSource(path);
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

  test('Refresh all appears only when more than one row can be refreshed', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addSource(path);
    await sm.syncNow();

    let scripts = await allScripts(sm);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(scripts[0].id)}`);
    // One copy: the panel is hidden entirely, so no Update all either.
    await expect(page.locator(PANEL)).toBeHidden();

    await sm.addSource(dir.path);
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

  // A copy inside a collection source is not a copy of your own, so
  // Install and Open/Update are both meaningful at once.
  test('preview of a file a directory source already covers offers Install AND Open', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script', { version: '1.0.0' });
    await sm.addSource(dir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();

    await expect(page.locator('#banner-slot')).toContainText('already installed');
    await expect(page.locator('#install-btn')).toBeVisible();
    await expect(page.locator('#open-btn')).toBeVisible();
    await expect(page.locator('#update-btn')).toBeVisible();

    // Preview heading, and the offer row for the container that has no
    // copy yet.
    await expect(page.locator(PANEL)).toContainText('Existing versions');
    await expect(page.locator(PANEL)).not.toContainText('Other versions of this script');
    await expect(page.locator(`${PANEL} tr.is-offer`)).toHaveCount(1);
    await expect(page.locator(`${PANEL} tr.is-offer`)).toContainText('Not installed here yet');
    // The offer row borrows the previewed file's version rather than
    // reading as missing data.
    await expect(page.locator(`${PANEL} tr.is-offer td.col-version`)).toHaveText('1.0.0');

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
    await sm.addSource(good);
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
    await sm.addSource(a);
    await sm.addSource(dir.path);
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

  // A row under a disabled source does not run. The box keeps showing
  // the script's OWN stored flag — same as the page's controls-row
  // toggle, which also stays checked and goes grey — and the disabled
  // state plus the label carry the source override.
  test('a row under a disabled source is greyed out and explains why', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addSource(dir.path);
    await sm.addSource(path);
    await sm.syncNow();

    const sources = await sm.getSources();
    const folder = sources.find((s) => s.path === dir.path)!;
    await sm.setSourceEnabled(folder.id, false);
    await sm.syncNow();

    const scripts = await allScripts(sm);
    const standalone = scripts.find((s) => s.relativePath === path)!;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${viewer(standalone.id)}`);

    const offRow = page.locator(`${PANEL} tbody tr:not(.is-current)`);
    await expect(offRow.locator('input[type=checkbox]')).toBeDisabled();
    await expect(offRow.locator('input[type=checkbox]'))
      .toHaveAttribute('aria-label', /source is disabled/);
    await expect(offRow.locator('label.toggle')).toHaveClass(/toggle-disabled/);
    // The current row's source is still on, so it stays operable.
    await expect(page.locator(`${PANEL} tr.is-current input[type=checkbox]`)).toBeEnabled();
    await page.close();
  });

  test('preview of a file already installed standalone offers no second install', async ({
    extensionContext, extensionId, sm,
  }) => {
    const path = write('hello.user.js', 'Shared Script');
    await sm.addSource(path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(`file://${path}`)}`,
    );
    await expect(page.locator('#preview-actions')).toBeVisible();
    await expect(page.locator('#banner-slot')).toContainText('already installed');
    // The container already holds this URL, so there is nothing to add.
    await expect(page.locator('#install-btn')).toBeHidden();
    await page.close();
  });
});
