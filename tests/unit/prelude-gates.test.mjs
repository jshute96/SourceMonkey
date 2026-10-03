// The injected prelude's two gates: the `sm:check-pending` decision and
// the `@run-at` lifecycle wait. They are armed CONCURRENTLY and joined
// in `flushPending`, so the user body starts at
// `max(decision, run-at)` — see docs/injection.md#concurrent-gates.
//
// These run the REAL minified `WRAPPER_PRELUDE` inside a `node:vm`
// context with a hand-rolled DOM stub, which is what makes the join
// testable at all: the harness controls exactly when each gate settles,
// something an e2e test against a real page and a real service worker
// can only nudge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { WRAPPER_PRELUDE } from '../../dist/generated-wrappers.js';

const SCRIPT_ID = 'script-1';
const SOURCE_URL = 'sourcemonkey://SourceMonkey/Demo/demo.user.js';

// Minimal stand-in for the page globals the prelude touches. Only the
// members it actually reaches are present — anything it starts using
// will fail loudly here rather than silently no-op.
function makeEnv({ readyState = 'loading' } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const sent = [];
  let replyResolve;
  const reply = new Promise((res) => { replyResolve = res; });

  const add = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };

  const sandbox = {
    setTimeout,
    clearTimeout,
    console: { log() {}, info() {} },
    location: { href: 'https://example.com/page' },
    document: {
      readyState,
      body: null,
      documentElement: {},
      addEventListener: add(docListeners),
      removeEventListener() {},
    },
    chrome: {
      runtime: {
        // A real extension context — the prelude takes the direct
        // channel only when `id` is a string.
        id: 'abcdefghijklmnopabcdefghijklmnop',
        sendMessage(msg) {
          sent.push(msg);
          // Only the check-pending round-trip is answered late; the
          // one-way telemetry (sm:start, sm:swapped, …) resolves now.
          return msg && msg.type === 'sm:check-pending' ? reply : Promise.resolve();
        },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.window = {
    addEventListener: add(winListeners),
    removeEventListener() {},
    postMessage() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(WRAPPER_PRELUDE, sandbox);

  const fire = (map, type) => {
    for (const fn of map.get(type) ?? []) fn({ type });
  };

  return {
    sandbox,
    sent,
    // Settle the decision gate.
    decide(decision) { replyResolve(decision); },
    // Settle the @run-at gate for the non-start lifecycles.
    domContentLoaded() {
      sandbox.document.readyState = 'interactive';
      fire(docListeners, 'DOMContentLoaded');
    },
    // As in a browser: readyState turns 'complete', then `load` fires
    // in the same task.
    load() {
      sandbox.document.readyState = 'complete';
      fire(docListeners, 'readystatechange');
      fire(winListeners, 'load');
    },
    // A page that called `window.stop()`: readyState still turns
    // 'complete', but `load` never fires.
    stoppedComplete() {
      sandbox.document.readyState = 'complete';
      fire(docListeners, 'readystatechange');
    },
    sentTypes() { return sent.map((m) => m.type); },
  };
}

function makeCfg(runAt) {
  return {
    id: SCRIPT_ID,
    name: 'Demo',
    sourceUrl: SOURCE_URL,
    runAt,
    loadedAt: 1000,
    needsGmValues: false,
  };
}

// Register a script and queue its body, mirroring the js[] order a real
// injection uses (config blob → prelude → user program). Returns a
// `ran` box the test asserts on.
function install(env, runAt) {
  const ran = { count: 0 };
  env.sandbox.__smPrelude.init(makeCfg(runAt));
  env.sandbox.__smRun(SCRIPT_ID, () => { ran.count += 1; });
  return ran;
}

// The prelude settles both gates through promise callbacks, so let the
// microtask queue drain before asserting.
const settle = () => new Promise((res) => setTimeout(res, 0));

test('document-end: run-at first, then the decision', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-end');
  assert.equal(ran.count, 0, 'neither gate has settled');

  env.domContentLoaded();
  await settle();
  assert.equal(ran.count, 0, 'run-at alone must not start the body');

  env.decide({ action: 'run' });
  await settle();
  assert.equal(ran.count, 1, 'body starts once the decision joins');
  assert.ok(env.sentTypes().includes('sm:start'));
});

test('document-end: decision first, then run-at', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-end');

  env.decide({ action: 'run' });
  await settle();
  assert.equal(
    ran.count, 0,
    'the decision must not start a document-end body at document-start',
  );

  env.domContentLoaded();
  await settle();
  assert.equal(ran.count, 1);
});

test('document-start: the decision is the only gate', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-start');
  assert.equal(ran.count, 0, 'still gated on the decision');

  env.decide({ action: 'run' });
  await settle();
  assert.equal(ran.count, 1, 'no lifecycle wait to sit behind');
});

// The property that keeps the concurrent arming from ever being LATER
// than the old chained shape: a lifecycle gate whose event has already
// passed settles synchronously off `document.readyState`.
test('a run-at whose event already passed settles immediately', async () => {
  const env = makeEnv({ readyState: 'interactive' });
  const ran = install(env, 'document-end');

  env.decide({ action: 'run' });
  await settle();
  assert.equal(ran.count, 1);
});

// document-idle waits for `load` itself rather than inferring it from
// readyState. Arming at init is what makes that possible: readyState
// flips to 'complete' just BEFORE the load event, so a decision landing
// in that gap must not be read as "idle already happened".
test('document-idle waits for the load event, not just readyState', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-idle');

  env.domContentLoaded();
  env.sandbox.document.readyState = 'complete';
  env.decide({ action: 'run' });
  await settle();
  assert.equal(ran.count, 0, 'load has not fired yet');

  env.load();
  await settle();
  assert.equal(ran.count, 1);
});

// `window.stop()` cancels `load`; the 'complete' readystatechange is
// then the only sign of idle, and the body must still run, once.
test('document-idle runs on a stopped page, where load never fires', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-idle');
  env.decide({ action: 'run' });
  env.domContentLoaded();
  env.stoppedComplete();
  await settle();
  await settle();
  assert.equal(ran.count, 1);
});

test('document-idle runs once when both readystatechange and load fire', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-idle');
  env.decide({ action: 'run' });
  env.domContentLoaded();
  env.load();
  await settle();
  await settle();
  assert.equal(ran.count, 1);
});

test('skip drops a body the run-at gate already queued', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-end');

  env.domContentLoaded();
  await settle();
  env.decide({ action: 'skip', reason: 'removed' });
  await settle();

  assert.equal(ran.count, 0, 'a skipped script must never run');
  assert.ok(env.sentTypes().includes('sm:abandoned'));
  assert.ok(!env.sentTypes().includes('sm:start'));
});

test('run-new swaps the body, and not before the run-at gate', async () => {
  const env = makeEnv();
  const ran = install(env, 'document-end');

  env.decide({
    action: 'run-new',
    loadedAt: 2000,
    body: 'globalThis.__smSwapRan = true;',
  });
  await settle();
  assert.notEqual(env.sandbox.__smSwapRan, true, 'swap must wait for @run-at');

  env.domContentLoaded();
  await settle();
  assert.equal(env.sandbox.__smSwapRan, true, 'swapped body ran');
  assert.equal(ran.count, 0, 'the baked-in body is replaced, not also run');
  assert.ok(env.sentTypes().includes('sm:swapped'));
});
