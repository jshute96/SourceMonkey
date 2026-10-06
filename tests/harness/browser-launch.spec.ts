// `sm-dev --open-browser` (browser-launch.ts): a browser that stays up after
// sm-dev ends, started once however often it's asked for, with a
// profile per port. Playwright's Chromium, headless, stands in for
// Chrome, and a temp directory for ~/.config.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { test, expect } from '../fixtures/harness.js';
import { extensionArgs, prepareProfile } from '../../lib/harness/extension-launch.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

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
      out: `The profile ${profile} is in use by the browser on port ${port}. Use --browser ${port}, or another --profile`,
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
