// Tests for the rate-limit + concurrency gate in src/extension/script-updater.ts.
// We cover the gate() helper directly so we don't have to stub the
// chrome.storage path the public updateScript / updateCollection /
// updateAllCollections wrappers go through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UPDATE_MIN_INTERVAL_MS,
  _setNowForTests,
  gate,
} from '../../dist/extension/script-updater.js';

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

test('gate: an own call waits for the running check, then runs, and later callers join it', async () => {
  freezeTime(1000);
  const state = new Map();
  const first = defer();
  const second = defer();
  let calls = 0;
  const p1 = gate(state, 'a', 'manual', async () => { calls++; return first.promise; }, 'skipped');
  const p2 = gate(state, 'a', 'manual', async () => { calls++; return second.promise; }, 'skipped', 'a', true);
  const p3 = gate(state, 'a', 'opportunistic', async () => { calls++; return 'unused'; }, 'skipped');
  first.resolve('first');
  assert.equal(await p1, 'first');
  second.resolve('own');
  assert.equal(await p2, 'own', 'its own run, not the running one');
  assert.equal(await p3, 'own', 'joined the own run');
  assert.equal(calls, 2);
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

// ---------- replayScriptLogsAtBoot ----------
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
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (localStore.has(k)) out[k] = localStore.get(k);
        return out;
      },
      getKeys: async () => [...localStore.keys()],
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); },
    },
    session: {
      // Mirrors the real API's key shapes: null → everything, a string
      // → that one key, an array → each present key. The log store
      // reads `[log:<id>, loglevel:<id>]` in one call, so the array
      // form is load-bearing here, not just completeness.
      get: async (key) => {
        if (key === null || key === undefined) return Object.fromEntries(sessionStore);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (sessionStore.has(k)) out[k] = sessionStore.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
      remove: async (key) => {
        for (const k of (Array.isArray(key) ? key : [key])) sessionStore.delete(k);
      },
    },
  },
};

const {
  replayScriptLogsAtBoot,
  emitScriptOutcomeLog,
  summarizeCollectionOutcome,
} = await import('../../dist/extension/script-updater.js');
const {
  appendScriptLog,
  clearScriptLog,
  getMaxLogLevel,
  getScriptLog,
  _flushScriptLogQueueForTests,
} = await import('../../dist/extension/script-log.js');

function seedScript({ scriptId, collectionId = 'src-x', startupLogs, ...overrides }) {
  // replayScriptLogsAtBoot reads via getAllScripts (one storage.local
  // .get(null) scan filtered to `script:` keys), so we only need the
  // script row — no collection row, no `collections` index.
  const script = {
    id: scriptId, collectionId, relativePath: 'a.user.js', fileUrl: 'file:///a.user.js',
    status: 'ok', size: 10, headerText: '', bodyText: '',
    header: { tags: [{ tag: 'name', value: 'X' }] },
    matching: { matches: ['https://e/*'], excludes: [], includes: [] },
    loadedAt: 0, enabled: true,
  };
  if (startupLogs) script.startupLogs = startupLogs;
  Object.assign(script, overrides);
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
    startupLogs: [{ level: 'warn', message: 'Ignoring unsupported @grant GM_audio' }],
  });
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests(scriptId);
}

test('replayScriptLogsAtBoot: emits one Log entry per script.startupLogs entry on first call', async () => {
  await seedSingleScriptThenReplay();
  const log = await getScriptLog('sc-1');
  assert.equal(log.length, 1);
  assert.equal(log[0].level, 'warning');
  assert.equal(log[0].source, 'parser');
  assert.match(log[0].message, /GM_audio/);
});

test('replayScriptLogsAtBoot: idempotent within a session — second call adds nothing', async () => {
  await seedSingleScriptThenReplay();
  const before = await getScriptLog('sc-1');
  // Sentinel is now set, so a second call should bail immediately
  // and not append duplicate rows.
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-1');
  const after = await getScriptLog('sc-1');
  assert.equal(after.length, before.length);
});

test('replayScriptLogsAtBoot: re-fires after a fresh-Chrome-session reset (session storage cleared)', async () => {
  await seedSingleScriptThenReplay();
  // Real Chrome shutdown clears `chrome.storage.session` — both the
  // sentinel and the log entries — so the next session's replay
  // should walk the persisted scripts and refill the log.
  sessionStore.clear();
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-1');
  const log = await getScriptLog('sc-1');
  assert.equal(log.length, 1);
  assert.match(log[0].message, /GM_audio/);
});

test('replayScriptLogsAtBoot: replays diagnostics even if a refresh got there first', async () => {
  // Cold-boot race: a refresh wrote the parser row before the replay
  // ran, so the replay states it again. A duplicate row costs the user
  // a glance; the `source` column tells the two apart.
  localStore.clear();
  sessionStore.clear();
  seedScript({
    scriptId: 'sc-race',
    startupLogs: [{ level: 'warn', message: 'Ignoring unsupported @grant GM_audio' }],
  });
  // Pre-seed the log with what a refresh path would have written.
  await (await import('../../dist/extension/script-log.js')).appendScriptLog('sc-race', {
    level: 'warning',
    source: 'parser',
    message: 'Ignoring unsupported @grant GM_audio',
  });
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-race');
  const log = await getScriptLog('sc-race');
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((e) => e.source), ['parser', 'parser']);
});

test('replayScriptLogsAtBoot: scripts without startupLogs contribute nothing', async () => {
  localStore.clear();
  sessionStore.clear();
  seedScript({ collectionId: 'src-2', scriptId: 'sc-2' /* no startupLogs */ });
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-2');
  const log = await getScriptLog('sc-2');
  assert.equal(log.length, 0);
});

test('replayScriptLogsAtBoot: walks across multiple collections', async () => {
  localStore.clear();
  sessionStore.clear();
  seedScript({
    collectionId: 'src-A', scriptId: 'sc-A',
    startupLogs: [{ level: 'warn', message: 'msg A' }],
  });
  seedScript({
    collectionId: 'src-B', scriptId: 'sc-B',
    startupLogs: [{ level: 'error', message: 'msg B' }],
  });
  await replayScriptLogsAtBoot();
  await Promise.all(['sc-A', 'sc-B'].map(_flushScriptLogQueueForTests));
  const logA = await getScriptLog('sc-A');
  const logB = await getScriptLog('sc-B');
  assert.equal(logA.length, 1);
  assert.equal(logA[0].message, 'msg A');
  assert.equal(logB.length, 1);
  assert.equal(logB[0].level, 'error');
  assert.equal(logB[0].message, 'msg B');
});

test('replayScriptLogsAtBoot: restates a still-broken row so the Log matches the badge', async () => {
  // The refresh paths only log on a state *change*, so a script that
  // was already invalid before the Chrome restart would show INVALID
  // over an empty Log (session storage, and the log with it, is wiped
  // on shutdown; storage.local keeps the row).
  localStore.clear();
  sessionStore.clear();
  seedScript({ scriptId: 'sc-broken', status: 'invalid', errorMessage: 'missing @name' });
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-broken');
  const log = await getScriptLog('sc-broken');
  assert.equal(log.length, 1);
  assert.equal(log[0].level, 'error');
  assert.equal(log[0].source, 'extension-startup');
  assert.equal(log[0].message, 'missing @name');
});

test('replayScriptLogsAtBoot: restates a stale refresh at warning level', async () => {
  localStore.clear();
  sessionStore.clear();
  seedScript({ scriptId: 'sc-stale', status: 'ok', refreshError: 'HTTP 503' });
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-stale');
  const log = await getScriptLog('sc-stale');
  assert.equal(log.length, 1);
  assert.equal(log[0].level, 'warning');
  assert.equal(log[0].message, 'Refresh failed: HTTP 503');
});

test('replayScriptLogsAtBoot: restates a load error even if a refresh already logged it', async () => {
  localStore.clear();
  sessionStore.clear();
  seedScript({ scriptId: 'sc-dup', status: 'invalid', errorMessage: 'missing @name' });
  await appendScriptLog('sc-dup', {
    level: 'error', source: 'manual-refresh', message: 'missing @name',
  });
  await replayScriptLogsAtBoot();
  await _flushScriptLogQueueForTests('sc-dup');
  const log = await getScriptLog('sc-dup');
  // The `source` column is what tells the two apart, which is why it
  // names who produced the row rather than which internal emitted it.
  assert.deepEqual(log.map((e) => e.source), ['manual-refresh', 'extension-startup']);
});

// ---------- emitScriptOutcomeLog: every surfaced failure lands in the Log ----------
//
// The pane / status column and the Log tab must tell the same story:
// anything that puts a red or amber badge on a row also explains
// itself in that row's Log.

const OK_ROW = {
  id: 'x', collectionId: 's', relativePath: 'a.user.js', fileUrl: 'file:///a.user.js',
  status: 'ok', size: 10, headerText: '', bodyText: '', header: null,
  matching: { matches: [], excludes: [], includes: [] }, loadedAt: 100, enabled: true,
};

// Emit one or more outcomes and return the resulting log. Each call
// uses a fresh script ID so tests don't have to unpick each other's
// entries.
let outcomeSeq = 0;
async function emitFull(steps, mode = 'manual') {
  const id = `oc-${++outcomeSeq}`;
  sessionStore.clear();
  for (const [prior, next] of steps) emitScriptOutcomeLog(id, prior, next, mode);
  await _flushScriptLogQueueForTests(id);
  return await getScriptLog(id);
}

// Same, minus the `Checking for updates` preamble a reportable check
// writes ahead of its outcome. Most tests here are about WHAT gets
// reported; the framing itself has its own block below.
async function emitAll(steps, mode = 'manual') {
  const log = await emitFull(steps, mode);
  return log.filter((e) => e.message !== 'Checking for updates');
}

test('emitScriptOutcomeLog: an invalid row logs its errorMessage at error level', async () => {
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  const log = await emitAll([[OK_ROW, bad]]);
  assert.equal(log.length, 1);
  assert.equal(log[0].level, 'error');
  assert.equal(log[0].source, 'manual-refresh');
  assert.equal(log[0].message, 'no metadata block');
});

test('emitScriptOutcomeLog: a repeated identical failure is logged every check', async () => {
  // Each check re-fetches and re-validates (an `invalid` row can't take
  // the size+mtime skip), so every one of them is a fresh verdict on a
  // fresh read.
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  const log = await emitAll([[OK_ROW, bad], [bad, bad], [bad, bad]]);
  assert.equal(log.length, 3, 'every check that starts must report an outcome');
  assert.deepEqual(
    log.map((e) => e.message),
    ['no metadata block', 'no metadata block', 'no metadata block'],
  );
});

// ---------- how a check frames itself ----------
//
// An uneventful check is ONE row naming both the check and its result.
// A check with something to report writes `Checking for updates` and
// then the outcome, which carries its own severity and is what the
// status badge links to.

async function framing(prior, next, mode = 'manual') {
  return (await emitFull([[prior, next]], mode)).map((e) => e.message);
}

test('framing: an uneventful check is a single self-describing row', async () => {
  assert.deepEqual(await framing(OK_ROW, OK_ROW), ['Checked for updates and found no change']);
});

test('framing: an uneventful background check says nothing at all', async () => {
  // Nothing happened and nobody asked, so there is no row to frame.
  assert.deepEqual(await framing(OK_ROW, OK_ROW, 'opportunistic'), []);
});

test('framing: a failing check is announced, then reported', async () => {
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  assert.deepEqual(
    await framing(OK_ROW, bad),
    ['Checking for updates', 'no metadata block'],
  );
});

test('framing: a still-failing check is announced again', async () => {
  // The prior was already broken, which is the case that forces a real
  // refetch + revalidate — so this check had something to do.
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  assert.deepEqual(
    await framing(bad, bad),
    ['Checking for updates', 'no metadata block'],
  );
});

test('framing: a recovery is announced, then reported', async () => {
  const stale = { ...OK_ROW, refreshError: 'HTTP 404' };
  assert.deepEqual(
    await framing(stale, OK_ROW),
    ['Checking for updates', 'Refresh succeeded again (collection is reachable)'],
  );
});

test('framing: new content is announced, then reported', async () => {
  const fresh = { ...OK_ROW, loadedAt: OK_ROW.loadedAt + 1 };
  const log = await framing(OK_ROW, fresh);
  assert.equal(log[0], 'Checking for updates');
  assert.match(log[1], /^Loaded new content/);
});

test('emitScriptOutcomeLog: a manual no-change check restates parse-time diagnostics', async () => {
  // A parse-time warning is a property of the installed content, not an
  // event: it stays true until the content changes. Logging it only on
  // the refresh that first loaded the content left a misconfigured
  // script with no Log line at all once that row scrolled away, was
  // cleared, or the session it was written in ended — while the page
  // console kept reporting the problem on every run.
  const warned = {
    ...OK_ROW,
    startupLogs: [{ level: 'warn', message: 'unsafeWindow cannot reach the page' }],
  };
  const log = await emitAll([[warned, warned]]);
  assert.deepEqual(log.map((e) => e.message), [
    'Checked for updates and found no change',
    'unsafeWindow cannot reach the page',
  ]);
  assert.equal(log[1].level, 'warning');
  assert.equal(log[1].source, 'parser');
});

test('emitScriptOutcomeLog: a background no-change check restates nothing', async () => {
  // Same rule as the "no change" line it follows: nobody asked.
  const warned = {
    ...OK_ROW,
    startupLogs: [{ level: 'warn', message: 'unsafeWindow cannot reach the page' }],
  };
  assert.deepEqual(await emitAll([[warned, warned]], 'auto'), []);
});

test('emitScriptOutcomeLog: new content states its diagnostics once, not twice', async () => {
  // The changed-content branch replays them and returns, so the
  // no-change restate above can't also fire for the same check.
  const warned = {
    ...OK_ROW,
    loadedAt: OK_ROW.loadedAt + 1,
    startupLogs: [{ level: 'warn', message: 'unsafeWindow cannot reach the page' }],
  };
  const log = await emitAll([[OK_ROW, warned]]);
  assert.equal(log.filter((e) => e.message === 'unsafeWindow cannot reach the page').length, 1);
});

test('emitScriptOutcomeLog: a still-failing check reports, like a healthy one does', async () => {
  // Both rows are unchanged since the prior check, so both must say so.
  // A broken script going quieter than a healthy one is the failure
  // mode this guards.
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  const healthy = await emitAll([[OK_ROW, OK_ROW]]);
  const broken = await emitAll([[bad, bad]]);
  assert.equal(healthy.length, 1);
  assert.equal(healthy[0].message, 'Checked for updates and found no change');
  assert.equal(broken.length, 1, 'a broken script must not go quiet');
  assert.equal(broken[0].message, 'no metadata block');
});

test('emitScriptOutcomeLog: a changed failure reason does append', async () => {
  const badA = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  const badB = { ...OK_ROW, status: 'invalid', errorMessage: 'missing @name' };
  const log = await emitAll([[OK_ROW, badA], [badA, badB]]);
  assert.deepEqual(log.map((e) => e.message), ['no metadata block', 'missing @name']);
});

test('emitScriptOutcomeLog: a refresh failure is a warning, on every check', async () => {
  // status stays 'ok': the cached copy is still injected, only the
  // update failed. The badge already reads REFRESH FAILED, which
  // outranks any log-derived level, so this can't double-count.
  const stale = { ...OK_ROW, refreshError: 'HTTP 404' };
  const log = await emitAll([[OK_ROW, stale], [stale, stale]]);
  assert.equal(log.length, 2, 'a source that is still down still says so');
  for (const entry of log) {
    assert.equal(entry.level, 'warning');
    assert.equal(entry.message, 'Refresh failed: HTTP 404');
  }
});

test('emitScriptOutcomeLog: a recovered refresh logs an info entry', async () => {
  const stale = { ...OK_ROW, refreshError: 'HTTP 404' };
  const recovered = { ...OK_ROW, loadedAt: 200 };
  const log = await emitAll([[OK_ROW, stale], [stale, recovered]]);
  assert.equal(log.length, 3);
  assert.equal(log[1].level, 'info');
  assert.match(log[1].message, /Refresh succeeded again/);
  assert.match(log[2].message, /Loaded new content/);
});

test('emitScriptOutcomeLog: recovery from invalid is logged even when the bytes are unchanged', async () => {
  // A dependency-fetch failure can clear without the script body
  // changing, so loadedAt doesn't move and there is no "loaded new
  // content" row to explain the badge going back to OK. The recovery
  // IS the outcome here, so no contradictory "no change" follows it.
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'require fetch failed' };
  const log = await emitAll([[OK_ROW, bad], [bad, OK_ROW]]);
  assert.equal(log.length, 2);
  assert.equal(log[1].level, 'info');
  assert.match(log[1].message, /Loads cleanly again/);
});

test('emitScriptOutcomeLog: a broken row with no prior still logs', async () => {
  // A file that first appears already broken during a collection refresh
  // has no prior row to diff against.
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'missing @name' };
  const log = await emitAll([[undefined, bad]]);
  assert.equal(log.length, 1);
  assert.equal(log[0].message, 'missing @name');
});

test('emitScriptOutcomeLog: a row that vanished mid-refresh writes nothing', async () => {
  // Its Log went with the row; an entry here would be an orphan.
  const log = await emitAll([[OK_ROW, null]]);
  assert.equal(log.length, 0);
});

test('emitScriptOutcomeLog: a cleared log gets its explanation back on the next check', async () => {
  // LOG_CAP rotation and the Log tab's Clear button both remove the
  // entry while the stored row keeps its badge, so the next check has
  // to put the reason back.
  const id = 'oc-cleared';
  sessionStore.clear();
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  emitScriptOutcomeLog(id, OK_ROW, bad, 'manual');
  await _flushScriptLogQueueForTests(id);

  await clearScriptLog(id);
  emitScriptOutcomeLog(id, bad, bad, 'manual');
  await _flushScriptLogQueueForTests(id);
  const after = (await getScriptLog(id)).map((e) => e.message);
  assert.deepEqual(
    after,
    ['Checking for updates', 'no metadata block'],
    'the reason must come back after the log lost it',
  );
});

test('emitScriptOutcomeLog: fail → recover → fail again tells the whole story', async () => {
  const stale = { ...OK_ROW, refreshError: 'HTTP 404' };
  const good = { ...OK_ROW, loadedAt: 200 };
  const log = await emitAll([[OK_ROW, stale], [stale, good], [good, stale]]);
  assert.deepEqual(log.map((e) => e.level), ['warning', 'info', 'info', 'warning']);
  assert.equal(log[3].message, 'Refresh failed: HTTP 404');
});

test('emitScriptOutcomeLog: opportunistic checks log failures but not "no change"', async () => {
  const bad = { ...OK_ROW, status: 'invalid', errorMessage: 'no metadata block' };
  const failed = await emitAll([[OK_ROW, bad]], 'opportunistic');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].source, 'background-refresh');
  const quiet = await emitAll([[OK_ROW, OK_ROW]], 'opportunistic');
  assert.equal(quiet.length, 0, 'background polling must not add a row per navigation');
});

// ---------- summarizeCollectionOutcome: scan failures ----------

const COLLECTION_OK = { id: 's', path: '/tmp/x', lastRefreshedAt: 0, scriptIds: ['a'], enabled: true };

async function summarize(priorCollection, priorScripts, next, mode = 'manual') {
  sessionStore.clear();
  const prior = priorCollection
    ? { collection: priorCollection, scripts: new Map(priorScripts.map((s) => [s.id, s])) }
    : undefined;
  const realLog = console.log;
  console.log = () => {};
  try {
    summarizeCollectionOutcome('label', prior, next, mode);
  } finally {
    console.log = realLog;
  }
  await Promise.all(next.scripts.map((s) => _flushScriptLogQueueForTests(s.id)));
  return await Promise.all(next.scripts.map((s) => getScriptLog(s.id)));
}

test('summarizeCollectionOutcome: a scan failure lands in every script log, not "no change"', async () => {
  // refreshCollection leaves every script row untouched when the listing
  // can't be read, so the per-script loop would otherwise report "no
  // change" for rows that were never actually checked.
  const script = { ...OK_ROW, id: 'sa' };
  const failed = { collection: { ...COLLECTION_OK, scanError: 'ENOENT' }, scripts: [script] };
  const [log] = await summarize(COLLECTION_OK, [script], failed);
  assert.equal(log.length, 1);
  assert.match(log[0].message, /This collection did not load: ENOENT/);
});

test('summarizeCollectionOutcome: a scan failure stays at info so it cannot badge every script', async () => {
  // The `loglevel:` sentinel is for what the script itself did, and
  // sticks until the log is cleared or new content loads — so a warning
  // here would leave every script under the collection reading WARNING
  // after one transient blip. The collection row is where a
  // collection-level problem gets its badge.
  const script = { ...OK_ROW, id: 'sa-level' };
  const failed = { collection: { ...COLLECTION_OK, scanError: 'ENOENT' }, scripts: [script] };
  const [log] = await summarize(COLLECTION_OK, [script], failed);
  assert.equal(log[0].level, 'info');
  assert.equal(await getMaxLogLevel('sa-level'), 'info');
});

test('summarizeCollectionOutcome: a collection that stays unreadable re-logs per pass', async () => {
  const script = { ...OK_ROW, id: 'sb' };
  const brokenCollection = { ...COLLECTION_OK, scanError: 'ENOENT' };
  const [first] = await summarize(COLLECTION_OK, [script], { collection: brokenCollection, scripts: [script] });
  assert.equal(first.length, 1);
  // Each pass really did try to read the collection, and this path is only
  // reachable from a Refresh / Refresh All click, so every repeat is
  // one the user asked for.
  summarizeCollectionOutcome(
    'label',
    { collection: brokenCollection, scripts: new Map([[script.id, script]]) },
    { collection: brokenCollection, scripts: [script] },
    'manual',
  );
  await _flushScriptLogQueueForTests(script.id);
  assert.equal((await getScriptLog(script.id)).length, 2);
});

test('summarizeCollectionOutcome: a readable-again collection logs the recovery', async () => {
  const script = { ...OK_ROW, id: 'sc' };
  const [log] = await summarize(
    { ...COLLECTION_OK, scanError: 'ENOENT' },
    [script],
    { collection: COLLECTION_OK, scripts: [script] },
  );
  assert.deepEqual(log.map((e) => e.message), [
    'This collection is readable again',
    'Checked for updates and found no change',
  ]);
  assert.equal(log[0].level, 'info');
});

test('summarizeCollectionOutcome: a broad refresh frames each script for itself', async () => {
  // One Refresh All, two scripts, two different framings — the routine
  // one costs a single row, the one with news gets its preamble.
  const healthy = { ...OK_ROW, id: 'sd-ok' };
  const broken = {
    ...OK_ROW, id: 'sd-bad', status: 'invalid', errorMessage: 'no metadata block',
  };
  const [healthyLog, brokenLog] = await summarize(
    COLLECTION_OK,
    [healthy, broken],
    { collection: COLLECTION_OK, scripts: [healthy, broken] },
  );
  assert.deepEqual(healthyLog.map((e) => e.message), ['Checked for updates and found no change']);
  assert.deepEqual(
    brokenLog.map((e) => e.message),
    ['Checking for updates', 'no metadata block'],
  );
});
