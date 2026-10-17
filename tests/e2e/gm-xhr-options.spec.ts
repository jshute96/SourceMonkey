// End-to-end tests for GM_xmlhttpRequest's request bodies and the
// options TM and VM support beyond the basics: `context`,
// `overrideMimeType` and the response's charset, GM.xmlHttpRequest's
// Promise, a missing `url`, `redirect: 'error'`, and a callback that
// throws.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { allScripts } from '../fixtures/sw-api';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('GM_xmlhttpRequest options', () => {
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

  const writeScript = (baseUrl: string, name: string, body: string, injectInto?: 'content'): void => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name,
        ...(injectInto ? { injectInto } : {}),
        match: [`${baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
        connect: ['127.0.0.1'],
      },
      body,
    });
  };

  // Each kind of body, posted to the echo route; the page records what
  // the server got, as "content-type | body".
  const BODIES_SCRIPT = (echo: string): string => `
    const post = (data, extra) => new Promise((resolve) => GM_xmlhttpRequest({
      method: 'POST', url: '${echo}', data, responseType: 'json', ...extra,
      onload: (r) => {
        const got = r.response;
        resolve((got.headers['content-type'] || '') + ' | ' + atob(got.body));
      },
      onerror: (r) => resolve('error ' + r.error),
    }));
    (async () => {
      const form = new FormData();
      form.append('a', '1');
      form.append('f', new Blob(['hi'], { type: 'text/plain' }), 'x.txt');
      const results = [
        await post('plain'),
        await post(new URLSearchParams({ q: 'a b' })),
        await post(new Blob(['blob'], { type: 'application/x-test' })),
        await post(new Uint8Array([65, 66, 67]).buffer),
        await post(new Uint8Array([0, 68, 69, 70]).subarray(1)),
        await post('\\u00ff\\u0141', { binary: true }),
        await post(form),
      ];
      document.body.dataset.smBodies = JSON.stringify(results);
    })();
  `;

  const checkBodies = (raw: string | null): void => {
    const got = JSON.parse(raw ?? '[]') as string[];
    expect(got[0]).toBe('text/plain;charset=UTF-8 | plain');
    expect(got[1]).toBe('application/x-www-form-urlencoded;charset=UTF-8 | q=a+b');
    expect(got[2]).toBe('application/x-test | blob');
    expect(got[3]).toBe(' | ABC');
    expect(got[4]).toBe(' | DEF');
    // One byte per character: 0xff, and 0x141 & 0xff.
    expect(got[5]).toBe(' | ÿA');
    expect(got[6]).toMatch(/^multipart\/form-data; boundary=/);
    expect(got[6]).toContain('name="a"\r\n\r\n1\r\n');
    expect(got[6]).toContain('name="f"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n');
  };

  test('request bodies: FormData, URLSearchParams, Blob, buffers and binary strings', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setEcho('/echo');
    writeScript(fixtureServer.baseUrl, 'Bodies', BODIES_SCRIPT(`${dataServer.baseUrl}/echo`));
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-bodies', /.+/);
    checkBodies(await page.locator('body').getAttribute('data-sm-bodies'));
    await page.close();
  });

  test('request bodies from an isolated script', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setEcho('/echo');
    writeScript(fixtureServer.baseUrl, 'BodiesIsolated', BODIES_SCRIPT(`${dataServer.baseUrl}/echo`), 'content');
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-bodies', /.+/);
    checkBodies(await page.locator('body').getAttribute('data-sm-bodies'));
    await page.close();
  });

  test('text decodes by overrideMimeType, else the response charset; context comes back', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    dataServer.setRoute('/bytes', bytes, { contentType: 'application/octet-stream' });
    // "日本" in Shift_JIS.
    dataServer.setRoute('/sjis', Buffer.from([0x93, 0xfa, 0x96, 0x7b]), { contentType: 'text/plain; charset=Shift_JIS' });
    writeScript(fixtureServer.baseUrl, 'Charset', `
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/bytes',
        overrideMimeType: 'text/plain; charset=x-user-defined',
        context: { n: 7 },
        onload: (r) => {
          const t = r.responseText;
          let ok = t.length === 256;
          for (let i = 0; i < t.length; i++) if ((t.charCodeAt(i) & 255) !== i) ok = false;
          document.body.dataset.smBytes = ok + ' ' + r.context.n;
        },
      });
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/sjis',
        onload: (r) => { document.body.dataset.smSjis = r.responseText; },
      });
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-bytes', 'true 7');
    await expect(page.locator('body')).toHaveAttribute('data-sm-sjis', '日本');
    await page.close();
  });

  test('GM.xmlHttpRequest is a Promise; a missing url goes to onerror; redirect: "error" fails', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    dataServer.setRoute('/hello', 'hello', { contentType: 'text/plain' });
    dataServer.setRedirect('/moved', `${dataServer.baseUrl}/hello`);
    writeScript(fixtureServer.baseUrl, 'Promise', `
      (async () => {
        const out = [];
        const r = await GM.xmlHttpRequest({ url: '${dataServer.baseUrl}/hello', context: 'c' });
        out.push(r.responseText + ' ' + r.context);
        const p = GM.xmlHttpRequest({ url: '${dataServer.baseUrl}/hello' });
        out.push(typeof p.abort);
        p.abort();
        try { await p; out.push('resolved'); } catch (e) { out.push('rejected ' + e.status); }
        let noUrl = 'none';
        GM_xmlhttpRequest({ onerror: (e) => { noUrl = e.message; } });
        out.push(noUrl);
        const moved = await new Promise((resolve) => GM_xmlhttpRequest({
          url: '${dataServer.baseUrl}/moved', redirect: 'error',
          onload: () => resolve('load'), onerror: (e) => resolve('error ' + e.error),
        }));
        out.push(moved);
        document.body.dataset.smOut = JSON.stringify(out);
      })();
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-out', /.+/);
    const out = JSON.parse((await page.locator('body').getAttribute('data-sm-out'))!) as string[];
    expect(out.slice(0, 4)).toEqual([
      'hello c', 'function', 'rejected 0', '[SourceMonkey] GM_xmlhttpRequest: url required',
    ]);
    expect(out[4]).toBe('error [SourceMonkey] GM_xmlhttpRequest: The server redirected the request, and the script asked to fail on a redirect (redirect: "error")');
    await page.close();
  });

  for (const injectInto of [undefined, 'content'] as const) {
    test(`a throw in a callback reaches the script's Log (${injectInto ?? 'page'} world)`, async ({
      extensionContext, fixtureServer, sm,
    }) => {
      dataServer.setRoute('/hello', 'hello', { contentType: 'text/plain' });
      writeScript(fixtureServer.baseUrl, 'Thrower', `
        GM_xmlhttpRequest({
          url: '${dataServer.baseUrl}/hello',
          onload: () => { throw new Error('Thrown in onload'); },
        });
      `, injectInto);
      await sm.addCollection(scriptsDir.path);
      await sm.syncNow();
      const id = (await allScripts(sm)).find((r) => r.relativePath.endsWith('a.user.js'))!.id;
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect.poll(async () => (await sm.getScriptLog(id)).some((e) => e.message.includes('Thrown in onload')))
        .toBe(true);
      await page.close();
    });
  }
});
