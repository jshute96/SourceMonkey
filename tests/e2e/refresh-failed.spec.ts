// End-to-end coverage of the "refresh failed, keep the good copy
// running" behavior for HTTP sources.
//
// A refresh must never downgrade a working script because the latest
// fetch failed or returned something that isn't a userscript. Both the
// hard-failure (404 / network) and soft-failure (200 returning a
// login / error page) cases should:
//   - leave `status: 'ok'` so the script stays injectable,
//   - preserve the prior good `bodyText` (we don't clobber it),
//   - set `refreshError` so the UI can flag REFRESH FAILED,
//   - and clear `refreshError` again once a good refresh lands.
//
// Every one of those states must also be readable in the script's own
// Log tab — a badge the user can't explain is worse than no badge — so
// the same sequence is asserted against the log, including that a
// source which stays down keeps saying so on each check.
//
// The store-level unit tests cover the pure transitions; this drives
// the real fetch pipeline (fetchHttpText + rebuildSource) end to end.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('refresh failed (keep prior good copy)', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('soft failure: a 200 login page does not replace the working script', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const source = await sm.addSource(`${server.baseUrl}/app.user.js`);
    const before = await sm.getSourceWithScripts(source!.id);
    const good = before!.scripts[0];
    expect(good.status).toBe('ok');
    const priorBody = good.bodyText;
    const priorLoadedAt = good.loadedAt;

    // Now the server is "logged out": it answers 200 with an HTML login
    // page instead of the script. The fetch succeeds, but the body is
    // not a userscript.
    server.setRoute('/app.user.js', '<!doctype html><title>Please log in</title>', {
      contentType: 'text/html; charset=utf-8',
    });
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');

    const after = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    // Still OK + injectable, body untouched, but flagged as stale.
    expect(after.status).toBe('ok');
    expect(after.bodyText).toBe(priorBody);
    expect(after.bodyText).not.toContain('login');
    expect(after.loadedAt).toBe(priorLoadedAt);
    expect(after.refreshError).toMatch(/not a valid userscript/);
  });

  test('hard failure: a 404 keeps the working script and records refreshError', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const source = await sm.addSource(`${server.baseUrl}/app.user.js`);
    const good = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(good.status).toBe('ok');
    const priorBody = good.bodyText;

    // The URL starts 404'ing (server moved / temporarily gone).
    server.removeRoute('/app.user.js');
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');

    const after = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(after.status).toBe('ok');
    expect(after.bodyText).toBe(priorBody);
    expect(after.refreshError).toBeTruthy();
  });

  test('recovery: a later good refresh clears refreshError and updates the body', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const source = await sm.addSource(`${server.baseUrl}/app.user.js`);
    const priorLoadedAt = (await sm.getSourceWithScripts(source!.id))!.scripts[0].loadedAt;

    // Break it (soft failure) → refresh-failed.
    server.setRoute('/app.user.js', '<!doctype html><title>Please log in</title>', {
      contentType: 'text/html; charset=utf-8',
    });
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');
    expect((await sm.getSourceWithScripts(source!.id))!.scripts[0].refreshError).toBeTruthy();

    // Source comes back with a real (new) version → refreshError clears,
    // body updates, loadedAt bumps.
    await new Promise((r) => setTimeout(r, 10));
    server.setRoute('/app.user.js', userscriptText('App', ' /* v2 */'));
    await sm.updateSource(source!.id, 'manual');

    const after = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(after.status).toBe('ok');
    expect(after.refreshError).toBeUndefined();
    expect(after.bodyText).toContain('v2');
    expect(after.loadedAt).toBeGreaterThan(priorLoadedAt);
  });

  test('the Log tab explains the failure, repeats it per check, and records the recovery', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const source = await sm.addSource(`${server.baseUrl}/app.user.js`);
    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;
    await sm.clearScriptLog(scriptId);

    // 1. Source goes down → one warning naming the reason. The script
    //    keeps running from its cached copy, so warning (not error) is
    //    the honest level.
    server.removeRoute('/app.user.js');
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');
    const afterFirst = await sm.getScriptLog(scriptId);
    const failures = afterFirst.filter((e) => /refresh failed/.test(e.message));
    expect(failures.length).toBe(1);
    expect(failures[0].level).toBe('warning');

    // 2. Still down two refreshes later → one entry per check. Each
    //    refresh really re-fetched and re-validated, so every one of
    //    them is reporting a fresh verdict on a fresh read.
    await sm.updateSource(source!.id, 'manual');
    await sm.updateSource(source!.id, 'manual');
    const afterRepeats = await sm.getScriptLog(scriptId);
    expect(afterRepeats.filter((e) => /refresh failed/.test(e.message)).length).toBe(3);

    // 3. Source comes back → an info entry says so, and the log's
    //    highest level stops being the last word on the script.
    await new Promise((r) => setTimeout(r, 10));
    server.setRoute('/app.user.js', userscriptText('App', ' /* v2 */'));
    await sm.updateSource(source!.id, 'manual');
    const afterRecovery = await sm.getScriptLog(scriptId);
    const recovery = afterRecovery.filter((e) => /refresh succeeded again/.test(e.message));
    expect(recovery.length).toBe(1);
    expect(recovery[0].level).toBe('info');
    expect(afterRecovery.some((e) => /loaded new content/.test(e.message))).toBe(true);
  });

  test('a soft failure (200 login page) is explained in the Log too', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const source = await sm.addSource(`${server.baseUrl}/app.user.js`);
    const scriptId = (await sm.getSourceWithScripts(source!.id))!.scripts[0].id;
    await sm.clearScriptLog(scriptId);

    server.setRoute('/app.user.js', '<!doctype html><title>Please log in</title>', {
      contentType: 'text/html; charset=utf-8',
    });
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');

    const log = await sm.getScriptLog(scriptId);
    const failures = log.filter((e) => /refresh failed/.test(e.message));
    expect(failures.length).toBe(1);
    expect(failures[0].level).toBe('warning');
    expect(failures[0].message).toMatch(/not a valid userscript/);
  });

  test('a script that cannot load at all logs an error on every check', async ({ sm }) => {
    // No prior good copy to protect: the row lands `invalid`, which
    // means "can't run" — error level, and the Log has to carry the
    // parse reason behind the INVALID badge.
    server.setRoute('/broken.user.js', 'just some text, no metadata block\n');
    const source = await sm.addSource(`${server.baseUrl}/broken.user.js`);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const afterAdd = await sm.getScriptLog(script.id);
    const errors = afterAdd.filter((e) => e.level === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe(script.errorMessage);

    // Every refresh re-fetches and re-parses an invalid row — it can't
    // take the size+mtime skip, which requires status 'ok' — so each
    // check reports its own verdict.
    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');
    await sm.updateSource(source!.id, 'manual');
    const afterRefreshes = await sm.getScriptLog(script.id);
    const allErrors = afterRefreshes.filter((e) => e.level === 'error');
    expect(allErrors.length).toBe(3);

    // The add path and the refresh path phrase the identical failure
    // identically (they share `loadStateLogEntry`), so a user reading
    // the Log can tell "the same problem again" from "a new problem"
    // by the message alone.
    expect(new Set(allErrors.map((e) => e.message)).size).toBe(1);
    expect(allErrors[0].source).toBe('add-source');
    expect(allErrors[1].source).toBe('manual-refresh');
  });

  test('a cleared log gets its explanation back on the next refresh', async ({ sm }) => {
    // Suppression must never be able to strand a red badge with an
    // empty Log. Clearing is the sharpest version of that: the stored
    // row is unchanged, so a naive "skip when unchanged" rule would
    // stay silent forever.
    server.setRoute('/broken.user.js', 'just some text, no metadata block\n');
    const source = await sm.addSource(`${server.baseUrl}/broken.user.js`);
    const script = (await sm.getSourceWithScripts(source!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    await sm.clearScriptLog(script.id);
    expect((await sm.getScriptLog(script.id)).length).toBe(0);

    await sm.syncNow();
    await sm.updateSource(source!.id, 'manual');
    const log = await sm.getScriptLog(script.id);
    const errors = log.filter((e) => e.level === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe(script.errorMessage);
  });
});
