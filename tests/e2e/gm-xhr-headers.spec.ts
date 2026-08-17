// End-to-end tests for `GM_xmlhttpRequest` request-header surgery.
//
// `fetch()` drops forbidden request headers (`Origin`, `Referer`,
// `User-Agent`, `Cookie`, and anything `Sec-*`), so those travel as a
// short-lived declarativeNetRequest session rule instead. These tests
// assert what lands on the wire, read back from the fixture server's
// `/__echo` route — the page itself can't see any of it.
//
// `Sec-Fetch-Site` is the one that motivated the work: a service
// worker always sends `none`, and sites that gate their APIs on a
// same-origin fetch refuse it.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_xmlhttpRequest header surgery', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  // Cookies go in afterEach, not at the end of the test that sets
  // them: `extensionContext` is worker-scoped, so a failed assertion
  // would otherwise leave one for every later test in the worker.
  test.afterEach(async ({ extensionContext }) => {
    scriptsDir.cleanup();
    await extensionContext.clearCookies();
  });

  // Run one request with `headers` and hand back what the server saw.
  async function echoHeaders(
    opts: {
      extensionContext: import('@playwright/test').BrowserContext;
      fixtureServerUrl: string;
      sm: import('../fixtures/sw-api').SmApi;
      headers: Record<string, string>;
      method?: string;
      // Appended to the echo URL, for the shapes fetch rewrites before
      // the request goes out.
      urlSuffix?: string;
    },
  ): Promise<Record<string, string>> {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Headers',
        match: [`${opts.fixtureServerUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        GM_xmlhttpRequest({
          method: '${opts.method ?? 'GET'}',
          url: '${opts.fixtureServerUrl}/__echo${opts.urlSuffix ?? ''}',
          ${opts.method && opts.method !== 'GET' ? "data: 'body=1'," : ''}
          headers: ${JSON.stringify(opts.headers)},
          onload: (res) => { document.body.dataset.smEcho = res.responseText; },
          onerror: (e) => { document.body.dataset.smError = String(e && e.error || e); },
        });
      `,
    });
    await opts.sm.addCollection(scriptsDir.path);
    await opts.sm.syncNow();

    const page = await opts.extensionContext.newPage();
    await page.goto(`${opts.fixtureServerUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-echo', /sec-fetch-site/);
    const body = await page.locator('body').getAttribute('data-sm-echo');
    await page.close();
    return (JSON.parse(body ?? '{}') as { headers: Record<string, string> }).headers;
  }

  test('a Sec-Fetch-* override reaches the server', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' },
    });
    // Without the rule this is 'none' — the value that identifies a
    // service-worker request and gets refused.
    expect(headers['sec-fetch-site']).toBe('same-origin');
    expect(headers['sec-fetch-mode']).toBe('cors');
  });

  test('Referer and User-Agent overrides reach the server', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: {
        Referer: 'https://example.com/from-here',
        'User-Agent': 'SourceMonkeyTest/1.0',
      },
    });
    expect(headers['referer']).toBe('https://example.com/from-here');
    expect(headers['user-agent']).toBe('SourceMonkeyTest/1.0');
  });

  test('ordinary headers still ride along on the fetch', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { 'X-Custom-Token': 'abc123', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(headers['x-custom-token']).toBe('abc123');
    expect(headers['sec-fetch-site']).toBe('same-origin');
    // The skip-Origin-on-GET optimization rests on a GET never
    // carrying one, custom headers or not. Locked here so a change in
    // Chrome's behavior surfaces as a failure rather than as an
    // extension origin quietly going out.
    expect(headers['origin']).toBeUndefined();
  });

  test('a Cookie override replaces what the browser would send', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await extensionContext.addCookies([
      { name: 'browser_cookie', value: 'from-jar', url: fixtureServer.baseUrl },
    ]);
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { Cookie: 'script_cookie=hand-built' },
    });
    expect(headers['cookie']).toBe('script_cookie=hand-built');
  });

  // The rule is per-request and has to come off when the request ends.
  // A stranded one would keep rewriting every later request to the same
  // URL — including other scripts' — for the rest of the session.
  test('the rule does not outlive its request', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'TwoRequests',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        // Second request deliberately sets no forbidden header, so it
        // installs no rule of its own and would show the first one's
        // value if that rule were still live.
        GM_xmlhttpRequest({
          url: '${fixtureServer.baseUrl}/__echo',
          headers: { 'Sec-Fetch-Site': 'same-origin' },
          onload: () => {
            GM_xmlhttpRequest({
              url: '${fixtureServer.baseUrl}/__echo',
              onload: (res) => { document.body.dataset.smEcho = res.responseText; },
            });
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-echo', /sec-fetch-site/);
    const body = await page.locator('body').getAttribute('data-sm-echo');
    await page.close();
    const headers = (JSON.parse(body ?? '{}') as { headers: Record<string, string> }).headers;
    expect(headers['sec-fetch-site']).toBe('none');
  });

  // The canonicalization bug this covers: DNR matches the URL the
  // browser requests, and a filter built from the raw string missed it
  // entirely — the surgery silently didn't happen.
  test('a URL that fetch will rewrite still gets its headers', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      // A space becomes %20 on the wire; upper-case host lowercases.
      urlSuffix: '?q=a b',
    });
    expect(headers['sec-fetch-site']).toBe('same-origin');
  });

  test('POST drops our extension Origin without being asked', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: {},
      method: 'POST',
    });
    // Unremoved this reads chrome-extension://<id>.
    expect(headers['origin']).toBeUndefined();
  });

  test('a caller-supplied Origin wins over the default removal', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { Origin: 'https://example.com' },
      method: 'POST',
    });
    expect(headers['origin']).toBe('https://example.com');
  });

  test('a request with no overrides is unaffected', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { 'X-Plain': 'yes' },
    });
    expect(headers['x-plain']).toBe('yes');
    // The browser's own value, untouched — no rule was installed.
    expect(headers['sec-fetch-site']).toBe('none');
  });
});
