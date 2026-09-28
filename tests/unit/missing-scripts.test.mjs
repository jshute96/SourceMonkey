// Tests for src/missing-scripts.ts (compiled to dist/missing-scripts.js)
// and the `notePageReport` helper in src/tab-status.ts that feeds it:
// which expected scripts count as never started, and the Log warning
// each gets from what the document's other reports said.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cspBlocksPageScripts, describeMissingScript, findMissingScripts } from '../../dist/missing-scripts.js';
import { notePageReport } from '../../dist/tab-status.js';

const URL = 'https://example.com/a.png';

function script(id, world) {
  return { id, name: id, world, matching: { matches: [], includes: [], excludes: [] }, collectionId: 'c' };
}

function state(extra = {}) {
  return { documentId: 'd', url: URL, matches: [], actual: {}, ...extra };
}

test('findMissingScripts: expected scripts with no report', () => {
  const s = state({
    matches: [script('ran', 'MAIN'), script('missing', 'MAIN'), script('rejected', 'MAIN')],
    actual: { ran: { state: 'started', name: 'ran' } },
  });
  assert.deepEqual(findMissingScripts(s, new Set(['rejected'])).map((m) => m.id), ['missing']);
});

test('findMissingScripts: only scripts that matched at the first load', () => {
  // `later` matched only a pushState URL, or was installed after the
  // document committed: never injected, so not missing either.
  const s = state({ matches: [script('first', 'MAIN'), script('later', 'MAIN')], loadMatchIds: ['first'] });
  assert.deepEqual(findMissingScripts(s).map((m) => m.id), ['first']);
});

test('findMissingScripts: none on a document loaded with no userscripts', () => {
  const s = state({ matches: [script('a', 'MAIN')], scriptsSkipped: true });
  assert.deepEqual(findMissingScripts(s), []);
});

test('describeMissingScript: MAIN world on a page a wrapper saw as sandboxed', () => {
  const msg = describeMissingScript(script('a', 'MAIN'), state({ reportedWorlds: ['USER_SCRIPT'], opaqueOrigin: true }));
  assert.match(msg, /^Matched https:\/\/example\.com\/a\.png but never started there\. This page is sandboxed/);
  assert.match(msg, /Add @inject-into content .*\.$/);
});

test('describeMissingScript: file:// gets no hint, and its opaque origin is not a sandbox', () => {
  const msg = describeMissingScript(
    script('a', 'MAIN'),
    state({ url: 'file:///tmp/a.png', reportedWorlds: ['USER_SCRIPT'], opaqueOrigin: true }),
  );
  assert.equal(msg, 'Matched file:///tmp/a.png but never started there');
});

test('describeMissingScript: MAIN world with nothing reported gives the likely cause', () => {
  const msg = describeMissingScript(script('a', 'MAIN'), state());
  assert.match(msg, /The page may be blocking scripts in its own context\. Check its Content-Security-Policy header/);
  assert.match(msg, /If it has one, add @inject-into content/);
});

test('describeMissingScript: MAIN world where another MAIN-world script started', () => {
  const msg = describeMissingScript(script('a', 'MAIN'), state({ reportedWorlds: ['MAIN'], opaqueOrigin: true }));
  assert.match(msg, /Other scripts in the page's own context did start here/);
  assert.doesNotMatch(msg, /sandbox/);
});

test('describeMissingScript: USER_SCRIPT world', () => {
  assert.equal(
    describeMissingScript(script('a', 'USER_SCRIPT'), state()),
    `Matched ${URL} but never started there`,
  );
  assert.match(
    describeMissingScript(script('a', 'USER_SCRIPT'), state({ reportedWorlds: ['USER_SCRIPT'] })),
    /\. Other scripts in the isolated context did start here\.$/,
  );
});

test('cspBlocksPageScripts: a sandbox directive without allow-scripts, in any policy', () => {
  assert.equal(cspBlocksPageScripts('sandbox'), true);
  assert.equal(cspBlocksPageScripts("default-src 'none'; style-src 'unsafe-inline'; sandbox"), true);
  assert.equal(cspBlocksPageScripts('SANDBOX allow-popups'), true);
  assert.equal(cspBlocksPageScripts('sandbox allow-scripts allow-popups'), false);
  assert.equal(cspBlocksPageScripts("script-src 'self'"), false);
  // Two headers, comma-joined: either policy can sandbox.
  assert.equal(cspBlocksPageScripts("script-src 'self', sandbox"), true);
  assert.equal(cspBlocksPageScripts('sandbox allow-scripts, sandbox'), true);
});

test('notePageReport: records worlds and the opaque origin, identity when nothing is new', () => {
  const s0 = state();
  const s1 = notePageReport(s0, 'USER_SCRIPT', true);
  assert.deepEqual(s1.reportedWorlds, ['USER_SCRIPT']);
  assert.equal(s1.opaqueOrigin, true);
  assert.equal(notePageReport(s1, 'USER_SCRIPT', false), s1);
  assert.deepEqual(notePageReport(s1, 'MAIN', false).reportedWorlds, ['USER_SCRIPT', 'MAIN']);
  assert.equal(notePageReport(s0, 'MAIN', false).opaqueOrigin, undefined);
});
