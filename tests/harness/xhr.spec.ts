// GM_xmlhttpRequest under the push backend: the host runs the request
// with the extension's own `runXhr` and `@connect` rules, and the page
// side sees the same events it would from the service worker.

import http from 'node:http';
import { test, expect } from '../fixtures/harness.js';

// A script that sends one request described by a `message` from the
// test and writes the outcome into `#target`.
function requester(connect: string[]) {
  return {
    relativePath: 'xhr.user.js',
    meta: { name: 'Xhr', match: ['*://*/target.html'], grant: ['GM_xmlhttpRequest'], connect },
    body: `
      const out = (text) => { document.getElementById('target').textContent = text; };
      window.addEventListener('message', (ev) => {
        if (!ev.data || ev.data.kind !== 'send') return;
        GM_xmlhttpRequest({
          ...ev.data.details,
          onload: (r) => out('load ' + r.status + ' ' + (ev.data.details.responseType === 'json' ? JSON.stringify(r.response) : r.responseText)),
          onerror: (e) => out('error ' + e.error),
          ontimeout: () => out('timeout'),
          onabort: () => out('abort'),
        });
      });
    `,
  };
}

async function send(page: import('@playwright/test').Page, details: Record<string, unknown>) {
  await page.evaluate((d) => window.postMessage({ kind: 'send', details: d }, '*'), details);
}

test.describe('harness GM_xmlhttpRequest', () => {
  test('a GET to an allowed host loads, and is recorded', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { method: 'GET', url: `${fixtureServer.baseUrl}/other.html` });
    await expect(page.locator('#target')).toHaveText(/^load 200 /);
    expect(host.reports.requests).toHaveLength(1);
    expect(host.reports.requests[0]).toMatchObject({ method: 'GET', outcome: 'load', status: 200 });
  });

  test('onreadystatechange gets readyState 4 before every terminal callback', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      ...requester(['127.0.0.1']),
      body: `
        const out = (text) => { document.getElementById('target').textContent = text; };
        window.addEventListener('message', (ev) => {
          if (!ev.data || ev.data.kind !== 'send') return;
          const seen = [];
          // The terminal object's readyState, status and responseText
          // length: the empty-text fields must exist on every outcome.
          const end = (kind) => (r) => out(seen.concat(
            kind + r.readyState + ' ' + r.status + ' ' + r.responseText.length).join(','));
          const control = GM_xmlhttpRequest({
            ...ev.data.details,
            onreadystatechange: (r) => seen.push('rsc' + r.readyState + ' ' + r.status),
            onload: end('load'),
            onerror: end('error'),
            ontimeout: end('timeout'),
            onabort: end('abort'),
          });
          if (ev.data.abortAfter != null) setTimeout(() => control.abort(), ev.data.abortAfter);
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/other.html` });
    await expect(page.locator('#target')).toHaveText(/^rsc4 200,load4 200 [1-9]/);
    await send(page, { url: 'http://127.0.0.1:1/never' });
    await expect(page.locator('#target')).toHaveText('rsc4 0,error4 0 0');
    await send(page, { url: `${fixtureServer.baseUrl}/__slow/other.html?ms=3000`, timeout: 200 });
    await expect(page.locator('#target')).toHaveText('rsc4 0,timeout4 0 0');
    await page.evaluate((url) => window.postMessage({ kind: 'send', details: { url }, abortAfter: 50 }, '*'),
      `${fixtureServer.baseUrl}/__slow/other.html?ms=3000`);
    await expect(page.locator('#target')).toHaveText('rsc4 0,abort4 0 0');
  });

  test('a 404 still fires onload', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/no-such-file.html` });
    await expect(page.locator('#target')).toHaveText(/^load 404/);
  });

  test('responseType json parses the body', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/__echo`, responseType: 'json' });
    await expect(page.locator('#target')).toHaveText(/^load 200 \{"method":"GET"/);
  });

  test('a host outside @connect is refused with the extension\'s message', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['example.com']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/other.html` });
    await expect(page.locator('#target')).toHaveText(/not in @connect allowlist/);
    expect(host.reports.requests[0].outcome).toBe('error');
  });

  test('no @connect at all blocks every host', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester([]));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/other.html` });
    await expect(page.locator('#target')).toHaveText(/@connect not declared/);
  });

  test('the browser\'s cookies ride along unless the request is anonymous', async ({ page, context, fixtureServer, host, loadScript }) => {
    await context.addCookies([{ name: 'session', value: 'abc', url: fixtureServer.baseUrl }]);
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    const echoedCookie = async (): Promise<string | undefined> => {
      const text = (await page.locator('#target').textContent()) ?? '';
      const json = JSON.parse(text.replace(/^load 200 /, ''));
      return json.headers.cookie;
    };
    await send(page, { url: `${fixtureServer.baseUrl}/__echo`, responseType: 'json' });
    await expect(page.locator('#target')).toContainText('load 200');
    expect(await echoedCookie()).toBe('session=abc');
    await page.locator('#target').evaluate((el) => { el.textContent = ''; });
    await send(page, { url: `${fixtureServer.baseUrl}/__echo`, responseType: 'json', anonymous: true });
    await expect(page.locator('#target')).toContainText('load 200');
    expect(await echoedCookie()).toBeUndefined();
  });

  test('a request asks for the page\'s languages, unless the script sets its own', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    const pageHeader = await page.evaluate(() => fetch('/__echo').then((r) => r.json()).then((j) => j.headers['accept-language']));
    expect(pageHeader).toBeTruthy();
    await send(page, { url: `${fixtureServer.baseUrl}/__echo`, responseType: 'json' });
    await expect(page.locator('#target')).toContainText('load 200');
    const text = (await page.locator('#target').textContent()) ?? '';
    expect(JSON.parse(text.replace(/^load 200 /, '')).headers['accept-language']).toBe(pageHeader);
    // A header the script sets wins.
    await page.locator('#target').evaluate((el) => { el.textContent = ''; });
    await send(page, { url: `${fixtureServer.baseUrl}/__echo`, responseType: 'json', headers: { 'Accept-Language': 'fr' } });
    await expect(page.locator('#target')).toContainText('load 200');
    const own = (await page.locator('#target').textContent()) ?? '';
    expect(JSON.parse(own.replace(/^load 200 /, '')).headers['accept-language']).toBe('fr');
  });

  test('a request goes out while the page shows a dialog', async ({ page, fixtureServer, host, loadScript }) => {
    // The languages for its header come from the page, which answers
    // nothing while an alert is up: they must not hold the request.
    let heard!: (language: string) => void;
    const reached = new Promise<string>((resolve) => { heard = resolve; });
    const server = http.createServer((req, res) => {
      heard(String(req.headers['accept-language'] ?? ''));
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await loadScript({
        ...requester(['localhost']),
        body: `
          window.addEventListener('message', (ev) => {
            if (ev.data?.kind !== 'send') return;
            GM_xmlhttpRequest({ url: ev.data.url });
            alert('hold');
          });
        `,
      });
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect.poll(() => host.reports.started.length).toBe(1);
      const pageHeader = await page.evaluate(() => fetch('/__echo').then((r) => r.json()).then((j) => j.headers['accept-language']));
      let whileOpen: string | null = null;
      const dismissed = new Promise<void>((resolve) => {
        page.once('dialog', async (dialog) => {
          whileOpen = await Promise.race([reached, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
          await dialog.dismiss();
          resolve();
        });
      });
      await page.evaluate((url) => window.postMessage({ kind: 'send', url }, '*'), `http://localhost:${port}/`);
      await dismissed;
      expect(whileOpen).toBe(pageHeader);
    } finally {
      server.close();
    }
  });

  test('a timeout fires ontimeout', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/__slow/other.html?ms=3000`, timeout: 200 });
    await expect(page.locator('#target')).toHaveText('timeout');
    expect(host.reports.requests[0].outcome).toBe('timeout');
  });

  test('a script\'s own Cookie header replaces the browser\'s jar', async ({ page, context, fixtureServer, host, loadScript }) => {
    await context.addCookies([{ name: 'session', value: 'abc', url: fixtureServer.baseUrl }]);
    await loadScript(requester(['127.0.0.1']));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/__echo`, responseType: 'json', headers: { Cookie: 'mine=1' } });
    await expect(page.locator('#target')).toContainText('load 200');
    const text = (await page.locator('#target').textContent()) ?? '';
    expect(JSON.parse(text.replace(/^load 200 /, '')).headers.cookie).toBe('mine=1');
  });

  test('abort fires onabort and the request is recorded as aborted', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      ...requester(['127.0.0.1']),
      body: `
        const out = (text) => { document.getElementById('target').textContent = text; };
        window.addEventListener('message', (ev) => {
          if (!ev.data || ev.data.kind !== 'send') return;
          const control = GM_xmlhttpRequest({
            ...ev.data.details,
            onload: (r) => out('load ' + r.status),
            onerror: (e) => out('error ' + e.error),
            onabort: () => out('abort'),
          });
          setTimeout(() => control.abort(), 50);
        });
      `,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/__slow/other.html?ms=2000` });
    await expect(page.locator('#target')).toHaveText('abort');
    await expect.poll(() => host.reports.requests[0].outcome).toBe('abort');
  });

  test('a redirect to a host outside @connect is refused after the fact', async ({ page, fixtureServer, host, loadScript }) => {
    // A tiny server on its own host name that bounces to the fixture
    // server, which the script's @connect does not allow.
    const bouncer = http.createServer((req, res) => {
      res.writeHead(302, { Location: `${fixtureServer.baseUrl}/other.html` });
      res.end();
    });
    await new Promise<void>((resolve) => bouncer.listen(0, 'localhost', resolve));
    const port = (bouncer.address() as { port: number }).port;
    try {
      await loadScript(requester(['localhost']));
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect.poll(() => host.reports.started.length).toBe(1);
      await send(page, { url: `http://localhost:${port}/go` });
      await expect(page.locator('#target')).toHaveText(/redirect to 127\.0\.0\.1 not allowed/);
    } finally {
      bouncer.close();
    }
  });

  test('an abort sent before the request starts still ends it as aborted', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript({
      ...requester(['127.0.0.1']),
      body: `
        window.addEventListener('message', (ev) => {
          if (!ev.data || ev.data.kind !== 'send') return;
          GM_xmlhttpRequest({ ...ev.data.details }).abort();
        });
      `,
    });
    // Slow to answer, so the abort lands while the request is still
    // on its way to the fetch.
    host.interceptRequests = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { kind: 'error', message: 'should not be delivered' };
    };
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/other.html` });
    await expect.poll(() => host.reports.requests[0]?.outcome).toBe('abort');
  });

  test('a test can answer a request itself', async ({ page, fixtureServer, host, loadScript }) => {
    await loadScript(requester(['127.0.0.1']));
    host.interceptRequests = (request) => request.url.endsWith('/canned')
      ? { kind: 'error', message: 'canned failure' }
      : null;
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.started.length).toBe(1);
    await send(page, { url: `${fixtureServer.baseUrl}/canned` });
    await expect(page.locator('#target')).toHaveText('error canned failure');
    await send(page, { url: `${fixtureServer.baseUrl}/other.html` });
    await expect(page.locator('#target')).toHaveText(/^load 200/);
    expect(host.reports.requests.map((r) => r.outcome)).toEqual(['error', 'load']);
  });
});
