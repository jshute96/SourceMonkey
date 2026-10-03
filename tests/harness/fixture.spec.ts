// The fixture a consumer repo imports from `sourcemonkey/harness`,
// driven here from `lib/` the way that repo would: `loadUserscript`,
// `gm`, `reports`, and `serveHtml`.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test as harnessTest, expect } from '../../lib/harness/index.js';

// A repo-like directory with one script, as a consumer would have.
const test = harnessTest.extend<{ repo: string }>({
  repo: async ({}, use) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sourcemonkey-consumer-'));
    await writeFile(path.join(dir, 'greet.user.js'), `// ==UserScript==
// @name         Greeter
// @match        https://example.test/items/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==
const greeting = GM_getValue('greeting', 'hello');
document.getElementById('target').textContent = greeting + ' from Greeter';
GM_setValue('visits', GM_getValue('visits', 0) + 1);
GM_registerMenuCommand('Shout', () => {
  document.getElementById('target').textContent = greeting.toUpperCase();
});
`);
    await writeFile(path.join(dir, 'snapshot.html'),
      '<!DOCTYPE html><html><body><main id="target">snapshot content</main></body></html>');
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
});

test.describe('consumer fixture', () => {
  test('loads a script against a served page and exposes gm and reports', async ({ page, repo, loadUserscript, gm, reports, serveHtml }) => {
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/items/42', { block: true });
    await loadUserscript(path.join(repo, 'greet.user.js'), {
      collectionRoot: repo,
      values: { greeting: 'hi' },
      url: 'https://example.test/items/42',
    });
    await page.goto('https://example.test/items/42');
    await expect(page.locator('#target')).toHaveText('hi from Greeter');
    await reports.waitForStart();
    expect(reports.errors()).toEqual([]);
    await expect.poll(() => gm.get('visits')).toBe(1);
    expect(gm.list()).toEqual({ greeting: 'hi', visits: 1 });
    await expect.poll(() => gm.menuCommands()).toEqual(['Shout']);
    expect(await gm.fireMenu('Shout')).toBe(true);
    await expect(page.locator('#target')).toHaveText('HI');
    // A write from the test reaches the running script like another tab's.
    await gm.set('greeting', 'yo', 'Greeter');
    expect(await gm.fireMenu('Shout', 'greet.user.js')).toBe(true);
    await expect(page.locator('#target')).toHaveText('HI');
    await expect.poll(() => gm.get('greeting')).toBe('yo');
    // A reload registers the command again, in place of the old
    // document's, which fires there no more.
    await page.reload();
    await expect(page.locator('#target')).toHaveText('yo from Greeter');
    await expect.poll(() => gm.menuCommands()).toEqual(['Shout']);
    expect(await gm.fireMenu('Shout')).toBe(true);
    await expect(page.locator('#target')).toHaveText('YO');
  });

  test('a second served page sits beside the first', async ({ page, repo, serveHtml }) => {
    await writeFile(path.join(repo, 'two.html'), '<!DOCTYPE html><html><body><main id="target">second</main></body></html>');
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/one', { block: true });
    await serveHtml(path.join(repo, 'two.html'), 'https://example.test/two');
    await page.goto('https://example.test/one');
    await expect(page.locator('#target')).toHaveText('snapshot content');
    await page.goto('https://example.test/two');
    await expect(page.locator('#target')).toHaveText('second');
    // Anything else falls through to the blocking route and is refused.
    await expect(page.goto('https://example.test')).rejects.toThrow();
  });

  test('a URL the header does not cover is refused up front', async ({ repo, loadUserscript }) => {
    await expect(loadUserscript(path.join(repo, 'greet.user.js'), {
      collectionRoot: repo,
      url: 'https://example.test/other',
    })).rejects.toThrow(/would not run on https:\/\/example\.test\/other: No @match or @include covers this URL/);
  });

  test('waitForStart explains a miss instead of timing out silently', async ({ page, repo, loadUserscript, reports, serveHtml }) => {
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/other', { block: true });
    await loadUserscript(path.join(repo, 'greet.user.js'), { collectionRoot: repo });
    await page.goto('https://example.test/other');
    await expect(reports.waitForStart(undefined, 500)).rejects.toThrow(/Skipped: Greeter on https:\/\/example\.test\/other: No @match/);
  });

  test('saveHtml records a page serveHtml can replay', async ({ page, repo, loadUserscript, serveHtml, saveHtml }) => {
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/items/7', { block: true });
    await page.goto('https://example.test/items/7');
    await page.evaluate(() => { document.getElementById('target')!.textContent = 'as it stood'; });
    const recorded = path.join(repo, 'recorded.html');
    await saveHtml(recorded);

    // Replaying it gives the page back as it was, with the script
    // running against it.
    await serveHtml(recorded, 'https://example.test/items/8');
    await loadUserscript(path.join(repo, 'greet.user.js'), { collectionRoot: repo });
    await page.goto('https://example.test/items/8');
    await expect(page.locator('#target')).toHaveText('hello from Greeter');
  });

  test('saveHtml records the URL and running scripts, and serveHtml defaults to that URL', async ({ page, repo, loadUserscript, serveHtml, saveHtml }) => {
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/items/9', { block: true });
    await loadUserscript(path.join(repo, 'greet.user.js'), { collectionRoot: repo });
    await page.goto('https://example.test/items/9');
    await expect(page.locator('#target')).toHaveText('hello from Greeter');
    const recorded = path.join(repo, 'recorded.html');
    await saveHtml(recorded);
    const header = (await readFile(recorded, 'utf8')).split('\n').slice(0, 3);
    expect(header).toEqual([
      '<!DOCTYPE html>',
      '<!-- saved from url=(0028)https://example.test/items/9 -->',
      '<!-- SourceMonkey: userscript active: Greeter -->',
    ]);

    await page.goto('about:blank');
    expect(await serveHtml(recorded)).toBe('https://example.test/items/9');
    await page.goto('https://example.test/items/9');
    await expect(page.locator('#target')).toHaveText('hello from Greeter');
  });

  test('serveHtml serves the <name>_files folder a browser saves beside the page', async ({ page, repo, serveHtml }) => {
    // As Chrome's Save Page As, Webpage Complete, writes one.
    const folder = path.join(repo, 'My Page _ Site_files');
    await mkdir(folder);
    await writeFile(path.join(folder, 'style.css'), '#target { color: rgb(1, 2, 3); }');
    await writeFile(path.join(folder, 'app.js'), 'document.getElementById("target").textContent = "ran";');
    await writeFile(path.join(repo, 'My Page _ Site.html'), [
      '<!DOCTYPE html>',
      '<!-- saved from url=(0029)https://example.test/items/10 -->',
      '<html><head><link rel="stylesheet" href="./My Page _ Site_files/style.css"></head>',
      '<body><main id="target">saved</main><script src="./My Page _ Site_files/app.js"></script></body></html>',
    ].join('\n'));
    // Named relatively, and served with everything else blocked, so
    // nothing comes from the network.
    const url = await serveHtml(path.relative(process.cwd(), path.join(repo, 'My Page _ Site.html')), undefined, { block: true });
    await page.goto(url);
    await expect(page.locator('#target')).toHaveText('ran');
    await expect(page.locator('#target')).toHaveCSS('color', 'rgb(1, 2, 3)');
    const status = (p: string) => page.evaluate((u) => fetch(u).then((r) => r.status), p);
    expect(await status('./My Page _ Site_files/missing.css')).toBe(404);
    // Never outside the folder: this one isn't served, so it's blocked.
    await expect(status('./My Page _ Site_files/..%2F..%2Fgreet.user.js')).rejects.toThrow(/Failed to fetch/);
  });

  test('requests are recorded, and a test can answer them: failHosts, and a canned response that ends elsewhere', async ({ page, repo, loadUserscript, gm, serveHtml }) => {
    await writeFile(path.join(repo, 'fetcher.user.js'), `// ==UserScript==
// @name         Fetcher
// @match        https://example.test/fetch
// @grant        GM_xmlhttpRequest
// @connect      example.test
// @connect      down.test
// ==/UserScript==
const get = (url) => new Promise((resolve) => GM_xmlhttpRequest({
  url, onload: (r) => resolve(r.status + ' ' + r.finalUrl + ' ' + r.responseText), onerror: () => resolve('error'),
}));
window.addEventListener('message', async (ev) => {
  if (typeof ev.data !== 'string' || !ev.data.startsWith('get ')) return;
  document.getElementById('target').textContent = await get(ev.data.slice(4));
});
document.getElementById('target').textContent = 'ready';
`);
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/fetch', { block: true });
    await loadUserscript(path.join(repo, 'fetcher.user.js'), { collectionRoot: repo });
    await gm.failHosts('down.test');
    await page.goto('https://example.test/fetch');
    await expect(page.locator('#target')).toHaveText('ready');
    const get = async (url: string): Promise<void> => {
      await page.evaluate((u) => window.postMessage('get ' + u, '*'), url);
    };
    await get('https://down.test/x');
    await expect(page.locator('#target')).toHaveText('503 https://down.test/x ');

    await gm.interceptRequests((request) => (request.url.endsWith('/api') ? {
      kind: 'load',
      response: {
        status: 200, statusText: 'OK', responseURL: 'https://example.test/signin', responseText: 'canned',
        response: 'canned', responseHeaders: 'content-type: text/plain', finalUrl: 'https://example.test/signin',
      },
    } : request.url.endsWith('/broken') ? { kind: 'error', message: 'broken' } : null));
    await get('https://example.test/api');
    await expect(page.locator('#target')).toHaveText('200 https://example.test/signin canned');
    await get('https://example.test/broken');
    await expect(page.locator('#target')).toHaveText('error');
    await expect.poll(() => gm.requests().map((r) => [r.url, r.outcome, r.status])).toEqual([
      ['https://down.test/x', 'load', 503],
      ['https://example.test/api', 'load', 200],
      ['https://example.test/broken', 'error', undefined],
    ]);
  });

  test('opened tabs, notifications, downloads and a second copy are reported', async ({ page, repo, loadUserscript, gm, serveHtml }) => {
    await writeFile(path.join(repo, 'apis.user.js'), `// ==UserScript==
// @name         Apis
// @match        https://example.test/apis
// @grant        GM_openInTab
// @grant        GM_notification
// @grant        GM_download
// @grant        GM_setValue
// ==/UserScript==
GM_setValue('copy', document.title);
window.addEventListener('message', (ev) => {
  if (ev.data === 'open') GM_openInTab('https://example.test/opened');
  if (ev.data === 'notify') GM_notification({ text: 'hi there', title: 'Note', onclick: () => { document.getElementById('target').textContent = 'clicked'; } });
  if (ev.data === 'download') GM_download({ url: 'https://unreachable.invalid/hello.txt', name: 'hello.txt', onerror: (e) => { document.getElementById('target').textContent = 'download ' + e.error; } });
});
`);
    await serveHtml(path.join(repo, 'snapshot.html'), 'https://example.test/apis', { block: true });
    await loadUserscript(path.join(repo, 'apis.user.js'), { collectionRoot: repo });
    await loadUserscript(path.join(repo, 'apis.user.js'), { collectionRoot: repo, copy: 'two', values: { copy: 'seeded' } });
    await page.goto('https://example.test/apis');
    await expect.poll(() => gm.list('apis.user.js')).toEqual({ copy: '' });
    const post = (m: string) => page.evaluate((x) => window.postMessage(x, '*'), m);
    await post('notify');
    await expect.poll(() => gm.notifications().map((n) => n.text)).toEqual(['hi there', 'hi there']);
    expect(await gm.clickNotification(gm.notifications()[0].requestId)).toBe(true);
    await expect(page.locator('#target')).toHaveText('clicked');
    // One that fails is reported as it ended.
    await post('download');
    await expect(page.locator('#target')).toHaveText(/^download /);
    await expect.poll(() => gm.downloads().map((d) => d.outcome)).toEqual(['error', 'error']);
    await post('open');
    await expect.poll(() => gm.openedTabs().map((t) => t.url)).toEqual(['https://example.test/opened', 'https://example.test/opened']);
  });
});
