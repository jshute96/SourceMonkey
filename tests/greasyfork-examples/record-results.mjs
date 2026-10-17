#!/usr/bin/env node
// Record individual facts about one corpus script at a time in corpus.json, as
// they're learned: the result of trying it on its target site, a tag, a dated
// note. It also defines the hand-added tags. It doesn't compute anything over
// the corpus; the one bulk command is `validate`, which records the corpus
// validator's verdict for every script.
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
//   list [filters]           one line per script, in top2000 rank order, then by ID:
//                              --untested  no test result yet
//                              --test S    test status S
//                              --valid S   validation status S
//                              --tag T     carries tag T (either source; repeatable)
//                              --label L   carries label L (`add-scripts.mjs`), listed
//                                          in that label's rank order
//                              --limit N
//   set ID [options]         record a finding:
//                              --test pass|fail|inconclusive|n/a
//                              --reason R   why it's n/a, with --test n/a only (see REASONS)
//                              --blame B    whose fault a failure is (see BLAMES)
//                              --note TEXT  markdown; --note-file PATH reads it from a file
//                              --replace-note N  the note replaces note N (from 1, in the
//                                           order show lists them) instead of adding one
//                              --remove-note N   drop note N (from 1)
//                              --tag T / --untag T  (repeatable); T must be
//                                           defined (`tag add`) or built in
//                              --version V  default: the @version of the copy in files/ now
//                              --date D     default: today (YYYY-MM-DD)
//   tag list                 the built-in tags, then the hand-added ones, each
//                            with how many scripts carry it and its description,
//                            then any tag in use that has no definition
//   tag add NAME DESCRIPTION define a new hand-added tag (short, kebab-case)
//   tag update NAME DESCRIPTION  change a tag's description
//   tag rename OLD NEW       rename a tag and its uses; NEW must not exist yet
//   tag merge FROM INTO      move FROM's uses onto INTO (an existing tag) and
//                            drop FROM's definition
//   tag remove NAME          drop a tag's definition, once no script uses it
//   help                     print this (so does --help or -h, anywhere)
//
// Built-in tags are the ones `validate` derives, described in corpus-help.js.
// `set --tag` can give one to a test (as what made it fail), but `tag` can't
// define or change them.
//
// Global, before or after the command: --corpus PATH (default corpus.json here),
// --root PATH (download root).
// The record format is described in README.md ("Test results").

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValue, getValues, parseHeader, unsupportedRunAt } from '../../dist/userscript-header.js';
import { resolveGrants } from '../../dist/gm-api-catalog.js';
import { describeDiagnostic } from '../../dist/diagnostic-location.js';
import { matchPatternProblem } from '../../dist/url-match.js';
import {
  CORPUS_JSON, builtinTagEntry, checkRoot, findExisting, isBuiltinTag, labelRank, listingRows, patternTarget, printHelp, readCorpus,
  readCorpusHelp, updateCorpus,
} from './corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const TEST_STATUSES = ['pass', 'fail', 'inconclusive', 'n/a'];
// Why a script couldn't be meaningfully tried. Kept to a fixed set so the
// report can filter on it; `other` plus a note covers the rest. Each reason
// and blame has a description in corpus-help.js.
const REASONS = [
  'requires-login',     // needs an account on the target site
  'paid',               // needs a paid subscription or purchase
  'geo-blocked',        // the site refuses our region
  'bot-blocked',        // a bot check (captcha, Cloudflare, WAF) we can't get past, headed too
  'unsafe',             // we chose not to run it: it harvests credentials, spams, or drives accounts or money
  'game',               // a game cheat, bot or tool: can't be judged without playing, and might get an account banned
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
  'list': ['untested', 'test', 'valid', 'tag', 'label', 'limit'],
  'set': ['test', 'reason', 'blame', 'note', 'note-file', 'replace-note', 'remove-note', 'tag', 'untag', 'version', 'date'],
  'tag': [],
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
  // Runs at document-idle instead, which can be too late for it.
  if (unsupportedRunAt(header)) tags.push('unsupported-run-at');
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
    // Why it's invalid, as the validator classified it.
    if (result.status === 'invalid' && result.reason) tags.push(`invalid:${result.reason}`);
    // Why the `@icon` can't be shown, as the validator classified it.
    if (result.iconProblem) tags.push(`icon-${result.iconProblem}`);
    if (tags.length) valid.tags = tags;
    valid.date = date;
    if (result.version) valid.version = result.version;
    updates.set(id, { version: result.version, file: path.relative(opts.root, file), sites: targetSites(source), valid });
  }

  // A verdict that matches the recorded one, date aside, keeps the old date,
  // so a rerun only redates the scripts whose result changed.
  const sameVerdict = (a, b) => a && JSON.stringify({ ...a, date: '' }) === JSON.stringify({ ...b, date: '' });
  let changed = 0;
  await updateCorpus(opts.corpus, (live) => {
    for (const id of unchecked) {
      const record = live.scripts[id];
      if (record) { delete record.valid; delete record.sites; delete record.version; delete record.file; }
    }
    for (const [id, update] of updates) {
      const record = live.scripts[id] ?? (live.scripts[id] = {});
      if (update.version) record.version = update.version;
      else delete record.version;
      record.file = update.file;
      if (update.sites.length) record.sites = update.sites;
      else delete record.sites;
      if (sameVerdict(record.valid, update.valid)) update.valid.date = record.valid.date;
      else changed++;
      record.valid = update.valid;
    }
  });

  const counts = {};
  for (const { valid } of updates.values()) counts[valid.status] = (counts[valid.status] ?? 0) + 1;
  const tagged = [...updates.values()].filter((u) => u.valid.tags).length;
  console.info(`Imported ${updates.size} verdicts: ${JSON.stringify(counts)}, ${tagged} with derived tags; ` +
    `${changed} new or changed`);
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
  const listing = (await readCorpus(opts.corpus)).scripts[id]?.listing;
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
  if (['fail', 'inconclusive', 'n/a'].includes(opts.test) && !note) {
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
  const help = opts.tag.length ? readCorpusHelp() : null;
  await updateCorpus(opts.corpus, (corpus) => {
    const record = corpus.scripts[id];
    if (!record) throw new Error(`No script ${id} in the corpus`);
    // Checked here, under the lock, so a tag another writer just added counts.
    for (const tag of opts.tag) {
      if (!Object.hasOwn(corpus.tags, tag) && !isBuiltinTag(help, tag)) {
        throw new Error(`No tag "${tag}" is defined. Define it first with \`tag add ${tag} DESCRIPTION\`.`);
      }
    }
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
  const record = corpus.scripts[id];
  if (!record) throw new Error(`No script ${id} in the corpus`);
  console.log(JSON.stringify(record, null, 2));
  await checkRoot(opts.root);
  const file = record.listing && await findExisting(opts.root, record.listing.script_url);
  console.log(`\nFile: ${file ? path.relative(process.cwd(), file) : '(not downloaded)'}`);
}

/** One `list` line: ID and installs right-aligned, the statuses padded, then the name. */
// TESTED is as wide as its longest value, `inconclusive`.
function listLine([id, installs, valid, tested, name]) {
  return [id.padStart(7), installs.padStart(9), valid.padEnd(7), tested.padEnd(12), name].join('  ');
}

async function list(opts) {
  oneOf(opts.test, TEST_STATUSES, 'test status');
  oneOf(opts.valid, ['ok', 'invalid', 'tool error'], 'validation status');
  const corpus = await readCorpus(opts.corpus);
  const limit = opts.limit ? Number(opts.limit) : Infinity;
  let shown = 0;
  let rows = listingRows(corpus);
  if (opts.label !== undefined) {
    const hasLabel = (row) => corpus.scripts[row.id].labels?.some((entry) => entry.label === opts.label);
    const rank = (row) => labelRank(corpus.scripts[row.id], opts.label) ?? Infinity;
    rows = rows.filter(hasLabel).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  }
  for (const row of rows) {
    if (shown >= limit) break;
    const record = corpus.scripts[row.id];
    if (opts.untested && record.test) continue;
    if (opts.test && record.test?.status !== opts.test) continue;
    if (opts.valid && record.valid?.status !== opts.valid) continue;
    // `--tag` is repeatable (for `set`); here every named tag must be present.
    const tags = [...(record.tags ?? []), ...(record.valid?.tags ?? [])];
    if (!opts.tag.every((tag) => tags.includes(tag))) continue;
    if (shown === 0) console.log(listLine(['ID', 'INSTALLS', 'VALID', 'TESTED', 'NAME']));
    console.log(listLine([
      String(row.id), String(row.total_installs ?? ''), record.valid?.status ?? '-', record.test?.status ?? '-', row.name,
    ]));
    shown++;
  }
}

// ---------- tag definitions ----------

/** How many scripts carry each hand-added tag (`tags`, not validation's). */
function tagUses(corpus) {
  const uses = new Map();
  for (const record of Object.values(corpus.scripts)) {
    for (const tag of record.tags ?? []) uses.set(tag, (uses.get(tag) ?? 0) + 1);
  }
  return uses;
}

/**
 * How many scripts carry each built-in tag, from validation or by hand, keyed
 * by its corpus-help.js entry: a `prefix:*` entry counts all its tags.
 */
function builtinTagUses(corpus, help) {
  const uses = new Map();
  for (const record of Object.values(corpus.scripts)) {
    const entries = new Set([...(record.valid?.tags ?? []), ...(record.tags ?? [])].map((tag) => builtinTagEntry(help, tag)));
    for (const entry of entries) if (entry) uses.set(entry, (uses.get(entry) ?? 0) + 1);
  }
  return uses;
}

/** Print tags as a table: how many scripts carry each, its name and description. */
function printTagTable(heading, rows) {
  console.log(heading);
  const width = Math.max(3, ...rows.map(([name]) => name.length));
  console.log(`  ${'SCRIPTS'.padStart(7)}  ${'TAG'.padEnd(width)}  DESCRIPTION`);
  for (const [name, count, text] of rows) console.log(`  ${String(count).padStart(7)}  ${name.padEnd(width)}  ${text}`);
}

/** Replace `from` with `to` in each script's hand-added tags. Returns how many changed. */
function retag(corpus, from, to) {
  let changed = 0;
  for (const record of Object.values(corpus.scripts)) {
    if (!record.tags?.includes(from)) continue;
    record.tags = [...new Set(record.tags.map((tag) => (tag === from ? to : tag)))].sort();
    changed++;
  }
  return changed;
}

const TAG_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const scriptCount = (n) => `${n} ${n === 1 ? 'script' : 'scripts'}`;

async function tagCommand(opts) {
  const [action, ...args] = opts.positional;
  const help = readCorpusHelp();
  const want = (count, usage) => {
    if (args.length !== count) throw new Error(`Usage: tag ${action}${usage && ' ' + usage}`);
  };
  const description = (text) => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('The description is empty');
    return trimmed;
  };
  // A name `tag` may act on: defined in this corpus, not built in.
  const defined = (corpus, name) => {
    if (isBuiltinTag(help, name)) throw new Error(`The tag "${name}" is built in, described in corpus-help.js`);
    if (!Object.hasOwn(corpus.tags, name)) throw new Error(`No tag "${name}" is defined`);
  };
  // A name `tag` may define.
  const fresh = (corpus, name) => {
    if (isBuiltinTag(help, name)) throw new Error(`The tag "${name}" is built in, described in corpus-help.js`);
    if (!TAG_NAME.test(name)) throw new Error(`The tag name "${name}" isn't short kebab-case (like dead-asset)`);
    if (Object.hasOwn(corpus.tags, name)) throw new Error(`The tag "${name}" is already defined`);
  };

  switch (action) {
    case 'list': {
      want(0, '');
      const corpus = await readCorpus(opts.corpus);
      const uses = tagUses(corpus);
      const builtinUses = builtinTagUses(corpus, help);
      printTagTable('Built-in tags (corpus-help.js):',
        Object.entries(help.tag).map(([name, text]) => [name, builtinUses.get(name) ?? 0, text]));
      console.log('');
      printTagTable(`Tags defined in corpus (${path.basename(opts.corpus)}):`,
        Object.entries(corpus.tags).map(([name, text]) => [name, uses.get(name) ?? 0, text]));
      const missing = [...uses.keys()].filter((tag) => !Object.hasOwn(corpus.tags, tag) && !isBuiltinTag(help, tag));
      if (missing.length) console.log(`\nIn use with no definition: ${missing.sort().join(', ')}`);
      return;
    }
    case 'add': {
      want(2, 'NAME DESCRIPTION');
      const [name, text] = args;
      await updateCorpus(opts.corpus, (corpus) => {
        fresh(corpus, name);
        corpus.tags[name] = description(text);
      });
      console.info(`Added tag ${name}`);
      return;
    }
    case 'update': {
      want(2, 'NAME DESCRIPTION');
      const [name, text] = args;
      await updateCorpus(opts.corpus, (corpus) => {
        defined(corpus, name);
        corpus.tags[name] = description(text);
      });
      console.info(`Updated tag ${name}`);
      return;
    }
    case 'rename': {
      want(2, 'OLD NEW');
      const [from, to] = args;
      const changed = await updateCorpus(opts.corpus, (corpus) => {
        defined(corpus, from);
        fresh(corpus, to);
        corpus.tags[to] = corpus.tags[from];
        delete corpus.tags[from];
        return retag(corpus, from, to);
      });
      console.info(`Renamed tag ${from} to ${to}, on ${scriptCount(changed)}`);
      return;
    }
    case 'merge': {
      want(2, 'FROM INTO');
      const [from, into] = args;
      if (from === into) throw new Error('The tags to merge are the same');
      const changed = await updateCorpus(opts.corpus, (corpus) => {
        defined(corpus, from);
        // INTO may be built in: a hand-added tag that turns out to be one the validator derives.
        if (!Object.hasOwn(corpus.tags, into) && !isBuiltinTag(help, into)) throw new Error(`No tag "${into}" is defined`);
        delete corpus.tags[from];
        return retag(corpus, from, into);
      });
      console.info(`Merged tag ${from} into ${into}, on ${scriptCount(changed)}`);
      return;
    }
    case 'remove': {
      want(1, 'NAME');
      const [name] = args;
      await updateCorpus(opts.corpus, (corpus) => {
        defined(corpus, name);
        const count = tagUses(corpus).get(name);
        if (count) {
          throw new Error(`The tag "${name}" is still on ${scriptCount(count)}. Untag them first, or merge it into another tag.`);
        }
        delete corpus.tags[name];
      });
      console.info(`Removed tag ${name}`);
      return;
    }
    default:
      throw new Error(`${action ? `Unknown tag action "${action}"` : 'No tag action given'}. ` +
        'Use one of: list, add, update, rename, merge, remove.');
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
    case 'tag': return tagCommand(opts);
  }
}

await main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exitCode = 1;
});
