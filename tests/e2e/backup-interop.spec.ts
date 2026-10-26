// Backups across managers: SourceMonkey's export imported into
// Tampermonkey (TM) and Violentmonkey (VM), and theirs into SourceMonkey,
// through each manager's own import and export pages. Checks what each
// side can carry: scripts, enabled state, ids, stored values, and
// dependency files. See docs/import.md and docs/export-format.md.
//
// Each test runs a second browser with the copy of TM or VM that
// `sm-dev --manager tm|vm manager fetch` put in sm-dev's cache, and is
// skipped without one. That browser reaches the same fixture server.
import { testWithBrowserDownloads as test, expect } from '../fixtures/extension';
import type { BrowserContext, Page } from '@playwright/test';
import { ScriptsDir } from '../fixtures/scripts-dir';
import {
  chooseImport, closeExport, closeImport, confirmImport, existingRows, exportVia, newRows, openImport, unchangedNames,
} from '../fixtures/backup-dialogs';
import { readZip } from '../fixtures/zip-read.mjs';
import type { StoredScriptLike } from '../fixtures/sw-api';
import { launchExtensionBrowser } from '../../lib/harness/extension-launch.js';
import { fetchedVersion } from '../../lib/harness/manager-fetch.js';
import fs from 'node:fs';
import path from 'node:path';

type Sm = Parameters<Parameters<typeof test>[2]>[0]['sm'];

function userscript(name: string, version: string, extra = '', body = 'void 0;'): string {
  return `// ==UserScript==\n// @name        ${name}\n// @namespace   sm-interop\n// @version     ${version}\n${extra}// ==/UserScript==\n${body}\n`;
}

// A script that stores values when it runs on `pageUrl`, and marks the
// page once they're written.
function valueSetter(name: string, pageUrl: string, values: Record<string, unknown>): string {
  return userscript(name, '1.0', `// @match       ${pageUrl}\n// @grant       GM_setValue\n`,
    `${Object.entries(values).map(([k, v]) => `GM_setValue(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')}\n`
    + `document.documentElement.dataset[${JSON.stringify(name.replace(/\W/g, '').toLowerCase())}] = 'stored';`);
}

// ---------- The other manager's browser ----------

interface OtherManager {
  context: BrowserContext;
  id: string;
  downloads: string;
  // Its options page, which its own calls are made from.
  page: Page;
  close(): Promise<void>;
}

// Its downloads land in `downloads`, which outlives it, so a backup it
// saved can still be imported once it's closed.
async function launchManager(manager: 'tampermonkey' | 'violentmonkey', optionsPath: string, downloads: string): Promise<OtherManager> {
  fs.mkdirSync(downloads, { recursive: true });
  const launched = await launchExtensionBrowser({ manager, downloadsDir: downloads, grantPermissions: ['downloads'] });
  const sw = launched.context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))
    ?? await launched.context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const page = await launched.context.newPage();
  await page.goto(`chrome-extension://${id}/${optionsPath}`);
  await page.waitForFunction(() => document.readyState === 'complete' && typeof chrome?.runtime?.sendMessage === 'function');
  return {
    context: launched.context, id, downloads, page,
    async close() {
      await launched.close();
    },
  };
}

// The next `.zip` that lands in `dir`.
async function nextDownload(dir: string, before: readonly string[]): Promise<string> {
  let found: string | undefined;
  await expect.poll(() => {
    found = fs.readdirSync(dir).find((f) => f.endsWith('.zip') && !before.includes(f));
    return found;
  }, { timeout: 15_000 }).toBeTruthy();
  return path.join(dir, found!);
}

// Visit `url` in the other browser and wait for `marker` on the page.
async function runOn(m: OtherManager, url: string, marker: string): Promise<void> {
  const page = await m.context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute(`data-${marker.toLowerCase()}`, 'stored', { timeout: 15_000 });
  await page.close();
}

// ---------- Tampermonkey ----------

// TM's element ids are base64 of its internal names.
const tmId = (name: string, suffix: string): string => `#input_${Buffer.from(name).toString('base64').replace(/=+$/, '')}_${suffix}`;

interface TmScript { uuid: string; name: string; enabled: boolean; code: string }

async function tmCall<R>(m: OtherManager, method: string, fields: Record<string, unknown> = {}): Promise<R> {
  return await m.page.evaluate((msg) => chrome.runtime.sendMessage(msg), { method, ...fields }) as R;
}

async function tmScripts(m: OtherManager): Promise<TmScript[]> {
  const tree = await tmCall<{ items: TmScript[] }>(m, 'loadTree', { referrer: 'options.scripts.userscripts', complete: true });
  return tree.items.filter((i) => typeof i.uuid === 'string');
}

async function tmValues(m: OtherManager, uuid: string): Promise<Record<string, unknown>> {
  const tree = await tmCall<{ items: Record<string, unknown>[] }>(m, 'loadTree', { referrer: 'options.scripts.userscripts.storage', uuid });
  return tree.items[0] ?? {};
}

async function tmInstall(m: OtherManager, code: string): Promise<string> {
  return (await tmCall<{ uuid: string }>(m, 'saveScript', { uuid: 'new', new_script: true, code, reload: false })).uuid;
}

// The Utilities page, in TM's advanced mode, where all its export
// buttons show.
async function tmUtilities(m: OtherManager): Promise<void> {
  await tmCall(m, 'setOption', { name: 'configMode', value: 100 });
  await m.page.goto(`chrome-extension://${m.id}/options.html#nav=utils`);
  await m.page.reload();
  await expect(m.page.locator(tmId('file_utils', 'file'))).toBeAttached();
}

// Import a zip through the Utilities page and its confirmation page.
async function tmImport(m: OtherManager, file: string, count: number): Promise<void> {
  await tmUtilities(m);
  const ask = m.context.waitForEvent('page', { predicate: (p) => p.url().includes('/ask.html') });
  await m.page.locator(tmId('file_utils', 'file')).setInputFiles(file);
  const confirm = await ask;
  await confirm.locator(tmId('Import_undefined', 'bu')).click();
  await expect.poll(async () => (await tmScripts(m)).length, { timeout: 15_000 }).toBe(count);
}

// TM's zip export. It saves through Chrome's Save As, which a headless
// browser cancels, so the save is made without it.
async function tmExportZip(m: OtherManager): Promise<string> {
  await tmUtilities(m);
  const sw = m.context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${m.id}/`))!;
  await sw.evaluate(() => {
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = ((options: chrome.downloads.DownloadOptions) => download({ ...options, saveAs: false })) as typeof chrome.downloads.download;
  });
  const before = fs.readdirSync(m.downloads);
  // The Zip section's Export; the first is the Cloud section's.
  await m.page.locator(`[id="${tmId('utils_utils_e_zip', 'bu').slice(1)}"]`).nth(1).click();
  return await nextDownload(m.downloads, before);
}

// TM's JSON backup, from its TextArea export.
async function tmExportJson(m: OtherManager): Promise<string> {
  await tmUtilities(m);
  const area = m.page.locator(`#textarea_${Buffer.from('utils_utils').toString('base64').replace(/=+$/, '')}_ta`);
  await m.page.locator(tmId('utils_utils_e_ta', 'bu')).click();
  await expect(area).not.toHaveValue('');
  return await area.inputValue();
}

// ---------- Violentmonkey ----------

interface VmScript { props: { id: number; uri: string }; config: { enabled: number; removed?: number }; meta: { name: string } }

async function vmCall<R>(m: OtherManager, cmd: string, data?: unknown): Promise<R> {
  return await m.page.evaluate((msg) => chrome.runtime.sendMessage(msg), { cmd, data }) as R;
}

async function vmScripts(m: OtherManager): Promise<VmScript[]> {
  return (await vmCall<{ scripts: VmScript[] }>(m, 'GetData', {})).scripts.filter((s) => !s.config.removed);
}

// A script's values as VM stores them, each with its type letter.
async function vmValues(m: OtherManager, id: number): Promise<Record<string, unknown>> {
  const sw = m.context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${m.id}/`))!;
  return await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key] ?? {}, `val:${id}`) as Record<string, unknown>;
}

async function vmSettings(m: OtherManager): Promise<void> {
  await m.page.goto(`chrome-extension://${m.id}/options/index.html#settings`);
  await expect(m.page.getByRole('button', { name: 'Import from zip' })).toBeVisible();
}

async function vmImport(m: OtherManager, file: string, count: number): Promise<void> {
  await vmSettings(m);
  const chooser = m.page.waitForEvent('filechooser');
  await m.page.getByRole('button', { name: 'Import from zip' }).click();
  await (await chooser).setFiles(file);
  await expect.poll(async () => (await vmScripts(m)).length, { timeout: 15_000 }).toBe(count);
}

async function vmExport(m: OtherManager): Promise<string> {
  await vmSettings(m);
  const before = fs.readdirSync(m.downloads);
  await m.page.getByRole('button', { name: 'Export to zip' }).click();
  return await nextDownload(m.downloads, before);
}

// ---------- SourceMonkey ----------

async function smPage(extensionContext: BrowserContext, extensionId: string): Promise<Page> {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/collections.html`);
  await expect(page.locator('#page-menu')).toBeVisible();
  return page;
}

async function scriptsIn(sm: Sm, collectionId: string): Promise<StoredScriptLike[]> {
  return (await sm.getCollectionWithScripts(collectionId))!.scripts;
}

const nameOf = (s: { header?: { tags: { tag: string; value: string }[] } | null }): string =>
  s.header?.tags.find((t) => t.tag === 'name')?.value ?? '';

test.describe('backups across managers', () => {
  test.describe.configure({ timeout: 180_000 });
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create(); });
  test.afterEach(() => { dir.cleanup(); });

  test('SourceMonkey → Tampermonkey → SourceMonkey: ids, enabled state and values survive', async ({
    extensionContext, extensionId, sm, fixtureServer,
  }) => {
    test.skip(fetchedVersion('tampermonkey') === null, 'No Tampermonkey fetched: run sm-dev --manager tm manager fetch');
    const lib = `${fixtureServer.baseUrl}/set-page-global.js`;
    dir.write({ relativePath: 'alpha.user.js', meta: { name: 'Alpha', match: ['https://example.com/*'] }, body: 'void 1;\n' });
    dir.write({ relativePath: 'beta.user.js', meta: { name: 'Beta', match: ['https://example.com/*'] }, body: 'void 2;\n' });
    dir.write({ relativePath: 'gamma.user.js', meta: { name: 'Gamma', match: ['https://example.com/*'], extra: [`// @require ${lib}`] }, body: 'void 3;\n' });
    const added = await sm.addCollection(dir.path);
    const scripts = await scriptsIn(sm, added!.id);
    const byName = new Map(scripts.map((s) => [nameOf(s), s]));
    await sm.setScriptEnabled(byName.get('Beta')!.id, false);
    await sm.writeGmValues(byName.get('Alpha')!.id, [{ key: 'theme', value: 'dark' }, { key: 'count', value: 3 }]);
    await sm.syncNow();

    const page = await smPage(extensionContext, extensionId);
    const saved = await exportVia(page, '#page-menu', { files: true });
    await closeExport(page);
    // The bundled dependency is in the zip, where TM sets it aside.
    expect(readZip(fs.readFileSync(saved)).some((e) => e.path.endsWith('set-page-global.js'))).toBe(true);

    const tm = await launchManager('tampermonkey', 'options.html', path.join(dir.path, 'downloads'));
    try {
      await tmImport(tm, saved, 3);
      const inTm = await tmScripts(tm);
      expect(inTm.map((s) => [s.name, s.uuid, s.enabled]).sort()).toEqual([
        ['Alpha', byName.get('Alpha')!.id, true],
        ['Beta', byName.get('Beta')!.id, false],
        ['Gamma', byName.get('Gamma')!.id, true],
      ]);
      // Written just after the scripts.
      await expect.poll(() => tmValues(tm, byName.get('Alpha')!.id)).toEqual({ theme: 'sdark', count: 'n3' });
      // Imported again, TM updates by uuid rather than adding copies.
      await tmImport(tm, saved, 3);

      // A script TM has that SourceMonkey doesn't.
      await tmInstall(tm, userscript('Only in TM', '1.0', '// @match       https://example.com/*\n'));
      const back = await tmExportZip(tm);

      await sm.writeGmValues(byName.get('Alpha')!.id, [{ key: 'theme', value: 'light' }]);
      await openImport(page, '#page-menu', back);
      // Only Alpha's values changed since.
      expect((await existingRows(page)).map((r) => [r.name, r.content])).toEqual([['Alpha', 'Same']]);
      expect((await unchangedNames(page)).sort()).toEqual(['Beta', 'Gamma']);
      expect((await newRows(page)).map((r) => r.name)).toEqual(['Only in TM']);
      await chooseImport(page, { existing: 'always', existingValues: true, existingEnabled: true });
      await confirmImport(page);
      await closeImport(page);
      // TM's copy of the values, decoded.
      expect(await sm.getGmValues(byName.get('Alpha')!.id)).toEqual({ theme: 'dark', count: 3 });
      expect((await scriptsIn(sm, added!.id)).map((s) => [nameOf(s), s.enabled]).sort())
        .toEqual([['Alpha', true], ['Beta', false], ['Gamma', true]]);
    } finally {
      await tm.close();
    }
    await page.close();
  });

  test('Tampermonkey\'s own backups, JSON and zip, import into SourceMonkey', async ({
    extensionContext, extensionId, sm, fixtureServer,
  }) => {
    test.skip(fetchedVersion('tampermonkey') === null, 'No Tampermonkey fetched: run sm-dev --manager tm manager fetch');
    const pageUrl = `${fixtureServer.baseUrl}/blank.html`;
    const lib = `${fixtureServer.baseUrl}/set-page-global.js`;
    const tm = await launchManager('tampermonkey', 'options.html', path.join(dir.path, 'downloads'));
    let json: string;
    let zip: string;
    const uuids: Record<string, string> = {};
    try {
      uuids.Stores = await tmInstall(tm, valueSetter('Stores', pageUrl, { theme: 'dark', count: 3, cfg: { a: [1] }, on: true }));
      uuids.Off = await tmInstall(tm, userscript('Off', '1.0', '// @match       https://example.com/*\n'));
      await tmCall(tm, 'modifyScriptOptions', { uuid: uuids.Off, enabled: false, reload: false });
      uuids.Uses = await tmInstall(tm, userscript('Uses lib', '1.0', `// @match       https://example.com/*\n// @require     ${lib}\n`));
      await runOn(tm, pageUrl, 'Stores');
      await expect.poll(async () => Object.keys(await tmValues(tm, uuids.Stores)).length).toBe(4);
      json = await tmExportJson(tm);
      zip = await tmExportZip(tm);
    } finally {
      await tm.close();
    }

    const jsonFile = path.join(dir.path, 'tampermonkey-backup.txt');
    fs.writeFileSync(jsonFile, json);
    const page = await smPage(extensionContext, extensionId);
    await openImport(page, '#page-menu', jsonFile);
    expect((await newRows(page)).map((r) => r.name)).toEqual(['Stores', 'Off', 'Uses lib']);
    expect(await confirmImport(page)).toBe('Imported 3 scripts.');
    await closeImport(page);

    const into = (await sm.getCollections()).find((c) => c.displayName?.startsWith('Imported from Tampermonkey'))!;
    const got = await scriptsIn(sm, into.id);
    const byName = new Map(got.map((s) => [nameOf(s), s]));
    expect(got.map((s) => [nameOf(s), s.status, s.enabled]).sort())
      .toEqual([['Off', 'ok', false], ['Stores', 'ok', true], ['Uses lib', 'ok', true]]);
    expect(await sm.getGmValues(byName.get('Stores')!.id)).toEqual({ theme: 'dark', count: 3, cfg: { a: [1] }, on: true });
    // Its @require came from the backup.
    expect(byName.get('Uses lib')!.requires?.[0]?.url).toBe(lib);

    // The zip has the same scripts, known by TM's uuids.
    await openImport(page, '#page-menu', zip);
    expect(await existingRows(page)).toEqual([]);
    expect((await unchangedNames(page)).sort()).toEqual(['Off', 'Stores', 'Uses lib']);
    await page.close();
  });

  test('SourceMonkey → Violentmonkey → SourceMonkey, with a script of Violentmonkey\'s own', async ({
    extensionContext, extensionId, sm, fixtureServer,
  }) => {
    test.skip(fetchedVersion('violentmonkey') === null, 'No Violentmonkey fetched: run sm-dev --manager vm manager fetch');
    const pageUrl = `${fixtureServer.baseUrl}/blank.html`;
    dir.write({ relativePath: 'alpha.user.js', meta: { name: 'Alpha', match: ['https://example.com/*'], extra: ['// @namespace sm-interop'] }, body: 'void 1;\n' });
    dir.write({ relativePath: 'beta.user.js', meta: { name: 'Beta', match: ['https://example.com/*'], extra: ['// @namespace sm-interop'] }, body: 'void 2;\n' });
    const added = await sm.addCollection(dir.path);
    const byName = new Map((await scriptsIn(sm, added!.id)).map((s) => [nameOf(s), s]));
    await sm.setScriptEnabled(byName.get('Beta')!.id, false);
    await sm.writeGmValues(byName.get('Alpha')!.id, [{ key: 'theme', value: 'dark' }, { key: 'count', value: 3 }]);
    await sm.syncNow();

    const page = await smPage(extensionContext, extensionId);
    const saved = await exportVia(page, '#page-menu');
    await closeExport(page);

    const vm = await launchManager('violentmonkey', 'options/index.html', path.join(dir.path, 'downloads'));
    let back: string;
    try {
      await vmImport(vm, saved, 2);
      const inVm = await vmScripts(vm);
      expect(inVm.map((s) => [s.meta.name, s.config.enabled]).sort()).toEqual([['Alpha', 1], ['Beta', 0]]);
      const alphaVm = inVm.find((s) => s.meta.name === 'Alpha')!;
      await expect.poll(() => vmValues(vm, alphaVm.props.id)).toEqual({ theme: 'sdark', count: 'n3' });

      // One of VM's own, turned off, with values it stored running.
      const own = await vmCall<{ where: { id: number } }>(vm, 'ParseScript', {
        code: valueSetter('VM own', pageUrl, { saved: 'yes', n: 2 }), require: {}, cache: {},
      });
      await runOn(vm, pageUrl, 'VMown');
      await expect.poll(async () => Object.keys(await vmValues(vm, own.where.id)).length).toBe(2);
      await vmCall(vm, 'UpdateScriptInfo', { id: own.where.id, config: { enabled: 0 } });
      back = await vmExport(vm);
    } finally {
      await vm.close();
    }

    await sm.writeGmValues(byName.get('Alpha')!.id, [{ key: 'theme', value: 'light' }]);
    await openImport(page, '#page-menu', back);
    // VM keeps no ids: what's here is found by namespace and name.
    expect((await existingRows(page)).map((r) => [r.name, r.content])).toEqual([['Alpha', 'Same']]);
    expect(await unchangedNames(page)).toEqual(['Beta']);
    expect((await newRows(page)).map((r) => r.name)).toEqual(['VM own']);
    await chooseImport(page, { existing: 'always', existingValues: true, existingEnabled: true });
    await confirmImport(page);
    await closeImport(page);
    expect(await sm.getGmValues(byName.get('Alpha')!.id)).toEqual({ theme: 'dark', count: 3 });
    const into = (await sm.getCollections()).find((c) => c.displayName?.startsWith('Imported from Violentmonkey'))!;
    const [vmOwn] = await scriptsIn(sm, into.id);
    expect([nameOf(vmOwn), vmOwn.enabled, vmOwn.status]).toEqual(['VM own', false, 'ok']);
    expect(await sm.getGmValues(vmOwn.id)).toEqual({ saved: 'yes', n: 2 });
    await page.close();
  });
});
