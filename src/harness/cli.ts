#!/usr/bin/env node
// `sm-dev`: argument parsing and dispatch for the development
// harness's command line. The usage text below describes each command,
// and describes it once; this file is the plumbing around it.
//
// Each command's work lives elsewhere:
//   - `validate` and `match` call prepare.ts, here in this file.
//   - `run` hands off to run.ts, which also opens the browser every
//     browser command uses.
//   - `probe` and `snapshot` hand off to browser-commands.ts.
//   - `list`, `send` and `stop` reach running runs through runs.ts.
//   - `--extension` and `clear` go through extension-backend.ts, which
//     drives a real SourceMonkey rather than the harness.
//
// Each command loads only the modules it needs. `validate` and `match`
// never import Playwright, so they run in a repo that has not
// installed it.
//
// Exit codes: 0 when every script checked out (or every URL matched,
// no script threw, every selector was found), 1 when one didn't or the
// command failed, 2 for a usage error (a `UsageError`).

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { writeOutputLine } from './console-commands.js';
import { NO_RULE_COVERS_URL, explainMatch, isDirectoryMessage, noSuchFileMessage, prepareScript, withDefaultScheme } from './prepare.js';

// A mistake in how the command was typed, as opposed to a failure while
// carrying it out: the one kind that exits 2.
class UsageError extends Error {}

const USAGE = `sm-dev: develop and test userscripts against a real browser,
with SourceMonkey's own injection and GM_* APIs behind them.

Usage: sm-dev <command> [options]

Commands:
  run <script>...             Inject the script(s) into a page and stream
                              their console lines, reports and GM_* calls
                              (no scripts with --noscript)
  validate <path>...          Run the install-time checks (header,
                              @require, syntax) over files or directories
  match <script> [url]...     Say whether the script would run on each
                              URL (and --url's), and which header rule
                              decided
  probe <url>                 Say which --selectors resolve on the page
  snapshot <url>              Save the page's HTML DOM to --out FILE
  clear --extension           Remove every script in the extension's
                              Scratch collection and turn solo mode off
  list                        List sm-dev runs active on this machine
  send [run] <command>        Run a command in another sm-dev run
                              Run IDs are D1, D2
  stop [run]... | --all       End one or more runs, or all

Options for every command:
  --root DIR      The repo root, searched for local copies of @require
                  URLs (default: the current directory)
  --local DIR     Another directory to search; repeatable

Options for the browser commands (run, probe, snapshot, clear):
  --cdp URL|PORT  Browser to connect to: a URL, host:port, or just a
                  port on this machine (default: $SM_DEV_CDP or 9233)
  --launch        Launch a Chromium instead of connecting to one
  --headed        With --launch: show the browser

A URL with no scheme gets http://, and a path becomes a file:// URL.

Options for run:
  --url URL       The page to open (default: the first page the script's
                  @match implies). Also checked by match, so one command
                  line serves both
  --all           Open each script's default page, one tab per page,
                  instead of only the first script's
  --noscript      Start with no scripts, as a browser to drive with the
                  typed commands (a blank page unless --url names one)
  --notab         Open no tab at startup; type tabs new to open one.
                  With --extension, the pages you browse to run them
  --watch         Re-inject and reload when a script or its files change
  --values JSON   Seed GM_* storage before the script runs, e.g.
                  --values '{"units":"metric"}'
  --fire-menu S   Fire the registered menu command named S once the page
                  has loaded, as if picked from the toolbar menu
  --seconds N     Stop after N seconds instead of waiting for Ctrl-C,
                  quit or sm-dev stop
  --page-errors   Also show the page's own errors, not just the script's
  --extension     Push the script into the SourceMonkey extension in
                  that browser instead of injecting it; reports then
                  come from the script's own Log tab
  --solo          With --extension: disable every other collection for
                  the run and restore them after

Options for probe:
  --selectors S   Comma-separated CSS selectors to look for; repeat the
                  flag for a selector that itself contains a comma
  --html          Also print the first match's HTML

Options for snapshot:
  --out FILE      Where to write the HTML

While run streams, it also acts as an interactive shell, with commands to
control the scripts. Type help at the prompt to see interactive commands.
Each run prints its id, for sm-dev send and sm-dev stop to reach it by.
`;

interface Opts {
  command: string | null;
  args: string[];
  root: string;
  local: string[];
  url?: string;
  all: boolean;
  noScript: boolean;
  noTab: boolean;
  cdp?: string;
  launch: boolean;
  headed: boolean;
  watch: boolean;
  values?: Record<string, unknown>;
  fireMenu?: string;
  extension: boolean;
  solo: boolean;
  pageErrors: boolean;
  seconds?: number;
  selectors: string[];
  selectorFlags: number;
  html: boolean;
  outFile?: string;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    command: null, args: [], root: process.cwd(), local: [],
    all: false, noScript: false, noTab: false, launch: false, headed: false, watch: false, extension: false, solo: false, pageErrors: false,
    selectors: [], selectorFlags: 0, html: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`The ${arg} flag needs a value`);
      return v;
    };
    switch (arg) {
      case '--root': opts.root = path.resolve(next()); break;
      case '--local': opts.local.push(path.resolve(next())); break;
      case '--url': opts.url = withDefaultScheme(next()); break;
      case '--all': opts.all = true; break;
      case '--noscript': opts.noScript = true; break;
      case '--notab': opts.noTab = true; break;
      case '--cdp': opts.cdp = next(); break;
      case '--launch': opts.launch = true; break;
      case '--headed': opts.headed = true; break;
      case '--watch': opts.watch = true; break;
      case '--values': {
        const raw = next();
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object');
          opts.values = parsed as Record<string, unknown>;
        } catch {
          throw new UsageError('The --values flag needs a JSON object');
        }
        break;
      }
      case '--fire-menu': opts.fireMenu = next(); break;
      case '--extension': opts.extension = true; break;
      case '--solo': opts.solo = true; break;
      case '--page-errors': opts.pageErrors = true; break;
      case '--selectors': {
        // One flag with commas holds a list. A selector containing a
        // comma (`:is(a, b)`) goes in its own flag, taken whole.
        const raw = next();
        opts.selectorFlags++;
        opts.selectors.push(raw.trim());
        break;
      }
      case '--html': opts.html = true; break;
      case '--out': opts.outFile = path.resolve(next()); break;
      case '--seconds': {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new UsageError('The --seconds flag needs a number');
        opts.seconds = v;
        break;
      }
      case '--help': case '-h': opts.command = 'help'; break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
        if (opts.command === null) opts.command = arg;
        else opts.args.push(arg);
    }
  }
  return opts;
}

async function collectScripts(inputs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const input of inputs) {
    const full = path.resolve(input);
    const info = await statInput(input);
    if (info.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
}

// The script a command was pointed at, checked up front so a typo is
// reported as one rather than as the file system's `ENOENT` text.
async function scriptFile(input: string): Promise<string> {
  const info = await statInput(input);
  if (info.isDirectory()) throw new UsageError(isDirectoryMessage(input));
  return path.resolve(input);
}

function statInput(input: string): ReturnType<typeof stat> {
  return stat(path.resolve(input)).catch(() => {
    throw new UsageError(noSuchFileMessage(input));
  });
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.user.js')) out.push(full);
  }
}

function rel(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

async function validate(opts: Opts): Promise<number> {
  if (opts.args.length === 0) throw new UsageError('The validate command needs at least one path');
  const files = await collectScripts(opts.args);
  if (files.length === 0) throw new UsageError('No *.user.js files found');
  let failed = 0;
  for (const file of files) {
    const prepared = await prepareScript({
      file,
      collectionRoot: opts.root,
      localRoots: opts.local,
    });
    if (prepared.status === 'ok') {
      const notes = prepared.startupLogs.map((l) => `\n    ${l.level}: ${l.message}`).join('');
      process.stdout.write(`ok       ${rel(file)}${notes}\n`);
    } else {
      failed++;
      process.stdout.write(`INVALID  ${rel(file)}\n    ${prepared.diagnostic}\n`);
    }
  }
  process.stdout.write(`\n${files.length - failed} ok, ${failed} invalid\n`);
  return failed === 0 ? 0 : 1;
}

async function match(opts: Opts): Promise<number> {
  const [script, ...typed] = opts.args;
  const urls = [...typed.map(withDefaultScheme), ...(opts.url ? [opts.url] : [])];
  if (!script || urls.length === 0) throw new UsageError('The match command needs a script and at least one URL, or --url');
  const prepared = await prepareScript({
    file: await scriptFile(script),
    collectionRoot: opts.root,
    localRoots: opts.local,
  });
  if (prepared.status !== 'ok') {
    process.stdout.write(`INVALID  ${rel(script)}\n    ${prepared.diagnostic}\n`);
    return 1;
  }
  let misses = 0;
  for (const url of urls) {
    const verdict = explainMatch(prepared.matching, url);
    if (verdict.matches) {
      process.stdout.write(`match    ${url}\n    ${verdict.rule}\n`);
    } else {
      misses++;
      process.stdout.write(`no match ${url}\n    ${verdict.rule ?? NO_RULE_COVERS_URL}\n`);
    }
  }
  return misses === 0 ? 0 : 1;
}

async function runCommand(opts: Opts): Promise<number> {
  if (opts.noScript && opts.args.length > 0) throw new UsageError('The --noscript flag runs no scripts, so the run command takes none with it');
  if (!opts.noScript && opts.args.length === 0) throw new UsageError('The run command needs at least one script, or --noscript');
  if (opts.all && opts.url) throw new UsageError('The --all and --url flags can\'t be used together');
  // Flags that would silently do nothing, or wait out --fire-menu's
  // grace period for a command nothing can register.
  const clash = (flag: string, others: [boolean, string][]): void => {
    const used = others.filter(([on]) => on).map(([, name]) => name);
    if (used.length > 0) throw new UsageError(`The ${flag} flag can't be used with ${used.join(' or ')}`);
  };
  if (opts.noTab) clash('--notab', [[opts.all, '--all'], [Boolean(opts.url), '--url'], [Boolean(opts.fireMenu), '--fire-menu']]);
  if (opts.noScript) {
    clash('--noscript', [
      [opts.all, '--all'], [Boolean(opts.fireMenu), '--fire-menu'], [Boolean(opts.values), '--values'],
      [opts.watch, '--watch'], [opts.extension, '--extension'], [opts.solo, '--solo'],
    ]);
  }
  const files = await Promise.all(opts.args.map(scriptFile));
  const { run } = await import('./run.js');
  // Ends on Ctrl-C, or after --seconds. With neither, the run streams
  // until interrupted, which suits a person watching it. The timer is
  // unreferenced so it can't hold the process open after an early
  // exit, and the listener comes off once the run has ended.
  let onSigint: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stop: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    // Also drops the signal handlers, so while a stopped run tears
    // down, a Ctrl-C kills it rather than landing here again. That matters
    // when a typed-command prompt did the stopping: its Ctrl-C (or
    // quit) never reached this handler.
    stop = () => {
      if (onSigint) {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigint);
      }
      resolve();
    };
    // SIGTERM too, so a plain kill (or sm-dev stop, for a run it
    // can't reach) still ends the run cleanly. Either one drops both
    // handlers, as `quit` does, so a second signal while the run tears
    // down kills it outright.
    onSigint = () => stop();
    onOutputClosed = stop;
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigint);
    if (opts.seconds !== undefined) timer = setTimeout(resolve, opts.seconds * 1000).unref();
  });
  try {
    return await run({
      files,
      url: opts.url,
      all: opts.all,
      noTab: opts.noTab,
      cdp: opts.cdp,
      launch: opts.launch,
      headed: opts.headed,
      watch: opts.watch,
      values: opts.values,
      fireMenu: opts.fireMenu,
      extension: opts.extension,
      solo: opts.solo,
      pageErrors: opts.pageErrors,
      collectionRoot: opts.root,
      localRoots: opts.local,
      // Drawn around the typed-command prompt, when one is showing.
      out: writeOutputLine,
      until,
      onStop: () => stop(),
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onSigint) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
    }
  }
}

async function probeCommand(opts: Opts): Promise<number> {
  const url = opts.args[0] && withDefaultScheme(opts.args[0]);
  if (!url) throw new UsageError('The probe command needs a URL');
  if (opts.selectors.length === 0) throw new UsageError('The probe command needs --selectors');
  const selectors = opts.selectorFlags === 1
    ? opts.selectors[0].split(',').map((x) => x.trim()).filter(Boolean)
    : opts.selectors;
  const { probe } = await import('./browser-commands.js');
  return probe({
    url, selectors, html: opts.html,
    cdp: opts.cdp, launch: opts.launch, headed: opts.headed,
    out: (line) => process.stdout.write(line + '\n'),
  });
}

async function snapshotCommand(opts: Opts): Promise<number> {
  const url = opts.args[0] && withDefaultScheme(opts.args[0]);
  if (!url) throw new UsageError('The snapshot command needs a URL');
  if (!opts.outFile) throw new UsageError('The snapshot command needs --out');
  const { snapshot } = await import('./browser-commands.js');
  return snapshot({
    url, outFile: opts.outFile,
    cdp: opts.cdp, launch: opts.launch, headed: opts.headed,
    out: (line) => process.stdout.write(line + '\n'),
  });
}

async function clearCommand(opts: Opts): Promise<number> {
  if (!opts.extension) throw new UsageError('The clear command needs --extension; the harness itself keeps nothing between runs');
  const { connectBrowser } = await import('./run.js');
  const { ExtensionBackend } = await import('./extension-backend.js');
  const out = (line: string): void => { process.stdout.write(line + '\n'); };
  const session = await connectBrowser(opts, out);
  if (!session) return 1;
  try {
    const backend = await ExtensionBackend.connect(session.context);
    const count = await backend.clear();
    // A run killed before it could turn solo mode off leaves the user's
    // collections disabled. Put them back here, since clearing the
    // scratch scripts is the other half of the same cleanup.
    await backend.solo(false);
    out(`[sm-dev] Removed ${count} scratch script(s)`);
    return 0;
  } catch (err) {
    out(`[sm-dev] ${(err as Error).message}`);
    return 1;
  } finally {
    await session.page.close().catch(() => undefined);
    await session.done();
  }
}

const NO_RUNS = 'No sm-dev runs are active';

// What a closed stdout does: ends the command. A run swaps in its own
// stop, so it still tears down (and says so to any `sm-dev stop`).
let onOutputClosed = (): void => process.exit(process.exitCode ?? 0);

function print(line: string): void {
  process.stdout.write(line + '\n');
}

async function listCommand(opts: Opts): Promise<number> {
  if (opts.args.length > 0) throw new UsageError('The list command takes no arguments');
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (runs.length === 0) print(NO_RUNS);
  else for (const line of runTable(runs)) print(line);
  return 0;
}

// A run named by its id (`D2`), which must be going. A bare number is
// the likely slip, as with tabs, and gets a hint.
function namedRun<T extends { id: string }>(runs: T[], typed: string, runIdOf: (typed: string) => string | null): T {
  const id = runIdOf(typed);
  if (!id) {
    throw new UsageError(/^\d+$/.test(typed)
      ? `Runs are named D1, D2 and so on. Did you mean D${typed}?`
      : `There is no run named ${typed}. Runs are named D1, D2 and so on; type sm-dev list to see them.`);
  }
  const found = runs.find((r) => r.id === id);
  if (!found) throw new Error(`There is no run ${id}. Type sm-dev list to see the runs.`);
  return found;
}

// The run a command meant when it named none: the only one going.
function onlyRun<T extends { id: string }>(runs: T[], usage: string): T {
  if (runs.length === 0) throw new Error(NO_RUNS);
  if (runs.length > 1) throw new UsageError(`Several runs are active (${runs.map((r) => r.id).join(', ')}). Name one: ${usage}`);
  return runs[0];
}

// Takes its arguments as typed, not through parseArgs: the command
// sent may have words of its own that look like flags (`set n -1`).
async function sendCommand(args: string[]): Promise<number> {
  const { liveRuns, runIdOf, sendLine } = await import('./runs.js');
  const runs = await liveRuns();
  // A run id (`D2`) or a bare number first names the run: no command is
  // either.
  const named = args[0] !== undefined && (runIdOf(args[0]) !== null || /^\d+$/.test(args[0]));
  const words = named ? args.slice(1) : args;
  if (words.length === 0) throw new UsageError('The send command needs a command to send, e.g. sm-dev send status');
  const target = named ? namedRun(runs, args[0], runIdOf) : onlyRun(runs, 'sm-dev send <run> <command>');
  await sendLine(target.id, words.join(' '), print);
  return 0;
}

async function stopCommand(opts: Opts): Promise<number> {
  const { liveRuns, runIdOf, stopRun } = await import('./runs.js');
  const runs = await liveRuns();
  let targets;
  if (opts.all) {
    if (opts.args.length > 0) throw new UsageError('The --all flag stops every run, so the stop command takes no run ids with it');
    if (runs.length === 0) {
      print(NO_RUNS);
      return 0;
    }
    targets = runs;
  } else {
    targets = opts.args.length === 0
      ? [onlyRun(runs, 'sm-dev stop <run>, or sm-dev stop --all')]
      : [...new Set(opts.args.map((typed) => namedRun(runs, typed, runIdOf)))];
  }
  // Together, each run's lines tagged with its id when there are
  // several.
  const several = targets.length > 1;
  const stopped = await Promise.all(targets.map((r) => stopRun(r, several ? (line) => print(`[${r.id}] ${line}`) : print)));
  return stopped.every(Boolean) ? 0 : 1;
}

async function main(): Promise<void> {
  // Output piped into something that stops reading early (`| head`)
  // ends the command quietly, as other command-line tools do, rather
  // than with a stack trace.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    // Writes after the first failure fail as a destroyed stream.
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') throw err;
    onOutputClosed();
  });
  const argv = process.argv.slice(2);
  if (argv[0] === 'send' && (argv[1] === '--help' || argv[1] === '-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === 'send') {
    try {
      process.exitCode = await sendCommand(argv.slice(1));
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = err instanceof UsageError ? 2 : 1;
    }
    return;
  }
  let opts: Opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.command === null || opts.command === 'help') {
    process.stdout.write(USAGE);
    process.exitCode = opts.command === 'help' ? 0 : 2;
    return;
  }
  try {
    switch (opts.command) {
      case 'validate': process.exitCode = await validate(opts); break;
      case 'match': process.exitCode = await match(opts); break;
      case 'run': process.exitCode = await runCommand(opts); break;
      case 'probe': process.exitCode = await probeCommand(opts); break;
      case 'snapshot': process.exitCode = await snapshotCommand(opts); break;
      case 'clear': process.exitCode = await clearCommand(opts); break;
      case 'list': process.exitCode = await listCommand(opts); break;
      case 'stop': process.exitCode = await stopCommand(opts); break;
      default:
        process.stderr.write(`Unknown command: ${opts.command}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}

await main();
