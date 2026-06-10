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
});
