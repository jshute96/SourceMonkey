// `sm-dev start` as a background process, driven from other commands
// the way an agent drives it: `list` finds it, its commands given to
// sm-dev directly (or through `send`) run in it, `stop` ends it. Also
// `start --detach`, and a line of several commands. And with
// `--devtools`, its tabs' DevTools page ids, which the
// `chrome-devtools` command then reaches.
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
import { existsSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
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
  /**
   * `sm-dev start` in the background, its stdin closed, as an agent starts
   * it. `cdp`: the browser to connect to, if not the port.
   */
  startRun: (args: string[], cdp?: string) => Run;
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
    SM_DEV_LOGS_DIR: path.join(dir, 'logs'),
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
    startRun: (args, cdp = String(port)) => {
      const proc = spawn(process.execPath, [CLI, 'start', '--cdp', cdp, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      // In the page's world, where a menu handler runs a task after the
      // push that fires it.
      meta: { name: 'Remote', match: ['*://*/target.html'], grant: ['GM_registerMenuCommand'], injectInto: 'page' },
      body: `console.log('[remote] body ran');\nGM_registerMenuCommand('Say hi', () => console.log('[remote] hi'));`,
    });
    const run = setup.startRun([file, `${fixtureServer.baseUrl}/target.html`, '--root', scriptsDir.path]);
    await run.waitFor(/^\[sm-dev\] Started as run D1\. /);
    await run.waitFor(/^\[sm-dev\] Remote started on /);

    const list = await setup.cli('list');
    expect(list[0]).toMatch(/^Run\s+PID\s+Uptime\s+Browser\s+Tabs\s+Scripts$/);
    expect(list[1]).toMatch(new RegExp(`^D1\\s+${run.proc.pid}\\s+\\S+\\s+127\\.0\\.0\\.1:${setup.port}\\s+1\\s+remote\\.user\\.js$`));

    expect((await setup.cli('status', '--run', 'D1'))[0]).toBe(`Run: D1 (pid ${run.proc.pid})`);
    // The only run, so it needs no id. The command's own output, and
    // what it set off in the page, come back; the page's line can
    // arrive first.
    expect((await setup.cli('send', 'menu', 'Say hi')).sort()).toEqual(['[page log] [remote] hi', '[sm-dev] Fired "Say hi"']);
    // The run's own stream says what it was sent.
    await run.waitFor(/^\[sm-dev\] Sent from another shell: menu Say hi$/);
    // A command that only inspects answered the sender alone.
    expect(run.lines.some((l) => /^Run: D1 |^\[sm-dev\] Sent from another shell: status$/.test(l))).toBe(false);
    // A reload is done once the script has started again and its body
    // has run, so both come back without waiting on anything more.
    const reloaded = await setup.cli('reload');
    expect(reloaded).toContain(`[sm-dev] Remote started on ${fixtureServer.baseUrl}/target.html`);
    expect(reloaded).toContain('[page log] [remote] body ran');
    await run.waitFor(/^\[sm-dev\] Sent from another shell: reload$/);
    // A load reloads the tab, and the new script's top-level throw comes
    // back with it.
    const thrower = scriptsDir.write({ relativePath: 'thrower.user.js', meta: { name: 'Thrower', match: ['*://*/target.html'] }, body: `throw new Error('boom');` });
    expect(await setup.cli('load', thrower)).toContain('[sm-dev] Thrower threw: boom');

    // A hash change loads no new document, so nothing waits on scripts.
    const started = Date.now();
    expect(await setup.cli('open', `${fixtureServer.baseUrl}/target.html#part`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
    // Everything the page logged so far, not only the lines streamed,
    // after the page load it came from.
    const logs = await setup.cli('logs');
    expect(logs).toContain('[log] [remote] hi');
    expect(logs.indexOf(`--- ${fixtureServer.baseUrl}/target.html`)).toBeLessThan(logs.indexOf('[log] [remote] hi'));
    expect(logs.indexOf(`--- ${fixtureServer.baseUrl}/target.html`)).toBeGreaterThanOrEqual(0);

    // Files a sent command names are the sender's, from its directory.
    const elsewhere = scriptsDir.path;
    expect((await setup.cliIn(elsewhere, 'send', 'savehtml', 'sent.html'))[0]).toMatch(/^\[sm-dev\] Wrote sent\.html /);
    expect(existsSync(path.join(elsewhere, 'sent.html'))).toBe(true);
    scriptsDir.write({ relativePath: 'more.user.js', meta: { name: 'More', match: ['*://*/nowhere.html'] }, body: '' });
    expect(await setup.cliIn(elsewhere, 'load', 'more.user.js')).toContain(`[sm-dev] Loaded ${path.join(elsewhere, 'more.user.js')} as script 3`);

    // A tab of the same page without the script, beside the scripted
    // one: no script started there, so it registered no menu command.
    const url = `${fixtureServer.baseUrl}/target.html`;
    await setup.cli('newtab', '--noscript', url);
    expect((await setup.cli('tabs')).some((l) => l.startsWith(`* T2: ${url} (no scripts)`))).toBe(true);
    expect(await setup.cli('menu', 'T2')).toEqual(['[sm-dev] No menu commands are registered on T2. T1 has some; type menu T1 to list them.']);
    // An expression with spaces and quotes arrives as the shell gave it,
    // and so does a whole command sent as one word.
    expect(await setup.cli('eval', 'T2', 'document.title + " " + location.pathname')).toEqual(['"target /target.html"']);
    expect(await setup.cli('send', 'eval T1 document.title')).toEqual(['"target"']);

    expect(await setup.cli('stop', '--run', 'D1')).toEqual([
      '[sm-dev] Stopping run D1',
      '[sm-dev] Run D1 ended. Pages still have previously loaded scripts.',
    ]);
    // Not 0: Thrower threw.
    expect(await exited(run.proc)).toBe(1);
    expect(await setup.cli('list')).toEqual(['No sm-dev runs are active']);
  } finally {
    await setup.cleanup();
  }
});

test('start --detach returns once started, is replaced by the next unless --new, and stops when idle', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({
      relativePath: 'detached.user.js',
      meta: { name: 'Detached', match: ['*://*/target.html'] },
      body: `console.log('[detached] body ran');`,
    });
    const url = `${fixtureServer.baseUrl}/target.html`;
    const detach = (...more: string[]): Promise<string[]> =>
      setup.cli('start', '--cdp', String(setup.port), '--detach', file, url, '--root', scriptsDir.path, ...more);
    // Back once the script has started, with its startup output.
    const first = await detach();
    expect(first).toContain(`[sm-dev] Detached started on ${url}`);
    expect(first).toContain('[page log] [detached] body ran');
    expect(first.at(-2)).toBe('[sm-dev] Run D1 now running detached, with idle timeout 30 minutes');
    const log = first.at(-1)!.match(/^\[sm-dev\] Output log: (\S+\.log)$/)![1];
    expect(path.basename(log)).toMatch(/^sm-dev-\d{8}-\d{6}-\d{3}\.log$/);
    // Stamped in the file, though not as printed.
    expect(readFileSync(log, 'utf8')).toMatch(/^\d{8}-\d{6}-\d{3} \[sm-dev\] Started as run D1\. /);
    expect(first[0]).toMatch(/^\[sm-dev\] Started as run D1\. /);
    // Found by the run's id too.
    expect(readlinkSync(path.join(path.dirname(log), 'sm-dev-D1.log'))).toBe(path.basename(log));
    expect(await setup.cli('eval', 'document.title')).toEqual(['"target"']);

    // With --new, another beside it. Three seconds with nothing sent,
    // and that one ends.
    const beside = await detach('--new', '--idle-seconds', '3');
    expect(beside.at(-2)).toBe('[sm-dev] Run D2 now running detached, with idle timeout 3 seconds');
    const ids = async (): Promise<string[]> => (await setup.cli('list')).map((l) => l.split(/\s+/)[0]);
    expect(await ids()).toEqual(['Run', 'D1', 'D2']);
    // Two going, so a command has to name one.
    const several = await setup.cli('status');
    expect(several.slice(0, 2)).toEqual(['Several runs are active. Pick one with --run:', expect.stringMatching(/^Run\s+PID/)]);
    await expect.poll(ids, { timeout: 15_000 }).toEqual(['Run', 'D1']);

    // Without it, the next one stops the earlier one, and takes its id.
    const next = await detach();
    expect(next.slice(0, 3)).toEqual([
      '[sm-dev] Stopping the earlier detached run D1',
      '[sm-dev] Stopping run D1',
      '[sm-dev] Run D1 ended. Pages still have previously loaded scripts.',
    ]);
    // Kept after the run ends.
    expect(readFileSync(log, 'utf8')).toMatch(/ \[sm-dev\] Run D1 ended\. /);
    expect(next.at(-2)).toMatch(/^\[sm-dev\] Run D1 now running detached/);
    // The id's link moved on to the new run's log.
    const nextLog = next.at(-1)!.match(/^\[sm-dev\] Output log: (\S+\.log)$/)![1];
    expect(nextLog).not.toBe(log);
    expect(readlinkSync(path.join(path.dirname(log), 'sm-dev-D1.log'))).toBe(path.basename(nextLog));
    expect(await ids()).toEqual(['Run', 'D1']);
  } finally {
    await setup.cli('stop', '--all');
    await setup.cleanup();
  }
});

test('one line starts a run, sends it commands, and stops it unless detached', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({
      relativePath: 'line.user.js',
      meta: { name: 'Line', match: ['*://*/target.html'] },
      body: `console.log('[line] body ran');`,
    });
    const url = `${fixtureServer.baseUrl}/target.html`;
    const start = ['start', '--cdp', String(setup.port), file, url, '--root', scriptsDir.path];
    // Not detached: stopped once the commands are done.
    const out = await setup.cli(...start, '--', 'eval', 'document.title', '--', 'status');
    expect(out).toContain('> eval document.title');
    expect(out[out.indexOf('> eval document.title') + 1]).toBe('"target"');
    expect(out.some((l) => l.startsWith('Run: D1 (pid '))).toBe(true);
    expect(out.slice(-3, -1)).toEqual(['[sm-dev] Stopping run D1', '[sm-dev] Run D1 ended. Pages still have previously loaded scripts.']);
    expect(out.at(-1)).toMatch(/^\[sm-dev\] Output log: /);
    expect(await setup.cli('list')).toEqual(['No sm-dev runs are active']);

    // Detached, with an ID of its own: left running, and a later start
    // with that ID takes it over.
    const kept = await setup.cli(...start, '--detach', '--run', 'Dmain', '--', 'eval', 'location.pathname');
    expect(kept.at(-1)).toBe('"/target.html"');
    expect((await setup.cli('list'))[1]).toMatch(/^Dmain\s/);
    const again = await setup.cli(...start, '--detach', '--run', 'Dmain');
    expect(again.slice(0, 2)).toEqual(['[sm-dev] Stopping run Dmain', '[sm-dev] Run Dmain ended. Pages still have previously loaded scripts.']);
    expect(again.at(-2)).toMatch(/^\[sm-dev\] Run Dmain now running detached/);
    // The old way of naming a run is pointed at the new one.
    expect(await setup.cli('send', 'Dmain', 'status')).toEqual(['Name the run with --run: sm-dev send status --run Dmain']);
  } finally {
    await setup.cli('stop', '--all');
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
    const run = setup.startRun([file, url, '--root', scriptsDir.path, '--devtools']);
    await run.waitFor(/^\[sm-dev\] DevTools: chrome-devtools --sessionId=D1 /);
    const first = (await run.waitFor(/^\[sm-dev\] T1 is DevTools page \d+$/)).match(/(\d+)$/)![1];
    // The run's own server, not one a tool call would start on its own
    // (with a browser of its own) if the run's had gone.
    expect(await setup.devtools('status')).toContain('is running');

    // A second tab on the same URL: the one case only the marker can
    // tell apart.
    await setup.cli('newtab', url, '--run', 'D1');
    const second = (await run.waitFor(/^\[sm-dev\] T2 is DevTools page \d+$/)).match(/(\d+)$/)![1];
    expect(second).not.toBe(first);

    // The id names the run's tab in DevTools' own numbering.
    expect(await setup.devtools('take_snapshot', first)).toContain('RootWebArea "target"');
    // The run lists both ids with the tab, and takes either back,
    // or both as shown.
    const t1 = (await setup.cli('tabs', '--run', 'D1')).find((l) => /^[* ] T1: /.test(l))!;
    const ids = t1.match(/(\[targetId=[0-9A-F]+ pageId=\d+\])$/)![1];
    expect(ids).toContain(`pageId=${first}]`);
    expect(await setup.cli('tabs', `pageId=${first}`, '--run', 'D1')).toEqual([`[sm-dev] The page commands now act on T1 (${url})`]);
    expect(await setup.cli('tabs', `pageId=${second}`, '--run', 'D1')).toEqual([`[sm-dev] The page commands now act on T2 (${url})`]);
    expect(await setup.cli('tabs', ids, '--run', 'D1')).toEqual([`[sm-dev] The page commands now act on T1 (${url})`]);
    // A tab that isn't the run's, stopped on a dialog: DevTools sees
    // only the run's tabs, so it neither lists this one nor waits on it.
    await openForeignDialogTab(setup.port, `${fixtureServer.baseUrl}/other.html`);
    const started = Date.now();
    const pages = await setup.devtools('list_pages', '--output-format=json');
    expect(Date.now() - started).toBeLessThan(5000);
    expect((JSON.parse(pages) as { pages: { id: number }[] }).pages.map((p) => String(p.id)).sort()).toEqual([first, second].sort());

    // The marker the lookup used is gone again.
    expect(await setup.devtools('evaluate_script', '() => Symbol.for("sm-dev") in window', '--pageId', first)).toContain('false');

    await setup.cli('stop', '--run', 'D1');
    expect(await exited(run.proc)).toBe(0);
    // The run's DevTools server went with it.
    expect(await setup.devtools('status')).toContain('not running');
  } finally {
    await setup.cleanup();
  }
});

test('a tab stopped on a dialog is named, and waited for, before the run connects', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({ relativePath: 'wait.user.js', meta: { name: 'Wait', match: ['*://*/target.html'] }, body: '' });
    const stuckUrl = `${fixtureServer.baseUrl}/other.html`;
    await openForeignDialogTab(setup.port, stuckUrl);
    const args = [file, `${fixtureServer.baseUrl}/target.html`, '--root', scriptsDir.path];

    // Ctrl-C (or a kill) while it waits ends it at once: there's
    // nothing to clean up yet.
    const given = setup.startRun(args);
    await given.waitFor(/^A tab is not responding, so sm-dev can't connect to the browser over CDP:$/);
    // Its title, then its address.
    expect(await given.waitFor(/^  \S/)).toMatch(new RegExp(`^  (\\S+  )?${stuckUrl.replace(/[.?]/g, '\\$&')}$`));
    given.proc.kill('SIGTERM');
    await within(exited(given.proc), 1000);
    expect(given.proc.signalCode).toBe('SIGTERM');

    // Once the tab is gone, the run connects.
    const run = setup.startRun(args);
    await run.waitFor(/^It may have a dialog open, or a busy page\. Answer the dialog or close the tab to continue \(Ctrl-C to abort\)\.$/);
    const tabs = await (await fetch(`http://127.0.0.1:${setup.port}/json`)).json() as { id: string; url: string }[];
    await fetch(`http://127.0.0.1:${setup.port}/json/close/${tabs.find((t) => t.url === stuckUrl)!.id}`, { method: 'PUT' });
    await run.waitFor(/^Every tab is responding now\. Connecting\.$/);
    await run.waitFor(/^\[sm-dev\] Wait started on /);

    // A dialog in a tab of the person's is left for them: not dismissed
    // (confirm would return false), and the run doesn't fall over.
    const id = await openTab(setup.port, `${fixtureServer.baseUrl}/other.html`);
    const ws = new WebSocket(`ws://127.0.0.1:${setup.port}/devtools/page/${id}`);
    await new Promise((resolve) => { ws.onopen = resolve; });
    const answered = new Promise<boolean>((resolve) => { ws.onmessage = () => resolve(true); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'confirm("keep?")' } }));
    expect(await within(answered, 2000)).toBeUndefined();
    ws.close();
    expect(run.proc.exitCode).toBeNull();
    expect((await setup.cli('status', '--run', 'D1'))[0]).toMatch(/^Run: D1 /);
  } finally {
    await setup.cleanup();
  }
});

test('several stuck tabs, a dialog and a busy page, are all named, over a ws:// endpoint too', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({ relativePath: 'wait.user.js', meta: { name: 'Wait', match: ['*://*/target.html'] }, body: '' });
    // Headless Chrome holds up only the front tab on a dialog, so the
    // other is a page stuck in a loop. about:blank keeps that loop in a
    // process of its own, clear of the fixture server's pages.
    const busy = 'about:blank?busy';
    const busyId = await openTab(setup.port, busy);
    const ws = new WebSocket(`ws://127.0.0.1:${setup.port}/devtools/page/${busyId}`);
    await new Promise((resolve) => { ws.onopen = resolve; });
    await new Promise((resolve) => {
      ws.onmessage = resolve;
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'setTimeout(() => { for (;;); }, 100)' } }));
    });
    ws.close();
    const dialog = `${fixtureServer.baseUrl}/other.html`;
    await openForeignDialogTab(setup.port, dialog);

    // The browser's own connection, as `--cdp` also takes it.
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${setup.port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const run = setup.startRun([file, `${fixtureServer.baseUrl}/target.html`, '--root', scriptsDir.path], webSocketDebuggerUrl);
    await run.waitFor(/^Some tabs are not responding, so sm-dev can't connect to the browser over CDP:$/);
    await run.waitFor(/^They may have a dialog open, or a busy page\. Answer the dialogs or close the tabs to continue \(Ctrl-C to abort\)\.$/);
    const named = run.lines.filter((l) => l.startsWith('  '));
    expect(named).toHaveLength(2);
    for (const url of [busy, dialog]) expect(named.some((l) => l.endsWith(url))).toBe(true);

    // Only once both are gone does it connect.
    const tabs = await (await fetch(`http://127.0.0.1:${setup.port}/json`)).json() as { id: string; url: string }[];
    const close = (url: string) => fetch(`http://127.0.0.1:${setup.port}/json/close/${tabs.find((t) => t.url === url)!.id}`, { method: 'PUT' });
    await close(busy);
    await new Promise((r) => setTimeout(r, 3000));
    expect(run.lines).not.toContain('Every tab is responding now. Connecting.');
    await close(dialog);
    await run.waitFor(/^Every tab is responding now\. Connecting\.$/);
    await run.waitFor(/^\[sm-dev\] Wait started on /);
  } finally {
    await setup.cleanup();
  }
});
