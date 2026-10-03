// Unit tests for sm-dev's file arguments: globs (src/harness/path-args.ts)
// and their expansion with directories (expandPathArg in checks.ts).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globFiles } from '../../../lib/harness/path-args.js';
import { UsageError, expandPathArg, expandPathArgs } from '../../../lib/harness/checks.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sm-path-args-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const file of [
  'a.user.js', 'b.user.js', 'page.html', '.hidden.user.js',
  'sub/c.user.js', 'sub/deep/d.user.js', 'sub/deep/page.html',
  'node_modules/x.user.js', '.git/y.user.js', 'empty/readme.txt',
]) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), '');
}
// A link back up the tree, which a search must not follow.
symlinkSync('..', path.join(root, 'sub', 'loop'));

test('* matches within one directory, sorted, skipping hidden files', () => {
  assert.deepEqual(globFiles('*.user.js', root), ['a.user.js', 'b.user.js']);
  assert.deepEqual(globFiles('sub/*', root), ['sub/c.user.js']);
  assert.deepEqual(globFiles('.*.user.js', root), ['.hidden.user.js']);
});

test('** matches zero or more directories, not node_modules or hidden ones', () => {
  assert.deepEqual(globFiles('**/*.user.js', root), ['a.user.js', 'b.user.js', 'sub/c.user.js', 'sub/deep/d.user.js']);
  assert.deepEqual(globFiles('sub/**/*.html', root), ['sub/deep/page.html']);
  assert.deepEqual(globFiles('s*/**/d.user.js', root), ['sub/deep/d.user.js']);
});

test('an absolute pattern gives absolute paths', () => {
  assert.deepEqual(globFiles(path.join(root, 'sub', '*.user.js')), [path.join(root, 'sub', 'c.user.js')]);
});

test('a directory stands for its scripts, only where scripts are expected', () => {
  assert.deepEqual(expandPathArg('sub', root, { scripts: true }), ['sub/c.user.js', 'sub/deep/d.user.js']);
  assert.deepEqual(expandPathArg('sub', root), ['sub']);
});

test('a URL or plain word is left as it is', () => {
  assert.deepEqual(expandPathArg('https://example.com/*', root, { scripts: true }), ['https://example.com/*']);
  assert.deepEqual(expandPathArg('example.com', root, { scripts: true }), ['example.com']);
});

test('expanding to nothing is a usage error', () => {
  assert.throws(() => expandPathArg('*.txt', root), (err) => err instanceof UsageError && err.message === 'No files match *.txt');
  assert.throws(() => expandPathArg('empty', root, { scripts: true }), (err) => err instanceof UsageError && err.message === 'No .user.js files found under empty');
});

test('each path once, in the order given', () => {
  assert.deepEqual(expandPathArgs(['b.user.js', '*.user.js'], root), ['b.user.js', 'a.user.js']);
});

test('** that is not a whole path part, or is the last one, is a usage error', () => {
  for (const glob of ['abc**', '**def', '**.user.js', 'sub/x**/*.js']) {
    assert.throws(() => expandPathArg(glob, root), (err) => err instanceof UsageError && err.message === `Invalid glob ${glob}. Use ** only as a whole path part, as in src/**/*.user.js.`);
  }
  assert.throws(() => expandPathArg('sub/**/', root), (err) => err instanceof UsageError && err.message.endsWith('as in sub/**/*.user.js.'));
  assert.throws(() => expandPathArg('sub/**', root), (err) => err instanceof UsageError && err.message === 'Invalid glob sub/**. It ends in **, so it names no files. Add a file name, as in sub/**/*.user.js.');
});

test('a directory link named in the pattern is followed, not while searching', () => {
  assert.deepEqual(globFiles('sub/loop/*.user.js', root), ['sub/loop/a.user.js', 'sub/loop/b.user.js']);
  assert.deepEqual(expandPathArg('sub', root, { scripts: true }), ['sub/c.user.js', 'sub/deep/d.user.js']);
});

test('a word with a * and no scheme is a glob, even one that looks like a host', () => {
  assert.throws(() => expandPathArg('example.com/*', root, { scripts: true }), /No files match example\.com\/\*/);
  assert.throws(() => expandPathArg('localhost/*', root, { scripts: true }), /No files match localhost\/\*/);
  assert.deepEqual(expandPathArg('http://localhost/*', root, { scripts: true }), ['http://localhost/*']);
  assert.deepEqual(expandPathArg('sub/*', root), ['sub/c.user.js']);
});

test('an empty word is left as it is, not the current directory', () => {
  assert.deepEqual(expandPathArg('', root, { scripts: true }), ['']);
});
