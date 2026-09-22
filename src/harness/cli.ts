#!/usr/bin/env node
// `sm-dev`: the command-line side of the development harness.
//
// Every command prints plain text meant to be read by a person or an
// agent iterating on a userscript. The commands that need a browser
// come later; these two run entirely in Node:
//
//   sm-dev validate <path>...        the install-time checks
//   sm-dev match <script> <url>...   would the script run there?
//
// Exit codes: 0 when every script checked out (or every URL matched),
// 1 when one didn't, 2 for a usage error.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { explainMatch, prepareScript } from './prepare.js';

const USAGE = `Usage: sm-dev <command> [options]

Commands:
  validate <path>...          Run the install-time checks over files or
                              directories of *.user.js
  match <script> <url>...     Say whether the script would run on each URL

Options:
  --root DIR      The repo root, searched for local copies of @require
                  URLs (default: the current directory)
  --local DIR     Another directory to search; repeatable
`;

interface Opts {
  command: string | null;
  args: string[];
  root: string;
  local: string[];
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { command: null, args: [], root: process.cwd(), local: [] };
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
