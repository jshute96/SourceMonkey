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
  // A list of only comments sends nothing.
  assert.deepEqual(cli('send', '# a comment\n\n'), { code: 2, out: 'The send command needs a command to send, or piped stdin, e.g. sm-dev send status' });
  assert.deepEqual(cli('send', 'tabs {{\n}}'), {
    code: 2, out: 'Line 1: Only the eval command takes a {{ block, so its lines up to }} are skipped. None of the commands were run.',
  });
  // Piped stdin, read once a run is found to send it to.
  assert.deepEqual(cli('send'), { code: 1, out: 'No sm-dev runs are active' });
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

function help(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('help for one command shows its entry and only its flags', () => {
  const match = help('help', 'match');
  assert.equal(match.code, 0);
  assert.match(match.out, /^Usage: sm-dev match <script> \[url\]\.\.\. \[options\]$/m);
  assert.match(match.out, /^ {2}--url URL /m);
  assert.match(match.out, /^ {2}--root DIR /m);
  assert.doesNotMatch(match.out, /--cdp|--watch|^ {2}run /m);
  // --help before or after the command asks the same.
  assert.equal(help('match', '--help').out, match.out);
  assert.equal(help('--help', 'match').out, match.out);
  // Even with a flag it would refuse.
  assert.equal(help('run', '--bogus', '--help').code, 0);
});

test('help covers a run\'s typed commands, and refuses unknown names', () => {
  const typed = help('help', 'status', 'scripts', 'get');
  assert.equal(typed.code, 0);
  assert.match(typed.out, /^Commands typed in sm-dev run, or sent with sm-dev send:$/m);
  // Two from one group share its heading.
  assert.equal(typed.out.match(/^ {2}Scripts:$/gm).length, 1);
  assert.match(typed.out, /^ {4}status \[what\] /m);
  assert.match(typed.out, /^ {4}get <key> /m);
  assert.doesNotMatch(typed.out, /menu \[what\]/);
  assert.deepEqual(help('help', 'nope'), { code: 2, out: 'nope is not a command. Type sm-dev --help to list them.\n' });
  // help is both, and shows both.
  const both = help('help', 'help').out;
  assert.match(both, /^Usage: sm-dev help \[command\]\.\.\.$/m);
  assert.match(both, /^ {4}help \[command\] {4}List these/m);
  // send's own --help, not one meant for the command sent.
  assert.match(help('send', '--help').out, /^Usage: sm-dev send /m);
});
