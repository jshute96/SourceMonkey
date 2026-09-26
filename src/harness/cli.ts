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

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { CommandAssembler, echoCommand, parseCommandList, shellWord, unclosedBlockMessage, type AssembledCommand } from './command-lines.js';
import { CONSOLE_HELP, commandFlagMistake, commandWords, consoleCommandsHelp, helpEntries, writeOutputLine } from './console-commands.js';
import { devtoolsWanted } from './devtools.js';
// Node built-ins only, so as cheap to load as the rest here.
import { runIdOf, type RunRecord } from './runs.js';
import { NO_RULE_COVERS_URL, explainMatch, isDirectoryMessage, noSuchFileMessage, prepareScript, withDefaultScheme, type PreparedScript } from './prepare.js';
import { isMarkupContentType, looksLikeMarkup, markupResponseMessage } from '../markup-response.js';
import { unusableMatchGroupKey } from '../url-match.js';

// A mistake in how the command was typed, as opposed to a failure while
// carrying it out: the one kind that exits 2.
class UsageError extends Error {}

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
  '                            URLs',
  'match <script>... <url>...  Say whether each script would run on each',
  '                            URL, and which header rules matched or',
  '                            excluded it',
  'clear --extension           Remove every script in the extension\'s',
  '                            Scratch collection and turn solo mode off',
  'list                        List sm-dev runs active on this machine',
  '<command>                   Any command a run takes (listed below),',
  '                            sent to the run: sm-dev eval document.title',
  'send [command|-]            Send a run a command. The command can be',
  '                            multi-line, one command per line.',
  '                            Omit it or use - to read from stdin.',
  'stop [--all]                End the run, or all runs',
  'help [command]...           List these, or one command\'s help and',
  '                            options (a run\'s typed commands too)',
];

// The flags, grouped as the full help shows them. `commands` are the
// ones a group's flags apply to, for `help <command>`; `only` narrows
// or widens that for one flag.
const OPTION_GROUPS: { title: string; commands: string[]; lines: string[]; only?: Record<string, string[]> }[] = [
  {
    title: 'Options for the commands that read scripts (start, validate, match)',
    commands: ['start', 'validate', 'match'],
    lines: [
      '--root DIR      The repo root, searched for local copies of @require',
      '                URLs (default: the current directory)',
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
    title: 'Options for the commands that act on a run (its commands, send, stop, start)',
    commands: ['send', 'stop', 'start'],
    lines: [
      '--run ID        The run to act on. Needed only when several are active.',
      '                With start: the ID for the new run, which stops a run',
      '                that has it first',
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
      'Commands after it on the line (after --) go to the run. Without --detach,',
      'the run is stopped once they are done.',
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
  if (name === 'start' || name === 'send') {
    lines.push('', 'Type sm-dev help <command> for a run\'s commands (sm-dev help status), or', 'help at its prompt.');
  }
  return lines.join('\n');
}

interface Opts {
  command: string | null;
  args: string[];
  root: string;
  local: string[];
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
    command: null, args: [], root: process.cwd(), local: [],
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
      case '--root': opts.root = path.resolve(next()); break;
      case '--local': opts.local.push(path.resolve(next())); break;
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

function checkValidate(opts: Opts): void {
  if (opts.args.length === 0) throw new UsageError('The validate command needs at least one path');
}

async function validate(opts: Opts): Promise<number> {
  checkValidate(opts);
  // In the order given. A web address is fetched; a path may be a
  // directory to search.
  const sources: ScriptSource[] = [];
  for (const arg of opts.args) {
    if (REMOTE_SCRIPT.test(arg)) sources.push(...await scriptSources([arg]));
    else for (const file of await collectScripts([arg])) sources.push({ label: rel(file), file });
  }
  // What it found, not how it was typed.
  if (sources.length === 0) throw new Error('No *.user.js files found');
  let failed = 0;
  for (const source of sources) {
    const prepared = await prepareSource(source, opts);
    if (prepared.status === 'ok') {
      const notes = prepared.startupLogs.map((l) => `\n    ${l.level}: ${l.message}`).join('');
      process.stdout.write(`ok       ${source.label}${notes}\n`);
    } else {
      failed++;
      process.stdout.write(`INVALID  ${source.label}\n    ${prepared.diagnostic}\n`);
    }
  }
  process.stdout.write(`\n${sources.length - failed} ok, ${failed} invalid\n`);
  return failed === 0 ? 0 : 1;
}

// A `start` or `match` argument that names a script rather than a page.
const SCRIPT_ARG = /\.user\.js$/i;

// `start` and `match` arguments: scripts, and the URLs the rest are.
function scriptsAndUrls(args: string[]): { scripts: string[]; urls: string[] } {
  return {
    // Each once, so a repeat is neither checked nor opened twice.
    scripts: [...new Set(args.filter((a) => SCRIPT_ARG.test(a)))],
    urls: [...new Set(args.filter((a) => !SCRIPT_ARG.test(a)).map((a) => withDefaultScheme(a)))],
  };
}

// A script named by a web address rather than a path: `validate` and
// `match` fetch it.
const REMOTE_SCRIPT = /^https?:\/\//i;

// A script to check: read from disk, or already fetched from `url`.
// `label` is how the output names it.
type ScriptSource = { label: string; file: string } | { label: string; url: string; text: string };

// Local ones checked, remote ones fetched, all up front, so a mistyped
// name or a dead link is reported before any output.
async function scriptSources(inputs: string[]): Promise<ScriptSource[]> {
  return Promise.all(inputs.map(async (input): Promise<ScriptSource> => {
    if (!REMOTE_SCRIPT.test(input)) {
      const file = await scriptFile(input);
      return { label: rel(file), file };
    }
    // Its final URL, past any redirect, for relative @requires to resolve against.
    const { url, text } = await fetchScript(input);
    return { label: input, url, text };
  }));
}

// Long enough for a slow server, short enough that a stuck one doesn't
// hold the command for minutes.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchScript(url: string): Promise<{ url: string; text: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const error = err as Error & { cause?: { code?: string; message?: string } };
    const why = error.name === 'TimeoutError' ? `The server didn't answer within ${FETCH_TIMEOUT_MS / 1000} seconds`
      : error.cause?.code === 'ENOTFOUND' ? 'No such host'
        : error.cause?.code === 'ECONNREFUSED' ? 'The server refused the connection'
          // Node's own message is only "fetch failed"; the cause says why.
          : capitalize(error.cause?.message ?? error.message);
    throw new Error(`Could not fetch ${url}: ${why}`);
  }
  if (!response.ok) throw new Error(`Could not fetch ${url}: The server answered ${response.status} ${response.statusText}`.trimEnd());
  const text = await response.text();
  // A login page or a forge's page about the file, not the file.
  const contentType = response.headers.get('content-type') ?? '';
  if (isMarkupContentType(contentType) || looksLikeMarkup(text)) {
    throw new Error(`Could not fetch ${url}: ${markupResponseMessage(isMarkupContentType(contentType) ? { contentType } : {})}`);
  }
  return { url: response.url || url, text };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function prepareSource(source: ScriptSource, opts: Opts): Promise<PreparedScript> {
  const shared = { collectionRoot: opts.root, localRoots: opts.local };
  return 'file' in source
    ? prepareScript({ file: source.file, ...shared })
    // Relative @requires resolve against the script's own URL.
    : prepareScript({ text: source.text, sourceUrl: source.url, ...shared });
}

// Every script against every URL, in the order given. Arguments can
// come in any order: a `.user.js` one is a script, the rest are URLs.
function checkMatch(opts: Opts): void {
  const { scripts, urls } = scriptsAndUrls(opts.args);
  if (scripts.length === 0 || urls.length === 0) {
    throw new UsageError('The match command needs a script (a .user.js file) and at least one URL');
  }
}

async function match(opts: Opts): Promise<number> {
  checkMatch(opts);
  const { scripts, urls } = scriptsAndUrls(opts.args);
  const sources = await scriptSources(scripts);
  let failures = 0;
  for (const [i, source] of sources.entries()) {
    // Headed only when there are several, so one script reads as before.
    if (sources.length > 1) process.stdout.write(`${i > 0 ? '\n' : ''}${source.label}\n`);
    const prepared = await prepareSource(source, opts);
    // A script whose @match rules can never match is stored invalid,
    // but the answer per URL is still exact: no match. Anything else
    // invalid never runs at all; `validate` says why.
    const unmatchable = prepared.errorMessage !== undefined && unusableMatchGroupKey(prepared.errorMessage) !== null;
    if (prepared.status !== 'ok' && !unmatchable) {
      failures++;
      // Under a heading, the heading has already named it.
      process.stdout.write(sources.length > 1 ? 'INVALID script\n' : `INVALID  ${source.label}\n`);
      continue;
    }
    for (const url of urls) {
      const verdict = explainMatch(prepared.matching, url);
      if (!verdict.matches) failures++;
      // Every rule that covers the URL, not only the deciding one, so a
      // miss shows what an @exclude overrode.
      const lines = [
        ...verdict.excludedBy.map((rule) => `Excluded by: ${rule}`),
        // Padded so its rules line up with the excludes'.
        ...verdict.matchedBy.map((rule) => `Matched by:  ${rule}`),
      ];
      if (lines.length === 0) lines.push(NO_RULE_COVERS_URL);
      process.stdout.write(`${verdict.matches ? 'match   ' : 'no match'} ${url}\n${lines.map((l) => `    ${l}\n`).join('')}`);
    }
  }
  return failures === 0 ? 0 : 1;
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
  const files = await Promise.all(scripts.map(scriptFile));
  return { urls, files, devtools };
}

// The run, in this process: until Ctrl-C, `quit`, `sm-dev stop` or
// `--seconds`, or for a background process, its idle timeout.
async function runHere(opts: Opts, files: string[], urls: string[], devtools: boolean, runId: string | undefined): Promise<number> {
  // A background run has no input: commands come from other shells.
  if (detachedLog) process.stdin.destroy();
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
      collectionRoot: opts.root,
      localRoots: opts.local,
      // Drawn around the typed-command prompt, when one is showing.
      out: writeOutputLine,
      until,
      onStop: () => stop(),
      onActivity: touch,
      detachedLog: detachedLog ?? undefined,
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
  } finally {
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
  const { timestampOutputLines } = await import('./detached-log.js');
  timestampOutputLines();
}

// `--idle-seconds` as the messages say it: whole minutes as minutes.
function duration(seconds: number): string {
  const [n, unit] = seconds >= 60 && seconds % 60 === 0 ? [seconds / 60, 'minute'] : [seconds, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Starts the run in a background process of its own, whose output goes
 * to a log file (see detached-log.ts). Its output is passed on here
 * until it says it is ready, and then this returns, leaving it running.
 * Its id, or none when it ended first (with its exit code) or can't be
 * reached.
 */
async function detachRun(words: string[], runId: string | undefined): Promise<{ code: number; id?: string; log: string }> {
  const { createDetachedLog, LOG_LINE_PREFIX } = await import('./detached-log.js');
  const { spawn } = await import('node:child_process');
  const { open } = await import('node:fs/promises');
  const { file: log, handle: writing } = await createDetachedLog();
  const reading = await open(log, 'r');
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...words, ...(runId ? ['--run', runId] : [])], {
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

// Old-style `send D2 status` and `stop D2`: the run goes in --run now.
async function refuseRunArgument(command: string, words: string[]): Promise<void> {
  if (words[0] === undefined || isTypedCommand(words[0])) return;
  const id = runIdOf(words[0]);
  if (id) throw new UsageError(`Name the run with --run: sm-dev ${[command, ...words.slice(1).map(shellWord), '--run', id].join(' ')}`);
}

function isTypedCommand(name: string): boolean {
  return consoleCommandsHelp([name]).unknown.length === 0;
}

// Takes its arguments as typed, not through parseArgs: the command
// sent may have words of its own that look like flags (`set n -1`).
async function sendCommand(words: string[], wanted: string | undefined): Promise<number> {
  const { sendLine } = await import('./runs.js');
  await checkSend(words);
  // `-`: each command sent as its line is read, a terminal included.
  if (words.length === 1 && words[0] === '-') {
    const target = await targetRun(wanted);
    return sendAsRead(target.id, sendLine);
  }
  // A list of commands: one argument of several lines, or piped stdin,
  // checked in full before any is sent. Stdin with no arguments only
  // when it isn't a terminal, which would sit waiting for a command
  // someone forgot to type. Several arguments are one command, so
  // eval's JavaScript can be one multi-line argument.
  const fromStdin = words.length === 0;
  // Before reading stdin, so a wrong run is said at once, not once the
  // input ends.
  const early = fromStdin ? await targetRun(wanted) : null;
  const list = fromStdin ? checkedList(await readStdin()) : sentList(words);
  const target = early ?? await targetRun(wanted);
  if (list) {
    // In order, each done before the next is sent, and each one's
    // output headed by the command as it was written. Stops at one that
    // failed (a `wait` that timed out), as a line of several does.
    for (const [i, command] of list.commands.entries()) {
      for (const line of echoCommand(command)) print(line);
      if (!await sendLine(target.id, command.text, print)) {
        if (i < list.commands.length - 1) process.stderr.write(`${LINE_STOPPED}\n`);
        return 1;
      }
    }
    return 0;
  }
  // The words go as the shell gave them, so a selector or text with
  // spaces reaches a page command as one word.
  return await sendLine(target.id, words.join(' '), print, undefined, words) ? 0 : 1;
}

/**
 * What `send` takes, checked, and what its commands start with: a
 * command a run takes. Nothing is read from stdin, so a list piped in
 * is checked once it is read. Also done before a line of several
 * commands runs any.
 */
async function checkSend(words: string[]): Promise<void> {
  await refuseRunArgument('send', words);
  if (words.length === 1 && words[0] === '-') return;
  if (words.length === 0 && process.stdin.isTTY) throw new UsageError(NOTHING_TO_SEND);
  const list = sentList(words);
  // A command can come as one word (`send 'eval T1 x'`), split then as
  // the prompt would.
  const commands = list ? list.commands.map((c) => commandWords(c.text))
    : words.length === 1 ? [commandWords(words[0])] : words.length > 0 ? [words] : [];
  for (const command of commands) {
    if (!isTypedCommand(command[0])) throw new UsageError(unknownRunCommand(command[0]));
    const mistake = commandFlagMistake(command);
    if (mistake) throw new UsageError(mistake);
  }
}

// The list in `send`'s one argument of several lines, checked; null
// for a single command.
function sentList(words: string[]): { commands: AssembledCommand[] } | null {
  return words.length === 1 && words[0].includes('\n') ? checkedList(words[0]) : null;
}

function checkedList(text: string): { commands: AssembledCommand[] } {
  const list = parseCommandList(text);
  if ('error' in list) throw new UsageError(list.error);
  if (list.commands.length === 0) throw new UsageError(NOTHING_TO_SEND);
  return list;
}

function unknownRunCommand(name: string): string {
  return `${name} is not a command a run takes. Type sm-dev help to list them.`;
}

/**
 * `send -`: stdin's commands sent one at a time as each is read, so at
 * a terminal each runs on Enter, as at the run's own prompt. A mistake
 * (a `{{` after another command) is said and the rest go on, since the
 * commands before it have run already. 1 when there was one.
 */
async function sendAsRead(
  id: string,
  sendLine: (id: string, line: string, out: (line: string) => void) => Promise<boolean>,
): Promise<number> {
  const { createInterface } = await import('node:readline');
  const blocks = new CommandAssembler();
  // Typed commands are on screen already; piped ones get a heading, and
  // stop at one that fails, as a list does. Typed, the person decides.
  const piped = !process.stdin.isTTY;
  let failed = false;
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    const got = blocks.push(line);
    if (!got) continue;
    if ('error' in got) {
      failed = true;
      print(`ERROR: ${got.error}`);
    } else {
      if (piped) for (const l of echoCommand(got.command)) print(l);
      if (!await sendLine(id, got.command.text, print)) failed = true;
    }
    if (failed && piped) {
      process.stderr.write(`${LINE_STOPPED}\n`);
      return 1;
    }
  }
  const unclosed = blocks.drop();
  if (unclosed !== null) {
    print(`ERROR: ${unclosedBlockMessage(unclosed)}, so it was not run`);
    failed = true;
  }
  return failed ? 1 : 0;
}

const NOTHING_TO_SEND = 'The send command needs a command to send, or piped stdin, e.g. sm-dev send status';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

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
  try {
    return takeRunFlag(words).words[0] === 'start';
  } catch {
    // A bad --run is said when the command runs.
    return false;
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
  if (words[0] === 'send') return { kind: 'send', words: words.slice(1) };
  if (!CLI_COMMANDS.has(words[0]) && isTypedCommand(words[0])) return { kind: 'send', words };
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
    if (parsed.kind === 'send') return await sendCommand(parsed.words, seq.run);
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
  const commands = splitCommands(process.argv.slice(2));
  if (commands.length === 0) {
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
      process.stderr.write('None of the commands were run.\n');
      process.exitCode = failed;
      return;
    }
  }
  const seq: Sequence = {};
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
  try {
    // In order, stopping at the first that fails, as a shell's && would.
    for (const [i, words] of commands.entries()) {
      if (commands.length > 1) print(`> ${words.map(shellWord).join(' ')}`);
      code = await runOne(words, seq, i < commands.length - 1);
      if (code !== 0) {
        if (i < commands.length - 1) process.stderr.write(`${LINE_STOPPED}\n`);
        break;
      }
      listen(seq.started !== undefined);
    }
  } finally {
    const stopped = await stopStarted(seq);
    if (code === 0) code = stopped;
    listen(false);
  }
  process.exitCode = code;
}

await main();
