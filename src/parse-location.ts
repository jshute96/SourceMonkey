// Turning a syntax error into a place: which file, which line, which
// column.
//
// The sandbox (`parse-sandbox.ts`) can only report a position in the
// text it was handed, which is the whole composed program — GM
// bindings, then every `@require` body in order, then the script's own
// source. This module is the other half: pick which of the sandbox's
// two probes to believe, then map its line back through the same
// segment list the source map is built from, so the answer names the
// file the line was actually written in.
//
// It lives apart from both checkers because both need it — the service
// worker's (`background.ts`) and every extension page's
// (`parse-check-client.ts`) — and a rule this fiddly must not exist
// twice.

import {
  lookupGeneratedLine,
  type MappedSegment,
} from './source-map.js';
import type {
  ParseProbes,
  ParseProbeResult,
  ParseVerdict,
} from './parse-check-protocol.js';

// Line provenance for the checked text, as `buildParseCheckSource`
// returns it. Declared structurally rather than imported from
// injector.ts so this module stays cheap for pages to load — the page
// checker imports the injector lazily, on purpose.
export interface CheckedSourceShape {
  segments: readonly MappedSegment[];
  lineCount: number;
}

// ---------- Choosing a probe ----------
//
// The two probes fail in opposite directions (see `locate` in
// parse-sandbox.ts), and the verdict's own message is what tells them
// apart.
//
// `new Function` is itself a wrapper — V8 compiles the body inside
// `function anonymous() { … }` — so it has the SAME blind spot as our
// wrapped probe. When a source's braces are unbalanced, the source
// escapes both wrappers, and each reports whatever it hit after the
// escape. That is exactly when the two messages diverge, which makes
// "do the messages agree?" a direct test for "was the wrapper
// absorbed?":
//
//   - **agree** → the wrapper *probably* held, so the wrapped probe
//     parsed the same program `new Function` judged. Trust it, subject
//     to the range check below. This covers every ordinary error, plus
//     the ones only the wrapped form gets right: a top-level `return`
//     (legal in a function body, an error in a Script) no longer
//     produces a spurious earlier position.
//   - **disagree** → both wrappers were escaped, so only the raw probe
//     is describing the real structure. It places the offending brace
//     itself rather than the downstream error it causes.
//
// Rejecting instead of choosing was the earlier design, and it was
// worse: brace imbalance is the most common syntax error there is, and
// the messages usually can't agree for it, so those scripts would
// always have lost their position.
//
// "Probably" is doing real work in the first branch. The messages can
// agree even when the wrapper was escaped, because after escaping it
// the wrapped probe hits the closing `}` WE appended and reports
// `Unexpected token '}'` — the same text a stray `}` produces for the
// verdict. Measured, for `var a=1;\nfunction b(){}\n}` (three lines):
//
//     verdict  "Unexpected token '}'"
//     wrapped  "Unexpected token '}'"  line 4   <- our WRAPPER_TAIL
//     raw      "Unexpected token '}'"  line 3   <- the actual brace
//
// The tell is the range check: a wrapped probe that really did hold
// can only land inside the source, or on the sentinel when the source
// is genuinely unterminated. If it lands outside while the raw probe
// lands inside, the source is demonstrably NOT unterminated — the raw
// probe found a real position in it — so the out-of-range answer is
// escape fallout and the raw probe is the honest one.
export function selectParseLocation(args: {
  verdictMessage: string | undefined;
  probes: ParseProbes | undefined;
  lineCount: number;
}): ParseProbeResult | null {
  const probes = args.probes;
  if (!probes) return null;
  const wrapped = validProbe(probes.wrapped);
  const raw = trustworthyRaw(validProbe(probes.raw));
  // Outside the checked text means V8 ran off the end and stopped at
  // our own sentinel, which happens when the source ends inside
  // something unclosed. There is no line to blame there.
  const inRange = (probe: ParseProbeResult | null): probe is ParseProbeResult =>
    probe !== null && probe.line >= 1 && probe.line <= args.lineCount;

  // `endsWith` rather than `===` so an unstripped DOM prefix on the
  // probe's message (see `stripDomPrefix`) still matches the verdict's.
  // It cannot match too eagerly in the direction that matters: a
  // different error produces different trailing text. The non-empty
  // check is load-bearing — `endsWith('')` is true of everything, so a
  // verdict with no message would otherwise "agree" with any probe.
  const verdictMessage = args.verdictMessage;
  if (wrapped && verdictMessage && wrapped.message.endsWith(verdictMessage)) {
    // Report the VERDICT's message rather than the probe's. They are
    // the same error by construction, and the verdict's is the one that
    // never carries a DOM prefix `stripDomPrefix` failed to strip.
    if (inRange(wrapped)) return { ...wrapped, message: verdictMessage };
    if (inRange(raw)) return raw;
    return null;
  }
  // The fallback does NOT run in the other direction. A wrapped probe
  // that disagreed with the verdict escaped its wrapper and is
  // describing a different parse of a different program, so its
  // position is not a second opinion about this error — it is an
  // answer to another question.
  return inRange(raw) ? raw : null;
}

// Diagnostics that only a *Script* can raise. The raw probe is a
// Script; `new Function` compiles a function body, so it can never
// produce either of these. Seeing one is proof the raw probe stopped
// at something that is perfectly legal in the entry we actually
// inject — so both its position and its message are about code that
// isn't broken, and using them would name a line the user should not
// go and look at.
//
// Verified against V8 that these two, and only these two, are
// Script-only. `Illegal break statement`, `Illegal continue
// statement` and `'super' keyword unexpected here` all read the same
// from `new Function`, so filtering them would throw away positions
// the raw probe got right.
const SCRIPT_ONLY_DIAGNOSTICS = [
  'Illegal return statement',
  'new.target expression is not allowed here',
];

function trustworthyRaw(probe: ParseProbeResult | null): ParseProbeResult | null {
  if (!probe) return null;
  const scriptOnly = SCRIPT_ONLY_DIAGNOSTICS.some((d) => probe.message.endsWith(d));
  return scriptOnly ? null : probe;
}

// The probes cross a postMessage boundary from a context that compiles
// untrusted source, so nothing about their shape is guaranteed.
function validProbe(probe: ParseProbeResult | undefined): ParseProbeResult | null {
  if (!probe || typeof probe.message !== 'string') return null;
  if (!Number.isFinite(probe.line) || !Number.isFinite(probe.column)) return null;
  return probe;
}

// ---------- Attaching it to the verdict ----------

// Replace a verdict's raw `probes` with a resolved `location`. Called
// by both checkers, immediately after the sandbox answers and while
// the composed source that produced it is still in hand.
//
// Only ever adds detail: a verdict whose position can't be resolved
// comes back with its status and message untouched, so nothing about
// whether a script is disabled depends on any of this.
export function attachParseLocation(
  verdict: ParseVerdict | null,
  source: CheckedSourceShape,
): ParseVerdict | null {
  if (!verdict) return null;
  if (verdict.status !== 'syntax-error') return { status: verdict.status, message: verdict.message };
  const hit = selectParseLocation({
    verdictMessage: verdict.message,
    probes: verdict.probes,
    lineCount: source.lineCount,
  });
  if (!hit) return { status: verdict.status, message: verdict.message };
  const origin = lookupGeneratedLine(source.segments, hit.line);
  // No segment covers the line, so it belongs to code WE emitted — the
  // GM-bindings preamble, or a seam between concatenated files.
  // Reporting a raw generated line there would point the user at a
  // line of their file that has nothing to do with the error, so drop
  // the position — and with it the probe's message, which only earned
  // its place by describing the line we are no longer naming. What's
  // left is the verdict's own message, from the compile that actually
  // decided this script is broken.
  if (!origin) return { status: verdict.status, message: verdict.message };
  return {
    status: verdict.status,
    // The chosen probe's message. `selectParseLocation` has already
    // substituted the verdict's own when the wrapped probe won, so the
    // two differ only when the raw probe won — and then the raw
    // probe's message is the one that describes the line we're about
    // to name. Pairing one compile's message with another's position
    // is how you get "Unexpected token 'var'" pointing at a line
    // containing no `var`.
    message: hit.message,
    location: { file: origin.url, line: origin.line, column: hit.column },
  };
}
