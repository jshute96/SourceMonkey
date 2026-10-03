// Service-worker side of the compile-only parse check.
//
// ---------- What this answers ----------
//
// "Would V8 accept the code we are about to register?" — asked at
// install / refresh time rather than discovered at injection time.
//
// Before this existed, a `@require` with a syntax error (a truncated
// CDN response, an HTML error page that squeaked past the content-type
// gate) made the whole concatenated entry fail to parse. The seal
// entry caught it and logged "Script source failed to parse (a
// @require or the script body has a syntax error); nothing was run" —
// but only on a page the script matched. Checking up front turns that
// into an `invalid` status on the collections page, next to the script,
// the moment it is added or refreshed.
//
// The verdict is about the whole composed program, so on its own it
// says nothing about WHERE. The sandbox answers that separately, by
// compiling the same text a second way to get a line and column out of
// V8, and `parse-location.ts` maps that line back to the `@require`
// (or the body) it was written in.
//
// This is the SERVICE WORKER's route to the sandbox. Extension pages
// have a DOM and embed their own sandbox frame instead — see
// `parse-check-client.ts`. Both share `parse-sandbox-host.ts`.
//
// ---------- Why the SW route takes three contexts ----------
//
// `new Function(src)` compiles without executing, which is exactly the
// check — and it is V8's own verdict on the same text we inject, not a
// bundled parser's opinion about a similar text. But it is `eval` as
// far as CSP is concerned, and MV3's extension CSP forbids that in the
// service worker, in extension pages, and in offscreen documents.
//
// A **sandboxed page** may declare `'unsafe-eval'`, and is the only
// context that may. It also has an opaque origin and no `chrome.*`, so
// it cannot be messaged by the service worker directly. Hence:
//
//   service worker  →  offscreen document  →  sandboxed iframe
//     (chrome.*,          (chrome.* + DOM,        ('unsafe-eval',
//      no DOM,             no eval)                no chrome.*)
//      no eval)
//
// Considered and rejected: bundling a real parser (acorn, vendored the
// way Prism is). It needs no offscreen machinery and runs synchronously
// in the worker — but it parses a *Program* where our injected code is
// a *function body*, so it disagrees with V8 on top-level `return`,
// `await` and `new.target`. Those appear in real userscripts, and a
// parser that rejects code V8 accepts would flip working scripts to
// invalid. Being wrong in that direction is much worse than the setup
// cost here.
//
// ---------- Failing open ----------
//
// Every failure of this machinery itself — no `chrome.offscreen`, the
// document won't open, the sandbox never answers — resolves to "I
// don't know", never to "didn't parse". A script that works must not
// be marked invalid because our plumbing broke. The seal entry is
// still in place as the backstop, so a parse failure we miss here is
// reported at run time exactly as it was before.

import { dlog } from '../debug-log.js';
import { PARSE_CHECK_MSG, type ParseVerdict } from '../parse-check-protocol.js';

const OFFSCREEN_URL = 'offscreen.html';

// How long to wait for the sandbox before giving up on a batch. The
// compile itself is fast (V8 parsing a few hundred KB), so this is a
// guard against the offscreen document being torn down mid-flight
// rather than a realistic budget. Kept short because opportunistic
// refresh runs on the navigation path: a wedged check should cost a
// moment, not ten seconds per pass.
const PARSE_TIMEOUT_MS = 3_000;

// After this many consecutive failures, stop trying for the rest of
// the service-worker's life. Without it, a permanently broken sandbox
// costs every refresh a full timeout per script forever — a
// degraded-capability path that gets slower the more scripts you have
// is worse than one that turns itself off.
const FAILURE_LIMIT = 3;
let consecutiveFailures = 0;

// `chrome.offscreen.createDocument` rejects if one already exists, and
// there is no "create if absent" call. Serializing through one promise
// keeps two concurrent refreshes from racing into that rejection.
let creating: Promise<void> | null = null;



// True when this browser can run the check at all. Chrome gained
// `chrome.offscreen` in 109; we don't support anything near that old,
// but the guard also covers test environments and any future context
// where the API is absent.
export function parseCheckAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.offscreen;
}

// Reset the circuit breaker. Exposed for tests, which need a clean
// slate between cases that deliberately break the machinery.
export function resetParseCheckFailures(): void {
  consecutiveFailures = 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    // hasDocument() landed alongside the API; getContexts() is the
    // newer spelling. Prefer whichever exists rather than assuming.
    const existing = await hasOffscreenDocument();
    if (existing) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
      justification:
        'Compile userscript source in a sandboxed iframe to detect syntax errors without running it.',
    });
  })().finally(() => {
    creating = null;
  });
  return creating;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const runtime = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  };
  if (runtime.getContexts) {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }
  const offscreen = chrome.offscreen as typeof chrome.offscreen & {
    hasDocument?: () => Promise<boolean>;
  };
  return offscreen.hasDocument ? offscreen.hasDocument() : false;
}

// Compile each source independently. Returns one verdict per input, or
// null when the check could not be performed at all — callers must
// treat null as "unknown", never as failure. See "Failing open" above.
export async function checkParses(sources: readonly string[]): Promise<ParseVerdict[] | null> {
  if (sources.length === 0) return [];
  if (!parseCheckAvailable()) return null;
  if (consecutiveFailures >= FAILURE_LIMIT) return null;
  try {
    await ensureOffscreenDocument();
    // Correlating a reply with its request is the sandbox host's job
    // (`parse-sandbox-host.ts`) — this leg is a single awaited
    // sendMessage, so there is nothing here to mix up.
    const reply = await withTimeout(
      chrome.runtime.sendMessage({ type: PARSE_CHECK_MSG, sources }),
      PARSE_TIMEOUT_MS,
    );
    const verdicts = (reply as { verdicts?: ParseVerdict[] } | undefined)?.verdicts;
    if (!Array.isArray(verdicts) || verdicts.length !== sources.length) {
      dlog('[SourceMonkey] parse check returned no usable verdicts');
      consecutiveFailures++;
      return null;
    }
    consecutiveFailures = 0;
    return verdicts;
  } catch (err) {
    // console.info, not .warn/.error: this is a degraded-capability
    // path, not an extension bug, and Chrome forwards warn/error into
    // chrome://extensions/?errors.
    console.info('[SourceMonkey] parse check unavailable', err);
    consecutiveFailures++;
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parse check timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
