// The browser-level GM APIs under the push backend: tabs, menu
// commands, notifications, downloads, window control, and
// `window.onurlchange`. The host records each call and lets a test
// drive the events the extension's UI would (a menu click, a
// notification click).

import { readFile } from 'node:fs/promises';
import { test, expect } from '../fixtures/harness.js';

const MATCH = ['*://*/target.html'];

test.describe('harness browser APIs', () => {
  test('GM_openInTab opens a real page in the context and onclose fires when it closes', async ({ page, context, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'tab.user.js',
      meta: { name: 'Tab', match: MATCH, grant: ['GM_openInTab'] },
      body: `
        window.addEventListener('message', (ev) => {
          if (ev.data !== 'open') return;
          const t = GM_openInTab(location.origin + '/other.html', { active: false });
          t.onclose = () => { document.getElementById('target').textContent = 'closed'; };
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    const opened = context.waitForEvent('page');
    await page.evaluate(() => window.postMessage('open', '*'));
    const tab = await opened;
    await tab.waitForURL(`${fixtureServer.baseUrl}/other.html`);
    expect(host.reports.tabs).toHaveLength(1);
    expect(host.reports.tabs[0]).toMatchObject({ url: `${fixtureServer.baseUrl}/other.html`, active: false, closed: false });
    await tab.close();
    await expect(page.locator('#target')).toHaveText('closed');
    expect(host.reports.tabs[0].closed).toBe(true);
  });

  test('menu commands are recorded and a test can fire one', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'menu.user.js',
      meta: { name: 'Menu', match: MATCH, grant: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand'] },
      body: `
        const id = GM_registerMenuCommand('Say hello', () => {
          document.getElementById('target').textContent = 'hello from menu';
        });
        GM_registerMenuCommand('Gone soon', () => {});
        window.addEventListener('message', (ev) => { if (ev.data === 'unregister') GM_unregisterMenuCommand(id); });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.menuCommands.map((m) => m.name)).toEqual(['Say hello', 'Gone soon']);
    expect(await host.fireMenuCommand('Say hello')).toBe(true);
    await expect(page.locator('#target')).toHaveText('hello from menu');
    expect(await host.fireMenuCommand('No such command')).toBe(false);
    await page.evaluate(() => window.postMessage('unregister', '*'));
    await expect.poll(() => host.reports.menuCommands.map((m) => m.name)).toEqual(['Gone soon']);
  });

  test('GM_notification resolves with an id, and a click reaches onclick', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'notify.user.js',
      meta: { name: 'Notify', match: MATCH, grant: ['GM_notification'] },
      body: `
        const out = (t) => { document.getElementById('target').textContent = t; };
        GM_notification({
          text: 'Hi there', title: 'Greeting',
          onclick: () => out('clicked'),
          ondone: () => out('done'),
        }).then((id) => out('shown ' + id), (err) => out('rejected ' + err.message));
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText(/^shown harness-notification-/);
    expect(host.reports.notifications).toHaveLength(1);
    expect(host.reports.notifications[0]).toMatchObject({ text: 'Hi there', title: 'Greeting' });
    const requestId = host.reports.notifications[0].requestId;
    expect(await host.clickNotification(requestId)).toBe(true);
    await expect(page.locator('#target')).toHaveText('clicked');
    expect(await host.closeNotification(requestId)).toBe(true);
    await expect(page.locator('#target')).toHaveText('done');
    expect(host.reports.notifications[0].event).toBe('closed');
  });

  test('GM_notification without text rejects', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'notify.user.js',
      meta: { name: 'Notify', match: MATCH, grant: ['GM_notification'] },
      body: `
        GM_notification({ text: '' }).then(
          () => { document.getElementById('target').textContent = 'resolved'; },
          () => { document.getElementById('target').textContent = 'rejected'; });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('rejected');
    expect(host.reports.notifications).toEqual([]);
  });

  test('GM_download writes the file under the host\'s download directory', async ({ page, fixtureServer, host, scriptsDir, loadScript }) => {
    host.downloadDir = scriptsDir.path + '/downloads';
    await loadScript({
      relativePath: 'dl.user.js',
      meta: { name: 'Download', match: MATCH, grant: ['GM_download'] },
      body: `
        const out = (t) => { document.getElementById('target').textContent = t; };
        GM_download({
          url: location.origin + '/other.html', name: 'saved/other.html',
          onload: () => out('loaded'),
          onerror: (e) => out('error ' + e.error),
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('loaded');
    expect(host.reports.downloads).toHaveLength(1);
    const record = host.reports.downloads[0];
    expect(record.outcome).toBe('load');
    expect(record.filename).toBe(`${scriptsDir.path}/downloads/saved/other.html`);
    expect(await readFile(record.filename!, 'utf8')).toContain('other page');
  });

  test('GM_download refuses a traversing name and a non-http URL', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'dl.user.js',
      meta: { name: 'Download', match: MATCH, grant: ['GM_download'] },
      body: `
        const out = (t) => { document.getElementById('target').textContent += t + ';'; };
        GM_download({ url: location.origin + '/other.html', name: '../escape.html',
          onload: () => out('loaded'), onerror: (e) => out('error ' + e.error) });
        GM_download({ url: 'file:///etc/hostname', name: 'x',
          onload: () => out('loaded'), onerror: (e) => out('error ' + e.error) });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('original contenterror not_permitted;error not_permitted;');
    expect(host.reports.downloads.map((d) => d.outcome)).toEqual(['error', 'error']);
  });

  test('menu commands re-registered after a reload replace the old document\'s', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'menu.user.js',
      meta: { name: 'Menu', match: MATCH, grant: ['GM_registerMenuCommand'] },
      body: `
        GM_registerMenuCommand('Mark', () => {
          document.getElementById('target').textContent = 'marked ' + performance.timeOrigin;
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.menuCommands.length).toBe(1);
    await page.reload();
    await expect.poll(() => host.reports.started.length).toBe(2);
    expect(host.reports.menuCommands).toHaveLength(1);
    expect(await host.fireMenuCommand('Mark')).toBe(true);
    await expect(page.locator('#target')).toHaveText(/^marked /);
  });

  test('a tab closed straight after opening still fires onclose', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'tab.user.js',
      meta: { name: 'Tab', match: MATCH, grant: ['GM_openInTab'] },
      body: `
        const t = GM_openInTab(location.origin + '/other.html', { active: false });
        t.onclose = () => { document.getElementById('target').textContent = 'closed'; };
        t.close();
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('closed');
    await expect.poll(() => host.reports.tabs[0]?.closed).toBe(true);
  });

  test('a notification with a timeout closes itself and fires ondone', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'notify.user.js',
      meta: { name: 'Notify', match: MATCH, grant: ['GM_notification'] },
      body: `
        GM_notification({ text: 'Brief', timeout: 100, ondone: () => {
          document.getElementById('target').textContent = 'done';
        } });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('done');
    expect(host.reports.notifications[0].event).toBe('closed');
  });

  test('a download whose name is taken gets a numbered one', async ({ page, fixtureServer, host, scriptsDir, loadScript }) => {
    host.downloadDir = scriptsDir.path + '/downloads';
    await loadScript({
      relativePath: 'dl.user.js',
      meta: { name: 'Download', match: MATCH, grant: ['GM_download'] },
      body: `
        let n = 0;
        const done = () => { if (++n === 2) document.getElementById('target').textContent = 'both'; };
        GM_download({ url: location.origin + '/other.html', name: 'same.html', onload: done, onerror: done });
        GM_download({ url: location.origin + '/other.html', name: 'same.html', onload: done, onerror: done });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('both');
    const names = host.reports.downloads.map((d) => d.filename && d.filename.slice(host.downloadDir.length + 1)).sort();
    expect(names).toEqual(['same (1).html', 'same.html']);
  });

  test('window.onurlchange sees the page\'s pushState', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'url.user.js',
      meta: { name: 'Url', match: MATCH, grant: ['window.onurlchange'] },
      body: `
        window.addEventListener('urlchange', (ev) => {
          document.getElementById('target').textContent = 'changed ' + ev.url;
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await page.evaluate(() => history.pushState({}, '', '/target.html?next=1'));
    await expect(page.locator('#target')).toHaveText(`changed ${fixtureServer.baseUrl}/target.html?next=1`);
  });

  test('a granted window.close closes the page', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'close.user.js',
      meta: { name: 'Close', match: MATCH, grant: ['window.close'] },
      body: `window.addEventListener('message', (ev) => { if (ev.data === 'close') window.close(); });`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    const closed = page.waitForEvent('close');
    await page.evaluate(() => window.postMessage('close', '*'));
    await closed;
    expect(host.reports.windowCalls).toEqual([expect.objectContaining({ method: 'close' })]);
  });
});
