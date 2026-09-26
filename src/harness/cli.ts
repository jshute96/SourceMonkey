#!/usr/bin/env node
// `sm-dev`: argument parsing and dispatch for the development
// harness's command line. The usage text below describes each command,
// and describes it once; this file is the plumbing around it.
//
// Each command's work lives elsewhere:
//   - `validate` and `match` call prepare.ts, here in this file.
//   - `run` hands off to run.ts, which also opens the browser every
//     browser command uses.
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

import { CommandAssembler, echoCommand, parseCommandList, unclosedBlockMessage } from './command-lines.js';
import { CONSOLE_HELP, consoleCommandsHelp, helpEntries, writeOutputLine } from './console-commands.js';
import { devtoolsWanted } from './devtools.js';
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
  'run <script>... [url]...    Inject the scripts into each URL, one tab',
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
  'send [run] [command|-]      Run a command in another sm-dev run',
  '                            Run IDs are D1, D2. The command can be',
  '                            multi-line, one command per line.',
  '                            Omit it or use - to read from stdin.',
  'stop [run]... | --all       End one or more runs, or all',
  'help [command]...           List these, or one command\'s help and',
  '                            options (a run\'s typed commands too)',
];

// The flags, grouped as the full help shows them. `commands` are the
// ones a group's flags apply to, for `help <command>`; `only` narrows
// or widens that for one flag.
const OPTION_GROUPS: { title: string; commands: string[]; lines: string[]; only?: Record<string, string[]> }[] = [
  {
    title: 'Options for the commands that read scripts (run, validate, match)',
    commands: ['run', 'validate', 'match'],
    lines: [
      '--root DIR      The repo root, searched for local copies of @require',
      '                URLs (default: the current directory)',
      '--local DIR     Another directory to search; repeatable',
    ],
  },
  {
    title: 'Options for the browser commands (run, clear)',
    commands: ['run', 'clear'],
    lines: [
      '--cdp URL|PORT  Browser to connect to: a URL, host:port, or just a',
      '                port on this machine (default: $SM_DEV_CDP or 9233)',
      '--launch        Launch a Chromium instead of connecting to one',
      '--headed        With --launch: show the browser',
    ],
  },
  {
    title: 'Options for run',
    commands: ['run'],
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
      '--fire-menu S   Fire the registered menu command named S once the page',
      '                has loaded, as if picked from the toolbar menu',
      '--seconds N     Stop after N seconds instead of waiting for Ctrl-C,',
      '                quit or sm-dev stop',
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
  run: {
    about: [
      'Starts a run that lasts as long as this command. It keeps a connection to',
      'the browser, injects the scripts into each page it opens, and streams their',
      'console lines, reports and GM_* calls back here.',
      '',
      'It is also an interactive shell: type commands at its prompt to act on the',
      'pages and scripts. Each run prints its id, for sm-dev send and sm-dev stop',
      'to reach it from another shell.',
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
  commands: ['run'],
  text: `While run streams, it also acts as an interactive shell, with the commands
below. Each run prints its id, for sm-dev send and sm-dev stop to reach it by.`,
};

const indent = (lines: string[]): string => lines.map((line) => (line ? `  ${line}` : '')).join('\n');

// The command lines and options alone: what a usage error prints.
const USAGE = `${INTRO}

Commands:
${indent(COMMAND_LINES)}

${OPTION_GROUPS[0].title}:
${indent(OPTION_GROUPS[0].lines)}

${OPTION_GROUPS[1].title}:
${indent(OPTION_GROUPS[1].lines)}

For run and match, a .user.js argument is a script, and the rest are URLs.
${ARGS_NOTE}

${OPTION_GROUPS.slice(2).map((group) => `${group.title}:\n${indent(group.lines)}`).join('\n\n')}

${SHELL_NOTE.text}
`;

// The whole of `--help`: the commands above, then the ones a run takes,
// as its own `help` lists them.
function usage(): string {
  return `${USAGE}
Commands in interactive shell and send:
${indent(CONSOLE_HELP)}
`;
}

const CLI_COMMANDS = new Set(COMMAND_LINES.filter((line) => !/^\s/.test(line)).map((line) => line.split(' ')[0]));

/**
 * `sm-dev help <command>...`: each command's entry, then the flags and
 * notes that concern it. A run's typed commands (`status`) get their
 * entry from its `help`. Throws for a name that is neither.
 */
function commandHelp(names: string[]): string {
  const isTyped = (name: string): boolean => consoleCommandsHelp([name]).unknown.length === 0;
  const unknown = names.filter((name) => !CLI_COMMANDS.has(name) && !isTyped(name));
  if (unknown.length > 0) throw new UsageError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${unknown.length === 1 ? 'a command' : 'commands'}. Type sm-dev --help to list them.`);
  const blocks: string[] = [];
  // The typed commands in a row, together under one heading.
  let typed: string[] = [];
  const flushTyped = (): void => {
    if (typed.length === 0) return;
    blocks.push(['Commands typed in sm-dev run, or sent with sm-dev send:', '', indent(consoleCommandsHelp(typed).lines)].join('\n'));
    typed = [];
  };
  for (const name of names) {
    if (CLI_COMMANDS.has(name)) {
      flushTyped();
      blocks.push(cliCommandHelp(name));
    }
    // A name that is both (help) gets both.
    if (isTyped(name)) typed.push(name);
  }
  flushTyped();
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
  if (name === 'run' || name === 'send') {
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
  fireMenu?: string;
  extension: boolean;
  solo: boolean;
  pageErrors: boolean;
  /** `--devtools` / `--nodevtools`; unset leaves it to `SM_DEV_DEVTOOLS`. */
  devtools?: boolean;
  seconds?: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    command: null, args: [], root: process.cwd(), local: [],
    all: false, noScript: false, noTab: false, launch: false, headed: false, watch: false, extension: false, solo: false, pageErrors: false,
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
      case '--fire-menu': opts.fireMenu = next(); break;
      case '--extension': opts.extension = true; break;
      case '--solo': opts.solo = true; break;
      case '--page-errors': opts.pageErrors = true; break;
      case '--devtools': opts.devtools = true; break;
      case '--nodevtools': opts.devtools = false; break;
      case '--seconds': {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new UsageError('The --seconds flag needs a number');
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

async function validate(opts: Opts): Promise<number> {
  if (opts.args.length === 0) throw new UsageError('The validate command needs at least one path');
  // In the order given. A web address is fetched; a path may be a
  // directory to search.
  const sources: ScriptSource[] = [];
  for (const arg of opts.args) {
    if (REMOTE_SCRIPT.test(arg)) sources.push(...await scriptSources([arg]));
    else for (const file of await collectScripts([arg])) sources.push({ label: rel(file), file });
  }
  if (sources.length === 0) throw new UsageError('No *.user.js files found');
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

// A `run` or `match` argument that names a script rather than a page.
const SCRIPT_ARG = /\.user\.js$/i;

// `run` and `match` arguments: scripts, and the URLs the rest are.
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
async function match(opts: Opts): Promise<number> {
  const { scripts, urls } = scriptsAndUrls(opts.args);
  if (scripts.length === 0 || urls.length === 0) {
    throw new UsageError('The match command needs a script (a .user.js file) and at least one URL');
  }
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

async function runCommand(opts: Opts): Promise<number> {
  const { scripts, urls } = scriptsAndUrls(opts.args);
  if (opts.noScript && scripts.length > 0) throw new UsageError('The --noscript flag runs no scripts, so the run command takes none with it');
  if (!opts.noScript && scripts.length === 0) throw new UsageError('The run command needs at least one script (a .user.js file), or --noscript');
  if (opts.all && urls.length > 0) throw new UsageError('The --all flag opens each script\'s own page, so it can\'t be used with a URL');
  const remote = scripts.find((s) => REMOTE_SCRIPT.test(s));
  if (remote) throw new UsageError(`The run command loads scripts from files, and ${remote} is a URL. Save it to a file first.`);
  // Flags that would silently do nothing, or wait out --fire-menu's
  // grace period for a command nothing can register.
  const clash = (flag: string, others: [boolean, string][]): void => {
    const used = others.filter(([on]) => on).map(([, name]) => name);
    if (used.length > 0) throw new UsageError(`The ${flag} flag can't be used with ${used.join(' or ')}`);
  };
  if (opts.noTab) clash('--notab', [[opts.all, '--all'], [urls.length > 0, 'a URL'], [Boolean(opts.fireMenu), '--fire-menu']]);
  if (opts.noScript) {
    clash('--noscript', [
      [opts.all, '--all'], [Boolean(opts.fireMenu), '--fire-menu'], [Boolean(opts.values), '--values'],
      [opts.watch, '--watch'], [opts.extension, '--extension'], [opts.solo, '--solo'],
    ]);
  }
  // Asked for by name, it must be able to run; on by default from the
  // environment, it just sits out the runs it can't serve.
  if (opts.devtools === true) clash('--devtools', [[opts.launch, '--launch'], [opts.extension, '--extension']]);
  const devtools = devtoolsWanted(opts.devtools) && !opts.launch && !opts.extension;
  const files = await Promise.all(scripts.map(scriptFile));
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
      fireMenu: opts.fireMenu,
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
      onConnected: () => {
        process.once('SIGINT', onSigint!);
        process.once('SIGTERM', onSigint!);
      },
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onSigint) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
    }
  }
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
  // `-`: each command sent as its line is read, a terminal included.
  if (words.length === 1 && words[0] === '-') {
    const target = named ? namedRun(runs, args[0], runIdOf) : onlyRun(runs, 'sm-dev send <run> -');
    return sendAsRead(target.id, sendLine);
  }
  // A list of commands: one argument of several lines, or piped stdin,
  // checked in full before any is sent. Stdin with no arguments only
  // when it isn't a terminal, which would sit waiting for a command
  // someone forgot to type. Several arguments are one command, so
  // eval's JavaScript can be one multi-line argument.
  const fromStdin = words.length === 0 && !process.stdin.isTTY;
  if (words.length === 0 && !fromStdin) throw new UsageError(NOTHING_TO_SEND);
  const pickTarget = () => (named ? namedRun(runs, args[0], runIdOf) : onlyRun(runs, 'sm-dev send <run> <command>'));
  // Before reading stdin, so a wrong run is said at once, not once the
  // input ends.
  const early = fromStdin ? pickTarget() : null;
  const listed = fromStdin ? await readStdin() : words.length === 1 && words[0].includes('\n') ? words[0] : null;
  const list = listed === null ? null : parseCommandList(listed);
  if (list && 'error' in list) throw new UsageError(list.error);
  if (list?.commands.length === 0) throw new UsageError(NOTHING_TO_SEND);
  const target = early ?? pickTarget();
  if (list) {
    // In order, each done before the next is sent, and each one's
    // output headed by the command as it was written.
    for (const command of list.commands) {
      for (const line of echoCommand(command)) print(line);
      await sendLine(target.id, command.text, print);
    }
    return 0;
  }
  // The words go as the shell gave them, so a selector or text with
  // spaces reaches a page command as one word.
  await sendLine(target.id, words.join(' '), print, undefined, words);
  return 0;
}

/**
 * `send -`: stdin's commands sent one at a time as each is read, so at
 * a terminal each runs on Enter, as at the run's own prompt. A mistake
 * (a `{{` after another command) is said and the rest go on, since the
 * commands before it have run already. 1 when there was one.
 */
async function sendAsRead(
  id: string,
  sendLine: (id: string, line: string, out: (line: string) => void) => Promise<void>,
): Promise<number> {
  const { createInterface } = await import('node:readline');
  const blocks = new CommandAssembler();
  // Typed commands are on screen already; piped ones get a heading.
  const echo = !process.stdin.isTTY;
  let failed = false;
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    const got = blocks.push(line);
    if (!got) continue;
    if ('error' in got) {
      failed = true;
      print(got.error);
      continue;
    }
    if (echo) for (const l of echoCommand(got.command)) print(l);
    await sendLine(id, got.command.text, print);
  }
  const unclosed = blocks.drop();
  if (unclosed !== null) {
    print(`${unclosedBlockMessage(unclosed)}, so it was not run`);
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

const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * What a help request asks about, or null when it isn't one; empty for
 * the whole help. Looked for before the flags are parsed, so a mistake
 * elsewhere on the line doesn't stand in the way:
 *   - `help status tabs`: each named command.
 *   - `status --help`, `--help status`: the one command. Only the
 *     first word, since a command's own words (a script path) follow.
 *   - `send --help`, but not the flag further on, where it may be part
 *     of the command sent.
 */
function helpTopics(argv: string[]): string[] | null {
  if (argv[0] === 'help') return argv.slice(1).filter((a) => !HELP_FLAGS.has(a));
  const asked = argv[0] === 'send' ? HELP_FLAGS.has(argv[1]) : argv.some((a) => HELP_FLAGS.has(a));
  if (!asked) return null;
  const first = argv.find((a) => !a.startsWith('-'));
  return first ? [first] : [];
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
  const topics = helpTopics(argv);
  if (topics) {
    try {
      process.stdout.write(topics.length === 0 ? usage() : commandHelp(topics));
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 2;
    }
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
  if (opts.command === null) {
    process.stdout.write(usage());
    process.exitCode = 2;
    return;
  }
  try {
    switch (opts.command) {
      case 'validate': process.exitCode = await validate(opts); break;
      case 'match': process.exitCode = await match(opts); break;
      case 'run': process.exitCode = await runCommand(opts); break;
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
