// Collection lifecycle: add (real file:// scan), refresh (with file
// rewrite on disk), remove (rows vanish from storage and the page
// stops being marked). Exercises the directories.ts pipeline end to
// end, including the unchanged-skip optimisation.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import fs from 'node:fs';

test.describe('collections', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('addCollection scans the dir and records every *.user.js', async ({ sm }) => {
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

    const collection = await sm.addCollection(scriptsDir.path);
    expect(collection).not.toBeNull();
    const result = await sm.getCollectionWithScripts(collection!.id);
    const paths = result!.scripts.map((s) => s.relativePath).sort();
    expect(paths).toEqual(['a.user.js', 'sub/b.user.js']);
    for (const s of result!.scripts) expect(s.status).toBe('ok');
  });

  test('addCollection refuses a duplicate path', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const first = await sm.addCollection(scriptsDir.path);
    expect(first).not.toBeNull();
    const second = await sm.addCollection(scriptsDir.path);
    expect(second).toBeNull();
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
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
    const collection = await sm.addCollection(scriptsDir.path);
    const result = await sm.getCollectionWithScripts(collection!.id);
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
    const collection = await sm.addCollection(scriptsDir.path);
    const before = await sm.getCollectionWithScripts(collection!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;
    const priorBody = before!.scripts[0].bodyText;

    scriptsDir.rewriteBody('a.user.js', 'console.log("v2");');
    await sm.updateCollection(collection!.id, 'manual');

    const after = await sm.getCollectionWithScripts(collection!.id);
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
    const collection = await sm.addCollection(scriptsDir.path);
    const before = await sm.getCollectionWithScripts(collection!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;

    // No file changes — the size+mtime skip path in fetchOrSkipInParallel
    // should preserve loadedAt verbatim. Sleep briefly to ensure any
    // re-fetch would produce a different loadedAt (epoch ms).
    await new Promise((r) => setTimeout(r, 10));
    await sm.updateCollection(collection!.id, 'manual');

    const after = await sm.getCollectionWithScripts(collection!.id);
    expect(after!.scripts[0].loadedAt).toBe(priorLoadedAt);
  });

  test('removeCollection drops the collection row and its scripts', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    expect(await sm.getCollectionWithScripts(collection!.id)).not.toBeNull();
    await sm.removeCollection(collection!.id);
    expect(await sm.getCollectionWithScripts(collection!.id)).toBeNull();
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(0);
  });

  test('zero-byte file lands as size=0 status=error (no metadata block)', async ({ sm }) => {
    // A truly empty .user.js used to fail the fetch (empty-body reject)
    // and end up as size=null displayed as MISSING — which conflated an
    // empty file with a vanished one. The fix lets the empty fetch
    // succeed and parse as a "no metadata block" error, with size=0.
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(scriptsDir.path, 'empty.user.js'), '');

    const collection = await sm.addCollection(scriptsDir.path);
    const ws = await sm.getCollectionWithScripts(collection!.id);
    expect(ws!.scripts).toHaveLength(1);
    expect(ws!.scripts[0].relativePath).toBe('empty.user.js');
    expect(ws!.scripts[0].status).toBe('invalid');
    expect(ws!.scripts[0].size).toBe(0);
  });

  test('deleting a file on disk drops its row while others remain', async ({ sm }) => {
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
    const collection = await sm.addCollection(scriptsDir.path);
    const before = await sm.getCollectionWithScripts(collection!.id);
    expect(before!.scripts).toHaveLength(2);

    scriptsDir.remove('a.user.js');
    await sm.updateCollection(collection!.id, 'manual');

    // The scan still listed b.user.js, so it is authoritative about
    // a.user.js being gone — the row goes rather than lingering as
    // `missing` for the user to trash by hand.
    const after = await sm.getCollectionWithScripts(collection!.id);
    expect(after!.scripts.map((s) => s.relativePath)).toEqual(['b.user.js']);
    expect(after!.scripts[0].status).toBe('ok');
  });

  test('a dropped row takes its log with it', async ({ sm }) => {
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
    const collection = await sm.addCollection(scriptsDir.path);
    const before = await sm.getCollectionWithScripts(collection!.id);
    const goingAway = before!.scripts.find((s) => s.relativePath === 'b.user.js')!;
    await sm.appendScriptLog(goingAway.id, {
      level: 'info', source: 'test', message: 'hello',
    });
    expect(await sm.getScriptLog(goingAway.id)).toHaveLength(1);

    scriptsDir.remove('b.user.js');
    await sm.updateCollection(collection!.id, 'manual');

    // The session-storage log goes with the row — otherwise it would
    // outlive the script it described.
    expect(await sm.getScriptLog(goingAway.id)).toHaveLength(0);
  });

  test('a single-script check drops a file the directory no longer lists', async ({ sm }) => {
    // The per-script refresh (navigation, tab focus, the viewer's
    // Refresh) lists the parent directory for size+mtime anyway, so a
    // file that has gone is dropped there too — the same outcome as a
    // collection refresh, rather than a "refresh failed" row that
    // keeps running from its cached body.
    for (const name of ['a.user.js', 'b.user.js']) {
      scriptsDir.write({
        relativePath: name,
        meta: { name, match: ['https://example.com/*'] },
        body: '',
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    const rows = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const a = rows.find((s) => s.relativePath === 'a.user.js')!;

    scriptsDir.remove('a.user.js');
    await sm.updateScript(a.id, 'manual', 'force');
    const after = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    expect(after.map((s) => s.relativePath)).toEqual(['b.user.js']);
    expect(await sm.getScriptLog(a.id)).toHaveLength(0);
  });

  test('emptying the directory drops the rows; losing the directory keeps them', async ({ sm }) => {
    // A directory collection mirrors its directory: a successful scan
    // that finds nothing drops every row, the same as an empty
    // manifest. A directory that can't be listed at all is a scan
    // failure, and a failed scan leaves every row alone — the two are
    // told apart by whether Chrome returned a listing page.
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
    const collection = await sm.addCollection(scriptsDir.path);
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts).toHaveLength(2);

    // The directory itself goes away: Chrome answers with an error
    // page, not a listing, so nothing is dropped.
    const parked = `${scriptsDir.path}.parked`;
    fs.renameSync(scriptsDir.path, parked);
    try {
      await sm.updateCollection(collection!.id, 'manual');
      const lost = await sm.getCollectionWithScripts(collection!.id);
      expect(lost!.scripts.map((s) => s.relativePath).sort()).toEqual(['a.user.js', 'b.user.js']);
      expect(lost!.scripts.every((s) => s.status === 'ok')).toBe(true);
      expect(lost!.collection.scanError).toBeTruthy();
    } finally {
      fs.renameSync(parked, scriptsDir.path);
    }

    // Back, and emptied: an empty listing is a real answer.
    scriptsDir.remove('a.user.js');
    scriptsDir.remove('b.user.js');
    await sm.updateCollection(collection!.id, 'manual');
    const after = await sm.getCollectionWithScripts(collection!.id);
    expect(after!.scripts).toHaveLength(0);
    expect(after!.collection.scanError).toBeFalsy();
  });

  test('unreadable top-level directory preserves scripts and their enabled state', async ({ sm }) => {
    // Models a remote mount whose credentials timed out: the directory
    // listing fails, but the user's scripts shouldn't get auto-disabled
    // just because we can't enumerate the collection right now.
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
    const collection = await sm.addCollection(scriptsDir.path);
    const before = await sm.getCollectionWithScripts(collection!.id);
    expect(before!.scripts).toHaveLength(2);
    // Disable one of the two so we can later verify enabled state is
    // preserved exactly.
    const aScript = before!.scripts.find((s) => s.relativePath === 'a.user.js')!;
    await sm.setScriptEnabled(aScript.id, false);

    // Blow the directory away so the listing fetch fails on the next
    // refresh (afterEach's cleanup tolerates the missing path).
    scriptsDir.cleanup();
    await sm.updateCollection(collection!.id, 'manual');

    const after = await sm.getCollectionWithScripts(collection!.id);
    expect(after!.scripts).toHaveLength(2);
    const afterByPath = Object.fromEntries(
      after!.scripts.map((s) => [s.relativePath, s]),
    );
    expect(afterByPath['a.user.js'].status).toBe('ok');
    expect(afterByPath['a.user.js'].enabled).toBe(false);
    expect(afterByPath['b.user.js'].status).toBe('ok');
    expect(afterByPath['b.user.js'].enabled).toBe(true);
    expect(after!.collection.scanError).toBeDefined();
  });

  test('an on-disk name containing %20 is shown literally, not decoded', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The mirror image of the URL case: names from a local directory
    // are literal, so the file really called `a%20b.user.js` must read
    // that way in the viewer and on the collections page. Decoding it here
    // would show a name that matches nothing on disk. See
    // docs/names-and-paths.md.
    // No `@name`, so the collections page falls back to the location —
    // which is what this test wants to read.
    scriptsDir.write({
      relativePath: 'a%20b.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const got = await sm.getCollectionWithScripts(collection!.id);
    const script = got!.scripts[0];
    expect(script.relativePath).toBe('a%20b.user.js');

    const viewer = await extensionContext.newPage();
    await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await expect(viewer.locator('h1#filename')).toHaveText('SourceMonkey | a%20b.user.js');
    await viewer.close();

    const collections = await extensionContext.newPage();
    await collections.goto(`chrome-extension://${extensionId}/collections.html`);
    // `.name-cell a` also matches the favicon slot's link, so target
    // the name anchor by its viewer href.
    const nameLink = collections.locator(
      `tr[data-script-id="${script.id}"] .name-cell a[href*="userscript.html"]`,
    );
    await expect(nameLink).toHaveText('a%20b.user.js');
    // …and the tooltip leads with the same literal location.
    await expect(nameLink).toHaveAttribute('title', /^a%20b\.user\.js\n/);
    await collections.close();
  });

  test('a very long script name wraps inside its card instead of widening the table', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Web-installed scripts routinely carry a whole marketing title as
    // their `@name`. A `nowrap` name cell made the table wider than
    // its `.directory` card, pushing Size / Status outside the border.
    // See docs/names-and-paths.md.
    const longName =
      'YouTube Ultimate Downloader v132 - All-in-One Media Suite - Ad-Free + SponsorBlock';
    scriptsDir.write({
      relativePath: `${longName}.user.js`,
      meta: { name: longName, match: ['https://example.com/*'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    const card = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
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

// Collections were called "sources" before the August 2026 rename, which
// moved the index row, the per-collection rows, and each script's parent
// pointer. A profile written before it has to survive the upgrade — see
// `ensureCollectionKeysMigrated` in src/script-store.ts and the
// removal note in TODO.md.
test.describe('legacy source:* key migration', () => {
  test('a pre-rename profile is rewritten on the first read', async ({
    sm, getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    // Write the old spelling straight into storage, bypassing the store.
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        sources: ['c1'],
        'source:c1': {
          id: 'c1',
          path: '/legacy/dir',
          lastRefreshedAt: 0,
          scriptIds: ['s1'],
          enabled: true,
        },
        'script:s1': {
          id: 's1',
          sourceId: 'c1',
          relativePath: 'a.user.js',
          fileUrl: 'file:///legacy/dir/a.user.js',
          status: 'ok',
          size: 1,
          headerText: '',
          bodyText: '',
          header: null,
          matching: { matches: ['https://example.com/*'], excludes: [], includes: [] },
          loadedAt: 1,
          enabled: true,
        },
      });
    });

    // Any read through the store triggers the migration.
    const collections = await sm.getCollections();
    expect(collections.map((c) => c.id)).toEqual(['c1']);

    const withScripts = await sm.getCollectionWithScripts('c1');
    expect(withScripts!.scripts.map((s) => s.id)).toEqual(['s1']);
    expect((withScripts!.scripts[0] as { collectionId?: string }).collectionId).toBe('c1');

    // The old rows are gone, and the new ones carry the same values.
    const raw = await sw.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return {
        keys: Object.keys(all).filter((k) => k === 'sources' || k.startsWith('source:')),
        newIndex: all.collections,
        script: all['script:s1'] as { sourceId?: string; collectionId?: string },
      };
    });
    expect(raw.keys).toEqual([]);
    expect(raw.newIndex).toEqual(['c1']);
    expect(raw.script.sourceId).toBeUndefined();
    expect(raw.script.collectionId).toBe('c1');
  });
});
