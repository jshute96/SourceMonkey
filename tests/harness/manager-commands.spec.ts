// `collection list` (`collections`) and `script list` from the command
// line: with no run, sm-dev connects to the --browser browser for them;
// in a run, the run answers them. Text and --json.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Worker } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';
import { findExtensionWorker } from '../../lib/harness/extension-backend.js';
import { launchExtensionBrowser, type LaunchedExtensionBrowser } from '../../lib/harness/extension-launch.js';
import { CONTAINER_TARGET_ONLY, LISTED_BY_LOCATION, RUN_COLLECTION_LOCKED } from '../../lib/sm-dev-protocol.js';

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
  // Each sm-dev call below connects to the browser afresh, about a
  // second apiece on a quiet machine, so they outlast the default 30s
  // under load.
  test.setTimeout(90_000);
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
  const listed = await cli('start', '--notab', file, '--', 'script', e, '--', 'scripts', '--', 'script', 'disable');
  expect(listed.stdout).toContain(`* ${e}: Away (`);
  // A verb with no script acts on the selected one.
  expect(listed.stdout).toContain(`Disabled ${e}: Away\n`);
  const missing = await cli('start', '--notab', file, '--', 'script', 'E99');
  expect(missing.stdout + missing.stderr).toContain('There is no script E99. Use `script list` to list the installed scripts.');
});

test('show, print, enable, disable and refresh, with no run', async ({ scriptsDir }) => {
  test.setTimeout(120_000);
  const file = scriptsDir.write({
    relativePath: 'a/one.user.js',
    meta: { name: 'One', match: ['https://example.com/*'], grant: ['GM_setValue'], extra: ['// @version 1.2', '// @description Does one thing'] },
    body: '',
  });
  const dir = path.join(scriptsDir.path, 'a');
  await worker.evaluate((d) => (self as unknown as Sm).SourceMonkey.addCollection(d), dir);

  const shown = await cli('collection', 'C1', 'show');
  expect(shown.stderr).toBe('');
  expect(shown.stdout).toBe(`C1: ${dir}\n  Kind:       directory\n  Location:   ${dir}\n  Status:     Enabled\n  Scripts:    1 script\n  E1: One 1.2\n`);

  const script = await cli('script', 'one', 'show');
  expect(script.stdout).toMatch(/^E1: One 1\.2\n/);
  expect(script.stdout).toMatch(/^ {2}Description: +Does one thing$/m);
  expect(script.stdout).toMatch(/^ {2}Collection: +C1: /m);
  expect(script.stdout).toMatch(/^ {2}Status: +Enabled, ok$/m);
  expect(script.stdout).toMatch(/^ {2}@match: +https:\/\/example\.com\/\*$/m);
  expect(script.stdout).toMatch(/^ {2}@grant: +GM_setValue$/m);
  const json = JSON.parse((await cli('script', 'E1', 'show', '--json')).stdout);
  expect(json).toMatchObject({
    command: 'script show',
    script: { id: 'E1', description: 'Does one thing', runAt: 'document-idle', grants: ['GM_setValue'], matching: { match: ['https://example.com/*'] }, valueCount: 0 },
  });

  const printed = await cli('script', 'E1', 'print');
  expect(printed.stdout).toBe(readFileSync(file, 'utf8').replace(/\n?$/, '\n'));

  // Easily undone, so no --force.
  expect((await cli('script', 'E1', 'disable')).stdout).toBe('Disabled E1: One\n');
  const enabled = JSON.parse((await cli('--json', 'script', 'E1', 'enable')).stdout);
  expect(enabled).toMatchObject({ command: 'script enable', script: { id: 'E1', enabled: true } });

  expect((await cli('script', 'E1', 'refresh')).stdout).toBe('Refreshed E1: One: no change\n');
  // Marked as the collections page does, until a refresh loads it.
  writeFileSync(file, readFileSync(file, 'utf8').replace('// @version 1.2', '// @version 1.3.0'));
  expect((await cli('script', 'list')).stdout).toContain('  E1: One 1.2 (modified on disk)\n');
  expect((await cli('collection', 'list')).stdout).toContain('      Refresh pending: 1 file modified on disk\n');
  expect(JSON.parse((await cli('script', 'E1', 'show', '--json')).stdout).script.onDisk).toBe('modified');
  expect((await cli('script', 'E1', 'refresh')).stdout).toBe('Refreshed E1: One: updated\n');
  expect((await cli('script', 'list')).stdout).toContain('  E1: One 1.3.0\n');

  const two = scriptsDir.write({ relativePath: 'a/two.user.js', meta: { name: 'Two', match: ['https://example.com/*'] }, body: '' });
  const refreshed = await cli('collection', 'C1', 'refresh');
  expect(refreshed.stdout).toBe(`Refreshed C1: ${dir}: 1 updated, 1 unchanged\n  Updated E2: Two\n`);
  // A removed script keeps its number in what's said of it.
  rmSync(two);
  expect((await cli('collection', 'C1', 'refresh')).stdout).toBe(`Refreshed C1: ${dir}: 0 updated, 1 unchanged, 1 removed\n  Removed E2: Two\n`);

  expect((await cli('collection', 'C1', 'disable')).stdout).toBe(`Disabled C1: ${dir}\n`);
  expect((await cli('script', 'E1', 'enable')).stdout)
    .toBe(`Enabled E1: One\n  E1: One is enabled, but won't run because it's inside disabled collection C1: ${dir}\n`);
  expect((await cli('collection', 'C1', 'rename', 'Mine')).stdout).toBe('Renamed C1 to Mine\n');
  expect(JSON.parse((await cli('collection', 'list', '--json')).stdout).collections[0]).toMatchObject({ name: 'Mine', enabled: false });

  const missing = await cli('script', 'show');
  expect(missing.stderr).toContain('The `script show` command needs a script: `script <script> show`. There is no selected script outside a run.');
  expect((await cli('script', 'enable', 'E1')).stderr).toContain('Name the script before the verb: script E1 enable');
});

test('install, uninstall and move', async ({ scriptsDir }) => {
  test.setTimeout(120_000);
  const file = scriptsDir.write({ relativePath: 'loose/solo.user.js', meta: { name: 'Solo', match: ['https://example.com/*'] }, body: '' });
  scriptsDir.write({ relativePath: 'dir/listed.user.js', meta: { name: 'Listed', match: ['https://example.com/*'] }, body: '' });
  await worker.evaluate((d) => (self as unknown as Sm).SourceMonkey.addCollection(d), path.join(scriptsDir.path, 'dir'));
  await worker.evaluate(() => (self as unknown as { SourceMonkey: { createCollection(spec: unknown): Promise<unknown> } }).SourceMonkey.createCollection({ kind: 'scripts', name: 'Mine' }));

  // A relative path is the sender's.
  const installed = await cli('script', 'install', path.relative(process.cwd(), file));
  expect(installed.stderr).toBe('');
  expect(installed.stdout).toMatch(/^Installed E2: Solo in C3: Scripts from local disk\n$/);
  expect((await cli('script', 'install', file)).stdout).toBe('E2: Solo is already installed in C3: Scripts from local disk\n');

  const moved = JSON.parse((await cli('script', 'Solo', 'move', 'Mine', '--json')).stdout);
  expect(moved).toMatchObject({ command: 'script move', script: { id: 'E2', collection: { id: 'C2', name: 'Mine' } } });
  expect((await cli('script', 'E2', 'move', 'Mine')).stderr).toContain('E2: Solo is already in C2: Mine');

  // A directory's scripts come from its files.
  // Refused before --force is asked for.
  expect((await cli('script', 'Listed', 'uninstall')).stderr).toBe(`Could not uninstall E1: Listed: ${LISTED_BY_LOCATION}\n`);
  expect((await cli('script', 'E2', 'move', 'C1')).stderr).toContain(`Could not move E2: Solo to C1: ${path.join(scriptsDir.path, 'dir')}: ${CONTAINER_TARGET_ONLY}`);
  expect((await cli('script', 'install', file, '--collection', 'C1')).stderr).toContain(CONTAINER_TARGET_ONLY);

  expect((await cli('script', 'E2', 'uninstall')).code).toBe(1);
  expect((await cli('script', 'E2', 'uninstall', '--force')).stdout).toBe('Uninstalled E2: Solo from C2: Mine\n');
  expect((await cli('script', 'list', 'Mine')).stdout).toBe('C2: Mine\n  No scripts\n');

  const again = JSON.parse((await cli('script', 'install', file, '--collection', 'Mine', '--json')).stdout);
  expect(again).toMatchObject({ command: 'script install', script: { name: 'Solo', enabled: true, collection: { id: 'C2' } } });

  // Another copy of a running script turns that one off, as the viewer does.
  const listed = path.join(scriptsDir.path, 'dir', 'listed.user.js');
  expect((await cli('script', 'install', listed, '--collection', 'Mine')).stdout).toBe(
    `Installed E4: Listed in C2: Mine\n  Another version of this script was disabled: E1: Listed in collection C1: ${path.join(scriptsDir.path, 'dir')}\n`);
  expect(JSON.parse((await cli('script', 'E1', 'enable', '--json')).stdout)).toMatchObject({ turnedOff: [{ id: 'E4', enabled: false }] });

  // Moved into a disabled collection, it doesn't run, so turns nothing off.
  await worker.evaluate(() => (self as unknown as { SourceMonkey: { createCollection(spec: unknown): Promise<unknown> } }).SourceMonkey.createCollection({ kind: 'scripts', name: 'Off' }));
  expect((await cli('collection', 'Off', 'disable')).code).toBe(0);
  expect((await cli('script', 'E4', 'enable')).stdout).toContain('Another version of this script was disabled: E1: Listed in collection C1: ');
  expect((await cli('script', 'E4', 'move', 'Off')).stdout)
    .toBe('Moved E4: Listed to C4: Off\n  E4: Listed is enabled, but won\'t run because it\'s inside disabled collection C4: Off\n');
  expect((await cli('script', 'install', path.join(scriptsDir.path, 'dir'))).stderr).toContain('is not a .user.js file or URL');
});

test('in a run, its own scripts and its test collection', async ({ scriptsDir }) => {
  const file = scriptsDir.write({ relativePath: 'run.user.js', meta: { name: 'Mine', match: ['https://example.com/*'] }, body: '' });
  // With no script named, the selected one.
  const result = await cli('start', '--notab', file, '--', 'script', 'disable', '--', 'script', '1', 'show', '--',
    'script', '1', 'enable', '--', 'collection', 'D1', 'disable');
  const text = result.stdout + result.stderr;
  // Its own, so no --force.
  expect(text).toContain('Disabled 1: Mine\n');
  expect(text).toMatch(/^ {2}Status: +Disabled, ok$/m);
  // By the path the run was given, as script list shows it.
  expect(text).toMatch(new RegExp(`^ {2}Location: +${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  expect(text).toContain('Enabled 1: Mine\n');
  expect(text).toMatch(new RegExp(`\\n\\[sm-dev\\] Could not disable D1: sm-dev test collection \\(run D1-[0-9a-f]{4}\\): ${RUN_COLLECTION_LOCKED}\\n`));
  // Re-read from disk, as update does; and on each tab, as scripts says.
  const more = await cli('start', '--notab', file, '--', 'script', '1', 'refresh', '--', 'newtab', '--', 'script', '1', 'show', '--', 'script', '1', 'refresh', '--json');
  expect(more.stdout + more.stderr).toContain('Script 1 hasn\'t changed on disk, so nothing was reloaded');
  expect(more.stdout).toMatch(/^ {2}Tabs: +T1: Not running$/m);
  const refreshJson = JSON.parse(more.stdout.split('\n').find((l) => l.startsWith('{"command":"script refresh"'))!);
  expect(refreshJson).toMatchObject({ script: { id: '1', kind: 'run' }, updated: false });
  const uninstall = await cli('start', '--notab', file, '--', 'script', '1', 'uninstall');
  const moved = await cli('start', '--notab', file, '--', 'script', '1', 'move', 'C1');
  expect(moved.stdout + moved.stderr).toContain('1: Mine is one of this run\'s own scripts, which stay in its test collection');
  expect(uninstall.stdout + uninstall.stderr).toContain('1: Mine is one of this run\'s own scripts, which go when the run ends');
  // Never the selected one by leaving it out.
  const unnamed = await cli('start', '--notab', file, '--', 'script', 'uninstall');
  expect(unnamed.stdout + unnamed.stderr).toContain('The `script uninstall` command needs a script: `script <script> uninstall [--force]`');
});
