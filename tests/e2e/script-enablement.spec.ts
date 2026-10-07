// The rules that keep one copy of a script running, through the
// collections page's toggles (src/extension/script-enablement.ts,
// docs/script-enablement.md). The viewer's checkboxes are covered in
// other-versions.spec.ts; the popup's order in tests/unit/popup-view.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts, type SmApi, type StoredScriptLike } from '../fixtures/sw-api';

test.describe('script enablement', () => {
  let dirs: ScriptsDir[];
  test.beforeEach(() => { dirs = []; });
  test.afterEach(() => { for (const d of dirs) d.cleanup(); });

  // A folder holding `files`, each a script named `name` at `version`.
  function folder(files: { path: string; name?: string; version?: string }[]): ScriptsDir {
    const dir = ScriptsDir.create();
    dirs.push(dir);
    for (const f of files) {
      dir.write({
        relativePath: f.path,
        meta: {
          name: f.name ?? 'Shared Script',
          match: ['https://example.com/*'],
          extra: f.version ? [`// @version     ${f.version}`] : [],
        },
        body: 'console.log("hi");\n',
      });
    }
    return dir;
  }

  async function addFolder(sm: SmApi, dir: ScriptsDir): Promise<string> {
    const c = await sm.addCollection(dir.path);
    return c!.id;
  }

  async function row(sm: SmApi, collectionId: string, path = 'a.user.js'): Promise<StoredScriptLike> {
    return (await allScripts(sm)).find((s) => s.collectionId === collectionId && s.relativePath === path)!;
  }

  async function collectionsPage(extensionContext: { newPage(): Promise<Page> }, extensionId: string): Promise<Page> {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await page.waitForSelector('tbody .toggle input');
    return page;
  }

  const scriptBox = (page: Page, id: string) => page.locator(`tr[data-script-id="${id}"] .toggle input`);
  const collectionBox = (page: Page, id: string) =>
    page.locator(`.collection[data-collection-id="${id}"] .collection-toggle input`);

  test('turning a script on turns its other active copy off; ctrl-click leaves it on', async ({
    extensionContext, extensionId, sm,
  }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const two = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const a = await row(sm, one);
    const b = await row(sm, two);
    // Adding the second folder turned the first copy off; start from the
    // first one active instead.
    await sm.setScriptEnabled(a.id, true);
    await sm.setScriptEnabled(b.id, false);
    await sm.syncNow();

    const page = await collectionsPage(extensionContext, extensionId);
    await scriptBox(page, b.id).check();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(false);
    // The two sides of the handoff share one time.
    const times = await sm.getEnablementTimes();
    expect(times[a.id]?.inactiveSince).toBeDefined();
    expect(times[a.id]?.inactiveSince).toBe(times[b.id]?.activeSince);
    await expect(scriptBox(page, a.id)).not.toBeChecked();

    await scriptBox(page, a.id).click({ modifiers: ['Control'] });
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(true);
    expect((await row(sm, two)).enabled).toBe(true);
    await page.close();
  });

  test('turning a collection on displaces copies elsewhere; turning it off brings them back', async ({
    extensionContext, extensionId, sm,
  }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const two = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    // Only the first copy is active to start with.
    await sm.setCollectionEnabled(two, false);
    await sm.setScriptEnabled((await row(sm, one)).id, true);
    await sm.syncNow();

    const page = await collectionsPage(extensionContext, extensionId);
    await collectionBox(page, two).check();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(false);
    expect((await row(sm, two)).enabled).toBe(true);

    await collectionBox(page, two).uncheck();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(true);
    await page.close();
  });

  test('turning a collection off brings back nothing a later change touched', async ({
    extensionContext, extensionId, sm,
  }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const two = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    await sm.setCollectionEnabled(two, false);
    await sm.setScriptEnabled((await row(sm, one)).id, true);
    await sm.syncNow();

    const page = await collectionsPage(extensionContext, extensionId);
    await collectionBox(page, two).check();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(false);
    // The displaced copy is active again for a while and is turned off by hand.
    const a = await row(sm, one);
    await scriptBox(page, a.id).click({ modifiers: ['Control'] });
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(true);
    await scriptBox(page, a.id).uncheck();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(false);

    await collectionBox(page, two).uncheck();
    await expect.poll(async () => (await sm.getCollections()).find((c) => c.id === two)!.enabled).toBe(false);
    expect((await row(sm, one)).enabled).toBe(false);
    await page.close();
  });

  test('a collection whose copy landed invalid still turns the working copy off', async ({
    extensionContext, extensionId, sm,
  }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    // Same name, no @match: it parses but lands `invalid`.
    const bad = ScriptsDir.create();
    dirs.push(bad);
    bad.writeRaw('a.user.js', [
      '// ==UserScript==', '// @name        Shared Script', '// ==/UserScript==', '', 'console.log("hi");', '',
    ].join('\n'));
    const two = await addFolder(sm, bad);
    expect((await row(sm, two)).status).toBe('invalid');
    await sm.setCollectionEnabled(two, false);
    await sm.setScriptEnabled((await row(sm, one)).id, true);
    await sm.syncNow();

    const page = await collectionsPage(extensionContext, extensionId);
    await collectionBox(page, two).check();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(false);
    expect((await row(sm, two)).enabled).toBe(true);
    await page.close();
  });

  test('adding a collection turns off the active copy elsewhere; turning it off brings it back', async ({
    extensionContext, extensionId, sm,
  }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const two = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    expect((await row(sm, one)).enabled).toBe(false);
    expect((await row(sm, two)).enabled).toBe(true);

    const page = await collectionsPage(extensionContext, extensionId);
    await collectionBox(page, two).uncheck();
    await expect.poll(async () => (await row(sm, one)).enabled).toBe(true);
    await page.close();
  });

  test('a refresh that finds a new copy leaves it off while another copy is active', async ({ sm }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const later = folder([{ path: 'other.user.js', name: 'Other Script' }]);
    const two = await addFolder(sm, later);
    later.write({
      relativePath: 'a.user.js',
      meta: { name: 'Shared Script', match: ['https://example.com/*'] },
      body: 'console.log("hi");\n',
    });
    await sm.updateCollection(two, 'manual');
    await expect.poll(async () => (await row(sm, two))?.enabled).toBe(false);
    expect((await row(sm, one)).enabled).toBe(true);
    // A new file with no active copy elsewhere lands on, as before.
    expect((await row(sm, two, 'other.user.js')).enabled).toBe(true);
  });

  test('a folder holding two copies of one script lands with only the highest version on', async ({ sm }) => {
    const id = await addFolder(sm, folder([
      { path: 'a.user.js', version: '1.2' },
      { path: 'b.user.js', version: '1.10' },
    ]));
    expect((await row(sm, id, 'b.user.js')).enabled).toBe(true);
    expect((await row(sm, id, 'a.user.js')).enabled).toBe(false);
  });

  test('Enable all turns on one copy per script: the most recently active, over a higher version', async ({
    extensionContext, extensionId, sm,
  }) => {
    const id = await addFolder(sm, folder([
      { path: 'a.user.js', version: '1.2' },
      { path: 'b.user.js', version: '1.10' },
      { path: 'other.user.js', name: 'Other Script' },
    ]));
    const a = await row(sm, id, 'a.user.js');
    const b = await row(sm, id, 'b.user.js');
    const other = await row(sm, id, 'other.user.js');
    // b off first, then a on and off: a is the one most recently active.
    await sm.setScriptEnabled(b.id, false);
    await sm.setScriptEnabled(a.id, true);
    await sm.setScriptEnabled(a.id, false);
    await sm.setScriptEnabled(other.id, false);
    await sm.syncNow();

    const page = await collectionsPage(extensionContext, extensionId);
    const bulk = page.locator(`.collection[data-collection-id="${id}"] .bulk-toggle`);
    await bulk.click();
    await expect.poll(async () => (await row(sm, id, 'a.user.js')).enabled).toBe(true);
    expect((await row(sm, id, 'b.user.js')).enabled).toBe(false);
    expect((await row(sm, id, 'other.user.js')).enabled).toBe(true);
    // Every script has a copy on, so the button now offers Disable all.
    await expect(bulk).toHaveText('−');
    await page.close();
  });

  test('removing a script or a collection drops its active times', async ({ sm }) => {
    const one = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const two = await addFolder(sm, folder([{ path: 'a.user.js' }]));
    const a = await row(sm, one);
    const b = await row(sm, two);
    let times = await sm.getEnablementTimes();
    expect(times[a.id]).toBeDefined();
    expect(times[b.id]).toBeDefined();
    await sm.removeScript(a.id);
    await sm.removeCollection(two);
    times = await sm.getEnablementTimes();
    expect(times[a.id]).toBeUndefined();
    expect(times[b.id]).toBeUndefined();
  });
});
