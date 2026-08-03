// Wire types shared by the two ends of the parse check that can import
// them: the service worker (`parse-check.ts`) and the offscreen relay
// (`offscreen.ts`).
//
// The third participant, `parse-sandbox.ts`, deliberately does NOT
// import this — it is loaded as a classic `<script>` in a sandboxed
// page, and any import would make tsc emit an ES module. It mirrors
// these shapes inline instead; they are small and change together.

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

export interface ParseVerdict {
  status: ParseStatus;
  // Present for `syntax-error` (V8's message about the whole compiled
  // source — it reports no line, no column, and no file) and for
  // `unknown` (whatever went wrong, for diagnostics only).
  message?: string;
}
