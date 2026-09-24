// Unit tests for the flag checks in `sm-dev run` (src/harness/cli.ts,
// compiled to lib/harness/cli.js): combinations that would do nothing
// or stall are refused up front, before any browser is reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
