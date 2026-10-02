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
//   - `clear --extension` goes through extension-backend.ts, which
//     reaches the real SourceMonkey in the browser. `start --extension`
//     runs go through run.ts like the rest (see extension-link.ts).
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
  commandWords, onlyInspects, readPromptCommands, runCommandHelp, runCommandMistake, writeOutputLine,
} from './console-commands.js';
import { parseLang } from './browser-lang.js';
import { parseCommandArgs } from './command-args.js';
import { OWN_COMMANDS, RUN_COMMAND_NAMES, SHARED_COMMANDS, commandNamed, commandSyntax, commandsHelp, fullHelp } from './command-list.js';
import { devtoolsWanted } from './devtools.js';
import { readJsonFile } from './input-file.js';
// Node built-ins only, so as cheap to load as the rest here.
import { runIdOf, type CommandSource, type RunClient, type RunRecord } from './runs.js';
import { runLogLabel } from './run-log.js';
import { staleBuildWarning } from './stale-build.js';
import { withDefaultScheme } from './prepare.js';
import { pagesToOpen, type PageWord, type SavedPageStart } from './saved-pages.js';
import {
  REMOTE_SCRIPT, SCRIPT_ARG, UsageError, expandPathArgs, matchLines, prepareSource, scriptFile, scriptSources, validateAll, validateSources,
  type ScriptRoots,
} from './checks.js';


// After a mistake, in place of the whole help, which would bury it.
const LIST_COMMANDS = 'Type sm-dev --help to list the commands.';

// `sm-dev help <command>...`, or the mistake for a name that is no command.
function commandHelp(names: string[]): string {
  const { text, unknown } = commandsHelp(names);
  if (unknown.length > 0) throw new UsageError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${unknown.length === 1 ? 'a command' : 'commands'}. Type sm-dev --help to list them.`);
  return text;
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
  extension: boolean;
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
  /** `--from-saved`: the `.html` files among the pages are opened as saved pages. */
  fromSaved: boolean;
  /** `--url`: with `fromSaved` and one saved page, the URL to serve it at. */
  url?: string;
  /** `--offline`: with `fromSaved`, the saved pages' network requests are blocked. */
  offline: boolean;
  /** `--lang`: the languages the run's tabs prefer. */
  lang?: string[];
}

// The longest a Node timer waits: past it, it fires at once instead.
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

// sm-dev's own commands' flags that take a value, for finding the
// command's name past the flags that may come before it (`--detach
// start`).
const OWN_VALUE_FLAGS = new Set([...OWN_COMMANDS].flatMap((name) => Object.entries(commandSyntax(name).flags)
  .filter(([, kind]) => kind === 'value').map(([flag]) => flag)));

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    command: null, args: [],
    all: false, noTab: false, watch: false, extension: false, pageErrors: false, detach: false, newRun: false, noWait: false, fromSaved: false, offline: false,
  };
  // The command's name: the first word that is no flag, nor a flag's value.
  let at = 0;
  while (at < argv.length && argv[at].startsWith('-')) at += OWN_VALUE_FLAGS.has(argv[at]) ? 2 : 1;
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
  if (dashed) throw new UsageError(`Unknown option: ${dashed}`);
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
        if (opts.valuesFlag) throw new UsageError(`The ${flag} flag can't be used with ${opts.valuesFlag}`);
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
      case '--extension': opts.extension = true; break;
      case '--page-errors': opts.pageErrors = true; break;
      case '--devtools': opts.devtools = true; break;
      case '--nodevtools': opts.devtools = false; break;
      case '--detach': opts.detach = true; break;
      case '--new': opts.newRun = true; break;
      case '--nowait': opts.noWait = true; break;
      case '--from-saved': opts.fromSaved = true; break;
      case '--url': opts.url = text; break;
      case '--offline': opts.offline = true; break;
      case '--lang':
        try {
          opts.lang = parseLang(text);
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
        break;
      case '--idle-seconds': {
        const v = Number(text);
        if (!text || !Number.isFinite(v) || v < 0) throw new UsageError('The --idle-seconds flag needs a number of seconds');
        if (v > MAX_TIMER_SECONDS) throw new UsageError(`The --idle-seconds flag can be at most ${MAX_TIMER_SECONDS}`);
        opts.idleSeconds = v;
        break;
      }
      case '--seconds': {
        const v = Number(text);
        if (!text || !Number.isFinite(v) || v < 0) throw new UsageError('The --seconds flag needs a number');
        if (v > MAX_TIMER_SECONDS) throw new UsageError(`The --seconds flag can be at most ${MAX_TIMER_SECONDS}`);
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
  return validateAll(await validateSources(opts.args), lineRoots, print);
}

// `start` and `match` arguments: scripts, and the URLs the rest are,
// after globs are expanded and directories searched for scripts.
// `pages`: the rest as typed, beside their URLs.
function scriptsAndUrls(words: string[]): { scripts: string[]; urls: string[]; pages: PageWord[] } {
  const args = expandPathArgs(words, process.cwd(), { scripts: true });
  // Each once, so a repeat is neither checked nor opened twice.
  const pages = new Map<string, PageWord>();
  for (const word of args.filter((a) => !SCRIPT_ARG.test(a))) {
    // A script misnamed would otherwise be opened as a page, leaving
    // the run with no scripts.
    if (/\.js$/i.test(word) && !/^[a-z][a-z0-9+.-]*:/i.test(word)) throw new UsageError(`${word} is not a userscript: Its name doesn't end in .user.js`);
    const url = withDefaultScheme(word);
    if (!pages.has(url)) pages.set(url, { word, url });
  }
  return {
    scripts: [...new Set(args.filter((a) => SCRIPT_ARG.test(a)))],
    urls: [...pages.keys()],
    pages: [...pages.values()],
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
 * `start`: a run in a background process of its own, which it connects
 * to (see Client). It replaces the run the client works with, under the
 * same id; else, with `--detach`, the earlier detached runs, unless
 * `--new`. `words` are the command's own, for that process.
 */
async function startCommand(opts: Opts, words: string[], client: Client): Promise<number> {
  const { urls, files, scripts, devtools, saved } = await checkStart(opts);
  // The background process: the run itself.
  if (detachedLog) return runHere(opts, { files, given: scripts, urls, saved }, devtools, client.runId);
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
    if (id === undefined) print(`[sm-dev] Stopping the earlier detached run ${old.id}`);
    await stopRun(old, print);
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
    print(`[sm-dev] Run ${started.id} now running detached, with ${idle > 0 ? `idle timeout ${duration(idle)}` : 'no idle timeout'}`);
    print(`[sm-dev] Output log: ${runLogLabel(started.log, started.id)}`);
  }
  // Following its stream from here, when the line does more than look.
  if (client.follow) await client.connect();
  return 0;
}

// `start`'s arguments and flags, checked: its URLs, and its script
// files, which must exist. Also done before a line of several commands
// runs any.
async function checkStart(opts: Opts): Promise<{ urls: string[]; files: string[]; scripts: string[]; devtools: boolean; saved: (SavedPageStart | null)[] }> {
  const { scripts, urls, pages } = scriptsAndUrls(opts.args);
  if (opts.all && urls.length > 0) throw new UsageError('The --all flag opens each script\'s own page, so it can\'t be used with a URL');
  const remote = scripts.find((s) => REMOTE_SCRIPT.test(s));
  if (remote) throw new UsageError(`The start command loads scripts from files, and ${remote} is a URL. Save it to a file first.`);
  // Flags that contradict another, or would silently do nothing with it.
  const clash = (flag: string, others: [boolean, string][]): void => {
    const used = others.filter(([on]) => on).map(([, name]) => name);
    if (used.length > 0) throw new UsageError(`The ${flag} flag can't be used with ${used.join(' or ')}`);
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
  // Asked for by name, it must be able to run; on by default from the
  // environment, it just sits out the runs it can't serve.
  // The extension keeps its own storage, which a run doesn't seed.
  if (opts.valuesFlag) clash(opts.valuesFlag, [[opts.extension, '--extension']]);
  if (opts.devtools === true) clash('--devtools', [[lineTempBrowser, '--temp-browser']]);
  if (lineTempBrowser && opts.cdp !== undefined) throw new UsageError('The --temp-browser flag can\'t be used with --browser');
  if (lineOpenBrowser && opts.cdp !== undefined) throw new UsageError('The start command connects to the browser --open-browser starts, so give --browser once, first: sm-dev --open-browser --browser ... start ...');
  if (!opts.detach && !detachedLog && opts.newRun) throw new UsageError('The --new flag only applies with --detach');
  const devtools = devtoolsWanted(opts.devtools) && !lineTempBrowser;
  const files = await Promise.all(scripts.map((s) => scriptFile(s)));
  if (opts.fromSaved) clash('--from-saved', [[opts.all, '--all'], [opts.noTab, '--notab']]);
  // Read before the run starts, so a file that can't be opened is said now.
  const opened = await pagesToOpen(pages, opts);
  return { urls: opened.map((p) => p.url), files, scripts, devtools, saved: opened.map((p) => p.saved ?? null) };
}

// The run, in the background process `start` began: until a client
// sends `stop`, a signal, `--seconds`, or its idle timeout. Given the
// scripts' files (and each as typed), and the pages to open with the
// saved page each serves, if any.
async function runHere(
  opts: Opts,
  { files, given, urls, saved }: { files: string[]; given: string[]; urls: string[]; saved: (SavedPageStart | null)[] },
  devtools: boolean,
  runId: string | undefined,
): Promise<number> {
  // The run has no input: commands come from its clients.
  process.stdin.destroy();
  const { run } = await import('./run.js');
  // Ends on stop, a signal, or after --seconds. The timer is
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
      urls,
      saved,
      all: opts.all,
      noTab: opts.noTab,
      cdp: opts.cdp ?? lineCdp,
      tempBrowser: lineTempBrowser,
      headed: lineHeaded,
      lang: opts.lang,
      watch: opts.watch,
      values: opts.values,
      extension: opts.extension,
      pageErrors: opts.pageErrors,
      devtools,
      collectionRoot: lineRoots.collectionRoot,
      localRoots: lineRoots.localRoots,
      out: writeOutputLine,
      until,
      onStop: () => stop(),
      onActivity: touch,
      detached: opts.detach,
      log: detachedLog ?? undefined,
      runId,
      primaryPid,
      noWait: opts.noWait,
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
    env: { ...process.env, SM_DEV_DETACHED_LOG: log, SM_DEV_PRIMARY_PID: String(process.pid) },
  });
  await writing.close();
  let ready: { id: string | null } | null = null;
  let exitCode: number | null = null;
  child.on('message', (m: { ready?: string | null }) => { if (m && 'ready' in m) ready = { id: m.ready ?? null }; });
  // Its exit code, for a client that waits for it to end (--seconds),
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
  // Ended before it was ready, with nothing wrong: `--seconds 0`, say.
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

function checkClear(opts: Opts): void {
  if (!opts.extension) throw new UsageError('The clear command needs --extension; the harness itself keeps nothing between runs');
  if (lineTempBrowser) throw new UsageError('The clear command has nothing to clear in a --temp-browser, whose scratch scripts go when its run ends');
}

async function clearCommand(opts: Opts): Promise<number> {
  checkClear(opts);
  const { connectBrowser } = await import('./run.js');
  const { ExtensionBackend } = await import('./extension-backend.js');
  const out = (line: string): void => { process.stdout.write(line + '\n'); };
  const session = await connectBrowser({ cdp: opts.cdp ?? lineCdp, tempBrowser: false, headed: false }, out);
  if (!session) return 1;
  try {
    const backend = await ExtensionBackend.connect(session.context);
    const count = await backend.clear();
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

// Drawn around the prompt, when one is showing.
function print(line: string): void {
  writeOutputLine(line);
}

async function listCommand(): Promise<number> {
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (runs.length === 0) print(NO_RUNS);
  else for (const line of runTable(runs)) print(line);
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
  /** Set by `exit`: the commands after it aren't run. */
  exiting = false;
  private connection: RunClient | null = null;
  /** Runs it started without `--detach`, with their logs and exit codes. */
  private readonly owned = new Map<string, { log: string; exited: Promise<number>; hold?: () => void }>();
  /** Set by a `start` with `--seconds`, whose run ends on its own. */
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
    const { RunClient } = await import('./runs.js');
    const connection = await RunClient.open(target.id, print, { follow: this.follow });
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
    const connection = await this.connect();
    return connection.send(text, { words, source });
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
   * Waits for a run started with `--seconds` to end on its own, as the
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
    print(`[sm-dev] Output log: ${runLogLabel(run.log, id)}`);
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
      if (record && !await stopRun(record, print)) code = 1;
      print(`[sm-dev] Output log: ${runLogLabel(log, id)}`);
    }
    this.owned.clear();
    return code;
  }
}

const NO_RUN_TO_USE = `${NO_RUNS}. Start one with sm-dev start.`;

// The run a command acts on: the one named, else the only one going.
async function targetRun(wanted: string | undefined): Promise<RunRecord> {
  const { liveRuns, runTable } = await import('./runs.js');
  const runs = await liveRuns();
  if (wanted !== undefined) {
    const found = runs.find((r) => r.id === wanted);
    if (!found) throw new Error(`There is no run ${wanted}. Type sm-dev list to see the runs.`);
    return found;
  }
  if (runs.length === 0) throw new Error(NO_RUN_TO_USE);
  if (runs.length > 1) throw new UsageError(['Several runs are active. Pick one with --run, or attach to one:', ...runTable(runs)].join('\n'));
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
      for (const line of echoed('arg', command)) print(line);
      code = await client.send(command.text, 'arg');
      if (stopsLine(code, commandWords(command.text))) {
        if (i < list.commands.length - 1) process.stderr.write(`${LINE_STOPPED}\n`);
        return code;
      }
    }
    return code;
  }
  // The words go as the shell gave them, so a selector or text with
  // spaces reaches a page command as one word.
  return client.send(words.join(' '), 'arg', words);
}

const MATCH_NEEDS = 'The match command needs a script (a .user.js file) and at least one URL, or a run to take them from';
const VALIDATE_NEEDS = 'The validate command needs at least one path, or a run to take the script from';
const NEEDS_A_RUN: Record<string, string> = {
  match: MATCH_NEEDS,
  validate: VALIDATE_NEEDS,
  // It would only pause, with nothing to show meanwhile.
  wait: 'The wait command needs a run to watch. Start or attach one first.',
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
  const name = 'line' in input ? input.line.trim().split(/\s+/)[0] : input.words[0];
  const first = lineFlag(name);
  if (first) return globalFlagMistake(first);
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
  return `${name} is not a command a run takes. Type sm-dev help to list them.`;
}

/**
 * A command as this client echoes it, headed by where it came from
 * (`stdin > eval {{`, then `... ` lines); the run heads other clients'
 * commands with who sent them too (see commandMark in run.ts).
 */
function echoed(source: CommandSource, command: AssembledCommand): string[] {
  const [first, ...rest] = echoCommand(command);
  return [`${source} ${first}`, ...rest];
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
    print(commandsHelp([help]).text.trimEnd());
    return 0;
  }
  if (runsHere(command.words)) {
    echo();
    return runOne(command.words, client);
  }
  try {
    await client.connect();
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
      const heading = commands.length > 1 ? [`stdin > ${command.text}`] : echoed('stdin', source);
      code = await runTyped(command, client, 'stdin', () => { for (const l of heading) print(l); });
      ran++;
      if (client.exiting) return false;
      if (stopsLine(code, command.words)) {
        if (more || i < commands.length - 1 || !ended || queue.length > 0) process.stderr.write(`${LINE_STOPPED}\n`);
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
      if (got && 'error' in got) mistakes.push(`ERROR: Line ${n}: ${got.error}`);
      else if (got) {
        const commands = typedCommands(got.command.text);
        let wrong = false;
        for (const command of commands) {
          const mistake = await typedMistake(command);
          if (!mistake) continue;
          if (!wrong) mistakes.push(...echoed('stdin', got.command));
          wrong = true;
          mistakes.push(`ERROR: ${mistake}`);
        }
        if (!wrong) batch.push({ commands, source: got.command });
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
    for (const [i, { commands, source }] of batch.entries()) {
      if (!await run(commands, source, i < batch.length - 1)) return ran === 0 ? null : code;
    }
    for (let got = await next(); got !== null; got = await next()) {
      if (typeof got !== 'string') continue;
      n++;
      const assembled = blocks.push(got);
      if (!assembled) continue;
      if ('error' in assembled) {
        process.stderr.write(`ERROR: Line ${n}: ${assembled.error}\n${LINE_STOPPED}\n`);
        return 1;
      }
      const commands = typedCommands(assembled.command.text);
      for (const command of commands) {
        const mistake = await typedMistake(command);
        if (!mistake) continue;
        for (const l of echoed('stdin', assembled.command)) process.stderr.write(`${l}\n`);
        process.stderr.write(`ERROR: ${mistake}\n${LINE_STOPPED}\n`);
        return 1;
      }
      if (!await run(commands, assembled.command, false)) return code;
    }
    const unclosed = blocks.drop();
    if (unclosed !== null) {
      process.stderr.write(`ERROR: ${unclosedBlockMessage(unclosed)}, so it was not run\n`);
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
function promptCommands(client: Client): Promise<number> {
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
            print(`ERROR: ${mistake}`);
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
    });
  });
}

// sm-dev's own commands, which run in this process rather than going
// to a run, when read from stdin or typed at the prompt.
function runsHere(words: string[]): boolean {
  const name = words[0];
  if (name === 'match' || name === 'validate') return !needsRun(words);
  return name !== undefined && HERE.has(name);
}

// Ones that need no run, or act on runs themselves.
const HERE = new Set(['start', 'attach', 'stop', 'exit', 'list', 'clear', 'help']);

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
  const stopped = await Promise.all(targets.map((r) => stopRun(r, several ? (line) => print(`[${r.id}] ${line}`) : print)));
  for (const r of targets) {
    const log = client.stopped(r.id);
    if (log) print(`[sm-dev] Output log: ${runLogLabel(log, r.id)}`);
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
  const { id } = await client.connect(named ?? globalRun);
  client.own = false;
  print(`[sm-dev] Attached to run ${id}`);
  return 0;
}

const HELP_FLAGS = new Set(['--help', '-h']);

// The `help` command's topics, or null for another command; empty for
// the whole help. `--help` is handled for the whole line (`lineHelp`).
function helpTopics(argv: string[]): string[] | null {
  if (argv[0] !== 'help' && argv[0] !== '?') return null;
  // `help --help`: help's own help, as for any command.
  const topics = argv.slice(1).filter((w) => !HELP_FLAGS.has(w));
  return topics.length === 0 && argv.length > 1 ? ['help'] : topics;
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
    const rest = words.filter((w) => !HELP_FLAGS.has(w));
    // `help status`: its topics. Otherwise the command's name, which
    // may come after its flags (`--detach start`).
    // `help --help` alone: help's own.
    const topics = rest.length === 1 ? ['help'] : rest.slice(1);
    const named = rest[0] === 'help' || rest[0] === '?' ? topics : rest.filter((w) => !w.startsWith('-')).slice(0, 1);
    for (const name of named) if (!names.includes(name)) names.push(name);
  }
  return names.length === 0 ? fullHelp() : commandHelp(names);
}

// The signals that end sm-dev: Ctrl-C, kill, and a closed terminal.
// Windows has no SIGHUP to listen for.
const STOP_SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

// After a command of several that failed.
const LINE_STOPPED = 'That command failed, so the commands after it were not run';

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
// `--browser` wins) and for `--open-browser`.
let lineCdp: string | undefined;
// `--open-browser` and `--profile`: a lasting browser to start first.
let lineOpenBrowser = false;
let lineProfile: string | undefined;
// `--temp-browser` and `--headed`: a browser of each run's own, closed
// with it.
let lineTempBrowser = false;
let lineHeaded = false;


// The flags for the whole line, which go before any command.
const GLOBAL_FLAGS = ['--run', '--root', '--local', '--stdin', '--interactive', '--browser', '--open-browser', '--profile', '--temp-browser', '--headed'];

function globalFlagMistake(flag: string): string {
  return `The ${flag} flag is for the whole command line, so it goes first, before any command: sm-dev ${flag}${VALUE_GLOBALS.has(flag) ? ' ...' : ''} <command>`;
}

const VALUE_GLOBALS = new Set(['--run', '--root', '--local', '--browser', '--profile']);

interface GlobalFlags {
  stdin: boolean;
  interactive: boolean;
  /** The words after the flags: the commands. */
  rest: string[];
}

/**
 * Takes the global options off the front of the line: `--run ID`,
 * `--root DIR`, `--local DIR` (repeatable), `--stdin`, `--interactive`
 * and the browser's: `--browser`, `--open-browser`, `--profile`,
 * `--temp-browser`, `--headed`. One later on the line, among a
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
    else if (word === '--temp-browser') lineTempBrowser = true;
    else if (word === '--headed') lineHeaded = true;
    else {
      const value = inline ?? argv[++i];
      // Not the next option taken for this one's value (`--browser --open-browser`).
      if (value === undefined || value === '' || value === SEPARATOR || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError(word === '--run' ? 'The --run flag needs a run ID, e.g. --run D2' : `The ${word} flag needs a value`);
      }
      if (word === '--run') globalRun = checkedRunId(value);
      else if (word === '--browser') lineCdp = value;
      else if (word === '--profile') lineProfile = path.resolve(value);
      else if (word === '--root') collectionRoot = path.resolve(value);
      else localRoots.push(path.resolve(value));
      if (word === '--root' || word === '--local') rootsGiven = true;
    }
  }
  lineRoots = { collectionRoot, localRoots };
  flags.rest = argv.slice(i);
  // The browser: one of --browser, --open-browser and --temp-browser's own.
  if (lineTempBrowser) {
    const others = [[lineCdp !== undefined, '--browser'], [lineOpenBrowser, '--open-browser']].filter(([on]) => on).map(([, name]) => name);
    if (others.length > 0) throw new UsageError(`The --temp-browser flag can't be used with ${others.join(' or ')}`);
  }
  if (lineHeaded && !lineTempBrowser) throw new UsageError('The --headed flag only applies with --temp-browser');
  if (lineProfile !== undefined && !lineOpenBrowser) throw new UsageError('The --profile flag only applies with --open-browser');
  return flags;
}

// A global option with its value in the same word (`--browser=9300`), as
// the option and the value; else the word and no value.
function splitInline(word: string): [string, string | undefined] {
  const eq = word.indexOf('=');
  if (eq > 0 && VALUE_GLOBALS.has(word.slice(0, eq))) return [word.slice(0, eq), word.slice(eq + 1)];
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
    ...(lineTempBrowser ? ['--temp-browser'] : []),
    ...(lineHeaded ? ['--headed'] : []),
  ];
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
  | { kind: 'help'; topics: string[] }
  | { kind: 'send'; words: string[] }
  | { kind: 'cli'; opts: Opts; words: string[] };


function parseCommand(words: string[]): ParsedCommand {
  const topics = helpTopics(words);
  if (topics) return { kind: 'help', topics };
  if (words.length === 0) throw new UsageError(`A command is needed. ${LIST_COMMANDS}`);
  // A run's command may come as one argument: `'eval T1 x'`. One of
  // several lines is a list of them, and never sm-dev's own.
  if (words.length === 1 && words[0].includes('\n')) return { kind: 'send', words };
  if (SHARED_COMMANDS.has(words[0]) && needsRun(words)) return { kind: 'send', words };
  const head = words.length === 1 ? words[0].trim().split(/\s+/)[0] : words[0];
  if (!OWN_COMMANDS.has(words[0]) && isTypedCommand(head)) return { kind: 'send', words };
  // One of sm-dev's own sent as one word (`'stop D1'`): split as typed.
  if (words.length === 1 && OWN_COMMANDS.has(head) && head !== words[0]) return parseCommand(commandWords(words[0]));
  const opts = parseArgs(words);
  if (opts.command === null) throw new UsageError(`A command is needed. ${LIST_COMMANDS}`);
  if (opts.help) return { kind: 'help', topics: [opts.command] };
  if (!OWN_COMMANDS.has(opts.command)) {
    // A run's ID where the command goes: the old `sm-dev D1 status`.
    const run = runIdOf(opts.command);
    if (run) throw new UsageError(`Name the run with --run, before the command: sm-dev --run ${run} ${words.slice(1).map(shellWord).join(' ')}`.trimEnd());
    throw new UsageError(`Unknown command: ${opts.command}. ${LIST_COMMANDS}`);
  }
  return { kind: 'cli', opts, words };
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
    if (parsed.topics.length > 0) commandHelp(parsed.topics);
    return;
  }
  if (parsed.kind === 'send') return checkSend(parsed.words);
  const { opts } = parsed;
  switch (opts.command) {
    case 'validate': return checkValidate(opts);
    case 'match': return checkMatch(opts);
    case 'start': await checkStart(opts); return;
    case 'attach': checkAttach(opts); return;
    case 'clear': return checkClear(opts);
    case 'stop': checkStop(opts); return;
  }
}

// Prints a command's mistake, and returns its exit code. One in how the
// command was typed is marked as such, apart from a failure doing it.
function printMistake(err: unknown): number {
  const usage = err instanceof UsageError;
  process.stderr.write(`${usage ? 'ERROR: ' : ''}${(err as Error).message}\n`);
  return usage ? 2 : 1;
}

/** One command. Prints its own errors, and returns its exit code. */
async function runOne(words: string[], client: Client): Promise<number> {
  try {
    const parsed = parseCommand(words);
    if (parsed.kind === 'help') {
      for (const line of (parsed.topics.length === 0 ? fullHelp() : commandHelp(parsed.topics)).trimEnd().split('\n')) print(line);
      return 0;
    }
    if (parsed.kind === 'send') return await sendCommand(parsed.words, client);
    const { opts } = parsed;
    switch (opts.command) {
      case 'validate': return await validate(opts);
      case 'match': return await match(opts);
      case 'start': return await startCommand(opts, parsed.words, client);
      case 'attach': return await attachCommand(opts, client);
      case 'clear': return await clearCommand(opts);
      case 'list': return await listCommand();
      case 'exit':
        client.exiting = true;
        return 0;
      default: return await stopCommand(opts, client);
    }
  } catch (err) {
    return printMistake(err);
  }
}

const START_ALONE = 'The start command with nothing after it would stop the run as soon as it started. Add --interactive for a prompt, --detach to leave it running, --seconds N to watch it for a while, or commands after --.';

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
  // Not again from a detached run's own process, nor where tests turn it off.
  if (!detachedLog && !process.env.SM_DEV_NO_STALE_WARNING) {
    const stale = staleBuildWarning();
    if (stale) process.stderr.write(`${stale}\n`);
  }
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
    process.stdout.write(fullHelp());
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
      if (commands.length > 1) process.stderr.write(`arg > ${words.map(shellWord).join(' ')}\n`);
      failed = Math.max(failed, printMistake(err));
    }
  }
  if (failed) {
    if (commands.length > 1) process.stderr.write(`${NONE_RUN}\n`);
    process.exitCode = failed;
    return;
  }
  // A `start` with nothing after it to keep it going: it would start the
  // run and stop it again straight away. Its flags can come first.
  const last = commands.at(-1);
  const ending = last && parseCommand(last).kind === 'cli' ? parseArgs(last) : null;
  if (ending?.command === 'start' && !ending.detach && ending.seconds === undefined && !stdin && !flags.interactive) {
    process.exitCode = printMistake(new UsageError(START_ALONE));
    return;
  }
  // --temp-browser and --headed shape the runs this line starts; with no
  // start to use them, they'd be silently ignored.
  const starts = commands.some((words) => parseCommand(words).kind === 'cli' && parseArgs(words).command === 'start');
  if ((lineTempBrowser || lineHeaded) && !starts && !stdin && !flags.interactive) {
    process.exitCode = printMistake(new UsageError(`The ${lineTempBrowser ? '--temp-browser' : '--headed'} flag is for the runs a start begins, and this line has no start`));
    return;
  }
  // The lasting browser first, for the commands to connect to.
  if (lineOpenBrowser) {
    const { launchBrowser, launchEndpointMistake } = await import('./browser-launch.js');
    const { browserSettingName, cdpEndpoint } = await import('./run.js');
    try {
      const endpoint = cdpEndpoint(lineCdp?.trim() || process.env.SM_DEV_BROWSER?.trim() || '9233');
      const mistake = launchEndpointMistake(endpoint, browserSettingName(lineCdp));
      if (mistake) throw new UsageError(mistake);
      await launchBrowser(endpoint, lineProfile, print);
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
      if (commands.length > 1) print(`arg > ${words.map(shellWord).join(' ')}`);
      code = await runOne(words, client);
      if (client.exiting) break;
      // A miss from match or validate is an answer, not a failure: the
      // line goes on, and it only sets the exit code if it is last.
      if (stopsLine(code, words)) {
        if (i < commands.length - 1 || stdin || flags.interactive) process.stderr.write(`${LINE_STOPPED}\n`);
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
        code = await promptCommands(client);
      } else if (watching) {
        await client.watch();
      } else {
        // A run started with --seconds, left to end on its own.
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
