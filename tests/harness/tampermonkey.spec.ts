// sm-dev under the real Tampermonkey: the `collection` and `script`
// commands, and a run's scripts installed into it and removed after.
// Uses the copy `manager fetch` put in sm-dev's cache, and is skipped
// without one. See docs/sm-dev-tampermonkey.md.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, test, expect, type BrowserContext } from '@playwright/test';
import { fetchedVersion } from '../../lib/harness/manager-fetch.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

test.skip(fetchedVersion('tampermonkey') === null, 'No Tampermonkey fetched: run sm-dev --manager tm manager fetch');

// A browser of the test's own, with Tampermonkey installed by
// `manager install`, as a person's would have it.
let browser: BrowserContext;
let endpoint: string;
let dir: string;

test.beforeEach(async () => {
  test.setTimeout(120_000);
  dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-tm-'));
  const profile = path.join(dir, 'profile');
  // Extensions need Chrome's new headless mode (see src/harness/extension-launch.ts).
  browser = await chromium.launchPersistentContext(profile, {
    headless: false, ignoreDefaultArgs: ['--disable-extensions'], args: ['--headless=new', '--remote-debugging-port=0'],
  });
  endpoint = `http://127.0.0.1:${readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]}`;
  expect((await cli('--manager', 'tm', 'manager', 'install')).code).toBe(0);
  writeFileSync(path.join(dir, 'lib.js'), 'var libValue = 42;\n');
  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('hello', libValue);", '// @require     lib.js\n'));
  writeFileSync(path.join(dir, 'page.html'), '<title>Page</title><p>Local</p>');
});

test.afterEach(async () => {
  for (const run of ['DT1', 'DT2', 'D1']) await cli('stop', run);
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, match: string, body: string, extra = ''): string {
  return `// ==UserScript==\n// @name        ${name}\n// @namespace   sm-dev-test\n// @version     1.0\n// @match       ${match}\n${extra}// @grant       none\n// ==/UserScript==\n${body}\n`;
}

// An `sm-dev` command line against the browser, with the test's own
// runs, from the test's folder.
function cli(...words: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, SM_DEV_RUNS_DIR: dir, SM_DEV_LOGS_DIR: dir, SM_DEV_BROWSER: endpoint };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...words], { env, cwd: dir, timeout: 90_000 }, (_err, stdout, stderr) => {
      resolve({ code: child.exitCode, stdout, stderr });
    });
    child.stdin?.end('');
  });
}

const tm = (...words: string[]): ReturnType<typeof cli> => cli('--manager', 'tm', ...words);

test('the collection and script commands, with no run', async () => {
  expect((await tm('script', 'list')).stdout).toBe('No scripts are installed in Tampermonkey\n');
  const install = await tm('script', 'install', 'hello.user.js');
  expect(install.stdout).toMatch(/^Installed E(\d+): Hello in C0: Tampermonkey\n$/);
  const id = /E(\d+)/.exec(install.stdout)![0];
  expect((await tm('script', 'install', 'hello.user.js')).stdout).toBe(`${id}: Hello is already installed in C0: Tampermonkey\n`);

  const list = await tm('script', 'list');
  expect(list.stdout).toBe(`C0: Tampermonkey\n  ${id}: Hello 1.0\n      ${path.join(dir, 'hello.user.js')}\n`);
  const show = await tm('script', id, 'show');
  expect(show.stdout).toContain('  @require:   lib.js\n');
  expect(show.stdout).toContain(`  Location:   ${path.join(dir, 'hello.user.js')}\n`);
  // Without the comment sm-dev adds.
  expect((await tm('script', id, 'print')).stdout).toBe(readFileSync(path.join(dir, 'hello.user.js'), 'utf8'));

  expect((await tm('script', id, 'disable')).stdout).toBe(`Disabled ${id}: Hello\n`);
  expect((await tm('script', 'list')).stdout).toContain(`${id}: Hello 1.0 (disabled)\n`);
  expect((await tm('script', id, 'enable')).stdout).toBe(`Enabled ${id}: Hello\n`);
  expect((await tm('collection', 'C0', 'disable')).stdout).toBe('Disabled C0: Tampermonkey\n');
  expect((await tm('collection', 'list')).stdout).toBe('Collections in Tampermonkey:\n  C0: Tampermonkey (container): 1 script, disabled\n');
  expect((await tm('collection', 'C0', 'enable')).stdout).toBe('Enabled C0: Tampermonkey\n');

  expect((await tm('script', id, 'refresh')).stdout).toBe(`Refreshed ${id}: Hello: no change\n`);
  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('changed');"));
  expect((await tm('script', id, 'refresh')).stdout).toBe(`Refreshed ${id}: Hello: updated\n`);

  // Installing another copy replaces it: the person's own, so only with --force.
  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('again');"));
  const replace = await tm('script', 'install', 'hello.user.js');
  expect(replace.stderr).toBe(`ERROR: ${id}: Hello is installed in Tampermonkey in this browser, so this would replace it for real. Use --force to continue.\n`);
  expect((await tm('script', 'install', 'hello.user.js', '--force')).stdout).toBe(`Replaced the script with the same name and namespace: ${id}: Hello in C0: Tampermonkey\n`);

  const unforced = await tm('script', id, 'uninstall');
  expect(unforced.stderr).toBe(`ERROR: ${id}: Hello is installed in Tampermonkey in this browser, so this would remove it for real. Use --force to continue.\n`);
  expect((await tm('script', id, 'uninstall', '--force')).stdout).toBe(`Uninstalled ${id}: Hello from C0: Tampermonkey\n`);
  expect((await tm('script', 'list')).stdout).toBe('No scripts are installed in Tampermonkey\n');
});

test('a run installs its scripts, traces their logs, and removes them when it ends', async () => {
  const start = await tm('--run', 'DT1', 'start', '--detach', 'hello.user.js');
  expect(start.stdout).toMatch(/\[sm-dev\] Installed in Tampermonkey as E\d+: hello\.user\.js\n/);
  // The local @require, handed over with the script.
  expect(start.stdout).toContain('[script log] hello 42\n');
  const id = /as (E\d+)/.exec(start.stdout)![1];

  const scripts = await cli('--run', 'DT1', 'scripts');
  expect(scripts.stdout).toBe(`Loaded scripts:\n  Expected on tab T1 using match rules:\n  * 1: Hello (hello.user.js), ${id} in Tampermonkey\n`);
  expect((await cli('--run', 'DT1', 'script', 'list')).stdout).toContain(`* ${id}: Hello 1.0 (run DT1's script 1)\n`);

  // Another run can't load it too, nor can it be installed over.
  const second = await tm('--run', 'DT2', 'start', '--detach', '--new', 'hello.user.js');
  expect(second.stdout).toContain(`[sm-dev] hello.user.js could not be loaded into Tampermonkey: Tampermonkey has ${id}: Hello with the same name and namespace, loaded by run DT1. Two runs can't both load one script.\n`);
  const over = await tm('script', 'install', 'hello.user.js');
  expect(over.stdout + over.stderr).toContain('is a script of run DT1, which only that run changes');

  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('updated', libValue);", '// @require     lib.js\n'));
  const update = await cli('--run', 'DT1', 'update');
  expect(update.stdout).toContain(`[sm-dev] Installed in Tampermonkey as ${id}: hello.user.js (replaced)\n`);
  expect(update.stdout).toContain('[script log] updated 42\n');
  expect((await cli('--run', 'DT1', 'logs')).stdout).toMatch(/T1 \[script log\] updated 42\n/);

  await cli('stop', 'DT1');
  expect((await tm('script', 'list')).stdout).toBe('No scripts are installed in Tampermonkey\n');
});

test('a run doesn\'t replace a script installed apart from it', async () => {
  const id = /E\d+/.exec((await tm('script', 'install', 'hello.user.js')).stdout)![0];
  const start = await tm('--run', 'DT1', 'start', '--detach', 'hello.user.js');
  expect(start.stdout).toContain(`installed apart from this run, which a run doesn't replace. To load this one, uninstall that one first: script ${id} uninstall --force.\n`);
  expect((await tm('script', 'list')).stdout).toContain(`  ${id}: Hello 1.0\n`);
});

test('in a --temp-browser, scripts run on local pages', async () => {
  writeFileSync(path.join(dir, 'file.user.js'), script('On files', 'file:///*/page.html', "console.log('on a file page');"));
  const run = await tm('--temp-browser', 'start', '--seconds', '3', 'file.user.js', 'page.html');
  expect(run.stdout).toContain('[script log] on a file page\n');
});

test('stack lines point at the files, other scripts come by Tampermonkey\'s matching, and errors are traced', async () => {
  writeFileSync(path.join(dir, 'two.js'), 'var two = 2;\nfunction where() { return new Error(\'in lib\').stack; }\n');
  writeFileSync(path.join(dir, 'lines.user.js'), script('Lines', 'https://example.com/*',
    "console.log('body', new Error('in body').stack);\nconsole.log('lib', where());\nsetTimeout(() => { null.x; }, 0);",
    '// @require     lib.js\n// @require     two.js\n'));
  writeFileSync(path.join(dir, 'other.user.js'), script('Other', 'https://example.com/*', "console.log('other');"));
  const other = /E\d+/.exec((await tm('script', 'install', 'other.user.js')).stdout)![0];
  const start = await tm('--run', 'DT1', 'start', '--detach', 'lines.user.js');
  // The header is lines 1-9. Tampermonkey runs the code after a line
  // of its own and the @require files, which sm-dev takes back out.
  const url = String.raw`chrome-extension://\w+/userscript\.html\?name=Lines\.user\.js&id=[0-9a-f-]+`;
  expect(start.stdout).toMatch(new RegExp(String.raw`\[script log\] body Error: in body\n {4}at \S+ \(${url}:10:21\)`));
  expect(start.stdout).toContain(`at where (file://${path.join(dir, 'two.js')}:2:27)`);
  expect(start.stdout).toMatch(new RegExp(`${url}:11:20\\)`));
  expect(start.stdout).toContain('[script error] Cannot read properties of null (reading \'x\')\n');
  const id = /as (E\d+)/.exec(start.stdout)![1];
  expect((await cli('--run', 'DT1', 'scripts')).stdout).toBe(`Loaded scripts:\n  Expected on tab T1 using match rules:\n  * 1: Lines (lines.user.js), ${id} in Tampermonkey\nTampermonkey scripts expected on T1:\n  ${other}: Other: Expected using match rules\n`);
  // Turned off, it isn't expected, though Tampermonkey's own matching still gives it.
  expect((await tm('script', other, 'disable')).code).toBe(0);
  expect((await cli('--run', 'DT1', 'scripts')).stdout).not.toContain(other);
});
