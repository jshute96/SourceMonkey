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
import { SM_DEV_MARKERS } from '../../dist/sm-dev-protocol.js';

const SCRIPT_ID = 'script-1';
const SOURCE_URL = 'sourcemonkey://SourceMonkey/Demo/demo.user.js';

// Minimal stand-in for the page globals the prelude touches. Only the
// members it actually reaches are present — anything it starts using
// will fail loudly here rather than silently no-op.
//
// `firstLoad`: a top frame on a navigation that isn't a reload, where a
// `document-start` wrapper may run without asking. `markers`: the event
// types sm-dev's markers cancel (`SM_DEV_MARKERS`). `pageWorld`: no
// chrome.runtime, so traffic goes over the bridge's DOM event, which
// a stub bridge takes once `bridgeIn()` is called.
function makeEnv({ readyState = 'loading', firstLoad = false, markers = [], pageWorld = false } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const sent = [];
  const infos = [];
  let replyResolve;
  let replyReject;
  const reply = new Promise((res, rej) => { replyResolve = res; replyReject = rej; });
  // The decision's timeout, held for the test to fire.
  let decisionTimeout = null;

  const add = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };

  const sandbox = {
    setTimeout: (fn, ms) => {
      if (ms !== sandbox.__smPrelude?.decisionTimeoutMs) return setTimeout(fn, ms);
      decisionTimeout = fn;
      return -1;
    },
    clearTimeout: (id) => {
      if (id === -1) decisionTimeout = null;
      else clearTimeout(id);
    },
    console: { log() {}, info(...args) { infos.push(args.join(' ')); } },
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
  if (firstLoad) {
    sandbox.window.top = sandbox.window;
    sandbox.performance = { getEntriesByType: () => [{ type: 'navigate' }] };
    sandbox.CustomEvent = class {
      constructor(type) { this.type = type; this.defaultPrevented = false; }
    };
    sandbox.window.dispatchEvent = (ev) => {
      if (markers.includes(ev.type)) ev.defaultPrevented = true;
      return !ev.defaultPrevented;
    };
  }
  // What the stub bridge took, as {requestId, payload}.
  const taken = [];
  let bridgeIn = false;
  if (pageWorld) {
    delete sandbox.chrome;
    sandbox.CustomEvent = class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
        this.cancelable = !!init.cancelable;
        this.defaultPrevented = false;
      }
    };
    sandbox.document.dispatchEvent = (ev) => {
      if (ev.type !== 'sourcemonkey-bridge-sync' || !bridgeIn) return true;
      assert.equal(ev.cancelable, true);
      taken.push(JSON.parse(ev.detail));
      return false;
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(WRAPPER_PRELUDE, sandbox);

  const fire = (map, type) => {
    for (const fn of map.get(type) ?? []) fn({ type });
  };

  return {
    sandbox,
    sent,
    infos,
    // Settle the decision gate.
    decide(decision) { replyResolve(decision); },
    // The SW call fails.
    failCall(err) { replyReject(err); },
    // The decision's timeout runs out, if it's still armed.
    timeOut() { decisionTimeout?.(); },
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
    taken,
    takenTypes() { return taken.map((t) => t.payload.type); },
    bridgeIn() { bridgeIn = true; },
    // The bridge's ready event; the page can fire one too.
    ready() { fire(winListeners, 'sourcemonkey-bridge-ready'); },
    // The bridge's reply to a request it took.
    reply(requestId, reply) {
      for (const fn of winListeners.get('message') ?? []) {
        fn({ source: sandbox.window, data: { __sm: 'sourcemonkey-bridge-reply', requestId, reply } });
      }
    },
  };
}

function makeCfg(runAt, extra) {
  return {
    ...extra,
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
function install(env, runAt, extra = {}) {
  const ran = { count: 0 };
  env.sandbox.__smPrelude.init(makeCfg(runAt, extra));
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

// A `document-start` wrapper runs without asking only where the answer
// can only be `run` (`canSkipDecision`); in a browser sm-dev is
// connected to, that takes its tab vouching for the script's run.
for (const [label, markers, extra, asks] of [
  ['no sm-dev: runs at once', [], {}, false],
  ['sm-dev connected: asks', [SM_DEV_MARKERS.present], {}, true],
  ['sm-dev connected, a claimed tab: asks', [SM_DEV_MARKERS.present, `${SM_DEV_MARKERS.vouchPrefix}R1`], {}, true],
  ['a run\'s script, its run\'s tab: runs at once', [SM_DEV_MARKERS.present, `${SM_DEV_MARKERS.vouchPrefix}R1`], { run: 'R1' }, false],
  ['a run\'s script, another run\'s tab: asks', [SM_DEV_MARKERS.present, `${SM_DEV_MARKERS.vouchPrefix}R2`], { run: 'R1' }, true],
  ['a run\'s script, no sm-dev: asks', [], { run: 'R1' }, true],
]) {
  test(`document-start markers: ${label}`, async () => {
    const env = makeEnv({ firstLoad: true, markers });
    const ran = install(env, 'document-start', extra);
    await settle();
    assert.equal(env.sentTypes().includes('sm:check-pending'), asks);
    assert.equal(ran.count, asks ? 0 : 1);
  });
}

// The GM runtime is its own registration and can come after the
// wrapper. A script that needs it asks rather than run without it.
for (const [label, runtimeIn, asks] of [
  ['needs the GM runtime, not in yet: asks', false, true],
  ['needs the GM runtime, already in: runs at once', true, false],
]) {
  test(`document-start: ${label}`, async () => {
    const env = makeEnv({ firstLoad: true });
    if (runtimeIn) env.sandbox.window.__SM_GM__ = {};
    const ran = install(env, 'document-start', { needsGmRuntime: true });
    await settle();
    assert.equal(env.sentTypes().includes('sm:check-pending'), asks);
    assert.equal(ran.count, asks ? 0 : 1);
  });
}

// In the page world, traffic goes over the bridge, which Chrome can
// inject after the wrapper. What it didn't take (it cancels the event
// as a receipt) is held and sent when it announces itself.
test('page world: a start sent before the bridge is in goes out when it is', async () => {
  const env = makeEnv({ firstLoad: true, pageWorld: true });
  const ran = install(env, 'document-start');
  await settle();
  assert.equal(ran.count, 1, 'ran without asking');
  assert.deepEqual(env.takenTypes(), []);

  // A ready event with still no bridge (the page can fire one).
  env.ready();
  assert.deepEqual(env.takenTypes(), []);

  env.bridgeIn();
  env.ready();
  assert.deepEqual(env.takenTypes(), ['sm:start']);
  env.ready();
  assert.deepEqual(env.takenTypes(), ['sm:start'], 'sent once');
});

test('page world: a held check-pending is answered once the bridge is in', async () => {
  const env = makeEnv({ pageWorld: true });
  const ran = install(env, 'document-end');
  env.bridgeIn();
  env.ready();
  assert.deepEqual(env.takenTypes(), ['sm:check-pending']);
  env.reply(env.taken[0].requestId, { action: 'run' });
  env.domContentLoaded();
  await settle();
  assert.equal(ran.count, 1);
});

// One that timed out isn't sent: nobody reads the answer, and the SW
// could use up a reload's hot swap on it. What the wrapper reports
// about not running still goes.
test('page world: a check-pending that timed out is not sent later', async () => {
  const env = makeEnv({ pageWorld: true });
  const ran = install(env, 'document-end');
  env.timeOut();
  env.bridgeIn();
  env.ready();
  assert.deepEqual(env.takenTypes(), ['sm:abandoned']);
  env.domContentLoaded();
  await settle();
  assert.equal(ran.count, 0);
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

// With no decision the script does NOT run: the decision is what keeps
// it out of an sm-dev run's tabs and honours a skip. It says why, in the
// page's console and in its report to the SW.
for (const [what, cause, detail] of [
  ['no answer in time', (env) => env.timeOut(), /did not answer whether to run it within 10 seconds/],
  // Chrome's own messages end in a period, which isn't doubled.
  ['a failed call', (env) => env.failCall(new Error('Receiving end does not exist.')), /Asking SourceMonkey whether to run it failed: Receiving end does not exist/],
  ['an unreadable answer', (env) => env.decide(undefined), /answer whether to run it was unreadable/],
  ['the bridge\'s failure', (env) => env.decide({ bridgeError: 'Asking SourceMonkey failed: gone' }), /Asking SourceMonkey failed: gone/],
]) {
  test(`no decision (${what}): the script doesn't run, and says why`, async () => {
    const env = makeEnv({ readyState: 'complete' });
    const ran = install(env, 'document-idle');
    cause(env);
    await settle();
    assert.equal(ran.count, 0);
    const abandoned = env.sent.find((m) => m.type === 'sm:abandoned');
    assert.equal(abandoned?.reason, 'no-decision');
    assert.match(abandoned.detail, detail);
    assert.ok(env.infos.some((line) => /Demo: It did not run\. .*[^.]\.$/.test(line)), env.infos.join('\n'));
  });
}
