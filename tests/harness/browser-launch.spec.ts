// `sm-dev --open-browser` (browser-launch.ts): a browser that stays up after
// sm-dev ends, started once however often it's asked for, with a
// profile for each browser and port. Playwright's Chromium, headless,
// stands in for Chrome, and a temp directory for ~/.config. Also
// `--temp-browser --browser-type chrome` (chrome-launch.ts).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { test, expect } from '../fixtures/harness.js';
import { chromeCandidates } from '../../lib/harness/browser-launch.js';
import { extensionArgs, prepareProfile } from '../../lib/harness/extension-launch.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

const CHROME_INSTALLED = chromeCandidates().some((f) => existsSync(f));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

test('--open-browser starts a lasting browser once, on a profile of its port', async () => {
  test.setTimeout(60_000);
  const config = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-launch-'));
  const runs = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-launch-runs-'));
  const env = {
    ...process.env, XDG_CONFIG_HOME: config, SM_DEV_RUNS_DIR: runs, SM_DEV_LOGS_DIR: runs,
    // On Linux, Chrome puts a profile's disk cache in $XDG_CACHE_HOME at
    // its path under $XDG_CONFIG_HOME, so this would otherwise leave a
    // ~/.cache/sm-dev/browser-profile-<port> behind for every run.
    XDG_CACHE_HOME: path.join(config, 'cache'),
    // With SourceMonkey, for the run below, which needs it.
    SM_DEV_BROWSER_BINARY: chromium.executablePath(), SM_DEV_BROWSER_ARGS: ['--headless=new', ...extensionArgs()].join(' '),
  };
  const cli = (...args: string[]): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  const port = await freePort();
  const profile = path.join(config, 'sm-dev', `browser-profile-${port}`);
  await prepareProfile(profile);
  try {
    expect(cli('--open-browser', '--browser', String(port))).toEqual({ code: 0, out: `[sm-dev] Launched chrome at 127.0.0.1:${port} (profile ${profile})` });
    // Still up once sm-dev has ended, and asked again, used as it is,
    // here by a run that connects to it.
    expect((await fetch(`http://127.0.0.1:${port}/json/version`)).ok).toBe(true);
    const started = cli('--browser', String(port), '--open-browser', 'start', 'about:blank', '--detach');
    expect(started.code).toBe(0);
    expect(started.out.split('\n')[0]).toBe(`[sm-dev] A browser is already running at 127.0.0.1:${port}`);
    expect(cli('list').out).toMatch(new RegExp(`^D1 .* 127\\.0\\.0\\.1:${port} \\(headless\\) `, 'm'));
    expect(cli('stop', '--all').code).toBe(0);
    // Its profile can't be had by a second browser, on another port.
    const other = await freePort();
    expect(cli('--open-browser', '--browser', String(other), '--profile', profile)).toEqual({
      code: 1,
      out: `The profile ${profile} is in use by the browser on port ${port}. Use \`--browser ${port}\`, or another --profile`,
    });
    // A --profile given with the port has to be that browser's own.
    expect(cli('--open-browser', '--browser', String(port), '--profile', profile)).toEqual({ code: 0, out: `[sm-dev] A browser is already running at 127.0.0.1:${port}` });
    const elsewhere = path.join(config, 'elsewhere');
    expect(cli('--open-browser', '--browser', String(port), '--profile', elsewhere)).toEqual({
      code: 1,
      out: `The browser at 127.0.0.1:${port} isn't using the profile ${elsewhere}. Use another --browser port to start one with it`,
    });
  } finally {
    // The browser, by the lock on its profile, however far this got.
    try {
      process.kill(Number(readlinkSync(path.join(profile, 'SingletonLock')).split('-').at(-1)));
    } catch {
      // Never started, or gone.
    }
    // Chrome's helpers can still be writing into the profile a moment.
    await new Promise((r) => setTimeout(r, 500));
    rmSync(config, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
});

test('--open-browser says why a browser didn\'t start', async () => {
  const config = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-launch-'));
  try {
    const r = spawnSync(process.execPath, [CLI, '--open-browser', '--browser', String(await freePort())], {
      encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: config, SM_DEV_BROWSER_BINARY: '/no/such/chrome' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toMatch(/^Could not launch chrome at 127\.0\.0\.1:\d+: It could not be started from \/no\/such\/chrome: spawn \/no\/such\/chrome ENOENT$/);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('--browser-type takes a known type, and only for a browser sm-dev launches', () => {
  const cli = (...args: string[]): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  expect(cli('--browser-type', 'firefox', 'start', 'about:blank', '--detach')).toEqual({ code: 2, out: 'ERROR: The --browser-type flag takes `chrome` or `chromium`, not `firefox`' });
  expect(cli('--existing-browser', '--browser-type', 'chrome', 'tabs').out).toBe('ERROR: The --browser-type flag only applies when sm-dev launches the browser, so not with --existing-browser');
  expect(cli('--browser-type', 'chrome', 'tabs').out).toBe('ERROR: The --browser-type flag only applies to a run that `start` begins, and no `start` command was given');
});

test('--open-browser --browser-type picks the browser, its profile, and checks one already running', async () => {
  test.setTimeout(60_000);
  const config = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-launch-'));
  const env = {
    ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(config, 'cache'),
    // Playwright looks for its Chromium under the cache directory otherwise.
    PLAYWRIGHT_BROWSERS_PATH: path.resolve(chromium.executablePath(), '../../..'),
    // It wins over this, so a binary that can't start shows if it doesn't.
    SM_DEV_BROWSER_BINARY: '/no/such/chrome', SM_DEV_BROWSER_ARGS: '--headless=new',
  };
  const cli = (...args: string[]): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  const port = await freePort();
  const at = `127.0.0.1:${port}`;
  const profile = path.join(config, 'sm-dev', `browser-profile-chromium-${port}`);
  try {
    // A profile from before names had the browser in them isn't this one's
    // when Chrome is installed, since Chrome would have written it.
    const old = path.join(config, 'sm-dev', `browser-profile-${port}`);
    mkdirSync(old, { recursive: true });
    expect(cli('--open-browser', '--browser', String(port), '--browser-type', 'chromium')).toEqual({ code: 0, out: `[sm-dev] Launched Chromium at ${at} (profile ${profile})` });
    expect(existsSync(old)).toBe(CHROME_INSTALLED);
    expect(cli('--open-browser', '--browser', String(port), '--browser-type', 'chromium')).toEqual({ code: 0, out: `[sm-dev] A browser is already running at ${at}` });
    expect(cli('--open-browser', '--browser', String(port), '--browser-type', 'chrome')).toEqual({
      code: 1,
      out: `The browser at ${at} is Chromium, not Google Chrome. Close it, or use another --browser port to start one.`,
    });
    // With no type asked for, it's used as it is.
    expect(cli('--open-browser', '--browser', String(port))).toEqual({ code: 0, out: `[sm-dev] A browser is already running at ${at}` });
  } finally {
    try {
      process.kill(Number(readlinkSync(path.join(profile, 'SingletonLock')).split('-').at(-1)));
    } catch {
      // Never started, or gone.
    }
    await new Promise((r) => setTimeout(r, 500));
    rmSync(config, { recursive: true, force: true });
  }
});

// A temp Google Chrome's own temp directory, with what the runs write
// elsewhere. Short, since Chrome's temp files go in the profile only
// when their path fits a socket's.
function tempChromeSetup(): { temp: string; env: NodeJS.ProcessEnv; cli: (...args: string[]) => { code: number | null; out: string }; cleanUp(): void } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-launch-'));
  const temp = mkdtempSync(path.join(os.tmpdir(), 'smt-'));
  const env = { ...process.env, TMPDIR: temp, SM_DEV_RUNS_DIR: home, SM_DEV_LOGS_DIR: home };
  const cli = (...args: string[]): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  const cleanUp = (): void => {
    for (const dir of [home, temp]) rmSync(dir, { recursive: true, force: true });
  };
  return { temp, env, cli, cleanUp };
}

// Whether a Chrome with its profile in `temp` is running.
function chromeIn(temp: string): boolean {
  return spawnSync('pgrep', ['-f', `user-data-dir=${temp}`]).status === 0;
}

test('--temp-browser --browser-type chrome is a throwaway Google Chrome with the manager', async () => {
  test.skip(!CHROME_INSTALLED, 'Needs Google Chrome');
  test.setTimeout(90_000);
  const { temp, cli, cleanUp } = tempChromeSetup();
  const profiles = (): string[] => readdirSync(temp).filter((f) => f.startsWith('sm-dev-chrome-'));
  const value = (expression: string): string => JSON.parse(cli('--run', 'DChrome', 'eval', '--page', expression).out.split('\n').at(-1)!);
  try {
    const started = cli('--run', 'DChrome', '--browser-type', 'chrome', 'start', 'about:blank', '--detach');
    expect(started.code).toBe(0);
    expect(started.out).toContain('has SourceMonkey');
    expect(profiles()).toHaveLength(1);
    // One tab: no first-run page.
    expect(cli('--run', 'DChrome', 'tabs').out.match(/^\* T\d+:|^ {2}T\d+:/gm)).toHaveLength(1);
    expect(value('navigator.userAgent')).not.toContain('Headless');
    expect(value('`${innerWidth}x${innerHeight}`')).toBe('1280x720');
    expect(cli('--run', 'DChrome', 'stop').code).toBe(0);
    // Nothing left: Chrome's own temp files were in the profile.
    await expect.poll(() => readdirSync(temp)).toEqual([]);
    // A port in use is refused before anything is made.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(cli('--run', 'DChrome', '--browser-type', 'chrome', '--browser', String(port), 'start', 'about:blank', '--detach')).toEqual({
        code: 1,
        out: `Could not launch a browser with SourceMonkey: Port ${port} is already in use. Use \`--existing-browser\` to connect to a browser there, or pick another port.`,
      });
    } finally {
      server.close();
    }
    expect(readdirSync(temp)).toEqual([]);
  } finally {
    cli('--run', 'DChrome', 'stop');
    await new Promise((r) => setTimeout(r, 500));
    cleanUp();
  }
});

test('--temp-browser --browser-type chrome ends its Chrome on a signal during the launch', async () => {
  test.skip(!CHROME_INSTALLED, 'Needs Google Chrome');
  test.skip(process.platform === 'win32', 'Needs pgrep');
  test.setTimeout(60_000);
  const { temp, env, cli, cleanUp } = tempChromeSetup();
  try {
    // Chrome is detached, so it wouldn't end with the run on its own.
    const client = spawn(process.execPath, [CLI, '--run', 'DChromeSig', '--browser-type', 'chrome', 'start', 'about:blank', '--detach'], { env, stdio: 'ignore' });
    const exited = new Promise((resolve) => client.on('exit', resolve));
    // Up, and still being readied: the run hasn't connected yet.
    await expect.poll(() => chromeIn(temp), { timeout: 20_000, intervals: [50] }).toBe(true);
    client.kill('SIGTERM');
    await exited;
    await expect.poll(() => chromeIn(temp)).toBe(false);
    await expect.poll(() => readdirSync(temp)).toEqual([]);
  } finally {
    cli('--run', 'DChromeSig', 'stop');
    await new Promise((r) => setTimeout(r, 500));
    cleanUp();
  }
});

test('--open-browser renames a port\'s old profile, keeping what it holds', async () => {
  test.skip(!CHROME_INSTALLED, 'Needs Google Chrome');
  test.setTimeout(60_000);
  const config = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-launch-'));
  const cache = path.join(config, 'cache');
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, SM_DEV_BROWSER_ARGS: '--headless=new' };
  delete env.SM_DEV_BROWSER_BINARY;
  const port = await freePort();
  const old = path.join(config, 'sm-dev', `browser-profile-${port}`);
  const profile = path.join(config, 'sm-dev', `browser-profile-chrome-${port}`);
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, 'kept'), '');
  mkdirSync(path.join(cache, 'sm-dev', path.basename(old)), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [CLI, '--open-browser', '--browser', String(port)], { encoding: 'utf8', env });
    expect((r.stdout + r.stderr).trim()).toBe(`[sm-dev] Launched Google Chrome at 127.0.0.1:${port} (profile ${profile})`);
    expect(existsSync(path.join(profile, 'kept'))).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(path.join(cache, 'sm-dev', path.basename(profile)))).toBe(true);
  } finally {
    try {
      process.kill(Number(readlinkSync(path.join(profile, 'SingletonLock')).split('-').at(-1)));
    } catch {
      // Never started, or gone.
    }
    await new Promise((r) => setTimeout(r, 500));
    rmSync(config, { recursive: true, force: true });
  }
});
