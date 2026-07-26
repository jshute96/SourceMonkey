// End-to-end coverage of update probes: reading `@version` from a
// script's `@updateURL` / `@downloadURL` and reporting when the copy we
// run is behind.
//
// The two rules worth proving here are the ones a unit test can't:
//   - a probe never becomes an update. We fetch the probe URL, read one
//     header line, and leave the body, the status, and the refreshError
//     exactly as the refresh left them.
//   - the URL we installed from stays the update channel, whatever
//     `@downloadURL` says.
//
// The pure target-selection / comparison logic lives in
// tests/unit/version-probe.test.mjs.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer } from '../fixtures/userscript-server';

// A userscript that declares a version and points its update/download
// headers wherever the test needs them.
function versionedScript(opts: {
  version: string;
  updateUrl?: string;
  downloadUrl?: string;
  body?: string;
}): string {
  return [
    '// ==UserScript==',
    '// @name        Versioned',
    `// @version     ${opts.version}`,
    '// @match       https://example.com/*',
    ...(opts.updateUrl ? [`// @updateURL   ${opts.updateUrl}`] : []),
    ...(opts.downloadUrl ? [`// @downloadURL ${opts.downloadUrl}`] : []),
    '// ==/UserScript==',
    opts.body ?? "console.log('versioned');",
    '',
  ].join('\n');
}

// The header-only form a real `@updateURL` serves.
function metaBlock(version: string): string {
  return [
    '// ==UserScript==',
    '// @name        Versioned',
    `// @version     ${version}`,
    '// @match       https://example.com/*',
    '// ==/UserScript==',
    '',
  ].join('\n');
}

test.describe('update probes', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('a newer @version upstream is recorded without touching the script', async ({ sm }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));

    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');

    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.versionProbes).toHaveLength(1);
    expect(script.versionProbes![0]).toMatchObject({
      kinds: ['update'],
      url: `${server.baseUrl}/thing.meta.js`,
      version: '2.0',
    });
    // The probe annotates and nothing else: we still run 1.0, the row is
    // still OK, and nothing was mistaken for a refresh failure.
    expect(script.status).toBe('ok');
    expect(script.refreshError).toBeUndefined();
    expect(script.bodyText).toContain("console.log('versioned')");
    expect(script.headerText).toContain('@version     1.0');
  });

  test('the installed copy is never updated from the probed URL', async ({ sm }) => {
    // @downloadURL points at a *different* body. Honoring it would move
    // the update channel to an origin the user never approved, so the
    // only thing that may cross over is the version number.
    server.setRoute('/official.user.js', versionedScript({
      version: '3.0',
      body: "console.log('OFFICIAL BODY');",
    }));
    server.setRoute('/mirror.user.js', versionedScript({
      version: '1.0',
      downloadUrl: `${server.baseUrl}/official.user.js`,
      body: "console.log('MIRROR BODY');",
    }));

    const source = await sm.addSource(`${server.baseUrl}/mirror.user.js`);
    await sm.updateSource(source!.id, 'manual');

    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.bodyText).toContain('MIRROR BODY');
    expect(script.bodyText).not.toContain('OFFICIAL BODY');
    expect(script.versionProbes![0]).toMatchObject({
      kinds: ['download'],
      version: '3.0',
    });
  });

  test('an unreachable probe URL is recorded as an error, not a refresh failure', async ({ sm }) => {
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/gone.meta.js`,
    }));

    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');

    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.status).toBe('ok');
    expect(script.refreshError).toBeUndefined();
    expect(script.versionProbes![0].version).toBeUndefined();
    expect(script.versionProbes![0].error).toBeTruthy();
  });

  test('a URL we already load from is not probed', async ({ sm }) => {
    // The common GreasyFork shape: @downloadURL is exactly where we
    // installed from. Probing it would re-download the script we just
    // fetched to learn what we already know.
    const own = `${server.baseUrl}/thing.user.js`;
    server.setRoute('/thing.user.js', versionedScript({ version: '1.0', downloadUrl: own }));

    const source = await sm.addSource(own);
    const before = server.requestLog.filter((e) => e.path === '/thing.user.js').length;
    await sm.updateSource(source!.id, 'manual');

    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.versionProbes).toBeUndefined();
    // One request for the refresh itself, none for a probe.
    expect(server.requestLog.filter((e) => e.path === '/thing.user.js').length).toBe(before + 1);
  });

  test('dropping @updateURL clears a stale probe annotation', async ({ sm }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');
    expect((await sm.getSourceWithScripts(source!.id))!.scripts[0].versionProbes).toHaveLength(1);

    // The author removes the header. Without an explicit clear, the row
    // would keep showing OUTDATED against a URL it no longer names.
    server.setRoute('/thing.user.js', versionedScript({ version: '1.0' }));
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');

    expect((await sm.getSourceWithScripts(source!.id))!.scripts[0].versionProbes)
      .toBeUndefined();
  });

  test('dropping one of two upstreams clears just that row', async ({ sm }) => {
    server.setRoute('/a.meta.js', metaBlock('2.0'));
    server.setRoute('/b.user.js', metaBlock('9.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/a.meta.js`,
      downloadUrl: `${server.baseUrl}/b.user.js`,
    }));
    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');
    expect((await sm.getSourceWithScripts(source!.id))!.scripts[0].versionProbes)
      .toHaveLength(2);

    // Drop only the download URL. The surviving row must stay and the
    // dead one must go — otherwise we'd keep reporting OUTDATED against
    // 9.0 at a URL the script no longer names.
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/a.meta.js`,
    }));
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');

    const probes = (await sm.getSourceWithScripts(source!.id))!.scripts[0].versionProbes!;
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ kinds: ['update'], version: '2.0' });
  });

  test('a probe failure keeps the version it already found', async ({ sm }) => {
    // Retracting a verdict because the host 500'd this afternoon would
    // flap OUTDATED off and on, and re-log the transition each time.
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');
    expect((await sm.getSourceWithScripts(source!.id))!.scripts[0].versionProbes![0].version)
      .toBe('2.0');

    server.removeRoute('/thing.meta.js');
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');

    const probe = (await sm.getSourceWithScripts(source!.id))!.scripts[0].versionProbes![0];
    expect(probe.version).toBe('2.0');
    expect(probe.error).toBeTruthy();
  });

  test('a background check does not re-probe a fresh answer', async ({ sm }) => {
    // The pacing that keeps probes off the per-navigation and
    // per-reload paths. `manual` mode is deliberately NOT enough to
    // force a probe — only an explicit Refresh click is.
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;
    await sm.updateSource(source!.id, 'manual');
    const afterFirst = server.requestLog.filter((e) => e.path === '/thing.meta.js').length;
    expect(afterFirst).toBe(1);

    // The reload fast-path's call shape: manual mode, default policy.
    await sm.updateScript(scriptId, 'manual');
    expect(server.requestLog.filter((e) => e.path === '/thing.meta.js').length)
      .toBe(afterFirst);

    // An explicit Refresh still checks now.
    await sm.updateSource(source!.id, 'manual');
    expect(server.requestLog.filter((e) => e.path === '/thing.meta.js').length)
      .toBe(afterFirst + 1);
  });

  test('the sources page shows OUTDATED with the newer version on hover', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.5'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    const status = page.locator('.script-table td.status-cell a');
    await expect(status).toHaveText('OUTDATED');
    await expect(status).toHaveAttribute('title', /Version 2\.5 at update URL/);

    // And the viewer's details panel carries the comparison.
    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    await expect(page.locator('#header-summary')).toContainText('Version at update URL');
    await expect(page.locator('#header-summary dd.version-newer')).toHaveText('2.5 (Newer)');
    await page.close();
  });

  test('a copy ahead of its upstream reads Older, and stays OK', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A local edit that outruns the published version is normal — it's
    // reported, but it isn't a problem.
    server.setRoute('/thing.meta.js', metaBlock('1.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '2.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const source = await sm.addSource(`${server.baseUrl}/thing.user.js`);
    await sm.updateSource(source!.id, 'manual');
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sources.html`);
    await expect(page.locator('.script-table td.status-cell a')).toHaveText('OK');

    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    await expect(page.locator('#header-summary')).toContainText('1.0 (Older)');
    await expect(page.locator('#header-summary dd.version-newer')).toHaveCount(0);
    await page.close();
  });
});
