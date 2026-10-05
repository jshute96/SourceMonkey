// Whether the Violentmonkey `manager fetch` got still answers each call
// sm-dev makes, as docs/sm-dev-external-managers.md lists them. Not a
// published API, so a new Violentmonkey release can change any of them.
//
// - Run on demand, with `pnpm run test:vm-api`, after `sm-dev --manager
//   vm manager fetch`. It fetches nothing itself.
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
import { Violentmonkey } from '../../lib/harness/violentmonkey.js';

test('Violentmonkey answers every call sm-dev makes', async () => {
  test.setTimeout(120_000);
  const version = fetchedVersion('violentmonkey');
  if (version === null) throw new Error('No Violentmonkey is fetched. Fetch it with sm-dev --manager vm manager fetch, then run this again.');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-vm-api-'));
  const vmDir = fetchedDir('violentmonkey');
  // Extensions need Chrome's new headless mode (see src/harness/extension-launch.ts).
  const browser = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--headless=new', '--remote-debugging-port=0', `--disable-extensions-except=${vmDir}`, `--load-extension=${vmDir}`],
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
  let vm: Violentmonkey | undefined;
  try {
    const endpoint = `http://127.0.0.1:${readFileSync(path.join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]}`;
    const copy = (await installedManagers(endpoint)).find((m) => m.manager === 'violentmonkey');
    if (!copy) throw new Error(`Violentmonkey ${version} isn't found in the browser by its name or Web Store id`);
    await allowUserScripts(endpoint, copy.id);
    vm = await Violentmonkey.open(endpoint);
    const v = vm;

    // A script with a local @require, installed as sm-dev installs one:
    // from a URL under sm-dev.invalid, with the file's contents given.
    const file = path.join(dir, 'probe.user.js');
    const fileUrl = pathToFileURL(file).href;
    const text = (body: string): string => `// ==UserScript==\n// @name        sm-dev probe\n// @namespace   sm-dev-test\n// @version     1.0\n// @match       https://example.com/*\n// @require     lib.js\n// @grant       none\n// ==/UserScript==\n${body}\n`;
    const files = { requires: { [installUrlOf(new URL('lib.js', fileUrl).href)]: 'var libValue = 42;' }, resources: {} };
    const first = markedText(text("console.log('probe', libValue);"), { run: 'D1', started: new Date(0).toISOString(), file });
    let id: number | undefined;
    await check('GetData lists scripts', async () => same('The script list', await v.scripts(), []));
    await check('ParseScript installs a script', async () => {
      const installed = await v.install(first, { url: installUrlOf(fileUrl), files, local: true });
      same('isNew', installed.isNew, true);
      id = installed.id;
    });
    const needId = (): number => {
      if (id === undefined) throw new Error('Not tried, since the install failed');
      return id;
    };
    await check('GetData gives a script\'s fields', async () => {
      const [s] = await v.scripts();
      same('The script', s && { id: s.id, name: s.name, namespace: s.namespace, version: s.version, enabled: s.enabled, match: s.match, requires: s.requires },
        { id: needId(), name: 'sm-dev probe', namespace: 'sm-dev-test', version: '1.0', enabled: true, match: ['https://example.com/*'], requires: ['lib.js'] });
    });
    await check('GetScriptCode gives the text as installed', async () => {
      const got = (await v.texts([needId()])).get(needId());
      same('Its comment', got && readMark(got), readMark(first));
    });
    await check('ParseScript replaces a script by its id', async () => {
      const again = await v.install(markedText(text("console.log('probe', libValue);"), { file }), { id: needId(), url: installUrlOf(fileUrl), files, local: true });
      same('The id', again.id, needId());
      same('isNew', again.isNew, false);
    });
    await check('ParseScript replaces a script by its name and namespace', async () => {
      const again = await v.install(first, { url: installUrlOf(fileUrl), files, local: true });
      same('The id', again.id, needId());
    });
    await check('UpdateScriptInfo turns a script off and on', async () => {
      await v.setEnabled(needId(), false);
      same('Enabled after turning it off', (await v.scripts())[0]?.enabled, false);
      await v.setEnabled(needId(), true);
      same('Enabled after turning it on', (await v.scripts())[0]?.enabled, true);
    });
    await check('The script runs with its @require, under a URL naming it', async () => {
      const page = await browser.newPage();
      await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Page</p>' }));
      const cdp = await browser.newCDPSession(page);
      await cdp.send('Runtime.enable');
      const logged = new Promise<{ text: unknown; url: string }>((resolve) => {
        cdp.on('Runtime.consoleAPICalled', (e) => {
          if (e.args[0]?.value === 'probe') resolve({ text: e.args[1]?.value, url: e.stackTrace?.callFrames[0]?.url ?? '' });
        });
      });
      await page.goto('https://example.com/');
      const line = await Promise.race([logged, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
      await page.close();
      if (!line) throw new Error('The script logged nothing within 10 seconds');
      same('The @require\'s value', line.text, 42);
      same('The script named by its code\'s URL', v.scriptIdOf(line.url), needId());
    });
    await check('GetAllOptions and SetOptions turn all scripts off and on', async () => {
      await v.setApplied(false);
      same('isApplied after turning it off', await v.applied(), false);
      await v.setApplied(true);
      same('isApplied after turning it on', await v.applied(), true);
    });
    await check('The blacklist option holds its file:// rule, which can be dropped', async () => {
      same('Whether the rule was dropped', await v.allowFilePages(), true);
      same('Whether it was dropped again', await v.allowFilePages(), false);
    });
    await check('MarkRemoved moves a script to the recycle bin', async () => {
      await v.uninstall(needId());
      same('The script list', (await v.scripts()).map((s) => s.id), []);
    });
    await check('RemoveScripts removes scripts for good', async () => {
      const { id: next } = await v.install(first, { url: installUrlOf(fileUrl), files, local: true });
      await v.remove([next]);
      same('The script list', (await v.scripts()).map((s) => s.id), []);
      same('Its text', (await v.texts([next])).get(next), undefined);
    });
  } catch (err) {
    failures.push(`Connecting: ${(err as Error).message}`);
  } finally {
    await vm?.close().catch(() => undefined);
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(failures, `Violentmonkey ${version} failed these of sm-dev's calls`).toEqual([]);
});
