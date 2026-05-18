// Tmp-dir helper for e2e tests that need real userscript files on
// disk. Each test gets its own dir under os.tmpdir(); the dir is
// passed to the extension via addSource(absolutePath), which then
// reads through the production file:// scan + fetch pipeline.
//
// Why on disk (and not just seeded into chrome.storage.local):
//   - exercises directories.ts, file:// XHR/fetch, and the unchanged-
//     skip optimisation
//   - exercises the storage.onChanged → stale-tab propagation flow when
//     a script's bodyText changes on refresh
//   - matches how a user would actually use the extension

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UserscriptSpec {
  // Relative path within the directory, e.g. "hello.user.js" or
  // "sub/greet.user.js". The file is created with the headers built
  // from `meta` and the body verbatim.
  relativePath: string;
  meta: UserscriptMeta;
  body: string;
}

export interface UserscriptMeta {
  // Empty `name` skips the @name line entirely (useful for tests that
  // need a script with no @name to trigger validateHeader's error
  // path). A whitespace-only @name still passes validateHeader, so we
  // can't emit `@name ` and call it missing.
  name: string;
  match?: string[];           // @match patterns
  include?: string[];         // @include patterns
  exclude?: string[];         // @exclude patterns
  runAt?: 'document-start' | 'document-end' | 'document-idle';
  grant?: string[];           // e.g. ['none'] — controls MAIN vs USER_SCRIPT world
  injectInto?: 'page' | 'content' | 'auto';
  extra?: string[];           // raw lines appended to the metadata block verbatim
}

// Build the @-prefixed metadata block. The output always starts with
// `// ==UserScript==` and ends with `// ==/UserScript==`, with a single
// blank line after so headers visually separate from the body.
export function renderMetadata(meta: UserscriptMeta): string {
  const lines: string[] = ['// ==UserScript=='];
  const push = (key: string, value: string): void => {
    lines.push(`// @${key.padEnd(11)} ${value}`);
  };
  if (meta.name) push('name', meta.name);
  for (const m of meta.match ?? []) push('match', m);
  for (const i of meta.include ?? []) push('include', i);
  for (const e of meta.exclude ?? []) push('exclude', e);
  if (meta.runAt) push('run-at', meta.runAt);
  for (const g of meta.grant ?? []) push('grant', g);
  if (meta.injectInto) push('inject-into', meta.injectInto);
  for (const extra of meta.extra ?? []) lines.push(extra);
  lines.push('// ==/UserScript==', '');
  return lines.join('\n');
}

export function renderUserscript(spec: UserscriptSpec): string {
  return renderMetadata(spec.meta) + spec.body;
}

export class ScriptsDir {
  readonly path: string;
  private readonly toCleanup: string[] = [];

  constructor(dir: string) {
    this.path = dir;
    this.toCleanup.push(dir);
  }

  // Create a tmp dir under os.tmpdir() and return a ScriptsDir handle.
  // Caller is responsible for calling cleanup() — tests usually do this
  // via test.afterEach.
  static create(prefix = 'vibemonkey-scripts-'): ScriptsDir {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return new ScriptsDir(dir);
  }

  // Write a userscript file into the dir, creating any intermediate
  // sub-directories. Bumps mtime by an explicit amount to avoid
  // ext4's seconds-resolution timestamps interfering with the
  // size+mtime skip optimisation in fetchOrSkipInParallel — when a
  // test rewrites a file we want the next refresh to see it.
  write(spec: UserscriptSpec): string {
    const fullPath = path.join(this.path, spec.relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, renderUserscript(spec));
    // Bump mtime explicitly forward so a same-second rewrite still
    // counts as changed for the unchanged-skip check.
    const now = Date.now();
    fs.utimesSync(fullPath, now / 1000, now / 1000 + 1);
    return fullPath;
  }

  // Rewrite an existing file with new body content. The metadata block
  // stays the same (preserves @match etc. so the matcher's view of the
  // script doesn't change). Bumps mtime so the next refresh sees it.
  rewriteBody(relativePath: string, newBody: string): void {
    const fullPath = path.join(this.path, relativePath);
    const current = fs.readFileSync(fullPath, 'utf8');
    // Find the end of the metadata block; keep everything up to and
    // including the trailing blank line, then append the new body.
    const closer = current.indexOf('// ==/UserScript==');
    if (closer === -1) throw new Error(`no metadata block in ${relativePath}`);
    const afterCloser = current.indexOf('\n', closer);
    const head = current.slice(0, afterCloser + 1);
    // Preserve the blank line after the header for readability.
    const blankLine = current[afterCloser + 1] === '\n' ? '\n' : '';
    fs.writeFileSync(fullPath, head + blankLine + newBody);
    const now = Date.now();
    fs.utimesSync(fullPath, now / 1000, now / 1000 + 2);
  }

  remove(relativePath: string): void {
    fs.rmSync(path.join(this.path, relativePath), { force: true });
  }

  cleanup(): void {
    for (const dir of this.toCleanup) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}
