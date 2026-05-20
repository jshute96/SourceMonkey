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

  test('addSource scans the dir and records every *.user.js', async ({ vm }) => {
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

    const source = await vm.addSource(scriptsDir.path);
    expect(source).not.toBeNull();
    const result = await vm.getSourceWithScripts(source!.id);
    const paths = result!.scripts.map((s) => s.relativePath).sort();
    expect(paths).toEqual(['a.user.js', 'sub/b.user.js']);
    for (const s of result!.scripts) expect(s.status).toBe('ok');
  });

  test('addSource refuses a duplicate path', async ({ vm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const first = await vm.addSource(scriptsDir.path);
    expect(first).not.toBeNull();
    const second = await vm.addSource(scriptsDir.path);
    expect(second).toBeNull();
    const sources = await vm.getSources();
    expect(sources).toHaveLength(1);
  });

  test('script with missing @name is recorded as error', async ({ vm }) => {
    // Empty `name` makes renderMetadata skip the @name line entirely,
    // which is exactly what we want to exercise validateHeader's
    // missing-@name path.
    scriptsDir.write({
      relativePath: 'bad.user.js',
      meta: { name: '', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await vm.addSource(scriptsDir.path);
    const result = await vm.getSourceWithScripts(source!.id);
    expect(result!.scripts).toHaveLength(1);
    expect(result!.scripts[0].status).toBe('error');
    expect(result!.scripts[0].errorMessage).toMatch(/@name/);
  });

  test('rewriting a script body bumps loadedAt on refresh', async ({ vm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'console.log("v1");',
    });
    const source = await vm.addSource(scriptsDir.path);
    const before = await vm.getSourceWithScripts(source!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;
    const priorBody = before!.scripts[0].bodyText;

    scriptsDir.rewriteBody('a.user.js', 'console.log("v2");');
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBeGreaterThan(priorLoadedAt);
    expect(after!.scripts[0].bodyText).not.toBe(priorBody);
    expect(after!.scripts[0].bodyText).toContain('v2');
  });

  test('refresh skips unchanged files (loadedAt stays put)', async ({ vm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: 'console.log("hi");',
    });
    const source = await vm.addSource(scriptsDir.path);
    const before = await vm.getSourceWithScripts(source!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;

    // No file changes — the size+mtime skip path in fetchOrSkipInParallel
    // should preserve loadedAt verbatim. Sleep briefly to ensure any
    // re-fetch would produce a different loadedAt (epoch ms).
    await new Promise((r) => setTimeout(r, 10));
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBe(priorLoadedAt);
  });

  test('removeSource drops the source row and its scripts', async ({ vm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await vm.addSource(scriptsDir.path);
    expect(await vm.getSourceWithScripts(source!.id)).not.toBeNull();
    await vm.removeSource(source!.id);
    expect(await vm.getSourceWithScripts(source!.id)).toBeNull();
    const sources = await vm.getSources();
    expect(sources).toHaveLength(0);
  });

  test('zero-byte file lands as size=0 status=error (no metadata block)', async ({ vm }) => {
    // A truly empty .user.js used to fail the fetch (empty-body reject)
    // and end up as size=null displayed as MISSING — which conflated an
    // empty file with a vanished one. The fix lets the empty fetch
    // succeed and parse as a "no metadata block" error, with size=0.
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(scriptsDir.path, 'empty.user.js'), '');

    const source = await vm.addSource(scriptsDir.path);
    const ws = await vm.getSourceWithScripts(source!.id);
    expect(ws!.scripts).toHaveLength(1);
    expect(ws!.scripts[0].relativePath).toBe('empty.user.js');
    expect(ws!.scripts[0].status).toBe('error');
    expect(ws!.scripts[0].size).toBe(0);
  });

  test('deleting a file on disk flips its row to missing', async ({ vm }) => {
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
    const source = await vm.addSource(scriptsDir.path);
    const before = await vm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(2);

    scriptsDir.remove('a.user.js');
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
    const byPath = Object.fromEntries(after!.scripts.map((s) => [s.relativePath, s]));
    expect(byPath['a.user.js'].status).toBe('missing');
    expect(byPath['b.user.js'].status).toBe('ok');
  });

  test('unreadable top-level directory preserves scripts and their enabled state', async ({ vm }) => {
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
    const source = await vm.addSource(scriptsDir.path);
    const before = await vm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(2);
    // Disable one of the two so we can later verify enabled state is
    // preserved exactly.
    const aScript = before!.scripts.find((s) => s.relativePath === 'a.user.js')!;
    await vm.setScriptEnabled(aScript.id, false);

    // Blow the directory away so the listing fetch fails on the next
    // refresh (afterEach's cleanup tolerates the missing path).
    scriptsDir.cleanup();
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
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
});
