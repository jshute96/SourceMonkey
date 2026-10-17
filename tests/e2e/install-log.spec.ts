// The Log lines a script starts with when it is installed
// (`emitInitialLoadLog` in src/extension/script-store.ts): the install
// itself, then its load failure or parse-time warnings. See
// docs/script-log.md.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

const WARNS_TEXT = [
  '// ==UserScript==',
  '// @name        Warns',
  '// @match       https://example.com/*',
  '// @grant       GM_notARealApi',
  '// ==/UserScript==',
  "console.log('Warns');",
  '',
].join('\n');

test.describe('install log', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => {
    server = await UserscriptServer.start();
  });
  test.afterEach(async () => { await server.stop(); });

  test('an install logs the install and its header warnings', async ({ sm }) => {
    server.setRoute('/warns.user.js', WARNS_TEXT);
    const collection = await sm.addCollection(`${server.baseUrl}/warns.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('ok');

    const log = await sm.getScriptLog(script.id);
    expect(log.map((e) => [e.source, e.level])).toEqual([
      ['add', 'info'],
      ['parser', 'warning'],
    ]);
    expect(log[0].message).toMatch(/^Installed \(\d/);
    expect(log[0].state).toBe('ok');
    expect(log[1].message).toContain('GM_notARealApi');
    expect(await sm.getMaxLogLevel(script.id)).toBe('warning');
  });

  test('a script that installs broken logs the install, then the failure', async ({ sm }) => {
    server.setRoute('/broken.user.js', 'just some text, no metadata block\n');
    const collection = await sm.addCollection(`${server.baseUrl}/broken.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const log = await sm.getScriptLog(script.id);
    // The size says the file did arrive; it's the content that's broken.
    expect(log.map((e) => [e.message, e.state])).toEqual([
      [expect.stringMatching(/^Installed \(\d/), undefined],
      [script.errorMessage, 'invalid'],
    ]);
  });

  test('a script whose file could not be fetched logs the install with no size', async ({ sm }) => {
    const collection = await sm.addCollection(`${server.baseUrl}/nowhere.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const log = await sm.getScriptLog(script.id);
    expect(log.map((e) => [e.message, e.state])).toEqual([
      ['Installed', undefined],
      [script.errorMessage, 'invalid'],
    ]);
  });

  test('a script broken by its @require still logs its header warnings, after the failure', async ({ sm }) => {
    server.setRoute('/needs-lib.user.js', WARNS_TEXT.replace(
      '// ==/UserScript==',
      `// @require     ${server.baseUrl}/missing-lib.js\n// ==/UserScript==`,
    ));
    const collection = await sm.addCollection(`${server.baseUrl}/needs-lib.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('invalid');

    const log = await sm.getScriptLog(script.id);
    expect(log.map((e) => [e.source, e.state ?? e.level])).toEqual([
      ['add', 'info'],
      ['add', 'invalid'],
      ['parser', 'warning'],
    ]);
  });

  test('installing beside an existing script logs nothing new for the sibling', async ({ sm }) => {
    server.setRoute('/first.user.js', userscriptText('First'));
    server.setRoute('/second.user.js', WARNS_TEXT);
    const collection = await sm.addCollection(`${server.baseUrl}/first.user.js`);
    await sm.addCollection(`${server.baseUrl}/second.user.js`);
    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const first = scripts.find((s) => s.relativePath.endsWith('first.user.js'))!;
    const second = scripts.find((s) => s.relativePath.endsWith('second.user.js'))!;

    expect((await sm.getScriptLog(first.id)).map((e) => e.message)).toEqual([
      expect.stringMatching(/^Installed /),
    ]);
    expect((await sm.getScriptLog(second.id)).map((e) => e.source)).toEqual(['add', 'parser']);
  });
});
