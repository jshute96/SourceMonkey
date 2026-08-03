// Source lifecycle: add (real file:// scan), refresh (with file
// rewrite on disk), remove (rows vanish from storage and the page
// stops being marked). Exercises the directories.ts pipeline end to
// end, including the unchanged-skip optimisation.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('sources', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('addSource scans the dir and records every *.user.js', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'sub/b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    // A non-userscript file should be ignored by the scan.
    scriptsDir.write({
      relativePath: 'notme.js',
      meta: { name: 'NotMe', match: ['https://example.com/*'] },
      body: '',
    });

    const source = await sm.addSource(scriptsDir.path);
    expect(source).not.toBeNull();
    const result = await sm.getSourceWithScripts(source!.id);
    const paths = result!.scripts.map((s) => s.relativePath).sort();
    expect(paths).toEqual(['a.user.js', 'sub/b.user.js']);
    for (const s of result!.scripts) expect(s.status).toBe('ok');
  });

  test('addSource refuses a duplicate path', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const first = await sm.addSource(scriptsDir.path);
    expect(first).not.toBeNull();
    const second = await sm.addSource(scriptsDir.path);
    expect(second).toBeNull();
    const sources = await sm.getSources();
    expect(sources).toHaveLength(1);
  });

  test('script with missing @name is recorded as error', async ({ sm }) => {
    // Empty `name` makes renderMetadata skip the @name line entirely,
    // which is exactly what we want to exercise validateHeader's
    // missing-@name path.
    scriptsDir.write({
      relativePath: 'bad.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const result = await sm.getSourceWithScripts(source!.id);
    expect(result!.scripts).toHaveLength(1);
    expect(result!.scripts[0].status).toBe('invalid');
    expect(result!.scripts[0].errorMessage).toMatch(/@name/);
  });

  test('rewriting a script body bumps loadedAt on refresh', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'console.log("v1");',
    });
    const source = await sm.addSource(scriptsDir.path);
    const before = await sm.getSourceWithScripts(source!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;
    const priorBody = before!.scripts[0].bodyText;

    scriptsDir.rewriteBody('a.user.js', 'console.log("v2");');
    await sm.updateSource(source!.id, 'manual');

    const after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBeGreaterThan(priorLoadedAt);
    expect(after!.scripts[0].bodyText).not.toBe(priorBody);
    expect(after!.scripts[0].bodyText).toContain('v2');
  });

  test('refresh skips unchanged files (loadedAt stays put)', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'console.log("hi");',
    });
    const source = await sm.addSource(scriptsDir.path);
    const before = await sm.getSourceWithScripts(source!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;

    // No file changes — the size+mtime skip path in fetchOrSkipInParallel
    // should preserve loadedAt verbatim. Sleep briefly to ensure any
    // re-fetch would produce a different loadedAt (epoch ms).
    await new Promise((r) => setTimeout(r, 10));
    await sm.updateSource(source!.id, 'manual');

    const after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBe(priorLoadedAt);
  });

  test('removeSource drops the source row and its scripts', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    expect(await sm.getSourceWithScripts(source!.id)).not.toBeNull();
    await sm.removeSource(source!.id);
    expect(await sm.getSourceWithScripts(source!.id)).toBeNull();
    const sources = await sm.getSources();
    expect(sources).toHaveLength(0);
  });

  test('zero-byte file lands as size=0 status=error (no metadata block)', async ({ sm }) => {
    // A truly empty .user.js used to fail the fetch (empty-body reject)
    // and end up as size=null displayed as MISSING — which conflated an
    // empty file with a vanished one. The fix lets the empty fetch
    // succeed and parse as a "no metadata block" error, with size=0.
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(scriptsDir.path, 'empty.user.js'), '');

    const source = await sm.addSource(scriptsDir.path);
    const ws = await sm.getSourceWithScripts(source!.id);
    expect(ws!.scripts).toHaveLength(1);
    expect(ws!.scripts[0].relativePath).toBe('empty.user.js');
    expect(ws!.scripts[0].status).toBe('invalid');
    expect(ws!.scripts[0].size).toBe(0);
  });

  test('deleting a file on disk flips its row to missing', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const before = await sm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(2);

    scriptsDir.remove('a.user.js');
    await sm.updateSource(source!.id, 'manual');

    const after = await sm.getSourceWithScripts(source!.id);
    const byPath = Object.fromEntries(after!.scripts.map((s) => [s.relativePath, s]));
    expect(byPath['a.user.js'].status).toBe('missing');
    expect(byPath['b.user.js'].status).toBe('ok');
  });

  test('unreadable top-level directory preserves scripts and their enabled state', async ({ sm }) => {
    // Models a remote mount whose credentials timed out: the directory
    // listing fails, but the user's scripts shouldn't get auto-disabled
    // just because we can't enumerate the source right now.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const before = await sm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(2);
    // Disable one of the two so we can later verify enabled state is
    // preserved exactly.
    const aScript = before!.scripts.find((s) => s.relativePath === 'a.user.js')!;
    await sm.setScriptEnabled(aScript.id, false);

    // Blow the directory away so the listing fetch fails on the next
    // refresh (afterEach's cleanup tolerates the missing path).
    scriptsDir.cleanup();
    await sm.updateSource(source!.id, 'manual');

    const after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts).toHaveLength(2);
    const afterByPath = Object.fromEntries(
      after!.scripts.map((s) => [s.relativePath, s]),
    );
    expect(afterByPath['a.user.js'].status).toBe('ok');
    expect(afterByPath['a.user.js'].enabled).toBe(false);
    expect(afterByPath['b.user.js'].status).toBe('ok');
    expect(afterByPath['b.user.js'].enabled).toBe(true);
    expect(after!.source.scanError).toBeDefined();
  });

  test('an on-disk name containing %20 is shown literally, not decoded', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The mirror image of the URL case: names from a local directory
    // are literal, so the file really called `a%20b.user.js` must read
    // that way in the viewer and on the sources page. Decoding it here
    // would show a name that matches nothing on disk. See
    // docs/names-and-paths.md.
    scriptsDir.write({
      relativePath: 'a%20b.user.js',
      meta: { name: 'Literal Percent', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts[0];
    expect(script.relativePath).toBe('a%20b.user.js');

    const viewer = await extensionContext.newPage();
    await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await expect(viewer.locator('h1#filename')).toHaveText('a%20b.user.js');
    await expect(viewer.locator('.log-id-cell')).toHaveText('a%20b.user.js');
    await viewer.close();

    const sources = await extensionContext.newPage();
    await sources.goto(`chrome-extension://${extensionId}/sources.html`);
    // `.name-cell a` also matches the favicon slot's link, so target
    // the filename anchor by its viewer href.
    await expect(sources.locator(`tr[data-script-id="${script.id}"] .name-cell a[href*="userscript.html"]`))
      .toHaveText('a%20b.user.js');
    await sources.close();
  });

  test('a very long script name wraps inside its card instead of widening the table', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Web-installed scripts routinely carry a whole marketing title as
    // their filename. A `nowrap` name cell made the table wider than
    // its `.directory` card, pushing Size / Status outside the border.
    // See docs/names-and-paths.md.
    const longName =
      'YouTube Ultimate Downloader v132 - All-in-One Media Suite - Ad-Free + SponsorBlock.user.js';
    scriptsDir.write({
      relativePath: longName,
      meta: { name: 'Long', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/sources.html`);

    const card = page.locator(`section.directory[data-source-id="${source!.id}"]`);
    const row = card.locator(`tr[data-script-id="${script.id}"]`);
    const cardBox = (await card.boundingBox())!;
    const statusBox = (await row.locator('td.status-cell').boundingBox())!;
    // The last column has to stay inside the card. Sub-pixel layout
    // rounding makes an exact compare flaky, hence the 1px slack.
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);

    // The name really did wrap (>1 line box), and the hanging indent
    // put every line at the same left edge — i.e. continuation lines
    // align with the first line's text rather than under the favicon.
    const rects = await row.locator('.name-cell a[href*="userscript.html"]').evaluate(
      (el) => [...el.getClientRects()].map((r) => r.left),
    );
    expect(rects.length).toBeGreaterThan(1);
    for (const left of rects) expect(Math.abs(left - rects[0])).toBeLessThan(1);
    await page.close();
  });
});
