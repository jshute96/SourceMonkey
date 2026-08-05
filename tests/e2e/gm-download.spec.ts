// End-to-end tests for GM_download.
//
// Two transports are exercised:
//   - http(s) → the SW's chrome.downloads wrapper. Headless Chromium
//     does run real downloads (Playwright points the download manager
//     at a temp dir), so `onload` genuinely means "the download
//     manager reported state=complete".
//   - data: (and blob:) → the page-side `<a download>` click, which
//     never reaches the SW.
//
// The refusal paths (bad scheme, unsafe name) are asserted through the
// script's own `onerror` AND through the per-script Log tab, since a
// silently-missing file is the failure mode users actually hit.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Report every callback the script sees as `data-sm-download`, so each
// test can assert on one attribute. Shared by most cases below.
const REPORTER = `
  const report = (s) => { document.body.dataset.smDownload = s; };
`;

test.describe('GM_download', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('downloads an http URL and fires onload with the saved filename', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadOk',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        GM_download({
          url: '${fixtureServer.baseUrl}/target.html',
          name: 'sm-download-ok.html',
          onload: (r) => report('load:' + (r && r.filename ? 'named' : 'unnamed')),
          onerror: (e) => report('error:' + (e && e.error)),
          ontimeout: () => report('timeout'),
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'load:named', {
      timeout: 15000,
    });
    await page.close();
  });

  test('the (url, name) positional form works too', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadPositional',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        // No details object at all — TM's two-argument shorthand. The
        // control object is still returned synchronously.
        const ctl = GM_download('${fixtureServer.baseUrl}/target.html', 'sm-positional.html');
        document.body.dataset.smCtl = String(ctl && typeof ctl.abort === 'function');
        report('started');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ctl', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'started');
    await page.close();
  });

  test('a data: URL is downloaded in-page and still fires onload', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadData',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        GM_download({
          url: 'data:text/plain;base64,aGVsbG8=',
          name: 'sm-data.txt',
          onload: () => report('load'),
          onerror: (e) => report('error:' + (e && e.error)),
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'load');
    await page.close();
  });

  test('a blob: URL built in the page is downloaded in-page', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // The shape every popular media-downloader script uses: build the
    // bytes in the page, hand GM_download the object URL. The SW can't
    // resolve a page-minted blob URL, so this has to stay in-page.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadBlob',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        const url = URL.createObjectURL(new Blob(['hi'], { type: 'text/plain' }));
        GM_download({
          url,
          name: 'sm-blob.txt',
          onload: (r) => { URL.revokeObjectURL(url); report('load:' + r.finalUrl.slice(0, 5)); },
          onerror: (e) => report('error:' + (e && e.error)),
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'load:blob:');
    await page.close();
  });

  test('a file:// URL is refused with not_permitted and logged', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadFileScheme',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        GM_download({
          url: 'file:///etc/passwd',
          name: 'stolen.txt',
          onload: () => report('unexpected-load'),
          onerror: (e) => report('error:' + (e && e.error)),
        });
      `,
    });
    const source = await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'error:not_permitted');

    // The same refusal lands on the script's Log tab — a user who sees
    // "nothing downloaded" needs a reason somewhere.
    const withScripts = await sm.getSourceWithScripts(source!.id);
    const scriptId = withScripts!.scripts[0].id;
    await expect.poll(async () => {
      const entries = await sm.getScriptLog(scriptId);
      return entries.filter((e) => e.source === 'gm-download').map((e) => e.message).join('\n');
    }).toMatch(/not_permitted/);
    await page.close();
  });

  test('a traversing `name` is refused with not_permitted', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadTraversal',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        GM_download({
          url: '${fixtureServer.baseUrl}/target.html',
          name: '../../evil.html',
          onload: () => report('unexpected-load'),
          onerror: (e) => report('error:' + (e && e.error)),
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'error:not_permitted');
    await page.close();
  });

  test('abort() settles the call as download_canceled', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadAbort',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        const ctl = GM_download({
          url: '${fixtureServer.baseUrl}/__slow/target.html?ms=5000',
          name: 'sm-aborted.html',
          onload: () => report('unexpected-load'),
          onerror: (e) => report('error:' + (e && e.error) + ':' + (e && e.details && e.details.current)),
        });
        ctl.abort();
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute(
      'data-sm-download',
      'error:download_canceled:USER_CANCELED',
    );
    await page.close();
  });

  test('abort() prefers onabort when the script supplies one', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadOnAbort',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        const ctl = GM_download({
          url: '${fixtureServer.baseUrl}/__slow/target.html?ms=5000',
          name: 'sm-aborted-2.html',
          onerror: () => report('onerror'),
          onabort: () => report('onabort'),
        });
        ctl.abort();
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'onabort');
    await page.close();
  });

  test('a missing url throws synchronously', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadNoUrl',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        try {
          GM_download({ name: 'nope.txt' });
          report('unexpected-ok');
        } catch (e) {
          report('threw:' + /url required/.test(String(e && e.message)));
        }
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'threw:true');
    await page.close();
  });

  test('GM.download (GM4 alias) is bound and returns the control object', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadGmDot',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download'],
      },
      body: `${REPORTER}
        const ctl = GM.download({
          url: 'data:text/plain,hi',
          name: 'sm-gm-dot.txt',
          onload: () => report('load'),
          onerror: (e) => report('error:' + (e && e.error)),
        });
        document.body.dataset.smCtl = String(ctl && typeof ctl.abort === 'function');
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-ctl', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'load');
    await page.close();
  });

  test('ungranted GM_download is undefined in scope', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoDownloadGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        document.body.dataset.smDownloadType = typeof GM_download;
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-download-type', 'undefined');
    await page.close();
  });

  test('GM_download is NOT gated by @connect (unlike GM_xmlhttpRequest)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Deliberate cross-API contrast: the same script, with no @connect
    // line at all, is blocked from GM_xmlhttpRequest but allowed to
    // download. See docs/GM-APIs.md for why.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'DownloadNoConnect',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_download', 'GM_xmlhttpRequest'],
      },
      body: `${REPORTER}
        GM_xmlhttpRequest({
          url: '${fixtureServer.baseUrl}/target.html',
          onload: () => { document.body.dataset.smXhr = 'load'; },
          onerror: (e) => { document.body.dataset.smXhr = 'error'; },
        });
        GM_download({
          url: '${fixtureServer.baseUrl}/target.html',
          name: 'sm-no-connect.html',
          onload: () => report('load'),
          onerror: (e) => report('error:' + (e && e.error)),
        });
      `,
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-xhr', 'error');
    await expect(page.locator('body')).toHaveAttribute('data-sm-download', 'load', {
      timeout: 15000,
    });
    await page.close();
  });
});
