// Unit tests for the run registry behind `sm-dev list`, `stop` and
// the commands sent to a run (src/harness/runs.ts, compiled to lib/harness/runs.js): a
// run's record and socket, a line's round trip, and stale records.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A directory of the tests' own, so real runs never see these records.
const RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-runs-test-'));
process.env.SM_DEV_RUNS_DIR = RUNS_DIR;
after(() => rmSync(RUNS_DIR, { recursive: true, force: true }));

const { RunControl, liveRuns, runIdOf, runTable, sendLine, stopRun } = await import('../../lib/harness/runs.js');

// A run's record; `open` takes one without an id, and picks the id.
function fields(overrides = {}) {
  return { pid: process.pid, started: Date.now(), browser: 'http://127.0.0.1:9233', scripts: ['a/b.user.js'], ...overrides };
}

// A made-up run, well past any id the tests' own runs take.
let fakeIds = 900;
function record(overrides = {}) {
  return { id: `D${fakeIds++}`, ...fields(), ...overrides };
}

// A process that stays up until signalled, standing in for a run.
async function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => child.on('spawn', r));
  return child;
}

test('a sent line reaches the run, and its output comes back', async () => {
  const seen = [];
  const control = await RunControl.open(fields(), async (line, reply) => {
    seen.push(line);
    reply(`one ${line}`);
    reply('two');
    return 'done';
  });
  try {
    assert.ok((await liveRuns()).some((r) => r.id === control.id));
    const out = [];
    await sendLine(control.id, 'status T2', (l) => out.push(l));
    assert.deepEqual(seen, ['status T2']);
    assert.deepEqual(out, ['one status T2', 'two']);
  } finally {
    await control.close();
  }
  assert.ok(!(await liveRuns()).some((r) => r.id === control.id));
});

test('a held line keeps receiving until the run closes', async () => {
  let reply;
  const control = await RunControl.open(fields(), async (_line, r) => {
    reply = r;
    r('stopping');
    return 'hold';
  });
  const out = [];
  const sent = sendLine(control.id, 'quit', (l) => out.push(l));
  while (!reply) await new Promise((r) => setTimeout(r, 10));
  reply('ended');
  await control.close();
  await sent;
  assert.deepEqual(out, ['stopping', 'ended']);
});

test('runs take the lowest free id, and a killed run\'s socket doesn\'t hold one', async () => {
  const handle = async () => 'done';
  const first = await RunControl.open(fields(), handle);
  const second = await RunControl.open(fields(), handle);
  try {
    assert.deepEqual([first.id, second.id], ['D1', 'D2']);
    await first.close();
    // A socket file nothing listens on, as a killed run leaves.
    const stale = net.createServer();
    await new Promise((r) => stale.listen(path.join(RUNS_DIR, 'D1.sock'), r));
    stale.close();
    await writeFile(path.join(RUNS_DIR, 'D1.sock'), '');
    const third = await RunControl.open(fields(), handle);
    assert.equal(third.id, 'D1');
    await third.close();
  } finally {
    await first.close().catch(() => undefined);
    await second.close();
  }
});

test('typed run ids', () => {
  assert.equal(runIdOf('D2'), 'D2');
  assert.equal(runIdOf('d02'), 'D2');
  assert.equal(runIdOf('2'), null);
  assert.equal(runIdOf('T2'), null);
  // Named by start --run: taken as typed, with a capital D.
  assert.equal(runIdOf('Dmain'), 'Dmain');
  assert.equal(runIdOf('Dmy-run_2'), 'Dmy-run_2');
  assert.equal(runIdOf('dmain'), null);
  assert.equal(runIdOf('D'), null);
  assert.equal(runIdOf('Da.b'), null);
});

test('a record whose process has gone is dropped', async () => {
  // A pid that has exited: a child that ran and was waited for.
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  const stale = record({ pid: child.pid });
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(path.join(RUNS_DIR, `${stale.id}.json`), JSON.stringify(stale));
  assert.ok(!(await liveRuns()).some((r) => r.id === stale.id));
  assert.ok(!(await readdir(RUNS_DIR)).includes(`${stale.id}.json`));
});

test('a record whose socket nothing listens on is gone, and its pid is never signalled', async () => {
  // A live process holding the dead run's pid, as after pid reuse.
  const child = await sleeper();
  try {
    const stale = record({ pid: child.pid });
    await writeFile(path.join(RUNS_DIR, `${stale.id}.json`), JSON.stringify(stale));
    assert.ok(!(await liveRuns()).some((r) => r.id === stale.id));
    const out = [];
    assert.equal(await stopRun(stale, (l) => out.push(l)), true);
    assert.deepEqual(out, [`[sm-dev] Run ${stale.id} had already ended`]);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.kill();
  }
});

test('stop falls back to SIGTERM for a run that drops the connection', async () => {
  const child = await sleeper();
  const target = record({ pid: child.pid });
  // Listening, as a stuck run's socket still would, but hanging up
  // without the answer a run gives `quit`.
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((r) => server.listen(path.join(RUNS_DIR, `${target.id}.sock`), r));
  try {
    const out = [];
    assert.equal(await stopRun(target, (l) => out.push(l)), true);
    assert.match(out[0], /did not answer, so it was sent SIGTERM, and has ended$/);
  } finally {
    server.close();
    child.kill();
  }
});

test('list prints a table', () => {
  const now = Date.now();
  const run = (overrides) => ({ ...fields({ started: now - 125_000 }), ...overrides });
  assert.deepEqual(runTable([
    run({ id: 'D1', pid: 42, scripts: ['sites/x/y.user.js', 'z.user.js'], tabs: 1 }),
    run({ id: 'D2', pid: 4567, scripts: ['a.user.js', 'b.user.js', 'c.user.js', 'd.user.js', 'e.user.js'], tabs: 3 }),
    // No tab count where the run keeps none (--extension).
    run({ id: 'D3', pid: 7, started: now - 3_725_000, browser: 'launched', scripts: [] }),
  ], now), [
    'Run  PID   Uptime  Browser         Tabs  Scripts',
    'D1   42    2m      127.0.0.1:9233  1     y.user.js, z.user.js',
    'D2   4567  2m      127.0.0.1:9233  3     a.user.js, b.user.js, c.user.js, (2 more)',
    'D3   7     1h02m   launched        -     -',
  ]);
});
