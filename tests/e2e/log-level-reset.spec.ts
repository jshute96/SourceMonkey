// Loading a new version of a script resets its WARNING / ERROR badge.
//
// The `loglevel:` sentinel is otherwise monotonic for the session, which
// is right for a script that keeps running the same code — but a new
// version is not the code that produced the old errors, and a developer
// who just fixed one needs the badge to answer "did that work?" rather
// than "did it ever fail?". The entries stay; only the badge starts over.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('log level reset on new content', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('a refresh that loads new content clears the sticky badge', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const collection = await sm.addCollection(`${server.baseUrl}/app.user.js`);
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;

    // The running version misbehaves: a runtime error the wrapper would
    // report. Badge goes to ERROR and stays there.
    await sm.appendScriptLog(scriptId, {
      level: 'error', source: 'script-wrapper', tabId: 1, message: 'TypeError: boom',
    });
    expect(await sm.getMaxLogLevel(scriptId)).toBe('error');

    // A check that finds the same bytes changes nothing — the error is
    // still about the code that's running.
    await sm.updateCollection(collection!.id, 'manual');
    expect(await sm.getMaxLogLevel(scriptId)).toBe('error');

    // A fix lands. The badge resets with the `Loaded new content` row,
    // which reads OK in the Log; the error row before it is kept.
    server.setRoute('/app.user.js', userscriptText('App', ' /* fixed */'));
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');
    expect(await sm.getMaxLogLevel(scriptId)).toBeUndefined();
    const log = await sm.getScriptLog(scriptId);
    expect(log.some((e) => e.message === 'TypeError: boom')).toBe(true);
    const loaded = log.filter((e) => /Loaded new content/.test(e.message));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ state: 'ok', resetsLogLevel: true });

    // Whatever the new version does counts from here.
    await sm.appendScriptLog(scriptId, {
      level: 'warning', source: 'script-wrapper', tabId: 1, message: 'still a bit off',
    });
    expect(await sm.getMaxLogLevel(scriptId)).toBe('warning');
  });

  test('parse diagnostics of the new version set the badge afresh', async ({ sm }) => {
    server.setRoute('/app.user.js', userscriptText('App'));
    const collection = await sm.addCollection(`${server.baseUrl}/app.user.js`);
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0].id;
    await sm.appendScriptLog(scriptId, {
      level: 'error', source: 'script-wrapper', tabId: 1, message: 'TypeError: boom',
    });

    // The new version carries a header the parser warns about. Its
    // `parser` rows are replayed right after `Loaded new content`, so the
    // reset must land between the two: ERROR from the old version goes,
    // WARNING from the new one stays.
    server.setRoute('/app.user.js', [
      '// ==UserScript==',
      '// @name        App',
      '// @match       https://example.com/*',
      '// @grant       GM_notARealApi',
      '// ==/UserScript==',
      "console.log('App');",
      '',
    ].join('\n'));
    await sm.syncNow();
    await sm.updateCollection(collection!.id, 'manual');
    expect(await sm.getMaxLogLevel(scriptId)).toBe('warning');
    const log = await sm.getScriptLog(scriptId);
    const loadedAt = log.findIndex((e) => /Loaded new content/.test(e.message));
    const parserAt = log.findIndex((e) => e.source === 'parser');
    expect(loadedAt).toBeGreaterThanOrEqual(0);
    expect(parserAt).toBeGreaterThan(loadedAt);
  });
});
