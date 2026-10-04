// `collection list` (`collections`) and `script list` from the command
// line: with no run, sm-dev connects to the --browser browser for them;
// in a run, the run answers them. Text and --json.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Worker } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';
import { findExtensionWorker } from '../../lib/harness/extension-backend.js';
import { launchExtensionBrowser, type LaunchedExtensionBrowser } from '../../lib/harness/extension-launch.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

type Sm = { SourceMonkey: { addCollection(path: string): Promise<{ id: string } | null>; syncNow(): Promise<void> } };

let launched: LaunchedExtensionBrowser;
let worker: Worker;
let runsDir: string;

// A browser and runs directory per test, so each starts with nothing
// installed and its numbers from 1.
test.beforeEach(async () => {
  launched = await launchExtensionBrowser({ connectedElsewhere: true });
  worker = await findExtensionWorker(launched.context);
  runsDir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-manager-runs-'));
});

test.afterEach(async () => {
  await cli('stop', '--all');
  await launched.close();
  rmSync(runsDir, { recursive: true, force: true });
});

// An `sm-dev` command line against the launched browser, with no runs.
function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, SM_DEV_RUNS_DIR: runsDir, SM_DEV_LOGS_DIR: runsDir, SM_DEV_BROWSER: launched.endpoint };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (_err, stdout, stderr) => {
      resolve({ code: child.exitCode, stdout, stderr });
    });
  });
}

test('collection list and script list, with no run', async ({ scriptsDir }) => {
  scriptsDir.write({ relativePath: 'a/one.user.js', meta: { name: 'One', match: ['https://example.com/*'], extra: ['// @version 1.2'] }, body: '' });
  scriptsDir.write({ relativePath: 'b/two.user.js', meta: { name: 'Two', match: ['https://example.com/*'] }, body: '' });
  await worker.evaluate((dir) => (self as unknown as Sm).SourceMonkey.addCollection(dir), path.join(scriptsDir.path, 'a'));
  await worker.evaluate((dir) => (self as unknown as Sm).SourceMonkey.addCollection(dir), path.join(scriptsDir.path, 'b'));

  const collections = await cli('collections');
  expect(collections.stderr).toBe('');
  expect(collections.code).toBe(0);
  const listed = collections.stdout.split('\n');
  expect(listed[0]).toBe('Collections in SourceMonkey:');
  // A directory collection is named by its path, so its location isn't
  // said again.
  const a = path.join(scriptsDir.path, 'a');
  expect(listed.slice(1, 3)).toEqual([`  C1: ${a} (directory): 1 script`, `  C2: ${path.join(scriptsDir.path, 'b')} (directory): 1 script`]);

  const json = JSON.parse((await cli('--json', 'collection', 'list')).stdout);
  expect(json.command).toBe('collection list');
  expect(json.collections.map((c: { id: string; kind: string; enabled: boolean; status: string; scriptCount: number }) =>
    [c.id, c.kind, c.enabled, c.status, c.scriptCount])).toEqual([['C1', 'directory', true, 'ok', 1], ['C2', 'directory', true, 'ok', 1]]);

  const scripts = (await cli('script', 'list')).stdout.split('\n');
  expect(scripts.slice(0, 2)).toEqual([`C1: ${a}`, '  E1: One 1.2']);
  expect(scripts).toContain('  E2: Two');

  // Named by a part of its name only it has.
  const one = JSON.parse((await cli('script', 'list', `${path.sep}b`, '--json')).stdout);
  expect(one).toMatchObject({ command: 'script list', collection: { id: 'C2' } });
  expect(one.scripts).toHaveLength(1);
  expect(one.scripts[0]).toMatchObject({ id: 'E2', kind: 'installed', name: 'Two', collection: { id: 'C2' }, enabled: true, status: 'ok' });

  // Its flags can come before the verb, and either spelling does.
  expect(JSON.parse((await cli('scripts', '--json', 'list')).stdout).scripts).toHaveLength(2);
  expect((await cli('collection')).stdout).toBe(collections.stdout);
  expect((await cli('collections', 'list')).stdout).toBe(collections.stdout);

  const missing = await cli('script', 'list', 'C9');
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('There is no collection C9');
});

test('a run answers them itself', async ({ scriptsDir }) => {
  const file = scriptsDir.write({ relativePath: 'run.user.js', meta: { name: 'Mine', match: ['https://example.com/*'] }, body: '' });
  scriptsDir.write({ relativePath: 'installed/kept.user.js', meta: { name: 'Kept', match: ['https://example.com/*'] }, body: '' });
  await worker.evaluate((dir) => (self as unknown as Sm).SourceMonkey.addCollection(dir), path.join(scriptsDir.path, 'installed'));
  // `start`, then the commands, in one line: they go to the run.
  const result = await cli('start', '--notab', file, '--', 'collections', '--', 'script', 'list');
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^ {2}E\d+: Kept$/m);
  expect(result.stdout).toContain('Collections in SourceMonkey:');
  // The run's own test collection is listed by its run, and its script
  // under it by the run's number, marked as the selected one.
  expect(result.stdout).toMatch(/^ {2}D\d+: sm-dev test collection .*\(container\): 1 script$/m);
  expect(result.stdout).toMatch(/^D\d+: sm-dev test collection .*\n\* 1: Mine$/m);
  // Shown by the path the run was given; the JSON has its file:// URL too.
  expect(result.stdout).toContain(`* 1: Mine\n      ${file}\n`);
  const json = await cli('start', '--notab', file, '--', 'script', 'list', 'D1', '--json');
  // One line, piped, among the run's own lines.
  const mine = JSON.parse(json.stdout.split('\n').find((l) => l.startsWith('{"command":"script list"'))!).scripts[0];
  expect(mine).toMatchObject({ id: '1', kind: 'run', file, location: pathToFileURL(file).href, selected: true });
});

test('--browser naming another browser than the run\'s is refused, except for the listings', async ({ scriptsDir }) => {
  const file = scriptsDir.write({ relativePath: 'run.user.js', meta: { name: 'Mine', match: ['https://example.com/*'] }, body: '' });
  expect((await cli('start', '--detach', '--notab', file)).code).toBe(0);
  const wrong = await cli('--browser', '1', 'tabs');
  expect(wrong.code).toBe(2);
  expect(wrong.stderr).toMatch(/The --browser flag names the browser at 127\.0\.0\.1:1, but run D\d+ uses the one at /);
  // The run's own browser is fine, however it's spelled.
  expect((await cli('--browser', launched.endpoint.replace(/^http:\/\/127\.0\.0\.1/, 'localhost'), 'tabs')).code).toBe(0);
  // The listings need no run, so they list a browser no run is in.
  const other = await launchExtensionBrowser({ connectedElsewhere: true });
  try {
    const listed = await cli('--browser', other.endpoint, 'collections');
    expect(listed.stderr).toBe('');
    expect(listed.stdout).toBe('Collections in SourceMonkey:\n  None\n');
  } finally {
    await other.close();
  }
});

test('an installed script not on the tab can be picked, and its values read and written', async ({ scriptsDir }) => {
  scriptsDir.write({ relativePath: 'elsewhere/away.user.js', meta: { name: 'Away', match: ['https://example.com/*'] }, body: '' });
  await worker.evaluate((dir) => (self as unknown as Sm).SourceMonkey.addCollection(dir), path.join(scriptsDir.path, 'elsewhere'));
  const numbers = await worker.evaluate(() => (self as unknown as { SourceMonkey: { scriptNumbers(): Promise<Record<string, number>> } }).SourceMonkey.scriptNumbers());
  const e = `E${Math.max(...Object.values(numbers))}`;
  const file = scriptsDir.write({ relativePath: 'run.user.js', meta: { name: 'Mine', match: ['https://example.com/*'] }, body: '' });
  const result = await cli('start', '--notab', file, '--', 'script', e.toLowerCase(), '--', 'set', 'k', '--force', '7', '--', 'get', 'k', '--', 'script', 'list');
  const text = result.stdout + result.stderr;
  expect(text).toContain(`Selected ${e}: Away. No tab is open.\n`);
  expect(text).toContain('  k = 7');
  expect(text).toContain(`* ${e}: Away`);
  // `scripts` lists it too, with no tab open.
  const listed = await cli('start', '--notab', file, '--', 'script', e, '--', 'scripts');
  expect(listed.stdout).toContain(`* ${e}: Away (`);
  const missing = await cli('start', '--notab', file, '--', 'script', 'E99');
  expect(missing.stdout + missing.stderr).toContain('There is no script E99. Use script list to list the installed scripts.');
});
