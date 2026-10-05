// Userscript managers in a browser: what sm-dev sees (`installedManagers`,
// as a run's first lines and `status` say it), the `manager` verbs, and a
// run under another manager (`--manager`).
//
// Violentmonkey is played by a stand-in: an extension of that name,
// "fetched" into a cache folder of the test's own, so nothing is
// downloaded. It is found by its name, as its id is its own key's. It
// answers the calls a run makes with no scripts installed. The real
// Violentmonkey's are tried in violentmonkey.spec.ts.

import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium, test, expect, type BrowserContext } from '@playwright/test';
import { installedManagers, managerState, managersIn } from '../../lib/harness/browser-extensions.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

// A browser with no extensions, as a person's own would start, which
// `manager install` loads them into.
let browser: BrowserContext;
let endpoint: string;
let dir: string;

test.beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-managers-'));
  const profile = path.join(dir, 'profile');
  // Extensions need Chrome's new headless mode, which Playwright's own
  // headless flag doesn't give (see src/harness/extension-launch.ts).
  browser = await chromium.launchPersistentContext(profile, {
    headless: false, ignoreDefaultArgs: ['--disable-extensions'], args: ['--headless=new', '--remote-debugging-port=0'],
  });
  endpoint = `http://127.0.0.1:${readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]}`;
  // The stand-in, where `manager fetch` would put Violentmonkey.
  const vm = path.join(dir, 'cache', 'sm-dev', 'managers', 'violentmonkey');
  mkdirSync(vm, { recursive: true });
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(path.join(vm, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Violentmonkey', version: '9.9.9', key, background: { service_worker: 'bg.js' }, permissions: ['userScripts'],
  }));
  writeFileSync(path.join(vm, 'bg.js'), `
    const answers = { GetData: { scripts: [] }, GetScriptCode: {}, GetAllOptions: { isApplied: true, blacklist: '' } };
    chrome.runtime.onMessage.addListener((message, _sender, reply) => {
      if (message.cmd in answers) reply(answers[message.cmd]);
    });
  `);
  mkdirSync(path.join(vm, 'options'));
  writeFileSync(path.join(vm, 'options', 'index.html'), '<title>Options</title>');
  writeFileSync(path.join(dir, 'page.html'), '<title>Page</title><p>Hello</p>');
});

test.afterEach(async () => {
  await cli('stop', '--all');
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

// An `sm-dev` command line against the browser, with the
// test's own runs and cache. Playwright finds its browsers by the
// cache folder too, so it's told where they are.
function cli(...args: (string | { input: string })[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const input = args.find((a): a is { input: string } => typeof a !== 'string');
  const words = args.filter((a): a is string => typeof a === 'string');
  const browsers = path.resolve(chromium.executablePath(), '..', '..', '..');
  const env = {
    ...process.env, SM_DEV_RUNS_DIR: dir, SM_DEV_LOGS_DIR: dir, SM_DEV_BROWSER: endpoint,
    XDG_CACHE_HOME: path.join(dir, 'cache'), PLAYWRIGHT_BROWSERS_PATH: browsers,
  };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...words], { env, timeout: 60_000 }, (_err, stdout, stderr) => {
      resolve({ code: child.exitCode, stdout, stderr });
    });
    // Commands on stdin, as piped; none otherwise.
    child.stdin?.end(input?.input ?? '');
  });
}

test('manager install, enable and disable, with a warning for the other one enabled', async () => {
  test.setTimeout(120_000);
  expect(await installedManagers(endpoint)).toEqual([]);
  expect(await managersIn('http://127.0.0.1:1')).toBeNull();
  const sm = await cli('manager', 'install');
  expect(sm.stdout).toMatch(/^Installed SourceMonkey 0\.0\.1 from .*dist, with Allow User Scripts on\n$/);
  const managers = await installedManagers(endpoint);
  expect(managers.map((m) => [m.manager, m.name, m.enabled, m.userScripts])).toEqual([['sourcemonkey', 'SourceMonkey', true, true]]);
  expect(managerState(managers, 'sourcemonkey')).toBe('installed');
  expect(managerState(managers, 'tampermonkey')).toBe('absent');

  const install = await cli('--manager', 'vm', 'manager', 'install');
  expect(install.code).toBe(0);
  expect(install.stdout).toMatch(/^Installed Violentmonkey 9\.9\.9 from .*violentmonkey, with Allow User Scripts on\n$/);
  expect(install.stderr).toBe('Warning: SourceMonkey is also enabled in this browser, so its scripts run too. To turn it off, use sm-dev --manager sm manager disable.\n');
  expect((await cli('--manager', 'vm', 'manager', 'install')).stdout).toMatch(/^Violentmonkey 9\.9\.9 is already installed, from /);
  const vm = (await installedManagers(endpoint)).find((m) => m.manager === 'violentmonkey');
  expect(vm).toMatchObject({ name: 'Violentmonkey', enabled: true, userScripts: true });

  expect((await cli('--manager', 'vm', 'manager', 'disable')).stdout).toBe('Disabled Violentmonkey 9.9.9\n');
  expect((await cli('--manager', 'vm', 'manager', 'disable')).stdout).toBe('Violentmonkey 9.9.9 is already disabled\n');
  expect(managerState(await installedManagers(endpoint), 'violentmonkey')).toBe('disabled');
  const enable = await cli('--manager', 'violentmonkey', 'manager', 'enable');
  expect(enable.stdout).toBe('Enabled Violentmonkey 9.9.9\n');
  expect(enable.stderr).toContain('Warning: SourceMonkey is also enabled');

  // With no run, status shows the browser and its managers.
  const before = (await cli('status')).stdout.split('\n');
  expect(before[0]).toBe('No current run. (Use start or attach to connect to one.)');
  expect(before[1]).toMatch(/^Browser: 127\.0\.0\.1:\d+ \(Chrome [\d.]+, headless\)$/);
  expect(before.slice(2)).toEqual([
    'Managers: SourceMonkey 0.0.1 (chosen), Violentmonkey 9.9.9',
    'Warning: Violentmonkey is also enabled in this browser, so its scripts run too. To turn it off, use sm-dev --manager vm manager disable.',
    '',
    'No other active runs',
    '',
  ]);

  // A run's first lines warn of it, as status does. SourceMonkey can't
  // be turned off under it.
  const started = await cli('start', '--notab', '--detach', '--', 'status');
  expect(started.stdout).toContain('[sm-dev] Warning: Violentmonkey is also enabled in this browser, so its scripts run too.');
  // Headed by how this sm-dev came to the run.
  expect(started.stdout).toMatch(/^Started run \(detached\): D1 \(pid /m);
  expect((await cli('--stdin', { input: 'attach D1\nstatus\n' })).stdout).toMatch(/^Attached run: D1 \(pid /m);
  const status = await cli('status');
  expect(status.stdout).toMatch(/^Other run: D1 \(pid /m);
  expect(status.stdout).toContain('Managers: SourceMonkey 0.0.1 (in use), Violentmonkey 9.9.9\n');
  expect(status.stdout).toContain('Warning: Violentmonkey is also enabled');
  const off = await cli('manager', 'disable');
  expect(off.code).toBe(1);
  expect(off.stderr).toContain('SourceMonkey can\'t be turned off while run D1 uses it. Stop that run first.');
  // The run works with SourceMonkey, so another --manager is refused.
  const other = await cli('--manager', 'vm', '--run', 'D1', 'status');
  expect(other.code).toBe(2);
  expect(other.stderr).toContain('The --manager flag names Violentmonkey, but run D1 uses SourceMonkey.');
  // The manager verbs act on the browser, so the warning's advice works
  // beside the run.
  expect((await cli('--manager', 'vm', 'manager', 'disable')).stdout).toBe('Disabled Violentmonkey 9.9.9\n');
  await cli('stop');
  expect((await cli('manager', 'disable')).stdout).toBe('Disabled SourceMonkey 0.0.1\n');
});

test('a run under another manager drives its pages, and refuses what needs SourceMonkey', async () => {
  test.setTimeout(90_000);
  const page = pathToFileURL(path.join(dir, 'page.html')).href;
  const withScript = await cli('--manager', 'tm', '--temp-browser', 'start', path.join(dir, 'x.user.js'));
  expect(withScript.code).toBe(2);
  expect(withScript.stderr).toContain('A run can\'t load scripts into Tampermonkey yet.');

  const run = await cli('--manager', 'vm', '--temp-browser', 'start', page, '--', 'status', '--', 'snapshot', '--', 'values');
  expect(run.stdout).toContain('(Chrome ');
  expect(run.stdout).toContain(', has Violentmonkey)');
  expect(run.stdout).toContain('Managers: Violentmonkey 9.9.9 (in use)\n');
  expect(run.stdout).toContain('Backend: Violentmonkey 9.9.9, with the run\'s scripts installed in it until the run ends');
  expect(run.stdout).toContain('paragraph [ref=');
  expect(run.stdout).toContain('[sm-dev] ERROR: The values command works with SourceMonkey only, and this run uses Violentmonkey');
  expect(run.code).toBe(2);
});
