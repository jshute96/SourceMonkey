// Unit tests for the argument checks in `sm-dev` (src/harness/cli.ts,
// compiled to lib/harness/cli.js): `run` flag combinations that would
// do nothing or stall, and `send`, `stop` and `list` arguments they
// can't act on, are refused up front, before any browser or run is
// reached.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../examples/gm-menu/gm-menu.user.js', import.meta.url));

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, 'run', ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim().split('\n')[0] };
}

test('--noscript refuses scripts, and a run needs one without it', () => {
  assert.deepEqual(run('--noscript', SCRIPT), {
    code: 2, out: 'The --noscript flag runs no scripts, so the run command takes none with it',
  });
  assert.deepEqual(run(), { code: 2, out: 'The run command needs at least one script, or --noscript' });
});

test('--noscript refuses the flags that act on scripts', () => {
  assert.deepEqual(run('--noscript', '--watch'), { code: 2, out: 'The --noscript flag can\'t be used with --watch' });
  assert.deepEqual(run('--noscript', '--all', '--fire-menu', 'X'), {
    code: 2, out: 'The --noscript flag can\'t be used with --all or --fire-menu',
  });
  assert.deepEqual(run('--noscript', '--extension'), { code: 2, out: 'The --noscript flag can\'t be used with --extension' });
});

test('--notab refuses the flags that need a tab', () => {
  assert.deepEqual(run(SCRIPT, '--notab', '--url', 'x.com'), { code: 2, out: 'The --notab flag can\'t be used with --url' });
  assert.deepEqual(run(SCRIPT, '--notab', '--fire-menu', 'X'), { code: 2, out: 'The --notab flag can\'t be used with --fire-menu' });
});

// An empty runs directory of its own, so runs active on this machine
// don't change the answers.
const RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-runs-test-'));
after(() => rmSync(RUNS_DIR, { recursive: true, force: true }));

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  return { code: r.status, out: (r.stdout + r.stderr).trim().split('\n')[0] };
}

test('send and stop refuse what they can\'t act on', () => {
  assert.deepEqual(cli('send'), { code: 2, out: 'The send command needs a command to send, e.g. sm-dev send status' });
  assert.deepEqual(cli('send', 'D9', 'status'), { code: 1, out: 'There is no run D9. Type sm-dev list to see the runs.' });
  assert.deepEqual(cli('send', '9', 'status'), { code: 2, out: 'Runs are named D1, D2 and so on. Did you mean D9?' });
  assert.deepEqual(cli('send', 'status'), { code: 1, out: 'No sm-dev runs are active' });
  assert.deepEqual(cli('stop', 'x'), { code: 2, out: 'There is no run named x. Runs are named D1, D2 and so on; type sm-dev list to see them.' });
  assert.deepEqual(cli('stop', '--all', 'D1'), {
    code: 2, out: 'The --all flag stops every run, so the stop command takes no run ids with it',
  });
  assert.deepEqual(cli('list', 'x'), { code: 2, out: 'The list command takes no arguments' });
});

test('--devtools refuses the runs it can\'t serve', () => {
  assert.deepEqual(run(SCRIPT, '--devtools', '--launch'), { code: 2, out: 'The --devtools flag can\'t be used with --launch' });
  assert.deepEqual(run(SCRIPT, '--devtools', '--extension'), { code: 2, out: 'The --devtools flag can\'t be used with --extension' });
});

test('--help lists the commands a run takes too', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Commands in interactive shell and send:$/m);
  assert.match(r.stdout, /^ {4}click <selector> /m);
  assert.match(r.stdout, /^ {4}menu \[what\] /m);
});
