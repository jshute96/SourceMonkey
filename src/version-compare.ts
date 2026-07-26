// `@version` ordering.
//
// Userscript versions are not semver — managers accept whatever the
// author writes. Tampermonkey compares them as dot-separated segments
// with an optional `-prerelease` tail, and that's what we implement:
// enough structure to order the versions real scripts use, with a
// deterministic answer for the ones that don't fit.
//
// Pure module — no DOM, no chrome.*, no fetching. The only consumer
// that needs a verdict rather than an ordering is the UI, which uses
// `versionRelation`.

// Splits `1.2.3-beta.4` into `{ main: ['1','2','3'], pre: ['beta','4'] }`.
// Only the FIRST `-` starts the prerelease tail, so `1.0-rc-2` has a
// two-segment-free prerelease of `rc-2` rather than nesting further.
//
// A `+build` tail is dropped first, per semver: build metadata carries
// no precedence. Without this, `1.0+b2` vs `1.0` would compare its last
// main segment as `0+b2` vs `0` and report the metadata-only change as
// a newer version — a false OUTDATED.
function splitVersion(v: string): { main: string[]; pre: string[] } {
  const plus = v.indexOf('+');
  const trimmed = (plus < 0 ? v : v.slice(0, plus)).trim();
  const dash = trimmed.indexOf('-');
  const mainPart = dash < 0 ? trimmed : trimmed.slice(0, dash);
  const prePart = dash < 0 ? '' : trimmed.slice(dash + 1);
  return {
    main: mainPart.split('.'),
    pre: prePart ? prePart.split('.') : [],
  };
}

const NUMERIC_RE = /^\d+$/;

// Compare one segment pair. Numeric-vs-numeric compares as numbers so
// `10` beats `9`; anything else falls back to code-unit order, which
// happens to put digits below letters — the same direction semver
// specifies for a numeric-vs-alphanumeric identifier.
//
// A consequence worth knowing: `1.0-beta` sorts *below* `1.0` (the
// prerelease rule) but `1.0.beta` sorts *above* it (padded `'0'` vs
// `'b'` here). Both follow from the rules as stated; only the `-` form
// is a prerelease.
function compareSegment(a: string, b: string): -1 | 0 | 1 {
  if (NUMERIC_RE.test(a) && NUMERIC_RE.test(b)) {
    const x = Number(a);
    const y = Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Missing trailing segments read as `0`, so `1.2` and `1.2.0` are the
// same version. Authors bump `1.2` → `1.2.1` all the time and expect
// exactly that.
function compareMain(a: string[], b: string[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const cmp = compareSegment(a[i] ?? '0', b[i] ?? '0');
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// Prerelease tails follow semver's precedence rules: a release outranks
// any prerelease of the same main version (`1.0` > `1.0-rc1`), and
// between two prereleases the one that runs out of segments first is
// lower (`1.0-rc` < `1.0-rc.2`).
function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const sa = a[i];
    const sb = b[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const cmp = compareSegment(sa, sb);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// Total order over version strings. Always returns an ordering — there
// is no "incomparable" verdict, because every caller ultimately has to
// pick newer / older / same and a null would just push the arbitrary
// choice up a layer. An empty string sorts below every non-empty one.
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta || !tb) {
    if (ta === tb) return 0;
    return ta ? 1 : -1;
  }
  const va = splitVersion(ta);
  const vb = splitVersion(tb);
  const main = compareMain(va.main, vb.main);
  if (main !== 0) return main;
  return comparePre(va.pre, vb.pre);
}

// What the UI says about a version we found somewhere else, relative to
// the copy we're running. `unknown` covers "one side didn't declare a
// `@version`" — with nothing to compare, claiming "same" would be a
// lie and claiming "newer" would be worse.
export type VersionRelation = 'same' | 'newer' | 'older' | 'unknown';

export function versionRelation(
  loaded: string | undefined,
  other: string | undefined,
): VersionRelation {
  if (!loaded?.trim() || !other?.trim()) return 'unknown';
  const cmp = compareVersions(other, loaded);
  if (cmp > 0) return 'newer';
  if (cmp < 0) return 'older';
  return 'same';
}
