// Expected outcomes for every file in `tests/bad-examples/`, shared by
// the two tests that check them:
//
//   - `tests/e2e/bad-scripts.spec.ts` — adds the directory as a real
//     source in a real browser, and reads the stored rows back.
//   - `tests/unit/validate-userscripts.test.mjs` — runs the offline
//     CLI over the same directory under Node.
//
// The table lives here rather than in either test because the point of
// having both is that they must agree: the CLI's whole claim is that it
// reproduces what the extension does at install time. Two copies of the
// expectations would let them drift apart silently, which is precisely
// the failure neither test could then detect.
//
// Status comes from `buildScriptFromText` → splitHeaderBody /
// parseHeader / validateHeader; the require failure on missing-require
// comes through the `@require` attach pipeline (`src/external-files.ts`);
// the located syntax errors come from the parse check
// (`docs/parse-check.md`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BAD_SCRIPTS_DIR = path.resolve(__dirname, '..', 'bad-examples');

/**
 * @typedef {object} BadCase
 * @property {string} file
 * @property {'ok' | 'invalid'} expectedStatus
 * @property {RegExp} [errorMatcher]
 * @property {string} [errorIn]  Which file in the corpus the error should
 *   be attributed to. The expected LINE is normally not written here —
 *   it is read off that file's `>>> the error` marker at run time, so
 *   editing an example can never silently invalidate the assertion.
 * @property {number | null} [errorLine]  Explicit expected line, for the
 *   cases with no line to mark. Every header-validation failure is about
 *   a tag that ISN'T there, so there is no offending line to put a marker
 *   above — they point at the `// ==UserScript==` line instead. `null`
 *   means "this file, no line", the honest answer when there is no block.
 * @property {boolean} [expectColumn]  Expect a column alongside the line.
 *   Only the parse check knows one (V8 reports it); header diagnostics
 *   deliberately don't invent one.
 */

/** @type {BadCase[]} */
export const BAD_CASES = [
  // No block at all, so no line to name — the location is the file
  // itself, which still opens the source the reader has to fix.
  { file: 'empty.user.js',                 expectedStatus: 'invalid', errorMatcher: /No \/\/ ==UserScript== metadata block/,
    errorIn: 'empty.user.js', errorLine: null },
  { file: 'no-header.user.js',             expectedStatus: 'invalid', errorMatcher: /No \/\/ ==UserScript== metadata block/,
    errorIn: 'no-header.user.js', errorLine: null },
  // A tag that isn't there has no line of its own, so these point at
  // the `// ==UserScript==` marker — the block the tag belongs in.
  { file: 'empty-header.user.js',          expectedStatus: 'invalid', errorMatcher: /No @name in the metadata block/,
    errorIn: 'empty-header.user.js', errorLine: 1 },
  { file: 'unclosed-header.user.js',       expectedStatus: 'invalid', errorMatcher: /metadata block is never closed/,
    errorIn: 'unclosed-header.user.js', errorLine: 1 },
  { file: 'malformed-field.user.js',       expectedStatus: 'invalid', errorMatcher: /No @match or @include in the metadata block/,
    errorIn: 'malformed-field.user.js', errorLine: 1 },
  { file: 'two-headers.user.js',           expectedStatus: 'ok' },
  { file: 'leading-text.user.js',          expectedStatus: 'ok' },
  { file: 'invalid-header-fields.user.js', expectedStatus: 'ok' },
  { file: 'blank-lines.user.js',           expectedStatus: 'ok' },
  // The file that failed has no content to point into, so the location
  // is the `@require` line that named it.
  //
  // One exact string, not an alternation: both `file://` legs (the
  // page's XHR and the service worker's / Node's `fetch`) report an
  // unreadable local file the same way, so the browser and the CLI
  // must agree here.
  { file: 'missing-require.user.js',       expectedStatus: 'invalid', errorMatcher: /@require \.\/does-not-exist\.js: The file may not exist/,
    errorIn: 'missing-require.user.js' },
  // Both require cases below fetch their `@require` fine — the failure
  // is in the code, not the load. They differ in WHEN we can see it:
  //
  //   - unparsable: the install-time compile check (src/parse-check.ts)
  //     compiles the composed program without running it, so a syntax
  //     error is visible before the script is ever registered.
  //   - throwing: the library parses and only fails when it RUNS, and
  //     running it is exactly what we won't do at install time. Still
  //     `ok` here; the run-time report is covered in requires.spec.ts.
  {
    file: 'unparsable-require.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /syntax error/i,
    errorIn: 'unparsable-require-lib.js',
    expectColumn: true,
  },
  { file: 'throwing-require.user.js',      expectedStatus: 'ok' },
  // Not invalid: an unsupported @grant is dropped and the script still
  // runs. Its located WARNING rides on `startupLogs`, asserted by
  // bad-scripts.spec.ts; the click-through is in diagnostic-links.spec.ts.
  { file: 'unknown-grant.user.js',         expectedStatus: 'ok' },

  // ---------- Where the error is ----------
  //
  // One per distinct route through the location machinery (see
  // docs/parse-check.md, "Locating the error"). These are the cases to
  // install by hand when you want to see what the message looks like.
  //
  //   - body: no `@require`, so the composed program is the file
  //     behind our preamble — the line must survive the header's
  //     height.
  //   - require: the error is in a library, and naming the script
  //     instead would point at innocent code.
  //   - stray brace: the wrapped probe is swallowed, so the raw probe
  //     is the one that places the brace.
  //   - collision: nothing is wrong until the files are joined, and
  //     the blame belongs to the file that redeclares.
  {
    file: 'syntax-error-body.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /syntax error/i,
    errorIn: 'syntax-error-body.user.js',
    expectColumn: true,
  },
  {
    file: 'syntax-error-require.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /syntax error/i,
    errorIn: 'syntax-error-require-lib.js',
    expectColumn: true,
  },
  {
    file: 'stray-brace.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /Unexpected token '\}'/,
    errorIn: 'stray-brace.user.js',
    expectColumn: true,
  },
  {
    // The shape where the two probes' messages agree even though the
    // wrapper was escaped, so only the range check separates them.
    file: 'stray-brace-at-end.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /Unexpected token '\}'/,
    errorIn: 'stray-brace-at-end.user.js',
    expectColumn: true,
  },
  {
    file: 'require-collision.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /'SHARED_CONFIG' has already been declared/,
    errorIn: 'require-collision-lib-b.js',
    expectColumn: true,
  },
];

// Every example that has a located error marks the offending line with
// a comment directly above it. Returns the 1-based line number of the
// line BELOW the marker.
const ERROR_MARKER = '>>> the error';

/** @param {string} file */
export function markedErrorLine(file) {
  const lines = fs.readFileSync(path.join(BAD_SCRIPTS_DIR, file), 'utf8').split('\n');
  const markerIdx = lines.findIndex((l) => l.includes(ERROR_MARKER));
  if (markerIdx < 0) throw new Error(`no '${ERROR_MARKER}' marker in ${file}`);
  return markerIdx + 2;
}

/** @param {string} text */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The line an `errorIn` case must be reported on, or `undefined` when
 * the honest answer is the file as a whole. Read off the `>>> the error`
 * marker unless the case states one, which the header failures do —
 * they are about a tag that isn't there, so there is no line to mark.
 * @param {BadCase} c
 */
export function expectedErrorLine(c) {
  if (c.errorLine !== undefined) return c.errorLine ?? undefined;
  return markedErrorLine(c.errorIn);
}

/**
 * The tail an `errorIn` case's reported file must match. A `@require`
 * resolves to a full `file://` URL and the script's own body to its
 * relative path, so only the end of the string is pinned.
 * @param {BadCase} c
 */
export function expectedFilePattern(c) {
  return new RegExp(`${escapeRe(c.errorIn)}$`);
}

/**
 * The `(in <where>)` tail an `errorIn` case must carry, as
 * `describeDiagnostic` renders it. `@require`s resolve to a full URL and
 * the script's own body to its relative path, so this matches the tail
 * of whichever form the case produces rather than the whole thing.
 *
 * The three shapes mirror `locationLabel` exactly: file alone, file plus
 * line, file plus line plus column. A case that expects no column must
 * not match a report that invented one, so the pattern is anchored.
 * @param {BadCase} c
 */
export function locationPattern(c) {
  let tail = `\\(in \\S*${escapeRe(c.errorIn)}`;
  const line = expectedErrorLine(c);
  if (line !== undefined) {
    tail += `, line ${line}`;
    if (c.expectColumn) tail += ', column \\d+';
  }
  return new RegExp(`${tail}\\)`);
}

/** Every `*.user.js` actually on disk, sorted — the coverage check. */
export function badScriptFilesOnDisk() {
  return fs.readdirSync(BAD_SCRIPTS_DIR).filter((n) => n.endsWith('.user.js')).sort();
}
