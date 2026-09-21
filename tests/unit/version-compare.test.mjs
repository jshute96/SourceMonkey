import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  isLocalEditVersion,
  localEditVersion,
  versionRelation,
} from '../../dist/version-compare.js';

// Helper so the assertions read as an ordering rather than as three
// separate -1/0/1 checks that could disagree with each other.
function assertOrder(lower, higher) {
  assert.equal(compareVersions(lower, higher), -1, `${lower} < ${higher}`);
  assert.equal(compareVersions(higher, lower), 1, `${higher} > ${lower}`);
}

test('compareVersions: equal forms', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  // Missing trailing segments read as 0 — authors bump 1.2 → 1.2.1 and
  // expect the two spellings of "1.2" to be the same version.
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0.0', '1.2'), 0);
  assert.equal(compareVersions(' 1.2.3 ', '1.2.3'), 0);
});

test('compareVersions: numeric segments compare as numbers', () => {
  assertOrder('1.9.0', '1.10.0');
  assertOrder('2.0', '10.0');
  // The bug a naive string compare would have: '9' > '10' lexically.
  assert.equal(compareVersions('1.9', '1.10'), -1);
});

test('compareVersions: ordinary bumps', () => {
  assertOrder('1.0.0', '1.0.1');
  assertOrder('1.0.9', '1.1.0');
  assertOrder('0.9.9', '1.0.0');
});

test('compareVersions: prerelease sorts below its release', () => {
  assertOrder('1.0-beta', '1.0');
  assertOrder('1.0-alpha', '1.0-beta');
  // A longer prerelease outranks the prefix it extends.
  assertOrder('1.0-rc', '1.0-rc.2');
  assertOrder('1.0-rc.1', '1.0-rc.2');
  assert.equal(compareVersions('1.0-rc.1', '1.0-rc.1'), 0);
});

test('compareVersions: non-numeric segments fall back to code-unit order', () => {
  assertOrder('1.0.a', '1.0.b');
  // Digits sort below letters, so a numeric segment stays below an
  // alphanumeric one at the same position.
  assertOrder('1.0.0', '1.0.a');
});

test('compareVersions: build metadata carries no precedence', () => {
  // semver rule. Without stripping `+…` the last main segment would
  // compare as '0+build2' vs '0' and report a metadata-only change as
  // a newer version — a false OUTDATED.
  assert.equal(compareVersions('1.0+build2', '1.0'), 0);
  assert.equal(compareVersions('1.0+a', '1.0+b'), 0);
  assertOrder('1.0+build9', '1.1+build1');
  // Stripped before the prerelease split, so both tails still apply.
  assertOrder('1.0-rc+build1', '1.0+build1');
});

test('compareVersions: empty sorts below anything', () => {
  assertOrder('', '0');
  assertOrder('', '1.0');
  assert.equal(compareVersions('', ''), 0);
  assert.equal(compareVersions('   ', ''), 0);
});

test('versionRelation: verdicts against the loaded copy', () => {
  assert.equal(versionRelation('1.0', '1.0'), 'same');
  assert.equal(versionRelation('1.0', '1.1'), 'newer');
  assert.equal(versionRelation('1.1', '1.0'), 'older');
  assert.equal(versionRelation('1.0', '1.0.0'), 'same');
});

test('versionRelation: a missing @version on either side is unknown', () => {
  // Claiming "same" here would be a lie and "newer" would be worse —
  // there is genuinely nothing to compare.
  assert.equal(versionRelation(undefined, '1.0'), 'unknown');
  assert.equal(versionRelation('1.0', undefined), 'unknown');
  assert.equal(versionRelation('', '1.0'), 'unknown');
  assert.equal(versionRelation('1.0', '  '), 'unknown');
});

test('localEditVersion: a plain -local append, recognised afterwards', () => {
  assert.equal(localEditVersion('13.2'), '13.2-local');
  assert.equal(localEditVersion(' 1.0-beta '), '1.0-beta-local');
  assert.ok(isLocalEditVersion('13.2-local'));
  assert.ok(isLocalEditVersion('13.2-local.2'));
  assert.ok(isLocalEditVersion('1.0-beta-local'));
  assert.ok(!isLocalEditVersion('13.2'));
  assert.ok(!isLocalEditVersion('1.0-beta'));
  assert.ok(!isLocalEditVersion('1.0-localhost'));
});

test('versionRelation: a -local edit of the probed version is edited, not newer', () => {
  // The prerelease rule alone would put 13.2 above 13.2-local and
  // report the copy outdated against the version it was copied from.
  assert.equal(versionRelation('13.2-local', '13.2'), 'edited');
  assert.equal(versionRelation('13.2-local', '13.2.0'), 'edited');
  assert.equal(versionRelation('1.0-beta-local', '1.0'), 'edited');
  // Upstream moved on: genuinely newer.
  assert.equal(versionRelation('13.2-local', '13.3'), 'newer');
  // The copy runs ahead of a prerelease source, the ordinary case.
  assert.equal(versionRelation('1.0-beta-local', '1.0-beta'), 'older');
  // A real prerelease whose release has shipped stays outdated.
  assert.equal(versionRelation('1.0-beta', '1.0'), 'newer');
});
