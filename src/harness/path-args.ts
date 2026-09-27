// Globs and directory searches over the file system, for sm-dev's file
// arguments (see expandPathArg in checks.ts). `*` matches within one
// path segment, and a `**` segment matches any number of directories.
//
// Synchronous, so the command line can sort its words into scripts and
// URLs before deciding whether a command goes to a run.

import { readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';

const SCRIPT_FILE = /\.user\.js$/i;

// Words with a scheme are URLs, whatever they contain. Two letters or
// more, so a Windows drive (`C:`) stays a path.
export const HAS_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

// Path separators: a backslash only where it is one.
const SEPARATORS = path.sep === '\\' ? /[/\\]+/ : /\/+/;

/**
 * Whether a word is a glob: a path with a `*` in it. Not a URL, with a
 * scheme or without: a relative word whose first part has no `*` and
 * isn't a directory here (`example.com/*`, `localhost/*`) reads as a
 * host. Unlike withDefaultScheme, a directory here wins over a dot.
 */
export function isGlob(word: string, cwd = process.cwd()): boolean {
  if (!word.includes('*') || HAS_SCHEME.test(word)) return false;
  if (path.isAbsolute(word)) return true;
  const parts = word.split(SEPARATORS);
  const first = parts[0];
  if (parts.length === 1 || first.includes('*') || first === '.' || first === '..') return true;
  return isDirectory(path.resolve(cwd, first));
}

export function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

// A directory searched in full, or by `**`: not node_modules, nor
// hidden ones, which hold copies and tool state rather than sources.
// Symbolic links to directories aren't followed either, so a link
// back up the tree can't loop.
const skipped = (entry: Dirent): boolean => entry.name === 'node_modules' || entry.name.startsWith('.');

/** The `*.user.js` files under `dir`, as paths starting with `spelled`. */
export function walkScripts(dir: string, spelled: string, out: string[]): void {
  for (const entry of entriesOf(dir)) {
    if (skipped(entry)) continue;
    const full = path.join(dir, entry.name);
    const shown = path.join(spelled, entry.name);
    if (entry.isDirectory()) walkScripts(full, shown, out);
    else if (SCRIPT_FILE.test(entry.name)) out.push(shown);
  }
}

// One path segment's pattern: `*` is any run of characters but `/`.
function segmentRegExp(segment: string): RegExp {
  const body = segment.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * What is wrong with a glob, or null. `**` only works as a whole path
 * part (not `a**` or `**.user.js`), and not as the last one, which
 * would leave the file name unmatched.
 */
export function globMistake(pattern: string): string | null {
  // A trailing slash leaves an empty last part, which isn't one.
  const segments = pattern.split(SEPARATORS).filter(Boolean);
  if (segments.some((s) => s.includes('**') && s !== '**')) {
    return `Invalid glob ${pattern}. Use ** only as a whole path part, as in src/**/*.user.js.`;
  }
  if (segments.at(-1) === '**') {
    return `Invalid glob ${pattern}. It ends in **, so it names no files. Add a file name, as in ${pattern.replace(/[/\\]+$/, '')}/*.user.js.`;
  }
  return null;
}

/**
 * The files a glob matches, sorted within each directory, no
 * directories. The glob must have no globMistake.
 */
export function globFiles(pattern: string, cwd = process.cwd()): string[] {
  if (!pattern.includes('*')) throw new Error('Internal error: globFiles needs a pattern with a *');
  // `/`, or a drive's root (`C:\\`) on Windows; '' when relative.
  const root = path.parse(pattern).root;
  const segments = pattern.slice(root.length).split(SEPARATORS).filter(Boolean);
  // The part before the first `*` is a plain directory to start from.
  const firstGlob = segments.findIndex((s) => s.includes('*'));
  const base = segments.slice(0, firstGlob);
  const spelledBase = root || base.length > 0 ? path.join(root, ...base) : '';
  const found: string[] = [];
  const visit = (dir: string, spelled: string, rest: string[]): void => {
    const [segment, ...after] = rest;
    const join = (name: string): string => (spelled ? path.join(spelled, name) : name);
    if (segment === '**') {
      // Zero directories, then one more, and so on.
      visit(dir, spelled, after);
      for (const entry of entriesOf(dir)) {
        if (!skipped(entry) && entry.isDirectory()) visit(path.join(dir, entry.name), join(entry.name), rest);
      }
      return;
    }
    if (!segment.includes('*')) {
      const full = path.join(dir, segment);
      if (after.length === 0) {
        if (!isDirectory(full) && statOk(full)) found.push(join(segment));
      } else if (isDirectory(full)) {
        visit(full, join(segment), after);
      }
      return;
    }
    const re = segmentRegExp(segment);
    for (const entry of entriesOf(dir)) {
      // A hidden name only for a segment that asks for one.
      if (entry.name.startsWith('.') && !segment.startsWith('.')) continue;
      if (!re.test(entry.name)) continue;
      // A link to a directory is followed here, where it was named.
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(dir, entry.name)));
      if (after.length === 0) {
        if (!isDir) found.push(join(entry.name));
      } else if (isDir) {
        visit(path.join(dir, entry.name), join(entry.name), after);
      }
    }
  };
  visit(path.resolve(cwd, spelledBase || '.'), spelledBase, segments.slice(firstGlob));
  // `**/**` and the like can reach one file twice.
  return [...new Set(found)];
}

function statOk(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
