#!/usr/bin/env node
// Record individual facts about one corpus script at a time in corpus.json, as
// they're learned: the result of trying it on its target site, a tag, a dated
// note. It doesn't compute anything over the corpus; the one bulk command is
// `validate`, which records the corpus validator's verdict for every script.
//
// This is the only tool that writes findings. Every write goes through
// updateCorpus(), so parallel agents can record results at once.
//
// Usage:
//   node tests/greasyfork-examples/record-results.mjs <command> [args]
//
//   validate                 run the corpus validator over every downloaded
//                            script and import the verdicts (needs `pnpm run build`)
//   import-validation FILE   import an existing `validate-corpus.mjs --json FILE`
//                            run; names resolve against --base (default: repo root)
//   show ID                  print one record
//   list [filters]           one line per script, in listing order:
//                              --untested  no test result yet
//                              --test S    test status S
//                              --valid S   validation status S
//                              --tag T     carries tag T (either source; repeatable)
//                              --limit N
//   set ID [options]         record a finding:
//                              --test pass|fail|n/a
//                              --reason R   why it's n/a, with --test n/a only (see REASONS)
//                              --blame B    whose fault a failure is (see BLAMES)
//                              --note TEXT  markdown; --note-file PATH reads it from a file
//                              --replace-note N  the note replaces note N (from 1, in the
//                                           order show lists them) instead of adding one
//                              --remove-note N   drop note N (from 1)
//                              --tag T / --untag T  (repeatable)
//                              --version V  default: the @version of the copy in files/ now
//                              --date D     default: today (YYYY-MM-DD)
//   help                     print this (so does --help or -h, anywhere)
//
// Global, before or after the command: --corpus PATH (default corpus.json here),
// --root PATH (download root).
// The record format is described in README.md ("Test results").

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValue, getValues, parseHeader } from '../../dist/userscript-header.js';
import { resolveGrants } from '../../dist/gm-api-catalog.js';
import { describeDiagnostic } from '../../dist/diagnostic-location.js';
import { matchPatternProblem } from '../../dist/url-match.js';
import {
  CORPUS_JSON, checkRoot, findExisting, listingRows, patternTarget, printHelp, readCorpus, updateCorpus,
} from './corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const TEST_STATUSES = ['pass', 'fail', 'n/a'];
// Why a script couldn't be meaningfully tried. Kept to a fixed set so the
// report can filter on it; `other` plus a note covers the rest.
const REASONS = [
  'requires-login',     // needs an account on the target site
  'paid',               // needs a paid subscription or purchase
  'geo-blocked',        // the site refuses our region
  'bot-blocked',        // a bot check (captcha, Cloudflare, WAF) we can't get past, headed too
  'unsafe',             // we chose not to run it: it harvests credentials, spams, or drives accounts or money
  'site-gone',          // the target site no longer exists or answers
  'needs-interaction',  // only does something after a manual flow we can't script
  'not-web',            // targets local files, browser pages, or no real site
  'other-browser',      // relies on another browser's features (Firefox-only APIs, old Opera)
  'other',
];
const BLAMES = [
  'sourcemonkey',  // SourceMonkey lacks a feature or has a bug; file it in TODO.md
  'script',        // the script is broken or out of date against the current site
  'unknown',
];

// Headers another manager acts on that SourceMonkey accepts and ignores, per
// docs/supported-headers.md. A script declaring one may behave differently.
const IGNORED_HEADERS = ['exclude-match', 'run-in', 'sandbox', 'top-level-await', 'unwrap', 'webrequest'];

function today() {
  // en-CA formats as YYYY-MM-DD, in local time.
  return new Date().toLocaleDateString('en-CA');
}

// The options each command takes, beyond --corpus and --root. Anything else is
// refused, so a typo (`--tst pass`) can't silently record half a finding.
const COMMAND_OPTIONS = {
  'validate': ['date'],
  'import-validation': ['base', 'date'],
  'show': [],
  'list': ['untested', 'test', 'valid', 'tag', 'limit'],
  'set': ['test', 'reason', 'blame', 'note', 'note-file', 'replace-note', 'remove-note', 'tag', 'untag', 'version', 'date'],
};

function parseArgs(command, argv) {
  const allowed = new Set(['corpus', 'root', ...COMMAND_OPTIONS[command]]);
  const opts = {
    corpus: CORPUS_JSON,
    root: path.join(HERE, 'files'),
    base: REPO_ROOT,
    positional: [],
    tag: [],
    untag: [],
  };
  const repeatable = new Set(['tag', 'untag']);
  const flags = new Set(['untested']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts.positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.has(name)) throw new Error(`The ${command} command doesn't take ${arg}`);
    if (flags.has(name)) { opts[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    if (repeatable.has(name)) opts[name].push(value);
    else opts[name] = value;
  }
  for (const key of ['corpus', 'root', 'base']) opts[key] = path.resolve(opts[key]);
  if (opts.note !== undefined && opts['note-file'] !== undefined) {
    throw new Error('Pass --note or --note-file, not both');
  }
  if (opts.limit !== undefined && !(Number(opts.limit) >= 1)) throw new Error('The --limit option must be a positive number');
  return opts;
}

function oneOf(value, allowed, what) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(`Unknown ${what} "${value}". Use one of: ${allowed.join(', ')}.`);
  }
}

// ---------- validation import ----------

/** Absolute on-disk path → script id, for every downloaded corpus script. */
async function scriptFiles(corpus, root) {
  await checkRoot(root);
  const byFile = new Map();
  for (const row of listingRows(corpus)) {
    const file = await findExisting(root, row.script_url);
    if (file) byFile.set(file, row.id);
  }
  return byFile;
}

/**
 * The sites the downloaded copy targets, from its `@match` / `@include` lines,
 * for the results page. Stored so the page needs nothing but corpus.json.
 */
function targetSites(source) {
  const header = parseHeader(source);
  if (!header) return [];
  const patterns = header.tags.filter((t) => (t.tag === 'match' || t.tag === 'include') && !t.locale);
  return [...new Set(patterns.map((t) => patternTarget(t.value)).filter(Boolean))].sort();
}

/**
 * Tags derived from the header: features SourceMonkey doesn't support that
 * don't make the script invalid. Read from the parsed header rather than the
 * validator's warning text, so a reworded message can't drop a tag.
 */
function headerTags(source) {
  const header = parseHeader(source);
  if (!header) return [];
  // Some scripts misuse `@grant` lines as comments; only an API-shaped name
  // (GM_x, GM.x, window.x, unsafeWindow) is a feature request worth a tag.
  const tags = resolveGrants(getValues(header, 'grant')).unknown
    .map((g) => (/^(GM[._]\w+|window\.\w+|unsafeWindow)$/.test(g) ? `unsupported-grant:${g}` : 'malformed-grant'));
  // A `@match` Chrome would refuse is dropped at registration, so the script
  // may never run on some of the pages it was written for.
  if (getValues(header, 'match').some((m) => matchPatternProblem(m))) tags.push('ignored-match');
  for (const name of IGNORED_HEADERS) {
    if (header.tags.some((t) => t.tag === name && !t.locale)) tags.push(`ignored-header:@${name}`);
  }
  return [...new Set(tags)];
}

function safeDecode(name) {
  try { return decodeURIComponent(name); } catch { return name; }
}

async function importValidation(opts, results, unchecked = []) {
  const date = opts.date ?? today();
  const corpus = await readCorpus(opts.corpus);
  const byFile = await scriptFiles(corpus, opts.root);

  // Read and derive everything before taking the lock, so the lock is held
  // only for the merge.
  const updates = new Map();
  let unmatched = 0;
  for (const result of results) {
    const file = path.resolve(opts.base, result.name);
    const id = byFile.get(file);
    if (id === undefined) { unmatched++; continue; }
    // The location names the script by its on-disk file name: percent-encoded,
    // sometimes hash-truncated, and redundant in a row that is the script.
    const own = path.basename(file);
    const describe = (message, location) => describeDiagnostic(message, location && {
      ...location,
      file: location.file === own ? 'the script' : safeDecode(location.file),
    });
    // Only real warnings: an `info` note (no `@connect`, say) isn't one.
    const warnings = (result.warnings ?? [])
      .filter((w) => w.level !== 'info')
      .map((w) => describe(w.message, w.location));
    // `ok` with a category is a check that couldn't decide (see the validator's
    // classify()); worth seeing, but not a failure.
    if (result.status === 'ok' && result.category !== 'ok') warnings.push(`${result.category}: ${result.detail}`);
    const valid = { status: result.status };
    if (result.status !== 'ok') {
      valid.error = result.errorMessage ? describe(result.errorMessage, result.location) : result.detail;
    }
    if (warnings.length) valid.warnings = warnings;
    const source = await readFile(file, 'utf8');
    const tags = headerTags(source);
    if (tags.length) valid.tags = tags;
    valid.date = date;
    if (result.version) valid.version = result.version;
    updates.set(id, { version: result.version, file: path.relative(opts.root, file), sites: targetSites(source), valid });
  }

  await updateCorpus(opts.corpus, (live) => {
    for (const id of unchecked) {
      const record = live[id];
      if (record) { delete record.valid; delete record.sites; delete record.version; delete record.file; }
    }
    for (const [id, update] of updates) {
      const record = live[id] ?? (live[id] = {});
      if (update.version) record.version = update.version;
      else delete record.version;
      record.file = update.file;
      if (update.sites.length) record.sites = update.sites;
      else delete record.sites;
      record.valid = update.valid;
    }
  });

  const counts = {};
  for (const { valid } of updates.values()) counts[valid.status] = (counts[valid.status] ?? 0) + 1;
  const tagged = [...updates.values()].filter((u) => u.valid.tags).length;
  console.info(`Imported ${updates.size} verdicts: ${JSON.stringify(counts)}, ${tagged} with derived tags`);
  if (unmatched) console.info(`${unmatched} validator records matched no corpus script`);
}

async function runValidator(opts) {
  const corpus = await readCorpus(opts.corpus);
  const byFile = await scriptFiles(corpus, opts.root);
  const checked = new Set(byFile.values());
  const missing = listingRows(corpus).map((row) => row.id).filter((id) => !checked.has(id));
  if (missing.length) console.info(`${missing.length} listed scripts aren't downloaded; clearing their verdicts`);
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-validate-'));
  const json = path.join(dir, 'results.json');
  try {
    const args = ['tests/greasyfork-examples/validate-corpus.mjs', '--offline-root', opts.root, '--json', json, '--quiet', ...byFile.keys()];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', resolve);
    });
    // Exit 1 with a JSON file means some script hit a `tool error`: those are
    // recorded like any other verdict. Without the file, the run itself failed.
    const results = await readFile(json, 'utf8').then(JSON.parse, () => null);
    if (!results) throw new Error(`The validator exited with status ${code} and wrote no results`);
    // Only a full run knows these weren't checked; a stale verdict would look current.
    await importValidation({ ...opts, base: REPO_ROOT }, results, missing);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- set / show / list ----------

/**
 * The `@version` of the copy in files/ now, which may be newer than the one
 * `validate` last recorded. Undefined when it isn't downloaded or declares none.
 */
async function downloadedVersion(opts, id) {
  const listing = (await readCorpus(opts.corpus))[id]?.listing;
  if (!listing) return undefined;
  await checkRoot(opts.root);
  const file = await findExisting(opts.root, listing.script_url);
  const header = file && parseHeader(await readFile(file, 'utf8'));
  return (header && getValue(header, 'version')?.trim()) || undefined;
}

async function setFinding(opts) {
  const [id] = opts.positional;
  if (!/^\d+$/.test(id ?? '')) throw new Error('The set command needs a numeric script id');
  oneOf(opts.test, TEST_STATUSES, 'test status');
  // Before the value checks, so a free-text reason on a fail says to use the
  // note, rather than listing the n/a reasons.
  if (opts.reason && opts.test !== 'n/a') throw new Error('The --reason option only goes with --test n/a. Explain other results with --note.');
  if (opts.blame && opts.test !== 'fail') throw new Error('The --blame option only goes with --test fail');
  oneOf(opts.reason, REASONS, 'reason');
  oneOf(opts.blame, BLAMES, 'blame');
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error('The --date option must be YYYY-MM-DD');
  const note = opts['note-file'] ? (await readFile(opts['note-file'], 'utf8')).trim() : opts.note?.trim();
  // A bare status is no use to the next reader; say what was seen.
  if ((opts.test === 'fail' || opts.test === 'n/a') && !note) {
    throw new Error(`A --test ${opts.test} result needs a --note saying what happened`);
  }
  if (opts['replace-note'] !== undefined && !note) throw new Error('The --replace-note option needs the new --note or --note-file');
  const removing = opts['remove-note'] !== undefined;
  // Which note --remove-note N means would depend on whether a new one went first.
  if (removing && note) throw new Error('Pass --remove-note by itself, without --note or --note-file');
  if (!opts.test && !note && !removing && !opts.tag.length && !opts.untag.length) {
    throw new Error('Nothing to set. Pass --test, --note, --remove-note, --tag or --untag.');
  }

  const date = opts.date ?? today();
  const fileVersion = opts.version === undefined ? await downloadedVersion(opts, id) : undefined;
  await updateCorpus(opts.corpus, (corpus) => {
    const record = corpus[id];
    if (!record) throw new Error(`No script ${id} in the corpus`);
    const version = opts.version ?? fileVersion ?? record.version;
    const stamp = version ? { date, version } : { date };
    if (opts.test) {
      record.test = { status: opts.test };
      if (opts.reason) record.test.reason = opts.reason;
      if (opts.blame) record.test.blame = opts.blame;
      Object.assign(record.test, stamp);
    }
    if (opts['replace-note'] !== undefined) {
      const at = noteIndex(record, opts['replace-note'], '--replace-note');
      record.notes[at] = { ...stamp, text: note };
    } else if (note) (record.notes ??= []).push({ ...stamp, text: note });
    if (removing) {
      const at = noteIndex(record, opts['remove-note'], '--remove-note');
      record.notes.splice(at, 1);
      if (!record.notes.length) delete record.notes;
    }
    if (opts.tag.length || opts.untag.length) {
      const tags = new Set(record.tags ?? []);
      for (const tag of opts.tag) tags.add(tag);
      for (const tag of opts.untag) tags.delete(tag);
      if (tags.size) record.tags = [...tags].sort();
      else delete record.tags;
    }
  });
  console.info(`Updated ${id}`);
}

/** Where note `which` (a number from 1) is in the record's notes. */
function noteIndex(record, which, flag) {
  const count = record.notes?.length ?? 0;
  const n = Number(which);
  if (!count) throw new Error(`The ${flag} option needs a note to act on, and this script has none`);
  if (!Number.isInteger(n) || n < 1 || n > count) {
    throw new Error(`The ${flag} option takes a note number from 1 to ${count}, not ${which}`);
  }
  return n - 1;
}

async function show(opts) {
  const [id] = opts.positional;
  if (!/^\d+$/.test(id ?? '')) throw new Error('The show command needs a numeric script id');
  const corpus = await readCorpus(opts.corpus);
  const record = corpus[id];
  if (!record) throw new Error(`No script ${id} in the corpus`);
  console.log(JSON.stringify(record, null, 2));
  await checkRoot(opts.root);
  const file = record.listing && await findExisting(opts.root, record.listing.script_url);
  console.log(`\nFile: ${file ? path.relative(process.cwd(), file) : '(not downloaded)'}`);
}

async function list(opts) {
  oneOf(opts.test, TEST_STATUSES, 'test status');
  oneOf(opts.valid, ['ok', 'invalid', 'tool error'], 'validation status');
  const corpus = await readCorpus(opts.corpus);
  const limit = opts.limit ? Number(opts.limit) : Infinity;
  let shown = 0;
  for (const row of listingRows(corpus)) {
    if (shown >= limit) break;
    const record = corpus[row.id];
    if (opts.untested && record.test) continue;
    if (opts.test && record.test?.status !== opts.test) continue;
    if (opts.valid && record.valid?.status !== opts.valid) continue;
    // `--tag` is repeatable (for `set`); here every named tag must be present.
    const tags = [...(record.tags ?? []), ...(record.valid?.tags ?? [])];
    if (!opts.tag.every((tag) => tags.includes(tag))) continue;
    const cells = [
      String(row.id).padStart(7),
      String(row.total_installs ?? '').padStart(9),
      (record.valid?.status ?? '-').padEnd(7),
      (record.test?.status ?? '-').padEnd(4),
      row.name,
    ];
    console.log(cells.join('  '));
    shown++;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (printHelp(argv[0] === 'help' ? ['--help'] : argv, import.meta.url)) return;
  // The global options can come before the command too.
  const lead = [];
  while (['--corpus', '--root'].includes(argv[0])) lead.push(argv.shift(), argv.shift());
  const [command, ...rest] = argv;
  rest.unshift(...lead);
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? '')) {
    throw new Error(`${command ? `Unknown command "${command}"` : 'No command given'}. ` +
      `Use one of: ${Object.keys(COMMAND_OPTIONS).join(', ')}. Run with --help for usage.`);
  }
  const opts = parseArgs(command, rest);
  switch (command) {
    case 'validate': return runValidator(opts);
    case 'import-validation': {
      if (!opts.positional[0]) throw new Error('The import-validation command needs the validator JSON file');
      return importValidation(opts, JSON.parse(await readFile(opts.positional[0], 'utf8')));
    }
    case 'set': return setFinding(opts);
    case 'show': return show(opts);
    case 'list': return list(opts);
  }
}

await main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exitCode = 1;
});
