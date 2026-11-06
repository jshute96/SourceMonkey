// Unit tests for the `sm-dev` launcher (src/harness/launcher.ts,
// compiled to lib/harness/launcher.js): run from inside a project that
// has its own copy of sourcemonkey, it runs that copy's cli.js instead
// of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../../../lib/harness/launcher.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-launcher-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in copy of sourcemonkey at `dir`, whose cli.js prints a mark
// and its arguments. `name` is the package.json name.
function fakeCopy(dir, { name = 'sourcemonkey', built = true } = {}) {
  fs.mkdirSync(path.join(dir, 'lib', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }));
  if (built) {
    fs.writeFileSync(path.join(dir, 'lib', 'harness', 'cli.js'),
      `console.log('fake ' + JSON.stringify(process.argv.slice(2))); process.exitCode = 3;\n`);
  }
}

function launch(cwd, args, env = {}) {
  const { SM_DEV_NO_LOCAL, ...rest } = process.env;
  return spawnSync(process.execPath, [LAUNCHER, ...args], { cwd, encoding: 'utf8', env: { ...rest, ...env } });
}

test('runs the copy in node_modules, from a subdirectory too', (t) => {
  const project = tmpDir(t);
  fakeCopy(path.join(project, 'node_modules', 'sourcemonkey'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"scripts"}');
  fs.mkdirSync(path.join(project, 'sites', 'a'), { recursive: true });
  const r = launch(path.join(project, 'sites', 'a'), ['validate', 'x.user.js']);
  assert.equal(r.stdout, 'fake ["validate","x.user.js"]\n');
  assert.equal(r.status, 3);
});

test('runs a checkout\'s own lib/', (t) => {
  const checkout = tmpDir(t);
  fakeCopy(checkout);
  const r = launch(checkout, ['--version']);
  assert.equal(r.stdout, 'fake ["--version"]\n');
});

test('reports an unbuilt checkout', (t) => {
  const checkout = tmpDir(t);
  fakeCopy(checkout, { built: false });
  const r = launch(checkout, ['--version']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^\[sm-dev\] ERROR: The SourceMonkey copy in .* isn't built: .*`pnpm run build`.*`SM_DEV_NO_LOCAL=1`/);
});

test('reports an unbuilt installed copy, with where to install', (t) => {
  const project = tmpDir(t);
  fakeCopy(path.join(project, 'node_modules', 'sourcemonkey'), { built: false });
  const r = launch(project, ['--version']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`is incomplete: The file lib/harness/cli.js is missing. Run \`npm install\` in ${project},`), r.stderr);
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
  assert.ok(launch(project, ['--version']).stderr.includes(`Run \`pnpm install\` in ${project},`));
});

test('reports a project that depends on sourcemonkey without having it installed', (t) => {
  const outer = tmpDir(t);
  fakeCopy(outer);
  const project = path.join(outer, 'scripts');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{"devDependencies":{"sourcemonkey":"^0.5.0"}}');
  const r = launch(project, ['--version']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sm-dev isn't installed: .* depends on it but it's not installed in node_modules\. Run `npm install` to install it, or/);
});

test('takes the nearest copy', (t) => {
  const checkout = tmpDir(t);
  fakeCopy(checkout, { built: false });
  const project = path.join(checkout, 'nested');
  fakeCopy(path.join(project, 'node_modules', 'sourcemonkey'));
  assert.equal(launch(project, ['x']).stdout, 'fake ["x"]\n');
});

test('follows a symlinked node_modules copy, as pnpm installs it', (t) => {
  const store = tmpDir(t);
  const project = tmpDir(t);
  fakeCopy(path.join(store, 'sourcemonkey'));
  fs.mkdirSync(path.join(project, 'node_modules'));
  fs.symlinkSync(path.join(store, 'sourcemonkey'), path.join(project, 'node_modules', 'sourcemonkey'));
  assert.equal(launch(project, ['x']).stdout, 'fake ["x"]\n');
});

test('a package.json with another name is not a checkout', (t) => {
  const dir = tmpDir(t);
  fakeCopy(dir, { name: 'other' });
  const r = launch(dir, ['--json=single', '--version']);
  assert.equal(JSON.parse(r.stdout).dir, REPO_ROOT.replace(/\/$/, ''));
});

test('runs its own copy outside a project, or with SM_DEV_NO_LOCAL', (t) => {
  const plain = tmpDir(t);
  const project = tmpDir(t);
  fakeCopy(path.join(project, 'node_modules', 'sourcemonkey'));
  for (const [cwd, env] of [[plain, {}], [project, { SM_DEV_NO_LOCAL: '1' }]]) {
    const r = launch(cwd, ['--json=single', '--version'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).dir, REPO_ROOT.replace(/\/$/, ''));
  }
});

test('run from npx\'s cache, runs its own copy', (t) => {
  const cache = tmpDir(t);
  const harness = path.join(cache, '_npx', 'abc', 'lib', 'harness');
  fs.mkdirSync(harness, { recursive: true });
  fs.writeFileSync(path.join(cache, '_npx', 'abc', 'package.json'), '{"type":"module"}');
  for (const f of ['launcher.js', 'output-style.js', 'project-copy.js']) {
    fs.copyFileSync(path.join(path.dirname(LAUNCHER), f), path.join(harness, f));
  }
  fs.writeFileSync(path.join(harness, 'cli.js'), `console.log('own');\n`);
  const project = tmpDir(t);
  fakeCopy(path.join(project, 'node_modules', 'sourcemonkey'));
  const r = spawnSync(process.execPath, [path.join(harness, 'launcher.js')], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'own\n');
});

test('runs the sourcemonkey an installed sm-dev wrapper depends on, as pnpm lays it out', (t) => {
  // pnpm: node_modules/sm-dev links into the store, where its own
  // sourcemonkey sits beside it; the project's node_modules has no
  // sourcemonkey.
  const project = tmpDir(t);
  const store = path.join(project, 'node_modules', '.pnpm', 'sm-dev@1', 'node_modules');
  fs.mkdirSync(path.join(store, 'sm-dev'), { recursive: true });
  fs.writeFileSync(path.join(store, 'sm-dev', 'package.json'), '{"name":"sm-dev"}');
  fakeCopy(path.join(store, 'sourcemonkey'));
  fs.symlinkSync(path.join(store, 'sm-dev'), path.join(project, 'node_modules', 'sm-dev'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"devDependencies":{"sm-dev":"^0.5.0"}}');
  assert.equal(launch(project, ['x']).stdout, 'fake ["x"]\n');
});

test('reports an unbuilt copy under an sm-dev wrapper, with the project to install in', (t) => {
  const project = tmpDir(t);
  const store = path.join(project, 'node_modules', '.pnpm', 'sm-dev@1', 'node_modules');
  fs.mkdirSync(path.join(store, 'sm-dev'), { recursive: true });
  fs.writeFileSync(path.join(store, 'sm-dev', 'package.json'), '{"name":"sm-dev"}');
  fakeCopy(path.join(store, 'sourcemonkey'), { built: false });
  fs.symlinkSync(path.join(store, 'sm-dev'), path.join(project, 'node_modules', 'sm-dev'));
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
  const r = launch(project, ['x']);
  assert.ok(r.stderr.includes(`Run \`pnpm install\` in ${project},`), r.stderr);
});

test('a workspace member finds the copy installed at the workspace root', (t) => {
  const ws = tmpDir(t);
  fakeCopy(path.join(ws, 'node_modules', 'sourcemonkey'));
  const member = path.join(ws, 'packages', 'foo');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'package.json'), '{"devDependencies":{"sourcemonkey":"^0.5.0"}}');
  assert.equal(launch(member, ['x']).stdout, 'fake ["x"]\n');
});

test('the install command: own lockfile, then packageManager, then a lockfile above', (t) => {
  const outer = tmpDir(t);
  fs.writeFileSync(path.join(outer, 'pnpm-lock.yaml'), '');
  const project = path.join(outer, 'p');
  fs.mkdirSync(project);
  const write = (pkg) => fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ devDependencies: { 'sm-dev': '^0.5.0' }, ...pkg }));
  const command = () => launch(project, ['x']).stderr.match(/Run `([^`]+)`/)?.[1];
  write({});
  assert.equal(command(), 'pnpm install');
  write({ packageManager: 'yarn@4.1.0' });
  assert.equal(command(), 'yarn install');
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
  assert.equal(command(), 'npm install');
});

test('reports an unbuilt checkout an installed copy links to', (t) => {
  const checkout = tmpDir(t);
  fakeCopy(checkout, { built: false });
  const project = tmpDir(t);
  fs.mkdirSync(path.join(project, 'node_modules'));
  fs.symlinkSync(checkout, path.join(project, 'node_modules', 'sourcemonkey'));
  const r = launch(project, ['x']);
  assert.ok(r.stderr.includes(`copy in ${checkout} isn't built: The file lib/harness/cli.js is missing. Run \`pnpm run build\` there,`), r.stderr);
});
