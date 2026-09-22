#!/usr/bin/env node
// `sm-dev`: the command-line side of the development harness.
//
// Every command prints plain text meant to be read by a person or an
// agent iterating on a userscript.
//
//   sm-dev validate <path>...        the install-time checks (Node only)
//   sm-dev match <script> <url>...   would the script run there? (Node only)
//   sm-dev run <script>... [--url U] inject into a browser and stream
//                                    what happens
//   sm-dev probe <url> --selectors S which selectors resolve on a page
//   sm-dev snapshot <url> --out F    save a page's DOM for a spec
//   sm-dev clear --extension         drop every pushed script
//
// Exit codes: 0 when every script checked out (or every URL matched,
// no script threw, every selector was found), 1 when one didn't, 2 for
// a usage error.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { explainMatch, prepareScript } from './prepare.js';

const USAGE = `Usage: sm-dev <command> [options]

Commands:
  validate <path>...          Run the install-time checks over files or
                              directories of *.user.js
  match <script> <url>...     Say whether the script would run on each URL
  run <script>...             Inject the script(s) into a page and stream
                              console lines and reports until Ctrl-C
  probe <url>                 Report which --selectors resolve on the page
  snapshot <url>              Save the page's DOM to --out FILE
  clear --extension           Remove every script pushed into the extension
                              and turn solo mode off

Options:
  --root DIR      The repo root, searched for local copies of @require
                  URLs (default: the current directory)
  --local DIR     Another directory to search; repeatable

Options for the browser commands (run, probe, snapshot):
  --cdp URL       Browser to connect to (default: $SM_DEV_CDP or
                  http://127.0.0.1:9233)
  --launch        Launch a Chromium instead of connecting; --headed shows it

Options for run:
  --url URL       The page to open (default: the first page the script's
                  @match implies)
  --watch         Re-inject and reload when a script or its files change
  --values JSON   Seed GM_* storage, e.g. --values '{"units":"metric"}'
  --fire-menu S   Fire the registered menu command named S after load
  --for SECONDS   Stop after this long instead of waiting for Ctrl-C
  --extension     Push the script into the SourceMonkey extension in
                  that browser instead of injecting it; reports come
                  from the script's Log tab
  --solo          With --extension: disable every other collection for
                  the run and restore them after

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
  for?: number;
  selectors: string[];
  selectorFlags: number;
  html: boolean;
  outFile?: string;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    command: null, args: [], root: process.cwd(), local: [],
    launch: false, headed: false, watch: false, extension: false, solo: false,
    selectors: [], selectorFlags: 0, html: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--root': opts.root = path.resolve(next()); break;
      case '--local': opts.local.push(path.resolve(next())); break;
      case '--url': opts.url = next(); break;
      case '--cdp': opts.cdp = next(); break;
      case '--launch': opts.launch = true; break;
      case '--headed': opts.headed = true; break;
      case '--watch': opts.watch = true; break;
      case '--values': {
        const raw = next();
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          opts.values = parsed as Record<string, unknown>;
        } catch {
          throw new Error('--values needs a JSON object');
        }
        break;
      }
      case '--fire-menu': opts.fireMenu = next(); break;
      case '--extension': opts.extension = true; break;
      case '--solo': opts.solo = true; break;
      case '--selectors': {
        // One flag with commas is a list; a selector that needs a comma
        // (`:is(a, b)`) goes in its own flag, which is taken whole.
        const raw = next();
        opts.selectorFlags++;
        opts.selectors.push(raw.trim());
        break;
      }
      case '--html': opts.html = true; break;
      case '--out': opts.outFile = path.resolve(next()); break;
      case '--for': {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new Error('--for needs a number of seconds');
        opts.for = v;
        break;
      }
      case '--help': case '-h': opts.command = 'help'; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
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
    const info = await stat(full).catch(() => {
      throw new Error(`No such file or directory: ${input}`);
    });
    if (info.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
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
  if (opts.args.length === 0) throw new Error('The validate command needs at least one path');
  const files = await collectScripts(opts.args);
  if (files.length === 0) throw new Error('No *.user.js files found');
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
  const [script, ...urls] = opts.args;
  if (!script || urls.length === 0) throw new Error('The match command needs a script and at least one URL');
  const prepared = await prepareScript({
    file: path.resolve(script),
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
      process.stdout.write(`no match ${url}\n    ${verdict.rule ?? 'No @match or @include covers it'}\n`);
    }
  }
  return misses === 0 ? 0 : 1;
}

async function runCommand(opts: Opts): Promise<number> {
  if (opts.args.length === 0) throw new Error('The run command needs at least one script');
  const { run } = await import('./run.js');
  // Ends on Ctrl-C, or after --for seconds. Without a bound the loop
  // keeps streaming, which is the interactive case. The timer is
  // unreferenced so it can't hold the process open after an early
  // exit, and the listener comes off once the run has ended.
  let onSigint: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const until = new Promise<void>((resolve) => {
    onSigint = () => resolve();
    process.once('SIGINT', onSigint);
    if (opts.for !== undefined) timer = setTimeout(resolve, opts.for * 1000).unref();
  });
  try {
    return await run({
      files: opts.args.map((a) => path.resolve(a)),
      url: opts.url,
      cdp: opts.cdp,
      launch: opts.launch,
      headed: opts.headed,
      watch: opts.watch,
      values: opts.values,
      fireMenu: opts.fireMenu,
      extension: opts.extension,
      solo: opts.solo,
      collectionRoot: opts.root,
      localRoots: opts.local,
      out: (line) => process.stdout.write(line + '\n'),
      until,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onSigint) process.off('SIGINT', onSigint);
  }
}

async function probeCommand(opts: Opts): Promise<number> {
  const [url] = opts.args;
  if (!url) throw new Error('The probe command needs a URL');
  if (opts.selectors.length === 0) throw new Error('The probe command needs --selectors');
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
  const [url] = opts.args;
  if (!url) throw new Error('The snapshot command needs a URL');
  if (!opts.outFile) throw new Error('The snapshot command needs --out');
  const { snapshot } = await import('./browser-commands.js');
  return snapshot({
    url, outFile: opts.outFile,
    cdp: opts.cdp, launch: opts.launch, headed: opts.headed,
    out: (line) => process.stdout.write(line + '\n'),
  });
}

async function clearCommand(opts: Opts): Promise<number> {
  if (!opts.extension) throw new Error('The clear command needs --extension; the harness itself keeps nothing between runs');
  const { connectBrowser } = await import('./run.js');
  const { ExtensionBackend } = await import('./extension-backend.js');
  const out = (line: string): void => { process.stdout.write(line + '\n'); };
  const session = await connectBrowser(opts, out);
  if (!session) return 1;
  try {
    const backend = await ExtensionBackend.connect(session.context);
    const count = await backend.clear();
    // A run killed before it could turn solo mode off leaves the user's
    // collections disabled; clearing is the natural place to put them
    // back.
    await backend.solo(false);
    out(`[sm-dev] removed ${count} pushed script(s)`);
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
    process.exitCode = 2;
  }
}

await main();
