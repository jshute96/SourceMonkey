// Which rows the viewer's details panel shows, and when.
//
// The panel is deliberately NOT a mirror of the metadata block — that
// block is already on screen in the first code tab, so a row exists
// only when it adds something. Several rows are therefore conditional
// in ways a reader can't infer from the header alone, and those
// conditions are what this file pins down. Row CONTENT (link
// rendering, version-probe values) is covered by the specs named for
// those features.

import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('userscript viewer details panel', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // The tags a userscript can declare that the panel deliberately does
  // NOT surface. Each is either pure identity plumbing (`@namespace`),
  // a credit line (`@author`), or a runtime knob whose effect shows up
  // elsewhere (`@run-at`, `@icon`) — all of them a verbatim re-read of
  // a header line the code view already shows.
  test('does not re-list header tags the code view already shows', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Shown',
        match: ['https://example.com/*'],
        grant: ['GM_setValue'],
        runAt: 'document-idle',
        extra: [
          '// @version     1.0',
          '// @description Also shown',
          '// @author      Ada Lovelace',
          '// @namespace   https://example.com/ns',
        ],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);

    const labels = page.locator('#header-summary dt');
    await expect(labels.filter({ hasText: 'Name' })).toHaveCount(1);
    await expect(labels.filter({ hasText: 'Description' })).toHaveCount(1);
    for (const dropped of ['Author', 'Namespace', 'Permissions']) {
      await expect(labels.filter({ hasText: dropped })).toHaveCount(0);
    }
    // The values are gone too, not merely unlabeled.
    await expect(page.locator('#header-summary')).not.toContainText('Ada Lovelace');
    await expect(page.locator('#header-summary')).not.toContainText('GM_setValue');
    await page.close();
  });

  // `@connect` earns a row where `@grant` doesn't: it is the header
  // that says where the script may send what it read, and
  // `GM_xmlhttpRequest` can't reach another origin without it.
  test('shows @connect under the match targets, and no @grant row', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Talker',
        match: ['https://example.com/*'],
        grant: ['GM_xmlhttpRequest'],
        connect: ['api.example.org', '*.cdn.example.net', 'self'],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);

    const row = page.locator('#header-summary dt', { hasText: 'Network access' })
      .locator('+ dd');
    await expect(row.locator('li')).toHaveText([
      'api.example.org', '*.cdn.example.net', 'self',
    ]);
    // Plain text, not links — a @connect value is a matching rule, not
    // an address.
    await expect(row.locator('a')).toHaveCount(0);

    // It sits after the match targets, not before them. Both rows are
    // asserted present first — `indexOf` returns -1 for a row that
    // regressed away, which would satisfy the comparison vacuously.
    const labels = await page.locator('#header-summary dt').allInnerTexts();
    expect(labels).toContain('Match');
    expect(labels).toContain('Network access');
    expect(labels.indexOf('Network access')).toBeGreaterThan(labels.indexOf('Match'));
    // And the grant that makes it meaningful still gets no row of its own.
    await expect(page.locator('#header-summary')).not.toContainText('GM_xmlhttpRequest');
    await page.close();
  });

  // Each row label carries a tooltip explaining what the row is. Two
  // of them vary — `Version` by mode, and the hosting-site row by site
  // name — which is the part worth pinning.
  test('row labels carry tooltips, with Version differing by mode', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Tipped',
        match: ['https://example.com/*'],
        extra: ['// @version     1.0'],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    const file = path.join(scriptsDir.path, 'a.user.js');

    const page = await extensionContext.newPage();

    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    // Anchored AND scoped: a bare `hasText: 'Version'` also catches
    // `Version at update URL`, and a page-wide `getByText` also catches
    // the Existing-versions panel's `Version` column header.
    await expect(page.locator('#header-summary dt').filter({ hasText: /^Version$/ }))
      .toHaveAttribute('title', 'The @version of the script that is installed and running');
    // A two-sentence tooltip breaks across lines and ends both.
    await expect(page.locator('#header-summary dt', { hasText: 'Status' }))
      .toHaveAttribute(
        'title',
        'Status from loading and executing this script.\nClick to open the Log.',
      );

    // Nothing is installed in a preview, so Version describes the file.
    await page.goto(
      `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`,
    );
    await expect(page.locator('#header-summary dt').filter({ hasText: /^Version$/ }))
      .toHaveAttribute('title', "The script's @version");
    await page.close();
  });

  // A unique log ID is the script's own basename, which the heading
  // and the Location row both already say; the `#N` is the part
  // written nowhere in the file, and it's what a stack trace names.
  test('shows the Log ID row only for a script whose basename collides', async ({
    extensionContext, extensionId, sm,
  }) => {
    const meta = { name: 'Dupe', match: ['https://example.com/*'] };
    scriptsDir.write({ relativePath: 'solo.user.js', meta, body: '' });
    scriptsDir.write({ relativePath: 'sub/dupe.user.js', meta, body: '' });
    scriptsDir.write({ relativePath: 'other/dupe.user.js', meta, body: '' });
    const source = await sm.addSource(scriptsDir.path);
    const scripts = (await sm.getSourceWithScripts(source!.id))!.scripts;
    const solo = scripts.find((s) => s.relativePath.endsWith('solo.user.js'))!;
    const dupe = scripts.find((s) => s.relativePath.endsWith('sub/dupe.user.js'))!;

    const page = await extensionContext.newPage();

    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${solo.id}`);
    await expect(page.locator('#header-summary dt', { hasText: 'Location' })).toHaveCount(1);
    await expect(page.locator('#header-summary dt', { hasText: 'Log ID' })).toHaveCount(0);

    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${dupe.id}`);
    // Which number it drew depends on UUID ordering, so assert the
    // shape rather than a specific one.
    await expect(page.locator('.log-id-cell')).toHaveText(/^dupe\.user\.js#[12]$/);
    await page.close();
  });

  // The script's own byte count understates what a page pays to run it
  // when the script pulls in libraries, so the Size row carries them.
  test('the Size row totals loaded @require and @resource bytes', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.writeRaw('lib/one.js', 'a'.repeat(100));
    scriptsDir.writeRaw('lib/two.js', 'b'.repeat(200));
    scriptsDir.writeRaw('lib/style.css', 'c'.repeat(50));
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Heavy',
        match: ['https://example.com/*'],
        // Relative refs, resolved against the script's own folder —
        // an absolute `file://` `@require` is rejected by design.
        extra: [
          '// @require     lib/one.js',
          '// @require     lib/two.js',
          '// @resource    css lib/style.css',
        ],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts
      .find((s) => s.relativePath === 'a.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    // Plural for the two requires, singular for the one resource.
    await expect(page.locator('#header-summary dt', { hasText: 'Size' }).locator('+ dd'))
      .toContainText('(plus 2 @require files: 300 B, 1 @resource file: 50 B)');
    await page.close();
  });

  test('a script with no dependencies gets no Size suffix', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Light', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    // Asserted positively: a bare `.not.toContainText` would also pass
    // if the Size row disappeared entirely.
    await expect(page.locator('#header-summary dt', { hasText: 'Size' }).locator('+ dd'))
      .toHaveText(/^\d+ B$/);
    await page.close();
  });
});
