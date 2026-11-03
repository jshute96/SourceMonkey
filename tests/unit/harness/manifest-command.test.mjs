// `sm-dev manifest`, as a subprocess over a temp directory of scripts:
// which directory it writes to, what it adds and prunes, and what it
// keeps of an existing manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI = path.join(REPO_ROOT, 'lib', 'harness', 'cli.js');
delete process.env.FORCE_COLOR;

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-manifest-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function manifest(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, 'manifest', ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'script_manifest.json'), 'utf8'));

test('a missing manifest is an error without --create', (t) => {
  const dir = sandbox({ 'a.user.js': '' });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const r = manifest(dir, '.');
  assert.equal(r.code, 2);
  assert.match(r.err, /There is no script_manifest\.json\. Use `?--create`? to make one/);
  assert.equal(fs.existsSync(path.join(dir, 'script_manifest.json')), false);
});

test('--create makes a sorted array, skipping hidden directories', (t) => {
  const dir = sandbox({ 'b.user.js': '', 'sub/a.user.js': '', '.hidden/c.user.js': '', 'x.js': '' });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const r = manifest(dir, '.', '--create');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read(dir), ['b.user.js', 'sub/a.user.js']);
  assert.equal(fs.readFileSync(path.join(dir, 'script_manifest.json'), 'utf8').endsWith(']\n'), true);
});

test('--format object wraps the list in scripts', (t) => {
  const dir = sandbox({ 'a.user.js': '' });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  assert.equal(manifest(dir, '.', '--create', '--format', 'object').code, 0);
  assert.deepEqual(read(dir), { scripts: ['a.user.js'] });
});

test('an update keeps other keys, fields and order, and adds objects beside objects', (t) => {
  const dir = sandbox({
    'sites/b/z.user.js': '', 'sites/b/a.user.js': '', 'sites/a/new.user.js': '',
    'script_manifest.json': JSON.stringify({ owner: 'me', scripts: [{ path: 'sites/b/z.user.js', note: 1 }, { path: './sites/b/a.user.js' }] }),
  });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const r = manifest(dir, '.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Added {2}sites\/a\/new\.user\.js/);
  assert.deepEqual(read(dir), { owner: 'me', scripts: [{ path: 'sites/a/new.user.js' }, { path: 'sites/b/z.user.js', note: 1 }, { path: './sites/b/a.user.js' }] });
  assert.match(manifest(dir, '.').out, /is up to date/);
});

test('--dir takes scripts and URLs, and refuses files outside it', (t) => {
  const dir = sandbox({ 'm/a.user.js': '', 'm/b.user.js': '', 'out.user.js': '', 'm/script_manifest.json': '[]' });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  assert.equal(manifest(dir, '--dir', 'm', 'm/b.user.js', 'https://example.com/x.user.js').code, 0);
  assert.deepEqual(read(path.join(dir, 'm')), ['b.user.js', 'https://example.com/x.user.js']);
  const outside = manifest(dir, '--dir', 'm', 'out.user.js');
  assert.equal(outside.code, 2);
  assert.match(outside.err, /isn't under `?m`?, where the manifest is/);
  assert.match(manifest(dir, 'm/a.user.js', 'm/b.user.js').err, /give the manifest's directory with `?--dir`?/);
});

test('--prune drops missing files under the directories given, and --dry-run writes nothing', (t) => {
  const dir = sandbox({ 'a.user.js': '', 'sub/b.user.js': '', 'script_manifest.json': JSON.stringify(['a.user.js', 'gone.user.js', 'sub/b.user.js', 'sub/gone.user.js', 'https://x.com/y.user.js']) });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const before = fs.readFileSync(path.join(dir, 'script_manifest.json'), 'utf8');
  assert.match(manifest(dir, '.', '--prune', '--dry-run').out, /Would remove {2}gone\.user\.js/);
  assert.equal(fs.readFileSync(path.join(dir, 'script_manifest.json'), 'utf8'), before);
  assert.equal(manifest(dir, '--dir', '.', 'sub', '--prune').code, 0);
  assert.deepEqual(read(dir), ['a.user.js', 'gone.user.js', 'sub/b.user.js', 'https://x.com/y.user.js']);
  assert.equal(manifest(dir, '.', '--prune').code, 0);
  assert.deepEqual(read(dir), ['a.user.js', 'sub/b.user.js', 'https://x.com/y.user.js']);
});

test('--format needs --create', (t) => {
  const dir = sandbox({ 'a.user.js': '' });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  assert.match(manifest(dir, '.', '--format', 'array').err, /only for a new manifest/);
  assert.match(manifest(dir, '.', '--create', '--format', 'list').err, /needs `?array`? or `?object`?/);
});

test('--prune handles a directory whose scripts were all deleted', (t) => {
  const dir = sandbox({ 'a.user.js': '', 'sub/.keep': '', 'script_manifest.json': JSON.stringify(['a.user.js', 'sub/gone.user.js']) });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const r = manifest(dir, '--dir', '.', 'sub', '--prune');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read(dir), ['a.user.js']);
});

test('a file: URL is taken as a local path', (t) => {
  const dir = sandbox({ 'a.user.js': '', 'script_manifest.json': '[]' });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const r = manifest(dir, '--dir', '.', pathToFileURL(path.join(dir, 'a.user.js')).href);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read(dir), ['a.user.js']);
});

test('new entries are strings when existing ones are mixed', (t) => {
  const dir = sandbox({ 'a.user.js': '', 'b.user.js': '', 'c.user.js': '', 'script_manifest.json': JSON.stringify(['a.user.js', { path: 'c.user.js' }]) });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  assert.equal(manifest(dir, '.').code, 0);
  assert.deepEqual(read(dir), ['a.user.js', 'b.user.js', { path: 'c.user.js' }]);
});
