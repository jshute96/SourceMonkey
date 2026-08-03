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
// from `src/parse-check.ts`, which is the source of truth; they are
// small and change together.

interface ParseRequest {
  type: 'sm:parse-check';
  // Correlates the reply. The offscreen relay round-trips it.
  id: string;
  // Each entry is compiled independently, as a FUNCTION BODY — which
  // is what the injected entry actually is, so constructs that are
  // legal there and nowhere else (a top-level `return`) don't produce
  // a spurious failure.
  sources: string[];
}

interface ParseVerdict {
  status: 'ok' | 'syntax-error' | 'unknown';
  // V8 gives no line or column for a `new Function` SyntaxError —
  // not in the message, not in the stack — so this is the message
  // alone.
  message?: string;
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
    return { status: 'syntax-error', message };
  }
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
