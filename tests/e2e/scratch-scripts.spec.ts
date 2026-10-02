// Scratch scripts: text handed to the extension over the test surface,
// for the development harness's extension backend. See
// docs/harness-design.md, "Extension backend".

import { test, expect } from '../fixtures/extension';
import { ScriptsDir, renderUserscript } from '../fixtures/scripts-dir';
import { activeTabId, type SmApi } from '../fixtures/sw-api';
import { ExtensionBackend } from '../../lib/harness/extension-backend.js';

function script(body: string, name = 'Scratch one'): string {
  return renderUserscript({
    relativePath: 'scratch.user.js',
    meta: { name, match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_getValue'] },
    body,
  });
}

// A scratch script runs only in a tab an sm-dev run's claim lets it run
// in, so these open a tab and claim it for `scriptId`, as a run does.
async function claimedPage(
  context: import('@playwright/test').BrowserContext,
  getServiceWorker: () => Promise<import('@playwright/test').Worker>,
  sm: SmApi,
  baseUrl: string,
  scriptId: string,
): Promise<import('@playwright/test').Page> {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/blank.html`);
  await sm.claimTab(await activeTabId(getServiceWorker), 'R1', [scriptId], 60_000);
  return page;
}

test.describe('scratch scripts', () => {
  test('a scratch script runs on the next navigation, in the Scratch collection', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const result = await sm.writeScratchScript({ text: script(`document.getElementById('target').textContent = 'pushed';`) });
    expect(result.status).toBe('ok');
    expect(result.replaced).toBe(false);
    const collections = await sm.getCollections();
    expect(collections.map((c) => [c.path, c.displayName])).toEqual([['container:scratch', 'Scratch']]);

    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl, result.scriptId);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('pushed');
    await page.close();
  });

  test('re-pushing the same name replaces the script in place and keeps its values', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const first = await sm.writeScratchScript({ text: script(`GM_setValue('v', 1); document.getElementById('target').textContent = 'one';`) });
    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl, first.scriptId);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('one');
    await expect.poll(() => sm.getGmValues(first.scriptId)).toEqual({ v: 1 });

    const second = await sm.writeScratchScript({ text: script(`document.getElementById('target').textContent = 'two:' + GM_getValue('v');`) });
    expect(second.scriptId).toBe(first.scriptId);
    expect(second.replaced).toBe(true);
    await page.reload();
    await expect(page.locator('#target')).toHaveText('two:1');
    await page.close();
  });

  test('an invalid push reports the extension\'s own diagnostic', async ({ sm }) => {
    const result = await sm.writeScratchScript({ text: 'not a userscript at all', name: 'Broken' });
    expect(result.status).toBe('invalid');
    expect(result.errorMessage).toBeTruthy();
  });

  test('clearScratchScripts removes them all with their values', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const written = await sm.writeScratchScript({ text: script(`GM_setValue('k', 'v'); document.getElementById('target').textContent = 'pushed';`) });
    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl, written.scriptId);
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('pushed');
    await expect.poll(() => sm.getGmValues(written.scriptId)).toEqual({ k: 'v' });
    expect(await sm.clearScratchScripts()).toBe(1);
    expect(await sm.getCollections()).toEqual([]);
    expect(await sm.getGmValues(written.scriptId)).toEqual({});
    await page.reload();
    await expect(page.locator('#target')).toHaveText('original content');
    await page.close();
  });

  test('removing a scratch script or its collection from the UI drops its text, unless a moved copy still reads it', async ({ sm, getServiceWorker }) => {
    const sw = await getServiceWorker();
    const scratchKeys = async () => Object.keys(await sw.evaluate(() => chrome.storage.local.get(null)))
      .filter((k) => k.startsWith('scratch:')).sort();

    const one = await sm.writeScratchScript({ text: script('', 'One') });
    await sm.writeScratchScript({ text: script('', 'Two') });
    expect(await scratchKeys()).toEqual(['scratch:scratch:///One.user.js', 'scratch:scratch:///Two.user.js']);
    await sm.removeScript(one.scriptId);
    expect(await scratchKeys()).toEqual(['scratch:scratch:///Two.user.js']);

    // A copy moved into another collection keeps its text alive, and
    // removing that copy last takes the text with it.
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const three = await sm.writeScratchScript({ text: script('', 'Three') });
    const moved = await sm.moveScript(three.scriptId, { collectionId: mine!.id });
    expect(moved).not.toBeNull();
    // Two goes with the collection; Three is still read from Mine.
    await sm.removeCollection(three.collectionId);
    expect(await scratchKeys()).toEqual(['scratch:scratch:///Three.user.js']);
    await sm.removeScript(moved!.id);
    expect(await scratchKeys()).toEqual([]);

    // A clear keeps the text a moved copy reads, even with a same-named
    // push still in the container.
    const four = await sm.writeScratchScript({ text: script('', 'Four') });
    await sm.moveScript(four.scriptId, { collectionId: mine!.id });
    await sm.writeScratchScript({ text: script('', 'Four') });
    await sm.clearScratchScripts();
    expect(await scratchKeys()).toEqual(['scratch:scratch:///Four.user.js']);
  });

  // The path `sm-dev start --extension` takes: find the worker from the
  // package's own copy of the manifest, push, and clear.
  test('the harness\'s ExtensionBackend finds the extension and pushes through it', async ({ extensionContext, fixtureServer, sm, getServiceWorker }) => {
    const backend = await ExtensionBackend.connect(extensionContext);
    const result = await backend.push(script(`document.getElementById('target').textContent = 'via backend';`));
    expect(result.status).toBe('ok');
    const page = await claimedPage(extensionContext, getServiceWorker, sm, fixtureServer.baseUrl, result.scriptId);
    try {
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveText('via backend');
      expect(await backend.clear()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
