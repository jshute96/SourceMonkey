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

// ---------- replayStartupLogsAtBoot ----------
//
// Boot-replay exists because chrome.storage.session (where the Log
// tab lives) is wiped on Chrome shutdown, while the script's
// startupLogs are persisted on the StoredScript in chrome.storage.local.
// On a fresh Chrome session the Log tab is empty even though the
// diagnostics still apply — boot-replay refills it once per session,
// gated by a session-storage sentinel so SW restarts within a session
// don't duplicate rows.

const localStore = new Map();
const sessionStore = new Map();
// `?? globalThis.chrome` so this file is safe if node:test ever runs
// these tests in the same context as another file that already
// installed a chrome stub.
globalThis.chrome = globalThis.chrome ?? {
  storage: {
    local: {
      get: async (key) => {
        if (key === null || key === undefined) {
          return Object.fromEntries(localStore);
        }
        if (typeof key === 'string') {
          return localStore.has(key) ? { [key]: localStore.get(key) } : {};
        }
        return {};
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); },
    },
    session: {
      get: async (key) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
      remove: async (key) => { sessionStore.delete(key); },
    },
  },
};

const { replayStartupLogsAtBoot } = await import('../../dist/script-updater.js');
const { getScriptLog, _flushScriptLogQueueForTests } = await import('../../dist/script-log.js');

function seedScript({ scriptId, sourceId = 'src-x', startupLogs }) {
  // replayStartupLogsAtBoot reads via getAllScripts (one storage.local
  // .get(null) scan filtered to `script:` keys), so we only need the
  // script row — no source row, no `sources` index.
  const script = {
    id: scriptId, sourceId, relativePath: 'a.user.js', fileUrl: 'file:///a.user.js',
    status: 'ok', size: 10, headerText: '', bodyText: '',
    header: { tags: [{ tag: 'name', value: 'X' }] },
    matching: { matches: ['https://e/*'], excludes: [], includes: [] },
    loadedAt: 0, enabled: true,
  };
  if (startupLogs) script.startupLogs = startupLogs;
  localStore.set(`script:${scriptId}`, script);
}

// Set up state shared between the basic boot-replay assertions.
// Each test calls this so the assertions don't depend on the previous
// test's leftover sessionStore / localStore contents.
async function seedSingleScriptThenReplay(scriptId = 'sc-1') {
  localStore.clear();
  sessionStore.clear();
  seedScript({
    scriptId,
    startupLogs: [{ level: 'warn', message: 'unknown @grant entries dropped: GM_audio' }],
  });
  await replayStartupLogsAtBoot();
  await _flushScriptLogQueueForTests(scriptId);
}

test('replayStartupLogsAtBoot: emits one Log entry per script.startupLogs entry on first call', async () => {
  await seedSingleScriptThenReplay();
  const log = await getScriptLog('sc-1');
  assert.equal(log.length, 1);
  assert.equal(log[0].level, 'warning');
  assert.equal(log[0].source, 'parser');
  assert.match(log[0].message, /GM_audio/);
});

test('replayStartupLogsAtBoot: idempotent within a session — second call adds nothing', async () => {
  await seedSingleScriptThenReplay();
  const before = await getScriptLog('sc-1');
  // Sentinel is now set, so a second call should bail immediately
  // and not append duplicate rows.
  await replayStartupLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-1');
  const after = await getScriptLog('sc-1');
  assert.equal(after.length, before.length);
});

test('replayStartupLogsAtBoot: re-fires after a fresh-Chrome-session reset (session storage cleared)', async () => {
  await seedSingleScriptThenReplay();
  // Real Chrome shutdown clears `chrome.storage.session` — both the
  // sentinel and the log entries — so the next session's replay
  // should walk the persisted scripts and refill the log.
  sessionStore.clear();
  await replayStartupLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-1');
  const log = await getScriptLog('sc-1');
  assert.equal(log.length, 1);
  assert.match(log[0].message, /GM_audio/);
});

test('replayStartupLogsAtBoot: skips diagnostics already present in the log (cold-boot race protection)', async () => {
  // Simulate the cold-boot scenario where a refresh wrote the parser
  // row first: the script's log already has it. Replay must NOT
  // duplicate.
  localStore.clear();
  sessionStore.clear();
  seedScript({
    scriptId: 'sc-race',
    startupLogs: [{ level: 'warn', message: 'unknown @grant entries dropped: GM_audio' }],
  });
  // Pre-seed the log with what a refresh path would have written.
  await (await import('../../dist/script-log.js')).appendScriptLog('sc-race', {
    level: 'warning',
    source: 'parser',
    message: 'unknown @grant entries dropped: GM_audio',
  });
  await replayStartupLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-race');
  const log = await getScriptLog('sc-race');
  assert.equal(log.length, 1, 'replay must not duplicate the pre-existing parser row');
});

test('replayStartupLogsAtBoot: scripts without startupLogs contribute nothing', async () => {
  localStore.clear();
  sessionStore.clear();
  seedScript({ sourceId: 'src-2', scriptId: 'sc-2' /* no startupLogs */ });
  await replayStartupLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-2');
  const log = await getScriptLog('sc-2');
  assert.equal(log.length, 0);
});

test('replayStartupLogsAtBoot: walks across multiple sources', async () => {
  localStore.clear();
  sessionStore.clear();
  seedScript({
    sourceId: 'src-A', scriptId: 'sc-A',
    startupLogs: [{ level: 'warn', message: 'msg A' }],
  });
  seedScript({
    sourceId: 'src-B', scriptId: 'sc-B',
    startupLogs: [{ level: 'error', message: 'msg B' }],
  });
  await replayStartupLogsAtBoot();
  await Promise.all(['sc-A', 'sc-B'].map(_flushScriptLogQueueForTests));
  const logA = await getScriptLog('sc-A');
  const logB = await getScriptLog('sc-B');
  assert.equal(logA.length, 1);
  assert.equal(logA[0].message, 'msg A');
  assert.equal(logB.length, 1);
  assert.equal(logB[0].level, 'error');
  assert.equal(logB[0].message, 'msg B');
});
