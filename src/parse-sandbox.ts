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
  ok: boolean;
  // Present only when `ok` is false. V8 gives no line or column for a
  // `new Function` SyntaxError — not in the message, not in the stack
  // — so this is the message alone. Attribution to a specific file
  // comes from compiling the pieces separately, not from a position.
  message?: string;
}

// `new Function` compiles the body and returns; it never runs it. A
// SyntaxError anywhere in the text is the answer we want.
function checkOne(source: string): ParseVerdict {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source);
    return { ok: true };
  } catch (err) {
    // Anything non-SyntaxError would be surprising (a RangeError from
    // a pathologically nested source is the plausible one), but the
    // caller only needs "V8 refused this, and here is what it said".
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Partial<ParseRequest> | null;
  if (!data || data.type !== 'sm:parse-check') return;
  if (!Array.isArray(data.sources) || typeof data.id !== 'string') return;
  const verdicts = data.sources.map((s) => checkOne(typeof s === 'string' ? s : ''));
  // Reply to the embedder only. `event.source` is the window that sent
  // the request; a sandboxed page has an opaque origin so the target
  // origin must be '*', which is safe here because the embedder is the
  // only window that can reach us (no other context has our URL, and
  // we never call postMessage on anything else).
  const source = event.source as WindowProxy | null;
  source?.postMessage({ type: 'sm:parse-check-result', id: data.id, verdicts }, '*');
});
