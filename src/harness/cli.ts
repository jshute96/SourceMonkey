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

import { CONSOLE_HELP, writeOutputLine } from './console-commands.js';
import { NO_RULE_COVERS_URL, explainMatch, prepareScript, withDefaultScheme } from './prepare.js';

// A mistake in how the command was typed, as opposed to a failure while
// carrying it out: the one kind that exits 2.
class UsageError extends Error {}

const USAGE = `sm-dev: develop and test userscripts against a real browser,
with SourceMonkey's own injection and GM_* APIs behind them.

Usage: sm-dev <command> [options]

Commands:
  run <script>...             Inject the script(s) into a page and stream
                              their console lines, reports and GM_* calls.
                              Type commands while it runs: see
                              "Interactive commands"
  validate <path>...          Run the install-time checks (header,
                              @require, syntax) over files or directories
  match <script> [url]...     Say whether the script would run on each
                              URL (and --url's), and which header rule
                              decided
  probe <url>                 Say which --selectors resolve on the page
  snapshot <url>              Save the page's HTML DOM to --out FILE
  clear --extension           Remove every script in the extension's
                              Scratch collection and turn solo mode off

Options for every command:
  --root DIR      The repo root, searched for local copies of @require
                  URLs (default: the current directory)
  --local DIR     Another directory to search; repeatable

Options for the browser commands (run, probe, snapshot, clear):
  --cdp URL       Browser to connect to (default: $SM_DEV_CDP or
                  http://127.0.0.1:9233)
  --launch        Launch a Chromium instead of connecting to one
  --headed        With --launch: show the browser

A URL with no scheme gets http://, and a path becomes a file:// URL.

Options for run:
  --url URL       The page to open (default: the first page the script's
                  @match implies). Also checked by match, so one command
                  line serves both
  --watch         Re-inject and reload when a script or its files change
  --values JSON   Seed GM_* storage before the script runs, e.g.
                  --values '{"units":"metric"}'
  --fire-menu S   Fire the registered menu command named S once the page
                  has loaded, as if picked from the toolbar menu
  --seconds N     Stop after N seconds instead of waiting for Ctrl-C
  --page-errors   Also show the page's own errors, not just the script's
  --extension     Push the script into the SourceMonkey extension in
                  that browser instead of injecting it; reports then
                  come from the script's own Log tab
  --solo          With --extension: disable every other collection for
                  the run and restore them after

Interactive commands (type these while \`run\` is streaming):
${CONSOLE_HELP.map((line) => `  ${line}`).join('\n')}

Options for probe:
  --selectors S   Comma-separated CSS selectors to look for; repeat the
                  flag for a selector that itself contains a comma
  --html          Also print the first match's HTML

Options for snapshot:
  --out FILE      Where to write the HTML
`;

interface Opts {
  command: string | null;
  args: string[];
  root: string;
  local: string[];
  url?: string;
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
    launch: false, headed: false, watch: false, extension: false, solo: false, pageErrors: false,
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
  if (info.isDirectory()) throw new UsageError(`${input} is a directory. Name a .user.js file.`);
  return path.resolve(input);
}

function statInput(input: string): ReturnType<typeof stat> {
  return stat(path.resolve(input)).catch(() => {
    throw new UsageError(`No such file or directory: ${input}`);
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
  if (opts.args.length === 0) throw new UsageError('The run command needs at least one script');
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
    // Also drops the Ctrl-C handler, so while a stopped run tears down,
    // a Ctrl-C kills it rather than landing here again. That matters
    // when a typed-command prompt did the stopping: its Ctrl-C (or
    // quit) never reached this handler.
    stop = () => {
      if (onSigint) process.off('SIGINT', onSigint);
      resolve();
    };
    onSigint = () => resolve();
    process.once('SIGINT', onSigint);
    if (opts.seconds !== undefined) timer = setTimeout(resolve, opts.seconds * 1000).unref();
  });
  try {
    return await run({
      files,
      url: opts.url,
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
    if (onSigint) process.off('SIGINT', onSigint);
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

async function main(): Promise<void> {
  let opts: Opts;
  try {
    opts = parseArgs(process.argv.slice(2));
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
