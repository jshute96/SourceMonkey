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
const RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'sm-test-runs-'));
process.env.SM_DEV_RUNS_DIR = RUNS_DIR;
after(() => rmSync(RUNS_DIR, { recursive: true, force: true }));

const { browserSentence, RunClient, RunControl, liveRuns, runIdOf, runTable, sendLine, stopRun } = await import('../../../lib/harness/runs.js');

// A run's handlers: `command` as given, and nothing to follow.
function handlers(command, follow = () => () => undefined) {
  return { command, follow };
}

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

test('a sent line reaches the run, and its output and exit code come back', async () => {
  const seen = [];
  const control = await RunControl.open(fields(), handlers(async (line, reply) => {
    seen.push(line);
    reply(`one ${line}`);
    reply('two');
    return line === 'fail' ? 3 : 0;
  }));
  try {
    assert.ok((await liveRuns()).some((r) => r.id === control.id));
    const out = [];
    assert.equal(await sendLine(control.id, 'menu T2', (l) => out.push(l)), 0);
    assert.deepEqual(seen, ['menu T2']);
    assert.deepEqual(out, ['one menu T2', 'two']);
    assert.equal(await sendLine(control.id, 'fail', () => undefined), 3);
  } finally {
    await control.close();
  }
  assert.ok(!(await liveRuns()).some((r) => r.id === control.id));
});

test('a held line keeps receiving until the run closes', async () => {
  let reply;
  const control = await RunControl.open(fields(), handlers(async (_line, r) => {
    reply = r;
    r('stopping');
    return 'hold';
  }));
  const out = [];
  const sent = sendLine(control.id, 'stop', (l) => out.push(l));
  while (!reply) await new Promise((r) => setTimeout(r, 10));
  reply('ended');
  await control.close();
  assert.equal(await sent, 0);
  assert.deepEqual(out, ['stopping', 'ended']);
});

test('one connection takes commands in turn; one that follows also gets what the run prints between them', async () => {
  const followers = new Set();
  const control = await RunControl.open(fields(), handlers(async (line, reply, sent) => {
    reply(`${line} ${sent.follows ? 'following' : 'not following'}`);
    return 0;
  }, (reply) => {
    followers.add(reply);
    return () => followers.delete(reply);
  }));
  try {
    const quiet = [];
    const plain = await RunClient.open(control.id, (l) => quiet.push(l));
    assert.equal(await plain.send('a'), 0);
    assert.equal(await plain.send('b'), 0);
    await plain.close();
    assert.deepEqual(quiet, ['a not following', 'b not following']);

    const seen = [];
    const following = await RunClient.open(control.id, (l) => seen.push(l), { follow: true });
    assert.equal(await following.send('c'), 0);
    for (const reply of followers) reply('printed meanwhile');
    assert.equal(await following.send('d'), 0);
    await following.close();
    assert.deepEqual(seen, ['c following', 'printed meanwhile', 'd following']);
    // Let go once it closed.
    while (followers.size > 0) await new Promise((r) => setTimeout(r, 10));
  } finally {
    await control.close();
  }
});

test('runs take the lowest free id, and a killed run\'s socket doesn\'t hold one', async () => {
  const handle = handlers(async () => 0);
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
    // No tab count where the run keeps none.
    run({ id: 'D3', pid: 7, started: now - 3_725_000, browser: 'http://127.0.0.1:41234', owned: true, headless: true, scripts: [] }),
    run({ id: 'D4', pid: 8, headless: true, scripts: [], manager: 'tampermonkey' }),
  ], now), [
    'Run  PID   Uptime  Browser                            Manager       Tabs  Scripts',
    'D1   42    2m      127.0.0.1:9233                     SourceMonkey  1     y.user.js, z.user.js',
    'D2   4567  2m      127.0.0.1:9233                     SourceMonkey  3     a.user.js, b.user.js, c.user.js, (2 more)',
    'D3   7     1h02m   127.0.0.1:41234 (owned, headless)  SourceMonkey  -     -',
    'D4   8     2m      127.0.0.1:9233 (headless)          Tampermonkey  -     -',
  ]);
});

test('status says the browser as a sentence', () => {
  assert.equal(browserSentence({ browser: 'http://127.0.0.1:9233' }), 'connected to browser 127.0.0.1:9233');
  assert.equal(browserSentence({ browser: 'http://127.0.0.1:41234', owned: true, headless: true }), 'connected to owned headless browser 127.0.0.1:41234');
});
