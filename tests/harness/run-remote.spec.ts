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
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchDebugBrowser, openTab } from '../fixtures/debug-browser.js';
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
  /** `cli`, run from `cwd`. */
  cliIn: (cwd: string, ...args: string[]) => Promise<string[]>;
  /** Runs a `chrome-devtools` command in the run's session, for its output. */
  devtools: (...args: string[]) => Promise<string>;
  /** `sm-dev run` in the background, its stdin closed, as an agent starts it. */
  startRun: (args: string[]) => Run;
  cleanup: () => Promise<void>;
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
  const browser = await launchDebugBrowser();
  const { port, dir } = browser;
  const env = {
    ...process.env,
    ...DEVTOOLS_ENV,
    SM_DEV_RUNS_DIR: path.join(dir, 'runs'),
    XDG_RUNTIME_DIR: path.join(dir, 'runtime'),
  };
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const runs: ChildProcess[] = [];
  const cliIn = (cwd: string, ...args: string[]): Promise<string[]> => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd, timeout: 30_000 }, (_err, stdout, stderr) => {
      resolve((stdout + stderr).split('\n').filter(Boolean));
    });
  });
  const devtools = (...args: string[]): Promise<string> => new Promise((resolve) => {
    execFile('chrome-devtools', ['--sessionId=D1', ...args], { env, timeout: 30_000 }, (_err, stdout) => resolve(stdout));
  });
  return {
    env,
    port,
    devtools,
    cli: (...args) => cliIn(process.cwd(), ...args),
    cliIn,
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
    // still there; then any server a failed test left; then the browser,
    // which removes the directories.
    cleanup: async () => {
      for (const proc of runs) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
        await within(exited(proc), 10_000);
      }
      if (devtoolsInstalled) await devtools('stop');
      await browser.close();
    },
  };
}

// Opens a tab the run doesn't control, straight through the browser's
// endpoint, and leaves it showing an alert.
async function openForeignDialogTab(port: number, url: string): Promise<void> {
  const id = await openTab(port, url);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${id}`);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'setTimeout(() => alert("hold"), 100)' } }));
    ws.onmessage = () => {
      ws.close();
      resolve();
    };
    ws.onerror = () => reject(new Error('Could not reach the new tab'));
  });
  await new Promise((r) => setTimeout(r, 300));
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
    // Everything the page logged so far, not only the lines streamed,
    // after the page load it came from.
    const logs = await setup.cli('send', 'logs');
    expect(logs).toContain('[log] [remote] hi');
    expect(logs.indexOf(`--- ${fixtureServer.baseUrl}/target.html`)).toBeLessThan(logs.indexOf('[log] [remote] hi'));
    expect(logs.indexOf(`--- ${fixtureServer.baseUrl}/target.html`)).toBeGreaterThanOrEqual(0);

    // Files a sent command names are the sender's, from its directory.
    const elsewhere = scriptsDir.path;
    expect((await setup.cliIn(elsewhere, 'send', 'savehtml', 'sent.html'))[0]).toMatch(/^\[sm-dev\] Wrote sent\.html /);
    expect(existsSync(path.join(elsewhere, 'sent.html'))).toBe(true);
    scriptsDir.write({ relativePath: 'more.user.js', meta: { name: 'More', match: ['*://*/nowhere.html'] }, body: '' });
    expect(await setup.cliIn(elsewhere, 'send', 'load', 'more.user.js')).toContain(`[sm-dev] Loaded ${path.join(elsewhere, 'more.user.js')} as script 2`);

    // A tab of the same page without the script, beside the scripted
    // one: no script started there, so it registered no menu command.
    const url = `${fixtureServer.baseUrl}/target.html`;
    await setup.cli('send', 'newtab', '--noscript', url);
    expect((await setup.cli('send', 'tabs')).some((l) => l.startsWith(`* T2: ${url} (no scripts)`))).toBe(true);
    expect(await setup.cli('send', 'menu', 'T2')).toEqual(['[sm-dev] No menu commands are registered on T2. T1 has some; type menu T1 to list them.']);
    // An expression with spaces and quotes arrives as the shell gave it,
    // and so does a whole command sent as one word.
    expect(await setup.cli('send', 'eval', 'T2', 'document.title + " " + location.pathname')).toEqual(['"target /target.html"']);
    expect(await setup.cli('send', 'eval T1 document.title')).toEqual(['"target"']);

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
    await setup.cli('send', 'D1', 'newtab', url);
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
    // A tab that isn't the run's, stopped on a dialog: DevTools sees
    // only the run's tabs, so it neither lists this one nor waits on it.
    await openForeignDialogTab(setup.port, `${fixtureServer.baseUrl}/other.html`);
    const started = Date.now();
    const pages = await setup.devtools('list_pages', '--output-format=json');
    expect(Date.now() - started).toBeLessThan(5000);
    expect((JSON.parse(pages) as { pages: { id: number }[] }).pages.map((p) => String(p.id)).sort()).toEqual([first, second].sort());

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
