// `sm-dev start` as a background process, driven from other commands
// the way an agent drives it: `list` finds it, its commands given to
// sm-dev directly (or piped to its stdin) run in it, `stop` ends it. Also
// `start --detach`, and a line of several commands.
//
// The real command line, not `run()` in-process: what's under test is
// the run registry, the control socket and the processes around them.
// The browser is a Chromium with a debugging port, which the run
// connects to.
//
// Each test gets its own runs directory, so its run (D1) never meets a
// real run.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchDebugBrowser, openTab } from '../fixtures/debug-browser.js';
import { test, expect } from '../fixtures/harness.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

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
  /** `cli`, with `input` piped to its stdin. */
  piped: (input: string, ...args: string[]) => Promise<string[]>;
  /** `cli`, with its exit code. */
  cliExit: (...args: string[]) => Promise<{ code: number | null; lines: string[] }>;
  /** `cli`, with stdout and stderr apart, and `input` piped to its stdin if given. */
  cliStreams: (...args: string[]) => Promise<{ code: number | null; stdout: string[]; stderr: string[] }>;
  pipedStreams: (input: string, ...args: string[]) => Promise<{ code: number | null; stdout: string[]; stderr: string[] }>;
  /**
   * `sm-dev start` in the background, its stdin closed, showing what the
   * run prints until it is stopped (`--seconds`, long). `cdp`: the
   * browser to connect to, if not the port. A `--root` among `args` goes
   * first, as the line's.
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
// test's own for runs and logs.
async function setUp(): Promise<Setup> {
  const browser = await launchDebugBrowser();
  const { port, dir } = browser;
  const env = {
    ...process.env,
    SM_DEV_RUNS_DIR: path.join(dir, 'runs'),
    SM_DEV_LOGS_DIR: path.join(dir, 'logs'),
  };
  const runs: ChildProcess[] = [];
  const cliIn = (cwd: string, ...args: string[]): Promise<string[]> => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd, timeout: 30_000 }, (_err, stdout, stderr) => {
      resolve((stdout + stderr).split('\n').filter(Boolean));
    });
  });
  const cliExit = (...args: string[]): Promise<{ code: number | null; lines: string[] }> => new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (_err, stdout, stderr) => {
      resolve({ code: child.exitCode, lines: (stdout + stderr).split('\n').filter(Boolean) });
    });
  });
  const pipedStreams = (input: string | undefined, ...args: string[]): Promise<{ code: number | null; stdout: string[]; stderr: string[] }> => new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (_err, stdout, stderr) => {
      resolve({ code: child.exitCode, stdout: stdout.split('\n').filter(Boolean), stderr: stderr.split('\n').filter(Boolean) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
  const cliStreams = (...args: string[]) => pipedStreams(undefined, ...args);
  const piped = (input: string, ...args: string[]): Promise<string[]> => new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (_err, stdout, stderr) => {
      resolve((stdout + stderr).split('\n').filter(Boolean));
    });
    child.stdin?.end(input);
  });
  return {
    env,
    port,
    cli: (...args) => cliIn(process.cwd(), ...args),
    cliIn,
    piped,
    cliExit,
    cliStreams,
    pipedStreams: (input, ...args) => pipedStreams(input, ...args),
    startRun: (args, cdp = String(port)) => {
      const at = args.indexOf('--root');
      const root = at >= 0 ? args.splice(at, 2) : [];
      const proc = spawn(process.execPath, [CLI, ...root, 'start', '--browser', cdp, '--seconds', '600', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // Runs first, then the browser, which removes the directories.
    cleanup: async () => {
      for (const proc of runs) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
        await within(exited(proc), 10_000);
      }
      await browser.close();
    },
  };
}

// Opens a tab the run doesn't control, straight through the browser's
// endpoint, and leaves it showing an alert.
async function openForeignDialogTab(port: number, url: string): Promise<void> {
  const id = await openTab(port, url);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${id}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Could not reach the new tab'));
  });
  let nextId = 1;
  let dialogOpened: () => void;
  const opened = new Promise<void>((r) => { dialogOpened = r; });
  const replies = new Map<number, (value: unknown) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; method?: string; result?: { result?: { value?: unknown } } };
    if (msg.method === 'Page.javascriptDialogOpening') dialogOpened();
    if (msg.id !== undefined) replies.get(msg.id)?.(msg.result?.result?.value);
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve) => {
    const callId = nextId++;
    replies.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  // Once the tab has its page: `/json/new` returns while it still shows
  // the blank one it starts with, and navigating away from that would
  // drop the timer, so no dialog would ever open.
  await expect.poll(() => send('Runtime.evaluate', { expression: 'location.href + " " + document.readyState' })).toBe(`${url} complete`);
  await send('Page.enable');
  await send('Runtime.evaluate', { expression: 'setTimeout(() => alert("hold"), 100)' });
  await opened;
  ws.close();
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
    expect(list[1]).toMatch(new RegExp(`^D1\\s+\\d+\\s+\\S+\\s+127\\.0\\.0\\.1:${setup.port} \\(headless\\)\\s+1\\s+remote\\.user\\.js$`));
    // Its own process, not this sm-dev's.
    const pid = Number(list[1].split(/\s+/)[1]);
    expect(pid).not.toBe(run.proc.pid);

    expect((await setup.cli('--run', 'D1', 'status'))[0]).toBe(`Run: D1 (pid ${pid}), connected to headless browser 127.0.0.1:${setup.port} (has SourceMonkey)`);
    // The only run, so it needs no id. The command's own output, and
    // what it set off in the page, come back; the page's line can
    // arrive first.
    expect((await setup.cli('menu', 'Say hi')).sort()).toEqual(['[page log] [remote] hi', '[sm-dev] Fired "Say hi"']);
    // The run's own stream, which the sm-dev that started it follows,
    // says what it was sent.
    await run.waitFor(/^remote:arg > menu 'Say hi'$/);
    // A command that only inspects answered the sender alone.
    expect(run.lines.some((l) => /^Run: D1 |^remote:arg > status$/.test(l))).toBe(false);
    // A reload is done once the script has started again and its body
    // has run, so both come back without waiting on anything more.
    const reloaded = await setup.cli('reload');
    expect(reloaded).toContain(`[sm-dev] Remote started on ${fixtureServer.baseUrl}/target.html`);
    expect(reloaded).toContain('[page log] [remote] body ran');
    await run.waitFor(/^remote:arg > reload$/);
    // A load reloads the tab, and the new script's top-level throw comes
    // back with it.
    const thrower = scriptsDir.write({ relativePath: 'thrower.user.js', meta: { name: 'Thrower', match: ['*://*/target.html'] }, body: `throw new Error('boom');` });
    // The throw comes from the extension a moment after the load is done.
    await setup.cli('load', thrower);
    await run.waitFor(/^\[sm-dev\] Thrower threw: boom$/);

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
    expect((await setup.cliIn(elsewhere, 'savehtml', 'sent.html'))[0]).toMatch(/^\[sm-dev\] Wrote sent\.html /);
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
    expect(await setup.cli('eval T1 document.title')).toEqual(['"target"']);
    // Commands piped in, with none on the line or after the line's
    // own, each headed by the command.
    expect(await setup.piped('eval 1+1\neval {{\n2+2\n}}\n')).toEqual(['stdin > eval 1+1', '2', 'stdin > eval {{', '... 2+2', '... }}', '4']);
    expect(await setup.piped('eval 3\n', '--stdin', 'eval', 'T1', '0')).toEqual(['0', 'stdin > eval 3', '3']);

    // match and validate take the run's scripts and tabs, and a miss
    // is the exit code only when it comes last.
    // T2, the tab newtab picked, which runs no scripts but matches.
    expect(await setup.cliExit('match')).toEqual({ code: 0, lines: [`match    ${url} (T2)`, '    Matched by:  @match *://*/target.html'] });
    expect(await setup.cliExit('match', '3', 'T2')).toEqual({ code: 1, lines: [`no match ${url} (T2)`, '    No @match or @include covers this URL'] });
    const goesOn = await setup.cliExit('match', '3', '--', 'eval', '1+1');
    expect(goesOn.code).toBe(0);
    expect(goesOn.lines.slice(-2)).toEqual(['arg > eval 1+1', '2']);
    const all = await setup.cliExit('validate', 'all');
    expect(all.code).toBe(0);
    expect(all.lines.at(-1)).toBe('3 ok, 0 invalid');
    // The run's roots are its own.
    expect((await setup.cliExit('--root', scriptsDir.path, 'match')).code).toBe(2);
    // A file that isn't there makes an invalid command, which stops the line.
    const typo = await setup.cliExit('match', 'nosuch.user.js', '--', 'eval', '1+1');
    expect(typo.code).toBe(2);
    expect(typo.lines).not.toContain('arg > eval 1+1');
    // A loaded script by its name.
    expect((await setup.cliExit('match', 'More', 'T1')).lines[0]).toMatch(/^no match \S+ \(T1\)$/);

    expect(await setup.cli('stop', 'D1')).toEqual([
      '[sm-dev] Stopping run D1',
      '[sm-dev] Run D1 ended',
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
      setup.cli('--root', scriptsDir.path, 'start', '--browser', String(setup.port), '--detach', file, url, ...more);
    // Back once the script has started, with its startup output.
    const first = await detach();
    expect(first).toContain(`[sm-dev] Detached started on ${url}`);
    expect(first).toContain('[page log] [detached] body ran');
    expect(first.at(-2)).toBe('[sm-dev] Run D1 now running detached, with idle timeout 30 minutes');
    const log = first.at(-1)!.match(/^\[sm-dev\] Output log: (\S+\.log) \(D1\.log\)$/)![1];
    expect(path.basename(log)).toMatch(/^sm-dev-\d{8}-\d{6}-\d{3}\.log$/);
    // Stamped in the file, though not as printed.
    // First, the browser it's using.
    expect(readFileSync(log, 'utf8')).toMatch(new RegExp(`^\\d{8}-\\d{6}-\\d{3} \\[sm-dev\\] Connected to headless browser 127\\.0\\.0\\.1:${setup.port} \\(Chrome [\\d.]+, has SourceMonkey\\)\\n\\d{8}-\\d{6}-\\d{3} \\[sm-dev\\] Started as run D1\\. `));
    expect(first[0]).toMatch(/^\[sm-dev\] Connected to headless browser /);
    expect(first[1]).toMatch(/^\[sm-dev\] Started as run D1\. /);
    // Found by the run's id too.
    expect(readlinkSync(path.join(path.dirname(log), 'D1.log'))).toBe(path.basename(log));
    expect(await setup.cli('eval', 'document.title')).toEqual(['"target"']);

    // With --new, another beside it. Three seconds with nothing sent,
    // and that one ends.
    const beside = await detach('--new', '--idle-seconds', '3');
    expect(beside.at(-2)).toBe('[sm-dev] Run D2 now running detached, with idle timeout 3 seconds');
    const ids = async (): Promise<string[]> => (await setup.cli('list')).map((l) => l.split(/\s+/)[0]);
    expect(await ids()).toEqual(['Run', 'D1', 'D2']);
    // Two going, so a command has to name one.
    const several = await setup.cli('status');
    expect(several.slice(0, 2)).toEqual(['ERROR: Several runs are active. Pick one with --run, or attach to one:', expect.stringMatching(/^Run\s+PID/)]);
    await expect.poll(ids, { timeout: 15_000 }).toEqual(['Run', 'D1']);

    // Without it, the next one stops the earlier one, and takes its id.
    const next = await detach();
    expect(next.slice(0, 3)).toEqual([
      '[sm-dev] Stopping the earlier detached run D1',
      '[sm-dev] Stopping run D1',
      '[sm-dev] Run D1 ended',
    ]);
    // Kept after the run ends.
    expect(readFileSync(log, 'utf8')).toMatch(/ \[sm-dev\] Run D1 ended\n/);
    expect(next.at(-2)).toMatch(/^\[sm-dev\] Run D1 now running detached/);
    // The id's link moved on to the new run's log.
    const nextLog = next.at(-1)!.match(/^\[sm-dev\] Output log: (\S+\.log) \(D1\.log\)$/)![1];
    expect(nextLog).not.toBe(log);
    expect(readlinkSync(path.join(path.dirname(log), 'D1.log'))).toBe(path.basename(nextLog));
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
    const start = ['--root', scriptsDir.path, 'start', '--browser', String(setup.port), file, url];
    // Not detached: stopped once the commands are done.
    const out = await setup.cli(...start, '--', 'eval', 'document.title', '--', 'status');
    expect(out).toContain('arg > eval document.title');
    expect(out[out.indexOf('arg > eval document.title') + 1]).toBe('"target"');
    expect(out.some((l) => l.startsWith('Run: D1 (pid '))).toBe(true);
    // The same log, and its link, as the last line names.
    const logLine = out.find((l) => l.startsWith('Log: '));
    expect(logLine).toBeDefined();
    expect(out.at(-1)).toBe(`[sm-dev] Output log: ${logLine!.slice('Log: '.length)}`);
    expect(out.slice(-3, -1)).toEqual(['[sm-dev] Stopping run D1', '[sm-dev] Run D1 ended']);
    expect(out.at(-1)).toMatch(/^\[sm-dev\] Output log: \S+ \(D1\.log\)$/);
    expect(await setup.cli('list')).toEqual(['No sm-dev runs are active']);
    // The same with the commands from stdin.
    const piped = await setup.piped('eval document.title\n', '--stdin', ...start);
    expect(piped[piped.indexOf('stdin > eval document.title') + 1]).toBe('"target"');
    expect(piped.slice(-3, -1)).toEqual(['[sm-dev] Stopping run D1', '[sm-dev] Run D1 ended']);
    expect(await setup.cli('list')).toEqual(['No sm-dev runs are active']);

    // A wait that gives up stops the line, and the run is still stopped.
    const stopped = await setup.cli(...start, '--', 'wait', 'selector-gone', 'body', '--timeout-seconds', '0.3', '--', 'eval', '"not run"');
    expect(stopped).toContain('[sm-dev] Wait failed: The selector body still matched on T1 after 0.3s');
    expect(stopped).not.toContain('"not run"');
    expect(stopped).toContain('[sm-dev] Stopping run D1');
    expect(await setup.cli('list')).toEqual(['No sm-dev runs are active']);

    // Detached, with an ID of its own: left running, and a later start
    // with that ID takes it over.
    const kept = await setup.cli('--run', 'Dmain', ...start, '--detach', '--', 'eval', 'location.pathname');
    expect(kept.at(-1)).toBe('"/target.html"');
    // Named by a line of only --run, stdin's commands reach it.
    expect(await setup.piped('eval 1+1\n', '--run', 'Dmain')).toEqual(['stdin > eval 1+1', '2']);
    expect((await setup.cli('list'))[1]).toMatch(/^Dmain\s/);
    const again = await setup.cli('--run', 'Dmain', ...start, '--detach');
    expect(again.slice(0, 2)).toEqual(['[sm-dev] Stopping run Dmain', '[sm-dev] Run Dmain ended']);
    expect(again.at(-2)).toMatch(/^\[sm-dev\] Run Dmain now running detached/);
    // The old way of naming a run is pointed at the new one.
    expect(await setup.cli('Dmain', 'status')).toEqual(['ERROR: Name the run with --run, before the command: sm-dev --run Dmain status']);
  } finally {
    await setup.cli('stop', '--all');
    await setup.cleanup();
  }
});

test('a reused tab drops the last run\'s scripts; nodes print as tags; own refs decode; wait log sees unstreamed lines', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const url = `${fixtureServer.baseUrl}/target.html`;
    const ticker = scriptsDir.write({
      relativePath: 'ticker.user.js',
      meta: { name: 'Ticker', match: ['*://*/target.html'] },
      body: `setInterval(() => console.log('[ticker] tick'), 10);`,
    });
    const first = await setup.cli('--root', scriptsDir.path, 'start', '--browser', String(setup.port), ticker, url, '--', 'wait', 'log', 'tick');
    expect(first).toContain('[page log] [ticker] tick');
    expect(first).toContain('[sm-dev] Run D1 ended');

    const nodes = scriptsDir.write({
      // A `%20` in the file name itself.
      relativePath: 'my%20nodes.user.js',
      meta: { name: 'Nodes', match: ['*://*/target.html'] },
      body: `console.debug(document.getElementById('target'));
        console.warn('[nodes] at', document.body, 2);
        (function boom() { throw new Error('boom'); })();`,
    });
    const second = await setup.cli(
      '--root', scriptsDir.path, 'start', '--browser', String(setup.port), nodes, url,
      // Logged from the page, with no `[name]`, so the stream leaves it out.
      '--', 'eval', 'setTimeout(() => console.log("KEYUP", 143), 100)',
      '--', 'wait', 'log', 'KEYUP',
    );
    // Named, and after the line naming the browser.
    const reusing = second.findIndex((l) => l.startsWith('[sm-dev] Reusing the selected tab ('));
    expect(second[reusing]).toMatch(/^\[sm-dev\] Reusing the selected tab \(http:.*target\.html\), which run D1 opened\. That run has ended\.$/);
    expect(second.findIndex((l) => l.startsWith('[sm-dev] Connected to'))).toBeLessThan(reusing);
    expect(second.filter((l) => l.includes('[ticker]'))).toEqual([]);
    expect(second).toContain('[page debug] <main id="target">');
    expect(second).toContain('[page warning] [nodes] at <body> 2');
    expect(second).toContain('[sm-dev] Wait matched log line: [page log] KEYUP 143');
    // Under the extension's name for it, which keeps a URL path's safe
    // characters only.
    expect(second.some((l) => l.includes('at boom (sourcemonkey://SourceMonkey/my-20nodes/my-20nodes.user.js:')), second.join('\n')).toBe(true);
  } finally {
    await setup.cli('stop', '--all');
    await setup.cleanup();
  }
});

test('a run logs its stream and the commands that change something', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({
      relativePath: 'logged.user.js',
      meta: { name: 'Logged', match: ['*://*/target.html'] },
      body: `console.log('[logged] body ran');`,
    });
    // Commands piped in, as typed ones are logged. Not spawnSync, which
    // would hold up the fixture server in this process.
    const proc = spawn(process.execPath, [CLI, '--stdin', '--root', scriptsDir.path, 'start', '--browser', String(setup.port), file, `${fixtureServer.baseUrl}/target.html`], {
      env: setup.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stdin!.end('status\neval {{\n1 + 1\n}}\nexit\n');
    await exited(proc);
    const log = stdout.match(/^\[sm-dev\] Output log: (\S+) \(D1\.log\)$/m)![1];
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.replace(/^\d{8}-\d{6}-\d{3} /, ''));
    expect(lines).toContain('[page log] [logged] body ran');
    // A command that changes something, as written, with its reply.
    expect(lines.slice(lines.indexOf('primary:stdin > eval {{'), lines.indexOf('primary:stdin > eval {{') + 4)).toEqual(['primary:stdin > eval {{', '... 1 + 1', '... }}', '2']);
    // exit is this sm-dev's, and never reaches the run.
    expect(lines).not.toContain('primary:stdin > exit');
    expect(lines).toContain('primary:arg > stop');
    // One that only looks, and its reply, aren't in it.
    expect(lines).not.toContain('primary:stdin > status');
    expect(lines.some((l) => l.startsWith('Run: D1'))).toBe(false);
    expect(readlinkSync(path.join(path.dirname(log), 'D1.log'))).toBe(path.basename(log));
  } finally {
    await setup.cli('stop', '--all');
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
    expect(await within(exited(given.proc), 5000)).toBe(130);

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
    expect((await setup.cli('--run', 'D1', 'status'))[0]).toMatch(/^Run: D1 /);
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
    // Each call its own id, so a late reply can't answer the next one.
    let nextId = 1;
    const evaluate = (expression: string) => new Promise<unknown>((resolve) => {
      const id = nextId++;
      ws.onmessage = (e) => {
        const reply = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } } };
        if (reply.id === id) resolve(reply.result?.result?.value);
      };
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression } }));
    });
    // Once the tab has its page: a loop set going in the blank one it
    // starts with would end with that document.
    await expect.poll(() => evaluate('location.href')).toBe(busy);
    await evaluate('setTimeout(() => { for (;;); }, 100)');
    ws.close();
    const dialog = `${fixtureServer.baseUrl}/other.html`;
    await openForeignDialogTab(setup.port, dialog);

    // The browser's own connection, as `--browser` also takes it.
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

test('--json prints each result as one line of JSON on stdout, and other log messages on stderr', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  const setup = await setUp();
  try {
    const file = scriptsDir.write({
      relativePath: 'json.user.js',
      meta: { name: 'Json', match: ['*://*/target.html'], grant: ['GM_setValue', 'GM_registerMenuCommand'] },
      body: `GM_setValue('units', 'metric'); GM_registerMenuCommand('Say hi', () => {}); console.log('[json] ran');`,
    });
    const url = `${fixtureServer.baseUrl}/target.html`;
    const started = await setup.cli('--root', scriptsDir.path, 'start', '--browser', String(setup.port), file, url, '--detach');
    expect(started.at(-2)).toMatch(/now running detached/);

    const { code, stdout, stderr } = await setup.cliStreams(
      '--json', 'status', '--', 'tabs', '--', 'scripts', '--', 'values', '--', 'get', 'units', '--', 'menu',
      '--', 'match', '--', 'probe', 'body', 'h1', '--', 'logs', '--', 'tabs', '--nojson',
    );
    expect(code).toBe(0);
    // The last command's --nojson: text, after a JSON line per command.
    const textAt = stdout.indexOf('Tabs:');
    expect(textAt).toBeGreaterThan(0);
    expect(stdout[textAt + 1]).toContain(`* T1: ${url}`);
    const results = stdout.slice(0, textAt).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(results.map((r) => r.command)).toEqual(['status', 'tabs', 'scripts', 'values', 'get', 'menu', 'match', 'probe', 'logs']);
    expect(stderr).toContain('arg > status');
    const [status, tabs, scripts, values, get, menu, match, probe, logs] = results;
    expect(status).toMatchObject({
      run: { id: 'D1', browser: { owned: false }, sourceMonkey: 'installed' },
      tab: 'T1',
      scripts: [{ id: '1', kind: 'run', name: 'Json', status: 'ok', values: 1, menuCommands: 1, errors: 0, tabs: [{ tab: 'T1', state: 'running' }] }],
    });
    expect(tabs).toEqual({ command: 'tabs', tabs: [expect.objectContaining({ id: 'T1', url, selected: true, scripts: ['1'] })] });
    expect(scripts).toMatchObject({ tab: 'T1', scripts: [{ id: '1', selected: true }] });
    expect(values).toEqual({ command: 'values', scripts: [{ script: '1', name: 'Json', values: { units: 'metric' } }] });
    // A tab named: the scripts running there, and which tab that was.
    expect(JSON.parse((await setup.cliStreams('values', 'T1', '--json')).stdout[0])).toEqual({ command: 'values', tab: 'T1', scripts: [{ script: '1', name: 'Json', values: { units: 'metric' } }] });
    expect(get).toEqual({ command: 'get', script: '1', key: 'units', found: true, value: 'metric' });
    expect(menu).toEqual({ command: 'menu', tabs: [{ tab: 'T1', url, commands: [{ id: 'M1', script: '1', name: 'Say hi' }] }] });
    // An empty detail list is left out.
    expect(match).toEqual({ command: 'match', results: [{ script: '1', name: 'Json', valid: true, pages: [{ url, matches: true, matchedBy: ['@match *://*/target.html'] }] }] });
    expect(probe).toEqual({ command: 'probe', tab: 'T1', url, selectors: [{ selector: 'body', count: 1 }, { selector: 'h1', count: 0 }] });
    expect(logs).toMatchObject({ tab: 'T1', pages: [{ url, lines: expect.arrayContaining(['[log] [json] ran']) }] });

    // Commands from stdin are echoed to stderr, a block's lines too.
    const piped = await setup.pipedStreams('tabs\nset note {{\n"x"\n}}\nget units --json=multi\n', '--json', '--stdin');
    expect(piped.stderr).toEqual(expect.arrayContaining(['stdin > tabs', 'stdin > set note {{', '... "x"', '... }}']));
    expect(piped.stdout[0]).toMatch(/^\{"command":"tabs",/);
    // Its own layout wins over the pipe's one line.
    expect(piped.stdout.slice(-7)).toEqual(['{', '  "command": "get",', '  "script": "1",', '  "key": "units",', '  "found": true,', '  "value": "metric"', '}']);

    // A failure is its text on stderr, in place of a result.
    const failed = await setup.cliStreams('values', '9', '--json');
    expect(failed).toEqual({ code: 1, stdout: [], stderr: ['[sm-dev] There is no script 9. Use scripts to list them.'] });
    // So is a mistake caught before anything runs.
    const mistaken = await setup.cliStreams('--json', 'validate', 'nope.user.js');
    expect(mistaken).toEqual({ code: 2, stdout: [], stderr: ['ERROR: No such file or directory: nope.user.js'] });

    const list = await setup.cliStreams('list', '--json');
    expect(JSON.parse(list.stdout[0])).toMatchObject({ command: 'list', runs: [{ id: 'D1', tabCount: 1, scriptFiles: [file] }] });
  } finally {
    await setup.cli('stop', '--all');
    await setup.cleanup();
  }
});
