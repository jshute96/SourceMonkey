// End-to-end behavior for manifest sources:
//   - Refresh updates the script list to match the manifest's entries.
//   - Entries the user removed from the manifest get DELETED (no
//     'missing' tombstone — manifests are the user's source of truth).
//   - When the manifest itself can't be read, the collection records a
//     scanError but leaves every script (and its enabled state)
//     untouched.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

function writeManifest(dir: string, entries: string[]): string {
  const manifestPath = path.join(dir, 'script_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(entries));
  return manifestPath;
}

test.describe('manifest collection refresh', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('removing an entry from the manifest deletes its script row', async ({ sm }) => {
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

    const collection = await sm.addCollection(manifestPath);
    expect(collection).not.toBeNull();
    const before = await sm.getCollectionWithScripts(collection!.id);
    expect(before!.scripts.map((s) => s.relativePath).sort()).toEqual([
      'a.user.js',
      'b.user.js',
    ]);

    // Drop b.user.js from the manifest and refresh.
    writeManifest(scriptsDir.path, ['a.user.js']);
    await sm.updateCollection(collection!.id, 'manual');

    const after = await sm.getCollectionWithScripts(collection!.id);
    // b.user.js is gone entirely — not marked missing, not in the list.
    const paths = after!.scripts.map((s) => s.relativePath);
    expect(paths).toEqual(['a.user.js']);
    expect(after!.collection.scanError).toBeUndefined();
  });

  test('manifest entry pointing at a missing file shows as error', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    // Manifest lists a script that doesn't exist on disk.
    const manifestPath = writeManifest(scriptsDir.path, ['a.user.js', 'gone.user.js']);

    const collection = await sm.addCollection(manifestPath);
    const result = await sm.getCollectionWithScripts(collection!.id);
    const byPath = Object.fromEntries(
      result!.scripts.map((s) => [s.relativePath, s]),
    );
    expect(byPath['a.user.js'].status).toBe('ok');
    expect(byPath['gone.user.js'].status).toBe('invalid');
  });

  test('unreadable manifest preserves scripts and their enabled state', async ({ sm }) => {
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

    const collection = await sm.addCollection(manifestPath);
    const before = await sm.getCollectionWithScripts(collection!.id);
    expect(before!.scripts).toHaveLength(2);
    // User disables one of the two scripts.
    const aScript = before!.scripts.find((s) => s.relativePath === 'a.user.js')!;
    await sm.setScriptEnabled(aScript.id, false);

    // Corrupt the manifest so the next refresh's JSON.parse fails.
    fs.writeFileSync(manifestPath, 'not valid json {{{');
    await sm.updateCollection(collection!.id, 'manual');

    const after = await sm.getCollectionWithScripts(collection!.id);
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
    // The scanError surfaces on the collection row so the collections page can
    // show it.
    expect(after!.collection.scanError).toBeDefined();
    expect(after!.collection.scanError).toMatch(/JSON|manifest/i);
  });

  test('manifest fetch failure (missing file) also preserves scripts', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/*'] },
      body: '',
    });
    const manifestPath = writeManifest(scriptsDir.path, ['a.user.js']);

    const collection = await sm.addCollection(manifestPath);
    const before = await sm.getCollectionWithScripts(collection!.id);
    expect(before!.scripts).toHaveLength(1);

    // Delete the manifest entirely; the next refresh's fetch fails.
    fs.rmSync(manifestPath);
    await sm.updateCollection(collection!.id, 'manual');

    const after = await sm.getCollectionWithScripts(collection!.id);
    expect(after!.scripts).toHaveLength(1);
    expect(after!.scripts[0].relativePath).toBe('a.user.js');
    expect(after!.scripts[0].status).toBe('ok');
    expect(after!.collection.scanError).toBeDefined();
  });
});
