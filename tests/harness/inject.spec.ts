// The push backend end to end: prepared scripts injected into a plain
// Chromium (no extension) run behind the real prelude and GM runtime,
// with the harness host answering the bridge.

import { test, expect } from '../fixtures/harness.js';
import { attachPage } from '../../dist/harness/inject.js';

test.describe('harness injection', () => {
  test('a script runs on a matching page and reports its start', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'hello from userscript';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('hello from userscript');
    expect(host.reports.started.map((r) => r.name)).toEqual(['Hello']);
    expect(host.reports.errors).toEqual([]);
  });

  test('the script survives a reload', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'hello';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('hello');
    await page.reload();
    await expect(page.locator('#target')).toHaveText('hello');
    expect(host.reports.started).toHaveLength(2);
  });

  test('a URL miss is recorded with the rule and the script stays off the page', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'hello';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await page.waitForTimeout(300);
    expect(host.reports.started).toEqual([]);
    expect(host.reports.skipped).toHaveLength(1);
    expect(host.reports.skipped[0].reason).toBe('No @match or @include covers this URL');
    await expect(page.locator('#target')).toHaveText('other page');
  });

  test('a sync throw and a later async throw are both attributed', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'thrower.user.js',
      meta: { name: 'Thrower', match: ['*://*/target.html'], grant: ['none'] },
      body: `setTimeout(() => { throw new Error('later'); }, 10);\nthrow new Error('at once');`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.errors.map((e) => e.message).sort()).toEqual(['at once', 'later']);
    expect(host.reports.errors[0].name).toBe('Thrower');
  });

  test('@grant puts the script in an isolated world; @grant none in the page world', async ({ page, fixtureServer, loadScript }) => {
    await loadScript({
      relativePath: 'isolated.user.js',
      meta: { name: 'Isolated', match: ['*://*/page-globals.html'], grant: ['GM_setValue'] },
      body: `document.getElementById('target').dataset.isolated = String(typeof window.__PAGE_APP__);`,
    });
    await loadScript({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: ['*://*/page-globals.html'], grant: ['none'] },
      body: `document.getElementById('target').dataset.main = String(typeof window.__PAGE_APP__);`,
    });
    await page.goto(`${fixtureServer.baseUrl}/page-globals.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-isolated', 'undefined');
    await expect(page.locator('#target')).toHaveAttribute('data-main', 'object');
  });

  test('GM_setValue writes reach the host and GM_getValue reads a seeded value', async ({ page, fixtureServer, host, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'store.user.js',
      meta: { name: 'Store', match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_getValue'] },
      body: `
        const seen = GM_getValue('seeded', 'missing');
        document.getElementById('target').textContent = 'seeded=' + seen;
        GM_setValue('count', 41 + 1);
        GM_setValue('when', new Date(0));
      `,
    });
    host.seedValues(prepared.spec!.id, { seeded: 'yes' });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('seeded=yes');
    await expect.poll(() => host.getValue(prepared.spec!.id, 'count')).toBe(42);
    // The runtime's codec round-trips a Date; the host decodes it.
    expect(host.getValue(prepared.spec!.id, 'when')).toEqual(new Date(0));
  });

  test('a write in one page is broadcast to another page running the script', async ({ page, context, fixtureServer, host, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'listen.user.js',
      meta: { name: 'Listen', match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_getValue', 'GM_addValueChangeListener'] },
      body: `
        GM_addValueChangeListener('shared', (key, oldValue, newValue, remote) => {
          document.getElementById('target').textContent = 'shared=' + newValue + ' remote=' + remote;
        });
        window.addEventListener('message', (ev) => {
          if (ev.data === 'write-now') GM_setValue('shared', 'from-writer');
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const second = await context.newPage();
    const secondAttachment = await attachPage(second, host);
    await secondAttachment.inject(prepared);
    await second.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(2);
    await second.evaluate(() => window.postMessage('write-now', '*'));
    await expect(page.locator('#target')).toHaveText('shared=from-writer remote=true');
    await secondAttachment.dispose();
    await second.close();
  });

  test('a removed script no longer runs after the next navigation', async ({ page, fixtureServer, host, attachment, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'hello';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('hello');
    await attachment.remove(prepared.spec!.id);
    await page.reload();
    await expect(page.locator('#target')).toHaveText('original content');
    expect(host.reports.started).toHaveLength(1);
  });

  test('re-injecting a script replaces it', async ({ page, fixtureServer, attachment, loadScript }) => {
    await loadScript({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'version one';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('version one');
    await loadScript({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'version two';`,
    });
    await page.reload();
    await expect(page.locator('#target')).toHaveText('version two');
    expect(attachment.injectedScripts()).toHaveLength(1);
  });

  test('a same-document navigation off the pattern is not reported as a skip', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      relativePath: 'spa.user.js',
      meta: { name: 'Spa', match: ['*://*/target.html'], grant: ['none'] },
      body: `document.getElementById('target').textContent = 'spa';`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('spa');
    await page.evaluate(() => history.pushState({}, '', '/elsewhere'));
    await page.waitForTimeout(200);
    expect(host.reports.skipped).toEqual([]);
    expect(host.reports.started).toHaveLength(1);
  });

  test('removing a script from one page leaves it working on another', async ({ context, fixtureServer, host, attachment, loadScript }) => {
    const prepared = await loadScript({
      relativePath: 'store.user.js',
      meta: { name: 'Store', match: ['*://*/target.html'], grant: ['GM_setValue'] },
      body: `window.addEventListener('message', (ev) => { if (ev.data === 'write') GM_setValue('k', 'v'); });`,
    });
    const second = await context.newPage();
    const secondAttachment = await attachPage(second, host);
    await secondAttachment.inject(prepared);
    await second.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await attachment.remove(prepared.spec!.id);
    await second.evaluate(() => window.postMessage('write', '*'));
    await expect.poll(() => host.getValue(prepared.spec!.id, 'k')).toBe('v');
    await secondAttachment.dispose();
    await second.close();
  });
});
