// End-to-end tests for `@connect` gating on GM_xmlhttpRequest.
//
// A request goes when a `@connect` rule covers its host (`*`,
// `*.subdomain`, `self`, a bare host) or it goes to the page's own
// origin. Any other http(s) host gets SourceMonkey's prompt, whose
// answer is kept per script (connect-prompt.ts, connect-grants.ts).
// The tests answer it in its window, by closing the window, or through
// the worker as sm-dev does.

import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';
import { allScripts } from '../fixtures/sw-api';

// A script that requests `url` once per page load, and records how it
// went on the body: `data-sm-text` on load, `data-sm-err` on error.
function requestBody(url: string): string {
  return `
    GM_xmlhttpRequest({
      method: 'GET',
      url: ${JSON.stringify(url)},
      onload: (res) => { document.body.dataset.smText = res.responseText; },
      onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
    });
  `;
}

// Click a prompt button. The worker closes the window as it takes the
// answer, which can land before Playwright's click finishes; that is
// the click working, not failing.
async function choose(prompt: Page, id: string): Promise<void> {
  await prompt.locator(`#${id}`).click().catch((err: Error) => {
    if (!prompt.isClosed() && !/closed/.test(err.message)) throw err;
  });
}

function promptWindow(context: BrowserContext): Promise<Page> {
  return context.waitForEvent('page', { predicate: (p) => p.url().includes('connect-prompt.html') });
}

test.describe('GM_xmlhttpRequest @connect gating', () => {
  let scriptsDir: ScriptsDir;
  let dataServer: UserscriptServer;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    dataServer = await UserscriptServer.start();
  });
  test.afterEach(async () => {
    scriptsDir.cleanup();
    await dataServer.stop();
  });

  async function install(
    sm: { addCollection(p: string): Promise<unknown>; syncNow(): Promise<unknown> },
    fixtureUrl: string,
    body: string,
    connect?: string[],
  ): Promise<void> {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'ConnectTest',
        match: [`${fixtureUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        ...(connect ? { connect } : {}),
      },
      body,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
  }

  test('an undeclared host opens the prompt; Allow lets it go and is remembered', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setRoute('/x', 'body', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/x?token=secret`));

    const prompted = promptWindow(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const prompt = await prompted;
    await expect(prompt.locator('.page-body p').first()).toHaveText('Script ConnectTest is requesting access to 127.0.0.1.');
    await expect(prompt.locator('#site')).toHaveAttribute('href', `${dataServer.baseUrl}/`);
    // The query string is left out of the request in the tooltip.
    await expect(prompt.locator('#site')).toHaveAttribute('title', `GET ${dataServer.baseUrl}/x`);
    const closed = prompt.waitForEvent('close');
    await choose(prompt, 'allow');
    await closed;
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'body');

    // Remembered: a reload asks nothing and goes straight through.
    const scriptId = (await allScripts(sm))[0].id;
    expect(await sm.pendingConnectPrompts()).toEqual([]);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'body');
    expect(await sm.pendingConnectPrompts()).toEqual([]);
    const stored = await extensionContext.serviceWorkers()[0].evaluate(
      (key) => chrome.storage.local.get(key), `connectGrants:${scriptId}`);
    expect(stored[`connectGrants:${scriptId}`]).toEqual({ hosts: ['127.0.0.1'] });
    await page.close();
  });

  test('Deny fails the request, and later requests fail without asking', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setRoute('/x', 'leaked', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/x`), ['example.com']);

    const prompted = promptWindow(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const prompt = await prompted;
    await choose(prompt, 'deny');
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /Connecting to 127\.0\.0\.1 was denied for this script/);
    expect(await page.locator('body').getAttribute('data-sm-text')).toBeNull();

    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /was denied/);
    expect(await sm.pendingConnectPrompts()).toEqual([]);
    expect(dataServer.requestLog.filter((r) => r.path === '/x')).toHaveLength(0);
    await page.close();
  });

  test('Allow once, Cancel, or closing the window settle only the requests waiting; the next one asks again', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setRoute('/x', 'body', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/x`));

    let prompted = promptWindow(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await choose(await prompted, 'cancel');
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /permission prompt for connecting to 127\.0\.0\.1 was cancelled/);

    prompted = promptWindow(extensionContext);
    await page.reload();
    await (await prompted).close();
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /was cancelled/);

    // Nothing was kept: the next load asks again. Allow once lets that
    // request go, and keeps nothing either.
    prompted = promptWindow(extensionContext);
    await page.reload();
    await choose(await prompted, 'once');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'body');
    prompted = promptWindow(extensionContext);
    await page.reload();
    await choose(await prompted, 'allow');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'body');
    const scriptId = (await allScripts(sm))[0].id;
    const messages = (await sm.getScriptLog(scriptId)).filter((e) => e.source === 'gm-xhr').map((e) => `${e.level}: ${e.message}`);
    expect(messages).toEqual([
      `info: Opened permission request window for connection to 127.0.0.1 (GET ${dataServer.baseUrl}/x)`,
      'warning: Cancelled the permission prompt about connecting to 127.0.0.1. The requests waiting on it were blocked, and the next one asks again.',
      `info: Opened permission request window for connection to 127.0.0.1 (GET ${dataServer.baseUrl}/x)`,
      'warning: The permission prompt about connecting to 127.0.0.1 was closed, which cancels it. The requests waiting on it were blocked, and the next one asks again.',
      `info: Opened permission request window for connection to 127.0.0.1 (GET ${dataServer.baseUrl}/x)`,
      'info: Allowed this script to connect to 127.0.0.1 once. The requests waiting on the permission prompt were sent, and the next one asks again.',
      `info: Opened permission request window for connection to 127.0.0.1 (GET ${dataServer.baseUrl}/x)`,
      'info: Allowed this script to connect to 127.0.0.1',
    ]);
    await page.close();
  });

  test('a denied site logs one warning per page load, however often the script retries', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setRoute('/x', 'x', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, `
      let n = 0;
      const go = () => GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/x',
        onerror: () => { if (++n < 3) go(); else document.body.dataset.smDone = String(n); },
      });
      go();
    `);
    const prompted = promptWindow(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await choose(await prompted, 'deny');
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '3');
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '3');
    const scriptId = (await allScripts(sm))[0].id;
    const warnings = (await sm.getScriptLog(scriptId))
      .filter((e) => e.source === 'gm-xhr' && e.message.startsWith('Blocked a request'));
    // The first load's two retries log once; the second load's three
    // requests log once more.
    expect(warnings).toHaveLength(2);
    expect(warnings[0].level).toBe('warning');
    await page.close();
  });

  test('Allow all sites covers other hosts too', async ({ extensionContext, fixtureServer, sm }) => {
    const otherHost = dataServer.baseUrl.replace('127.0.0.1', 'localhost');
    dataServer.setRoute('/x', 'first', { contentType: 'text/plain' });
    dataServer.setRoute('/y', 'second', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, `
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/x',
        onload: () => GM_xmlhttpRequest({
          url: '${otherHost}/y',
          onload: (res) => { document.body.dataset.smText = res.responseText; },
          onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
        }),
      });
    `);

    const prompted = promptWindow(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await choose(await prompted, 'allow-all');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'second');
    expect(await sm.pendingConnectPrompts()).toEqual([]);
    await page.close();
  });

  test('requests to one host wait on a single prompt', async ({ extensionContext, fixtureServer, sm }) => {
    dataServer.setRoute('/x', 'x', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, `
      let done = 0;
      for (let i = 0; i < 3; i++) {
        GM_xmlhttpRequest({
          url: '${dataServer.baseUrl}/x',
          onload: () => { document.body.dataset.smDone = String(++done); },
        });
      }
    `);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(async () => (await sm.pendingConnectPrompts()).length).toBe(1);
    const [waiting] = await sm.pendingConnectPrompts();
    expect(waiting.host).toBe('127.0.0.1');
    expect(await sm.answerConnectPrompt(waiting.promptId, 'allow')).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '3');
    await page.close();
  });

  test('abort() while the prompt waits: the request never goes, and the prompt closes', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setRoute('/x', 'x', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, `
      const req = GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/x',
        onabort: () => { document.body.dataset.smAborted = 'yes'; },
        onload: () => { document.body.dataset.smText = 'loaded'; },
      });
      window.addEventListener('sm-abort', () => req.abort());
    `);
    const prompted = promptWindow(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const prompt = await prompted;
    const closed = prompt.waitForEvent('close');
    await page.evaluate(() => window.dispatchEvent(new Event('sm-abort')));
    await expect(page.locator('body')).toHaveAttribute('data-sm-aborted', 'yes');
    // Nobody is waiting on it any more.
    await closed;
    await expect.poll(async () => (await sm.pendingConnectPrompts()).length).toBe(0);
    expect(dataServer.requestLog.filter((r) => r.path === '/x')).toHaveLength(0);
    expect(await page.locator('body').getAttribute('data-sm-text')).toBeNull();
    await page.close();
  });

  test('a script gets at most three prompts at once', async ({ extensionContext, fixtureServer, sm }) => {
    // Never fetched: each waits on its prompt, or fails before asking.
    await install(sm, fixtureServer.baseUrl, `
      for (const host of ['a', 'b', 'c', 'd']) {
        GM_xmlhttpRequest({
          url: 'http://' + host + '.invalid/x',
          onerror: (e) => { document.body.dataset['smErr' + host] = String(e && e.error || ''); },
        });
      }
    `);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute(
      'data-sm-errd', /already asking about 3 other sites for this script, so this request to d\.invalid was blocked/);
    const waiting = await sm.pendingConnectPrompts();
    expect(waiting.map((p) => p.host).sort()).toEqual(['a.invalid', 'b.invalid', 'c.invalid']);
    for (const p of waiting) await sm.answerConnectPrompt(p.promptId, 'cancel');
    await page.close();
  });

  test('the page\'s own origin needs no @connect, and a relative URL resolves against the page', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    await install(sm, fixtureServer.baseUrl, `
      GM_xmlhttpRequest({
        url: 'target.html',
        onload: (res) => { document.body.dataset.smFinal = res.finalUrl; document.body.dataset.smStatus = String(res.status); },
        onerror: (e) => { document.body.dataset.smErr = String(e && e.error || ''); },
      });
    `, ['example.com']);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-status', '200');
    await expect(page.locator('body')).toHaveAttribute('data-sm-final', `${fixtureServer.baseUrl}/target.html`);
    expect(await sm.pendingConnectPrompts()).toEqual([]);
    await page.close();
  });

  test('matching @connect allows the request', async ({ extensionContext, fixtureServer, sm }) => {
    dataServer.setRoute('/ok', 'allowed', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/ok`), ['127.0.0.1']);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'allowed');
    await page.close();
  });

  test('@connect *.subdomain matches the host itself', async ({ extensionContext, fixtureServer, sm }) => {
    // Every test server is 127.0.0.1, so this checks the pattern
    // surface: 127.0.0.1 ends with `.0.0.1`, which `*.0.0.1` covers.
    dataServer.setRoute('/ok', 'allowed', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/ok`), ['*.0.0.1']);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'allowed');
    await page.close();
  });

  test('@connect * allows everything', async ({ extensionContext, fixtureServer, sm }) => {
    dataServer.setRoute('/anywhere', 'wild', { contentType: 'text/plain' });
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/anywhere`), ['*']);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'wild');
    await page.close();
  });

  test('a redirect to an undeclared host asks too, and Deny leaks nothing', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // 127.0.0.1 is declared but 302s to `localhost` (also loopback, so
    // reachable), which isn't. Without the post-redirect check, fetch
    // would follow the redirect and hand the script the body.
    const otherHost = dataServer.baseUrl.replace('127.0.0.1', 'localhost');
    dataServer.setRoute('/secret', 'leaked-via-redirect', { contentType: 'text/plain' });
    dataServer.setRedirect('/redirect', `${otherHost}/secret`);
    await install(sm, fixtureServer.baseUrl, requestBody(`${dataServer.baseUrl}/redirect`), ['127.0.0.1']);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(async () => (await sm.pendingConnectPrompts()).map((p) => p.host)).toEqual(['localhost']);
    const [waiting] = await sm.pendingConnectPrompts();
    await sm.answerConnectPrompt(waiting.promptId, 'deny');
    await expect(page.locator('body')).toHaveAttribute('data-sm-err', /Connecting to localhost was denied/);
    expect(await page.locator('body').getAttribute('data-sm-text')).toBeNull();
    await page.close();
  });

  test('a URL with no host is refused unless @connect * allows it', async ({ extensionContext, fixtureServer, sm }) => {
    await install(sm, fixtureServer.baseUrl, requestBody('data:text/plain,hi'), ['example.com']);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute(
      'data-sm-err', /This script's @connect rules don't allow this request\. A data: URL has no host to allow/);
    await page.close();
  });

  test('the script page lists an allowed host under Network access, and can take it back', async ({
    extensionContext, extensionId, sm,
  }) => {
    await install(sm, 'https://example.com', '', ['api.example.com']);
    const scriptId = (await allScripts(sm))[0].id;
    expect(await sm.answerConnectPrompt('none', 'allow')).toBe(false);
    await extensionContext.serviceWorkers()[0].evaluate(async ({ id }) => {
      await chrome.storage.local.set({
        [`connectGrants:${id}`]: { hosts: ['cdn.example.net'], allHosts: true, denied: ['tracker.example.org'] },
      });
    }, { id: scriptId });

    const viewer = await extensionContext.newPage();
    await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    const row = viewer.locator('#header-summary dt:text-is("Network access") + dd');
    await expect(row).toContainText('api.example.com');
    const answer = (text: string) => row.locator('.connect-answer', { hasText: text });
    await expect(answer('All sites')).toHaveText('All sites:AllowedReset');
    await expect(answer('cdn.example.net')).toHaveText('cdn.example.net:AllowedReset');
    await expect(answer('tracker.example.org')).toHaveText('tracker.example.org:DeniedReset');
    const allowReset = answer('cdn.example.net').getByRole('button', { name: 'Reset' });
    await expect(allowReset).toHaveAttribute('title', 'Clear this approval. The next request will prompt again.');
    await allowReset.click();
    await expect(row).not.toContainText('cdn.example.net');
    await answer('All sites').getByRole('button', { name: 'Reset' }).click();
    await expect(row).not.toContainText('All sites');
    const denyReset = answer('tracker.example.org').getByRole('button', { name: 'Reset' });
    await expect(denyReset).toHaveAttribute('title', 'Clear this denial. The next request will prompt again.');
    await denyReset.click();
    await expect(row).not.toContainText('tracker.example.org');
    await expect(row).toContainText('api.example.com');
    const left = await extensionContext.serviceWorkers()[0].evaluate(
      ({ id }) => chrome.storage.local.get(`connectGrants:${id}`), { id: scriptId });
    expect(left).toEqual({});
    await viewer.close();
  });
});
