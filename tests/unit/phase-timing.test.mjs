// Tests for the debug-gated timers.
//
// This is diagnostic code, which is exactly why it needs pinning: it
// wraps `attachFiles`, `buildScriptFromText` and the dependency fetches,
// so anything it throws propagates out of `rebuildCollection` and fails
// the whole collection refresh. A measurement tool that can break the
// thing it measures — and only when someone has turned it on to
// diagnose a problem — is worse than no measurement at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startPhaseTimer,
  resetPhaseTotals,
  timePhase,
  reportPhaseTotals,
  storageSize,
} from '../../dist/phase-timing.js';
import { _setDebugLoggingForTests } from '../../dist/debug-log.js';

// The module logs through `console.log`; capture it rather than let it
// scribble over the test output, and so assertions can read what it said.
function capturingConsole(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original;
  }
}

test('a disabled timer is inert', () => {
  _setDebugLoggingForTests(false);
  const { lines } = capturingConsole(() => {
    const t = startPhaseTimer('nothing');
    t.mark('a');
    t.note('b');
    t.done();
  });
  assert.deepEqual(lines, []);
});

test('a disabled note never evaluates its thunk', () => {
  // The reason `note` accepts a function: the facts it reports can cost
  // real work to produce (walking every script to count probe targets),
  // and the disabled path must not pay for a line nobody prints.
  _setDebugLoggingForTests(false);
  let called = false;
  const t = startPhaseTimer('nothing');
  t.note(() => { called = true; return 'x'; });
  t.done();
  assert.equal(called, false);
});

test('an enabled note does evaluate its thunk', () => {
  _setDebugLoggingForTests(true);
  const { lines } = capturingConsole(() => {
    const t = startPhaseTimer('something');
    t.note(() => 'computed');
    t.done();
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /computed/);
});

test('timePhase is a pass-through when disabled', async () => {
  _setDebugLoggingForTests(false);
  resetPhaseTotals();
  assert.equal(await timePhase('x', async () => 'value'), 'value');
});

test('timePhase returns the wrapped value and records it', async () => {
  _setDebugLoggingForTests(true);
  resetPhaseTotals();
  assert.equal(await timePhase('work', async () => 'value'), 'value');
  const { lines } = capturingConsole(() => reportPhaseTotals('pass'));
  assert.match(lines[0], /work \d/);
});

test('timePhase records a throwing call and rethrows the original error', async () => {
  // Work that failed still cost what it cost, and the caller must see
  // its own error rather than anything the timer produced.
  _setDebugLoggingForTests(true);
  resetPhaseTotals();
  await assert.rejects(
    () => timePhase('boom', async () => { throw new Error('original'); }),
    /original/,
  );
  const { lines } = capturingConsole(() => reportPhaseTotals('pass'));
  assert.match(lines[0], /boom/);
});

test('a report from a concurrent pass cannot break an in-flight timePhase', async () => {
  // The regression this file exists for. `reportPhaseTotals` clears the
  // module-global accumulator, and two refreshes can overlap in one JS
  // context — `gate()` keys per collection, and Refresh All has its own
  // slot. If `timePhase` re-read the global in its `finally` instead of
  // capturing it, this would reject with a TypeError thrown out of the
  // finally, discarding a result the caller had already computed.
  _setDebugLoggingForTests(true);
  resetPhaseTotals();
  const slow = timePhase('slow', () => new Promise((r) => setTimeout(() => r('done'), 20)));
  capturingConsole(() => reportPhaseTotals('the other pass'));
  assert.equal(await slow, 'done');
});

test('a pass that recorded nothing does not leak into the next one', async () => {
  _setDebugLoggingForTests(true);
  resetPhaseTotals();
  capturingConsole(() => reportPhaseTotals('empty pass'));   // clears
  // No reset here: a stray sample now has nowhere to land, rather than
  // accumulating into a map the previous pass left open.
  await timePhase('stray', async () => 1);
  const { lines } = capturingConsole(() => reportPhaseTotals('later pass'));
  assert.deepEqual(lines, []);
});

test('a mark prints its detail beside the phase', () => {
  _setDebugLoggingForTests(true);
  const { lines } = capturingConsole(() => {
    const t = startPhaseTimer('enable');
    t.mark('read', '2 keys, 1.0 KB');
    t.mark('plan');
    t.mark('write', () => 'computed');
    t.done();
  });
  assert.match(lines[0], /read [\d.]+ \[2 keys, 1\.0 KB\], plan [\d.]+, write [\d.]+ \[computed\]/);
});

test('a disabled mark never evaluates its detail thunk', () => {
  _setDebugLoggingForTests(false);
  let called = false;
  const t = startPhaseTimer('nothing');
  t.mark('a', () => { called = true; return 'x'; });
  t.done();
  assert.equal(called, false);
});

test('time spent computing a detail is left out of the phases and the total', () => {
  // A size detail can mean serializing several MB; charging that to the
  // step being measured would make it look slower than it is.
  _setDebugLoggingForTests(true);
  const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
  const { lines } = capturingConsole(() => {
    const t = startPhaseTimer('slow detail');
    t.mark('read', () => { busy(50); return 'big'; });
    t.mark('next');
    t.done();
  });
  const total = Number(/total ([\d.]+)ms/.exec(lines[0])[1]);
  const next = Number(/next ([\d.]+)/.exec(lines[0])[1]);
  assert.ok(total < 25, lines[0]);
  assert.ok(next < 25, lines[0]);
});

test('storageSize counts keys and their JSON size', () => {
  assert.equal(storageSize({ a: 'x' }), '1 key, 9 B');
  assert.equal(storageSize({}), '0 keys, 2 B');
  assert.equal(storageSize({ a: 1, b: 2 }), '2 keys, 13 B');
});
