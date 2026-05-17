// Tests for the rate-limit + concurrency gate in src/script-updater.ts.
// We cover the gate() helper directly so we don't have to stub the
// chrome.storage path the public updateScript / updateSource /
// updateAllSources wrappers go through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UPDATE_MIN_INTERVAL_MS,
  _setNowForTests,
  gate,
} from '../../dist/script-updater.js';

// Tiny helper: a Promise the test resolves manually so we can control
// when "the fetch finishes" without real I/O.
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function freezeTime(t = 1_000_000) {
  let current = t;
  _setNowForTests(() => current);
  return {
    advance(by) { current += by; },
    set(to) { current = to; },
  };
}

test('gate: manual call runs the task and records completion time', async () => {
  freezeTime(1000);
  const state = new Map();
  let calls = 0;
  const result = await gate(state, 'a', 'manual', async () => {
    calls++;
    return 'done';
  }, 'skipped');
  assert.equal(result, 'done');
  assert.equal(calls, 1);
  assert.equal(state.get('a').lastCompletedAt, 1000);
});

test('gate: opportunistic call within cooldown returns skipResult without running', async () => {
  const clock = freezeTime(1000);
  const state = new Map();
  await gate(state, 'a', 'manual', async () => 'first', 'skipped');
  clock.advance(UPDATE_MIN_INTERVAL_MS - 1);
  let ran = false;
  const result = await gate(state, 'a', 'opportunistic', async () => {
    ran = true;
    return 'second';
  }, 'skipped');
  assert.equal(ran, false);
  assert.equal(result, 'skipped');
});

test('gate: opportunistic call past cooldown runs the task', async () => {
  const clock = freezeTime(1000);
  const state = new Map();
  await gate(state, 'a', 'opportunistic', async () => 'first', 'skipped');
  clock.advance(UPDATE_MIN_INTERVAL_MS);
  const result = await gate(state, 'a', 'opportunistic', async () => 'second', 'skipped');
  assert.equal(result, 'second');
});

test('gate: manual call bypasses the opportunistic cooldown', async () => {
  const clock = freezeTime(1000);
  const state = new Map();
  await gate(state, 'a', 'manual', async () => 'first', 'skipped');
  clock.advance(100); // way less than cooldown
  let ran = false;
  const result = await gate(state, 'a', 'manual', async () => {
    ran = true;
    return 'second';
  }, 'skipped');
  assert.equal(ran, true);
  assert.equal(result, 'second');
});

test('gate: concurrent callers share the in-flight promise (single fetch)', async () => {
  freezeTime(1000);
  const state = new Map();
  const d = defer();
  let calls = 0;
  const task = async () => {
    calls++;
    return d.promise;
  };
  const p1 = gate(state, 'a', 'manual', task, 'skipped');
  const p2 = gate(state, 'a', 'manual', task, 'skipped');
  // A second opportunistic call should also coalesce, even if cooldown
  // would otherwise apply — there's nothing to rate-limit against, the
  // work is already in flight.
  const p3 = gate(state, 'a', 'opportunistic', task, 'skipped');
  d.resolve('shared');
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1, 'task should run exactly once');
  assert.equal(r1, 'shared');
  assert.equal(r2, 'shared');
  assert.equal(r3, 'shared');
});

test('gate: different keys run independently', async () => {
  freezeTime(1000);
  const state = new Map();
  const d1 = defer();
  const d2 = defer();
  let aCalls = 0;
  let bCalls = 0;
  const pA = gate(state, 'a', 'manual', async () => { aCalls++; return d1.promise; }, 'skipped');
  const pB = gate(state, 'b', 'manual', async () => { bCalls++; return d2.promise; }, 'skipped');
  d1.resolve('A');
  d2.resolve('B');
  assert.deepEqual(await Promise.all([pA, pB]), ['A', 'B']);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);
});

test('gate: failure in task clears in-flight so the next caller can retry', async () => {
  freezeTime(1000);
  const state = new Map();
  await assert.rejects(
    gate(state, 'a', 'manual', async () => { throw new Error('boom'); }, 'skipped'),
    /boom/,
  );
  // No in-flight left over.
  assert.equal(state.get('a').inFlight, undefined);
  // A second manual call still works.
  const result = await gate(state, 'a', 'manual', async () => 'ok', 'skipped');
  assert.equal(result, 'ok');
});
