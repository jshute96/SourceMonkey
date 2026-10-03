// Scratch scripts: text handed to the extension over the test surface,
// into an sm-dev run's test collection. See docs/sm-dev-extension.md.

import { test, expect } from '../fixtures/extension';
import { pathToFileURL } from 'node:url';

import { ScriptsDir, renderUserscript } from '../fixtures/scripts-dir';
import { activeTabId, type SmApi } from '../fixtures/sw-api';

const RUN = 'R1-test';
// sm-dev-link.ts's RUN_GRACE_MS.
const GRACE_MS = 5 * 60_000;

// Sweeps a minute apart, as the worker's alarm does, from `from` to `to`:
// a longer gap reads as the computer sleeping, which sweeps nothing.
async function sweepEachMinute(sm: SmApi, from: number, to: number): Promise<void> {
  for (let at = from; at < to; at += 60_000) await sm.sweepRunCollections(at);
  await sm.sweepRunCollections(to);
}

function script(body: string, name = 'Scratch one'): string {
  return renderUserscript({
    relativePath: 'scratch.user.js',
    meta: { name, match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_getValue'] },
    body,
  });
}

// A scratch script runs only in a tab its run's claim holds, so these
// open a tab and claim it for `run`, as a run does.
async function claimedPage(
  context: import('@playwright/test').BrowserContext,
  getServiceWorker: () => Promise<import('@playwright/test').Worker>,
  sm: SmApi,
  baseUrl: string,
  run = RUN,
): Promise<import('@playwright/test').Page> {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/blank.html`);
  await sm.claimTab(await activeTabId(getServiceWorker), run, true, 60_000);
  return page;
}

test.describe('scratch scripts', () => {
  test('a run\'s script runs on the next navigation, in the run\'s test collection', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const result = await sm.writeRunScript({ run: RUN, text: script(`document.getElementById('target').textContent = 'pushed';`) });
    expect(result.status).toBe('ok');
    expect(result.replaced).toBe(false);
    const collections = await sm.getCollections();
    expect(collections.map((c) => [c.path, c.displayName])).toEqual([[`container:sm-dev:${RUN}`, `sm-dev test collection (run ${RUN})`]]);

    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('pushed');
    await page.close();
  });

  test('re-pushing the same name replaces the script in place and keeps its values', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const first = await sm.writeRunScript({ run: RUN, text: script(`GM_setValue('v', 1); document.getElementById('target').textContent = 'one';`) });
    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('one');
    await expect.poll(() => sm.getGmValues(first.scriptId)).toEqual({ v: 1 });

    const second = await sm.writeRunScript({ run: RUN, text: script(`document.getElementById('target').textContent = 'two:' + GM_getValue('v');`) });
    expect(second.scriptId).toBe(first.scriptId);
    expect(second.replaced).toBe(true);
    await page.reload();
    await expect(page.locator('#target')).toHaveText('two:1');
    await page.close();
  });

  test('an invalid push reports the extension\'s own diagnostic, and isn\'t kept', async ({ sm }) => {
    const result = await sm.writeRunScript({ run: RUN, text: 'not a userscript at all', name: 'Broken' });
    expect(result.status).toBe('invalid');
    expect(result.errorMessage).toBeTruthy();
    expect((await sm.getCollections())[0]?.scriptIds ?? []).toEqual([]);
  });

  test('a relative @require is read from the files pushed with the text, and refused without them', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const text = renderUserscript({
      relativePath: 'scratch.user.js',
      meta: { name: 'With lib', match: ['*://*/target.html'], extra: ['// @require lib/helper.js'] },
      body: `document.getElementById('target').textContent = helperText;`,
    });
    const refused = await sm.writeRunScript({ run: RUN, text });
    expect(refused.status).toBe('invalid');
    expect(refused.errorMessage).toContain('@require lib/helper.js: A scratch script can use a relative path only to a file pushed along with its text');

    const files = {
      'lib/helper.js': {
        url: 'file:///home/me/scripts/lib/helper.js',
        bytesBase64: Buffer.from('var helperText = "from the pushed file";').toString('base64'),
        contentType: '',
      },
    };
    const result = await sm.writeRunScript({ run: RUN, text, files });
    expect(result.status).toBe('ok');
    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('from the pushed file');
    await page.close();

    // The run's end removes the pushed files with the text.
    await sm.releaseRun(RUN);
    const sw = await getServiceWorker();
    const left = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('scratch')));
    expect(left).toEqual([]);
  });

  test('two runs pushing the same name get a script each, which runs only in its own run\'s tabs', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const one = await sm.writeRunScript({ run: 'R1-aaaa', text: script(`document.getElementById('target').textContent = 'one';`) });
    const two = await sm.writeRunScript({ run: 'R2-bbbb', text: script(`document.getElementById('target').textContent = 'two';`) });
    expect(two.scriptId).not.toBe(one.scriptId);
    expect(two.collectionId).not.toBe(one.collectionId);
    expect(two.replaced).toBe(false);
    for (const [run, text] of [['R1-aaaa', 'one'], ['R2-bbbb', 'two']]) {
      const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl, run);
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveText(text);
      await page.close();
    }
  });

  test('releasing the run removes its test collection, with the scripts\' values', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const written = await sm.writeRunScript({ run: RUN, text: script(`GM_setValue('k', 'v'); document.getElementById('target').textContent = 'pushed';`) });
    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('pushed');
    await expect.poll(() => sm.getGmValues(written.scriptId)).toEqual({ k: 'v' });
    await sm.releaseRun(RUN);
    expect(await sm.getCollections()).toEqual([]);
    expect(await sm.getGmValues(written.scriptId)).toEqual({});
    await page.reload();
    await expect(page.locator('#target')).toHaveText('original content');
    await page.close();
  });

  test('a run\'s test collection outlives its lease by the grace period, then goes', async ({ sm }) => {
    await sm.writeRunScript({ run: RUN, text: script('') });
    const start = Date.now();
    await sm.renewRun(RUN, 30_000, true);
    await sweepEachMinute(sm, start, start + 30_000 + GRACE_MS - 10_000);
    expect(await sm.getCollections()).toHaveLength(1);
    await sweepEachMinute(sm, start + 30_000 + GRACE_MS - 10_000, start + 30_000 + GRACE_MS + 70_000);
    expect(await sm.getCollections()).toEqual([]);
  });

  test('a test collection with no lease on record gets the grace period from when it\'s found', async ({ sm }) => {
    // A run from before a browser restart, which has no lease in session storage.
    await sm.writeRunScript({ run: 'R9-gone', text: script('') });
    const start = Date.now();
    await sweepEachMinute(sm, start, start + GRACE_MS - 10_000);
    expect(await sm.getCollections()).toHaveLength(1);
    await sweepEachMinute(sm, start + GRACE_MS - 10_000, start + GRACE_MS + 70_000);
    expect(await sm.getCollections()).toEqual([]);
  });

  test('after a gap in the sweeps (the computer slept), a run\'s lease gets its grace period again', async ({ sm }) => {
    await sm.writeRunScript({ run: RUN, text: script('') });
    const start = Date.now();
    await sm.renewRun(RUN, 30_000, true);
    await sm.sweepRunCollections(start);
    // Woken long past the lease and grace period: nothing goes.
    const woke = start + 30 * 60_000;
    await sm.sweepRunCollections(woke);
    expect(await sm.getCollections()).toHaveLength(1);
    // A run that really is gone still goes, once its grace period passes.
    await sweepEachMinute(sm, woke, woke + GRACE_MS + 70_000);
    expect(await sm.getCollections()).toEqual([]);
  });

  test('the cleanup alarm runs while a test collection exists, and stops once none does', async ({ sm, getServiceWorker }) => {
    const sw = await getServiceWorker();
    const alarm = (): Promise<boolean> => sw.evaluate(async () => (await chrome.alarms.get('sm-dev-run-sweep')) !== undefined);
    expect(await alarm()).toBe(false);
    await sm.writeRunScript({ run: RUN, text: script('') });
    expect(await alarm()).toBe(true);
    await sm.releaseRun(RUN);
    await sm.sweepRunCollections(Date.now());
    expect(await alarm()).toBe(false);
  });

  test('a re-push that doesn\'t parse replaces the script and is kept, reported invalid', async ({ sm }) => {
    const first = await sm.writeRunScript({ run: RUN, text: script(''), name: 'x.user.js' });
    const second = await sm.writeRunScript({ run: RUN, text: 'not a userscript at all', name: 'x.user.js' });
    expect(second.scriptId).toBe(first.scriptId);
    expect(second.replaced).toBe(true);
    expect(second.status).toBe('invalid');
    expect((await sm.getCollections())[0].scriptIds).toEqual([first.scriptId]);
  });

  test('a run id that isn\'t one is refused', async ({ sm }) => {
    for (const run of ['', '../x', 'a b']) {
      await expect(sm.writeRunScript({ run, text: script('') })).rejects.toThrow(/is not an sm-dev run id/);
    }
  });

  test('removing a run\'s script or its test collection from the UI drops the text', async ({ sm, getServiceWorker }) => {
    const sw = await getServiceWorker();
    const scratchKeys = async () => Object.keys(await sw.evaluate(() => chrome.storage.local.get(null)))
      .filter((k) => k.startsWith('scratch:')).sort();
    const key = (name: string): string => `scratch:scratch:///${RUN}/${name}.user.js`;

    const one = await sm.writeRunScript({ run: RUN, text: script('', 'One') });
    const two = await sm.writeRunScript({ run: RUN, text: script('', 'Two') });
    expect(await scratchKeys()).toEqual([key('One'), key('Two')]);
    await sm.removeScript(one.scriptId);
    expect(await scratchKeys()).toEqual([key('Two')]);
    await sm.removeCollection(two.collectionId);
    expect(await scratchKeys()).toEqual([]);
  });

  test('scripts can\'t be moved into or out of a test collection, or installed into one', async ({ sm }) => {
    const dir = ScriptsDir.create();
    try {
      const pushed = await sm.writeRunScript({ run: RUN, text: script('', 'Mine') });
      const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
      const file = dir.write({ relativePath: 'own.user.js', meta: { name: 'Own', match: ['*://*/*'] }, body: '' });
      await sm.installScript(pathToFileURL(file).href, { collectionId: mine!.id });
      const ownId = (await sm.getCollections()).find((c) => c.id === mine!.id)!.scriptIds[0];
      const locked = /only its sm-dev run changes it/;
      await expect(sm.moveScript(pushed.scriptId, { collectionId: mine!.id })).rejects.toThrow(locked);
      await expect(sm.moveScript(ownId, { collectionId: pushed.collectionId })).rejects.toThrow(locked);
      const other = dir.write({ relativePath: 'other.user.js', meta: { name: 'Other', match: ['*://*/*'] }, body: '' });
      await expect(sm.installScript(pathToFileURL(other).href, { collectionId: pushed.collectionId })).rejects.toThrow(locked);
      // Nothing moved.
      const collections = await sm.getCollections();
      expect(collections.find((c) => c.id === pushed.collectionId)!.scriptIds).toEqual([pushed.scriptId]);
      expect(collections.find((c) => c.id === mine!.id)!.scriptIds).toEqual([ownId]);
    } finally {
      dir.cleanup();
    }
  });

  test('the collections page shows a test collection as sm-dev, with no rename gear', async ({ extensionContext, extensionId, sm }) => {
    await sm.writeRunScript({ run: RUN, text: script('') });
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const test = page.locator('section.collection', { hasText: `sm-dev test collection (run ${RUN})` });
    await expect(test.locator('.collection-type-bubble')).toHaveText('sm-dev');
    await expect(test.locator('.edit-collection')).toHaveCount(0);
    const own = page.locator(`section.collection:has(h2 .collection-display-name:text-is("Mine"))`);
    await expect(own.locator('.collection-type-bubble')).toHaveText('scripts');
    await expect(own.locator('.edit-collection')).toHaveCount(1);
    expect(mine).not.toBeNull();
    await page.close();
  });
});
