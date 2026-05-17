// Tests for the directory-listing parser and path/URL helpers in
// src/directories.ts (compiled to dist/directories.js).
//
// parseListing is the part most likely to silently rot: Chrome's
// directory-listing HTML is an undocumented format, so the sample
// HTML below mirrors the addRow(...) shape we've observed and
// regression-guards the regex against accidental tightening.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseListing,
  pathToFileUrl,
  joinPath,
  scriptFileUrl,
  isSingleFilePath,
  parentDir,
  baseName,
} from '../../dist/directories.js';

test('parseListing extracts files and directories, skipping ..', () => {
  const html = `
    <script>start("/home/me/scripts/");</script>
    <script>addRow("..", ".", 1, 0, "", 0, "");</script>
    <script>addRow("foo.user.js", "foo.user.js", 0, 1234, "1 KB", 5678, "date");</script>
    <script>addRow("sub", "sub/", 1, 0, "", 0, "");</script>
    <script>addRow("readme.md", "readme.md", 0, 9, "9 B", 1, "date");</script>
  `;
  const entries = parseListing(html);
  assert.deepEqual(entries, [
    { name: 'foo.user.js', isDir: false, size: 1234, mtime: 5678 },
    { name: 'sub', isDir: true, size: 0, mtime: 0 },
    { name: 'readme.md', isDir: false, size: 9, mtime: 1 },
  ]);
});

test('parseListing tolerates rows without size/mtime', () => {
  // Some older Chrome builds emitted shorter addRow calls. The refresh
  // pipeline copes with missing size/mtime by falling back to always-
  // refetch, so the parser must just leave the fields undefined.
  const html = `
    <script>addRow("a.user.js", "a.user.js", 0);</script>
    <script>addRow("b.user.js", "b.user.js", 0, 100);</script>
  `;
  assert.deepEqual(parseListing(html), [
    { name: 'a.user.js', isDir: false },
    { name: 'b.user.js', isDir: false, size: 100 },
  ]);
});

test('parseListing accepts true/false for the isdir argument', () => {
  const html = `
    <script>addRow("a.user.js", "a.user.js", false, 1, "1", 1, "d");</script>
    <script>addRow("dir", "dir/", true, 0, "", 0, "");</script>
  `;
  assert.deepEqual(parseListing(html), [
    { name: 'a.user.js', isDir: false, size: 1, mtime: 1 },
    { name: 'dir', isDir: true, size: 0, mtime: 0 },
  ]);
});

test('parseListing decodes escaped names', () => {
  const html = `<script>addRow("with \\"quote\\".user.js", "x", 0, 1, "1", 1, "d");</script>`;
  assert.deepEqual(parseListing(html), [
    { name: 'with "quote".user.js', isDir: false, size: 1, mtime: 1 },
  ]);
});

test('parseListing returns [] on unrelated HTML', () => {
  assert.deepEqual(parseListing('<html><body>nothing here</body></html>'), []);
});

test('pathToFileUrl percent-encodes segments and strips trailing slash', () => {
  assert.equal(pathToFileUrl('/home/me/my scripts/'), 'file:///home/me/my%20scripts');
  assert.equal(pathToFileUrl('/a/b'), 'file:///a/b');
});

test('joinPath strips trailing slashes on the base', () => {
  assert.equal(joinPath('/a/b/', 'c'), '/a/b/c');
  assert.equal(joinPath('/a/b', 'c/d'), '/a/b/c/d');
});

test('scriptFileUrl joins dir + relative and encodes the result', () => {
  assert.equal(
    scriptFileUrl('/home/me/scripts', 'sub/foo bar.user.js'),
    'file:///home/me/scripts/sub/foo%20bar.user.js',
  );
});

test('isSingleFilePath recognizes *.user.js paths', () => {
  assert.equal(isSingleFilePath('/home/me/foo.user.js'), true);
  assert.equal(isSingleFilePath('/home/me/scripts'), false);
  assert.equal(isSingleFilePath('/home/me/notes.txt'), false);
});

test('parentDir and baseName split an absolute path', () => {
  assert.equal(parentDir('/home/me/foo.user.js'), '/home/me');
  assert.equal(baseName('/home/me/foo.user.js'), 'foo.user.js');
  // Top-level path keeps `/` as parent.
  assert.equal(parentDir('/foo.user.js'), '/');
  assert.equal(baseName('/foo.user.js'), 'foo.user.js');
});

test('scriptFileUrl uses the source path verbatim for a single-file source', () => {
  // relativePath equals the basename, so the directory-style join
  // would double the filename — the single-file branch returns the
  // source path's URL directly.
  assert.equal(
    scriptFileUrl('/home/me/foo bar.user.js', 'foo bar.user.js'),
    'file:///home/me/foo%20bar.user.js',
  );
});
