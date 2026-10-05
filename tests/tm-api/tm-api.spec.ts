// Whether the Tampermonkey `manager fetch` got still answers each call
// sm-dev makes, as docs/sm-dev-tampermonkey.md lists them. Not a
// published API, so a new Tampermonkey release can change any of them.
//
// - Run on demand, with `pnpm run test:tm-api`, after `sm-dev --manager
//   tm manager fetch`. It fetches nothing itself.
// - Each call is made for real, in a throwaway browser, so a call whose
//   data or answer changed shape fails too, not only one that's gone.
// - One failing doesn't stop the rest: the test ends listing every one
//   that failed.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, test, expect } from '@playwright/test';
import { allowUserScripts, installedManagers } from '../../lib/harness/browser-extensions.js';
import { installUrlOf } from '../../lib/harness/external-manager.js';
import { fetchedDir, fetchedVersion } from '../../lib/harness/manager-fetch.js';
import { markedText, readMark } from '../../lib/harness/script-mark.js';
import { Tampermonkey } from '../../lib/harness/tampermonkey.js';

test('Tampermonkey answers every call sm-dev makes', async () => {
  test.setTimeout(120_000);
  const version = fetchedVersion('tampermonkey');
  if (version === null) throw new Error('No Tampermonkey is fetched. Fetch it with sm-dev --manager tm manager fetch, then run this again.');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-tm-api-'));
  const tmDir = fetchedDir('tampermonkey');
  // Extensions need Chrome's new headless mode (see src/harness/extension-launch.ts).
  const browser = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--headless=new', '--remote-debugging-port=0', `--disable-extensions-except=${tmDir}`, `--load-extension=${tmDir}`],
  });
  const failures: string[] = [];
  // Each check by name; a failure is noted, and the rest go on.
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message.split('\n')[0]}`);
    }
  };
  const same = (what: string, actual: unknown, wanted: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${what} is ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
  };
  let tm: Tampermonkey | undefined;
  try {
    const endpoint = `http://127.0.0.1:${readFileSync(path.join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]}`;
    const copy = (await installedManagers(endpoint)).find((m) => m.manager === 'tampermonkey');
    if (!copy) throw new Error(`Tampermonkey ${version} isn't found in the browser by its name or Web Store id`);
    await allowUserScripts(endpoint, copy.id);
    tm = await Tampermonkey.open(endpoint);
    const t = tm;

    // A script with a local @require, installed as sm-dev installs one:
    // its header rewritten to a URL under sm-dev.invalid, with the
    // file's contents given.
    const file = path.join(dir, 'probe.user.js');
    const fileUrl = pathToFileURL(file).href;
    const text = (body: string): string => `// ==UserScript==\n// @name        sm-dev probe\n// @namespace   sm-dev-test\n// @version     1.0\n// @match       https://example.com/*\n// @require     lib.js\n// @grant       none\n// ==/UserScript==\n${body}\n`;
    const lib = 'var libValue = 42;\nvar two = 2;';
    const files = { requires: { [installUrlOf(new URL('lib.js', fileUrl).href)]: lib }, resources: {} };
    const body = "console.log('probe', libValue, new Error('at').stack);";
    const first = markedText(text(body), { run: 'D1', started: new Date(0).toISOString(), file });
    let id: number | undefined;
    await check('loadTree lists scripts', async () => same('The script list', await t.scripts(), []));
    await check('saveScript installs a script', async () => {
      const installed = await t.install(first, { url: installUrlOf(fileUrl), files, local: true });
      same('isNew', installed.isNew, true);
      id = installed.id;
    });
    const needId = (): number => {
      if (id === undefined) throw new Error('Not tried, since the install failed');
      return id;
    };
    await check('loadTree gives a script\'s fields', async () => {
      const [s] = await t.scripts();
      same('The script', s && { id: s.id, name: s.name, namespace: s.namespace, version: s.version, enabled: s.enabled, match: s.match, requires: s.requires },
        { id: needId(), name: 'sm-dev probe', namespace: 'sm-dev-test', version: '1.0', enabled: true, match: ['https://example.com/*'], requires: ['lib.js'] });
    });
    await check('loadTree gives the text as installed', async () => {
      const got = (await t.texts([needId()])).get(needId());
      same('Its comment', got && readMark(got), readMark(first));
      same('Its text', got, first);
    });
    await check('saveScript replaces a script by its uuid', async () => {
      const again = await t.install(markedText(text(body), { file }), { id: needId(), url: installUrlOf(fileUrl), files, local: true });
      same('The id', again.id, needId());
      same('isNew', again.isNew, false);
    });
    await check('saveScript replaces the script with the same name and namespace', async () => {
      const again = await t.install(first, { url: installUrlOf(fileUrl), files, local: true });
      same('The id', again.id, needId());
      same('The script count', (await t.scripts()).length, 1);
    });
    await check('modifyScriptOptions turns a script off and on', async () => {
      await t.setEnabled(needId(), false);
      same('Enabled after turning it off', (await t.scripts())[0]?.enabled, false);
      await t.setEnabled(needId(), true);
      same('Enabled after turning it on', (await t.scripts())[0]?.enabled, true);
    });
    await check('determineScriptsToRun gives the scripts matching a URL', async () => {
      same('On a matching page', await t.matching('https://example.com/a'), [needId()]);
      same('On another', await t.matching('https://other.example/'), []);
    });
    await check('The script runs with its @require, under a URL naming it, after one line and the @require', async () => {
      t.noteRequires(needId(), [{ url: 'file:///lib.js', source: lib }]);
      const page = await browser.newPage();
      await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Page</p>' }));
      const cdp = await browser.newCDPSession(page);
      await cdp.send('Runtime.enable');
      const logged = new Promise<{ value: unknown; stack: unknown; url: string }>((resolve) => {
        cdp.on('Runtime.consoleAPICalled', (e) => {
          if (e.args[0]?.value === 'probe') resolve({ value: e.args[1]?.value, stack: e.args[2]?.value, url: e.stackTrace?.callFrames[0]?.url ?? '' });
        });
      });
      await page.goto('https://example.com/');
      const line = await Promise.race([logged, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
      await page.close();
      if (!line) throw new Error('The script logged nothing within 10 seconds');
      same('The @require\'s value', line.value, 42);
      same('The script named by its code\'s URL', t.scriptIdOf(line.url), needId());
      // The body's line is 9: the header's 8, then the log.
      const at = /:(\d+):\d+\)/.exec(t.remapStack(String(line.stack)))?.[1];
      same('The logged line, mapped back', at, '9');
    });
    await check('loadTree and setOption turn all scripts off and on', async () => {
      await t.setApplied(false);
      same('Enabled after turning it off', await t.applied(), false);
      await t.setApplied(true);
      same('Enabled after turning it on', await t.applied(), true);
    });
    await check('saveScript with no code moves a script to the trash', async () => {
      await t.uninstall(needId());
      same('The script list', (await t.scripts()).map((s) => s.id), []);
    });
    await check('purgeScripts removes scripts for good', async () => {
      const { id: next } = await t.install(first, { url: installUrlOf(fileUrl), files, local: true });
      await t.remove([next]);
      same('The script list', (await t.scripts()).map((s) => s.id), []);
      same('Its text', (await t.texts([next])).get(next), undefined);
    });
  } catch (err) {
    failures.push(`Connecting: ${(err as Error).message}`);
  } finally {
    await tm?.close().catch(() => undefined);
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(failures, `Tampermonkey ${version} failed these of sm-dev's calls`).toEqual([]);
});
