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

  // How many XHR header rules are live right now. Rules at or above
  // this id are the XHR band (`XHR_RULE_ID_MIN` in `gm-xhr-headers.ts`,
  // duplicated here because the SW-side constant isn't exported).
  const countXhrRules = async (
    getServiceWorker: () => Promise<import('@playwright/test').Worker>,
  ): Promise<number> => {
    const sw = await getServiceWorker();
    return sw.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return rules.filter((r) => r.id >= 1000).length;
    });
  };

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

  // Rules are per-request and have to come off when the request ends.
  // A stranded one rewrites nothing this worker will request, but the
  // id counter restarts each worker life and hands its tag out again —
  // so teardown is checked directly rather than through a later
  // request's headers.
  test('the rule does not outlive its request', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const headers = await echoHeaders({
      extensionContext,
      fixtureServerUrl: fixtureServer.baseUrl,
      sm,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(headers['sec-fetch-site']).toBe('same-origin');
    expect(await countXhrRules(getServiceWorker)).toBe(0);
  });

  // The request goes out as `<url>#sm-xhr-<id>`, which is what makes the
  // rule match one request rather than every request to that URL. Two
  // things have to hold for that to be free: the tag must not reach the
  // server, and a script's own fragment must survive being replaced.
  test('the URL tag stays inside the browser', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Fragment',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        GM_xmlhttpRequest({
          url: '${fixtureServer.baseUrl}/__echo?q=1#script-fragment',
          headers: { 'Sec-Fetch-Site': 'same-origin' },
          onload: (res) => {
            document.body.dataset.smFinal = res.finalUrl;
            document.body.dataset.smEcho = res.responseText;
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-echo', /sec-fetch-site/);
    const echoed = JSON.parse(
      (await page.locator('body').getAttribute('data-sm-echo')) ?? '{}',
    ) as { url: string; headers: Record<string, string> };
    const finalUrl = await page.locator('body').getAttribute('data-sm-final');
    await page.close();
    // The surgery happened even though the script supplied a fragment
    // of its own — it is replaced by the tag, not appended to.
    expect(echoed.headers['sec-fetch-site']).toBe('same-origin');
    // The request target the server received: query intact, no fragment
    // of either kind. (A fragment is never transmitted, so this is what
    // makes the tag safe to add to any URL.)
    expect(echoed.url).toBe('/__echo?q=1');
    // And nothing the script reads back carries the tag.
    expect(finalUrl).toBe(`${fixtureServer.baseUrl}/__echo?q=1`);
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

  // Same-URL overlap — the case the per-request URL tag exists for.
  // Without it a live rule would match every same-URL request of ours,
  // and an overlapping one would carry the other's headers. `?delay=`
  // keeps the first request in flight while the second is issued; the
  // param is part of the URL, so both really do differ only by tag.
  test('an overlapping rule-less request does not pick up the rule', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Overlap',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        const url = '${fixtureServer.baseUrl}/__echo?delay=500';
        GM_xmlhttpRequest({
          url,
          headers: { 'Sec-Fetch-Site': 'same-origin' },
          onload: (res) => { document.body.dataset.smSurgical = res.responseText; },
        });
        // Issued while the first is in flight, so it really does go out
        // under the first one's live rule — and must not match it.
        GM_xmlhttpRequest({
          url,
          onload: (res) => { document.body.dataset.smPlain = res.responseText; },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-surgical', /sec-fetch-site/);
    await expect(page.locator('body')).toHaveAttribute('data-sm-plain', /sec-fetch-site/);
    const surgical = JSON.parse(
      (await page.locator('body').getAttribute('data-sm-surgical')) ?? '{}',
    ) as { headers: Record<string, string> };
    const plain = JSON.parse(
      (await page.locator('body').getAttribute('data-sm-plain')) ?? '{}',
    ) as { headers: Record<string, string> };
    await page.close();
    expect(surgical.headers['sec-fetch-site']).toBe('same-origin');
    expect(plain.headers['sec-fetch-site']).toBe('none');
    // No timing assertion here on purpose: Chrome's HTTP cache holds a
    // single-writer lock per cache key, so two identical GETs are
    // serialized by the browser whatever we do (measured: 800ms and
    // 1600ms for a pair of 800ms requests). The genuinely simultaneous
    // case is the POST pair below — POSTs aren't cached, so they aren't
    // locked either.
  });

  // Every POST installs an `Origin`-removal rule whether or not the
  // script asked for anything, so this is the shape most likely to be
  // serialized by accident if rules ever stopped being per-request.
  test('plain POSTs to one URL still run concurrently', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ConcurrentPosts',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        const url = '${fixtureServer.baseUrl}/__echo?delay=800';
        const started = Date.now();
        let done = 0;
        const finish = () => {
          done += 1;
          if (done === 3) {
            document.body.dataset.smPostsMs = String(Date.now() - started);
            document.body.dataset.smPosts = 'done';
          }
        };
        for (let i = 0; i < 3; i += 1) {
          GM_xmlhttpRequest({ method: 'POST', url, data: 'x=1', onload: finish, onerror: finish });
        }
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-posts', 'done');
    const elapsed = Number(await page.locator('body').getAttribute('data-sm-posts-ms'));
    await page.close();
    // Serialized, three 800ms requests would take ~2.4s. Concurrent,
    // they overlap and finish in roughly one delay — so the midpoint is
    // a wide margin either way.
    expect(elapsed).toBeLessThan(1700);
  });

  // A closed tab can't receive a response, but its request used to run
  // to completion in the worker, holding its rule live that whole time.
  test('closing a tab tears down the rule its requests were holding', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const countRules = (): Promise<number> => countXhrRules(getServiceWorker);

    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'HoldThenClose',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        // Would hold its rule for 10s. The tab closes long before that,
        // so the observe-then-close sequence has plenty of room.
        GM_xmlhttpRequest({
          url: '${fixtureServer.baseUrl}/__echo?delay=10000',
          headers: { 'Sec-Fetch-Site': 'same-origin' },
          onload: () => {},
        });
        document.body.dataset.smSent = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const holder = await extensionContext.newPage();
    await holder.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(holder.locator('body')).toHaveAttribute('data-sm-sent', 'yes');
    await expect.poll(countRules, { timeout: 5000 }).toBe(1);

    await holder.close();
    // The request had ~10s left to run. Without the tab-close cancel the
    // rule stays live for all of it; with it, the rule comes off as the
    // fetch aborts.
    await expect.poll(countRules, { timeout: 2000 }).toBe(0);
  });

  // The cross-contamination case, on POSTs so the browser's own cache
  // lock isn't what keeps them apart: two requests to one URL, both with
  // a rule live at the same time, each carrying only its own headers.
  test('overlapping requests with different overrides each carry only their own', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'OverlapTwoRules',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body: `
        const url = '${fixtureServer.baseUrl}/__echo?delay=800';
        const started = Date.now();
        GM_xmlhttpRequest({
          method: 'POST',
          data: 'x=1',
          url,
          headers: { 'Sec-Fetch-Site': 'same-origin' },
          onload: (res) => { document.body.dataset.smFirst = res.responseText; },
        });
        GM_xmlhttpRequest({
          method: 'POST',
          data: 'x=2',
          url,
          headers: { Referer: 'https://b.test/' },
          onload: (res) => {
            document.body.dataset.smSecondMs = String(Date.now() - started);
            document.body.dataset.smSecond = res.responseText;
          },
        });
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-first', /sec-fetch-site/);
    await expect(page.locator('body')).toHaveAttribute('data-sm-second', /sec-fetch-site/);
    const first = JSON.parse(
      (await page.locator('body').getAttribute('data-sm-first')) ?? '{}',
    ) as { headers: Record<string, string> };
    const second = JSON.parse(
      (await page.locator('body').getAttribute('data-sm-second')) ?? '{}',
    ) as { headers: Record<string, string> };
    const secondMs = Number(await page.locator('body').getAttribute('data-sm-second-ms'));
    await page.close();
    // Each request carries exactly its own overrides — no union in
    // either direction, even though both rules were live at once.
    expect(first.headers['sec-fetch-site']).toBe('same-origin');
    expect(first.headers['referer']).not.toBe('https://b.test/');
    expect(second.headers['referer']).toBe('https://b.test/');
    expect(second.headers['sec-fetch-site']).toBe('none');
    // Both really were in flight together: concurrent they finish in
    // roughly one 800ms hold, serialized in two — so the midpoint is a
    // wide margin either way.
    expect(secondMs).toBeLessThan(1200);
    // Neither picked up the other's `Origin` removal either — both
    // POSTs drop ours, so this is only a check that the rules applied.
    expect(first.headers['origin']).toBeUndefined();
    expect(second.headers['origin']).toBeUndefined();
  });
});
