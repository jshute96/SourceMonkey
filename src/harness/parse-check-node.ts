// Node counterpart of `src/parse-sandbox.ts` — the compile-only parse
// check, run under Node's V8 instead of Chrome's. Used by the development
// harness (`prepare.ts`), which runs the install pipeline outside a
// browser for `sm-dev` and the corpus validator.
//
// The extension can only do this inside a sandboxed extension page,
// because MV3's CSP forbids `eval` everywhere else and the location
// probes need to insert a `<script>`. Node has neither restriction, so
// the same two-step check (verdict, then location) is a few lines here:
//
//   - the verdict comes from `new Function(src)`, byte-for-byte the
//     call the sandbox makes;
//   - the location comes from compiling the same text twice more with
//     `new vm.Script`, which is Node's classic-script compile — the
//     same thing appending a `<script>` element does in the sandbox.
//
// Everything downstream (`selectParseLocation`, `attachParseLocation`)
// is the extension's own code, so the probe selection rule is shared
// rather than reimplemented.
//
// Caveat worth remembering when reading results: Node's V8 is not
// Chrome's V8. Both accept the same language, but a very new syntax
// feature (or a wording change in a `SyntaxError` message) can differ
// between the two versions. `node --version` pins which one answered.

import vm from 'node:vm';
import type { ParseProbeResult, ParseProbes, ParseVerdict } from '../parse-check-protocol.js';

// Mirrors `parse-sandbox.ts` exactly, because the probe text is what
// the reported positions are relative to: change the framing and the
// line numbers stop matching the browser's.
//
// In the sandbox the sentinel is load-bearing for safety — appending a
// `<script>` element runs it, and only a guaranteed parse failure stops
// that. `new vm.Script` compiles without running either way, so here
// the sentinel is purely about parity. Keeping it means a source that
// ends mid-construct fails at the same place in both, which is the case
// `selectParseLocation`'s range check is reading.
const PROBE_SENTINEL = '\n(';
const WRAPPER_HEAD = 'function __smParseProbe__() {\n';
const WRAPPER_TAIL = '\n}';

// Any name works; it only has to be recognizable in the stack trace we
// parse the position out of. The `:` is the separator V8 puts before
// the line number — matched as a literal prefix rather than
// interpolated into a regex, so a future rename can't turn a character
// of the name into a wildcard.
const PROBE_FILENAME = 'sm-parse-probe.js';
const PROBE_HEAD_PREFIX = `${PROBE_FILENAME}:`;

/** The verdict, with probes attached when it's a syntax error. */
export function checkParseNode(source: string): ParseVerdict {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source);
    return { status: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only a SyntaxError means "this source is broken". A RangeError
    // (parser stack overflow on pathologically nested source) means we
    // couldn't tell — see the long note in parse-sandbox.ts.
    if (!(err instanceof SyntaxError)) return { status: 'unknown', message };
    return { status: 'syntax-error', message, probes: locate(source) };
  }
}

function locate(source: string): ParseProbes | undefined {
  try {
    return {
      wrapped: runProbe(`${WRAPPER_HEAD}${source}${WRAPPER_TAIL}${PROBE_SENTINEL}`, 1),
      raw: runProbe(`${source}${PROBE_SENTINEL}`, 0),
    };
  } catch {
    // Locating is a nicety; the verdict is the product.
    return undefined;
  }
}

// Compile `text` as a classic script and report where it failed.
// `lineOffset` is how many lines of our own framing precede the source,
// so the caller gets source coordinates back.
function runProbe(text: string, lineOffset: number): ParseProbeResult | undefined {
  try {
    new vm.Script(text, { filename: PROBE_FILENAME });
  } catch (err) {
    if (!(err instanceof SyntaxError)) return undefined;
    const at = positionFromStack(err);
    if (!at) return undefined;
    return { message: err.message, line: at.line - lineOffset, column: at.column };
  }
  // No error at all means the sentinel failed to do its job — and the
  // source ran. Report no position; `selectParseLocation` then has one
  // fewer probe to choose from.
  return undefined;
}

// A `vm.Script` SyntaxError carries its position only in the rendered
// preamble at the top of `err.stack`, which V8 formats as:
//
//     sm-parse-probe.js:3
//     }
//     ^
//     (blank)
//     SyntaxError: Unexpected token '}'
//         at new Script (node:vm:…)
//
// The first line gives the 1-based line; the caret line gives the
// 1-based column as its first `^`. A stack whose first line isn't the
// preamble is one we don't recognize, and gets no position at all.
//
// **The column is best-effort; the line is not.** V8 clips the rendered
// frame at ~1020 characters, so for a longer source line the caret line
// is all spaces with no `^` in it and the true column is simply not in
// the stack. That is not exotic input here — a minified script, or a
// minified `@require`, is one enormous line, and bulk-checking real
// corpora is what this tool is for. Chrome's path reads `event.colno`
// and has the real column in every case, so this is the one place the
// Node port is knowingly less precise. We keep the line (exact, and the
// part that names a file) and fall back to column 1, which
// `COLUMN_UNKNOWN` marks as a fallback rather than a measurement.
// Nothing downstream depends on it: `selectParseLocation` compares only
// lines, so probe choice and the verdict are unaffected.
const COLUMN_UNKNOWN = 1;

function positionFromStack(err: Error): { line: number; column: number } | null {
  const lines = String(err.stack ?? '').split('\n');
  const head = lines[0] ?? '';
  if (!head.startsWith(PROBE_HEAD_PREFIX)) return null;
  const line = Number(head.slice(PROBE_HEAD_PREFIX.length));
  if (!Number.isInteger(line)) return null;
  const caretIndex = (lines[2] ?? '').indexOf('^');
  return { line, column: caretIndex >= 0 ? caretIndex + 1 : COLUMN_UNKNOWN };
}
