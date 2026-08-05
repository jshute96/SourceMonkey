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
 *   be attributed to. The expected LINE is deliberately not written here —
 *   it is read off that file's `>>> the error` marker at run time, so
 *   editing an example can never silently invalidate the assertion.
 */

/** @type {BadCase[]} */
export const BAD_CASES = [
  { file: 'empty.user.js',                 expectedStatus: 'invalid', errorMatcher: /no metadata block/ },
  { file: 'no-header.user.js',             expectedStatus: 'invalid', errorMatcher: /no metadata block/ },
  { file: 'empty-header.user.js',          expectedStatus: 'invalid', errorMatcher: /missing @name/ },
  { file: 'unclosed-header.user.js',       expectedStatus: 'invalid', errorMatcher: /unterminated metadata block/ },
  { file: 'malformed-field.user.js',       expectedStatus: 'invalid', errorMatcher: /missing @match or @include/ },
  { file: 'two-headers.user.js',           expectedStatus: 'ok' },
  { file: 'leading-text.user.js',          expectedStatus: 'ok' },
  { file: 'invalid-header-fields.user.js', expectedStatus: 'ok' },
  { file: 'blank-lines.user.js',           expectedStatus: 'ok' },
  { file: 'missing-require.user.js',       expectedStatus: 'invalid', errorMatcher: /@require \.\/does-not-exist\.js:.*fetch/ },
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
  },
  { file: 'throwing-require.user.js',      expectedStatus: 'ok' },

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
  },
  {
    file: 'syntax-error-require.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /syntax error/i,
    errorIn: 'syntax-error-require-lib.js',
  },
  {
    file: 'stray-brace.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /Unexpected token '\}'/,
    errorIn: 'stray-brace.user.js',
  },
  {
    // The shape where the two probes' messages agree even though the
    // wrapper was escaped, so only the range check separates them.
    file: 'stray-brace-at-end.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /Unexpected token '\}'/,
    errorIn: 'stray-brace-at-end.user.js',
  },
  {
    file: 'require-collision.user.js',
    expectedStatus: 'invalid',
    errorMatcher: /'SHARED_CONFIG' has already been declared/,
    errorIn: 'require-collision-lib-b.js',
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
 * The `(in <file>, line N, column N)` tail an `errorIn` case must carry.
 * `@require`s resolve to a full URL and the script's own body to its
 * relative path, so this matches the tail of whichever form the case
 * produces rather than the whole thing.
 * @param {string} errorIn
 */
export function locationPattern(errorIn) {
  return new RegExp(
    `\\(in \\S*${escapeRe(errorIn)}, line ${markedErrorLine(errorIn)}, column \\d+\\)`,
  );
}

/** Every `*.user.js` actually on disk, sorted — the coverage check. */
export function badScriptFilesOnDisk() {
  return fs.readdirSync(BAD_SCRIPTS_DIR).filter((n) => n.endsWith('.user.js')).sort();
}
