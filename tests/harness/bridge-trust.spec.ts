// What the page can and can't do with the harness's traffic. The DOM
// bridge is shared with the page, so the host checks every request on
// it the way the worker's `bridgeMayActAs` does, and an isolated
// script's traffic never touches it at all.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/harness.js';
import { prepareScript } from '../../lib/harness/prepare.js';
import { BRIDGE_DENIED } from '../../lib/gm-api-catalog.js';

// Send a request over the DOM bridge from the page's own code, as a
// hostile page would, and return the reply (or 'no reply').
function forge(page: Page, payload: Record<string, unknown>): Promise<unknown> {
  return page.evaluate((p) => new Promise((resolve) => {
    const requestId = 'forged-' + Math.random().toString(36).slice(2);
    const finish = (value: unknown) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.__sm === 'sourcemonkey-bridge-reply' && ev.data.requestId === requestId) finish(ev.data.reply);
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish('no reply'), 2000);
    document.dispatchEvent(new CustomEvent('sourcemonkey-bridge-sync', { detail: JSON.stringify({ requestId, payload: p }) }));
  }), payload);
}

// Everything the page's window hears from the bridge, collected from
// document start.
async function recordPushes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __heard: unknown[] }).__heard = [];
    window.addEventListener('message', (ev) => {
      if (ev.data?.__sm === 'sourcemonkey-bridge-push') (window as unknown as { __heard: unknown[] }).__heard.push(ev.data.payload);
    });
  });
}

const DENIED = { ok: false, error: BRIDGE_DENIED };

test.describe('harness bridge trust', () => {
  test('an isolated script works, and the page cannot act for it or read its values', async ({ page, fixtureServer, host, loadScript }) => {
    await recordPushes(page);
    const prepared = await loadScript({
      relativePath: 'isolated.user.js',
      meta: { name: 'Isolated', match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest', 'GM_addValueChangeListener'], connect: ['127.0.0.1'] },
      body: `
        GM_addValueChangeListener('k', (key, oldValue, newValue) => {
          document.getElementById('target').textContent = 'heard ' + newValue;
        });
        GM_setValue('secret', 's3cret');
      `,
    });
    const id = prepared.spec!.id;
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.getValue(id, 'secret')).toBe('s3cret');

    // The isolated channel still carries pushes to the script.
    await host.setValues(id, { k: 'pushed' });
    await expect(page.locator('#target')).toHaveText('heard pushed');
    expect(await page.evaluate(() => (window as unknown as { __heard: unknown[] }).__heard)).toEqual([]);

    expect(await forge(page, { type: 'sm:gm-resync', scriptId: id })).toEqual(DENIED);
    expect(await forge(page, {
      type: 'sm:gm-xhr-start', scriptId: id, id: 'forged-xhr', request: { method: 'GET', url: `${fixtureServer.baseUrl}/other.html` },
    })).toEqual(DENIED);
    const pending = await forge(page, { type: 'sm:check-pending', id, needsValues: true }) as Record<string, unknown>;
    expect(pending.gmValues).toBeUndefined();
    expect(host.reports.requests).toEqual([]);
  });

  test('a page-world script is reachable from the page only through the APIs it granted', async ({ page, fixtureServer, host, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: ['*://*/target.html'], grant: ['unsafeWindow', 'GM_setValue', 'GM_getValue'] },
      body: `GM_setValue('mine', 1);`,
    });
    const id = prepared.spec!.id;
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.getValue(id, 'mine')).toBe(1);

    // Storage is granted, so the page could reach it anyway.
    expect(await forge(page, { type: 'sm:gm-resync', scriptId: id })).toEqual({ ok: true, values: expect.any(Object) });
    // Requests and tabs are not.
    expect(await forge(page, {
      type: 'sm:gm-xhr-start', scriptId: id, id: 'forged-xhr', request: { method: 'GET', url: `${fixtureServer.baseUrl}/other.html` },
    })).toEqual(DENIED);
    expect(await forge(page, { type: 'sm:gm-tab-open', scriptId: id, requestId: 't', url: fixtureServer.baseUrl })).toEqual(DENIED);
    expect(host.reports.requests).toEqual([]);
    expect(host.reports.tabs).toEqual([]);
  });
});

test.describe('harness bridge channels', () => {
  test('the isolated channel leaves nothing in the page\'s world', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'isolated.user.js',
      meta: { name: 'Isolated', match: ['*://*/target.html'], grant: ['GM_setValue'] },
      body: `GM_setValue('k', 1);`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    expect(await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { chrome?: { runtime?: { id?: unknown } } };
      return [typeof w.__smHarnessRuntime, typeof w.__smHarnessReply, typeof w.__smHarnessPush, w.chrome?.runtime?.id];
    })).toEqual(['undefined', 'undefined', 'undefined', undefined]);
  });

  test('a page-world script still hears pushes', async ({ page, fixtureServer, host, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: ['*://*/target.html'], grant: ['unsafeWindow', 'GM_getValue', 'GM_addValueChangeListener'] },
      body: `
        GM_addValueChangeListener('k', (key, oldValue, newValue, remote) => {
          document.getElementById('target').textContent = 'heard ' + newValue + ' remote=' + remote;
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await host.setValues(prepared.spec!.id, { k: 'pushed' });
    await expect(page.locator('#target')).toHaveText('heard pushed remote=true');
  });

  test('a page that replaces the binding cannot swallow a script\'s reports', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: ['*://*/target.html'], grant: ['none'] },
      body: `window.addEventListener('message', (ev) => { if (ev.data === 'throw') throw new Error('after the swap'); });`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__smHarnessBridge = () => undefined;
      window.postMessage('throw', '*');
    });
    await expect.poll(() => host.reports.errors.map((e) => e.message)).toEqual(['after the swap']);
  });

  test('a call from a subframe is ignored', async ({ page, fixtureServer, host, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: ['*://*/target.html'], grant: ['none'] },
      body: '',
    });
    const id = prepared.spec!.id;
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await page.evaluate((src) => new Promise<void>((resolve) => {
      const frame = document.createElement('iframe');
      frame.onload = () => resolve();
      frame.src = src;
      document.body.appendChild(frame);
    }), `${fixtureServer.baseUrl}/other.html`);
    // Straight to the binding, which CDP exposes in every frame.
    const forgeStart = (name: string) => `window.__smHarnessBridge(${JSON.stringify(JSON.stringify({ payload: { type: 'sm:start', id, name, url: 'forged' } }))})`;
    const child = page.frames().find((f) => f !== page.mainFrame())!;
    await child.evaluate(forgeStart('from subframe'));
    // The same call from the top frame is heard, so the one above
    // would have been too without the frame check.
    await page.evaluate(forgeStart('from top'));
    await expect.poll(() => host.reports.started.map((r) => r.name)).toContain('from top');
    expect(host.reports.started.map((r) => r.name)).not.toContain('from subframe');
  });

  test('an isolated script injected immediately runs in the current document', async ({ page, fixtureServer, host, attachment, scriptsDir }) => {
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const file = scriptsDir.write({
      relativePath: 'late.user.js',
      meta: { name: 'Late', match: ['*://*/target.html'], grant: ['GM_setValue'] },
      body: `GM_setValue('late', true);`,
    });
    const prepared = await prepareScript({ file, collectionRoot: scriptsDir.path });
    await attachment.inject(prepared, { immediately: true });
    await expect.poll(() => host.getValue(prepared.spec!.id, 'late')).toBe(true);
    expect(host.reports.started.map((r) => r.name)).toEqual(['Late']);
  });
});
