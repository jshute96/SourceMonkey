import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHeader } from '../../dist/userscript-header.js';
import {
  PROBE_MIN_INTERVAL_MS,
  outdatedProbe,
  probeLabel,
  probeTargets,
  probesAreFresh,
} from '../../dist/version-probe.js';

// Build a parsed header from `@tag value` lines, so each test names
// only the tags it cares about.
function header(...lines) {
  return parseHeader([
    '// ==UserScript==',
    '// @name        Probe Test',
    ...lines.map((l) => `// ${l}`),
    '// ==/UserScript==',
    '',
  ].join('\n'));
}

const OWN = 'https://example.com/scripts/thing.user.js';

test('probeTargets: nothing declared → nothing to probe', () => {
  assert.deepEqual(probeTargets(header('@version 1.0'), OWN), []);
  assert.deepEqual(probeTargets(null, OWN), []);
});

test('probeTargets: a URL we already load from is not a target', () => {
  // The GreasyFork shape: @downloadURL is exactly where we installed
  // from, so the only question left is the sibling .meta.js.
  const targets = probeTargets(
    header(`@downloadURL ${OWN}`, '@updateURL https://example.com/scripts/thing.meta.js'),
    OWN,
  );
  assert.deepEqual(targets, [
    { url: 'https://example.com/scripts/thing.meta.js', kinds: ['update'] },
  ]);
});

test('probeTargets: one URL named by both headers collapses to one target', () => {
  const url = 'https://elsewhere.example/thing.user.js';
  const targets = probeTargets(header(`@updateURL ${url}`, `@downloadURL ${url}`), OWN);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].kinds, ['update', 'download']);
  assert.equal(probeLabel(targets[0].kinds), 'update/download URL');
});

test('probeTargets: distinct update and download URLs are both probed', () => {
  const targets = probeTargets(
    header(
      '@updateURL https://a.example/thing.meta.js',
      '@downloadURL https://b.example/thing.user.js',
    ),
    OWN,
  );
  // `update` first so the rendered row order is stable.
  assert.deepEqual(targets.map((t) => t.kinds), [['update'], ['download']]);
  assert.deepEqual(
    targets.map((t) => t.url),
    ['https://a.example/thing.meta.js', 'https://b.example/thing.user.js'],
  );
});

test('probeTargets: only absolute http(s) URLs qualify', () => {
  // A file:// update URL would turn a header line into a host-file
  // read; a relative one has no meaning for a fixed upstream home.
  assert.deepEqual(probeTargets(header('@updateURL file:///etc/passwd'), OWN), []);
  assert.deepEqual(probeTargets(header('@updateURL ./thing.meta.js'), OWN), []);
  assert.deepEqual(probeTargets(header('@updateURL not a url'), OWN), []);
  assert.deepEqual(probeTargets(header('@updateURL '), OWN), []);
});

test('probeTargets: own-URL comparison is canonical, not literal', () => {
  // Same URL, differently spelled — the default port is dropped by URL
  // normalization, so this must not become a target.
  assert.deepEqual(
    probeTargets(header('@updateURL https://example.com:443/scripts/thing.user.js'), OWN),
    [],
  );
});

test('probeTargets: a local script pointing at a published home', () => {
  const targets = probeTargets(
    header('@downloadURL https://greasyfork.example/scripts/1/thing.user.js'),
    'file:///home/user/scripts/thing.user.js',
  );
  assert.deepEqual(targets, [
    { url: 'https://greasyfork.example/scripts/1/thing.user.js', kinds: ['download'] },
  ]);
});

// ---------- outdatedProbe ----------

const probe = (version, extra = {}) => ({
  kinds: ['update'], url: 'https://a.example/x.js', version, checkedAt: 0, ...extra,
});

test('outdatedProbe: only a strictly newer upstream counts', () => {
  assert.equal(outdatedProbe('1.0', [probe('1.0')]), null);
  assert.equal(outdatedProbe('1.1', [probe('1.0')]), null);
  assert.equal(outdatedProbe('1.0', [probe('1.1')])?.version, '1.1');
});

test('outdatedProbe: nothing to compare against is not outdated', () => {
  assert.equal(outdatedProbe(undefined, [probe('1.1')]), null);
  assert.equal(outdatedProbe('1.0', [probe(undefined, { error: 'could not fetch' })]), null);
  assert.equal(outdatedProbe('1.0', undefined), null);
  assert.equal(outdatedProbe('1.0', []), null);
});

test('outdatedProbe: disagreeing upstreams report the furthest ahead', () => {
  const chosen = outdatedProbe('1.0', [
    { kinds: ['update'], url: 'https://a.example/x', version: '1.1', checkedAt: 0 },
    { kinds: ['download'], url: 'https://b.example/x', version: '2.0', checkedAt: 0 },
  ]);
  assert.equal(chosen?.version, '2.0');
  assert.equal(chosen?.url, 'https://b.example/x');
});

// ---------- probesAreFresh ----------

const target = { url: 'https://a.example/x.js', kinds: ['update'] };

test('probesAreFresh: no targets is fresh only when nothing is stored', () => {
  assert.equal(probesAreFresh(undefined, [], 1000), true);
  assert.equal(probesAreFresh([], [], 1000), true);
  // A row left over from a header the script no longer declares has to
  // be cleared, so the set counts as stale.
  assert.equal(probesAreFresh([{ ...probe('1.0'), checkedAt: 1000 }], [], 1000), false);
});

test('probesAreFresh: a young probe for every target', () => {
  const probes = [{ ...probe('1.0'), url: target.url, checkedAt: 1000 }];
  assert.equal(probesAreFresh(probes, [target], 1000 + PROBE_MIN_INTERVAL_MS - 1), true);
  assert.equal(probesAreFresh(probes, [target], 1000 + PROBE_MIN_INTERVAL_MS), false);
});

test('probesAreFresh: an unprobed target makes the set stale', () => {
  // A newly-declared @updateURL should be checked on the next pass, not
  // in six hours, even though the existing rows are young.
  const probes = [{ ...probe('1.0'), url: target.url, checkedAt: 1000 }];
  const added = { url: 'https://b.example/y.js', kinds: ['download'] };
  assert.equal(probesAreFresh(probes, [target, added], 1000), false);
});

test('probesAreFresh: a target the script dropped makes the set stale', () => {
  // The partial case: one of two declared URLs goes away. The survivor's
  // row is young, but leaving the dead one in place would keep reporting
  // OUTDATED against a URL the script no longer names.
  const gone = { ...probe('9.0'), url: 'https://b.example/y.js', checkedAt: 1000 };
  const kept = { ...probe('1.0'), url: target.url, checkedAt: 1000 };
  assert.equal(probesAreFresh([kept, gone], [target], 1000), false);
  assert.equal(probesAreFresh([kept], [target], 1000), true);
});

test('probesAreFresh: a failed probe still counts as checked', () => {
  // Otherwise an unreachable host would be retried on every navigation.
  const probes = [
    { kinds: ['update'], url: target.url, error: 'could not fetch', checkedAt: 1000 },
  ];
  assert.equal(probesAreFresh(probes, [target], 2000), true);
});
