// `sm-dev manifest`: adds scripts to a `script_manifest.json`, makes a
// new one with `--create`, and with `--prune` drops entries for files
// that are gone. It works on files alone, with no run or browser.
//
// The manifest goes in the directory given by `--dir`, or the one
// directory given as the only argument. Everything else in the file
// (other top-level keys, other fields on object entries, the entries'
// order) is kept as it is.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_FILENAME, resolveManifestEntryUrl } from '../collection-scan.js';
import { REMOTE_SCRIPT, SCRIPT_ARG, UsageError, expandPathArg } from './checks.js';
import { isDirectory, isGlob, walkScripts } from './path-args.js';
import { noSuchFileMessage, shownPath } from './prepare.js';
import { quoted, ui, url } from './output-style.js';

/** The shapes `--format` makes a new manifest in. */
export const MANIFEST_FORMATS = ['array', 'object'] as const;
export type ManifestFormat = (typeof MANIFEST_FORMATS)[number];

export interface ManifestOptions {
  /** `--dir`: the manifest's directory. */
  dir?: string;
  /** `--create`: make the manifest if it's missing. */
  create: boolean;
  /** `--format`: the shape of a new manifest. */
  format?: ManifestFormat;
  /** `--prune`: drop entries for files that no longer exist. */
  prune: boolean;
  /** `--dry-run`: report the changes without writing them. */
  dryRun: boolean;
}

// A list element as the manifest holds it.
type Entry = string | { path: string; [field: string]: unknown };

const entryPath = (entry: Entry): string => (typeof entry === 'string' ? entry : entry.path);

// Byte order, so the order is the same on all machines and locales.
const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `file` is `dir` or under it. */
function isUnder(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The flag combinations `manifest` refuses, checked before anything runs. */
export function checkManifest(args: string[], opts: ManifestOptions): void {
  if (opts.format && !opts.create) throw new UsageError(`The ${quoted('--format')} flag is only for a new manifest, with ${quoted('--create')}`);
  if (opts.dir === undefined) {
    if (args.length === 0) throw new UsageError(`The ${quoted('manifest')} command needs a directory, as its argument or with ${quoted('--dir')}`);
    if (args.length > 1) throw new UsageError(`With more than one argument, give the manifest's directory with ${quoted('--dir')}`);
  }
}

// The manifest's directory, as an absolute path.
function manifestDir(args: string[], opts: ManifestOptions, cwd: string): { dir: string; spelled: string } {
  const spelled = opts.dir ?? args[0];
  const dir = path.resolve(cwd, spelled);
  if (isDirectory(dir)) return { dir, spelled };
  if (path.basename(dir) === MANIFEST_FILENAME) {
    throw new UsageError(`${quoted(spelled)} is the manifest itself. Give its directory instead.`);
  }
  if (!existsSync(dir)) throw new UsageError(noSuchFileMessage(spelled));
  if (opts.dir !== undefined) throw new UsageError(`The ${quoted('--dir')} flag needs a directory, and ${quoted(spelled)} isn't one`);
  throw new UsageError(`${quoted(spelled)} isn't a directory. Give the manifest's directory with ${quoted('--dir')}.`);
}

/** The manifest as read: its JSON, and the list in it. Null for no file. */
function readManifest(file: string, shown: string): { data: unknown[] | Record<string, unknown>; entries: Entry[] } | null {
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const unreadable = (why: string): UsageError => new UsageError(`The manifest ${quoted(shown)} can't be read: ${why}`);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw unreadable(`The file is not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { scripts?: unknown }).scripts) ? (data as { scripts: unknown[] }).scripts
      : null;
  if (!list) throw unreadable('It must be a JSON array of entries, or `{"scripts": [...]}`');
  for (const item of list) {
    const ok = typeof item === 'string'
      || (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { path?: unknown }).path === 'string');
    if (!ok) throw unreadable('Its entries must all be strings, or objects with a "path" string');
  }
  return { data: data as unknown[] | Record<string, unknown>, entries: list as Entry[] };
}

// An entry's key for telling two apart: the URL it resolves to, so
// `./a.user.js` and `a.user.js` are the same script. Null for one that
// doesn't resolve, which is never matched or pruned.
function entryKey(entry: string, base: string): string | null {
  try {
    return resolveManifestEntryUrl(entry, base).href;
  } catch {
    return null;
  }
}

/**
 * The scripts to add, as manifest entries (relative paths, or URLs as
 * given), and the directories searched, which `--prune` covers.
 */
function scriptsToAdd(args: string[], dir: string, spelled: string, prune: boolean, cwd: string): { paths: string[]; searched: string[] } {
  const paths: string[] = [];
  const searched: string[] = [];
  for (let word of args) {
    // A `file:` URL is a local path.
    if (/^file:/i.test(word)) {
      try {
        word = fileURLToPath(word);
      } catch {
        throw new UsageError(`${quoted(word)} is not a usable file URL`);
      }
    }
    if (REMOTE_SCRIPT.test(word)) {
      if (!SCRIPT_ARG.test(new URL(word).pathname)) throw new UsageError(`${quoted(word)} is not a userscript: Its name doesn't end in .user.js`);
      paths.push(word);
      continue;
    }
    const resolved = path.resolve(cwd, word);
    const isDir = !isGlob(word) && isDirectory(resolved);
    if (isDir) {
      if (!isUnder(resolved, dir)) throw new UsageError(`${quoted(word)} isn't under ${quoted(spelled)}, where the manifest is`);
      searched.push(resolved);
    }
    // With --prune, a directory whose scripts were all deleted is fine:
    // it has entries to remove, and none to add.
    const files: string[] = [];
    if (isDir && prune) walkScripts(resolved, word, files);
    else files.push(...expandPathArg(word, cwd, { scripts: true }));
    for (const found of files) {
      const file = path.resolve(cwd, found);
      if (!existsSync(file)) throw new UsageError(noSuchFileMessage(found));
      if (statSync(file).isDirectory()) continue;
      if (!SCRIPT_ARG.test(file)) throw new UsageError(`${quoted(found)} is not a userscript: Its name doesn't end in .user.js`);
      if (!isUnder(file, dir)) throw new UsageError(`${quoted(found)} isn't under ${quoted(spelled)}, where the manifest is`);
      paths.push(path.relative(dir, file).split(path.sep).join('/'));
    }
  }
  return { paths, searched };
}

/**
 * `manifest`: the manifest updated as `opts` say. Prints a line per
 * entry added or removed, then what happened to the file.
 */
export function manifestCommand(args: string[], opts: ManifestOptions, out: (line: string) => void, cwd = process.cwd()): number {
  checkManifest(args, opts);
  const { dir, spelled } = manifestDir(args, opts, cwd);
  const file = path.join(dir, MANIFEST_FILENAME);
  const shown = shownPath(file, cwd);
  const base = pathToFileURL(file).href;

  // The arguments first, so a mistake in them is reported as one.
  const { paths, searched } = scriptsToAdd(args.length > 0 ? args : [spelled], dir, spelled, opts.prune, cwd);
  if (opts.prune && searched.length === 0) throw new UsageError(`The ${quoted('--prune')} flag needs a directory to check, among the arguments`);

  const read = readManifest(file, shown);
  if (!read && !opts.create) throw new UsageError(`There is no ${quoted(shown)}. Use ${quoted('--create')} to make one.`);
  const entries: Entry[] = read ? [...read.entries] : [];

  const removed: string[] = [];
  if (opts.prune) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const key = entryKey(entryPath(entries[i]), base);
      if (!key?.startsWith('file:')) continue;
      const target = fileURLToPath(key);
      if (searched.some((d) => isUnder(target, d)) && !existsSync(target)) removed.unshift(entryPath(entries.splice(i, 1)[0]));
    }
  }

  // New entries match the others: objects only if all of them are.
  const asObjects = entries.length > 0 && entries.every((e) => typeof e !== 'string');
  const known = new Set(entries.map((e) => entryKey(entryPath(e), base)));
  const added: string[] = [];
  for (const entry of [...new Set(paths)].sort(byteOrder)) {
    const key = entryKey(entry, base);
    if (known.has(key)) continue;
    known.add(key);
    added.push(entry);
    // Before the first entry that sorts after it, so a sorted list stays
    // sorted and one in rough path order keeps it.
    const at = entries.findIndex((e) => byteOrder(entryPath(e), entry) > 0);
    entries.splice(at < 0 ? entries.length : at, 0, asObjects ? { path: entry } : entry);
  }

  const would = opts.dryRun ? 'Would add' : 'Added';
  for (const entry of added) out(ui`${would}  ${url(entry)}`);
  for (const entry of removed) out(ui`${opts.dryRun ? 'Would remove' : 'Removed'}  ${url(entry)}`);

  if (read && added.length === 0 && removed.length === 0) {
    out(ui`${url(shown)} is up to date`);
    return 0;
  }
  let data: unknown;
  if (!read) data = opts.format === 'object' ? { scripts: entries } : entries;
  else if (Array.isArray(read.data)) data = entries;
  else data = { ...read.data, scripts: entries };
  const counts = [added.length > 0 || !read ? `${added.length} added` : '', removed.length > 0 ? `${removed.length} removed` : ''].filter(Boolean).join(', ');
  if (opts.dryRun) {
    out(ui`${read ? 'Would update' : 'Would create'} ${url(shown)} (${counts}). Nothing was written.`);
    return 0;
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  out(ui`${read ? 'Updated' : 'Created'} ${url(shown)} (${counts})`);
  return 0;
}
