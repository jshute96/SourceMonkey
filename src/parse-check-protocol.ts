// Wire types and shared state for the parse check, imported by every
// end that can: the service worker (`parse-check.ts`), the offscreen
// relay (`offscreen.ts`), the sandbox driver (`parse-sandbox-host.ts`),
// and the page-side client (`parse-check-client.ts`).
//
// The remaining participant, `parse-sandbox.ts`, deliberately does NOT
// import this — it is loaded as a classic `<script>` in a sandboxed
// page, and any import would make tsc emit an ES module. It mirrors
// these shapes inline instead; they are small and change together.

import type { DiagnosticLocation } from './diagnostic-location.js';

export const PARSE_CHECK_MSG = 'sm:parse-check';
export const PARSE_CHECK_RESULT_MSG = 'sm:parse-check-result';
// Posted by the sandbox to its embedder once its listener is live.
// See the readiness note in `offscreen.ts`.
export const PARSE_SANDBOX_READY_MSG = 'sm:parse-sandbox-ready';

// Three states, not two. `unknown` is the load-bearing one: the whole
// feature rests on "a machinery failure must never mark a working
// script invalid", and collapsing it into `syntax-error` is exactly how
// that breaks.
//
// The dangerous case is not the obvious one. A `RangeError` from a
// pathologically nested source is merely wrong; but if the sandbox CSP
// ever stopped applying — a manifest edit, an enterprise policy, a
// future Chrome change — `new Function` would throw `EvalError` and
// EVERY script in the profile would be reported as a syntax error at
// once. Distinguishing the states means that failure mode turns the
// feature off instead of disabling every userscript the user has.
export type ParseStatus = 'ok' | 'syntax-error' | 'unknown';

// One location probe's answer, already in the coordinates of the
// source that was checked — the sandbox removes its own framing before
// reporting. Line and column are 1-based, as V8 reports them.
export interface ParseProbeResult {
  message: string;
  line: number;
  column: number;
}

// Both probes' answers, unselected. Choosing between them is
// deliberately NOT done in the sandbox: it is the subtlest rule in the
// feature, and a sandboxed classic script cannot be imported by the
// unit suite. `selectParseLocation` in parse-location.ts decides, and
// is tested directly.
export interface ParseProbes {
  wrapped?: ParseProbeResult;
  raw?: ParseProbeResult;
}

// Where the error is, once a probe has been chosen and its line mapped
// back through the segment list to the file that line was written in.
//
// The general `DiagnosticLocation` with both optional fields pinned
// present: unlike a header diagnostic, a parse verdict either knows the
// line AND the column (V8 reports both) or has no location at all.
// Narrowing here keeps that guarantee where it is true without asking
// every other producer to invent a column.
export interface ParseLocation extends DiagnosticLocation {
  // The `@require` URL, or the script's own path.
  file: string;
  line: number;
  column: number;
}

export interface ParseVerdict {
  status: ParseStatus;
  // Present for `syntax-error` (V8's message) and for `unknown`
  // (whatever went wrong, for diagnostics only).
  message?: string;
  // Wire only, sandbox → checker. Consumed by `attachParseLocation`,
  // which replaces it with `location`; nothing downstream reads it.
  probes?: ParseProbes;
  // Derived by the checker, which is the only participant holding both
  // the verdict and the segment list the line has to be mapped
  // through. Absent when the probes couldn't place the error — V8
  // landing on our own sentinel (the source ends mid-construct), or on
  // the first line or a seam we add, none of which is a line the
  // user wrote.
  location?: ParseLocation;
}

// ---------- The test toggle ----------
//
// `sm.setParseCheckEnabled(false)` turns the check off so a test can
// drive an unparsable script all the way to injection and exercise the
// run-time backstop.
//
// It lives in **session storage**, not in a module variable, for two
// reasons — each of which was a real bug in an earlier shape of this:
//
//   - There is more than one checker now (the service worker's and one
//     per extension page). A flag in the SW can't reach a page that
//     compiles in its own sandbox, so the toggle would silently mean
//     "half off".
//   - `resetAllState` clears session storage between tests, so the
//     toggle resets itself. A module variable had to be restored by
//     hand, and a missed restore left the check disabled for the rest
//     of that service worker's life — re-breaking the feature for
//     every later spec, as a flake rather than a clean failure.
const PARSE_CHECK_DISABLED_KEY = 'sm:parse-check-disabled';

export async function setParseCheckDisabled(disabled: boolean): Promise<void> {
  if (disabled) await chrome.storage.session.set({ [PARSE_CHECK_DISABLED_KEY]: true });
  else await chrome.storage.session.remove(PARSE_CHECK_DISABLED_KEY);
}

// Read before every compile. Cheap (session storage is in-memory) and
// always current, which is what lets a test flip it mid-run.
export async function isParseCheckDisabled(): Promise<boolean> {
  try {
    const got = await chrome.storage.session.get(PARSE_CHECK_DISABLED_KEY);
    return got[PARSE_CHECK_DISABLED_KEY] === true;
  } catch {
    // Storage unavailable is not a reason to skip the check.
    return false;
  }
}
