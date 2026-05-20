// End-to-end behavior for manifest sources:
//   - Refresh updates the script list to match the manifest's entries.
//   - Entries the user removed from the manifest get DELETED (no
//     'missing' tombstone — manifests are the user's source of truth).
//   - When the manifest itself can't be read, the source records a
//     scanError but leaves every script (and its enabled state)
//     untouched.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

function writeManifest(dir: string, entries: string[]): string {
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(entries));
  return manifestPath;
}

test.describe('manifest source refresh', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('removing an entry from the manifest deletes its script row', async ({ vm }) => {
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
    const manifestPath = writeManifest(scriptsDir.path, ['a.user.js', 'b.user.js']);

    const source = await vm.addSource(manifestPath);
    expect(source).not.toBeNull();
    const before = await vm.getSourceWithScripts(source!.id);
    expect(before!.scripts.map((s) => s.relativePath).sort()).toEqual([
      'a.user.js',
      'b.user.js',
    ]);

    // Drop b.user.js from the manifest and refresh.
    writeManifest(scriptsDir.path, ['a.user.js']);
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
    // b.user.js is gone entirely — not marked missing, not in the list.
    const paths = after!.scripts.map((s) => s.relativePath);
    expect(paths).toEqual(['a.user.js']);
    expect(after!.source.scanError).toBeUndefined();
  });

  test('manifest entry pointing at a missing file shows as error', async ({ vm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    // Manifest lists a script that doesn't exist on disk.
    const manifestPath = writeManifest(scriptsDir.path, ['a.user.js', 'gone.user.js']);

    const source = await vm.addSource(manifestPath);
    const result = await vm.getSourceWithScripts(source!.id);
    const byPath = Object.fromEntries(
      result!.scripts.map((s) => [s.relativePath, s]),
    );
    expect(byPath['a.user.js'].status).toBe('ok');
    expect(byPath['gone.user.js'].status).toBe('error');
  });

  test('unreadable manifest preserves scripts and their enabled state', async ({ vm }) => {
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
    const manifestPath = writeManifest(scriptsDir.path, ['a.user.js', 'b.user.js']);

    const source = await vm.addSource(manifestPath);
    const before = await vm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(2);
    // User disables one of the two scripts.
    const aScript = before!.scripts.find((s) => s.relativePath === 'a.user.js')!;
    await vm.setScriptEnabled(aScript.id, false);

    // Corrupt the manifest so the next refresh's JSON.parse fails.
    fs.writeFileSync(manifestPath, 'not valid json {{{');
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
    // Scripts are unchanged: same set, content preserved, enabled
    // state preserved (a is still disabled, b is still enabled).
    expect(after!.scripts).toHaveLength(2);
    const afterByPath = Object.fromEntries(
      after!.scripts.map((s) => [s.relativePath, s]),
    );
    expect(afterByPath['a.user.js'].status).toBe('ok');
    expect(afterByPath['a.user.js'].enabled).toBe(false);
    expect(afterByPath['b.user.js'].status).toBe('ok');
    expect(afterByPath['b.user.js'].enabled).toBe(true);
    // The scanError surfaces on the source row so the options page can
    // show it.
    expect(after!.source.scanError).toBeDefined();
    expect(after!.source.scanError).toMatch(/JSON|manifest/i);
  });

  test('manifest fetch failure (missing file) also preserves scripts', async ({ vm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const manifestPath = writeManifest(scriptsDir.path, ['a.user.js']);

    const source = await vm.addSource(manifestPath);
    const before = await vm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(1);

    // Delete the manifest entirely; the next refresh's fetch fails.
    fs.rmSync(manifestPath);
    await vm.updateSource(source!.id, 'manual');

    const after = await vm.getSourceWithScripts(source!.id);
    expect(after!.scripts).toHaveLength(1);
    expect(after!.scripts[0].relativePath).toBe('a.user.js');
    expect(after!.scripts[0].status).toBe('ok');
    expect(after!.source.scanError).toBeDefined();
  });
});
