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
//   - A run reaches the real SourceMonkey, which runs its scripts,
//     through extension-link.ts.
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
  commandWords, managerCommandOf, managerCommand, onlyInspects, PROMPT_READY, PROMPT_STARTED, readPromptCommands, runCommandHelp, runCommandMistake, runLogLabelUi, setJsonOutput, writeOutputLine,
} from './console-commands.js';
import { parseLang } from './browser-lang.js';
import { helpRequest, parseCommandArgs, splitWords } from './command-args.js';
import { DEFAULT_MANAGER, MANAGERS, managerMistake, managerNamed, type ManagerName } from './managers.js';
import type { ManagerVerb } from './manager-actions.js';
import type { ManagerControl } from './manager-commands.js';
import { COMMAND_NAMES, MAX_TIMER_SECONDS, OWN_COMMANDS, RUN_COMMAND_NAMES, SHARED_COMMANDS, TIMEOUT_FLAG, TIMEOUT_NEEDS_SECONDS, GLOBAL_FLAGS, VALUE_GLOBALS, commandHelp, commandNamed, commandSyntax, globalFlagMistake, helpTarget, helpText, timeoutSecondsMs, unsupportedCommand } from './command-list.js';
import { readJsonFile } from './input-file.js';
import { echoLine, err as errorLine, ERROR_PREFIX, paintOutput, quoted, SM_DEV_PREFIX, streamHasColor } from './output-style.js';
// The roles for marked-up output, as S.id(...): their names are common locals here.
import * as S from './output-style.js';
import { isJsonLine, jsonLayoutMistake, jsonResult, jsonResultData, STDERR_LINE, withLayout, type JsonLayout, type BrowserStatus, type ListData, type MatchData, type RunConnection, type StatusData, type StatusRunsData } from './json-output.js';
// Node built-ins only, so as cheap to load as the rest here.
import { runIdOf, type CommandSource, type RunClient, type RunRecord } from './runs.js';
import { parseLogSources, type LogSource } from './run-logs.js';
import { preparedScriptName, withDefaultScheme } from './prepare.js';
import { pagesToOpen, type PageWord, type SavedPageStart } from './saved-pages.js';
import {
  REMOTE_SCRIPT, SCRIPT_ARG, UsageError, expandPathArg, matchJson, matchLines, prepareSource, scriptFile, scriptSources, validateAll, validateSources,
  type ScriptRoots,
} from './checks.js';


// A line to stderr, painted for it as writeOutputLine paints stdout's.
function writeErr(line: string): void {
  process.stderr.write(paintOutput(line, streamHasColor(process.stderr)) + '\n');
}

// After a mistake, in place of the whole help, which would bury it.
const LIST_COMMANDS = 'Use `sm-dev help commands` to list the commands.';

// Whether help goes to a terminal that shows color (see streamHasColor).
function helpInColor(): boolean {
  return streamHasColor(process.stdout);
}

// `sm-dev help [topic|command [subcommand]]`, or the mistake for words
// that name none.
function helpFor(words: string[]): string {
  const target = helpTarget(words);
  if (target && 'error' in target) throw new UsageError(target.error);
  return helpText(target, helpInColor());
}

// `<command> <words> --help`: the command's help, or its subcommand's
// when the words name one, or the mistake for a name that is none.
function commandHelpFor(command: string, words: string[] = []): string {
  if (!commandNamed(command)) throw new UsageError(`${quoted(command)} is not a command. ${LIST_COMMANDS}`);
  // With `--help` back on, so a flag the subcommand doesn't take
  // doesn't stand in the way of its help.
  const request = helpRequest(commandNamed(command)!, { words: [...words, '--help'] });
  if ('error' in request) throw new UsageError(request.error);
  return commandHelp(request.command, request.subcommand, helpInColor());
}

interface Opts {
  command: string | null;
  args: string[];
  /** `--help`: show the command's help rather than run it. */
  help?: boolean;
  all: boolean;
  noTab: boolean;
  cdp?: string;
  watch: boolean;
  values?: Record<string, unknown>;
  /** Which flag gave `values`, to name in messages. */
  valuesFlag?: string;
  /** `--log-source`: on start, what the run's stream shows; on attach, what this client shows of it. */
  logSources?: ReadonlySet<LogSource>;
  seconds?: number;
  detach: boolean;
  /** `start --nowait`: ready once the scripts start, without settling. */
  noWait: boolean;
  /** `--timeout-seconds`, in ms: each of start's waits on its tabs. */
  timeoutMs?: number;
  /** `match --frames`: a tab's iframes too, which only a run has. */
  frames?: boolean;
  /** `--new`: start beside earlier detached runs, not in their place. */
  newRun: boolean;
  /** `--stop-after-idle-seconds`. */
  idleSeconds?: number;
  /** `--from-saved`: the `.html` files among the pages are opened as saved pages. */
  fromSaved: boolean;
  /** `--url`: with `fromSaved` and one saved page, the URL to serve it at. */
  url?: string;
  /** `--offline`: with `fromSaved`, the saved pages' network requests are blocked. */
  offline: boolean;
  /** `--lang`: the languages the run's tabs prefer. */
  lang?: string[];
  /** `--json` (true) or `--nojson` (false), over the global `--json`. */
  json?: boolean;
  /** `--json=single` or `=multi`, over the global one. */
  jsonLayout?: JsonLayout;
}

// The commands' flags that take a value, for finding the command's
// name past the flags that may come before it: sm-dev's own (`--detach
// start`), and a run's, to say where one put first goes (`--find x logs`).
const OWN_VALUE_FLAGS = new Set([...OWN_COMMANDS, ...RUN_COMMAND_NAMES].flatMap((name) => Object.entries(commandSyntax(name).flags)
  .filter(([, kind]) => kind === 'value').map(([flag]) => flag)));
// Every command's flags.
const COMMAND_FLAGS = new Set([...OWN_COMMANDS, ...RUN_COMMAND_NAMES].flatMap((name) => Object.keys(commandSyntax(name).flags)));

// Where the command's name is in `argv`: the first word that is no
// flag, nor a flag's value. Past the end when there is none.
function commandIndex(argv: string[]): number {
  let at = 0;
  while (at < argv.length && argv[at].startsWith('-')) at += OWN_VALUE_FLAGS.has(argv[at]) ? 2 : 1;
  return at;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    command: null, args: [],
    all: false, noTab: false, watch: false, detach: false, newRun: false, noWait: false, fromSaved: false, offline: false,
  };
  const at = commandIndex(argv);
  // None: said by the caller, as is a name that is no command of sm-dev's own.
  if (at >= argv.length) return opts;
  opts.command = argv[at];
  const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
  if (!OWN_COMMANDS.has(opts.command)) {
    opts.args = rest;
    return opts;
  }
  const parsed = parseCommandArgs(opts.command, { words: rest });
  if ('error' in parsed) {
    const flag = parsed.flag;
    // One for the whole line, which this command doesn't take itself.
    if (flag && GLOBAL_FLAGS.includes(flag) && !Object.hasOwn(commandSyntax(opts.command).flags, flag)) throw new UsageError(globalFlagMistake(flag));
    // Once a start flag; a start given no scripts is one now.
    if (flag === '--noscript' && opts.command === 'start') throw new UsageError('The start command no longer takes --noscript. Give it no scripts to start without any.');
    throw new UsageError(parsed.error);
  }
  if (parsed.help) {
    opts.help = true;
    return opts;
  }
  opts.args = parsed.words;
  // A single-dash word is no argument of these commands' (`-x`).
  const dashed = opts.args.find((word) => /^-./.test(word));
  if (dashed) throw new UsageError(`Unknown option: ${quoted(dashed)}`);
  for (const [flag, value] of Object.entries(parsed.flags)) {
    // Each flag's syntax, value or none, is its help's (command-list.ts).
    const text = typeof value === 'string' ? value : '';
    switch (flag) {
      case '--all': opts.all = true; break;
      case '--notab': opts.noTab = true; break;
      case '--browser': opts.cdp = text; break;
      case '--watch': opts.watch = true; break;
      case '--values':
      case '--values-file': {
        if (opts.valuesFlag) throw new UsageError(`The ${quoted(flag)} flag can't be used with ${quoted(opts.valuesFlag)}`);
        let given: unknown;
        if (flag === '--values') {
          try {
            given = JSON.parse(text);
          } catch {
            throw new UsageError('The --values flag needs a JSON object');
          }
        } else {
          try {
            given = readJsonFile(path.resolve(text), text);
          } catch (err) {
            throw new UsageError((err as Error).message);
          }
        }
        if (!given || typeof given !== 'object' || Array.isArray(given)) {
          throw new UsageError(flag === '--values' ? 'The --values flag needs a JSON object' : `The file ${text} needs to hold a JSON object, e.g. {"units":"metric"}`);
        }
        opts.values = given as Record<string, unknown>;
        opts.valuesFlag = flag;
        break;
      }
      case '--log-source': {
        const sources = parseLogSources(text);
        if ('error' in sources) throw new UsageError(sources.error as string);
        opts.logSources = sources;
        break;
      }
      case '--detach': opts.detach = true; break;
      case '--new': opts.newRun = true; break;
      case '--nowait': opts.noWait = true; break;
      case '--timeout-seconds': {
        const ms = timeoutSecondsMs(text);
        if (ms === null) throw new UsageError(TIMEOUT_NEEDS_SECONDS);
        opts.timeoutMs = ms;
        break;
      }
      case '--from-saved': opts.fromSaved = true; break;
      case '--url': opts.url = text; break;
      case '--offline': opts.offline = true; break;
      case '--frames': opts.frames = true; break;
      case '--json': {
        opts.json = true;
        if (!text) break;
        const mistake = jsonLayoutMistake(text);
        if (mistake) throw new UsageError(mistake);
        opts.jsonLayout = text as JsonLayout;
        break;
      }
      case '--nojson': opts.json = false; break;
      case '--lang':
        try {
          opts.lang = parseLang(text);
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
        break;
      case '--stop-after-idle-seconds': {
        const v = Number(text);
        if (!text || !Number.isFinite(v) || v < 0) throw new UsageError('The --stop-after-idle-seconds flag needs a number of seconds');
        if (v > MAX_TIMER_SECONDS) throw new UsageError(`The --stop-after-idle-seconds flag can be at most ${MAX_TIMER_SECONDS}`);
        opts.idleSeconds = v;
        break;
      }
      case '--stop-after-seconds': {
        const v = Number(text);
        if (!text || !Number.isFinite(v) || v < 0) throw new UsageError('The --stop-after-seconds flag needs a number');
        if (v > MAX_TIMER_SECONDS) throw new UsageError(`The --stop-after-seconds flag can be at most ${MAX_TIMER_SECONDS}`);
        opts.seconds = v;
        break;
      }
    }
  }
  return opts;
}

function checkValidate(opts: Opts): void {
  if (opts.args.length === 0) throw new UsageError(VALIDATE_NEEDS);
}

async function validate(opts: Opts): Promise<number> {
  checkValidate(opts);
  return validateAll(await validateSources(opts.args), lineRoots, jsonPrint(opts), opts.json ?? lineJson);
}

// `start` and `match` arguments: scripts, and the URLs the rest are,
// after globs are expanded and directories searched for scripts.
// `pages`: the rest as typed, beside their URLs. `found`: the scripts
// that came from a directory search or a glob rather than being named,
// which `start` skips when they're invalid.
function scriptsAndUrls(words: string[]): { scripts: string[]; urls: string[]; pages: PageWord[]; found: Set<string> } {
  const searched = new Set<string>();
  const named = new Set<string>();
  const args = [...new Set(words.flatMap((word) => {
    const out = expandPathArg(word, process.cwd(), { scripts: true });
    for (const a of out) (out.length === 1 && out[0] === word ? named : searched).add(path.resolve(a));
    return out;
  }))];
  // Each once, so a repeat is neither checked nor opened twice.
  const pages = new Map<string, PageWord>();
  for (const word of args.filter((a) => !SCRIPT_ARG.test(a))) {
    // A script misnamed would otherwise be opened as a page, leaving
    // the run with no scripts.
    if (/\.js$/i.test(word) && !/^[a-z][a-z0-9+.-]*:/i.test(word)) throw new UsageError(`${quoted(word)} is not a userscript: Its name doesn't end in .user.js`);
    const url = withDefaultScheme(word);
    if (!pages.has(url)) pages.set(url, { word, url });
  }
  // Each once too, by the file it names, so `x.user.js ./x.user.js` is
  // one script (the extension keeps a run's scripts by the path typed).
  // The first spelling is kept.
  const scripts = new Map<string, string>();
  for (const word of args.filter((a) => SCRIPT_ARG.test(a))) {
    const file = path.resolve(word);
    if (!scripts.has(file)) scripts.set(file, word);
  }
  return {
    scripts: [...scripts.values()],
    urls: [...pages.keys()],
    pages: [...pages.values()],
    // A script named outright is never skipped, though a search found it too.
    found: new Set([...scripts.values()].filter((w) => searched.has(path.resolve(w)) && !named.has(path.resolve(w)))),
  };
}

// Every script against every URL, in the order given. Arguments can
// come in any order: a `.user.js` one (or a directory of them) is a
// script, the rest are URLs.
function checkMatch(opts: Opts): void {
  const { scripts, urls } = scriptsAndUrls(opts.args);
  if (scripts.length === 0 || urls.length === 0) {
    throw new UsageError(MATCH_NEEDS);
  }
  if (opts.frames) throw new UsageError(MATCH_FRAMES_NEEDS_RUN);
}

async function match(opts: Opts): Promise<number> {
  checkMatch(opts);
  const { scripts, urls } = scriptsAndUrls(opts.args);
  const sources = await scriptSources(scripts);
  if (opts.json ?? lineJson) {
    const results: MatchData['results'] = [];
    for (const source of sources) {
      const prepared = await prepareSource(source, lineRoots);
      results.push({ script: source.label, name: preparedScriptName(prepared), ...matchJson(prepared, urls.map((url) => ({ url }))) });
    }
    jsonPrint(opts)(jsonResult('match', { results } satisfies MatchData));
    return results.every((r) => r.valid && r.pages.every((p) => p.matches)) ? 0 : 1;
  }
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
 * `start`: a run in a background process of its own, which it connects
 * to (see Client). It replaces the run the client works with, under the
 * same id; else, with `--detach`, the earlier detached runs, unless
 * `--new`. `words` are the command's own, for that process.
 */
async function startCommand(opts: Opts, words: string[], client: Client): Promise<number> {
  const { urls, files, scripts, saved, found } = await checkStart(opts);
  // The background process: the run itself.
  if (detachedLog) return runHere(opts, { files, given: scripts, urls, saved, found }, client.runId);
  const { liveRuns, stopRun } = await import('./runs.js');
  const live = await liveRuns();
  // Stopped first, which also frees a tab for this one to reuse. The
  // new one takes the id of the one it replaces.
  const id = client.runId;
  const replaced = id !== undefined ? live.filter((r) => r.id === id)
    : opts.detach && !opts.newRun ? live.filter((r) => r.detached) : [];
  await client.disconnect();
  for (const old of replaced) {
    // Named, stopRun's own line says enough.
    if (id === undefined) print(`[sm-dev] ${S.ui`Stopping the earlier detached run ${S.id(old.id)}`}`);
    await stopRun(old, print, true);
    client.stopped(old.id);
  }
  // The values as read here, not the file again: a pipe or `<(...)`
  // is spent by now, and the process doesn't inherit it anyway.
  const valuesAt = words.indexOf('--values-file');
  const sent = valuesAt < 0 ? words : [...words.slice(0, valuesAt), '--values', JSON.stringify(opts.values), ...words.slice(valuesAt + 2)];
  const started = await detachRun(sent, id);
  if (!started.id) return started.code;
  client.started(started.id, started.log, started.exited, { detached: opts.detach, lasting: opts.seconds !== undefined, hold: started.hold });
  if (opts.detach) {
    const idle = opts.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    print(`[sm-dev] ${S.ui`Run ${S.id(started.id)} now running detached, with ${idle > 0 ? `idle timeout ${duration(idle)}` : 'no idle timeout'}`}`);
    print(`[sm-dev] ${S.ui`Output log: ${runLogLabelUi(started.log, started.id)}`}`);
  }
  // Following its stream from here, when the line does more than look.
  if (client.follow) await client.connect();
  return 0;
}

// `start`'s arguments and flags, checked: its URLs, and its script
// files, which must exist. Also done before a line of several commands
// runs any.
async function checkStart(opts: Opts): Promise<{ urls: string[]; files: string[]; scripts: string[]; saved: (SavedPageStart | null)[]; found: string[] }> {
  const { scripts, urls, pages, found } = scriptsAndUrls(opts.args);
  if (opts.all && urls.length > 0) throw new UsageError('The --all flag opens each script\'s own page, so it can\'t be used with a URL');
  const remote = scripts.find((s) => REMOTE_SCRIPT.test(s));
  if (remote) throw new UsageError(`The start command loads scripts from files, and ${remote} is a URL. Save it to a file first.`);
  // Flags that contradict another, or would silently do nothing with it.
  const clash = (flag: string, others: [boolean, string][]): void => {
    const used = others.filter(([on]) => on).map(([, name]) => name);
    if (used.length > 0) throw new UsageError(`The ${quoted(flag)} flag can't be used with ${used.map((f) => (f.startsWith('--') ? quoted(f) : f)).join(' or ')}`);
  };
  if (opts.noTab) clash('--notab', [[opts.all, '--all'], [urls.length > 0, 'a URL']]);
  // With no scripts, just a browser to drive: the flags that act on
  // scripts would do nothing.
  if (scripts.length === 0) {
    const used = ([
      [opts.all, '--all'], [Boolean(opts.values), opts.valuesFlag ?? '--values'],
      [opts.watch, '--watch'],
    ] as [boolean, string][]).filter(([on]) => on).map(([, name]) => name);
    if (used.length > 0) throw new UsageError(`The start command was given no scripts, so it can't take ${used.join(' or ')}`);
  }
  if (lineManager !== undefined && lineManager !== 'sourcemonkey' && opts.values) {
    throw new UsageError(`The ${quoted(opts.valuesFlag ?? '--values')} flag works with SourceMonkey only, and ${quoted('--manager')} names ${MANAGERS[lineManager].label}`);
  }
  if (tempBrowserLine() && (opts.cdp ?? lineCdp) !== undefined) {
    // A temp browser's own port, which must be free.
    const { launchEndpointMistake } = await import('./browser-launch.js');
    const { cdpEndpoint } = await import('./run.js');
    const mistake = launchEndpointMistake(cdpEndpoint((opts.cdp ?? lineCdp)!), '--browser', 'A temp browser starts');
    if (mistake) throw new UsageError(mistake);
  }
  if (lineOpenBrowser && opts.cdp !== undefined) throw new UsageError('The `start` command connects to the browser `--open-browser` starts, so give `--browser` once, first: `sm-dev --open-browser --browser ... start ...`');
  if (!opts.detach && !detachedLog && opts.newRun) throw new UsageError('The `--new` flag only applies with `--detach`');
  const files = await Promise.all(scripts.map((s) => scriptFile(s)));
  if (opts.fromSaved) clash('--from-saved', [[opts.all, '--all'], [opts.noTab, '--notab']]);
  // Read before the run starts, so a file that can't be opened is said now.
  const opened = await pagesToOpen(pages, opts);
  return {
    urls: opened.map((p) => p.url), files, scripts, saved: opened.map((p) => p.saved ?? null),
    found: files.filter((_, i) => found.has(scripts[i])),
  };
}

// The run, in the background process `start` began: until a client
// sends `stop`, a signal, `--stop-after-seconds`, or its idle timeout. Given the
// scripts' files (and each as typed), and the pages to open with the
// saved page each serves, if any.
async function runHere(
  opts: Opts,
  { files, given, urls, saved, found }: { files: string[]; given: string[]; urls: string[]; saved: (SavedPageStart | null)[]; found: string[] },
  runId: string | undefined,
): Promise<number> {
  // The run has no input: commands come from its clients.
  process.stdin.destroy();
  const { run } = await import('./run.js');
  // Ends on stop, a signal, or after --stop-after-seconds. The timer is
  // unreferenced so it can't hold the process open after an early
  // exit, and the listener comes off once the run has ended.
  let onSigint: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stop: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    // Also drops the signal handlers, so while a stopped run tears
    // down, a second signal kills it rather than landing here again.
    stop = () => {
      if (onSigint) {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigint);
      }
      resolve();
    };
    // SIGTERM too, so a plain kill (or sm-dev stop, for a run it
    // can't reach) still ends the run cleanly. Set once the run has
    // connected: before that there is nothing to clean up, and a
    // signal ends it at once, as it would any command (a wait for a
    // stuck tab, say).
    onSigint = () => stop();
    onOutputClosed = stop;
    if (opts.seconds !== undefined) timer = setTimeout(resolve, opts.seconds * 1000).unref();
  });
  // The run ends itself once nothing has been sent it for a while, so
  // one a client forgot (or a client that was killed) doesn't hold the
  // browser for good. Counted from the start, and restarted as each
  // command starts and ends; held off while a client follows the run.
  const idleSeconds = opts.idleSeconds ?? DEFAULT_IDLE_SECONDS;
  let idleTimer: NodeJS.Timeout | null = null;
  let watched = false;
  const touch = (following = watched): void => {
    watched = following;
    if (idleSeconds <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (watched) {
        touch();
        return;
      }
      writeOutputLine(`[sm-dev] Stopping: no command was sent for ${duration(idleSeconds)}`);
      stop();
    }, idleSeconds * 1000).unref();
  };
  touch();
  try {
    return await run({
      files,
      given,
      found: new Set(found),
      urls,
      saved,
      all: opts.all,
      noTab: opts.noTab,
      cdp: opts.cdp ?? lineCdp,
      manager: lineManager,
      tempBrowser: tempBrowserLine(),
      headed: launchHeaded(),
      muted: lineMuted,
      lang: opts.lang,
      watch: opts.watch,
      values: opts.values,
      logSources: opts.logSources,
      collectionRoot: lineRoots.collectionRoot,
      localRoots: lineRoots.localRoots,
      out: writeOutputLine,
      markup: true,
      until,
      onStop: () => stop(),
      onActivity: touch,
      detached: opts.detach,
      log: detachedLog ?? undefined,
      runId,
      primaryPid,
      noWait: opts.noWait,
      timeoutMs: opts.timeoutMs,
      // Tells the client that started it, which then goes on. One that
      // has gone (killed, say) leaves the run going unannounced, rather
      // than crashing it on the closed channel.
      onReady: (id) => {
        if (!process.connected) return;
        process.send?.({ ready: id ?? null }, (err: Error | null) => {
          if (!err && process.connected) process.disconnect();
        });
      },
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
const primaryPid = Number(process.env.SM_DEV_PRIMARY_PID) || undefined;
delete process.env.SM_DEV_PRIMARY_PID;
if (detachedLog) {
  const { timestampOutputLines } = await import('./run-log.js');
  timestampOutputLines();
}

// `--stop-after-idle-seconds` as the messages say it: whole minutes as minutes.
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
async function detachRun(words: string[], runId: string | undefined): Promise<{ code: number; id?: string; log: string; exited: Promise<number>; hold?: () => void }> {
  const { createRunLog, LOG_LINE_PREFIX } = await import('./run-log.js');
  const { spawn } = await import('node:child_process');
  const { open } = await import('node:fs/promises');
  const { file: log, handle: writing } = await createRunLog();
  const reading = await open(log, 'r');
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...globalWords(runId), ...words], {
    // Its own process group, so a Ctrl-C or closed terminal here
    // doesn't reach it once it is detached. No console window of its
    // own on Windows.
    detached: true,
    windowsHide: true,
    stdio: ['ignore', writing.fd, writing.fd, 'ipc'],
    // This process, as the client that started the run, whose commands
    // it marks as the primary's.
    // Never color in its log, whatever FORCE_COLOR asks of this process.
    env: { ...process.env, SM_DEV_DETACHED_LOG: log, SM_DEV_PRIMARY_PID: String(process.pid), FORCE_COLOR: '0' },
  });
  await writing.close();
  let ready: { id: string | null } | null = null;
  let exitCode: number | null = null;
  child.on('message', (m: { ready?: string | null }) => { if (m && 'ready' in m) ready = { id: m.ready ?? null }; });
  // Its exit code, for a client that waits for it to end (--stop-after-seconds),
  // which keeps this process alive meanwhile.
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      exitCode = code ?? 1;
      resolve(exitCode);
    });
    child.on('error', () => {
      exitCode ??= 1;
      resolve(exitCode);
    });
  });
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
    // Closed first: the handlers come off only with nothing left to
    // await, so no signal lands between them and the caller taking the
    // run on as its own.
    await reading.close();
    for (const signal of STOP_SIGNALS) process.off(signal, interrupt);
  }
  if (interrupted && ready === null) return { code: 130, log, exited };
  // Ended before it was ready, with nothing wrong: `--stop-after-seconds 0`, say.
  if (ready === null) return { code: exitCode || 1, log, exited };
  const { id } = ready as { id: string | null };
  if (id === null) {
    // It printed why; unreachable, it could only be killed.
    child.kill('SIGTERM');
    return { code: 1, log, exited };
  }
  child.unref();
  return { code: 0, id, log, exited, hold: () => child.ref() };
}

const NO_RUNS = 'No sm-dev runs are active';

// What a closed stdout does: ends the command. A run swaps in its own
// stop, so it still tears down (and says so to any `sm-dev stop`).
let onOutputClosed = (): void => process.exit(process.exitCode ?? 0);

// Drawn around the prompt, when one is showing.
function print(line: string): void {
  writeOutputLine(line);
}

// A command echoed before its output (`arg > status`, a block's `...`
// lines): to stderr under --json, so stdout holds only the results.
function echo(line: string): void {
  print(lineJson ? STDERR_LINE + line : line);
}

// `print`, with a result laid out as the command's own `--json=` said.
function jsonPrint(opts: Opts): (line: string) => void {
  return (line) => print(opts.jsonLayout && isJsonLine(line) ? withLayout(line, opts.jsonLayout) : line);
}

async function listCommand(opts: Opts): Promise<number> {
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (opts.json ?? lineJson) {
    jsonPrint(opts)(jsonResult('list', {
      runs: runs.map((r) => ({
        id: r.id,
        pid: r.pid,
        started: new Date(r.started).toISOString(),
        browser: { address: r.browser.replace(/^https?:\/\//, ''), owned: r.owned === true, headless: r.headless === true },
        manager: r.manager ?? DEFAULT_MANAGER,
        ...(r.tabs === undefined ? {} : { tabCount: r.tabs }),
        scriptFiles: r.scripts,
      })),
    } satisfies ListData));
    return 0;
  }
  if (runs.length === 0) print(NO_RUNS);
  else for (const line of runTable(runs, Date.now(), { markup: true })) print(line);
  return 0;
}

/**
 * The sm-dev process as a client of runs. It works with one run at a
 * time, and connects to it once a command needs it: the run `--run`
 * names, else the one it started or attached to, else the only one
 * going. `start` connects to the run it starts, in place of the one it
 * had (which, under the same id, it replaces); `attach` switches; `stop`
 * leaves it with none. A run it started without `--detach` is stopped
 * when it exits.
 */
class Client {
  /** The run it works with, once there is one. */
  runId: string | undefined;
  /** Whether it started the run it works with, which then has the line's `--root` and `--local`. */
  own = false;
  /** The run `attach` attached it to, for `status` to say so. */
  attachedTo: string | undefined;
  /** Set by `exit`: the commands after it aren't run. */
  exiting = false;
  /** The log sources it shows of its run's stream (`attach --log-source`); the run's own when unset. */
  logSources: ReadonlySet<LogSource> | undefined;
  private connection: RunClient | null = null;
  /** Runs it started without `--detach`, with their logs and exit codes. */
  private readonly owned = new Map<string, { log: string; exited: Promise<number>; hold?: () => void }>();
  /** Set by a `start` with `--stop-after-seconds`, whose run ends on its own. */
  private lasting: string | undefined;

  /**
   * `follow`: connect for the run's whole stream, as decided for the
   * line up front.
   */
  constructor(runId: string | undefined, readonly follow: boolean) {
    this.runId = runId;
  }

  /**
   * The connection to its run, made now if need be: `wanted`'s, else the
   * one it works with, else the only one going. Works with it from then
   * on; one that can't be reached leaves the client as it was.
   */
  async connect(wanted = this.runId): Promise<RunClient> {
    if (this.finishing) throw new Error('This sm-dev is exiting');
    if (this.connection?.open && this.connection.id === (wanted ?? this.connection.id)) return this.connection;
    const target = await targetRun(wanted);
    await checkRunBrowser(target);
    checkRunManager(target);
    const { RunClient } = await import('./runs.js');
    const connection = await RunClient.open(target.id, print, { follow: this.follow, logSources: this.logSources, markup: true });
    await this.disconnect();
    this.connection = connection;
    this.runId = target.id;
    return connection;
  }

  /** Waits for its run to end on its own (or be stopped from elsewhere). */
  async watch(): Promise<void> {
    await this.connection?.ended;
  }

  /** Sends one of a run's commands, from `source`; its exit code. */
  async send(text: string, source: CommandSource, words?: string[]): Promise<number> {
    if (rootsGiven && !this.own) throw new UsageError(ROOTS_ARE_THE_RUNS);
    if (this.toEveryRun(text)) return statusWithoutRun(words ?? commandWords(text), source);
    const connection = await this.connect();
    if (commandWords(text)[0] !== 'status') return connection.send(text, { words, source, json: lineJson });
    // Headed by how this sm-dev came to the run.
    const { liveRuns } = await import('./runs.js');
    const detached = (await liveRuns()).find((r) => r.id === connection.id)?.detached === true;
    const how: RunConnection = this.own ? 'started' : this.attachedTo === connection.id ? 'attached' : 'selected';
    return connection.send(text, { words, source, json: lineJson, rewrite: statusHeading(how, detached) });
  }

  /**
   * Whether a command needs no run of its own: `status`, with no run
   * picked yet, which shows the browser and every run.
   */
  toEveryRun(text: string): boolean {
    return this.runId === undefined && commandWords(text)[0] === 'status';
  }

  /** Drops the connection, leaving the run going. */
  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }

  /** The run it works with, when it is connected to one. */
  get connected(): string | undefined {
    return this.connection?.open ? this.connection.id : undefined;
  }

  /** A run it just started: stopped on exit unless `detached`. */
  started(id: string, log: string, exited: Promise<number>, { detached, lasting, hold }: { detached: boolean; lasting: boolean; hold?: () => void }): void {
    this.runId = id;
    this.own = true;
    if (!detached) this.owned.set(id, { log, exited, hold });
    this.lasting = lasting && !detached ? id : undefined;
  }

  /**
   * A run that has been stopped, and so is no longer one to work with.
   * Its log, when this started it.
   */
  stopped(id: string): string | undefined {
    const log = this.owned.get(id)?.log;
    this.owned.delete(id);
    if (this.lasting === id) this.lasting = undefined;
    if (this.runId === id) {
      this.runId = undefined;
      this.own = false;
    }
    return log;
  }

  /**
   * Waits for a run started with `--stop-after-seconds` to end on its own, as the
   * line's last word: its exit code. 0 when there is none.
   */
  async outlast(): Promise<number> {
    // Kept, since stopped() can clear lasting while this waits.
    const id = this.lasting;
    const run = id === undefined ? undefined : this.owned.get(id);
    if (!run) return 0;
    // Its stream, until it ends; waited for, so this process stays.
    await this.connect().catch(() => undefined);
    run.hold?.();
    const code = await run.exited;
    this.owned.delete(id!);
    await this.disconnect();
    print(`[sm-dev] ${S.ui`Output log: ${runLogLabelUi(run.log, id)}`}`);
    return code;
  }

  private finishing: Promise<number> | null = null;

  /**
   * Leaves: stops the runs it started without `--detach`. 1 when one
   * wouldn't stop. Once, however often asked (a Ctrl-C, then the end of
   * the line).
   */
  finish(): Promise<number> {
    this.finishing ??= this.stopOwned();
    return this.finishing;
  }

  private async stopOwned(): Promise<number> {
    this.exiting = true;
    const connection = this.connection;
    this.connection = null;
    await connection?.close({ force: true });
    const { liveRuns, stopRun } = await import('./runs.js');
    let code = 0;
    for (const [id, { log }] of this.owned) {
      const record = (await liveRuns()).find((r) => r.id === id);
      if (record && !await stopRun(record, print, true)) code = 1;
      print(`[sm-dev] ${S.ui`Output log: ${runLogLabelUi(log, id)}`}`);
    }
    this.owned.clear();
    return code;
  }
}

const NO_RUN_TO_USE = `${NO_RUNS}. Start one with ${quoted('sm-dev start')}.`;

// The run a command acts on: the one named, else the only one going.
async function targetRun(wanted: string | undefined): Promise<RunRecord> {
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (wanted !== undefined) {
    const found = runs.find((r) => r.id === wanted);
    if (!found) throw new Error(`There is no run ${quoted(wanted)}. Use ${quoted('sm-dev list')} to see the runs.`);
    return found;
  }
  if (runs.length === 0) throw new Error(NO_RUN_TO_USE);
  if (runs.length > 1) throw new UsageError(['Multiple runs are active. Pick one with --run, or attach to one:', ...runTable(runs)].join('\n'));
  return runs[0];
}

// A typed run ID as the run's id, or a usage error. A bare number is the
// likely slip, as with tabs, and gets a hint.
function checkedRunId(typed: string, flag = '--run '): string {
  const id = runIdOf(typed);
  if (id) return id;
  throw new UsageError(/^\d+$/.test(typed)
    ? `Runs are named D1, D2 and so on. Did you mean ${flag}D${typed}?`
    : `The run ID ${typed} is not valid. Run IDs are D and then letters, digits, _ or -.`);
}

function isTypedCommand(name: string): boolean {
  const command = commandNamed(name);
  return command !== null && RUN_COMMAND_NAMES.includes(command);
}

// Takes its arguments as typed, not through parseArgs: the command
// sent may have words of its own that look like flags (`set n -1`).
async function sendCommand(words: string[], client: Client): Promise<number> {
  const { liveRuns } = await import('./runs.js');
  await checkSend(words);
  // A list of several lines goes to a run whole, as before.
  const typed = words.length === 1 ? commandWords(words[0]) : words;
  if (!sentList(words) && typed[0] === 'manager') return managerVerbHere(typed, client);
  if (!sentList(words) && await listsHere(typed, client)) return managerHere(typed);
  // With no run to work with, what the command needs instead.
  const needs = NEEDS_A_RUN[words[0]];
  if (needs && client.runId === undefined && (await liveRuns()).length === 0) throw new UsageError(needs);
  const list = sentList(words);
  if (list) {
    // In order, each done before the next is sent, and each one's
    // output headed by the command as it was written. Stops at one that
    // failed (a `wait` that timed out), as a line of several does. The
    // exit code is the last one's.
    let code = 0;
    for (const [i, command] of list.commands.entries()) {
      for (const line of echoed('arg', command)) echo(line);
      code = await client.send(command.text, 'arg');
      if (stopsLine(code, commandWords(command.text))) {
        if (i < list.commands.length - 1) writeErr(LINE_STOPPED);
        return code;
      }
    }
    return code;
  }
  // The words go as the shell gave them, so a selector or text with
  // spaces reaches a page command as one word.
  return client.send(words.join(' '), 'arg', words);
}

/**
 * `status` with no run picked: the browser the line names, if any, with
 * its managers, then every active run's status, each headed `Other run:`.
 * Under --json, one result holding them all, so its shape depends only
 * on whether a run was picked. 1 when a run couldn't be read.
 */
async function statusWithoutRun(words: string[], source: CommandSource): Promise<number> {
  const { liveRuns, RunClient } = await import('./runs.js');
  // The command's own --json too, which the runs read.
  const json = lineJson || words.some((w) => /^--json(=|$)/.test(w));
  if (lineCdp !== undefined) await needBrowserWithoutRun('status');
  if (!json) print(S.message('No current run. (Use `start` or `attach` to connect to one.)'));
  // A temp browser comes with a run, so there's a browser to show only
  // when the line names one.
  const browser = lineOpenBrowser || lineExistingBrowser ? await browserStatus(json) : undefined;
  const runs = await liveRuns();
  if (!json) {
    // A blank line sets off a list of runs, not the line saying there are none.
    if (runs.length > 0) print('');
    print(runs.length === 0 ? 'No other active runs' : S.ui`${S.heading('Other active runs')}:`);
  }
  const statuses: StatusData[] = [];
  // The command's own --json=, which the runs' results carry too, but
  // there may be none.
  let layout = words.map((w) => /^--json=(single|multi)$/.exec(w)?.[1]).find(Boolean) as JsonLayout | undefined;
  let code = 0;
  for (const run of runs) {
    if (!json) print('');
    const out = (line: string): void => {
      const result = json ? jsonResultData(line) : null;
      if (!result) return print(line);
      statuses.push(result.data as unknown as StatusData);
      layout ??= result.layout;
    };
    try {
      const connection = await RunClient.open(run.id, out, { markup: true });
      code = Math.max(code, await connection.send(words.join(' '), { words, source, json: lineJson, rewrite: statusHeading('other', run.detached === true) }));
      await connection.close();
    } catch (err) {
      // Ended since it was listed, say.
      print(`[sm-dev] ${(err as Error).message}`);
      code = 1;
    }
  }
  if (json) {
    const line = jsonResult('status', { ...(browser ? { browser } : {}), runs: statuses } satisfies StatusRunsData);
    print(layout ? withLayout(line, layout) : line);
  }
  return code;
}

/**
 * The `--existing-browser` or `--open-browser` browser, with its
 * managers, for `status` with no run. Printed too unless `json`.
 */
async function browserStatus(json: boolean): Promise<BrowserStatus> {
  const { addressArg, browserArg, browserSetting } = await import('./run.js');
  const { browserVersion, managersIn, managersText, otherManagersWarning } = await import('./browser-extensions.js');
  const endpoint = browserSetting(lineCdp);
  const address = endpoint.replace(/^https?:\/\//, '');
  const chosen = lineManager ?? DEFAULT_MANAGER;
  const version = await browserVersion(endpoint);
  const managers = version ? await managersIn(endpoint) : null;
  if (!json) {
    print(version ? S.ui`${S.heading('Browser')}: ${address} (Chrome ${version.version}${version.headless ? ', headless' : ''})`
      : S.ui`${S.heading('Browser')}: ${S.message(`None answering at ${address}. Start one with ${quoted(`sm-dev --open-browser${addressArg(endpoint)}`)}.`)}`);
    if (managers) {
      print(S.ui`${S.heading('Managers')}: ${managersText(managers, chosen, 'chosen')}`);
      for (const line of otherManagersWarning(managers, chosen, browserArg(endpoint))) print(line);
    }
  }
  return {
    address,
    answering: version !== null,
    ...(version ? { version: version.version, headless: version.headless } : {}),
    manager: chosen,
    ...(managers ? { managers: managers.map((m) => ({ manager: m.manager, name: m.name, version: m.version, id: m.id, enabled: m.enabled, userScripts: m.userScripts })) } : {}),
  };
}

/**
 * Heads a run's `status` by how this sm-dev came to it: its `Run:` line
 * becomes `Attached run:` and the like, and its JSON gets `connection`.
 */
function statusHeading(how: RunConnection, detached: boolean): (line: string) => string {
  const label = { started: 'Started run', attached: 'Attached run', selected: 'Selected run', other: 'Other run' }[how];
  const note = how === 'started' && detached ? ' (detached)' : '';
  // The line as a run sends it: plain from an older run, else marked up.
  const markedRun = `${S.MARKUP}<h>Run</h>: `;
  return (line) => {
    if (line.startsWith('Run: ')) return `${label}${note}: ${line.slice('Run: '.length)}`;
    if (line.startsWith(markedRun)) return S.ui`${S.heading(label)}${note}: ` + line.slice(markedRun.length);
    const result = jsonResultData(line);
    const run = result?.data.run as Record<string, unknown> | undefined;
    if (!result || !run) return line;
    const marked = jsonResult('status', { ...result.data, run: { ...run, connection: how, ...(detached ? { detached: true } : {}) } });
    return result.layout ? withLayout(marked, result.layout) : marked;
  };
}

const MATCH_FRAMES_NEEDS_RUN = 'The `--frames` flag checks the iframes of a run\'s tab, so `match` needs a run for it. Name a frame\'s URL to check it.';
const MATCH_NEEDS = 'The `match` command needs a script (a .user.js file) and at least one URL, or a run to take them from';
const VALIDATE_NEEDS = 'The `validate` command needs at least one path, or a run to take the script from';
const NEEDS_A_RUN: Record<string, string> = {
  match: MATCH_NEEDS,
  validate: VALIDATE_NEEDS,
  // It would only pause, with nothing to show meanwhile.
  wait: 'The `wait` command needs a run to watch. Start or attach one first.',
};

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
  const commands = list ? list.commands.map((c) => ({ line: c.text }))
    : words.length === 1 ? [{ line: words[0] }] : [{ words }];
  for (const command of commands) {
    const mistake = commandMistake(command);
    if (mistake) throw new UsageError(mistake);
  }
}

// What's wrong with a run command, before it's sent: as typed (a
// line), or as the sender's words.
function commandMistake(input: { line: string } | { words: string[] }): string | null {
  // A global option typed where only the command line takes it: on a
  // line of stdin or the prompt, or after a command.
  const lineFlag = (word: string | undefined): string | undefined => {
    const flag = word?.split('=')[0];
    return flag !== undefined && GLOBAL_FLAGS.includes(flag) ? flag : undefined;
  };
  const words = 'line' in input ? splitWords(input.line).map((w) => w.text) : input.words;
  let name = words[0] ?? '';
  if (name.startsWith('-')) {
    const flagMistake = leadingFlagMistake(words);
    if (flagMistake) return flagMistake;
    // Flags some command takes, before a word that is none.
    name = words[commandIndex(words)];
  }
  if (!isTypedCommand(name)) return unknownRunCommand(name);
  const mistake = runCommandMistake(input);
  if (!mistake) return null;
  const flag = lineFlag(mistake.flag);
  return flag ? globalFlagMistake(flag) : mistake.error;
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
  return `${quoted(name)} is not a command a run takes. Use ${quoted('sm-dev help commands')} to list them.`;
}

/**
 * A command as this client echoes it, headed by where it came from
 * (`stdin > eval {{`, then `... ` lines); the run heads other clients'
 * commands with who sent them too (see commandMark in run.ts).
 */
function echoed(source: CommandSource, command: AssembledCommand): string[] {
  return echoCommand(command, `${source} >`);
}

const NO_COMMANDS = 'No commands given on either the command line or stdin';

/**
 * A command read from stdin or typed at the prompt, as its words: one
 * or more commands, split at `--` as on the command line. A `{{`
 * block's several lines stay one. Each with the text to send a run.
 */
function typedCommands(text: string): { words: string[]; text: string }[] {
  if (text.includes('\n')) return [{ words: commandWords(text), text }];
  // The typed text of each, as typed: eval takes its quotes as they are.
  return text.split(/(?:^|\s)--(?=\s|$)/).map((part) => part.trim()).filter(Boolean)
    .map((part) => ({ words: commandWords(part), text: part }));
}

/** What is wrong with a command read from stdin or typed, before it runs; null when nothing. */
async function typedMistake({ words, text }: { words: string[]; text: string }): Promise<string | null> {
  if (!runsHere(words)) return commandMistake({ line: text });
  try {
    await checkCommand(words);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Runs a command read from stdin or typed: its exit code. `echo` heads
 * its output: once the run it goes to is found, so a missing run is
 * said without a heading for a command that never ran.
 */
async function runTyped(command: { words: string[]; text: string }, client: Client, source: CommandSource, echo: () => void = () => undefined): Promise<number> {
  // `--help` on a run's command: its help, from here, with no run needed.
  const help = runCommandHelp({ line: command.text });
  if (help) {
    echo();
    if ('error' in help) return printMistake(new UsageError(help.error));
    print(commandHelp(help.command, help.subcommand, helpInColor()).trimEnd());
    return 0;
  }
  if (runsHere(command.words)) {
    echo();
    return runOne(command.words, client);
  }
  try {
    if (command.words[0] === 'manager') {
      echo();
      return await managerVerbHere(command.words, client);
    }
    if (await listsHere(command.words, client)) {
      echo();
      return await managerHere(command.words);
    }
    if (!client.toEveryRun(command.text)) await client.connect();
    echo();
    // As typed, for the run to split as its prompt would.
    return await client.send(command.text, source);
  } catch (err) {
    return printMistake(err);
  }
}

// How long piped input can pause and still count as arriving at once,
// for checking in full before any of it runs.
const PIPED_BATCH_GAP_MS = 50;

/**
 * `--stdin`, or no command and piped input: commands read from stdin,
 * one per line. A run's go to the run; sm-dev's own (`list`, `start`,
 * `match` on files) run here. Returns the last command's exit code (1
 * after a mistake), or null when stdin had no commands.
 *
 * - A file, or what a pipe delivers at once (a heredoc, `printf`), is
 *   checked in full before any is run, so a typo on its fifth line
 *   leaves the first four unrun.
 * - After that, each command runs once it is read.
 * - A mistake, or a command that fails, stops the rest, as on a line of
 *   several. A `match` or `validate` miss is an answer, and doesn't.
 */
async function stdinCommands(client: Client): Promise<number | null> {
  const { createInterface } = await import('node:readline');
  const { fstatSync } = await import('node:fs');
  // A file ends; only a pipe needs the pause to tell a batch.
  const file = !process.stdin.isTTY && fstatSync(0).isFile();
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
  let ran = 0;
  let code = 0;
  // Lines read, for naming the one a block mistake is on.
  let n = 0;
  // The commands in a line read, each run in turn, echoed first. False
  // when one stopped the rest.
  const run = async (commands: { words: string[]; text: string }[], source: AssembledCommand, more: boolean): Promise<boolean> => {
    for (const [i, command] of commands.entries()) {
      const heading = commands.length > 1 ? [echoLine('stdin >', command.text)] : echoed('stdin', source);
      code = await runTyped(command, client, 'stdin', () => { for (const l of heading) echo(l); });
      ran++;
      if (client.exiting) return false;
      if (stopsLine(code, command.words)) {
        if (more || i < commands.length - 1 || !ended || queue.length > 0) writeErr(LINE_STOPPED);
        return false;
      }
    }
    return true;
  };
  try {
    const batch: { commands: { words: string[]; text: string }[]; source: AssembledCommand }[] = [];
    const mistakes: string[] = [];
    let line = await next();
    while (typeof line === 'string') {
      n++;
      const got = blocks.push(line);
      if (got && 'error' in got) mistakes.push(`${ERROR_PREFIX}Line ${n}: ${got.error}`);
      else if (got) {
        const commands = typedCommands(got.command.text);
        let wrong = false;
        for (const command of commands) {
          const mistake = await typedMistake(command);
          if (!mistake) continue;
          if (!wrong) mistakes.push(...echoed('stdin', got.command));
          wrong = true;
          mistakes.push(`${ERROR_PREFIX}${mistake}`);
        }
        if (!wrong) batch.push({ commands, source: got.command });
      }
      line = await next(file ? undefined : PIPED_BATCH_GAP_MS);
    }
    if (line === null) {
      const unclosed = blocks.drop();
      if (unclosed !== null) mistakes.push(`${ERROR_PREFIX}${unclosedBlockMessage(unclosed)}`);
    }
    if (mistakes.length > 0) {
      for (const m of mistakes) writeErr(m);
      writeErr(NONE_RUN);
      return 2;
    }
    for (const [i, { commands, source }] of batch.entries()) {
      if (!await run(commands, source, i < batch.length - 1)) return ran === 0 ? null : code;
    }
    for (let got = await next(); got !== null; got = await next()) {
      if (typeof got !== 'string') continue;
      n++;
      const assembled = blocks.push(got);
      if (!assembled) continue;
      if ('error' in assembled) {
        writeErr(`${ERROR_PREFIX}Line ${n}: ${assembled.error}`);
        writeErr(LINE_STOPPED);
        return 1;
      }
      const commands = typedCommands(assembled.command.text);
      for (const command of commands) {
        const mistake = await typedMistake(command);
        if (!mistake) continue;
        for (const l of echoed('stdin', assembled.command)) writeErr(l);
        writeErr(`${ERROR_PREFIX}${mistake}`);
        writeErr(LINE_STOPPED);
        return 1;
      }
      if (!await run(commands, assembled.command, false)) return code;
    }
    const unclosed = blocks.drop();
    if (unclosed !== null) {
      writeErr(`${ERROR_PREFIX}${unclosedBlockMessage(unclosed)}, so it was not run`);
      return 1;
    }
  } finally {
    lines.close();
    process.stdin.pause();
  }
  return ran === 0 ? null : code;
}

/**
 * `--interactive`: the `> ` prompt, until `exit`, Ctrl-D, or Ctrl-C on
 * an empty line. Each command runs in turn, as typed; one that fails
 * doesn't stop the next, since the person decides. The last one's exit
 * code.
 */
function promptCommands(client: Client, greeting: string[]): Promise<number> {
  return new Promise((resolve) => {
    let code = 0;
    let queue: Promise<unknown> = Promise.resolve();
    let close: () => void = () => undefined;
    let done = false;
    const leave = (now = false): void => {
      // A second Ctrl-C while a command runs: as a signal would.
      if (now) void client.finish().finally(() => process.exit(130));
      if (done) return;
      done = true;
      // After the command running now, if any.
      void queue.then(() => {
        close();
        resolve(code);
      });
    };
    close = readPromptCommands({ out: print, exit: leave }, (line, hooks) => {
      const turn = queue.then(async () => {
        hooks?.start?.();
        if (!line || done) return;
        const commands = typedCommands(line);
        // All checked before any runs, as on the command line.
        for (const command of commands) {
          const mistake = await typedMistake(command);
          if (mistake) {
            print(`${ERROR_PREFIX}${mistake}`);
            code = 2;
            return;
          }
        }
        for (const command of commands) {
          code = await runTyped(command, client, 'prompt');
          if (client.exiting) {
            leave();
            return;
          }
          if (stopsLine(code, command.words)) return;
        }
      });
      queue = turn.catch(() => undefined);
      return turn;
    }, greeting);
  });
}

/**
 * Whether a `collection` or `script` command for what's installed runs
 * here rather than in a run: when no run is picked and none is going, or
 * the line names a browser no run is in (see `noRunToUse`). They need
 * SourceMonkey, not a run.
 */
async function listsHere(words: string[], client: Client): Promise<boolean> {
  return managerCommandOf(words) !== null && await noRunToUse(client);
}

// Whether a command for the browser itself, rather than a run's tabs,
// has no run to go to: no run is picked and none is going, or the line
// names a browser no run is in (`--existing-browser`, `--open-browser`
// or `--browser`).
async function noRunToUse(client: Client): Promise<boolean> {
  if (client.runId !== undefined) return false;
  const { liveRuns } = await import('./runs.js');
  const runs = await liveRuns();
  if (runs.length === 0) return true;
  const { browserSetting, sameBrowser } = await import('./run.js');
  const named = tempBrowserLine() ? lineCdp : browserSetting(lineCdp);
  if (named === undefined) return false;
  return !runs.some((run) => sameBrowser(run.browser, named));
}

// Throws for a command that acts on a browser outside a run, when the
// line names none: a temp browser comes only with a run. `--browser`
// alone is a temp browser's port, so it's refused too rather than
// taken as the browser to connect to.
async function needBrowserWithoutRun(command: string): Promise<void> {
  if (!tempBrowserLine()) return;
  const { liveRuns } = await import('./runs.js');
  const { browserSetting } = await import('./run.js');
  const address = browserSetting(lineCdp).replace(/^https?:\/\//, '');
  const existing = quoted('--existing-browser');
  if (lineCdp !== undefined) {
    throw new UsageError(`The ${quoted(command)} command connects to a browser, and ${quoted('--browser')} alone is the port for a temp browser. Use ${existing} to connect to the browser at ${address}.`);
  }
  if ((await liveRuns()).length > 0) {
    throw new UsageError(`The ${quoted(command)} command needs a browser. Pick a run with ${quoted('--run')}, or use ${existing} for the browser at ${address}.`);
  }
  throw new UsageError(`The ${quoted(command)} command needs a browser, and no run is going. Use ${existing} for the browser at ${address}, or ${quoted('--open-browser')} to start one there.`);
}

/**
 * A `manager` command, which sm-dev does itself: in the browser of the
 * run picked (by --run, start or attach), else the --existing-browser
 * or --open-browser one, as `status` shows it with no run. Never an
 * active run that isn't picked. `fetch` needs no browser.
 */
async function managerVerbHere(words: string[], client: Client): Promise<number> {
  const parsed = parseCommandArgs('manager', { words: words.slice(1) });
  if ('error' in parsed) throw new UsageError(parsed.error);
  if (parsed.help) {
    print(commandHelpFor('manager', words.slice(1).filter((w) => !HELP_FLAGS.has(w))).trimEnd());
    return 0;
  }
  const verb = parsed.form as ManagerVerb | undefined;
  if (verb === undefined) {
    throw new UsageError(parsed.words.length > 0 ? `The ${quoted('manager')} command has no ${quoted(parsed.words[0])} verb. It takes ${quoted('fetch')}, ${quoted('install')}, ${quoted('enable')} or ${quoted('disable')}.`
      : 'The `manager` command needs a verb: `fetch`, `install`, `enable` or `disable`');
  }
  const { liveRuns } = await import('./runs.js');
  const { browserArg, browserSetting, sameBrowser } = await import('./run.js');
  // The run picked, if any.
  const picked = client.runId ?? globalRun;
  const run = picked ? await targetRun(picked) : null;
  // Not checkRunManager: these act on the browser's extensions, not the
  // run, so --manager can name another manager than the run's (to turn
  // off one a warning names, say).
  if (run) await checkRunBrowser(run);
  else if (verb !== 'fetch') await needBrowserWithoutRun(`manager ${verb}`);
  const manager = lineManager ?? run?.manager ?? DEFAULT_MANAGER;
  const endpoint = run?.browser ?? browserSetting(lineCdp);
  const runsUsing = verb === 'disable' && manager === 'sourcemonkey'
    ? (await liveRuns()).filter((r) => (r.manager ?? DEFAULT_MANAGER) === 'sourcemonkey' && sameBrowser(r.browser, endpoint)).map((r) => r.id)
    : [];
  const { ManagerUsageError, managerAction } = await import('./manager-actions.js');
  try {
    const done = await managerAction({ verb, manager, endpoint, browserArg: browserArg(endpoint), runsUsing, out: print, note: writeErr });
    return done ? 0 : 1;
  } catch (err) {
    if (err instanceof ManagerUsageError) throw new UsageError(err.message);
    writeErr(errorLine((err as Error).message));
    return 1;
  }
}

/**
 * A `collection` or `script` command with no run: connects to the
 * --existing-browser or --open-browser browser for it, and disconnects
 * after.
 */
async function managerHere(words: string[]): Promise<number> {
  const [, ...rest] = words;
  const name = managerCommandOf(words)!.command;
  const parsed = parseCommandArgs(name, { words: rest });
  if ('error' in parsed) throw new UsageError(parsed.error);
  if (parsed.help) {
    print(commandHelpFor(words[0], rest.filter((w) => !HELP_FLAGS.has(w))).trimEnd());
    return 0;
  }
  await needBrowserWithoutRun(words[0]);
  const chosen = lineManager ?? DEFAULT_MANAGER;
  const unsupported = unsupportedCommand(name, chosen, '--manager names');
  if (unsupported) throw new UsageError(unsupported);
  const { noSuchVerb } = await import('./manager-commands.js');
  if (parsed.form === undefined && parsed.words.length > 0) throw new UsageError(noSuchVerb(parsed.words));
  const own = parsed.flags['--json'];
  if (typeof own === 'string') {
    const mistake = jsonLayoutMistake(own);
    if (mistake) throw new UsageError(mistake);
  }
  const json = parsed.flags['--nojson'] ? false : own ? true : lineJson;
  const out = (line: string): void => print(typeof own === 'string' && isJsonLine(line) ? withLayout(line, own as JsonLayout) : line);
  const { connectWithoutRun } = await import('./run.js');
  const { firstLine, openManagerLink } = await import('./extension-link.js');
  // What went wrong connecting goes to stderr, as other mistakes do.
  const session = await connectWithoutRun(lineCdp, (line) => writeErr(errorLine(line)));
  if (!session) return 1;
  let closeManager: (() => Promise<void>) | undefined;
  try {
    const { managersIn, otherManagersWarning } = await import('./browser-extensions.js');
    const { browserArg } = await import('./run.js');
    for (const line of otherManagersWarning(await managersIn(session.endpoint) ?? [], chosen, browserArg(session.endpoint))) writeErr(line);
    let manager: ManagerControl;
    if (chosen !== 'sourcemonkey') {
      const { externalControl, openExternalManager } = await import('./external-manager.js');
      const external = await openExternalManager(chosen, session.endpoint, browserArg(session.endpoint));
      closeManager = () => external.close();
      manager = externalControl(external);
    } else {
      const link = await openManagerLink(session.context);
      if (link.versionNote) writeErr(S.message(link.versionNote));
      manager = link.manager;
    }
    // Its failures go to stderr, as sm-dev's own commands' do, with the
    // lines that follow one (the files it lists).
    let failed = false;
    const said = (line: string): void => {
      if (line.startsWith(SM_DEV_PREFIX)) {
        failed = true;
        writeErr(errorLine(line.slice(SM_DEV_PREFIX.length)));
      } else if (failed) writeErr(line);
      else out(line);
    };
    return await managerCommand({ manager, out: said, json }, name, parsed) === false ? 1 : 0;
  } catch (err) {
    writeErr(errorLine(firstLine(err)));
    return 1;
  } finally {
    await closeManager?.().catch(() => undefined);
    await session.done();
  }
}

// sm-dev's own commands, which run in this process rather than going
// to a run, when read from stdin or typed at the prompt.
function runsHere(words: string[]): boolean {
  const name = words[0];
  if (name === 'match' || name === 'validate') return !needsRun(words);
  return name !== undefined && HERE.has(name);
}

// Ones that need no run, or act on runs themselves.
const HERE = new Set(['start', 'attach', 'stop', 'exit', 'list', 'help']);

/**
 * Whether a command only looks, so a line of only such commands needn't
 * follow the run's stream: just their own answers.
 */
function isQuiet(words: string[]): boolean {
  const name = words[0];
  if (name === undefined) return true;
  if (name === 'start' || name === 'attach') return false;
  if (HERE.has(name) || name === 'match' || name === 'validate') return true;
  const list = words.length === 1 && words[0].includes('\n') ? parseCommandList(words[0]) : null;
  if (list && !('error' in list)) return list.commands.every((c) => onlyInspects(c.text));
  return onlyInspects(words.join(' '));
}

function checkStop(opts: Opts): string | undefined {
  const named = opts.args[0] === undefined ? undefined : checkedRunId(opts.args[0], 'stop ');
  if (opts.all && named !== undefined) throw new UsageError('The --all flag stops every run, so the stop command can\'t take a run ID too');
  return named;
}

/**
 * `stop`: the run it works with (or the only one going), the one named,
 * or with `--all` every run. Leaves it with no run to work with.
 */
async function stopCommand(opts: Opts, client: Client): Promise<number> {
  const { liveRuns, stopRun } = await import('./runs.js');
  const named = checkStop(opts);
  let targets: RunRecord[];
  if (opts.all) {
    const runs = await liveRuns();
    if (runs.length === 0) {
      print(NO_RUNS);
      return 0;
    }
    targets = runs;
  } else {
    targets = [await targetRun(named ?? client.runId)];
  }
  if (targets.some((r) => r.id === client.runId)) await client.disconnect();
  // Together, each run's lines tagged with its id when there are
  // several.
  const several = targets.length > 1;
  const stopped = await Promise.all(targets.map((r) => stopRun(r, several ? (line) => print(`[${r.id}] ${line}`) : print, true)));
  for (const r of targets) {
    const log = client.stopped(r.id);
    if (log) print(`[sm-dev] ${S.ui`Output log: ${runLogLabelUi(log, r.id)}`}`);
  }
  return stopped.every(Boolean) ? 0 : 1;
}

function checkAttach(opts: Opts): string | undefined {
  return opts.args[0] === undefined ? undefined : checkedRunId(opts.args[0], 'attach ');
}

/**
 * `attach`: work with a run that is going, the one named (else `--run`'s,
 * else the only one), and show what it prints from now on.
 */
async function attachCommand(opts: Opts, client: Client): Promise<number> {
  const named = checkAttach(opts);
  // A new connection, whose hello asks for these.
  if (opts.logSources) {
    client.logSources = opts.logSources;
    await client.disconnect();
  }
  const { id } = await client.connect(named ?? globalRun);
  client.own = false;
  client.attachedTo = id;
  print(`[sm-dev] ${S.ui`Attached to run ${S.id(id)}`}`);
  return 0;
}

const HELP_FLAGS = new Set(['--help', '-h']);

// The `help` command's words (a topic, or a command and subcommand),
// or null for another command; empty for the help index. `--help` is
// handled for the whole line (`lineHelp`).
function helpWords(argv: string[]): string[] | null {
  // Any command takes --timeout-seconds, and help ignores it, before
  // `help` or after.
  const words = argv.filter((w, i) => w !== TIMEOUT_FLAG && argv[i - 1] !== TIMEOUT_FLAG && !w.startsWith(`${TIMEOUT_FLAG}=`));
  if (words[0] !== 'help' && words[0] !== '?') return null;
  // `help --help`: help's own help, as for any command.
  const asked = words.slice(1).filter((w) => !HELP_FLAGS.has(w));
  return asked.length === 0 && words.length > 1 ? ['help'] : asked;
}

/**
 * `--help` (or `-h`) anywhere on the line: the help for each command
 * the line names, once each, and nothing run. Looked for before the
 * commands are checked, so a mistake elsewhere doesn't stand in the
 * way. With no command named, the help index. Null when not asked.
 */
function lineHelp(commands: string[][]): string | null {
  if (!commands.some((words) => words.some((w) => HELP_FLAGS.has(w)))) return null;
  // `help` commands' text first, then the commands', in the full help's order.
  const topics: string[] = [];
  const named: { order: number; text: string }[] = [];
  for (const words of commands) {
    const rest = words.filter((w) => !HELP_FLAGS.has(w));
    // `help status`: what it names. `help --help` alone: help's own.
    const asked = helpWords(rest);
    if (asked) {
      if (asked.length === 0) named.push({ order: COMMAND_NAMES.indexOf('help'), text: commandHelpFor('help') });
      else topics.push(helpFor(asked));
      continue;
    }
    // The command's name, which may come after its flags and their
    // values (`--find x logs`), and the rest of its words, which may
    // name a subcommand.
    const at = commandIndex(rest);
    if (rest[at] !== undefined) named.push({ order: COMMAND_NAMES.indexOf(commandNamed(rest[at]) ?? ''), text: commandHelpFor(rest[at], rest.filter((_, i) => i !== at)) });
  }
  // The index, with nothing named. Each help once.
  if (topics.length === 0 && named.length === 0) return helpFor([]);
  const texts = [...topics, ...named.sort((a, b) => a.order - b.order).map((n) => n.text)];
  return [...new Set(texts)].join('\n');
}

// The signals that end sm-dev: Ctrl-C, kill, and a closed terminal.
// Windows has no SIGHUP to listen for.
const STOP_SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

// After a command of several that failed.
const LINE_STOPPED = 'That command failed, so the commands after it were not run';

/**
 * Throws when the line's `--browser` names a browser other than the
 * run's, which the run's commands act in: the flag would otherwise be
 * passed over without a word.
 */
async function checkRunBrowser(run: RunRecord): Promise<void> {
  if (lineCdp === undefined) return;
  const { cdpEndpoint, sameBrowser } = await import('./run.js');
  if (sameBrowser(run.browser, lineCdp)) return;
  const named = cdpEndpoint(lineCdp.trim());
  const shown = (endpoint: string): string => endpoint.replace(/^https?:\/\//, '');
  throw new UsageError(
    `The --browser flag names the browser at ${shown(named)}, but run ${run.id} uses the one at ${shown(run.browser)}. `
    + `Leave out --browser to use run ${run.id}, or pick a run in that browser with --run.`,
  );
}

/**
 * Throws when the line's `--manager` isn't the run's: the whole run
 * works with the manager it started with.
 */
function checkRunManager(run: RunRecord): void {
  const theirs = run.manager ?? DEFAULT_MANAGER;
  if (lineManager === undefined || lineManager === theirs) return;
  throw new UsageError(
    `The --manager flag names ${MANAGERS[lineManager].label}, but run ${run.id} uses ${MANAGERS[theirs].label}. `
    + `Leave out --manager to use run ${run.id}, or name a ${MANAGERS[lineManager].label} run with --run.`,
  );
}

const ROOTS_ARE_THE_RUNS = 'The --root and --local flags are set when a run starts, and a command sent to a run uses the run\'s own';

// `--root` and `--local`, for every command of the line: where the
// scripts it reads find local copies of their @requires. A run started
// on the line keeps them; commands sent to another run use its own.
let lineRoots: ScriptRoots = { collectionRoot: process.cwd(), localRoots: [] };
// Whether the line gave either, so one sent to a run can be refused.
let rootsGiven = false;
// `--run`: the run the line works with.
let globalRun: string | undefined;
// `--browser`, for the commands that connect to a browser (their own
// `--browser` wins) and for `--open-browser`. With a temp browser, the
// port to launch it on.
let lineCdp: string | undefined;
// The browser mode: `--open-browser` (a lasting browser to start first,
// with `--profile`) or `--existing-browser`. Neither is a temp browser
// for each run, closed with it; `lineTempBrowser` is that given outright.
let lineOpenBrowser = false;
let lineExistingBrowser = false;
let lineTempBrowser = false;
let lineProfile: string | undefined;
// `--headed` (true) or `--headless` (false): the window of a browser the
// line launches. Unset is headed for --open-browser, and for a temp
// browser when the line goes to a prompt (`linePrompt`).
let lineHeaded: boolean | undefined;
let linePrompt = false;
// `--mute` / `--nomute`: sound in the browser the line launches. Unset
// is muted for a temp browser, and with sound for --open-browser.
let lineMuted: boolean | undefined;
// `--json`: the commands with a JSON form print it (see json-output.ts).
let lineJson = false;
// `--manager`: the userscript manager the line works with. Unset is
// SourceMonkey, or a run's own when sending to one.
let lineManager: ManagerName | undefined;


interface GlobalFlags {
  stdin: boolean;
  interactive: boolean;
  /** The words after the flags: the commands. */
  rest: string[];
}

/**
 * Takes the global options off the front of the line: `--run ID`,
 * `--root DIR`, `--local DIR` (repeatable), `--stdin`, `--interactive`
 * and the browser's: `--temp-browser`, `--open-browser`,
 * `--existing-browser`, `--browser`, `--manager`, `--profile`, `--headed`,
 * `--headless`, `--mute`, `--nomute`. One later on the line, among a
 * command's words, is said to go first.
 */
function takeGlobalFlags(argv: string[]): GlobalFlags {
  let collectionRoot = process.cwd();
  const localRoots: string[] = [];
  const flags: GlobalFlags = { stdin: false, interactive: false, rest: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const [word, inline] = splitInline(argv[i]);
    if (!GLOBAL_FLAGS.includes(word)) break;
    if (word === '--stdin') flags.stdin = true;
    else if (word === '--interactive') flags.interactive = true;
    else if (word === '--open-browser') lineOpenBrowser = true;
    else if (word === '--existing-browser') lineExistingBrowser = true;
    else if (word === '--temp-browser') lineTempBrowser = true;
    else if (word === '--headed' || word === '--headless') {
      const headed = word === '--headed';
      if (lineHeaded !== undefined && lineHeaded !== headed) throw new UsageError('The command line takes --headed or --headless, not both');
      lineHeaded = headed;
    }
    else if (word === '--mute' || word === '--nomute') {
      const muted = word === '--mute';
      if (lineMuted !== undefined && lineMuted !== muted) throw new UsageError('The command line takes --mute or --nomute, not both');
      lineMuted = muted;
    }
    else if (word === '--json') {
      const mistake = inline === undefined ? null : jsonLayoutMistake(inline);
      if (mistake) throw new UsageError(mistake);
      lineJson = true;
      setJsonOutput(inline as JsonLayout | undefined);
    }
    else {
      const value = inline ?? argv[++i];
      // Not the next option taken for this one's value (`--browser --open-browser`).
      if (value === undefined || value === '' || value === SEPARATOR || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError(word === '--run' ? 'The `--run` flag needs a run ID, e.g. `--run D2`' : `The ${quoted(word)} flag needs a value`);
      }
      if (word === '--run') globalRun = checkedRunId(value);
      else if (word === '--browser') lineCdp = value;
      else if (word === '--manager') {
        const named = managerNamed(value);
        if (!named) throw new UsageError(managerMistake(value));
        lineManager = named;
      }
      else if (word === '--profile') lineProfile = path.resolve(value);
      else if (word === '--root') collectionRoot = path.resolve(value);
      else localRoots.push(path.resolve(value));
      if (word === '--root' || word === '--local') rootsGiven = true;
    }
  }
  lineRoots = { collectionRoot, localRoots };
  flags.rest = argv.slice(i);
  // At most one browser mode.
  const modes = [[lineTempBrowser, '--temp-browser'], [lineOpenBrowser, '--open-browser'], [lineExistingBrowser, '--existing-browser']] as const;
  const given = modes.filter(([on]) => on).map(([, name]) => name);
  if (given.length > 1) throw new UsageError(`The ${quoted(given[0])} flag can't be used with ${given.slice(1).map((f) => quoted(f)).join(' or ')}`);
  if (lineExistingBrowser) {
    const launching = [[lineHeaded !== undefined, lineHeaded ? '--headed' : '--headless'], [lineMuted !== undefined, lineMuted ? '--mute' : '--nomute']] as const;
    for (const [on, name] of launching) {
      if (on) throw new UsageError(`The ${quoted(name)} flag only applies when sm-dev launches the browser, so not with ${quoted('--existing-browser')}`);
    }
  }
  if (lineProfile !== undefined && !lineOpenBrowser) throw new UsageError('The `--profile` flag only applies with `--open-browser`');
  return flags;
}

// A global option with its value in the same word (`--browser=9300`,
// `--json=multi`), as the option and the value; else the word and no
// value.
function splitInline(word: string): [string, string | undefined] {
  const eq = word.indexOf('=');
  if (eq > 0 && (VALUE_GLOBALS.has(word.slice(0, eq)) || word.slice(0, eq) === '--json')) return [word.slice(0, eq), word.slice(eq + 1)];
  return [word, undefined];
}

// The line with its leading global options (and their values) taken
// off, for --help to look at the commands alone.
function withoutGlobalFlags(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && GLOBAL_FLAGS.includes(splitInline(argv[i])[0])) {
    const [word, inline] = splitInline(argv[i]);
    i += VALUE_GLOBALS.has(word) && inline === undefined ? 2 : 1;
  }
  return argv.slice(i);
}

// The line's own flags again, for a run started in the background.
function globalWords(runId: string | undefined): string[] {
  return [
    ...(rootsGiven ? ['--root', lineRoots.collectionRoot, ...lineRoots.localRoots.flatMap((dir) => ['--local', dir])] : []),
    ...(runId ? ['--run', runId] : []),
    ...(lineCdp !== undefined ? ['--browser', lineCdp] : []),
    ...(lineManager !== undefined ? ['--manager', lineManager] : []),
    // The run connects to the browser --open-browser started, or the
    // one --existing-browser names.
    ...(lineOpenBrowser || lineExistingBrowser ? ['--existing-browser'] : []),
    // A detached run has no prompt, so the prompt's headed default goes
    // as the flag.
    ...(tempBrowserLine() && launchHeaded() ? ['--headed'] : []),
    ...(tempBrowserLine() && lineMuted !== undefined ? [lineMuted ? '--mute' : '--nomute'] : []),
  ];
}

// Whether runs the line starts launch a temp browser: the default mode.
function tempBrowserLine(): boolean {
  return !lineOpenBrowser && !lineExistingBrowser;
}

// Whether a browser the line launches is headed.
function launchHeaded(): boolean {
  return lineHeaded ?? (lineOpenBrowser || linePrompt);
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

// Whether a command's exit code stops the commands after it: any
// failure but a miss from match or validate, which is an answer.
function stopsLine(code: number, words: string[]): boolean {
  return code !== 0 && !(code === 1 && isVerdict(words));
}

// The commands whose exit code answers a question.
function isVerdict(words: string[]): boolean {
  return words[0] === 'match' || words[0] === 'validate';
}

// A command's own words, sorted out: help, a command sent to a run, or
// one of sm-dev's own.
type ParsedCommand =
  | { kind: 'help'; text: () => string }
  | { kind: 'send'; words: string[] }
  | { kind: 'cli'; opts: Opts; words: string[] };


function parseCommand(words: string[]): ParsedCommand {
  const help = helpWords(words);
  if (help) return { kind: 'help', text: () => helpFor(help) };
  if (words.length === 0) throw new UsageError(`A command is needed. ${LIST_COMMANDS}`);
  // A run's command may come as one argument: `'eval T1 x'`. One of
  // several lines is a list of them, and never sm-dev's own.
  if (words.length === 1 && words[0].includes('\n')) return { kind: 'send', words };
  if (SHARED_COMMANDS.has(words[0]) && needsRun(words)) return { kind: 'send', words };
  const head = words.length === 1 ? words[0].trim().split(/\s+/)[0] : words[0];
  if (!OWN_COMMANDS.has(words[0]) && isTypedCommand(head)) return { kind: 'send', words };
  // One of sm-dev's own sent as one word (`'stop D1'`): split as typed.
  if (words.length === 1 && OWN_COMMANDS.has(head) && head !== words[0]) return parseCommand(commandWords(words[0]));
  // Or a command sent as one word after a flag (`'--x eval 1'`): its
  // words, to say what is wrong with the flag.
  if (words.length === 1 && head.startsWith('-') && head !== words[0]) return parseCommand(commandWords(words[0]));
  const opts = parseArgs(words);
  // A flag before any command is the first mistake, read left to right:
  // `--stdin --xx` is about `--xx`, not the missing command.
  if (opts.command === null) throw new UsageError(leadingFlagMistake(words)!);
  if (opts.help) {
    const command = opts.command;
    return { kind: 'help', text: () => commandHelpFor(command) };
  }
  if (!OWN_COMMANDS.has(opts.command)) {
    const flagMistake = words[0].startsWith('-') ? leadingFlagMistake(words) : null;
    if (flagMistake) throw new UsageError(flagMistake);
    // A run's ID where the command goes: the old `sm-dev D1 status`.
    const run = runIdOf(opts.command);
    if (run) throw new UsageError(`Name the run with ${quoted('--run')}, before the command: ${quoted(`sm-dev --run ${run} <command>`)}`);
    throw new UsageError(`Unknown command: ${quoted(opts.command)}. ${LIST_COMMANDS}`);
  }
  return { kind: 'cli', opts, words };
}

// Flags where a run's command goes, before it or with none after them:
// the first mistake among them, read left to right. Only the line's own
// flags go first, and those were taken already. Null when the flags are
// all some command's and what follows is no command: that is the
// mistake to say. With no command after them, never null.
function leadingFlagMistake(words: string[]): string | null {
  const at = commandIndex(words);
  const command = words[at];
  const own = command !== undefined && isTypedCommand(command) ? commandSyntax(commandNamed(command)!).flags : null;
  for (const word of words.slice(0, at)) {
    // A value, after its flag.
    if (!word.startsWith('-')) continue;
    const flag = word.split('=')[0];
    // The command's own first: `--json probe x` has `probe x --json`.
    if (own && (Object.hasOwn(own, flag) || flag === TIMEOUT_FLAG)) continue;
    if (GLOBAL_FLAGS.includes(flag)) return globalFlagMistake(flag);
    if (own) return commandMistake({ words: [command, word] }) ?? `Unknown option: ${quoted(word)}`;
    if (!COMMAND_FLAGS.has(flag)) return `There is no ${quoted(flag)} flag. Use ${quoted('sm-dev help flags')} to list the flags.`;
    if (command === undefined) return `The ${quoted(flag)} flag goes after the command it is for`;
  }
  if (!own) return null;
  return `The ${quoted(words[0].split('=')[0])} flag goes after the command (${quoted(command)}), not before it`;
}

/**
 * Everything about one command that can be checked before any command
 * of the line runs: its name, flags and arguments, and that `start`'s
 * script files exist. Not whether the run, tab or script it names is
 * there, since earlier commands can change that. Throws the mistake.
 */
async function checkCommand(words: string[]): Promise<void> {
  const parsed = parseCommand(words);
  if (parsed.kind === 'help') {
    parsed.text();
    return;
  }
  if (parsed.kind === 'send') return checkSend(parsed.words);
  const { opts } = parsed;
  switch (opts.command) {
    case 'validate': return checkValidate(opts);
    case 'match': return checkMatch(opts);
    case 'start': await checkStart(opts); return;
    case 'attach': checkAttach(opts); return;
    case 'stop': checkStop(opts); return;
  }
}

// Prints a command's mistake, and returns its exit code. One in how the
// command was typed is marked as such, apart from a failure doing it.
function printMistake(err: unknown): number {
  const usage = err instanceof UsageError;
  const text = (err as Error).message;
  writeErr(usage ? `${ERROR_PREFIX}${text}` : errorLine(text));
  return usage ? 2 : 1;
}

/** One command. Prints its own errors, and returns its exit code. */
async function runOne(words: string[], client: Client): Promise<number> {
  try {
    const parsed = parseCommand(words);
    if (parsed.kind === 'help') {
      for (const line of parsed.text().trimEnd().split('\n')) print(line);
      return 0;
    }
    if (parsed.kind === 'send') return await sendCommand(parsed.words, client);
    const { opts } = parsed;
    switch (opts.command) {
      case 'validate': return await validate(opts);
      case 'match': return await match(opts);
      case 'start': return await startCommand(opts, parsed.words, client);
      case 'attach': return await attachCommand(opts, client);
      case 'list': return await listCommand(opts);
      case 'exit':
        client.exiting = true;
        return 0;
      default: return await stopCommand(opts, client);
    }
  } catch (err) {
    return printMistake(err);
  }
}

/** Whether stdin and stdout are both a terminal, for the prompt by default. */
function atTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const START_ALONE = 'The start command with nothing after it would stop the run as soon as it started. Add --interactive for a prompt, --detach to leave it running, --stop-after-seconds N to watch it for a while, or commands after --.';

async function main(): Promise<void> {
  // Output piped into something that stops reading early (`| head`)
  // ends the command quietly, as other command-line tools do, rather
  // than with a stack trace.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    // Writes after the first failure fail as a destroyed stream.
    // EIO: the terminal closed.
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED' && err.code !== 'EIO') throw err;
    onOutputClosed();
  });
  const argv = process.argv.slice(2);
  // Before anything else is checked, so a mistake doesn't stand in the
  // way of help.
  let help: string | null;
  try {
    help = lineHelp(splitCommands(withoutGlobalFlags(argv)));
  } catch (err) {
    process.exitCode = printMistake(err);
    return;
  }
  if (help !== null) {
    process.stdout.write(help);
    return;
  }
  let flags: GlobalFlags;
  try {
    flags = takeGlobalFlags(argv);
    if (flags.interactive && flags.stdin) throw new UsageError('The --interactive flag reads the terminal, so it can\'t be used with --stdin');
    if (flags.interactive && !process.stdin.isTTY) throw new UsageError('The --interactive flag needs a terminal. To read commands from a pipe or file, use --stdin.');
  } catch (err) {
    process.exitCode = printMistake(err);
    return;
  }
  const commands = splitCommands(flags.rest);
  // No commands, with stdin and stdout both a terminal: the prompt, as
  // with --interactive. Not with --stdin, in a detached run, or after
  // `--open-browser` alone, which is a whole line: start a browser.
  if (commands.length === 0 && !flags.stdin && !lineOpenBrowser && !detachedLog && atTerminal()) {
    flags.interactive = true;
  }
  // The background process a `start` began: the run itself, which
  // handles its own signals.
  if (detachedLog) {
    process.exitCode = await runOne(commands[0] ?? [], new Client(globalRun, false));
    return;
  }
  // Piped in with no command, stdin can only be commands. (Not after
  // `--open-browser` alone, which is a whole line: start a browser.)
  const stdin = flags.stdin || (commands.length === 0 && !flags.interactive && !lineOpenBrowser && !process.stdin.isTTY);
  if (commands.length === 0 && !stdin && !flags.interactive && !lineOpenBrowser) {
    process.stdout.write(helpFor([]));
    process.exitCode = 2;
    return;
  }
  // Every command checked before any runs, so a typo late in the line
  // doesn't leave the ones before it done.
  let failed = 0;
  for (const words of commands) {
    try {
      await checkCommand(words);
    } catch (err) {
      if (commands.length > 1) writeErr(echoLine('arg >', words.map(shellWord).join(' ')));
      failed = Math.max(failed, printMistake(err));
    }
  }
  if (failed) {
    if (commands.length > 1) writeErr(NONE_RUN);
    process.exitCode = failed;
    return;
  }
  // A `start` with nothing after it to keep it going: it would start the
  // run and stop it again straight away. Its flags can come first. At a
  // terminal, the prompt keeps it going, as with --interactive.
  const last = commands.at(-1);
  const ending = last && parseCommand(last).kind === 'cli' ? parseArgs(last) : null;
  if (ending?.command === 'start' && !ending.detach && ending.seconds === undefined && !stdin && !flags.interactive) {
    if (atTerminal()) {
      flags.interactive = true;
    } else {
      process.exitCode = printMistake(new UsageError(START_ALONE));
      return;
    }
  }
  // Decided by now: a temp browser opened from a prompt is headed.
  linePrompt = flags.interactive;
  // --temp-browser, --headed, --headless, --mute and --nomute shape the
  // runs this line starts (or --open-browser's browser); with no start
  // to use them, they'd be silently ignored.
  const starts = commands.some((words) => parseCommand(words).kind === 'cli' && parseArgs(words).command === 'start');
  const shaping = lineTempBrowser ? '--temp-browser'
    : lineOpenBrowser ? null
    : lineHeaded !== undefined ? (lineHeaded ? '--headed' : '--headless')
    : lineMuted !== undefined ? (lineMuted ? '--mute' : '--nomute')
    : null;
  if (shaping && !starts && !stdin && !flags.interactive) {
    process.exitCode = printMistake(new UsageError(`The ${shaping} flag is for the runs a start begins, and this line has no start`));
    return;
  }
  // The lasting browser first, for the commands to connect to.
  if (lineOpenBrowser) {
    const { launchBrowser, launchEndpointMistake } = await import('./browser-launch.js');
    const { browserSetting, browserSettingName } = await import('./run.js');
    try {
      const endpoint = browserSetting(lineCdp);
      const mistake = launchEndpointMistake(endpoint, browserSettingName(lineCdp));
      if (mistake) throw new UsageError(mistake);
      await launchBrowser(endpoint, lineProfile, print, lineMuted === true, !launchHeaded());
    } catch (err) {
      process.exitCode = printMistake(err);
      return;
    }
    if (commands.length === 0 && !stdin && !flags.interactive) return;
  }
  // A line that only attaches: it watches the run until it ends.
  const watching = ending?.command === 'attach' && !stdin && !flags.interactive;
  // Whether to follow the run's stream, decided once, up front: when
  // the line does more than look, or has no known end.
  const follow = flags.interactive || stdin || commands.some((words) => !isQuiet(words));
  const client = new Client(globalRun, follow);
  // Ctrl-C (or kill, or a closed terminal) leaves as `exit` does: the
  // runs this started are stopped, and ones it only attached to go on.
  // A second one kills it.
  let interrupted = false;
  const interrupt = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    void client.finish().finally(() => process.exit(130));
  };
  for (const signal of STOP_SIGNALS) process.on(signal, interrupt);
  // Output piped into something that stopped reading (`| head`): the
  // same, once, since what finish prints fails there too.
  let closing = false;
  onOutputClosed = () => {
    if (closing) return;
    closing = true;
    void client.finish().finally(() => process.exit(process.exitCode ?? 0));
  };
  let code = 0;
  let stopped = false;
  try {
    // In order, stopping at the first that fails, as a shell's && would.
    for (const [i, words] of commands.entries()) {
      if (commands.length > 1) echo(echoLine('arg >', words.map(shellWord).join(' ')));
      code = await runOne(words, client);
      if (client.exiting) break;
      // A miss from match or validate is an answer, not a failure: the
      // line goes on, and it only sets the exit code if it is last.
      if (stopsLine(code, words)) {
        if (i < commands.length - 1 || stdin || flags.interactive) writeErr(LINE_STOPPED);
        stopped = true;
        break;
      }
    }
    if (!stopped && !client.exiting) {
      if (stdin) {
        const read = await stdinCommands(client);
        if (read !== null) code = read;
        else if (commands.length === 0) code = printMistake(new UsageError(NO_COMMANDS));
      } else if (flags.interactive) {
        code = await promptCommands(client, commands.length === 0 && client.runId === undefined ? PROMPT_STARTED : [PROMPT_READY]);
      } else if (watching) {
        await client.watch();
      } else {
        // A run started with --stop-after-seconds, left to end on its own.
        const lasted = await client.outlast();
        if (code === 0) code = lasted;
      }
    }
  } finally {
    const ended = await client.finish();
    if (code === 0) code = ended;
    for (const signal of STOP_SIGNALS) process.off(signal, interrupt);
  }
  process.exitCode = code;
}

await main();
