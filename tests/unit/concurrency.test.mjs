import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapWithConcurrency,
  FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
  FETCH_COLLECTIONS_CONCURRENCY,
  PROBE_SCRIPTS_CONCURRENCY,
  PROBE_URLS_PER_SCRIPT_CONCURRENCY,
} from '../../dist/extension/concurrency.js';

// Resolve-on-demand task: lets a test hold tasks open and observe how
// many the mapper started before any of them finished.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('returns results in input order, not completion order', async () => {
  const items = [30, 10, 20, 0];
  const out = await mapWithConcurrency(items, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ['0:30', '1:10', '2:20', '3:0']);
});

test('passes the index alongside the item', async () => {
  const seen = [];
  await mapWithConcurrency(['a', 'b', 'c'], 1, async (item, i) => {
    seen.push([item, i]);
    return item;
  });
  assert.deepEqual(seen, [['a', 0], ['b', 1], ['c', 2]]);
});

test('never runs more than `limit` tasks at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 4, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n % 5));
    running--;
    return n * 2;
  });
  assert.equal(peak, 4);
  assert.equal(out.length, 50);
  assert.equal(out[49], 98);
});

test('holds later items back until a slot frees', async () => {
  const gates = Array.from({ length: 5 }, () => deferred());
  const started = [];
  const all = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
    started.push(i);
    await gates[i].promise;
    return i;
  });
  // Let the workers reach their first await.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(started, [0, 1], 'only `limit` tasks start up front');

  gates[0].resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(started, [0, 1, 2], 'finishing one starts exactly one more');

  for (const g of gates) g.resolve();
  assert.deepEqual(await all, [0, 1, 2, 3, 4]);
});

test('an empty input does no work', async () => {
  let calls = 0;
  const out = await mapWithConcurrency([], 4, async () => { calls++; return 1; });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

// A non-positive limit would leave the worker pool with nothing to run,
// so it degrades to unbounded rather than hanging forever.
test('a limit at or above the item count, or non-positive, still runs everything', async () => {
  for (const limit of [3, 99, 0, -1]) {
    const out = await mapWithConcurrency([1, 2, 3], limit, async (n) => n * 10);
    assert.deepEqual(out, [10, 20, 30], `limit ${limit}`);
  }
});

test('the first rejection rejects the whole call', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});

// The pool keeps draining after the caller has been rejected.
// `refreshAllCollections` depends on this — one collection throwing must
// not stop its siblings from refreshing.
test('a rejection does not stop the remaining items from running', async () => {
  const ran = [];
  let settleLast;
  const allRan = new Promise((r) => { settleLast = r; });
  const p = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
    ran.push(n);
    if (ran.length === 6) settleLast();
    if (n === 1) throw new Error('boom');
    return n;
  });
  await assert.rejects(p, /boom/);
  await allRan;
  assert.deepEqual(ran.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

// The systemic case: every item fails, so there is no "surviving worker"
// to drain the list. A pool whose workers die on rejection would run
// only the first `limit` items and silently skip the tail — which is
// exactly what an out-of-quota storage write looks like, since it fails
// for every collection rather than one.
test('every item still runs when every item fails', async () => {
  const ran = [];
  let settleLast;
  const allRan = new Promise((r) => { settleLast = r; });
  const p = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
    ran.push(n);
    if (ran.length === 6) settleLast();
    throw new Error(`boom ${n}`);
  });
  // The FIRST failure is what surfaces, not a later one.
  await assert.rejects(p, /boom 0/);
  await allRan;
  assert.deepEqual(ran.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

// Rejecting only once the whole list had drained would make a failure
// cost as much wall time as a success — on a large collection, minutes.
test('the rejection surfaces before the rest of the list has drained', async () => {
  let releaseTail;
  const tail = new Promise((r) => { releaseTail = r; });
  let tailFinished = false;
  const p = mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
    if (n === 0) throw new Error('boom');
    await tail;
    tailFinished = true;
    return n;
  });
  await assert.rejects(p, /boom/);
  assert.equal(tailFinished, false, 'rejected while later items were still running');
  releaseTail();
});

// A second failure lands on a promise the pool is still holding, so it
// must not surface as an unhandled rejection.
test('a later failure after the call already rejected stays handled', async () => {
  const seen = [];
  process.on('unhandledRejection', (err) => { seen.push(err); });
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
      if (n % 2 === 1) throw new Error(`boom ${n}`);
      return n;
    }),
    /boom/,
  );
  // Let any unhandled rejection reach the process hook.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, []);
});

// Tripwires, not behavioral assertions. The refresh limits nest, so what
// caps in-flight fetches is their product, and 32 is the ceiling this
// design commits to — high enough to keep the pipes full, low enough
// that peak memory stays well clear of the out-of-memory abort an
// unbounded fan-out causes. Today's values sit exactly at it, which is
// the point: raising either constant has to be a deliberate act that
// reconsiders the ceiling.
test('the refresh limits are positive and bound their product', () => {
  assert.ok(FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY > 0);
  assert.ok(FETCH_COLLECTIONS_CONCURRENCY > 0);
  assert.ok(FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY * FETCH_COLLECTIONS_CONCURRENCY <= 32);
});

// The inner limit carries the balance deliberately: one collection is
// the common shape, and a per-collection Refresh never engages the outer
// limit at all. If these ever invert, the single-collection case — the
// one every user hits — got slower to speed up a rare one.
test('scripts-per-collection is the larger of the refresh pair', () => {
  assert.ok(FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY > FETCH_COLLECTIONS_CONCURRENCY);
});

// Probes have their own nested pair, and the outer half is sized for the
// callers that AWAIT the pass — a Refresh holds its spinner until the
// probes land, so this cap is wall-clock the user sees. It was tuned for
// the fire-and-forget per-script caller until measurement showed the
// collection paths paying for it.
//
// The bound worth asserting is the REALISTIC peak, not the product.
// `probeTargets` yields at most two URLs per script, so the per-script
// cap cannot bind today — it guards a future third target kind. Policing
// the product would police a number no run can reach, and would block a
// change to the guard that has no effect on anything in flight.
test('the probe limits are positive and bound their realistic peak', () => {
  const MAX_TARGETS_PER_SCRIPT = 2; // @updateURL + @downloadURL, deduped by URL
  assert.ok(PROBE_SCRIPTS_CONCURRENCY > 0);
  assert.ok(PROBE_URLS_PER_SCRIPT_CONCURRENCY > 0);
  assert.ok(PROBE_SCRIPTS_CONCURRENCY * MAX_TARGETS_PER_SCRIPT <= 24);
  // The guard has to stay a guard: drop it below the real target count
  // and it starts binding, silently serializing each script's probes.
  assert.ok(PROBE_URLS_PER_SCRIPT_CONCURRENCY >= MAX_TARGETS_PER_SCRIPT);
});
