// A `@resource` that doesn't load: the script still runs, with a load-time
// note in its Log and "" from the getters, which log an error when asked.
// See docs/resources.md#failure-handling.

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Writes what each getter gave into the page, for the test to read.
const REPORT_BODY = `
  const out = {
    text: GM_getResourceText('bad'),
    url: GM_getResourceURL('bad'),
    again: GM_getResourceText('bad'),
    listed: GM_info.script.resources.map((r) => r.name),
  };
  document.body.dataset.smOut = JSON.stringify(out);
  GM_log('asked');
`;

test.describe('@resource that does not load', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  // A file server whose answers the test can see and change.
  function resourceServer(): { url: (file: string) => string; hits: Map<string, number>; serving: Set<string>; close: () => void; ready: Promise<void> } {
    const hits = new Map<string, number>();
    const serving = new Set<string>();
    const server = http.createServer((req, res) => {
      hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
      res.statusCode = serving.has(req.url!) ? 200 : 404;
      res.end('body{}');
    });
    const ready = new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    return {
      url: (file) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${file}`,
      hits, serving, ready, close: () => server.close(),
    };
  }

  test('a background refresh keeps a lasting problem without fetching or logging it again; Refresh looks again', async ({ sm }) => {
    const server = resourceServer();
    await server.ready;
    try {
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'Dead', match: ['*://*/*'], extra: [`// @resource bad ${server.url('/dead.css')}`] },
        body: '',
      });
      const added = await sm.addCollection(scriptsDir.path);
      const row = async () => (await sm.getCollectionWithScripts(added!.id))!.scripts[0];
      expect((await row()).resourceProblems).toHaveLength(1);
      expect(server.hits.get('/dead.css')).toBe(1);

      await sm.updateCollection(added!.id, 'opportunistic');
      expect(server.hits.get('/dead.css')).toBe(1);
      expect((await row()).resourceProblems).toHaveLength(1);
      expect((await row()).startupLogs).toHaveLength(1);

      await sm.updateCollection(added!.id, 'manual');
      expect(server.hits.get('/dead.css')).toBe(2);
      expect((await row()).startupLogs).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  test('moving a loaded resource to a URL that fails keeps the script on its good copy', async ({ sm }) => {
    const server = resourceServer();
    await server.ready;
    server.serving.add('/v1.css');
    try {
      const write = (file: string) => scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'Moved', match: ['*://*/*'], extra: [`// @resource css ${server.url(file)}`] },
        body: '',
      });
      write('/v1.css');
      const added = await sm.addCollection(scriptsDir.path);
      // Later than the same-second write above, so the refresh reads it.
      const edited = write('/v2.css');
      fs.utimesSync(edited, new Date(), new Date(Date.now() + 10_000));
      await sm.updateCollection(added!.id, 'manual');
      const script = (await sm.getCollectionWithScripts(added!.id))!.scripts[0];
      expect(script.status).toBe('ok');
      expect(script.resources?.[0].url).toBe(server.url('/v1.css'));
      expect(script.resourceProblems).toBeUndefined();
      expect(script.refreshError).toContain('@resource css');
    } finally {
      server.close();
    }
  });

  test('a script invalid for its header records no problem, and the install preview shows one', async ({ extensionContext, extensionId, sm }) => {
    const file = scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Preview', match: ['*://*/*'], extra: ['// @resource bad missing.css'] },
      body: '',
    });
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(file)}`);
    await expect(page.locator('#banner-slot')).toContainText('@resource bad (missing.css)');
    await expect(page.locator('#banner-slot')).not.toContainText('could not be checked');
    await page.close();

    fs.writeFileSync(file, '// ==UserScript==\n// @name Invalid\n// @resource bad missing.css\n// ==/UserScript==\n');
    const added = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(added!.id))!.scripts[0];
    expect(script.status).toBe('invalid');
    expect(script.resourceProblems).toBeUndefined();
    expect(script.startupLogs).toBeUndefined();
  });

  test('warns at load, runs, and errors when the script asks; a refresh recovers', async ({ extensionContext, fixtureServer, sm }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'BadResource',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_getResourceText', 'GM_getResourceURL', 'GM_log'],
        extra: ['// @resource bad missing.css'],
      },
      body: REPORT_BODY,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const script = (await sm.getCollectionWithScripts(added!.id))!.scripts[0];
    expect(script.status).toBe('ok');
    expect(script.resourceProblems?.[0]).toMatchObject({ name: 'bad', ref: 'missing.css' });

    const logged = async () => (await sm.getScriptLog(script.id)).filter((e) => e.message.includes('@resource bad'));
    const atLoad = await logged();
    expect(atLoad).toHaveLength(1);
    expect(atLoad[0].level).toBe('warning');
    expect(atLoad[0].source).not.toBe('gm-resource');

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-out', /.+/);
    const out = JSON.parse((await page.locator('body').getAttribute('data-sm-out'))!);
    expect(out).toEqual({ text: '', url: '', again: '', listed: ['bad'] });

    // Reported once per name per page, however many calls asked.
    await expect.poll(async () => (await sm.getScriptLog(script.id)).filter((e) => e.source === 'gm-resource').length).toBe(1);
    const asked = (await sm.getScriptLog(script.id)).find((e) => e.source === 'gm-resource')!;
    expect(asked.level).toBe('error');
    expect(asked.message).toMatch(/^GM_getResourceText returned an empty string\. @resource bad \(missing\.css\): .+\.$/);

    // The file appears: a refresh loads it and clears the problem.
    fs.writeFileSync(path.join(scriptsDir.path, 'missing.css'), 'body{}');
    await sm.updateCollection(added!.id, 'manual');
    await sm.syncNow();
    const fixed = (await sm.getCollectionWithScripts(added!.id))!.scripts[0];
    expect(fixed.resourceProblems).toBeUndefined();
    expect(fixed.startupLogs ?? []).toEqual([]);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-sm-out', /body\{\}/);
    await page.close();
  });
});
