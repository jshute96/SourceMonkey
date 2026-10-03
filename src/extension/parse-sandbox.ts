// Sandboxed compile-only parse check. Loaded by `parse-sandbox.html`,
// which is declared under `sandbox.pages` in the manifest — the one
// context in an MV3 extension allowed to declare `'unsafe-eval'`.
//
// See the comment in `parse-sandbox.html` for why the compile has to
// happen in a sandbox at all, and why compiling untrusted source here
// is safe.
//
// This file deliberately imports nothing. tsc would emit an ES module
// for a file with imports, and a sandboxed page loads it as a classic
// `<script src>`. The message shapes below are mirrored (not shared)
// from `src/parse-check-protocol.ts`, which is the source of truth;
// they are small and change together.

interface ParseRequest {
  type: 'sm:parse-check';
  // Correlates the reply. Round-tripped by whichever context embeds
  // this frame — `parse-sandbox-host.ts` drives both of them.
  id: string;
  // Each entry is compiled independently, as a FUNCTION BODY — which
  // is what the injected entry actually is, so constructs that are
  // legal there and nowhere else (a top-level `return`) don't produce
  // a spurious failure.
  sources: string[];
}

interface ParseProbeResult {
  message: string;
  line: number;
  column: number;
}

interface ParseProbes {
  wrapped?: ParseProbeResult;
  raw?: ParseProbeResult;
}

interface ParseVerdict {
  status: 'ok' | 'syntax-error' | 'unknown';
  // V8 gives no line or column for a `new Function` SyntaxError —
  // not in the message, not in the stack — so this is the message
  // alone. `probes` is where the position comes from.
  message?: string;
  probes?: ParseProbes;
}

// `new Function` compiles the body and returns; it never runs it. A
// SyntaxError anywhere in the text is the answer we want.
function checkOne(source: string): ParseVerdict {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source);
    return { status: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ONLY a SyntaxError means "this source is broken". Everything
    // else means "we couldn't tell", and the difference matters more
    // than it looks:
    //
    //   - A `RangeError: Maximum call stack size exceeded` on a
    //     pathologically nested source is the parser running out of
    //     budget HERE — inside a message handler inside a promise
    //     chain — which is not the budget `chrome.userScripts` will
    //     compile the real entry with. Reporting it as a syntax error
    //     would disable a script V8 is perfectly willing to run.
    //   - If the sandbox CSP ever stopped applying, `new Function`
    //     would throw `EvalError` and every script in the profile
    //     would be branded broken at once. That is the exact outcome
    //     the design says cannot happen.
    if (!(err instanceof SyntaxError)) return { status: 'unknown', message };
    return { status: 'syntax-error', message, probes: locate(source) };
  }
}

// ---------- Finding out WHERE ----------
//
// `new Function` answers "does this parse?" and nothing else: no line,
// no column, not even a position in `err.stack`, which stops at
// `at new Function (<anonymous>)`. V8 does report a position when a
// classic `<script>` fails to parse — the window `error` event carries
// `lineno` and `colno` — so once the verdict is in we compile the same
// text a second way, purely to locate the error it already found.
//
// **Appending a `<script>` normally runs it.** What keeps this
// compile-only is the sentinel below, not luck; see `PROBE_SENTINEL`.
//
// Two probes, because neither framing is faithful on its own:
//
//   - **wrapped** reproduces `new Function`'s semantics exactly — the
//     text is a function body, so a top-level `return` is legal, as it
//     is in the entry we actually inject. Its weakness is that a
//     source with unbalanced braces swallows the wrapper's closing
//     `}`, and the parse then runs on to a later, different error.
//   - **raw** has no wrapper to swallow, so it places a stray or
//     missing brace exactly — but it is a *Script*, where a top-level
//     `return` is an error V8 would never have raised for real.
//
// The caller picks. See `selectParseLocation` in parse-location.ts.
function locate(source: string): ParseProbes | undefined {
  try {
    return {
      wrapped: runProbe(`${WRAPPER_HEAD}${source}${WRAPPER_TAIL}${PROBE_SENTINEL}`, 1),
      raw: runProbe(`${source}${PROBE_SENTINEL}`, 0),
    };
  } catch {
    // Locating is a nicety; the verdict is the product. Never let a
    // DOM failure here turn a usable `syntax-error` into a throw.
    return undefined;
  }
}

// An unmatched OPENER, appended to whatever we compile, so the probe
// script can never parse — and therefore can never execute a single
// statement, since a parse failure aborts the whole script before
// evaluation begins.
//
// It has to be an opener. A closing `}` or `)` would be *closed by*
// whatever the source left dangling: appending `}` to a source ending
// in `if (1) {` produces a valid program, and it runs. An opener at
// end of input has nothing after it to close it.
//
// The leading newline matters too — without it a source whose last
// line is a `//` comment swallows the sentinel.
//
// V8 reports the FIRST error it hits, so a real error in the source is
// still the one reported; the sentinel only speaks when the source had
// nothing to say. A probe that comes back with NO error at all would
// therefore mean the sentinel failed to do its job and the source ran —
// so it reports no position, and `selectParseLocation` simply has one
// fewer probe to choose from.
const PROBE_SENTINEL = '\n(';
const WRAPPER_HEAD = 'function __smParseProbe__() {\n';
const WRAPPER_TAIL = '\n}';

// Compile `text` as a classic script and report where it failed.
// `lineOffset` is how many lines of our own framing precede the
// source, so the caller gets source coordinates back.
function runProbe(text: string, lineOffset: number): ParseProbeResult | undefined {
  let hit: ParseProbeResult | undefined;
  const onError = (event: ErrorEvent): void => {
    hit = {
      // `event.error.message` is the clean one; `event.message` has
      // "Uncaught SyntaxError: " in front of it as well.
      message: stripDomPrefix(event.error instanceof Error ? event.error.message : event.message),
      line: event.lineno - lineOffset,
      column: event.colno,
    };
    // Marks the error handled, which is what stops Chrome reporting it
    // as an uncaught page error — and an uncaught error in an
    // extension context is forwarded into chrome://extensions/?errors,
    // making SourceMonkey look broken when it is working exactly as
    // designed. Verified: without this the error surfaces, with it the
    // console stays clean. See CLAUDE.md.
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  const el = document.createElement('script');
  el.textContent = text;
  try {
    // The parse — and the `error` event it fires — both happen
    // synchronously inside this call, which is why `hit` is readable
    // immediately after it and no async plumbing is needed.
    document.body.append(el);
  } finally {
    el.remove();
    window.removeEventListener('error', onError);
  }
  return hit;
}

// Inserting the script means the SyntaxError arrives wrapped in the
// DOM method that raised it: "Failed to execute 'append' on 'Element':
// Unexpected token ';'". Strip it so the message we may end up showing
// is about the user's code and not about our insertion trick. Matched
// loosely rather than by exact string so a different insertion method
// (or wording) degrades to a cosmetic prefix rather than a wrong
// message — and `selectParseLocation` compares with `endsWith`, so an
// unstripped prefix still matches.
function stripDomPrefix(message: string): string {
  return message.replace(/^Failed to execute '[^']*' on '[^']*': /, '');
}

window.addEventListener('message', (event: MessageEvent) => {
  // Only our embedder may ask.
  if (event.source !== window.parent) return;
  const data = event.data as Partial<ParseRequest> | null;
  if (!data || data.type !== 'sm:parse-check') return;
  if (!Array.isArray(data.sources) || typeof data.id !== 'string') return;
  const verdicts = data.sources.map((s) => checkOne(typeof s === 'string' ? s : ''));
  // Reply to the embedder only, and to nothing else. A sandboxed page
  // has an opaque origin, so the target origin has to be '*' — which
  // makes the `event.source` check the only thing standing between us
  // and replying to an arbitrary window. Nothing can reach this page
  // today (the manifest declares no `web_accessible_resources`, so no
  // web page can frame or navigate to it), so this enforces the
  // property rather than relying on it staying true.
  window.parent.postMessage({ type: 'sm:parse-check-result', id: data.id, verdicts }, '*');
});

// Announce readiness. The embedder cannot detect it any other way: a
// sandboxed frame is opaque-origin, so its `contentDocument` is always
// null and `readyState` is unreadable from outside. Without this the
// embedder's only signal is the iframe's `load` event, and a listener
// attached even a moment late would miss it — leaving every request to
// time out silently for the rest of the session.
window.parent.postMessage({ type: 'sm:parse-sandbox-ready' }, '*');
