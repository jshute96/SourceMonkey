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
    { name: 'foo.user.js', isDir: false },
    { name: 'sub', isDir: true },
    { name: 'readme.md', isDir: false },
  ]);
});

test('parseListing accepts true/false for the isdir argument', () => {
  const html = `
    <script>addRow("a.user.js", "a.user.js", false, 1, "1", 1, "d");</script>
    <script>addRow("dir", "dir/", true, 0, "", 0, "");</script>
  `;
  assert.deepEqual(parseListing(html), [
    { name: 'a.user.js', isDir: false },
    { name: 'dir', isDir: true },
  ]);
});

test('parseListing decodes escaped names', () => {
  const html = `<script>addRow("with \\"quote\\".user.js", "x", 0, 1, "1", 1, "d");</script>`;
  assert.deepEqual(parseListing(html), [
    { name: 'with "quote".user.js', isDir: false },
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
