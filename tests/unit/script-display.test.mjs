// Tests for src/script-display.ts (compiled to dist/script-display.js).
//
// Pure display helpers shared by the collections page + userscript viewer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeForDisplay,
  displayLocation,
  effectiveScriptStatus,
  formatBytes,
  formatScriptSize,
  formatScriptStatusLabel,
  leafName,
  logIdDupeSuffix,
  scriptBasename,
  scriptDisplayName,
  scriptOutdatedProbe,
  stripSriFragment,
} from '../../dist/script-display.js';

// ---------- formatBytes ----------

test('formatBytes: bytes under 1 KB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes: kilobytes 1 KB through < 1 MB, one decimal', () => {
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1024.0 KB');
});

test('formatBytes: megabytes >= 1 MB, one decimal', () => {
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 + 512 * 1024), '2.5 MB');
});

// ---------- formatScriptSize ----------

test('formatScriptSize: missing status shows the cached content size', () => {
  // The file is gone but we still hold its last-read bytes; reflect
  // that in the size column. The Status cell (separately) shows MISSING.
  assert.equal(formatScriptSize({ status: 'missing', size: 100 }), '100 B');
});

test('formatScriptSize: null size → "—" (unknown)', () => {
  // Only buildInitialErrorEntry produces size=null — the first fetch
  // failed with no prior content to fall back on. Render an em dash
  // rather than "0 B" (wrong) or "MISSING" (conflates with the missing
  // status).
  assert.equal(formatScriptSize({ status: 'invalid', size: null }), '—');
  assert.equal(formatScriptSize({ status: 'missing', size: null }), '—');
});

test('formatScriptSize: ok status renders the byte count', () => {
  assert.equal(formatScriptSize({ status: 'ok', size: 1234 }), '1.2 KB');
});

test('formatScriptSize: zero-byte file renders "0 B", not MISSING', () => {
  // An empty file is a real (if degenerate) file — it parses to a
  // header-less error, but the size cell should show "0 B" so the
  // user can see it's not missing.
  assert.equal(formatScriptSize({ status: 'invalid', size: 0 }), '0 B');
  assert.equal(formatScriptSize({ status: 'ok', size: 0 }), '0 B');
});

test('formatScriptSize: error with known size still renders the bytes', () => {
  // Errored fetches preserve the prior size; show it so the user can
  // see the row didn't vanish.
  assert.equal(formatScriptSize({ status: 'invalid', size: 500 }), '500 B');
});

// ---------- formatScriptStatusLabel ----------

test('formatScriptStatusLabel: distinct labels per display status', () => {
  // OK is the calm state; INVALID and MISSING are the persisted load
  // failures; REFRESH FAILED means the script still runs from its cached
  // copy but the last update attempt failed; WARNING and ERROR come from
  // the per-script Log carrying entries at that level.
  assert.equal(formatScriptStatusLabel('ok'), 'OK');
  assert.equal(formatScriptStatusLabel('invalid'), 'INVALID');
  assert.equal(formatScriptStatusLabel('missing'), 'MISSING');
  assert.equal(formatScriptStatusLabel('refresh-failed'), 'REFRESH FAILED');
  // OUTDATED: the script runs and is current with its own collection, but a
  // URL we deliberately don't update from declares a newer @version.
  assert.equal(formatScriptStatusLabel('outdated'), 'OUTDATED');
  assert.equal(formatScriptStatusLabel('warning'), 'WARNING');
  assert.equal(formatScriptStatusLabel('error'), 'ERROR');
});

// ---------- effectiveScriptStatus ----------

test('effectiveScriptStatus: invalid always wins', () => {
  // INVALID is the most-actionable surface: the script literally
  // can't run, so we don't surface log-derived levels alongside it.
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, undefined), 'invalid');
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, 'info'), 'invalid');
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, 'warning'), 'invalid');
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, 'error'), 'invalid');
});

test('effectiveScriptStatus: missing wins over log-derived levels', () => {
  assert.equal(effectiveScriptStatus({ status: 'missing' }, undefined), 'missing');
  assert.equal(effectiveScriptStatus({ status: 'missing' }, 'warning'), 'missing');
  assert.equal(effectiveScriptStatus({ status: 'missing' }, 'error'), 'missing');
});

test('effectiveScriptStatus: ok script reflects highest log level', () => {
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined), 'ok');
  // info collapses to OK (we still track it internally, but the Status
  // column only ramps when there's something actionable).
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'info'), 'ok');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'warning'), 'warning');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'error'), 'error');
});

test('effectiveScriptStatus: refreshError surfaces as refresh-failed', () => {
  // A row that's still `ok` (running from its cached copy) but carries a
  // refreshError shows REFRESH FAILED. It ranks above the log-derived
  // levels — the staleness is a distinct, specific signal — but below
  // invalid/missing, which mean the script can't run at all.
  assert.equal(
    effectiveScriptStatus({ status: 'ok', refreshError: 'permission denied' }, undefined),
    'refresh-failed',
  );
  assert.equal(
    effectiveScriptStatus({ status: 'ok', refreshError: 'permission denied' }, 'error'),
    'refresh-failed',
  );
  // invalid / missing still win — the script genuinely can't run.
  assert.equal(
    effectiveScriptStatus({ status: 'invalid', refreshError: 'x' }, undefined),
    'invalid',
  );
  assert.equal(
    effectiveScriptStatus({ status: 'missing', refreshError: 'x' }, undefined),
    'missing',
  );
});

test('effectiveScriptStatus: outdated ranks under refresh-failed, over log levels', () => {
  // OUTDATED is an update-pipeline fact with no other surface in the
  // collections list, so it outranks the log-derived levels — but a collection
  // we can't reach at all subsumes "some other copy is ahead".
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined, true), 'outdated');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'error', true), 'outdated');
  assert.equal(
    effectiveScriptStatus({ status: 'ok', refreshError: 'x' }, undefined, true),
    'refresh-failed',
  );
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, undefined, true), 'invalid');
  // Defaults to false, so every existing caller keeps its behavior.
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined), 'ok');
});

test('effectiveScriptStatus: a rejected registration ranks just under invalid', () => {
  // REJECTED means the script loaded fine but Chrome refused to
  // register it, so it never runs — a can't-run state like INVALID,
  // and above MISSING (which still injects its cached copy).
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined, false, true), 'rejected');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'error', false, true), 'rejected');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined, true, true), 'rejected');
  assert.equal(
    effectiveScriptStatus({ status: 'ok', refreshError: 'x' }, undefined, false, true),
    'rejected',
  );
  assert.equal(effectiveScriptStatus({ status: 'missing' }, undefined, false, true), 'rejected');
  // INVALID still wins. The two can't co-occur in practice — an invalid
  // script is never offered to Chrome — but the order is defined.
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, undefined, false, true), 'invalid');
  // Defaults to false, so every existing caller keeps its behavior.
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined, false), 'ok');
});

test('formatScriptStatusLabel: every display status has a label', () => {
  assert.equal(formatScriptStatusLabel('rejected'), 'REJECTED');
  assert.equal(formatScriptStatusLabel('invalid'), 'INVALID');
  assert.equal(formatScriptStatusLabel('refresh-failed'), 'REFRESH FAILED');
});

// ---------- scriptOutdatedProbe ----------

function headerWithVersion(version) {
  return { tags: [{ tag: 'version', value: version }] };
}

const upstream = (version) => ({
  kinds: ['update'], url: 'https://a.example/x.meta.js', version, checkedAt: 0,
});

test('scriptOutdatedProbe: reports the probe that is ahead of us', () => {
  assert.equal(
    scriptOutdatedProbe({ header: headerWithVersion('1.0'), versionProbes: [upstream('2.0')] })
      ?.version,
    '2.0',
  );
  assert.equal(
    scriptOutdatedProbe({ header: headerWithVersion('2.0'), versionProbes: [upstream('1.0')] }),
    null,
  );
});

test('scriptOutdatedProbe: an unversioned or unprobed script is never outdated', () => {
  assert.equal(scriptOutdatedProbe({ header: null, versionProbes: [upstream('2.0')] }), null);
  assert.equal(scriptOutdatedProbe({ header: headerWithVersion('1.0') }), null);
});

// ---------- names and paths ----------

test('decodeForDisplay: percent escapes become the characters they encode', () => {
  assert.equal(decodeForDisplay('My%20Script.user.js'), 'My Script.user.js');
  assert.equal(decodeForDisplay('YouTube%E2%84%A2'), 'YouTube™');
});

test('decodeForDisplay: a malformed escape leaves the string intact', () => {
  // A literal `%` in a name makes decodeURIComponent throw. Showing
  // `100% free.user.js` with one stray escape beats showing nothing.
  assert.equal(decodeForDisplay('100% free.user.js'), '100% free.user.js');
  assert.equal(decodeForDisplay('%'), '%');
});

test('leafName: last slash-separated segment', () => {
  assert.equal(leafName('sites/example.com/foo.user.js'), 'foo.user.js');
  assert.equal(leafName('foo.user.js'), 'foo.user.js');
  assert.equal(leafName('a/b/.foo.user.js'), '.foo.user.js');
});

test('displayLocation: decodes URLs', () => {
  assert.equal(
    displayLocation('https://update.greasyfork.org/scripts/1/My%20Script.user.js'),
    'https://update.greasyfork.org/scripts/1/My Script.user.js',
  );
  assert.equal(displayLocation('file:///home/me/a%20b.user.js'), 'file:///home/me/a b.user.js');
});

test('displayLocation: leaves non-URL paths alone', () => {
  // An on-disk name is literal — a directory really called `a%20b`
  // must not be shown (or later searched for) as `a b`.
  assert.equal(displayLocation('a%20b/foo.user.js'), 'a%20b/foo.user.js');
  assert.equal(displayLocation('/home/me/100%25.user.js'), '/home/me/100%25.user.js');
});

test('scriptBasename: URL filename, decoded, without the query string', () => {
  assert.equal(
    scriptBasename('https://update.greasyfork.org/scripts/1/My%20Script.user.js?version=9'),
    'My Script.user.js',
  );
});

test('scriptBasename: on-disk relative path keeps its literal segment', () => {
  assert.equal(scriptBasename('sites/example.com/foo.user.js'), 'foo.user.js');
  assert.equal(scriptBasename('a%20b.user.js'), 'a%20b.user.js');
});

test('scriptBasename: falls back to the whole input when there is no filename', () => {
  assert.equal(scriptBasename('https://example.com/'), 'https://example.com/');
  assert.equal(scriptBasename('https://example.com'), 'https://example.com');
});

test('scriptDisplayName: prefers @name, falls back to the readable location', () => {
  const header = { tags: [{ tag: 'name', value: 'Nice Name' }] };
  assert.equal(
    scriptDisplayName({ header, relativePath: 'https://x/y%20z.user.js' }),
    'Nice Name',
  );
  assert.equal(
    scriptDisplayName({ relativePath: 'https://x/y%20z.user.js' }),
    'https://x/y z.user.js',
  );
});

test('scriptBasename: an escaped slash cannot smuggle a path separator in', () => {
  // `%2F` decodes to a real `/`. This value becomes a log ID, so a
  // "basename" carrying a separator would read as a directory in every
  // log line.
  assert.equal(scriptBasename('https://x.com/a%2Fb.user.js'), 'b.user.js');
});

test('logIdDupeSuffix: only a trailing #<digits> counts', () => {
  assert.equal(logIdDupeSuffix('foo.user.js#2'), '#2');
  assert.equal(logIdDupeSuffix('foo.user.js#12'), '#12');
  assert.equal(logIdDupeSuffix('foo.user.js'), '');
  assert.equal(logIdDupeSuffix(''), '');
  // A literal `#` in the name (a decoded `%23`) is not a dupe suffix —
  // splitting on the first `#` would render half the name as one.
  assert.equal(logIdDupeSuffix('Chapter #2 notes.user.js'), '');
  assert.equal(logIdDupeSuffix('Chapter #2 notes.user.js#3'), '#3');
});

// ---------- stripSriFragment ----------
//
// Display-only: a 64-hex-digit tail is most of the width of a tooltip
// or a details row and tells the reader nothing they can act on. The
// fetch / dedup / error-message paths keep the verbatim ref.

test('stripSriFragment: drops a single hash fragment', () => {
  assert.equal(
    stripSriFragment('https://example.com/lib.js#md5=c45f9b0d19ba69bb2d44918746c4d7ae'),
    'https://example.com/lib.js',
  );
  assert.equal(
    stripSriFragment('https://example.com/lib.js#sha256=e3b0c44298fc1c14'),
    'https://example.com/lib.js',
  );
});

// TM accepts a comma-separated list and uses the last supported one.
test('stripSriFragment: drops a multi-hash fragment', () => {
  assert.equal(
    stripSriFragment('https://example.com/lib.js#md5=abc,sha256=def'),
    'https://example.com/lib.js',
  );
});

// The base64 spelling uses `-` where the hex spelling uses `=`.
test('stripSriFragment: handles the base64 spelling', () => {
  assert.equal(
    stripSriFragment('https://example.com/lib.js#sha256-47DEQpj8HBSa+/TImW'),
    'https://example.com/lib.js',
  );
});

test('stripSriFragment: every supported algorithm', () => {
  for (const algo of ['md5', 'sha1', 'sha256', 'sha384', 'sha512']) {
    assert.equal(stripSriFragment(`https://example.com/lib.js#${algo}=abc`), 'https://example.com/lib.js');
  }
  // Case-insensitive: TM's docs lowercase these but nothing enforces it.
  assert.equal(stripSriFragment('https://example.com/lib.js#SHA256=abc'), 'https://example.com/lib.js');
});

// An ordinary fragment is content the author meant, so it survives —
// this is why the rule matches hash SHAPES rather than just cutting at
// the first `#`.
test('stripSriFragment: leaves a non-hash fragment alone', () => {
  for (const url of [
    'https://example.com/lib.js#section',
    'https://example.com/lib.js#',
    'https://example.com/lib.js#md5',
    'https://example.com/lib.js#sha256=abc,notahash',
    'https://example.com/lib.js#crc32=abc',
    'https://example.com/lib.js',
  ]) {
    assert.equal(stripSriFragment(url), url);
  }
});

// A malformed hash tail surviving is the right way round: a reader
// wondering why validation didn't happen needs to see what they typed.
test('stripSriFragment: leaves a hash with no value alone', () => {
  assert.equal(stripSriFragment('https://example.com/lib.js#md5='), 'https://example.com/lib.js#md5=');
});
