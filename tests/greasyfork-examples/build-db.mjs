#!/usr/bin/env node
// Load the GreasyFork corpus into a SQLite database for analysis: the CSV's
// script metadata, plus everything parsed out of the downloaded script bodies
// (header lines, @require and @resource dependencies, file sizes).
//
// Usage:
//   node tests/greasyfork-examples/build-db.mjs [options]
//
//   --csv PATH   input CSV (default tests/greasyfork-examples/top-scripts.csv)
//   --root PATH  download root (default tests/greasyfork-examples/files)
//   --db PATH    database to write (default tests/greasyfork-examples/corpus.db)
//
// The database is rebuilt from scratch each run — it's derived data, and both
// inputs (the CSV and the file tree) are cheap to re-read.
//
// Requires a build (`pnpm run build`): the header parsing reuses the extension's
// own metadata-block parser from `dist/userscript-header.js`, so the database
// sees headers exactly the way SourceMonkey does.

import { DatabaseSync } from 'node:sqlite';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeader } from '../../dist/userscript-header.js';
import {
  detectMaxFilename, findExisting, parseCsv, parseResourceValue, readDownloaded, resolveDependencyUrl,
} from './corpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULTS = {
  csv: path.join(REPO_ROOT, 'tests/greasyfork-examples/top-scripts.csv'),
  root: path.join(REPO_ROOT, 'tests/greasyfork-examples/files'),
  db: path.join(REPO_ROOT, 'tests/greasyfork-examples/corpus.db'),
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!Object.hasOwn(DEFAULTS, arg.replace(/^--/, '')) || !arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    opts[arg.slice(2)] = path.resolve(value);
  }
  return opts;
}

const SCHEMA = `
CREATE TABLE Scripts (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  info_page      TEXT NOT NULL,
  script_url     TEXT NOT NULL,
  total_installs INTEGER,
  daily_installs INTEGER,
  ratings_good   INTEGER,
  ratings_ok     INTEGER,
  ratings_bad    INTEGER,
  created_date   TEXT,
  updated_date   TEXT,
  size           INTEGER,  -- bytes on disk; NULL when the body wasn't downloaded
  local_filename TEXT      -- relative to the download root; NULL when absent
);

-- One row per distinct dependency URL. size/local_filename are NULL when the
-- file couldn't be fetched: a dead link, a blocked or unreachable host.
CREATE TABLE RequiresFiles (
  url            TEXT PRIMARY KEY,
  size           INTEGER,
  local_filename TEXT
);

CREATE TABLE ResourceFiles (
  url            TEXT PRIMARY KEY,
  size           INTEGER,
  local_filename TEXT
);

-- Join tables: which script pulls in which dependency. A script listing the
-- same URL twice is recorded once, so counts here are "scripts referencing".
CREATE TABLE ScriptRequiresFiles (
  script_id INTEGER NOT NULL REFERENCES Scripts(id),
  url       TEXT NOT NULL REFERENCES RequiresFiles(url),
  PRIMARY KEY (script_id, url)
);

CREATE TABLE ScriptResourcesFiles (
  script_id     INTEGER NOT NULL REFERENCES Scripts(id),
  url           TEXT NOT NULL REFERENCES ResourceFiles(url),
  resource_name TEXT NOT NULL,  -- the @resource name the script binds it to
  PRIMARY KEY (script_id, url, resource_name)
);

-- Every metadata-block line, in source order.
--   @description:ar → header_field 'description', suffix 'ar', full 'description:ar'
--   @grant          → header_field 'grant',       suffix '',   full 'grant'
CREATE TABLE ScriptHeaders (
  script_id           INTEGER NOT NULL REFERENCES Scripts(id),
  header_field        TEXT NOT NULL,
  header_field_full   TEXT NOT NULL,
  header_field_suffix TEXT NOT NULL,
  argument            TEXT NOT NULL
);

-- One row per @match / @include line, decomposed so the URL-targeting questions
-- are plain SQL. See classifyPattern() for what each column means.
CREATE TABLE ScriptMatches (
  script_id    INTEGER NOT NULL REFERENCES Scripts(id),
  header_field TEXT NOT NULL,     -- 'match' or 'include'
  pattern      TEXT NOT NULL,     -- the line's argument, trimmed
  shape        TEXT NOT NULL,     -- absolute | prefix-glob | inner-glob | regex | all-urls
                                  -- judged on host+path only; a wildcard scheme
                                  -- is tracked separately in scheme_glob
  scheme       TEXT NOT NULL,     -- '' when the pattern names none
  host_pattern TEXT NOT NULL,     -- host portion as written, e.g. '*.youtube.com'
  site         TEXT,              -- resolved hostname, NULL when it isn't one site
  scheme_glob  INTEGER NOT NULL,
  host_glob    INTEGER NOT NULL,
  path_glob    INTEGER NOT NULL
);

CREATE INDEX idx_matches_script ON ScriptMatches(script_id);
CREATE INDEX idx_matches_site ON ScriptMatches(site);
CREATE INDEX idx_headers_script ON ScriptHeaders(script_id);
CREATE INDEX idx_headers_field ON ScriptHeaders(header_field);
CREATE INDEX idx_requires_url ON ScriptRequiresFiles(url);
CREATE INDEX idx_resources_url ON ScriptResourcesFiles(url);
`;

/** Size and root-relative name of a downloaded file, or nulls when it's absent. */
async function fileFacts(root, url) {
  const file = await findExisting(root, url);
  if (file === null) return { size: null, local_filename: null };
  const info = await stat(file);
  return { size: info.size, local_filename: path.relative(root, file) };
}

/**
 * A host portion resolves to a single site when stripping one leading `*.`
 * leaves no wildcard: `*.youtube.com` and `www.youtube.com` both attribute to a
 * site, while `*`, `*.the-west.*`, and `` do not.
 */
function resolveSite(hostPattern) {
  let host = hostPattern.toLowerCase();
  if (host.startsWith('*.')) host = host.slice(2);
  if (host === '' || host.includes('*')) return null;
  return host.replace(/:\d+$/, ''); // ports aren't part of the site identity
}

/**
 * Decompose one `@match` / `@include` argument.
 *
 * `shape` answers "how open-ended is this pattern" over the host and path only:
 * no `*` is absolute, a single trailing `*` is a prefix, and a `*` before the
 * end makes it an inner glob — a wildcard host or a wildcard path segment.
 *
 * The scheme is deliberately left out of that judgement. `*://` is the ordinary
 * way to write "http or https" and says nothing about how broadly a pattern
 * reaches, but counting it would push every `*://site.com/*` into the inner-glob
 * bucket and swamp the patterns that really do match mid-URL. Scheme wildcards
 * are tracked on their own in `scheme_glob`.
 *
 * @include also allows regex forms delimited by slashes, which get their own
 * shape, as does the `<all_urls>` keyword.
 */
function classifyPattern(raw) {
  const pattern = raw.trim();
  if (!pattern) return null;

  const base = { pattern, scheme: '', host_pattern: '', site: null, scheme_glob: 0, host_glob: 0, path_glob: 0 };
  // @include regexes are delimited by slashes and aren't glob patterns at all.
  // A few lines in the corpus open with `/` but never close (an unterminated
  // regex); those fall through and get classified as globs with an empty host,
  // which is as sensible as anything for a line no manager can honour.
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return { ...base, shape: 'regex' };
  }
  // `<all_urls>` is a keyword, not a URL shape — it means "any scheme, any host".
  if (pattern === '<all_urls>') {
    return { ...base, shape: 'all-urls', scheme: '*', host_pattern: '*', scheme_glob: 1, host_glob: 1, path_glob: 1 };
  }

  const scheme = /^([^:/]*):\/\//.exec(pattern);
  const rest = scheme ? pattern.slice(scheme[0].length) : pattern;
  const slash = rest.indexOf('/');
  const hostPattern = slash === -1 ? rest : rest.slice(0, slash);
  const pathPattern = slash === -1 ? '' : rest.slice(slash);

  const stars = (rest.match(/\*/g) ?? []).length;
  const shape = stars === 0 ? 'absolute'
    : stars === 1 && rest.endsWith('*') ? 'prefix-glob'
    : 'inner-glob';

  return {
    pattern,
    shape,
    scheme: scheme ? scheme[1] : '',
    host_pattern: hostPattern,
    site: resolveSite(hostPattern),
    scheme_glob: scheme && scheme[1].includes('*') ? 1 : 0,
    host_glob: hostPattern.includes('*') ? 1 : 0,
    path_glob: pathPattern.includes('*') ? 1 : 0,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await detectMaxFilename(opts.root, { create: false });

  // Drop the WAL sidecars too: SQLite would treat a stray -wal next to a
  // freshly created database as content to recover.
  for (const suffix of ['', '-wal', '-shm']) await rm(opts.db + suffix, { force: true });
  const db = new DatabaseSync(opts.db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const insertScript = db.prepare(`
    INSERT INTO Scripts (id, name, info_page, script_url, total_installs, daily_installs,
                         ratings_good, ratings_ok, ratings_bad, created_date, updated_date,
                         size, local_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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

  const rows = parseCsv(await readFile(opts.csv, 'utf8'));
  const stats = { scripts: 0, missingBodies: 0, headers: 0, noHeaderBlock: 0, requires: 0, resources: 0, matches: 0 };

  db.exec('BEGIN');
  for (const row of rows) {
    const id = Number(row.id);
    const facts = await fileFacts(opts.root, row.script_url);
    // Number('') is 0, which would turn a missing rating into a real zero.
    const num = (value) => (value === '' ? null : Number(value));
    insertScript.run(
      id, row.name, row.info_page, row.script_url,
      num(row.total_installs), num(row.daily_installs),
      num(row.ratings_good), num(row.ratings_ok), num(row.ratings_bad),
      row.created_date, row.updated_date,
      facts.size, facts.local_filename,
    );
    stats.scripts++;

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

await main();
