// sm-dev under the real Violentmonkey: the `collection` and `script`
// commands, and a run's scripts installed into it and removed after.
// Uses the copy `manager fetch` put in sm-dev's cache, and is skipped
// without one. See docs/sm-dev-violentmonkey.md.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, test, expect, type BrowserContext } from '@playwright/test';
import { fetchedVersion } from '../../lib/harness/manager-fetch.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

test.skip(fetchedVersion('violentmonkey') === null, 'No Violentmonkey fetched: run sm-dev --manager vm manager fetch');

// A browser of the test's own, with Violentmonkey installed by
// `manager install`, as a person's would have it.
let browser: BrowserContext;
let endpoint: string;
let dir: string;

test.beforeEach(async () => {
  test.setTimeout(120_000);
  dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-vm-'));
  const profile = path.join(dir, 'profile');
  // Extensions need Chrome's new headless mode (see src/harness/extension-launch.ts).
  browser = await chromium.launchPersistentContext(profile, {
    headless: false, ignoreDefaultArgs: ['--disable-extensions'], args: ['--headless=new', '--remote-debugging-port=0'],
  });
  endpoint = `http://127.0.0.1:${readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]}`;
  expect((await cli('--manager', 'vm', 'manager', 'install')).code).toBe(0);
  writeFileSync(path.join(dir, 'lib.js'), 'var libValue = 42;\n');
  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('hello', libValue);", '// @require     lib.js\n'));
  writeFileSync(path.join(dir, 'page.html'), '<title>Page</title><p>Local</p>');
});

test.afterEach(async () => {
  for (const run of ['DV1', 'DV2', 'D1']) await cli('stop', run);
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

const vm = (...words: string[]): ReturnType<typeof cli> => cli('--manager', 'vm', ...words);

test('the collection and script commands, with no run', async () => {
  expect((await vm('script', 'list')).stdout).toBe('No scripts are installed in Violentmonkey\n');
  const install = await vm('script', 'install', 'hello.user.js');
  expect(install.stdout).toMatch(/^Installed E(\d+): Hello in C0: Violentmonkey\n$/);
  const id = /E(\d+)/.exec(install.stdout)![0];
  expect((await vm('script', 'install', 'hello.user.js')).stdout).toBe(`${id}: Hello is already installed in C0: Violentmonkey\n`);

  const list = await vm('script', 'list');
  expect(list.stdout).toBe(`C0: Violentmonkey\n  ${id}: Hello 1.0\n      ${path.join(dir, 'hello.user.js')}\n`);
  const show = await vm('script', id, 'show');
  expect(show.stdout).toContain('  @require:   lib.js\n');
  expect(show.stdout).toContain(`  Location:   ${path.join(dir, 'hello.user.js')}\n`);
  // Without the comment sm-dev adds.
  expect((await vm('script', id, 'print')).stdout).toBe(readFileSync(path.join(dir, 'hello.user.js'), 'utf8'));

  expect((await vm('script', id, 'disable')).stdout).toBe(`Disabled ${id}: Hello\n`);
  expect((await vm('script', 'list')).stdout).toContain(`${id}: Hello 1.0 (disabled)\n`);
  expect((await vm('script', id, 'enable')).stdout).toBe(`Enabled ${id}: Hello\n`);
  expect((await vm('collection', 'C0', 'disable')).stdout).toBe('Disabled C0: Violentmonkey\n');
  expect((await vm('collection', 'list')).stdout).toBe('Collections in Violentmonkey:\n  C0: Violentmonkey (container): 1 script, disabled\n');
  expect((await vm('collection', 'C0', 'enable')).stdout).toBe('Enabled C0: Violentmonkey\n');

  expect((await vm('script', id, 'refresh')).stdout).toBe(`Refreshed ${id}: Hello: no change\n`);
  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('changed');"));
  expect((await vm('script', id, 'refresh')).stdout).toBe(`Refreshed ${id}: Hello: updated\n`);

  // Installing another copy replaces it: the person's own, so only with --force.
  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('again');"));
  const replace = await vm('script', 'install', 'hello.user.js');
  expect(replace.stderr).toBe(`ERROR: ${id}: Hello is installed in Violentmonkey in this browser, so this would replace it for real. Use --force to continue.\n`);
  expect((await vm('script', 'install', 'hello.user.js', '--force')).stdout).toBe(`Replaced the script with the same name and namespace: ${id}: Hello in C0: Violentmonkey\n`);

  const unforced = await vm('script', id, 'uninstall');
  expect(unforced.stderr).toBe(`ERROR: ${id}: Hello is installed in Violentmonkey in this browser, so this would remove it for real. Use --force to continue.\n`);
  expect((await vm('script', id, 'uninstall', '--force')).stdout).toBe(`Uninstalled ${id}: Hello from C0: Violentmonkey\n`);
  expect((await vm('script', 'list')).stdout).toBe('No scripts are installed in Violentmonkey\n');
});

test('a run installs its scripts, traces their logs, and removes them when it ends', async () => {
  const start = await vm('--run', 'DV1', 'start', '--detach', 'hello.user.js');
  expect(start.stdout).toMatch(/\[sm-dev\] Installed in Violentmonkey as E\d+: hello\.user\.js\n/);
  // The local @require, handed over with the script.
  expect(start.stdout).toContain('[script log] hello 42\n');
  const id = /as (E\d+)/.exec(start.stdout)![1];

  const scripts = await cli('--run', 'DV1', 'scripts');
  expect(scripts.stdout).toBe(`Loaded scripts:\n  Expected on tab T1 using match rules:\n  * 1: Hello (hello.user.js), ${id} in Violentmonkey\n`);
  expect((await cli('--run', 'DV1', 'script', 'list')).stdout).toContain(`* ${id}: Hello 1.0 (run DV1's script 1)\n`);

  // Another run can't load it too, nor can it be installed over.
  const second = await vm('--run', 'DV2', 'start', '--detach', '--new', 'hello.user.js');
  expect(second.stdout).toContain(`[sm-dev] hello.user.js could not be loaded into Violentmonkey: Violentmonkey has ${id}: Hello with the same name and namespace, loaded by run DV1. Two runs can't both load one script.\n`);
  const over = await vm('script', 'install', 'hello.user.js');
  expect(over.stdout + over.stderr).toContain('is a script of run DV1, which only that run changes');

  writeFileSync(path.join(dir, 'hello.user.js'), script('Hello', 'https://example.com/*', "console.log('updated', libValue);", '// @require     lib.js\n'));
  const update = await cli('--run', 'DV1', 'update');
  expect(update.stdout).toContain(`[sm-dev] Installed in Violentmonkey as ${id}: hello.user.js (replaced)\n`);
  expect(update.stdout).toContain('[script log] updated 42\n');
  expect((await cli('--run', 'DV1', 'logs')).stdout).toMatch(/T1 \[script log\] updated 42\n/);

  await cli('stop', 'DV1');
  expect((await vm('script', 'list')).stdout).toBe('No scripts are installed in Violentmonkey\n');
});

test('a run doesn\'t replace a script installed apart from it', async () => {
  const id = /E\d+/.exec((await vm('script', 'install', 'hello.user.js')).stdout)![0];
  const start = await vm('--run', 'DV1', 'start', '--detach', 'hello.user.js');
  expect(start.stdout).toContain(`installed apart from this run, which a run doesn't replace. To load this one, uninstall that one first: script ${id} uninstall --force.\n`);
  expect((await vm('script', 'list')).stdout).toContain(`  ${id}: Hello 1.0\n`);
});

test('in a --temp-browser, scripts run on local pages', async () => {
  writeFileSync(path.join(dir, 'file.user.js'), script('On files', 'file:///*/page.html', "console.log('on a file page');"));
  const run = await vm('--temp-browser', 'start', '--stop-after-seconds', '3', 'file.user.js', 'page.html');
  expect(run.stdout).toContain('[script log] on a file page\n');
});
