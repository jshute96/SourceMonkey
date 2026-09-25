// `sm-dev run` as a background process, driven from other commands the
// way an agent drives it: `list` finds it, `send` runs commands in it,
// `stop` ends it. And with `--devtools`, its tabs' DevTools page ids,
// which the `chrome-devtools` command then reaches.
//
// The real command line, not `run()` in-process: what's under test is
// the run registry, the control socket and the processes around them.
// The browser is a Chromium with a debugging port, since `--devtools`
// needs one to attach to.
//
// Each test gets its own runs directory and runtime directory, so its
// run (D1) never meets a real run, or a real run's DevTools server,
// which is named by the run's id.

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

// As the run starts it: no usage statistics or update checks.
const DEVTOOLS_ENV = { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' };

const devtoolsInstalled = spawnSync('chrome-devtools', ['--version'], { env: { ...process.env, ...DEVTOOLS_ENV } }).status === 0;

interface Run {
  proc: ChildProcess;
  lines: string[];
  /** Resolves once a line matching `pattern` has appeared. */
  waitFor: (pattern: RegExp) => Promise<string>;
}

interface Setup {
  env: NodeJS.ProcessEnv;
  port: number;
  /**
   * Runs an `sm-dev` command to the end, and returns its output lines.
   * Not `spawnSync`: while it blocks, a run that exits can't be reaped,
   * and `stop` would see its pid as alive.
   */
  cli: (...args: string[]) => Promise<string[]>;
  /** Runs a `chrome-devtools` command in the run's session, for its output. */
  devtools: (...args: string[]) => Promise<string>;
  /** `sm-dev run` in the background, its stdin closed, as an agent starts it. */
  startRun: (args: string[]) => Run;
  cleanup: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function exited(proc: ChildProcess): Promise<number | null> {
  return proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve(proc.exitCode)
    : new Promise((r) => proc.once('exit', (code) => r(code)));
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([work, new Promise<undefined>((r) => setTimeout(r, ms))]);
}

// A headless Chromium with a debugging port, and directories of the
// test's own for runs and DevTools servers.
async function setUp(): Promise<Setup> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-remote-'));
  const port = await freePort();
  // In a process group of its own, so its helper processes can be
  // stopped with it.
  const browser = spawn(chromium.executablePath(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`The test browser's debugging port ${port} didn't answer within 10 seconds`);
  const env = {
    ...process.env,
    ...DEVTOOLS_ENV,
    SM_DEV_RUNS_DIR: path.join(dir, 'runs'),
    XDG_RUNTIME_DIR: path.join(dir, 'runtime'),
  };
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const runs: ChildProcess[] = [];
  const devtools = (...args: string[]): Promise<string> => new Promise((resolve) => {
    execFile('chrome-devtools', ['--sessionId=D1', ...args], { env, timeout: 30_000 }, (_err, stdout) => resolve(stdout));
  });
  return {
    env,
    port,
    devtools,
    cli: (...args) => new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (_err, stdout, stderr) => {
        resolve((stdout + stderr).split('\n').filter(Boolean));
      });
    }),
    startRun: (args) => {
      const proc = spawn(process.execPath, [CLI, 'run', '--cdp', String(port), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      runs.push(proc);
      const lines: string[] = [];
      const waiters = new Set<() => void>();
      let partial = '';
      const onData = (chunk: Buffer): void => {
        const parts = (partial + chunk.toString('utf8')).split('\n');
        partial = parts.pop()!;
        lines.push(...parts);
        for (const wake of waiters) wake();
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      const waitFor = (pattern: RegExp): Promise<string> => new Promise((resolve, reject) => {
        const check = (): void => {
          const hit = lines.find((l) => pattern.test(l));
          if (!hit) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`No line matched ${pattern} within 20 seconds. The run printed:\n${lines.join('\n')}`));
        }, 20_000);
        waiters.add(check);
        check();
      });
      return { proc, lines, waitFor };
    },
    // Runs first, so each stops its DevTools server while its files are
    // still there; then any server a failed test left; then the browser
    // and every helper process it started; then the directories.
    cleanup: async () => {
      for (const proc of runs) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
        await within(exited(proc), 10_000);
      }
      if (devtoolsInstalled) await devtools('stop');
      const gone = new Promise((r) => browser.once('exit', r));
      try {
        process.kill(-browser.pid!, 'SIGKILL');
      } catch {
        // Gone already.
      }
      await within(gone, 5000);
      for (let i = 0; i < 20 && existsSync(dir); i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (existsSync(dir)) throw new Error(`The test's directory ${dir} could not be removed`);
    },
  };
}

test('a background run is listed, takes sent commands, and stops', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({
      relativePath: 'remote.user.js',
      meta: { name: 'Remote', match: ['*://*/target.html'], grant: ['GM_registerMenuCommand'] },
      body: `GM_registerMenuCommand('Say hi', () => console.log('[remote] hi'));`,
    });
    const run = setup.startRun([file, '--url', `${fixtureServer.baseUrl}/target.html`, '--root', scriptsDir.path]);
    await run.waitFor(/^\[sm-dev\] Started as run D1: /);
    await run.waitFor(/^\[sm-dev\] Remote started on /);

    const list = await setup.cli('list');
    expect(list[0]).toMatch(/^Run\s+PID\s+Uptime\s+Browser\s+Tabs\s+Scripts$/);
    expect(list[1]).toMatch(new RegExp(`^D1\\s+${run.proc.pid}\\s+\\S+\\s+127\\.0\\.0\\.1:${setup.port}\\s+1\\s+remote\\.user\\.js$`));

    expect((await setup.cli('send', 'D1', 'status'))[0]).toBe(`Run: D1 (pid ${run.proc.pid})`);
    // The only run, so it needs no id. The command's own output, and
    // what it set off in the page, come back; the page's line can
    // arrive first.
    expect((await setup.cli('send', 'menu', 'Say hi')).sort()).toEqual(['[page log] [remote] hi', '[sm-dev] Fired "Say hi"']);
    // The run's own stream says what it was sent.
    await run.waitFor(/^\[sm-dev\] Sent by sm-dev send: menu Say hi$/);

    expect(await setup.cli('stop', 'D1')).toEqual([
      '[sm-dev] Stopping run D1',
      '[sm-dev] Run D1 ended. Pages still have previously loaded scripts.',
    ]);
    expect(await exited(run.proc)).toBe(0);
    expect(await setup.cli('list')).toEqual(['No sm-dev runs are active']);
  } finally {
    await setup.cleanup();
  }
});

test('--devtools reports each tab\'s page id, which chrome-devtools reaches', async ({ fixtureServer, scriptsDir }) => {
  test.skip(!devtoolsInstalled, 'The chrome-devtools command is not installed');
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({
      relativePath: 'devtools.user.js',
      meta: { name: 'DevTools', match: ['*://*/target.html'] },
      body: `console.log('[devtools] on ' + document.title);`,
    });
    const url = `${fixtureServer.baseUrl}/target.html`;
    const run = setup.startRun([file, '--url', url, '--root', scriptsDir.path, '--devtools']);
    await run.waitFor(/^\[sm-dev\] DevTools: chrome-devtools --sessionId=D1 /);
    const first = (await run.waitFor(/^\[sm-dev\] T1 is DevTools page \d+$/)).match(/(\d+)$/)![1];
    // The run's own server, not one a tool call would start on its own
    // (with a browser of its own) if the run's had gone.
    expect(await setup.devtools('status')).toContain('is running');

    // A second tab on the same URL: the one case only the marker can
    // tell apart.
    await setup.cli('send', 'D1', 'tabs', 'new', url);
    const second = (await run.waitFor(/^\[sm-dev\] T2 is DevTools page \d+$/)).match(/(\d+)$/)![1];
    expect(second).not.toBe(first);

    // The id names the run's tab in DevTools' own numbering.
    expect(await setup.devtools('take_snapshot', first)).toContain('RootWebArea "target"');
    // The run lists both ids with the tab, and takes either back,
    // or both as shown.
    const t1 = (await setup.cli('send', 'D1', 'tabs')).find((l) => /^[* ] T1: /.test(l))!;
    const ids = t1.match(/(\[targetId=[0-9A-F]+ pageId=\d+\])$/)![1];
    expect(ids).toContain(`pageId=${first}]`);
    expect(await setup.cli('send', 'D1', 'tabs', `pageId=${first}`)).toEqual([`[sm-dev] The page commands now act on T1 (${url})`]);
    expect(await setup.cli('send', 'D1', 'tabs', `pageId=${second}`)).toEqual([`[sm-dev] The page commands now act on T2 (${url})`]);
    expect(await setup.cli('send', 'D1', 'tabs', ids)).toEqual([`[sm-dev] The page commands now act on T1 (${url})`]);
    // The marker the lookup used is gone again.
    expect(await setup.devtools('evaluate_script', '() => Symbol.for("sm-dev") in window', '--pageId', first)).toContain('false');

    await setup.cli('stop', 'D1');
    expect(await exited(run.proc)).toBe(0);
    // The run's DevTools server went with it.
    expect(await setup.devtools('status')).toContain('not running');
  } finally {
    await setup.cleanup();
  }
});
