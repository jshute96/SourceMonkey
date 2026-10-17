// Page-world (MAIN) scripts reach the worker through the bridge
// (src/wrapper-bridge.js), a separate registration that Chrome can
// inject after them. Whatever a script sends before the bridge listens
// must still arrive: its start and errors, and its GM_* calls.
//
// Two ways to get a late bridge:
//   - `bridgeBehind`: what happens for real. A sync that widens the
//     bridge's patterns re-registers it, and Chrome puts it after the
//     scripts already registered. Only `document-start` scripts beat
//     it, and only the part they run synchronously.
//   - `delayBridge`: moves the bridge to `document_idle`, so every
//     script at an earlier @run-at sends before it exists, a stand-in
//     for a bridge that is slow to start.

import path from 'node:path';

import type { Worker } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import {
  activeTabId, allScripts, waitFor, waitForTabState, type SmApi,
} from '../fixtures/sw-api';

const BRIDGE_ID = 'sourcemonkey-bridge';
const GM_RUNTIME_MAIN_ID = 'sourcemonkey-gm-runtime-main';

async function registrationOrder(getServiceWorker: () => Promise<Worker>): Promise<string[]> {
  return (await getServiceWorker()).evaluate(async () =>
    (await chrome.userScripts.getScripts()).map((r) => r.id));
}

// Adds a page-world script on another page, which widens the bridge
// (and with `gm`, the MAIN-world GM runtime too) so it is re-registered
// behind the scripts already in place.
async function widenHelpers(
  sm: SmApi, scriptsDir: ScriptsDir, base: string, gm: boolean,
): Promise<void> {
  scriptsDir.write({
    relativePath: 'wider/wider.user.js',
    meta: {
      name: 'Wider',
      match: [`${base}/other.html`],
      ...(gm ? { grant: ['GM_registerMenuCommand'], injectInto: 'page' } : { grant: ['none'] }),
    },
    body: '',
  });
  await sm.addCollection(path.join(scriptsDir.path, 'wider'));
  await sm.syncNow();
}

async function delayBridge(getServiceWorker: () => Promise<Worker>): Promise<void> {
  await (await getServiceWorker()).evaluate(async (id) => {
    // `update` merges into the registered spec, so `js` can be left
    // out, though the types require it.
    await chrome.userScripts.update([{ id, runAt: 'document_idle' } as chrome.userScripts.RegisteredUserScript]);
  }, BRIDGE_ID);
}

async function scriptIdOf(sm: SmApi, file: string): Promise<string> {
  return (await allScripts(sm)).find((r) => r.relativePath.endsWith(file))!.id;
}

test.describe('a bridge injected after the script', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // A first load, not a reload: that is when a `document-start` script
  // runs at once, without asking the worker first.
  test('a document-start script reports its start', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const base = fixtureServer.baseUrl;
    scriptsDir.write({
      relativePath: 'main/early.user.js',
      meta: { name: 'Early', match: [`${base}/target.html`], grant: ['none'], runAt: 'document-start' },
      body: `document.documentElement.dataset.ran = 'yes';`,
    });
    await sm.addCollection(path.join(scriptsDir.path, 'main'));
    await sm.syncNow();
    await widenHelpers(sm, scriptsDir, base, false);
    const order = await registrationOrder(getServiceWorker);
    expect(order.indexOf(BRIDGE_ID)).toBeGreaterThan(order.indexOf(await scriptIdOf(sm, 'early.user.js')));

    const page = await extensionContext.newPage();
    await page.goto(`${base}/target.html`);
    await expect(page.locator('html')).toHaveAttribute('data-ran', 'yes');
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Early | OK'), 'Early OK');
    await page.close();
  });

  test('a document-start script\'s synchronous error is reported', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const base = fixtureServer.baseUrl;
    scriptsDir.write({
      relativePath: 'main/thrower.user.js',
      meta: { name: 'Thrower', match: [`${base}/target.html`], grant: ['none'], runAt: 'document-start' },
      body: `throw new Error('Thrown at start');`,
    });
    await sm.addCollection(path.join(scriptsDir.path, 'main'));
    await sm.syncNow();
    await widenHelpers(sm, scriptsDir, base, false);
    const id = await scriptIdOf(sm, 'thrower.user.js');

    const page = await extensionContext.newPage();
    await page.goto(`${base}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Thrower | ERROR'), 'Thrower ERROR');
    expect((await sm.getScriptLog(id)).some((e) => e.message.includes('Thrown at start'))).toBe(true);
    await page.close();
  });

  // GM calls made in the script's first, synchronous run. With `gm`,
  // the GM runtime is behind the script too, not just the bridge.
  for (const runtimeBehind of [false, true]) {
    test(`GM calls at document-start reach the worker${runtimeBehind ? ', GM runtime behind too' : ''}`, async ({
      extensionContext, fixtureServer, sm, getServiceWorker,
    }) => {
      const base = fixtureServer.baseUrl;
      scriptsDir.write({
        relativePath: 'main/gm.user.js',
        meta: {
          name: 'GmEarly',
          match: [`${base}/target.html`],
          grant: ['GM_registerMenuCommand', 'GM_xmlhttpRequest'],
          injectInto: 'page',
          runAt: 'document-start',
          connect: ['127.0.0.1', 'localhost'],
        },
        body: `
          GM_registerMenuCommand('Early command', () => {});
          GM_xmlhttpRequest({
            url: ${JSON.stringify(`${base}/target.html`)},
            onload: (r) => { document.documentElement.dataset.xhr = String(r.status); },
            onerror: () => { document.documentElement.dataset.xhr = 'error'; },
          });
        `,
      });
      await sm.addCollection(path.join(scriptsDir.path, 'main'));
      await sm.syncNow();
      await widenHelpers(sm, scriptsDir, base, runtimeBehind);
      const order = await registrationOrder(getServiceWorker);
      const scriptAt = order.indexOf(await scriptIdOf(sm, 'gm.user.js'));
      expect(order.indexOf(BRIDGE_ID)).toBeGreaterThan(scriptAt);
      if (runtimeBehind) expect(order.indexOf(GM_RUNTIME_MAIN_ID)).toBeGreaterThan(scriptAt);
      else expect(order.indexOf(GM_RUNTIME_MAIN_ID)).toBeLessThan(scriptAt);

      const page = await extensionContext.newPage();
      await page.goto(`${base}/target.html`);
      const tabId = await activeTabId(getServiceWorker);
      await waitFor(
        () => sm.getActionContextMenu(tabId),
        (g) => g.length === 1 && g[0]!.commands.some((c) => c.name === 'Early command'),
        { label: 'menu command registered' },
      );
      await expect(page.locator('html')).toHaveAttribute('data-xhr', '200');
      await waitForTabState(sm, tabId, (s) => s.rows.includes('GmEarly | OK'), 'GmEarly OK');
      await page.close();
    });
  }

  // A bridge slow to start: every @run-at before it sends into nothing.
  test('scripts at each @run-at start and make GM calls when the bridge is late', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const base = fixtureServer.baseUrl;
    for (const runAt of ['document-start', 'document-end', 'document-idle'] as const) {
      for (const gm of [false, true]) {
        const name = `${runAt}${gm ? ' gm' : ''}`;
        const key = `${runAt.replace('document-', '')}${gm ? 'Gm' : ''}`;
        scriptsDir.write({
          relativePath: `${runAt}${gm ? '-gm' : ''}.user.js`,
          meta: {
            name,
            match: [`${base}/target.html`],
            runAt,
            ...(gm
              ? { grant: ['GM_registerMenuCommand', 'GM_xmlhttpRequest'], injectInto: 'page', connect: ['127.0.0.1', 'localhost'] }
              : { grant: ['none'] }),
          },
          body: gm
            ? `
              GM_registerMenuCommand(${JSON.stringify(name)}, () => {});
              GM_xmlhttpRequest({
                url: ${JSON.stringify(`${base}/target.html`)},
                onload: (r) => { document.documentElement.dataset.${key} = String(r.status); },
              });
            `
            : `document.documentElement.dataset.${key} = 'ran';`,
        });
      }
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    await delayBridge(getServiceWorker);

    const page = await extensionContext.newPage();
    await page.goto(`${base}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    const names = ['document-start', 'document-end', 'document-idle'].flatMap((r) => [r, `${r} gm`]);
    await waitForTabState(
      sm, tabId, (s) => names.every((n) => s.rows.includes(`${n} | OK`)), 'all OK',
    );
    for (const runAt of ['start', 'end', 'idle']) {
      await expect(page.locator('html')).toHaveAttribute(`data-${runAt}`, 'ran');
      await expect(page.locator('html')).toHaveAttribute(`data-${runAt}-gm`, '200');
    }
    await waitFor(
      () => sm.getActionContextMenu(tabId),
      (g) => g.flatMap((x) => x.commands).length === 3,
      { label: 'menu commands registered' },
    );
    // Still late: nothing put the bridge back in the meantime.
    const bridge = await (await getServiceWorker()).evaluate(async (id) =>
      (await chrome.userScripts.getScripts({ ids: [id] }))[0]?.runAt, BRIDGE_ID);
    expect(bridge).toBe('document_idle');
    await page.close();
  });
});
