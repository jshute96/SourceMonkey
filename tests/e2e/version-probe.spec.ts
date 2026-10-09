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
import { ScriptsDir } from '../fixtures/scripts-dir';

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

    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');

    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
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

    const collection = await sm.addCollection(`${server.baseUrl}/mirror.user.js`);
    await sm.updateCollection(collection!.id, 'manual');

    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
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

    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');

    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
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

    const collection = await sm.addCollection(own);
    const before = server.requestLog.filter((e) => e.path === '/thing.user.js').length;
    await sm.updateCollection(collection!.id, 'manual');

    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.versionProbes).toBeUndefined();
    // One request for the refresh itself, none for a probe.
    expect(server.requestLog.filter((e) => e.path === '/thing.user.js').length).toBe(before + 1);
  });

  test('the Log records OUTDATED and, once the copy catches up, OK', async ({ sm }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;

    // The transition carries the badge's state, and — because it does —
    // leaves the script-originated max level alone: OUTDATED is not a
    // WARNING the user has to clear.
    const outdated = (await sm.getScriptLog(scriptId)).filter((e) => /Newer version 2\.0/.test(e.message));
    expect(outdated).toHaveLength(1);
    expect(outdated[0].state).toBe('outdated');
    expect(await sm.getMaxLogLevel(scriptId)).toBe('info');

    // The collection catches up. The probe answer is unchanged (2.0);
    // it is OUR version that moved, so the refresh outcome — not the
    // probe — is what notices the badge going back to OK.
    server.setRoute('/thing.user.js', versionedScript({
      version: '2.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');
    const recovered = (await sm.getScriptLog(scriptId)).filter((e) => /Up to date again/.test(e.message));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ state: 'ok', message: 'Up to date again (running 2.0)' });
  });

  test('a persisted OUTDATED is restated at startup, so the badge has a line', async ({ sm }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;

    // Chrome restart: the session log is gone, the probe on the row is
    // not. The probe only reports a transition, and re-probing finds
    // the same 2.0, so without the replay the badge would sit over an
    // empty Log for the whole session.
    await sm.clearScriptLog(scriptId);
    await sm.replayScriptLogsAtBoot();

    const restated = (await sm.getScriptLog(scriptId)).filter((e) => e.source === 'extension-startup');
    expect(restated).toHaveLength(1);
    expect(restated[0]).toMatchObject({
      state: 'outdated',
      message: `Newer version 2.0 at update URL (running 1.0): ${server.baseUrl}/thing.meta.js`,
    });
  });

  test('the startup restatement skips a row that is not running', async ({ sm }) => {
    // A local file rather than an http(s) route: over http a body that
    // stops parsing is treated as a login page standing in for the
    // script and keeps the good copy running (REFRESH FAILED), whereas a
    // local edit that breaks the header is flagged INVALID at once.
    const dir = ScriptsDir.create();
    try {
      server.setRoute('/thing.meta.js', metaBlock('2.0'));
      dir.writeRaw('thing.user.js', versionedScript({
        version: '1.0',
        updateUrl: `${server.baseUrl}/thing.meta.js`,
      }));
      const collection = await sm.addCollection(dir.path);
      await sm.updateCollection(collection!.id, 'manual');
      const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
      expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes).toHaveLength(1);

      // The script goes bad in place. The stale probe stays on the row
      // (INVALID outranks OUTDATED on the badge, so nothing is on screen
      // that shouldn't be), but the replay must not restate it: the row
      // isn't running 1.0, and the line would land after the INVALID one.
      dir.writeRaw('thing.user.js', 'not a userscript\n');
      await sm.updateCollection(collection!.id, 'manual');
      const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      expect(script.status).toBe('invalid');

      await sm.clearScriptLog(scriptId);
      await sm.replayScriptLogsAtBoot();
      const restated = (await sm.getScriptLog(scriptId)).filter((e) => e.source === 'extension-startup');
      expect(restated.map((e) => e.state)).toEqual(['invalid']);
    } finally {
      dir.cleanup();
    }
  });

  test('dropping @updateURL clears a stale probe annotation', async ({ sm }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes).toHaveLength(1);

    // The author removes the header. Without an explicit clear, the row
    // would keep showing OUTDATED against a URL it no longer names.
    server.setRoute('/thing.user.js', versionedScript({ version: '1.0' }));
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');

    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes)
      .toBeUndefined();
    // The badge went from OUTDATED to OK, so the Log says so.
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    const recovered = (await sm.getScriptLog(scriptId)).filter((e) => /Up to date again/.test(e.message));
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe('ok');
  });

  test('dropping one of two upstreams clears just that row', async ({ sm }) => {
    server.setRoute('/a.meta.js', metaBlock('2.0'));
    server.setRoute('/b.user.js', metaBlock('9.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/a.meta.js`,
      downloadUrl: `${server.baseUrl}/b.user.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes)
      .toHaveLength(2);

    // Drop only the download URL. The surviving row must stay and the
    // dead one must go — otherwise we'd keep reporting OUTDATED against
    // 9.0 at a URL the script no longer names.
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/a.meta.js`,
    }));
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');

    const probes = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes!;
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
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    expect((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes![0].version)
      .toBe('2.0');

    server.removeRoute('/thing.meta.js');
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');

    const probe = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes![0];
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
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await sm.updateCollection(collection!.id, 'manual');
    const afterFirst = server.requestLog.filter((e) => e.path === '/thing.meta.js').length;
    expect(afterFirst).toBe(1);

    // The reload fast-path's call shape: manual mode, default policy.
    await sm.updateScript(scriptId, 'manual');
    expect(server.requestLog.filter((e) => e.path === '/thing.meta.js').length)
      .toBe(afterFirst);

    // An explicit Refresh still checks now.
    await sm.updateCollection(collection!.id, 'manual');
    expect(server.requestLog.filter((e) => e.path === '/thing.meta.js').length)
      .toBe(afterFirst + 1);
  });

  test('the collections page shows OUTDATED with the newer version on hover', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.5'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const status = page.locator('.script-table td.status-cell a');
    await expect(status).toHaveText('OUTDATED');
    await expect(status).toHaveAttribute('title', /Version 2\.5 at update URL/);

    // And the viewer's details panel carries the comparison.
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    await expect(page.locator('#header-summary')).toContainText('Version at update URL');
    await expect(page.locator('#header-summary dd.version-newer')).toHaveText('2.5 (Newer)');
    await page.close();
  });

  // The viewer drops probe rows the reader would learn nothing from,
  // so "no row" has to mean "nothing to act on" — which only holds if
  // the cases that DO need acting on always keep theirs.
  test('a probe that agrees with the running version gets no row', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/thing.meta.js', metaBlock('1.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();
    // The probe really did resolve — this is a dropped row, not a
    // missing probe, which is what makes the assertion below mean
    // something.
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.versionProbes![0].version).toBe('1.0');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    // Anchored, since a bare `hasText` would also match the
    // `Version at update URL` row this test is asserting is absent.
    await expect(page.locator('#header-summary dt').filter({ hasText: /^Version$/ }))
      .toHaveCount(1);
    await expect(page.locator('#header-summary dt', { hasText: 'Version at' })).toHaveCount(0);
    await page.close();
  });

  // The other half of the rule: a probe whose version AGREES is
  // dropped, but not when its latest check failed. A script whose
  // @updateURL dies after one good check would otherwise look
  // permanently up to date.
  test('an agreeing probe whose latest check failed still gets a row', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/thing.meta.js', metaBlock('1.0'));
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/thing.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    // First check agrees, so at this point there is deliberately no row.
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    await expect(page.locator('#header-summary dt', { hasText: 'Version at' })).toHaveCount(0);

    // Now the upstream goes away.
    server.removeRoute('/thing.meta.js');
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');
    const probe = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].versionProbes![0];
    expect(probe.version).toBe('1.0');
    expect(probe.error).toBeTruthy();

    await page.reload();
    const row = page.locator('#header-summary dt', { hasText: 'Version at update URL' })
      .locator('+ dd');
    // The version matches ours and is old news; the failed re-check is
    // what the row is here to say, so it's the value.
    await expect(row).toHaveText(probe.error!);
    // …and the version it displaced rides along in the tooltip.
    await expect(row).toHaveAttribute('title', /last known version 1\.0/);
    await page.close();
  });

  // One side declaring a version and the other not is a difference
  // worth seeing, even though it can't be ranked. The script's own row
  // says `<none>` so the comparison has both halves on screen.
  test('an upstream version with no local @version shows <none> against it', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/thing.meta.js', metaBlock('2.0'));
    // Deliberately no `@version` on the installed script.
    server.setRoute('/thing.user.js', [
      '// ==UserScript==',
      '// @name        Unversioned',
      '// @match       https://example.com/*',
      `// @updateURL   ${server.baseUrl}/thing.meta.js`,
      '// ==/UserScript==',
      '',
    ].join('\n'));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.versionProbes![0].version).toBe('2.0');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await expect(page.locator('#header-summary dt').filter({ hasText: /^Version$/ })
      .locator('+ dd')).toHaveText('<none>');
    const row = page.locator('#header-summary dt', { hasText: 'Version at update URL' })
      .locator('+ dd');
    // Bare number: we can't say which is ahead, so no (Newer)/(Older)…
    await expect(row).toHaveText('2.0');
    // …and no highlight, which is reserved for a known-newer upstream.
    await expect(page.locator('#header-summary dd.version-newer')).toHaveCount(0);
    await page.close();
  });

  // A probe can't set a status and nothing logs it, so this row is the
  // only place a permanently broken @updateURL is ever reported. It
  // must survive the row-dropping rule above.
  test('a probe that never resolved a version keeps its row, showing the error', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/thing.user.js', versionedScript({
      version: '1.0',
      updateUrl: `${server.baseUrl}/gone.meta.js`,
    }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    const probeError = script.versionProbes![0].error!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const row = page.locator('#header-summary dt', { hasText: 'Version at update URL' })
      .locator('+ dd');
    await expect(row).toHaveText(probeError);
    // Not highlighted — there's no newer version, there's no answer.
    await expect(page.locator('#header-summary dd.version-newer')).toHaveCount(0);
    // And the status is untouched: a probe failure is not a script failure.
    await expect(page.locator('#header-summary dt', { hasText: 'Status' }).locator('+ dd'))
      .toHaveText('OK');
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
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.updateCollection(collection!.id, 'manual');
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator('.script-table td.status-cell a')).toHaveText('OK');

    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    await expect(page.locator('#header-summary')).toContainText('1.0 (Older)');
    await expect(page.locator('#header-summary dd.version-newer')).toHaveCount(0);
    await page.close();
  });
  // A probe result is a display annotation, but it is stored on the
  // script row — and every `script:*` write used to schedule a full
  // unregister-all + register-all across every registered script. A
  // Refresh All probes each script in turn and writes each result
  // separately, so the annotation pass alone produced a re-registration
  // per probed script: measured at 23 syncs averaging 356ms on a
  // 177-script profile, most of them after the refresh had finished.
  //
  // Both halves are asserted together on purpose. The suppression is
  // only correct if it is narrow, and "we stopped re-registering" is a
  // bug, not a fix, if a real edit stops re-registering too.
  test('a probe-only write does not re-register, but a body change still does', async ({ sm, getServiceWorker }) => {
    server.setRoute('/thing.user.js', versionedScript({ version: '1.0' }));
    const collection = await sm.addCollection(`${server.baseUrl}/thing.user.js`);
    await sm.syncNow();
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;

    // Count what actually reaches Chrome, rather than trusting a log
    // line. Both calls that place a spec: an incremental sync UPDATES a
    // script Chrome already holds rather than registering it, so
    // counting `register` alone would read a real edit as no work.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      const w = self as unknown as { __regCalls: number };
      w.__regCalls = 0;
      const origRegister = chrome.userScripts.register.bind(chrome.userScripts);
      chrome.userScripts.register = ((specs: unknown[]) => {
        w.__regCalls++;
        return origRegister(specs as Parameters<typeof origRegister>[0]);
      }) as typeof chrome.userScripts.register;
      const origUpdate = chrome.userScripts.update.bind(chrome.userScripts);
      chrome.userScripts.update = ((specs: unknown[]) => {
        w.__regCalls++;
        return origUpdate(specs as Parameters<typeof origUpdate>[0]);
      }) as typeof chrome.userScripts.update;
    });
    const regCalls = () => sw.evaluate(() => (self as unknown as { __regCalls: number }).__regCalls);
    // Longer than scheduleSync's 50ms debounce, so a sync that WAS
    // scheduled has landed by the time we read the counter.
    const settle = () => new Promise((r) => setTimeout(r, 400));

    // Write a probe onto the row, changing nothing else — the exact
    // shape `setVersionProbes` produces.
    await sw.evaluate(async (id: string) => {
      const key = `script:${id}`;
      const got = await chrome.storage.local.get(key);
      const row = got[key] as Record<string, unknown>;
      await chrome.storage.local.set({
        [key]: {
          ...row,
          versionProbes: [{
            kinds: ['update'], url: 'https://example.com/x.meta.js',
            checkedAt: 123, version: '9.9',
          }],
        },
      });
    }, scriptId);
    await settle();
    expect(await regCalls()).toBe(0);

    // Same row, real content change: this one has to reach Chrome, or
    // the page keeps running the old body.
    await sw.evaluate(async (id: string) => {
      const key = `script:${id}`;
      const got = await chrome.storage.local.get(key);
      const row = got[key] as Record<string, unknown>;
      await chrome.storage.local.set({
        // An inline body, which reads as it is in place of the row's blob.
        [key]: { ...row, bodyBlobRef: undefined, bodyText: 'console.log("edited");', contentHash: 'changed' },
      });
    }, scriptId);
    await settle();
    expect(await regCalls()).toBeGreaterThan(0);
  });
});
