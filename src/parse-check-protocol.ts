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

export interface ParseVerdict {
  ok: boolean;
  // Present only when `ok` is false. V8 reports no line or column for a
  // `new Function` SyntaxError, so this is the message alone; which
  // file is at fault comes from compiling the pieces separately.
  message?: string;
}
