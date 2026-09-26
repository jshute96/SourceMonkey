#!/usr/bin/env node
// `sm-dev`: argument parsing and dispatch for the development
// harness's command line. The usage text below describes each command,
// and describes it once; this file is the plumbing around it.
//
// Each command's work lives elsewhere:
//   - `validate` and `match` call prepare.ts, here in this file.
//   - `start` hands off to run.ts, which also opens the browser every
//     browser command uses.
//   - `list`, `stop`, and the commands sent to a run, reach running
//     runs through runs.ts.
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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { CommandAssembler, NONE_RUN, echoCommand, parseCommandList, shellWord, unclosedBlockMessage, type AssembledCommand } from './command-lines.js';
import {
  CONSOLE_HELP, commandFlagMistake, commandWords, consoleCommandsHelp, helpEntries, inCommand, onlyInspects, writeOutputLine,
} from './console-commands.js';
import { devtoolsWanted } from './devtools.js';
// Node built-ins only, so as cheap to load as the rest here.
import { runIdOf, type RunRecord } from './runs.js';
import { withDefaultScheme } from './prepare.js';
import {
  REMOTE_SCRIPT, SCRIPT_ARG, UsageError, matchLines, prepareSource, scriptFile, scriptSources, validateLines, validateSources, validateSummary,
  type ScriptRoots,
} from './checks.js';


const INTRO = `sm-dev: develop and test userscripts against a real browser,
with SourceMonkey's script injection and GM_* APIs behind them.

Usage: sm-dev <command> [options]`;

// Each command's entry, as the full help lists them and `help <command>`
// picks them out: a line starting with the name, and indented lines
// carrying on its description.
const COMMAND_LINES = [
  'start <script>... [url]...  Inject the scripts into each URL, one tab',
  '                            each, and stream what they do (default URL:',
  '                            the first page the first script\'s @match',
  '                            implies)',
  'validate <path>...          Check script validity (header, @require,',
  '                            syntax) over files, directories or script',
  '                            URLs. In a run, also its loaded scripts',
  '                            (validate alone: the selected one)',
  'match <script>... <url>...  Say whether each script would run on each',
  '                            URL, and which header rules matched or',
  '                            excluded it. In a run, also its scripts and',
  '                            tabs (match alone: the selected script on',
  '                            the current tab)',
  'clear --extension           Remove every script in the extension\'s',
  '                            Scratch collection and turn solo mode off',
  'list                        List sm-dev runs active on this machine',
  '<command>                   Any command a run takes (listed below),',
  '                            sent to the run: sm-dev eval document.title.',
  '                            One argument of several lines is several',
  '                            commands, one per line. Or pipe them in',
  '                            (see --stdin)',
  'stop [--all]                End the run, or all runs',
  'help [command]...           List these, or one command\'s help and',
  '                            options (a run\'s typed commands too)',
];

// The flags, grouped as the full help shows them. `commands` are the
// ones a group's flags apply to, for `help <command>`; `only` narrows
// or widens that for one flag.
const OPTION_GROUPS: { title: string; commands: string[]; lines: string[]; only?: Record<string, string[]> }[] = [
  {
    title: 'Options for the whole line (used by start, validate, match)',
    commands: ['start', 'validate', 'match'],
    lines: [
      '--root DIR      The repo root, searched for local copies of @require',
      '                URLs (default: the current directory). A run keeps',
      '                the ones it started with',
      '--local DIR     Another directory to search; repeatable',
    ],
  },
  {
    title: 'Options for the browser commands (start, clear)',
    commands: ['start', 'clear'],
    lines: [
      '--cdp URL|PORT  Browser to connect to: a URL, host:port, or just a',
      '                port on this machine (default: $SM_DEV_CDP or 9233)',
      '--launch        Launch a Chromium instead of connecting to one',
      '--headed        With --launch: show the browser',
    ],
  },
  {
    title: 'Options for the commands that act on a run (its commands, stop, start)',
    commands: ['stop', 'start'],
    only: { '--stdin': ['start'] },
    lines: [
      '--run ID        The run to act on. Needed only when several are active.',
      '                With start: the ID for the new run, which stops a run',
      '                that has it first',
      '--stdin         Anywhere on the line: once its commands are done, read',
      '                more from stdin, one per line, and send them to the run.',
      '                The default when no command is given and stdin is not',
      '                a terminal',
    ],
  },
  {
    title: 'Options for start',
    commands: ['start'],
    lines: [
      '--all           Open each script\'s default page, one tab per page,',
      '                instead of only the first script\'s',
      '--noscript      Start with no scripts, as a browser to drive with the',
      '                typed commands (a blank page unless a URL is given)',
      '--notab         Open no tab at startup; type newtab to open one.',
      '                With --extension, the pages you browse to run them',
      '--watch         Re-inject and reload when a script or its files change',
      '--values JSON   Seed GM_* storage before the script runs, e.g.',
      '                --values \'{"units":"metric"}\'',
      '--seconds N     Stop after N seconds instead of waiting for Ctrl-C,',
      '                quit or sm-dev stop',
      '--detach        Return once the pages have settled (see wait),',
      '                printing their output so far, and leave the',
      '                run going in the background. It replaces any earlier',
      '                detached run, unless --run names one',
      '--new           With --detach: leave earlier detached runs going, and',
      '                start another beside them',
      '--nowait        Don\'t wait for the pages to settle before continuing',
      '                (it still waits for the scripts to start)',
      '--idle-seconds N',
      '                With --detach: stop after N seconds with no command',
      '                sent (default: 1800; 0 never stops)',
      '--page-errors   Also show the page\'s own errors, not just the script\'s',
      '--extension     Push the script into the SourceMonkey extension in',
      '                that browser instead of injecting it; reports then',
      '                come from the script\'s own Log tab',
      '--solo          With --extension: disable every other collection for',
      '                the run and restore them after',
      '--devtools      Also start a Chrome DevTools server for the run, and',
      '                print each tab\'s page id in it, for the chrome-devtools',
      '                command. Default: on when $SM_DEV_DEVTOOLS is 1',
      '--nodevtools    Don\'t, even when $SM_DEV_DEVTOOLS is 1',
    ],
  },
];

// What `sm-dev help <command>` shows in place of the one-line entry,
// for the commands that need more: what the command does, then its
// arguments. The options follow.
const COMMAND_DETAILS: Record<string, { about: string[]; args: string[] }> = {
  start: {
    about: [
      'Starts a run that lasts as long as this command. It keeps a connection to',
      'the browser, injects the scripts into each page it opens, and streams their',
      'console lines, reports and GM_* calls back here.',
      '',
      'It is also an interactive shell: type commands at its prompt to act on the',
      'pages and scripts. Other shells reach it by giving sm-dev those commands',
      'directly (sm-dev status), with --run and its ID when several runs are active.',
      '',
      'With --detach, it returns once the pages have settled (loaded, scripts',
      'started, no requests or DOM changes; see sm-dev help wait), and the run',
      'goes on in the background.',
      '',
      'Commands after it on the line (after --), and from stdin with --stdin, go',
      'to the run. Without --detach, the run is stopped once they are done.',
    ],
    args: [
      '<script>...     The userscripts to inject: the arguments ending in .user.js.',
      '                None with --noscript',
      '[url]...        The pages to open, one tab each: the other arguments.',
      '                Default URL: the first page the first script\'s @match',
      '                implies',
    ],
  },
  match: {
    about: [
      'Says whether each script would run on each URL, listing all header rules',
      'that matched it (Matched by:) or excluded it (Excluded by:).',
    ],
    args: [
      '<script>...     The userscripts to check: the arguments ending in .user.js.',
      '                A script\'s http(s) URL is fetched',
      '<url>...        The URLs to check them against: the other arguments',
    ],
  },
};

const ARGS_NOTE = `Scripts, URLs and options can come in any order. A URL with no scheme gets
http://, and a path becomes a file:// URL.`;

// Notes after the options, and the commands each concerns.
const SHELL_NOTE = {
  commands: ['start'],
  text: `While start streams, it also acts as an interactive shell, with the commands
below. Other shells give sm-dev the same commands directly to reach it.`,
};

const SEQUENCE_NOTE = `Several commands can go on one line, separated by --. They run in order,
stopping at the first that fails. start can only come first. --run carries on
to the commands after it, and start sets it to the run it starts:
  sm-dev start a.user.js example.com --detach -- eval document.title -- key x`;

const indent = (lines: string[]): string => lines.map((line) => (line ? `  ${line}` : '')).join('\n');

// The command lines and options alone: what a usage error prints.
const USAGE = `${INTRO}

Commands:
${indent(COMMAND_LINES)}

${OPTION_GROUPS[0].title}:
${indent(OPTION_GROUPS[0].lines)}

${OPTION_GROUPS[1].title}:
${indent(OPTION_GROUPS[1].lines)}

For start and match, a .user.js argument is a script, and the rest are URLs.
${ARGS_NOTE}

${OPTION_GROUPS.slice(2).map((group) => `${group.title}:\n${indent(group.lines)}`).join('\n\n')}

${SEQUENCE_NOTE}

${SHELL_NOTE.text}
`;

// Above the commands a run takes, in `--help` and `help <command>`.
// The usage's `<command>` entry and `--run` say how to give them.
const RUN_COMMANDS_HEADING = 'Commands for a run:';

// The whole of `--help`: the commands above, then the ones a run takes,
// as its own `help` lists them.
function usage(): string {
  return `${USAGE}
${RUN_COMMANDS_HEADING}
${indent(CONSOLE_HELP)}
`;
}

// Not `<command>`, which stands for the run's.
// After a mistake, in place of the whole help, which would bury it.
const LIST_COMMANDS = 'Type sm-dev --help to list the commands.';

const CLI_COMMANDS = new Set(COMMAND_LINES.filter((line) => !/^[\s<]/.test(line)).map((line) => line.split(' ')[0]));

/**
 * `sm-dev help <command>...`: each command's entry, then the flags and
 * notes that concern it, once each and in the full help's order. A
 * run's typed commands (`status`) get their entry from its `help`, all
 * under one heading. Throws for a name that is neither.
 */
function commandHelp(names: string[]): string {
  const unknown = names.filter((name) => !CLI_COMMANDS.has(name) && !isTypedCommand(name));
  if (unknown.length > 0) throw new UsageError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${unknown.length === 1 ? 'a command' : 'commands'}. Type sm-dev --help to list them.`);
  const unique = [...new Set(names)];
  // sm-dev's own commands in the order the full help lists them, then
  // a run's together under one heading, in its help's order. A name
  // that is both (help) gets both.
  const order = [...CLI_COMMANDS];
  const blocks = unique.filter((name) => CLI_COMMANDS.has(name))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map(cliCommandHelp);
  const typed = unique.filter(isTypedCommand);
  if (typed.length > 0) blocks.push([RUN_COMMANDS_HEADING, '', indent(consoleCommandsHelp(typed).lines)].join('\n'));
  return blocks.join('\n\n') + '\n';
}

// One sm-dev command's usage line, entry, the flags it takes, and notes.
function cliCommandHelp(name: string): string {
  const entry = helpEntries(COMMAND_LINES, name);
  // A flag's lines are an entry too, named by the flag.
  const options = OPTION_GROUPS.flatMap((group) => group.lines
    .filter((line) => !/^\s/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((flag) => (group.only?.[flag] ?? group.commands).includes(name))
    .flatMap((flag) => helpEntries(group.lines, flag)));
  const details = COMMAND_DETAILS[name];
  const lines = [`Usage: sm-dev ${entry[0].split(/\s{2,}/)[0]}${options.length ? ' [options]' : ''}`, ''];
  if (details) {
    lines.push(...details.about, '', 'Arguments:', indent(details.args), '', ARGS_NOTE);
  } else {
    lines.push(indent(entry));
  }
  if (options.length) lines.push('', 'Options:', indent(options));
  // The commands a run takes, typed or sent, have help of their own.
  if (name === 'start') {
    lines.push('', 'Type sm-dev help <command> for a run\'s commands (sm-dev help status), or', 'help at its prompt.');
  }
  return lines.join('\n');
}

interface Opts {
  command: string | null;
  args: string[];
  all: boolean;
  noScript: boolean;
  noTab: boolean;
  cdp?: string;
  launch: boolean;
  headed: boolean;
  watch: boolean;
  values?: Record<string, unknown>;
  extension: boolean;
  solo: boolean;
  pageErrors: boolean;
  /** `--devtools` / `--nodevtools`; unset leaves it to `SM_DEV_DEVTOOLS`. */
  devtools?: boolean;
  seconds?: number;
  detach: boolean;
  /** `start --nowait`: ready once the scripts start, without settling. */
  noWait: boolean;
  /** `--new`: start beside earlier detached runs, not in their place. */
  newRun: boolean;
  /** `--idle-seconds`. */
  idleSeconds?: number;
}

// The longest a Node timer waits: past it, it fires at once instead.
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    command: null, args: [],
    all: false, noScript: false, noTab: false, launch: false, headed: false, watch: false, extension: false, solo: false, pageErrors: false, detach: false, newRun: false, noWait: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`The ${arg} flag needs a value`);
      return v;
    };
    switch (arg) {
      case '--root':
      case '--local':
        throw new UsageError(`The ${arg} flag applies to the whole line, so it goes on the sm-dev command line`);
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
      case '--extension': opts.extension = true; break;
      case '--solo': opts.solo = true; break;
      case '--page-errors': opts.pageErrors = true; break;
      case '--devtools': opts.devtools = true; break;
      case '--nodevtools': opts.devtools = false; break;
      case '--detach': opts.detach = true; break;
      case '--new': opts.newRun = true; break;
      case '--nowait': opts.noWait = true; break;
      case '--idle-seconds': {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new UsageError('The --idle-seconds flag needs a number of seconds');
        if (v > MAX_TIMER_SECONDS) throw new UsageError(`The --idle-seconds flag can be at most ${MAX_TIMER_SECONDS}`);
        opts.idleSeconds = v;
        break;
      }
      case '--seconds': {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new UsageError('The --seconds flag needs a number');
        if (v > MAX_TIMER_SECONDS) throw new UsageError(`The --seconds flag can be at most ${MAX_TIMER_SECONDS}`);
        opts.seconds = v;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
        if (opts.command === null) opts.command = arg;
        else opts.args.push(arg);
    }
  }
  return opts;
}

function checkValidate(opts: Opts): void {
  if (opts.args.length === 0) throw new UsageError(VALIDATE_NEEDS);
}

async function validate(opts: Opts): Promise<number> {
  checkValidate(opts);
  const sources = await validateSources(opts.args);
  let failed = 0;
  for (const source of sources) {
    const { lines, ok } = validateLines(source.label, await prepareSource(source, lineRoots));
    if (!ok) failed++;
    for (const line of lines) print(line);
  }
  print(`\n${validateSummary(sources.length - failed, failed)}`);
  return failed === 0 ? 0 : 1;
}

// `start` and `match` arguments: scripts, and the URLs the rest are.
function scriptsAndUrls(args: string[]): { scripts: string[]; urls: string[] } {
  return {
    // Each once, so a repeat is neither checked nor opened twice.
    scripts: [...new Set(args.filter((a) => SCRIPT_ARG.test(a)))],
    urls: [...new Set(args.filter((a) => !SCRIPT_ARG.test(a)).map((a) => withDefaultScheme(a)))],
  };
}

// Every script against every URL, in the order given. Arguments can
// come in any order: a `.user.js` one is a script, the rest are URLs.
function checkMatch(opts: Opts): void {
  const { scripts, urls } = scriptsAndUrls(opts.args);
  if (scripts.length === 0 || urls.length === 0) {
    throw new UsageError(MATCH_NEEDS);
  }
}

async function match(opts: Opts): Promise<number> {
  checkMatch(opts);
  const { scripts, urls } = scriptsAndUrls(opts.args);
  const sources = await scriptSources(scripts);
  let misses = 0;
  for (const [i, source] of sources.entries()) {
    // Headed only when there are several, so one script reads as before.
    if (sources.length > 1) print(`${i > 0 ? '\n' : ''}${source.label}`);
    const report = matchLines(await prepareSource(source, lineRoots), urls.map((url) => ({ url })), sources.length > 1 ? undefined : source.label);
    misses += report.misses;
    for (const line of report.lines) print(line);
  }
  return misses === 0 ? 0 : 1;
}

/**
 * `start`. With `--detach`, or other commands after it on the line, the
 * run goes on in a background process (`detachRun`), and the commands
 * after it go to that run; otherwise it runs here, as an interactive
 * shell. `words` are the command's own, for that process.
 */
async function startCommand(opts: Opts, words: string[], seq: Sequence, more: boolean): Promise<number> {
  const { urls, files, devtools } = await checkStart(opts);
  // The background process: the run itself.
  if (detachedLog) return runHere(opts, files, urls, devtools, seq.run);
  const { liveRuns, stopRun } = await import('./runs.js');
  const live = await liveRuns();
  // `--run`: the one run it replaces. Otherwise `--detach` replaces the
  // earlier detached runs, unless `--new`. Stopped first, which also
  // frees a tab for this one to reuse.
  const replaced = seq.run !== undefined ? live.filter((r) => r.id === seq.run)
    : opts.detach && !opts.newRun ? live.filter((r) => r.detached) : [];
  for (const old of replaced) {
    // Named by --run, stopRun's own line says enough.
    if (seq.run === undefined) print(`[sm-dev] Stopping the earlier detached run ${old.id}`);
    await stopRun(old, print);
  }
  if (!opts.detach && !more) return runHere(opts, files, urls, devtools, seq.run);
  const started = await detachRun(words.filter((w) => w !== '--detach'), seq.run);
  if (!started.id) return started.code;
  seq.run = started.id;
  seq.own = true;
  if (opts.detach) {
    const idle = opts.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    print(`[sm-dev] Run ${started.id} now running detached, with ${idle > 0 ? `idle timeout ${duration(idle)}` : 'no idle timeout'}`);
    print(`[sm-dev] Output log: ${started.log}`);
  } else {
    seq.started = { id: started.id, log: started.log };
  }
  return 0;
}

// `start`'s arguments and flags, checked: its URLs, and its script
// files, which must exist. Also done before a line of several commands
// runs any.
async function checkStart(opts: Opts): Promise<{ urls: string[]; files: string[]; devtools: boolean }> {
  const { scripts, urls } = scriptsAndUrls(opts.args);
  if (opts.noScript && scripts.length > 0) throw new UsageError('The --noscript flag runs no scripts, so the start command takes none with it');
  if (!opts.noScript && scripts.length === 0) throw new UsageError('The start command needs at least one script (a .user.js file), or --noscript');
  if (opts.all && urls.length > 0) throw new UsageError('The --all flag opens each script\'s own page, so it can\'t be used with a URL');
  const remote = scripts.find((s) => REMOTE_SCRIPT.test(s));
  if (remote) throw new UsageError(`The start command loads scripts from files, and ${remote} is a URL. Save it to a file first.`);
  // Flags that contradict another, or would silently do nothing with it.
  const clash = (flag: string, others: [boolean, string][]): void => {
    const used = others.filter(([on]) => on).map(([, name]) => name);
    if (used.length > 0) throw new UsageError(`The ${flag} flag can't be used with ${used.join(' or ')}`);
  };
  if (opts.noTab) clash('--notab', [[opts.all, '--all'], [urls.length > 0, 'a URL']]);
  if (opts.noScript) {
    clash('--noscript', [
      [opts.all, '--all'], [Boolean(opts.values), '--values'],
      [opts.watch, '--watch'], [opts.extension, '--extension'], [opts.solo, '--solo'],
    ]);
  }
  // Asked for by name, it must be able to run; on by default from the
  // environment, it just sits out the runs it can't serve.
  if (opts.devtools === true) clash('--devtools', [[opts.launch, '--launch'], [opts.extension, '--extension']]);
  if (!opts.detach && !detachedLog) {
    if (opts.idleSeconds !== undefined) throw new UsageError('The --idle-seconds flag only applies with --detach');
    if (opts.newRun) throw new UsageError('The --new flag only applies with --detach');
  }
  const devtools = devtoolsWanted(opts.devtools) && !opts.launch && !opts.extension;
  const files = await Promise.all(scripts.map((s) => scriptFile(s)));
  return { urls, files, devtools };
}

// The run, in this process: until Ctrl-C, `quit`, `sm-dev stop` or
// `--seconds`, or for a background process, its idle timeout.
async function runHere(opts: Opts, files: string[], urls: string[], devtools: boolean, runId: string | undefined): Promise<number> {
  // A background run has no input: commands come from other shells.
  if (detachedLog) process.stdin.destroy();
  const { run } = await import('./run.js');
  // In the foreground, the run's stream is copied to a log too (a
  // background run's output is its log already): what the page and
  // scripts do, and the commands typed at the prompt that change
  // something, with their replies. Not a command that only looks, as a
  // background run leaves those out too.
  const { openRunLog } = await import('./run-log.js');
  const log = detachedLog ? null : await openRunLog().catch((err: Error) => {
    writeOutputLine(`[sm-dev] The run's output is not being logged: ${err.message}`);
    return null;
  });
  const out = log ? (line: string): void => {
    writeOutputLine(line);
    if (!inCommand.getStore()?.inspects) log.write(line);
  } : writeOutputLine;
  if (log) out(`[sm-dev] Output log: ${log.file}`);
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
    // down kills it outright. Set once the run has connected: before
    // that there is nothing to clean up, and a signal ends it at once,
    // as it would any command (a wait for a stuck tab, say).
    onSigint = () => stop();
    onOutputClosed = stop;
    if (opts.seconds !== undefined) timer = setTimeout(resolve, opts.seconds * 1000).unref();
  });
  // A detached run ends itself once nothing has been sent it for a
  // while, so one an agent forgot doesn't hold the browser for good.
  // Counted from the start, and restarted as each command starts and
  // ends, so a slow command isn't cut off.
  const idleSeconds = detachedLog ? opts.idleSeconds ?? DEFAULT_IDLE_SECONDS : 0;
  let idleTimer: NodeJS.Timeout | null = null;
  const touch = (): void => {
    if (idleSeconds <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      writeOutputLine(`[sm-dev] Stopping: no command was sent for ${duration(idleSeconds)}`);
      stop();
    }, idleSeconds * 1000).unref();
  };
  touch();
  try {
    return await run({
      files,
      urls,
      all: opts.all,
      noTab: opts.noTab,
      cdp: opts.cdp,
      launch: opts.launch,
      headed: opts.headed,
      watch: opts.watch,
      values: opts.values,
      extension: opts.extension,
      solo: opts.solo,
      pageErrors: opts.pageErrors,
      devtools,
      collectionRoot: lineRoots.collectionRoot,
      localRoots: lineRoots.localRoots,
      // Drawn around the typed-command prompt, when one is showing.
      out,
      logCommand: log ? (text, echoed) => {
        if (!onlyInspects(text)) log.write(echoed.join('\n'));
      } : undefined,
      until,
      onStop: () => stop(),
      onActivity: touch,
      detached: detachedLog !== null,
      log: detachedLog ?? log?.file,
      runId,
      noWait: opts.noWait,
      // Tells the command that started it, which then returns.
      // One that has gone (killed by a timeout, say) leaves the run going
      // unannounced, rather than crashing it on the closed channel.
      onReady: detachedLog ? (id) => {
        if (!process.connected) return;
        process.send?.({ ready: id ?? null }, (err: Error | null) => {
          if (!err && process.connected) process.disconnect();
        });
      } : undefined,
      onConnected: () => {
        process.once('SIGINT', onSigint!);
        process.once('SIGTERM', onSigint!);
      },
    });
  } catch (err) {
    // Said by the caller too, but only to the terminal.
    log?.write(`[sm-dev] ${(err as Error).message}`);
    throw err;
  } finally {
    await log?.close();
    if (timer) clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    if (onSigint) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
    }
  }
}

const DEFAULT_IDLE_SECONDS = 1800;

// Set in the background process `start --detach` starts: the file its
// output goes to. Taken out of the environment, so nothing the run
// starts takes itself for a detached run too.
const detachedLog = process.env.SM_DEV_DETACHED_LOG || null;
delete process.env.SM_DEV_DETACHED_LOG;
if (detachedLog) {
  const { timestampOutputLines } = await import('./run-log.js');
  timestampOutputLines();
}

// `--idle-seconds` as the messages say it: whole minutes as minutes.
function duration(seconds: number): string {
  const [n, unit] = seconds >= 60 && seconds % 60 === 0 ? [seconds / 60, 'minute'] : [seconds, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Starts the run in a background process of its own, whose output goes
 * to a log file (see run-log.ts). Its output is passed on here
 * until it says it is ready, and then this returns, leaving it running.
 * Its id, or none when it ended first (with its exit code) or can't be
 * reached.
 */
async function detachRun(words: string[], runId: string | undefined): Promise<{ code: number; id?: string; log: string }> {
  const { createRunLog, LOG_LINE_PREFIX } = await import('./run-log.js');
  const { spawn } = await import('node:child_process');
  const { open } = await import('node:fs/promises');
  const { file: log, handle: writing } = await createRunLog();
  const reading = await open(log, 'r');
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...words, ...rootWords(), ...(runId ? ['--run', runId] : [])], {
    // Its own process group, so a Ctrl-C or closed terminal here
    // doesn't reach it once it is detached. No console window of its
    // own on Windows.
    detached: true,
    windowsHide: true,
    stdio: ['ignore', writing.fd, writing.fd, 'ipc'],
    env: { ...process.env, SM_DEV_DETACHED_LOG: log },
  });
  await writing.close();
  let ready: { id: string | null } | null = null;
  let exitCode: number | null = null;
  child.on('message', (m: { ready?: string | null }) => { if (m && 'ready' in m) ready = { id: m.ready ?? null }; });
  child.on('exit', (code) => { exitCode = code ?? 1; });
  child.on('error', () => { exitCode ??= 1; });
  // A Ctrl-C (or kill, or closed terminal) while it starts ends the
  // run, as it would a foreground one. A run ended that way can exit 0
  // having torn down cleanly, so that is kept apart from a success.
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  for (const signal of STOP_SIGNALS) process.on(signal, interrupt);
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let partial = '';
  // Whole lines, without the timestamps the file has; `end` passes on
  // a last line with no newline too.
  const passOn = async (end = false): Promise<void> => {
    for (;;) {
      const { bytesRead } = await reading.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      partial += decoder.write(buffer.subarray(0, bytesRead));
    }
    const lines = partial.split('\n');
    const rest = lines.pop()!;
    if (end && rest) lines.push(rest);
    partial = end ? '' : rest;
    for (const line of lines) print(line.replace(LOG_LINE_PREFIX, ''));
  };
  try {
    while (ready === null && exitCode === null) {
      await passOn();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Written before it said so.
    await passOn(true);
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, interrupt);
    await reading.close();
  }
  if (interrupted && ready === null) return { code: 130, log };
  // Ended before it was ready, with nothing wrong: `--seconds 0`, say.
  if (ready === null) return { code: exitCode || 1, log };
  const { id } = ready as { id: string | null };
  if (id === null) {
    // It printed why; unreachable, it could only be killed.
    child.kill('SIGTERM');
    return { code: 1, log };
  }
  child.unref();
  return { code: 0, id, log };
}

function checkClear(opts: Opts): void {
  if (!opts.extension) throw new UsageError('The clear command needs --extension; the harness itself keeps nothing between runs');
}

async function clearCommand(opts: Opts): Promise<number> {
  checkClear(opts);
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

function checkList(opts: Opts): void {
  if (opts.args.length > 0) throw new UsageError('The list command takes no arguments');
}

async function listCommand(opts: Opts): Promise<number> {
  checkList(opts);
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (runs.length === 0) print(NO_RUNS);
  else for (const line of runTable(runs)) print(line);
  return 0;
}

/**
 * A line's state across its commands. `--run` carries over to the
 * commands after it, and `start` sets it to the run it starts.
 */
interface Sequence {
  run?: string;
  /** Whether a `start` of this line began the run, which takes its `--root` and `--local`. */
  own?: boolean;
  /**
   * A run `start` began, without `--detach`, for the commands after it
   * on the line: stopped once they are done.
   */
  started?: { id: string; log: string };
}

const NO_RUN_TO_USE = `${NO_RUNS}. Start one with sm-dev start.`;

// The run a command acts on: the one `--run` names, else the only one
// going.
async function targetRun(wanted: string | undefined): Promise<RunRecord> {
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (wanted !== undefined) {
    const found = runs.find((r) => r.id === wanted);
    if (!found) throw new Error(`There is no run ${wanted}. Type sm-dev list to see the runs.`);
    return found;
  }
  if (runs.length === 0) throw new Error(NO_RUN_TO_USE);
  if (runs.length > 1) throw new UsageError(['Several runs are active. Pick one with --run:', ...runTable(runs)].join('\n'));
  return runs[0];
}

// A `--run` value as its run id, or a usage error. A bare number is the
// likely slip, as with tabs, and gets a hint.
async function checkedRunId(typed: string): Promise<string> {
  const id = runIdOf(typed);
  if (id) return id;
  throw new UsageError(/^\d+$/.test(typed)
    ? `Runs are named D1, D2 and so on. Did you mean --run D${typed}?`
    : `The run ID ${typed} is not valid. Run IDs are D and then letters, digits, _ or -.`);
}

// Old-style `stop D2`: the run goes in --run now.
async function refuseRunArgument(command: string, words: string[]): Promise<void> {
  if (words[0] === undefined) return;
  const id = runIdOf(words[0]);
  if (id) throw new UsageError(`Name the run with --run: sm-dev ${[command, ...words.slice(1).map(shellWord), '--run', id].join(' ')}`);
}

function isTypedCommand(name: string): boolean {
  return consoleCommandsHelp([name]).unknown.length === 0;
}

// Takes its arguments as typed, not through parseArgs: the command
// sent may have words of its own that look like flags (`set n -1`).
async function sendCommand(words: string[], wanted: string | undefined): Promise<number> {
  const { liveRuns, sendLine } = await import('./runs.js');
  await checkSend(words);
  // With no run to take a script or page from, what the command line
  // form needs instead.
  const needs = RUN_OR_FILES[words[0]];
  if (needs && wanted === undefined && (await liveRuns()).length === 0) throw new UsageError(needs);
  const target = await targetRun(wanted);
  const list = sentList(words);
  if (list) {
    // In order, each done before the next is sent, and each one's
    // output headed by the command as it was written. Stops at one that
    // failed (a `wait` that timed out), as a line of several does. The
    // exit code is the last one's.
    let code = 0;
    for (const [i, command] of list.commands.entries()) {
      for (const line of echoCommand(command)) print(line);
      code = await sendLine(target.id, command.text, print);
      if (stopsLine(code, commandWords(command.text))) {
        if (i < list.commands.length - 1) process.stderr.write(`${LINE_STOPPED}\n`);
        return code;
      }
    }
    return code;
  }
  // The words go as the shell gave them, so a selector or text with
  // spaces reaches a page command as one word.
  return sendLine(target.id, words.join(' '), print, undefined, words);
}

const MATCH_NEEDS = 'The match command needs a script (a .user.js file) and at least one URL, or a run to take them from';
const VALIDATE_NEEDS = 'The validate command needs at least one path, or a run to take the script from';
const RUN_OR_FILES: Record<string, string> = { match: MATCH_NEEDS, validate: VALIDATE_NEEDS };

// The words `match` and `validate` take in a run only: a loaded
// script, a tab, or all of them.
const SESSION_REF: Record<string, RegExp> = {
  match: /^(all|all-scripts|all-tabs|\d+|[Tt]\d+(\.\d+)?)$/i,
  validate: /^(all|\d+|[Tt]\d+\.\d+)$/i,
};

/**
 * Whether a `match` or `validate` needs a run: it names a loaded script
 * or tab, or leaves out what the command line form has to be given.
 * Otherwise it runs here, run or no run. A word that is also a file or
 * directory here (`all`, `2024`) is taken for it.
 */
function needsRun(words: string[]): boolean {
  const [name, ...args] = words;
  if (args.some((a) => SESSION_REF[name].test(a) && !existsSync(a))) return true;
  if (name === 'validate') return args.length === 0;
  const { scripts, urls } = scriptsAndUrls(args);
  return scripts.length === 0 || urls.length === 0;
}

/**
 * A command sent to a run, checked: a command a run takes, with flags
 * it takes. Also done before a line of several commands runs any.
 */
async function checkSend(words: string[]): Promise<void> {
  const list = sentList(words);
  // A command can come as one word (`sm-dev 'eval T1 x'`), split then
  // as the prompt would.
  const commands = list ? list.commands.map((c) => commandWords(c.text))
    : words.length === 1 ? [commandWords(words[0])] : [words];
  for (const command of commands) {
    const mistake = commandMistake(command);
    if (mistake) throw new UsageError(mistake);
  }
}

function commandMistake(words: string[]): string | null {
  if (!isTypedCommand(words[0])) return unknownRunCommand(words[0]);
  return commandFlagMistake(words);
}

// The list in one argument of several lines, checked; null for a
// single command.
function sentList(words: string[]): { commands: AssembledCommand[] } | null {
  return words.length === 1 && words[0].includes('\n') ? checkedList(words[0]) : null;
}

function checkedList(text: string): { commands: AssembledCommand[] } {
  const list = parseCommandList(text);
  if ('error' in list) throw new UsageError(list.error);
  if (list.commands.length === 0) throw new UsageError(NO_COMMANDS);
  return list;
}

function unknownRunCommand(name: string): string {
  return `${name} is not a command a run takes. Type sm-dev help to list them.`;
}

const NO_COMMANDS = 'No commands given on either command line or stdin';

// How long piped input can pause and still count as arriving at once,
// for checking in full before any of it runs.
const PIPED_BATCH_GAP_MS = 50;

/**
 * `--stdin`, or no command and piped input: commands read from stdin,
 * one per line. A run's go to the run; sm-dev's own (`list`, `match`
 * on files) run here, `start` only as the first command of all.
 * Returns the last command's exit code (1 after a mistake), or null
 * when stdin had no commands.
 *
 * - A file, or what a pipe delivers at once (a heredoc, `printf`), is
 *   checked in full before any is sent, so a typo on its fifth line
 *   leaves the first four unrun.
 * - After that, and at a terminal, each command is sent once it is
 *   read, as at the run's own prompt. A mistake then is said, and the
 *   rest go on, since the commands before it have run already.
 */
async function stdinCommands(seq: Sequence, first: boolean, started: () => void): Promise<number | null> {
  const { sendLine } = await import('./runs.js');
  const { createInterface } = await import('node:readline');
  const { fstatSync } = await import('node:fs');
  const terminal = Boolean(process.stdin.isTTY);
  // A file ends; only a pipe needs the pause to tell a batch.
  const file = !terminal && fstatSync(0).isFile();
  const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  // readline holds back a final line with no newline until the input
  // ends, so a line half-written to a pipe is never taken early.
  lines.on('line', (line) => { queue.push(line); wake?.(); });
  lines.on('close', () => { ended = true; wake?.(); });
  const QUIET = Symbol('quiet');
  // The next line, null once the input ends, or QUIET when none came
  // within `ms`.
  const next = async (ms?: number): Promise<string | null | typeof QUIET> => {
    while (queue.length === 0 && !ended) {
      let timer: NodeJS.Timeout | undefined;
      const quiet = await new Promise<boolean>((resolve) => {
        wake = () => resolve(false);
        if (ms !== undefined) timer = setTimeout(() => resolve(true), ms);
      });
      wake = null;
      clearTimeout(timer);
      if (quiet) return QUIET;
    }
    return queue.shift() ?? null;
  };
  const blocks = new CommandAssembler();
  let sent = 0;
  let failed = false;
  let code = 0;
  // Typed commands are on screen already; piped ones get a heading.
  // The run is looked up for each, since a start among them changes it,
  // and only once there is a command, so input with none says that.
  // Set by a command that stopped the rest: a start that failed, or
  // any that failed, piped in.
  let halted = false;
  // Commands of the batch still to send after this one.
  let pending = 0;
  const send = async (command: AssembledCommand): Promise<void> => {
    if (halted) return;
    const words = commandWords(command.text);
    const target = runsHere(words) ? null : await targetRun(seq.run);
    if (!terminal) for (const l of echoCommand(command)) print(l);
    code = target ? await sendLine(target.id, command.text, print) : await runOne(words, seq, true);
    sent++;
    // Piped ones stop at one that fails, as a list does; typed, the
    // person decides. A start that failed stops the rest either way,
    // since they were meant for its run.
    const isStart = commandName(words) === 'start';
    if (stopsLine(code, words) && (!terminal || isStart)) {
      halted = true;
      if (!ended || queue.length > 0 || pending > 0) process.stderr.write(`${LINE_STOPPED}\n`);
      return;
    }
    // So a Ctrl-C stops the run it began, as on the command line.
    if (isStart && code === 0) started();
  };
  // What is wrong with a command, before any runs; null when nothing.
  // `start` comes first or not at all, as on the command line.
  // A start read first begins the run the rest go to, with the line's roots.
  let startFirst = false;
  // Commands read so far, mistaken ones too: only the first can start.
  let seen = 0;
  const mistakeIn = async (command: AssembledCommand): Promise<string | null> => {
    const index = seen++;
    const words = commandWords(command.text);
    if (!runsHere(words)) return rootsGiven && !seq.own && !startFirst ? ROOTS_ARE_THE_RUNS : commandMistake(words);
    if (commandName(words) === 'start') {
      if (!(first && index === 0)) return START_FIRST;
      startFirst = true;
    }
    try {
      await checkCommand(words);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };
  // Lines read, for naming the one a block mistake is on.
  let n = 0;
  try {
    if (!terminal) {
      const batch: AssembledCommand[] = [];
      const mistakes: string[] = [];
      let line = await next();
      while (typeof line === 'string') {
        n++;
        const got = blocks.push(line);
        if (got && 'error' in got) mistakes.push(`ERROR: Line ${n}: ${got.error}`);
        else if (got) {
          const mistake = await mistakeIn(got.command);
          if (mistake) mistakes.push(...echoCommand(got.command), `ERROR: ${mistake}`);
          else batch.push(got.command);
        }
        line = await next(file ? undefined : PIPED_BATCH_GAP_MS);
      }
      if (line === null) {
        const unclosed = blocks.drop();
        if (unclosed !== null) mistakes.push(`ERROR: ${unclosedBlockMessage(unclosed)}`);
      }
      if (mistakes.length > 0) {
        for (const m of mistakes) process.stderr.write(`${m}\n`);
        process.stderr.write(`${NONE_RUN}\n`);
        return 2;
      }
      for (const [i, command] of batch.entries()) {
        pending = batch.length - i - 1;
        await send(command);
        if (halted) break;
      }
      pending = 0;
    }
    for (let line = await next(); line !== null && !halted; line = await next()) {
      if (typeof line !== 'string') continue;
      n++;
      const got = blocks.push(line);
      if (!got) continue;
      const mistake = 'error' in got ? `Line ${n}: ${got.error}` : await mistakeIn(got.command);
      if (mistake) {
        failed = true;
        if (!terminal && !('error' in got)) for (const l of echoCommand(got.command)) process.stderr.write(`${l}\n`);
        process.stderr.write(`ERROR: ${mistake}\n`);
        // Piped in, a mistake stops the rest, as a failed command does.
        if (!terminal) {
          process.stderr.write(`${LINE_STOPPED}\n`);
          return 1;
        }
        continue;
      }
      if (!('error' in got)) await send(got.command);
    }
    const unclosed = blocks.drop();
    if (unclosed !== null) {
      process.stderr.write(`ERROR: ${unclosedBlockMessage(unclosed)}, so it was not run\n`);
      failed = true;
    }
  } finally {
    lines.close();
    process.stdin.pause();
  }
  if (sent === 0 && !failed) return null;
  return failed || halted ? Math.max(code, 1) : code;
}

// sm-dev's own commands, which run in this process rather than going
// to a run, when read from stdin.
function runsHere(words: string[]): boolean {
  const name = commandName(words);
  if (name === 'match' || name === 'validate') return !needsRun(takeRunFlag(words).words);
  return name !== undefined && HERE.has(name);
}

// Ones that need no run, so a run's own copy isn't wanted.
const HERE = new Set(['start', 'list', 'stop', 'clear', 'help']);

async function checkStop(opts: Opts, run: string | undefined): Promise<void> {
  if (opts.all && run !== undefined) throw new UsageError('The --all flag stops every run, so the stop command can\'t be used with --run');
  if (opts.args.length > 0) {
    await refuseRunArgument('stop', opts.args);
    throw new UsageError('The stop command takes no arguments. Name the run with --run, or use --all.');
  }
}

async function stopCommand(opts: Opts, seq: Sequence): Promise<number> {
  const { liveRuns, stopRun } = await import('./runs.js');
  await checkStop(opts, seq.run);
  let targets: RunRecord[];
  if (opts.all) {
    const runs = await liveRuns();
    if (runs.length === 0) {
      print(NO_RUNS);
      return 0;
    }
    targets = runs;
  } else {
    targets = [await targetRun(seq.run)];
  }
  // Stopped here, so not again once the line's commands are done.
  if (targets.some((r) => r.id === seq.started?.id)) seq.started = undefined;
  // Together, each run's lines tagged with its id when there are
  // several.
  const several = targets.length > 1;
  const stopped = await Promise.all(targets.map((r) => stopRun(r, several ? (line) => print(`[${r.id}] ${line}`) : print)));
  return stopped.every(Boolean) ? 0 : 1;
}

// Stops the run a `start` began for the commands after it.
async function stopStarted(seq: Sequence): Promise<number> {
  const started = seq.started;
  if (!started) return 0;
  seq.started = undefined;
  const { liveRuns, stopRun } = await import('./runs.js');
  const record = (await liveRuns()).find((r) => r.id === started.id);
  const stopped = record ? await stopRun(record, print) : true;
  print(`[sm-dev] Output log: ${started.log}`);
  return stopped ? 0 : 1;
}

const HELP_FLAGS = new Set(['--help', '-h']);

// The `help` command's topics, or null for another command; empty for
// the whole help. `--help` is handled for the whole line (`lineHelp`).
function helpTopics(argv: string[]): string[] | null {
  return argv[0] === 'help' ? argv.slice(1) : null;
}

/**
 * `--help` (or `-h`) anywhere on the line: the help for each command
 * the line names, once each, and nothing run. Looked for before the
 * commands are checked, so a mistake elsewhere doesn't stand in the
 * way. With no command named, the whole help. Null when not asked.
 */
function lineHelp(commands: string[][]): string | null {
  if (!commands.some((words) => words.some((w) => HELP_FLAGS.has(w)))) return null;
  const names: string[] = [];
  for (const words of commands) {
    let rest: string[];
    try {
      rest = takeRunFlag(words).words;
    } catch {
      rest = words;
    }
    rest = rest.filter((w) => !HELP_FLAGS.has(w));
    // `help status`: its topics. Otherwise the command's name, which
    // may come after its flags (`--launch start`).
    const named = rest[0] === 'help' ? rest.slice(1) : rest.filter((w) => !w.startsWith('-')).slice(0, 1);
    for (const name of named) if (!names.includes(name)) names.push(name);
  }
  return names.length === 0 ? usage() : commandHelp(names);
}

// The signals that end sm-dev: Ctrl-C, kill, and a closed terminal.
// Windows has no SIGHUP to listen for.
const STOP_SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

// After a command of several that failed.
const LINE_STOPPED = 'That command failed, so the commands after it were not run';

const STDIN_FLAG = '--stdin';

const ROOTS_ARE_THE_RUNS = 'The --root and --local flags are set when a run starts, and a command sent to a run uses the run\'s own';

// `--root` and `--local`, for every command of the line: where the
// scripts it reads find local copies of their @requires. A run started
// on the line keeps them; commands sent to another run use its own.
let lineRoots: ScriptRoots = { collectionRoot: process.cwd(), localRoots: [] };
// Whether the line gave either, so one sent to a run can be refused.
let rootsGiven = false;

// Takes `--root DIR` and `--local DIR` out of the line's words.
function takeRootFlags(argv: string[]): string[] {
  const rest: string[] = [];
  let collectionRoot = process.cwd();
  const localRoots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word !== '--root' && word !== '--local') {
      rest.push(word);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value === SEPARATOR) throw new UsageError(`The ${word} flag needs a value`);
    if (word === '--root') collectionRoot = path.resolve(value);
    else localRoots.push(path.resolve(value));
    rootsGiven = true;
  }
  lineRoots = { collectionRoot, localRoots };
  return rest;
}

// The line's roots as flags again, for a run started in the background.
function rootWords(): string[] {
  if (!rootsGiven) return [];
  return ['--root', lineRoots.collectionRoot, ...lineRoots.localRoots.flatMap((dir) => ['--local', dir])];
}

// The commands from stdin, after the line's. With none on the line
// either, says so rather than exiting without a word.
async function runStdin(seq: Sequence, only: boolean, started: () => void): Promise<number> {
  try {
    const code = await stdinCommands(seq, only, started);
    if (code !== null) return code;
    if (!only) return 0;
    throw new UsageError(NO_COMMANDS);
  } catch (err) {
    return printMistake(err);
  }
}

// Where one command ends and the next begins, when a line has several.
const SEPARATOR = '--';

function splitCommands(argv: string[]): string[][] {
  const commands: string[][] = [[]];
  for (const arg of argv) {
    if (arg === SEPARATOR) commands.push([]);
    else commands[commands.length - 1].push(arg);
  }
  return commands.filter((c) => c.length > 0);
}

// Takes `--run ID` or `--run=ID` out of a command's words.
function takeRunFlag(words: string[]): { words: string[]; run?: string } {
  const rest: string[] = [];
  let run: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--run') {
      run = words[++i];
      if (run === undefined) throw new UsageError('The --run flag needs a run ID, e.g. --run D2');
    } else if (word.startsWith('--run=')) {
      run = word.slice('--run='.length);
      if (run === '') throw new UsageError('The --run flag needs a run ID, e.g. --run D2');
    } else {
      rest.push(word);
    }
  }
  return { words: rest, run };
}

const START_FIRST = 'The start command can only come first on a line of several commands';

function isStart(words: string[]): boolean {
  return commandName(words) === 'start';
}

const STOP_THEN_STDIN = 'The --stdin flag sends commands to the line\'s run, so it can\'t be used with stop';

// Whether a command's exit code stops the commands after it: any
// failure but a miss from match or validate, which is an answer.
function stopsLine(code: number, words: string[]): boolean {
  return code !== 0 && !(code === 1 && isVerdict(words));
}

// The commands whose exit code answers a question.
function isVerdict(words: string[]): boolean {
  const name = commandName(words);
  return name === 'match' || name === 'validate';
}

function isStop(words: string[]): boolean {
  return commandName(words) === 'stop';
}

function commandName(words: string[]): string | undefined {
  try {
    return takeRunFlag(words).words[0];
  } catch {
    // A bad --run is said when the command runs.
    return undefined;
  }
}



// A command's own words, sorted out: help, a command sent to a run, or
// one of sm-dev's own. `--run` is taken out already.
type ParsedCommand =
  | { kind: 'help'; topics: string[] }
  | { kind: 'send'; words: string[] }
  | { kind: 'cli'; opts: Opts; words: string[] };

function parseCommand(words: string[]): ParsedCommand {
  const topics = helpTopics(words);
  if (topics) return { kind: 'help', topics };
  // Only `--run` given.
  if (words.length === 0) throw new UsageError('A command is needed, e.g. sm-dev status --run D2');
  // A run's command may come as one argument: `'eval T1 x'`. One of
  // several lines is a list of them, and never sm-dev's own.
  if (words.length === 1 && words[0].includes('\n')) return { kind: 'send', words };
  if ((words[0] === 'match' || words[0] === 'validate') && needsRun(words)) return { kind: 'send', words };
  const head = words.length === 1 ? words[0].trim().split(/\s+/)[0] : words[0];
  if (!CLI_COMMANDS.has(words[0]) && isTypedCommand(head)) return { kind: 'send', words };
  const opts = parseArgs(words);
  if (opts.command === null) throw new UsageError(`A command is needed. ${LIST_COMMANDS}`);
  if (!['validate', 'match', 'start', 'clear', 'list', 'stop'].includes(opts.command)) {
    // A run's ID where the command goes: the old `sm-dev D1 status`.
    const run = runIdOf(opts.command);
    if (run) throw new UsageError(`Name the run with --run: sm-dev ${[...words.slice(1).map(shellWord), '--run', run].join(' ')}`);
    throw new UsageError(`Unknown command: ${opts.command}. ${LIST_COMMANDS}`);
  }
  return { kind: 'cli', opts, words };
}

/**
 * Everything about one command that can be checked before any command
 * of the line runs: its name, flags and arguments, the form of a
 * `--run`, and that `start`'s script files exist. Not whether the run,
 * tab or script it names is there, since earlier commands can change
 * that. Throws the mistake.
 */
async function checkCommand(words: string[]): Promise<void> {
  const taken = takeRunFlag(words);
  if (taken.run !== undefined) await checkedRunId(taken.run);
  const parsed = parseCommand(taken.words);
  if (parsed.kind === 'help') {
    if (parsed.topics.length > 0) commandHelp(parsed.topics);
    return;
  }
  if (parsed.kind === 'send') return checkSend(parsed.words);
  const { opts } = parsed;
  switch (opts.command) {
    case 'validate': return checkValidate(opts);
    case 'match': return checkMatch(opts);
    case 'start': await checkStart(opts); return;
    case 'clear': return checkClear(opts);
    case 'list': return checkList(opts);
    case 'stop': return checkStop(opts, taken.run);
  }
}

// Prints a command's mistake, and returns its exit code. One in how the
// command was typed is marked as such, apart from a failure doing it.
function printMistake(err: unknown): number {
  const usage = err instanceof UsageError;
  process.stderr.write(`${usage ? 'ERROR: ' : ''}${(err as Error).message}\n`);
  return usage ? 2 : 1;
}

/**
 * One command of the line. `more`: whether others follow it. Prints its
 * own errors, and returns its exit code.
 */
async function runOne(words: string[], seq: Sequence, more: boolean): Promise<number> {
  try {
    const taken = takeRunFlag(words);
    if (taken.run !== undefined) seq.run = await checkedRunId(taken.run);
    const parsed = parseCommand(taken.words);
    if (parsed.kind === 'help') {
      process.stdout.write(parsed.topics.length === 0 ? usage() : commandHelp(parsed.topics));
      return 0;
    }
    if (parsed.kind === 'send') {
      if (rootsGiven && !seq.own) throw new UsageError(ROOTS_ARE_THE_RUNS);
      return await sendCommand(parsed.words, seq.run);
    }
    const { opts } = parsed;
    switch (opts.command) {
      case 'validate': return await validate(opts);
      case 'match': return await match(opts);
      case 'start': return await startCommand(opts, parsed.words, seq, more);
      case 'clear': return await clearCommand(opts);
      case 'list': return await listCommand(opts);
      default: return await stopCommand(opts, seq);
    }
  } catch (err) {
    return printMistake(err);
  }
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
  let argv: string[];
  try {
    argv = takeRootFlags(process.argv.slice(2));
  } catch (err) {
    process.exitCode = printMistake(err);
    return;
  }
  let commands = splitCommands(argv.filter((w) => w !== STDIN_FLAG));
  // A line of only `--run D1` names the run for stdin's commands.
  let lineRun: string | undefined;
  if (commands.length === 1) {
    try {
      const taken = takeRunFlag(commands[0]);
      if (taken.words.length === 0 && taken.run !== undefined) {
        lineRun = taken.run;
        commands = [];
      }
    } catch {
      // A bad --run is said when the command runs.
    }
  }
  // Piped in with no command, stdin can only be commands.
  const stdin = argv.includes(STDIN_FLAG) || (commands.length === 0 && !process.stdin.isTTY);
  if (lineRun !== undefined && !stdin) commands = [['--run', lineRun]];
  if (commands.length === 0 && !stdin) {
    process.stdout.write(usage());
    process.exitCode = 2;
    return;
  }
  let help: string | null;
  try {
    help = lineHelp(commands);
  } catch (err) {
    process.exitCode = printMistake(err);
    return;
  }
  if (help !== null) {
    process.stdout.write(help);
    return;
  }
  // Only first, so a start never inherits a --run meant for another
  // command, and a line never holds two runs of its own.
  // Its run is gone once it is done, with nothing left to send to.
  if (stdin && commands.some(isStop)) {
    process.exitCode = printMistake(new UsageError(STOP_THEN_STDIN));
    return;
  }
  if (commands.slice(1).some(isStart)) {
    process.exitCode = printMistake(new UsageError(START_FIRST));
    return;
  }
  // Every command checked before any runs, so a typo late in the line
  // doesn't leave the ones before it done. A lone one is checked as it
  // runs.
  if (commands.length > 1) {
    let failed = 0;
    for (const words of commands) {
      try {
        await checkCommand(words);
      } catch (err) {
        process.stderr.write(`> ${words.map(shellWord).join(' ')}\n`);
        failed = Math.max(failed, printMistake(err));
      }
    }
    if (failed) {
      process.stderr.write(`${NONE_RUN}\n`);
      process.exitCode = failed;
      return;
    }
  }
  const seq: Sequence = {};
  if (lineRun !== undefined && commands.length === 0) {
    try {
      seq.run = await checkedRunId(lineRun);
    } catch (err) {
      process.exitCode = printMistake(err);
      return;
    }
  }
  // A Ctrl-C partway through still stops a run started for the line.
  // Only once there is one, since a run in this process, or one still
  // starting, handles its own.
  const interrupt = (): void => {
    void stopStarted(seq).finally(() => process.exit(130));
  };
  const listen = (on: boolean): void => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, interrupt);
      if (on) process.on(signal, interrupt);
    }
  };
  let code = 0;
  let stopped = false;
  try {
    // In order, stopping at the first that fails, as a shell's && would.
    for (const [i, words] of commands.entries()) {
      if (commands.length > 1) print(`> ${words.map(shellWord).join(' ')}`);
      code = await runOne(words, seq, stdin || i < commands.length - 1);
      // A miss from match or validate is an answer, not a failure: the
      // line goes on, and it only sets the exit code if it is last.
      if (stopsLine(code, words)) {
        if (i < commands.length - 1 || stdin) process.stderr.write(`${LINE_STOPPED}\n`);
        stopped = true;
        break;
      }
      listen(seq.started !== undefined);
    }
    if (stdin && !stopped) code = await runStdin(seq, commands.length === 0, () => listen(seq.started !== undefined));
  } finally {
    const ended = await stopStarted(seq);
    if (code === 0) code = ended;
    listen(false);
  }
  process.exitCode = code;
}

await main();
