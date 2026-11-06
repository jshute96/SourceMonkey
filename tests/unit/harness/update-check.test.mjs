// Unit tests for the update check (src/harness/update-check.ts) and the
// update commands (src/harness/project-copy.ts). The CLI tests run a copy
// of lib/ marked as a release, since only those check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { announcedVersion, refreshUpdateCache, updateNote } from '../../../lib/harness/update-check.js';
import { globalInstall, nearestCopy, updateCommand } from '../../../lib/harness/project-copy.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-update-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('announces a newer version only once it is a day old', () => {
  const cached = (latest, age) => ({ checkedAt: NOW, latest, publishedAt: NOW - age });
  assert.equal(announcedVersion('0.5.1', cached('0.5.3', 24 * HOUR), NOW), '0.5.3');
  assert.equal(announcedVersion('0.5.1', cached('0.5.3', 23 * HOUR), NOW), null);
  // The same, or a local copy ahead of npm.
  assert.equal(announcedVersion('0.5.3', cached('0.5.3', 48 * HOUR), NOW), null);
  assert.equal(announcedVersion('0.6.0', cached('0.5.3', 48 * HOUR), NOW), null);
  // Compared as versions, not as text.
  assert.equal(announcedVersion('0.9.0', cached('0.10.0', 48 * HOUR), NOW), '0.10.0');
  // Nothing known yet.
  assert.equal(announcedVersion('0.5.1', null, NOW), null);
  assert.equal(announcedVersion('0.5.1', { checkedAt: NOW }, NOW), null);
});

test('the update command fits how the copy was installed', () => {
  const project = (manager, dependency = 'sourcemonkey') => updateCommand({ kind: 'project', manager, dependency });
  assert.equal(project('pnpm'), 'pnpm update --latest sourcemonkey');
  assert.equal(project('pnpm', 'sm-dev'), 'pnpm update --latest sm-dev');
  assert.equal(project('npm'), 'npm install -D sourcemonkey@latest');
  // Only what's positively identified gets a command.
  assert.equal(project('yarn'), null);
  assert.equal(project('bun'), null);
  assert.equal(project(undefined), null);
  assert.equal(updateCommand({ kind: 'unknown' }), null);
  assert.equal(updateCommand({ kind: 'global', manager: 'npm', dependency: 'sm-dev' }), 'npm update -g sm-dev');
  assert.equal(updateCommand({ kind: 'global', manager: 'pnpm', dependency: 'sourcemonkey' }), 'pnpm update -g --latest sourcemonkey');
  assert.equal(updateCommand({ kind: 'download', tool: 'npx' }), 'npx sm-dev@latest');
  assert.equal(updateCommand({ kind: 'download', tool: 'dlx' }), 'pnpm dlx sm-dev@latest');
});

test('a project is told to update the package it lists', (t) => {
  const dir = tmpDir(t);
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
  };
  // npm hoists the wrapper's `sourcemonkey` to the top of node_modules.
  write('wrapper/package.json', { devDependencies: { 'sm-dev': '0.5.1' } });
  write('wrapper/node_modules/sm-dev/package.json', { name: 'sm-dev' });
  write('wrapper/node_modules/sourcemonkey/package.json', { name: 'sourcemonkey' });
  assert.equal(nearestCopy(path.join(dir, 'wrapper')).dependency, 'sm-dev');
  write('direct/package.json', { devDependencies: { sourcemonkey: '0.5.1' } });
  write('direct/node_modules/sourcemonkey/package.json', { name: 'sourcemonkey' });
  assert.equal(nearestCopy(path.join(dir, 'direct')).dependency, 'sourcemonkey');
  // A workspace member's dependency, installed at the root.
  write('space/package.json', { name: 'root' });
  write('space/node_modules/sourcemonkey/package.json', { name: 'sourcemonkey' });
  write('space/member/package.json', { dependencies: { 'sm-dev': '0.5.1' } });
  const member = nearestCopy(path.join(dir, 'space', 'member'));
  assert.equal(member.dependency, 'sm-dev');
  assert.equal(member.project, path.join(dir, 'space'));
});

test('a global copy is told to update the package installed', () => {
  const direct = (dir) => globalInstall(dir, path.join(dir, 'lib', 'harness', 'launcher.js'));
  const wrapped = (dir) => globalInstall(dir, path.join(dir, '..', '..', 'sm-dev', 'cli.js'));
  const npm = path.join(path.sep, 'usr', 'lib', 'node_modules', 'sourcemonkey');
  assert.deepEqual(direct(npm), { kind: 'global', manager: 'npm', dependency: 'sourcemonkey' });
  assert.deepEqual(wrapped(npm), { kind: 'global', manager: 'npm', dependency: 'sm-dev' });
  // pnpm's two layouts.
  for (const dir of [
    path.join(path.sep, 'pnpm', 'global', 'v11', 'abc', 'node_modules', '.pnpm', 'sourcemonkey@0.5.1', 'node_modules', 'sourcemonkey'),
    path.join(path.sep, 'pnpm', 'store', 'v11', 'links', '@', 'sourcemonkey', '0.5.1', 'abc', 'node_modules', 'sourcemonkey'),
  ]) {
    assert.deepEqual(direct(dir), { kind: 'global', manager: 'pnpm', dependency: 'sourcemonkey' });
    assert.deepEqual(wrapped(dir), { kind: 'global', manager: 'pnpm', dependency: 'sm-dev' });
  }
  // A layout it doesn't recognize, and a project's copy run from outside it.
  assert.deepEqual(direct(path.join(path.sep, 'opt', 'tools', 'sourcemonkey')), { kind: 'unknown' });
  assert.deepEqual(direct(path.join(path.sep, 'proj', 'node_modules', 'sourcemonkey')), { kind: 'unknown' });
  assert.deepEqual(direct(path.join(path.sep, 'proj', 'node_modules', '.pnpm', 'sourcemonkey@0.5.1', 'node_modules', 'sourcemonkey')), { kind: 'unknown' });
});

test('the note names the current version only when asked to', () => {
  const update = { latest: '0.5.3', command: 'npm update -g sm-dev' };
  assert.equal(updateNote(update), 'sm-dev 0.5.3 is available. Update with `npm update -g sm-dev`.');
  assert.equal(updateNote(update, '0.5.1'), 'sm-dev 0.5.3 is available (current is 0.5.1). Update with `npm update -g sm-dev`.');
  assert.equal(updateNote({ latest: '0.5.3' }), 'sm-dev 0.5.3 is available. Update it the way you installed it.');
  assert.equal(updateNote({ latest: '0.5.3', command: 'npx sm-dev@latest', oneOff: true }, '0.5.1'), 'sm-dev 0.5.3 is available (current is 0.5.1). Run it with `npx sm-dev@latest`.');
});

// Runs `refreshUpdateCache` against a local server answering with `reply`,
// with the cache under `dir`, and gives back the saved file.
async function refreshed(t, dir, reply) {
  const server = http.createServer((_req, res) => reply(res));
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  });
  await refreshUpdateCache(`http://127.0.0.1:${server.address().port}/`);
  return JSON.parse(fs.readFileSync(path.join(dir, 'sm-dev', 'latest-version.json'), 'utf8'));
}

test('a refresh saves the latest version and when it was published, atomically', async (t) => {
  const dir = tmpDir(t);
  const saved = await refreshed(t, dir, (res) => res.end(JSON.stringify({
    'dist-tags': { latest: '0.5.3' },
    time: { '0.5.3': '2026-11-01T05:18:18.337Z' },
  })));
  assert.equal(saved.latest, '0.5.3');
  assert.equal(saved.publishedAt, Date.parse('2026-11-01T05:18:18.337Z'));
  assert.ok(Date.now() - saved.checkedAt < 60_000);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sm-dev')), ['latest-version.json']);
});

test('a failed refresh keeps the earlier answer and updates the time', async (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'sm-dev'));
  fs.writeFileSync(path.join(dir, 'sm-dev', 'latest-version.json'), JSON.stringify({ checkedAt: 1, latest: '0.5.2', publishedAt: 2 }));
  const saved = await refreshed(t, dir, (res) => { res.statusCode = 500; res.end('{}'); });
  assert.equal(saved.latest, '0.5.2');
  assert.equal(saved.publishedAt, 2);
  assert.ok(saved.checkedAt > 1);
});

// A copy of the package at version 0.0.1, with a cache saying 9.9.9 came
// out long ago. `release` says whether it's marked as published.
function installedCopy(t, { release = true, at = ['lib', 'node_modules', 'sourcemonkey'] } = {}) {
  const dir = tmpDir(t);
  const copy = path.join(dir, ...at);
  fs.mkdirSync(copy, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'lib'), path.join(copy, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(copy, 'node_modules'));
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'not-a-checkout', version: '0.0.1', type: 'module' }));
  fs.writeFileSync(path.join(copy, 'lib', 'build-info.json'), JSON.stringify(release ? { release: true } : { source: REPO_ROOT }));
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(cache, 'sm-dev'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'sm-dev', 'latest-version.json'),
    JSON.stringify({ checkedAt: Date.now(), latest: '9.9.9', publishedAt: Date.now() - 48 * HOUR }));
  const run = (args, env = {}) => {
    const { CI, SM_DEV_NO_UPDATE_CHECK, FORCE_COLOR, ...rest } = process.env;
    return spawnSync(process.execPath, [path.join(copy, 'lib', 'harness', 'cli.js'), ...args], {
      cwd: dir, encoding: 'utf8', env: { ...rest, XDG_CACHE_HOME: cache, ...env },
    });
  };
  return { copy, run };
}

const NOTE = /^\[sm-dev\] sm-dev 9\.9\.9 is available\. Update with `npm update -g sourcemonkey`\.\n$/;

test('--version puts the new version on stderr, leaving stdout as it was', (t) => {
  const { copy, run } = installedCopy(t);
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `sm-dev 0.0.1 from ${copy}\n`);
  assert.match(r.stderr, NOTE);
});

test('--version --json gives the new version as a field, with no note', (t) => {
  const { run } = installedCopy(t);
  const r = run(['--json=single', '--version']);
  assert.deepEqual(JSON.parse(r.stdout).update, { latest: '9.9.9', command: 'npm update -g sourcemonkey' });
  assert.equal(r.stderr, '');
});

test('a copy it can\'t place gets no command', (t) => {
  const { run } = installedCopy(t, { at: ['tools', 'sourcemonkey'] });
  assert.match(run(['--version']).stderr, /^\[sm-dev\] sm-dev 9\.9\.9 is available\. Update it the way you installed it\.\n$/);
  assert.deepEqual(JSON.parse(run(['--json=single', '--version']).stdout).update, { latest: '9.9.9' });
});

test('a local build, CI and the opt-out show nothing', (t) => {
  const quiet = (r) => {
    assert.equal(r.stderr, '');
    assert.doesNotMatch(r.stdout, /9\.9\.9/);
  };
  quiet(installedCopy(t, { release: false }).run(['--version']));
  const { run } = installedCopy(t);
  quiet(run(['--version'], { CI: 'true' }));
  quiet(run(['--version'], { SM_DEV_NO_UPDATE_CHECK: '1' }));
});
