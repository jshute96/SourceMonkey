// Tests for src/parse-location.ts (compiled to dist/parse-location.js).
//
// This is where a syntax error becomes a place, and every input below
// is real: the messages, lines and columns are what Chromium actually
// reported for these sources, not invented shapes. The interesting
// cases are the ones where the two probes disagree, because that is
// the only thing standing between a helpful line number and a
// confidently wrong one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachParseLocation,
  selectParseLocation,
} from '../../dist/parse-location.js';

// `// @require url` marker, then 3 lines of library, a `;` seam, then
// the script's own 2 lines — the layout composeSource emits.
const SEGMENTS = [
  { url: 'https://cdn.example/lib.js', content: 'a\nb\nc', generatedLine: 2, lineCount: 3 },
  { url: 'my.user.js', content: 'x\ny', generatedLine: 6, lineCount: 2 },
];

test('picks the wrapped probe when its message matches the verdict', () => {
  // Source: `if (0) return;` then a real error further down. The raw
  // probe stops at the `return` — legal in the injected function body,
  // so its line 1 is a lie. The wrapped probe agrees with the verdict.
  const hit = selectParseLocation({
    verdictMessage: "Unexpected token ';'",
    probes: {
      wrapped: { message: "Unexpected token ';'", line: 3, column: 9 },
      raw: { message: 'Illegal return statement', line: 1, column: 8 },
    },
    lineCount: 8,
  });
  assert.deepEqual(hit, { message: "Unexpected token ';'", line: 3, column: 9 });
});

test('falls to the raw probe when the wrapper was absorbed', () => {
  // Source starting with a stray `}`. It escapes BOTH wrappers —
  // ours and `new Function`'s — so the verdict's own message is about
  // the token after the escape, and only the raw probe places the
  // brace itself.
  const hit = selectParseLocation({
    verdictMessage: "Unexpected token 'var'",
    probes: {
      wrapped: { message: "Unexpected token ';'", line: 3, column: 9 },
      raw: { message: "Unexpected token '}'", line: 1, column: 1 },
    },
    lineCount: 8,
  });
  assert.deepEqual(hit, { message: "Unexpected token '}'", line: 1, column: 1 });
});

test('tolerates an unstripped DOM prefix on the probe message', () => {
  const hit = selectParseLocation({
    verdictMessage: "Unexpected token ';'",
    probes: {
      wrapped: {
        message: "Failed to execute 'append' on 'Element': Unexpected token ';'",
        line: 3,
        column: 9,
      },
    },
    lineCount: 8,
  });
  assert.equal(hit.line, 3);
  // Tolerated for MATCHING, never shown: a winning wrapped probe
  // reports the verdict's message, which can't carry the prefix.
  assert.equal(hit.message, "Unexpected token ';'");
});

test('falls back to raw when an agreeing wrapped probe lands out of range', () => {
  // A stray `}` at the END of the source. Measured for
  // `var a=1;\nfunction b(){}\n}` — the wrapped probe escapes the
  // wrapper and then hits the closing `}` WE append, which produces
  // the same message a stray `}` gives the verdict. The messages agree
  // even though the wrapper did not hold.
  //
  // Trusting the agreement here would throw away the raw probe's line
  // 3, which is exactly the brace the user has to delete.
  const hit = selectParseLocation({
    verdictMessage: "Unexpected token '}'",
    probes: {
      wrapped: { message: "Unexpected token '}'", line: 4, column: 1 },
      raw: { message: "Unexpected token '}'", line: 3, column: 1 },
    },
    lineCount: 3,
  });
  assert.deepEqual(hit, { message: "Unexpected token '}'", line: 3, column: 1 });
});

test('still gives up when BOTH probes land out of range', () => {
  // The genuinely-unterminated shape the fallback must not paper over:
  // `if (1) {\nvar a = 1;` runs off the end in either framing, so
  // there is no line in the source to blame.
  assert.equal(
    selectParseLocation({
      verdictMessage: 'Unexpected end of input',
      probes: {
        wrapped: { message: 'Unexpected end of input', line: 4, column: 1 },
        raw: { message: 'Unexpected end of input', line: 3, column: 1 },
      },
      lineCount: 2,
    }),
    null,
  );
});

test('discards a raw probe reporting a Script-only error', () => {
  // Measured for `if (0) return;\nvar a = 1;\n}\nvar c=2;`. The wrapped
  // probe escaped (it disagrees with the verdict), so the raw probe
  // would normally win — but it stopped at the top-level `return`,
  // which is legal in the function body we actually inject. Reporting
  // it would name line 1, print a message about code that is not
  // broken, and send the user away from the `}` that is.
  assert.equal(
    selectParseLocation({
      verdictMessage: "Unexpected token 'var'",
      probes: {
        wrapped: { message: "Unexpected token '}'", line: 6, column: 1 },
        raw: { message: 'Illegal return statement', line: 1, column: 8 },
      },
      lineCount: 4,
    }),
    null,
  );
  // `new.target` is the other one V8 allows in a function body but not
  // in a Script. Errors that BOTH framings raise are not filtered —
  // discarding those would lose positions the raw probe got right.
  assert.equal(
    selectParseLocation({
      verdictMessage: 'x',
      probes: { raw: { message: 'new.target expression is not allowed here', line: 1, column: 1 } },
      lineCount: 4,
    }),
    null,
  );
  const kept = selectParseLocation({
    verdictMessage: 'x',
    probes: { raw: { message: 'Illegal break statement', line: 2, column: 1 } },
    lineCount: 4,
  });
  assert.deepEqual(kept, { message: 'Illegal break statement', line: 2, column: 1 });
});

test('rejects a position that landed on the sentinel', () => {
  // The source ends inside something unclosed, so V8 ran off the end
  // and stopped at our own appended `(`. There is no line to blame.
  assert.equal(
    selectParseLocation({
      verdictMessage: 'Unexpected end of input',
      probes: {
        wrapped: { message: 'Unexpected end of input', line: 9, column: 1 },
        raw: { message: 'Unexpected end of input', line: 9, column: 1 },
      },
      lineCount: 8,
    }),
    null,
  );
  assert.equal(
    selectParseLocation({
      verdictMessage: 'x',
      probes: { raw: { message: 'x', line: 0, column: 1 } },
      lineCount: 8,
    }),
    null,
  );
});

test('rejects missing or malformed probes', () => {
  const bad = [
    undefined,
    {},
    { raw: null },
    { raw: { message: 'x' } },
    { raw: { message: 'x', line: NaN, column: 1 } },
    { raw: { message: 'x', line: 1, column: Infinity } },
    { raw: { message: 42, line: 1, column: 1 } },
  ];
  for (const probes of bad) {
    assert.equal(
      selectParseLocation({ verdictMessage: 'x', probes, lineCount: 8 }),
      null,
      `expected null for ${JSON.stringify(probes)}`,
    );
  }
});

test('a probe with no verdict message to compare against still uses raw', () => {
  // `sameError` returns false without a verdict message, so the
  // wrapped probe can never be selected — raw is the safe default
  // because it has no wrapper of ours to have been absorbed.
  const hit = selectParseLocation({
    verdictMessage: undefined,
    probes: {
      wrapped: { message: 'a', line: 2, column: 1 },
      raw: { message: 'b', line: 5, column: 3 },
    },
    lineCount: 8,
  });
  assert.deepEqual(hit, { message: 'b', line: 5, column: 3 });
});

test('maps the chosen line back to the @require it came from', () => {
  const verdict = attachParseLocation(
    {
      status: 'syntax-error',
      message: "Unexpected token ';'",
      probes: { wrapped: { message: "Unexpected token ';'", line: 4, column: 31 } },
    },
    { segments: SEGMENTS, lineCount: 8 },
  );
  assert.deepEqual(verdict, {
    status: 'syntax-error',
    message: "Unexpected token ';'",
    location: { file: 'https://cdn.example/lib.js', line: 2, column: 31 },
  });
});

test('maps a line in the script body to the script', () => {
  const verdict = attachParseLocation(
    {
      status: 'syntax-error',
      message: 'boom',
      probes: { wrapped: { message: 'boom', line: 8, column: 2 } },
    },
    { segments: SEGMENTS, lineCount: 8 },
  );
  assert.deepEqual(verdict.location, { file: 'my.user.js', line: 2, column: 2 });
});

test('drops the position when no segment covers the line', () => {
  // Generated line 1 is the GM-bindings preamble — ours, not the
  // user's. Naming a line of their file for it would be worse than
  // saying nothing.
  const verdict = attachParseLocation(
    {
      status: 'syntax-error',
      message: 'boom',
      probes: { wrapped: { message: 'boom', line: 1, column: 2 } },
    },
    { segments: SEGMENTS, lineCount: 8 },
  );
  assert.deepEqual(verdict, { status: 'syntax-error', message: 'boom' });

  // And when the RAW probe won, its message goes with the position it
  // came in with. It earned its place by describing a line we are no
  // longer naming, so what's left is the verdict's own message.
  const rawWon = attachParseLocation(
    {
      status: 'syntax-error',
      message: "Unexpected token 'var'",
      probes: {
        wrapped: { message: "Unexpected token ';'", line: 7, column: 1 },
        raw: { message: "Unexpected token '}'", line: 1, column: 1 },
      },
    },
    { segments: SEGMENTS, lineCount: 8 },
  );
  assert.deepEqual(rawWon, { status: 'syntax-error', message: "Unexpected token 'var'" });
});

test('never invents a verdict, and drops the wire-only probes', () => {
  assert.equal(attachParseLocation(null, { segments: SEGMENTS, lineCount: 8 }), null);
  for (const status of ['ok', 'unknown']) {
    const out = attachParseLocation(
      { status, message: 'm', probes: { raw: { message: 'm', line: 4, column: 1 } } },
      { segments: SEGMENTS, lineCount: 8 },
    );
    assert.deepEqual(out, { status, message: 'm' });
  }
  // A syntax error whose position can't be resolved keeps its status
  // and message, so nothing about disabling a script depends on any of
  // the location machinery working.
  const unplaced = attachParseLocation(
    { status: 'syntax-error', message: 'm', probes: undefined },
    { segments: SEGMENTS, lineCount: 8 },
  );
  assert.deepEqual(unplaced, { status: 'syntax-error', message: 'm' });
});
