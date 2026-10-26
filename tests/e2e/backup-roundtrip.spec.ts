// A SourceMonkey export restored into an empty SourceMonkey gives back
// what was exported: every kind of collection, and scripts of every
// kind in them, with their enabled states, text, dependencies and
// values. Then a refresh of the restored collections keeps each
// script's row and values. See docs/import.md#restoring-collections.
//
// GitHub and web scripts come from routes on made-up hosts, so nothing
// here reaches the network.
import { testWithBrowserDownloads as test, expect } from '../fixtures/extension';
import type { BrowserContext, Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';
import {
  closeExport, closeImport, collectionRows, confirmImport, exportVia, IMPORT_DIALOG, importVia, newCollections, openImport,
} from '../fixtures/backup-dialogs';
import fs from 'node:fs';
import path from 'node:path';

type Sm = Parameters<Parameters<typeof test>[2]>[0]['sm'];
type GetSw = Parameters<Parameters<typeof test>[2]>[0]['getServiceWorker'];

const WEB = 'https://sm-roundtrip.invalid';
const GH_OWNER = 'sm-test';
const GH_REPO = 'roundtrip';
const GH_TREE = `https://github.com/${GH_OWNER}/${GH_REPO}/tree/main/scripts`;

function userscript(name: string, extra = '', body = 'void 0;'): string {
  return `// ==UserScript==\n// @name        ${name}\n// @namespace   sm-roundtrip\n// @version     1.0\n// @match       https://example.com/*\n${extra}// @grant       GM_setValue\n// ==/UserScript==\n${body}\n`;
}

// Web scripts and libraries, and a GitHub folder: `scripts/` holds
// gh-a.user.js and nested/gh-b.user.js.
const WEB_FILES: Record<string, string> = {
  '/web.user.js': userscript('Web', `// @require     ${WEB}/lib/shared.js\n`),
  '/mine-web.user.js': userscript('MineWeb'),
  '/lib/shared.js': 'window.shared = 1;\n',
};
const GH_FILES: Record<string, string> = {
  'scripts/gh-a.user.js': userscript('GhA'),
  'scripts/nested/gh-b.user.js': userscript('GhB'),
};

async function routeFakeHosts(context: BrowserContext): Promise<void> {
  await context.route(`${WEB}/**`, async (route) => {
    const body = WEB_FILES[new URL(route.request().url()).pathname];
    await (body === undefined ? route.fulfill({ status: 404, body: 'Not found' }) : route.fulfill({ contentType: 'text/javascript', body }));
  });
  // The Contents API lists a folder; raw.githubusercontent serves a file.
  await context.route('https://api.github.com/repos/**', async (route) => {
    const url = new URL(route.request().url());
    const prefix = `/repos/${GH_OWNER}/${GH_REPO}/contents/`;
    if (!url.pathname.startsWith(prefix)) return route.fulfill({ status: 404, body: '{}' });
    const dir = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/$/, '');
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; size?: number }>();
    for (const [file, text] of Object.entries(GH_FILES)) {
      if (!file.startsWith(`${dir}/`)) continue;
      const [first, ...rest] = file.slice(dir.length + 1).split('/');
      const p = `${dir}/${first}`;
      entries.set(first, rest.length > 0 ? { type: 'dir', name: first, path: p } : { type: 'file', name: first, path: p, size: text.length });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([...entries.values()]) });
  });
  await context.route(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/**`, async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').slice(4).join('/');
    const body = GH_FILES[file];
    await (body === undefined ? route.fulfill({ status: 404, body: 'Not found' }) : route.fulfill({ contentType: 'text/plain', body }));
  });
}

// Everything a restore should bring back, without ids or times. An
// imported script's location has a random tag, so that is left out.
async function snapshot(sm: Sm, getServiceWorker: GetSw): Promise<unknown> {
  const sw = await getServiceWorker();
  const rows = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const index = (all['collections'] ?? []) as string[];
    return index.map((id) => all[`collection:${id}`]) as { id: string; path: string; enabled: boolean; displayName?: string; localFiles?: boolean }[];
  });
  const out = [];
  for (const c of rows) {
    const { scripts } = (await sm.getCollectionWithScripts(c.id))!;
    const list = [];
    for (const s of scripts) {
      list.push({
        relativePath: s.relativePath.replace(/^imported:\/\/\/[0-9a-f]+\//, 'imported:///*/'),
        status: s.status,
        enabled: s.enabled,
        text: s.headerText + s.bodyText,
        requires: (s.requires ?? []).map((r) => [r.ref, r.source]),
        values: await sm.getGmValues(s.id),
      });
    }
    out.push({
      name: c.displayName,
      path: c.path.startsWith('container:') && !/^container:(file|http|github)$/.test(c.path) ? 'container:*' : c.path,
      enabled: c.enabled !== false,
      localFiles: c.localFiles !== false,
      scripts: list,
    });
  }
  return out;
}

async function collectionsPage(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/collections.html`);
  await expect(page.locator('#page-menu')).toBeVisible();
}

test.describe('backup round trip', () => {
  let dir: ScriptsDir;
  let manifestDir: ScriptsDir;
  let looseDir: ScriptsDir;
  test.beforeEach(() => {
    dir = ScriptsDir.create();
    manifestDir = ScriptsDir.create();
    looseDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    for (const d of [dir, manifestDir, looseDir]) d.cleanup();
  });

  test('an export restored into an empty SourceMonkey gives back every collection and script', async ({
    extensionContext, extensionId, sm, getServiceWorker,
  }) => {
    await routeFakeHosts(extensionContext);
    const write = (d: ScriptsDir, rel: string, text: string): string => {
      const file = path.join(d.path, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    };

    // A local directory: a script with a local and a web @require, a
    // disabled one in a subfolder, one whose header doesn't parse, and
    // an empty file.
    write(dir, 'lib/util.js', 'window.util = 1;\n');
    write(dir, 'alpha.user.js', userscript('Alpha', `// @require     lib/util.js\n// @require     ${WEB}/lib/shared.js\n`));
    write(dir, 'sub/beta.user.js', userscript('Beta'));
    write(dir, 'broken.user.js', '// ==UserScript==\n// @name Broken\nvoid 0;\n');
    write(dir, 'empty.user.js', '');
    const local = (await sm.addCollection(dir.path))!;

    // A manifest whose entries are spelled two ways; it is off, and
    // doesn't use local files.
    write(manifestDir, 'm1.user.js', userscript('M1'));
    write(manifestDir, 'sub/m2.user.js', userscript('M2'));
    write(manifestDir, 'script_manifest.json', JSON.stringify({ scripts: [{ path: './m1.user.js' }, { path: 'sub/m2.user.js' }] }));
    const manifest = (await sm.addCollection(path.join(manifestDir.path, 'script_manifest.json')))!;
    await sm.setCollectionEnabled(manifest.id, false);
    await sm.setCollectionLocalFiles(manifest.id, false);

    // A GitHub folder.
    const github = (await sm.addCollection(GH_TREE))!;

    // The built-in collections for web and local scripts.
    await sm.addCollection(`${WEB}/web.user.js`);
    await sm.addCollection(write(looseDir, 'loose.user.js', userscript('Loose')));

    // A scripts collection of the user's: a local file, a web script,
    // and one kept as text (imported earlier).
    const mine = (await sm.createCollection({ kind: 'scripts', name: 'Mine' }))!;
    await sm.installScript(write(looseDir, 'mine-file.user.js', userscript('MineFile')), { collectionId: mine.id });
    await sm.installScript(`${WEB}/mine-web.user.js`, { collectionId: mine.id });
    const tmJson = path.join(looseDir.path, 'tm.txt');
    fs.writeFileSync(tmJson, JSON.stringify({
      created_by: 'Tampermonkey', version: '1',
      scripts: [{ name: 'Kept', uuid: 'tm-1', enabled: true, position: 1, source: Buffer.from(userscript('Kept')).toString('base64'), options: {} }],
    }));
    const page = await extensionContext.newPage();
    await collectionsPage(page, extensionId);
    await importVia(page, '#page-menu', tmJson, { into: 'Mine' });

    // Values and enabled states across them.
    const byName = async (collectionId: string, name: string): Promise<string> => {
      const { scripts } = (await sm.getCollectionWithScripts(collectionId))!;
      const found = scripts.find((s) => s.header?.tags.some((t) => t.tag === 'name' && t.value === name));
      if (!found) throw new Error(`No ${name}`);
      return found.id;
    };
    await sm.writeGmValues(await byName(local.id, 'Alpha'), [{ key: 'theme', value: 'dark' }, { key: 'n', value: 2 }, { key: 'o', value: { a: [1] } }]);
    await sm.setScriptEnabled(await byName(local.id, 'Beta'), false);
    await sm.writeGmValues(await byName(manifest.id, 'M2'), [{ key: 'm', value: true }]);
    await sm.writeGmValues(await byName(github.id, 'GhB'), [{ key: 'g', value: 'b' }]);
    await sm.setScriptEnabled(await byName(github.id, 'GhA'), false);
    await sm.writeGmValues(await byName(mine.id, 'Kept'), [{ key: 'k', value: 'kept' }]);
    await sm.writeGmValues(await byName(mine.id, 'MineWeb'), [{ key: 'w', value: 1 }]);
    await sm.syncNow();

    const before = await snapshot(sm, getServiceWorker);
    await collectionsPage(page, extensionId);
    const saved = await exportVia(page, '#page-menu', { files: true });
    await closeExport(page);

    await sm.resetAllState();
    expect(await sm.getCollections()).toEqual([]);
    await collectionsPage(page, extensionId);
    await openImport(page, '#page-menu', saved);
    // Directory, manifest and GitHub collections restore; scripts
    // collections' scripts are new scripts, which go back into them.
    expect((await collectionRows(page)).map((r) => [r.name, r.kind, r.status, r.restore])).toEqual([
      [dir.path, 'Directory', 'New', true],
      [expect.any(String), 'Manifest', 'New', true],
      [expect.any(String), 'GitHub', 'New', true],
    ]);
    const fromScriptsCollections = await newCollections(page);
    expect(fromScriptsCollections.map((c) => c.name.endsWith(' (New)'))).toEqual(fromScriptsCollections.map(() => true));
    await expect(page.locator(`${IMPORT_DIALOG} #import-new-by-collection`)).toBeChecked();
    // The heading's box clears and checks them all.
    const all = page.locator(`${IMPORT_DIALOG} #import-collections-table thead input`);
    await all.uncheck();
    expect((await collectionRows(page)).map((r) => r.restore)).toEqual([false, false, false]);
    await all.check();
    expect((await collectionRows(page)).map((r) => r.restore)).toEqual([true, true, true]);
    // Not restoring the directory, its scripts import one by one, but
    // the empty one can't: it's listed as invalid. They have no scripts
    // collection, so all new scripts go into the one picked.
    const localBox = page.locator(`${IMPORT_DIALOG} #import-collections-table tbody tr`).first().locator('input');
    await localBox.uncheck();
    await expect(page.locator(`${IMPORT_DIALOG} #import-new-table .import-name`))
      .toHaveText(['Alpha', 'broken', 'Beta', 'Web', 'Loose', 'MineFile', 'MineWeb', 'Kept']);
    await expect(page.locator(`${IMPORT_DIALOG} #import-invalid-table tbody tr`)).toHaveText(['emptyThe script is empty']);
    await expect(page.locator(`${IMPORT_DIALOG} #import-new-by-collection`)).toBeHidden();
    expect(await newCollections(page)).toEqual([]);
    await localBox.check();
    await expect(page.locator(`${IMPORT_DIALOG} #import-invalid`)).toBeHidden();
    expect(await newCollections(page)).toEqual(fromScriptsCollections);
    const result = await confirmImport(page);
    await closeImport(page);
    expect(result).toBe(`Restored 3 collections with 8 scripts.\n\nImported ${fromScriptsCollections.length} scripts.`);
    expect(await snapshot(sm, getServiceWorker)).toEqual(before);

    // The next refresh of each finds the same rows: same ids, values kept.
    const ids = async (): Promise<string[]> => (await sm.getCollections()).flatMap((c) => c.scriptIds);
    const restoredIds = await ids();
    for (const c of await sm.getCollections()) await sm.updateCollection(c.id, 'manual');
    expect(await ids()).toEqual(restoredIds);
    expect(await snapshot(sm, getServiceWorker)).toEqual(before);
    await page.close();
  });
});
