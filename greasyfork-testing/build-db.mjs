#!/usr/bin/env node
// Load the GreasyFork corpus into a SQLite database for analysis: corpus.json's
// listing metadata and test findings, plus everything parsed out of the
// downloaded script bodies (header lines, @require and @resource dependencies,
// file sizes).
//
// Usage:
//   node greasyfork-testing/build-db.mjs [options]
//
//   --corpus PATH  script list and findings (default greasyfork-testing/corpus.json)
//   --root PATH    download root (default greasyfork-testing/files)
//   --db PATH      database to write (default greasyfork-testing/corpus.db)
//   --query SQL    after building, run one SQL statement and print its rows as
//                  tab-separated lines under a header line (NULL as empty).
//                  Only the first statement runs; any after it are ignored.
//   --no-build     with --query, query the database as it is instead of
//                  rebuilding it first
//
// Examples:
//   node greasyfork-testing/build-db.mjs
//   node greasyfork-testing/build-db.mjs --query \
//     "SELECT script_id, test_status FROM ScriptResults WHERE test_blame = 'sourcemonkey'"
//
// Building takes about a second, so --query rebuilds by default and sees
// corpus.json as it is now. The `sqlite3` tool works on corpus.db too, for
// `.tables`, `.schema` and SQL files.
//
// The database is rebuilt from scratch each build: it's derived data, and both
// inputs (corpus.json and the file tree) are cheap to re-read.
//
// Requires a build (`pnpm run build`): the header parsing reuses the extension's
// own metadata-block parser from `dist/userscript-header.js`, so the database
// sees headers exactly the way SourceMonkey does.

import { DatabaseSync } from 'node:sqlite';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeader } from '../dist/userscript-header.js';
import {
  CORPUS_JSON, classifyPattern, checkRoot, findExisting, listingRows, parseResourceValue, readCorpus, readDownloaded, resolveDependencyUrl,
  printHelp,
} from './corpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  corpus: CORPUS_JSON,
  root: path.join(REPO_ROOT, 'greasyfork-testing/files'),
  db: path.join(REPO_ROOT, 'greasyfork-testing/corpus.db'),
};

const PATH_OPTIONS = new Set(['corpus', 'root', 'db']);

function parseArgs(argv) {
  const opts = { ...DEFAULTS, query: null, build: true };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`The ${arg} option is given more than once`);
    seen.add(arg);
    if (arg === '--no-build') { opts.build = false; continue; }
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!PATH_OPTIONS.has(name) && name !== 'query') throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    opts[name] = name === 'query' ? value : path.resolve(value);
  }
  if (!opts.build && opts.query === null) throw new Error('The --no-build option needs --query');
  return opts;
}

/** One cell of --query output: tabs and line breaks escaped so each row stays one line. */
function cell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

async function runQuery(dbPath, sql) {
  if (!await stat(dbPath).catch(() => null)) {
    throw new Error(`The database ${path.relative(REPO_ROOT, dbPath)} does not exist. Run without --no-build to build it.`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let statement;
    try {
      statement = db.prepare(sql);
    } catch (err) {
      const reason = String(err?.message ?? err);
      throw new Error(`SQLite refused the query: ${reason[0].toUpperCase()}${reason.slice(1)}`);
    }
    const columns = statement.columns().map((c) => c.name);
    if (columns.length === 0) throw new Error('The query returns no columns. Give a SELECT statement.');
    // Rows as arrays: as objects, two columns with one name (`SELECT *` over
    // a join) would both show the last one's value.
    statement.setReturnArrays(true);
    process.stdout.write(columns.map(cell).join('\t') + '\n');
    for (const row of statement.iterate()) {
      process.stdout.write(row.map(cell).join('\t') + '\n');
    }
  } finally {
    db.close();
  }
}

// The tables, kept in their own file so they're easy to read.
const SCHEMA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Size and root-relative name of a downloaded file, or nulls when it's absent. */
async function fileFacts(root, url) {
  const file = await findExisting(root, url);
  if (file === null) return { size: null, local_filename: null };
  const info = await stat(file);
  return { size: info.size, local_filename: path.relative(root, file) };
}

async function main() {
  if (printHelp(process.argv.slice(2), import.meta.url)) return;
  const opts = parseArgs(process.argv.slice(2));
  if (opts.build) await build(opts, { quiet: opts.query !== null });
  if (opts.query !== null) await runQuery(opts.db, opts.query);
}

async function build(opts, { quiet }) {
  await checkRoot(opts.root);
  // Read before the old database is deleted, so a missing file leaves it alone.
  const schema = await readFile(SCHEMA_FILE, 'utf8');

  // Drop the WAL sidecars too: SQLite would treat a stray -wal next to a
  // freshly created database as content to recover.
  for (const suffix of ['', '-wal', '-shm']) await rm(opts.db + suffix, { force: true });
  const db = new DatabaseSync(opts.db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(schema);

  const insertScript = db.prepare(`
    INSERT INTO Scripts (id, name, info_page, script_url, total_installs, daily_installs,
                         ratings_good, ratings_ok, ratings_bad, created_date, updated_date,
                         gone_as_of, size, local_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertHeader = db.prepare(`
    INSERT INTO ScriptHeaders (script_id, header_field, header_field_full, header_field_suffix, argument)
    VALUES (?, ?, ?, ?, ?)`);
  const insertRequire = db.prepare('INSERT OR IGNORE INTO RequiresFiles (url) VALUES (?)');
  const insertResource = db.prepare('INSERT OR IGNORE INTO ResourceFiles (url) VALUES (?)');
  const linkRequire = db.prepare('INSERT OR IGNORE INTO ScriptRequiresFiles (script_id, url) VALUES (?, ?)');
  const linkResource = db.prepare(
    'INSERT OR IGNORE INTO ScriptResourcesFiles (script_id, url, resource_name) VALUES (?, ?, ?)');
  const insertMatch = db.prepare(`
    INSERT INTO ScriptMatches (script_id, header_field, pattern, shape, scheme, host_pattern, site,
                               scheme_glob, host_glob, path_glob)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const corpus = await readCorpus(opts.corpus);
  const rows = listingRows(corpus);
  const insertResult = db.prepare(`
    INSERT INTO ScriptResults (script_id, version, valid_status, valid_error, valid_date,
                               test_status, test_reason, test_blame, test_date, test_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTag = db.prepare('INSERT INTO ScriptTags (script_id, tag, source) VALUES (?, ?, ?)');
  const insertLabel = db.prepare('INSERT INTO ScriptLabels (script_id, label, rank) VALUES (?, ?, ?)');
  const insertNote = db.prepare('INSERT INTO ScriptNotes (script_id, date, version, text) VALUES (?, ?, ?, ?)');
  const insertFindings = (id, record) => {
    const { valid, test } = record;
    if (valid || test || record.tags || record.notes) {
      insertResult.run(id, record.version ?? null,
        valid?.status ?? null, valid?.error ?? null, valid?.date ?? null,
        test?.status ?? null, test?.reason ?? null, test?.blame ?? null, test?.date ?? null,
        test?.version ?? null);
    }
    for (const tag of valid?.tags ?? []) insertTag.run(id, tag, 'validation');
    for (const tag of record.tags ?? []) insertTag.run(id, tag, 'manual');
    for (const entry of record.labels ?? []) insertLabel.run(id, entry.label, entry.rank ?? null);
    for (const note of record.notes ?? []) insertNote.run(id, note.date, note.version ?? null, note.text);
  };
  const stats = { scripts: 0, missingBodies: 0, headers: 0, noHeaderBlock: 0, requires: 0, resources: 0, matches: 0 };

  db.exec('BEGIN');
  for (const row of rows) {
    const id = Number(row.id);
    const facts = await fileFacts(opts.root, row.script_url);
    insertScript.run(
      id, row.name, row.info_page, row.script_url,
      row.total_installs, row.daily_installs,
      row.ratings_good, row.ratings_ok, row.ratings_bad,
      row.created_date, row.updated_date,
      row.gone_as_of ?? null, facts.size, facts.local_filename,
    );
    stats.scripts++;
    insertFindings(id, corpus.scripts[id]);

    const downloaded = await readDownloaded(opts.root, row.script_url);
    if (!downloaded) { stats.missingBodies++; continue; }
    const header = parseHeader(downloaded.text);
    if (!header) { stats.noHeaderBlock++; continue; }

    for (const tag of header.tags) {
      const full = tag.locale === undefined ? tag.tag : `${tag.tag}:${tag.locale}`;
      insertHeader.run(id, tag.tag, full, tag.locale ?? '', tag.value);
      stats.headers++;

      // Dependency URLs are resolved against the script's own URL so relative
      // and `//host/path` forms land on the same absolute key as everyone else's.
      if (tag.tag === 'require' && tag.locale === undefined) {
        const url = resolveDependencyUrl(tag.value, row.script_url);
        if (url) { insertRequire.run(url); linkRequire.run(id, url); stats.requires++; }
      } else if (tag.tag === 'resource' && tag.locale === undefined) {
        const parsed = parseResourceValue(tag.value);
        const url = parsed && resolveDependencyUrl(parsed.url, row.script_url);
        if (url) { insertResource.run(url); linkResource.run(id, url, parsed.name); stats.resources++; }
      } else if ((tag.tag === 'match' || tag.tag === 'include') && tag.locale === undefined) {
        const parsed = classifyPattern(tag.value);
        if (parsed) {
          insertMatch.run(id, tag.tag, parsed.pattern, parsed.shape, parsed.scheme, parsed.host_pattern,
            parsed.site, parsed.scheme_glob, parsed.host_glob, parsed.path_glob);
          stats.matches++;
        }
      }
    }
  }
  db.exec('COMMIT');

  // Fill in sizes once per distinct URL rather than per reference.
  const updateRequire = db.prepare('UPDATE RequiresFiles SET size = ?, local_filename = ? WHERE url = ?');
  const updateResource = db.prepare('UPDATE ResourceFiles SET size = ?, local_filename = ? WHERE url = ?');
  db.exec('BEGIN');
  for (const [table, update] of [['RequiresFiles', updateRequire], ['ResourceFiles', updateResource]]) {
    for (const { url } of db.prepare(`SELECT url FROM ${table}`).all()) {
      const facts = await fileFacts(opts.root, url);
      update.run(facts.size, facts.local_filename, url);
    }
  }
  db.exec('COMMIT');

  if (quiet) { db.close(); return; }
  const count = (sql) => db.prepare(sql).get().n;
  console.info(`Scripts:              ${stats.scripts} (${stats.missingBodies} without a downloaded body)`);
  console.info(`ScriptHeaders:        ${stats.headers} lines (${stats.noHeaderBlock} scripts had no metadata block)`);
  console.info(`RequiresFiles:        ${count('SELECT COUNT(*) n FROM RequiresFiles')} unique, ` +
    `${stats.requires} references, ${count('SELECT COUNT(*) n FROM RequiresFiles WHERE size IS NULL')} not on disk`);
  console.info(`ScriptMatches:        ${stats.matches} @match/@include lines, ` +
    `${count('SELECT COUNT(DISTINCT site) n FROM ScriptMatches WHERE site IS NOT NULL')} distinct sites`);
  console.info(`ResourceFiles:        ${count('SELECT COUNT(*) n FROM ResourceFiles')} unique, ` +
    `${stats.resources} references, ${count('SELECT COUNT(*) n FROM ResourceFiles WHERE size IS NULL')} not on disk`);
  db.close();
  console.info(`Wrote ${path.relative(REPO_ROOT, opts.db)}`);
}

await main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exitCode = 1;
});
