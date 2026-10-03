// End-to-end tests for GM_xmlhttpRequest's streamed responses: the
// body reaches the page in pieces, with progress callbacks, and has no
// size cap.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('GM_xmlhttpRequest streaming', () => {
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

  const writeScript = (baseUrl: string, name: string, body: string, injectInto?: 'page'): void => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name,
        ...(injectInto ? { injectInto } : {}),
        match: [`${baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_xmlhttpRequest'],
        connect: ['127.0.0.1'],
      },
      body,
    });
  };

  test('a body past the old 50 MB cap and the 64 MiB message limit arrives whole, with progress', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    test.setTimeout(120_000);
    const size = 70 * 1024 * 1024;
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    dataServer.setRoute('/big', bytes, { contentType: 'application/octet-stream' });
    writeScript(fixtureServer.baseUrl, 'BigBody', `
      let progressCount = 0;
      let lastProgress = null;
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/big',
        responseType: 'arraybuffer',
        onprogress: (p) => {
          progressCount++;
          lastProgress = p.lengthComputable + ' ' + p.loaded + ' ' + p.total + ' ' + p.readyState;
        },
        onload: (res) => {
          const view = new Uint8Array(res.response);
          // Every 4099th byte, as a fingerprint of order and content.
          let ok = true;
          for (let i = 0; i < view.length; i += 4099) if (view[i] !== i % 251) { ok = false; break; }
          document.body.dataset.smLen = String(view.length);
          document.body.dataset.smOk = String(ok && view[view.length - 1] === (view.length - 1) % 251);
          document.body.dataset.smProgress = String(progressCount > 1) + ' ' + lastProgress;
        },
        onerror: (e) => { document.body.dataset.smError = String(e.error); },
      });
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-len', String(size), { timeout: 90_000 });
    await expect(page.locator('body')).toHaveAttribute('data-sm-ok', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-progress', `true true ${size} ${size} 3`);
    await page.close();
  });

  test('callbacks come in XMLHttpRequest\'s order, and text grows during progress', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Multi-byte characters across piece boundaries: "€" is 3 bytes,
    // and pieces are 1 MiB, which 3 doesn't divide.
    const text = 'a€'.repeat(800_000);
    dataServer.setRoute('/text', text, { contentType: 'text/plain; charset=utf-8' });
    writeScript(fixtureServer.baseUrl, 'Order', `
      const seen = [];
      const note = (s) => { if (seen[seen.length - 1] !== s) seen.push(s); };
      let grew = true;
      let lastLength = -1;
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/text',
        onloadstart: (r) => note('loadstart' + r.readyState),
        onreadystatechange: (r) => note('rsc' + r.readyState),
        onprogress: (p) => {
          note('progress');
          if (p.responseText.length <= lastLength) grew = false;
          lastLength = p.responseText.length;
        },
        onload: (r) => {
          note('load');
          document.body.dataset.smText = String(r.responseText === ${JSON.stringify('a€')}.repeat(800000) && r.response === r.responseText);
        },
        onloadend: (r) => {
          note('loadend' + r.readyState);
          document.body.dataset.smSeen = seen.join(',');
          document.body.dataset.smGrew = String(grew);
        },
      });
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-seen', 'loadstart1,rsc2,rsc3,progress,rsc4,load,loadend4');
    await expect(page.locator('body')).toHaveAttribute('data-sm-text', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-grew', 'true');
    await page.close();
  });

  test('responseType stream gives a ReadableStream from onloadstart, fed as the body arrives', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const size = 3 * 1024 * 1024 + 5;
    dataServer.setRoute('/stream', Buffer.alloc(size, 9), { contentType: 'application/octet-stream' });
    writeScript(fixtureServer.baseUrl, 'StreamBody', `
      let reads = 0;
      let bytes = 0;
      let allNine = true;
      let sameOnLoad = false;
      let readBeforeLoad = false;
      let stream = null;
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/stream',
        responseType: 'stream',
        onloadstart: async (r) => {
          stream = r.response;
          const reader = r.response.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            reads++;
            if (!sameOnLoad) readBeforeLoad = true;
            bytes += value.byteLength;
            if (!value.every((b) => b === 9)) allNine = false;
          }
          // onload runs before the reader sees done: the stream closes
          // just before it, and done arrives in a later microtask.
          document.body.dataset.smStream = reads + ' ' + bytes + ' ' + allNine + ' ' + sameOnLoad + ' ' + readBeforeLoad;
        },
        onload: (r) => { sameOnLoad = r.response === stream && r.responseText === ''; },
      });
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // At least 4 pieces of up to 1 MiB.
    await expect(page.locator('body')).toHaveAttribute('data-sm-stream', new RegExp(`^([4-9]|\\d{2,}) ${size} true true true$`));
    await page.close();
  });

  test('aborting mid-stream ends the callbacks there', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/abort', Buffer.alloc(5 * 1024 * 1024, 1), { contentType: 'application/octet-stream' });
    writeScript(fixtureServer.baseUrl, 'AbortMidStream', `
      const seen = [];
      const handle = GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/abort',
        responseType: 'arraybuffer',
        onreadystatechange: (r) => {
          seen.push('rsc' + r.readyState);
          // Aborted from inside a callback the same event fires.
          if (r.readyState === 3) handle.abort();
        },
        onprogress: () => seen.push('progress'),
        onload: () => seen.push('load'),
        onabort: () => seen.push('abort'),
        onloadend: () => {
          seen.push('loadend');
          setTimeout(() => { document.body.dataset.smSeen = seen.join(','); }, 1000);
        },
      });
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-seen', 'rsc2,rsc3,rsc4,abort,loadend');
    await page.close();
  });

  test('a page-world script gets a multi-piece body through the bridge', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const size = 3 * 1024 * 1024 + 5;
    dataServer.setRoute('/main', Buffer.alloc(size, 3), { contentType: 'application/octet-stream' });
    writeScript(fixtureServer.baseUrl, 'MainWorld', `
      let progress = 0;
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/main',
        responseType: 'arraybuffer',
        onprogress: () => { progress++; },
        onload: (r) => {
          const view = new Uint8Array(r.response);
          document.body.dataset.smMain = view.length + ' ' + view.every((b) => b === 3) + ' ' + (progress > 1);
        },
      });
    `, 'page');
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-main', `${size} true true`);
    await page.close();
  });

  test('cancelling the stream ends the request as aborted; aborting errors the stream', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    dataServer.setRoute('/stream', Buffer.alloc(5 * 1024 * 1024, 2), { contentType: 'application/octet-stream' });
    writeScript(fixtureServer.baseUrl, 'StreamEnds', `
      const run = (name, end) => new Promise((resolve) => {
        const seen = [];
        const handle = GM_xmlhttpRequest({
          url: '${dataServer.baseUrl}/stream',
          responseType: 'stream',
          onloadstart: async (r) => {
            const reader = r.response.getReader();
            await reader.read();
            if (end === 'cancel') {
              await reader.cancel();
            } else {
              handle.abort();
              try { await reader.read(); seen.push('read'); } catch (e) { seen.push('rejected ' + e.name); }
            }
            setTimeout(() => resolve(name + ': ' + seen.join(',')), 500);
          },
          onload: () => seen.push('load'),
          onerror: () => seen.push('error'),
          onabort: () => seen.push('abort'),
          onloadend: () => seen.push('loadend'),
        });
      });
      (async () => {
        const out = [await run('cancel', 'cancel'), await run('abort', 'abort')];
        document.body.dataset.smEnds = out.join(' | ');
      })();
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ends', 'cancel: abort,loadend | abort: abort,loadend,rejected AbortError');
    await page.close();
  });

  test('a blob of several pieces has the whole body and its type', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const size = 3 * 1024 * 1024 + 5;
    dataServer.setRoute('/blob', Buffer.alloc(size, 7), { contentType: 'image/png' });
    writeScript(fixtureServer.baseUrl, 'BlobPieces', `
      GM_xmlhttpRequest({
        url: '${dataServer.baseUrl}/blob',
        responseType: 'blob',
        onload: async (r) => {
          const view = new Uint8Array(await r.response.arrayBuffer());
          document.body.dataset.smBlob = r.response.size + ' ' + r.response.type + ' ' + view.every((b) => b === 7);
        },
      });
    `);
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-blob', `${size} image/png true`);
    await page.close();
  });
});
