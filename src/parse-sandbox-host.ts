// Drives a sandboxed parse page over `postMessage`, for any context
// that has a DOM.
//
// The compile itself must happen in a sandboxed page — `new Function`
// is `eval` as far as CSP is concerned, and a sandboxed page is the
// only place allowed to declare `'unsafe-eval'` (see
// [docs/parse-check.md]). A sandboxed page has an opaque origin and no
// `chrome.*`, so it can only be reached by whoever embeds it.
//
// Two contexts embed one:
//
//   - `offscreen.ts`, on behalf of the service worker. The SW has no
//     DOM, so it cannot host an iframe at all; the offscreen document
//     exists to be the DOM it lacks.
//   - extension pages (`parse-check-client.ts`). A page already has a
//     DOM, so it embeds its own frame and skips the service worker
//     entirely — no wake, no cross-context clone of the script, and no
//     dependency on the SW being alive mid-request.
//
// Both get the same behaviour from here: readiness, correlation,
// timeouts, verdict validation, and the circuit breaker.

import {
  PARSE_CHECK_MSG,
  PARSE_CHECK_RESULT_MSG,
  PARSE_SANDBOX_READY_MSG,
  type ParseStatus,
  type ParseVerdict,
} from './parse-check-protocol.js';

export interface ParseSandboxHost {
  // One verdict per input, or null when the check could not be
  // performed at all. Callers must read null as "unknown", never as
  // failure — see "Failing open" in [docs/parse-check.md].
  compile(sources: readonly string[]): Promise<ParseVerdict[] | null>;
}

// Per-request ceiling. The compile is fast (V8 parsing a few hundred
// KB), so this guards against the frame being torn down mid-flight
// rather than budgeting real work. It also stops `pending` from
// growing a dead resolver per abandoned request — an offscreen
// document outlives service-worker restarts, so "leaks slowly,
// forever" is a real shape there.
//
// Longer than the service worker's own `PARSE_TIMEOUT_MS`
// (`parse-check.ts`), deliberately: the SW is on the navigation path
// and gives up early, this is the last resort that keeps `pending`
// bounded. On the SW route that means the SW usually abandons a stuck
// request before this fires, so the breaker below mostly counts
// failures on the page route.
const REQUEST_TIMEOUT_MS = 8_000;

// Readiness cannot be observed from outside. A sandboxed frame is
// opaque-origin, so `frame.contentDocument` is ALWAYS null and its
// `readyState` is unreadable — an "is it loaded?" fast path looks
// reasonable and can never fire. That leaves two signals, and we take
// whichever arrives first:
//
//   - the sandbox's own ready ping, sent as the last thing it does;
//   - the iframe's `load` event, in case the ping was posted before
//     the listener existed.
//
// The timeout is the third leg, and the important one: without it a
// missed signal wedges readiness forever and every check silently
// times out for the rest of the session. Resolving anyway lets the
// request through — the sandbox is almost certainly up, and if it
// isn't, the per-request timeout reports "couldn't check" rather than
// lying.
const FRAME_READY_TIMEOUT_MS = 2_000;

// After this many consecutive failures, stop trying. Without it a
// permanently broken sandbox costs every refresh a full timeout per
// script forever — a degraded-capability path that gets slower the
// more scripts you have is worse than one that turns itself off.
//
// Per host, not global: one wedged page no longer speaks for the whole
// extension, which is part of what embedding per-context buys.
const FAILURE_LIMIT = 3;

// ...but the trip is not permanent. The offscreen document is never
// torn down and is reused for the life of the browser session, so a
// sticky breaker there would mean three unlucky timeouts disable the
// check until the browser restarts — including after the sandbox
// recovers. Instead a tripped host lets one probe request through per
// cooldown: if it succeeds the breaker resets, if it fails the host
// goes quiet for another cooldown. The cost of staying wedged stays
// bounded, and recovery costs one timeout every 30s rather than never
// happening.
const BREAKER_COOLDOWN_MS = 30_000;

export function createParseSandboxHost(frame: HTMLIFrameElement): ParseSandboxHost {
  // Requests waiting on the sandbox, by correlation id.
  const pending = new Map<string, (verdicts: ParseVerdict[] | null) => void>();
  let consecutiveFailures = 0;
  let breakerTrippedAt = 0;

  const frameReady: Promise<void> = new Promise((resolve) => {
    // Named and removed rather than inline: readiness is answered once,
    // but this listener would otherwise keep type-checking every
    // message reaching the context for as long as it lives.
    const onReadyMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type === PARSE_SANDBOX_READY_MSG) done();
    };
    const done = () => {
      window.removeEventListener('message', onReadyMessage);
      resolve();
    };
    window.addEventListener('message', onReadyMessage);
    frame.addEventListener('load', done, { once: true });
    setTimeout(done, FRAME_READY_TIMEOUT_MS);
  });

  window.addEventListener('message', (event: MessageEvent) => {
    // Only the sandboxed frame can reach an offscreen document in
    // practice, but a normal extension page is a richer target — check
    // the source so nothing else can resolve a request.
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type?: string; id?: string; verdicts?: unknown } | null;
    if (!data || data.type !== PARSE_CHECK_RESULT_MSG) return;
    if (typeof data.id !== 'string' || !Array.isArray(data.verdicts)) return;
    const resolve = pending.get(data.id);
    if (!resolve) return;
    pending.delete(data.id);
    // A verdict we don't recognise is not a verdict. `applyParseCheck`
    // treats anything that isn't `ok`/`unknown` as `invalid`, so an
    // unexpected status string would DISABLE the script — exactly what
    // the three-state design exists to prevent.
    resolve(data.verdicts.every(isParseVerdict) ? (data.verdicts as ParseVerdict[]) : null);
  });

  // Stamp the trip on the failure that reaches the limit, so the
  // cooldown runs from when the host went quiet.
  const noteFailure = (): void => {
    consecutiveFailures++;
    if (consecutiveFailures === FAILURE_LIMIT) breakerTrippedAt = Date.now();
  };

  return {
    async compile(sources: readonly string[]): Promise<ParseVerdict[] | null> {
      if (sources.length === 0) return [];
      if (consecutiveFailures >= FAILURE_LIMIT) {
        if (Date.now() - breakerTrippedAt < BREAKER_COOLDOWN_MS) return null;
        // Probe: let this one through, and re-arm the cooldown now so a
        // second caller during the probe doesn't get a second probe.
        breakerTrippedAt = Date.now();
      }
      await frameReady;
      const win = frame.contentWindow;
      if (!win) {
        // The frame went away (document teardown racing a request).
        noteFailure();
        return null;
      }
      // Random rather than a counter: an offscreen document outlives
      // service-worker restarts, and a counter restarts at zero with
      // it. A reused id can resolve a NEW request with an OLD
      // request's verdicts, which is the one way this machinery could
      // mark a good script invalid.
      const id = crypto.randomUUID();
      const verdicts = await new Promise<ParseVerdict[] | null>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
        win.postMessage({ type: PARSE_CHECK_MSG, id, sources }, '*');
      });
      if (!verdicts || verdicts.length !== sources.length) {
        noteFailure();
        return null;
      }
      consecutiveFailures = 0;
      return verdicts;
    },
  };
}

const PARSE_STATUSES: readonly ParseStatus[] = ['ok', 'syntax-error', 'unknown'];

// Exported for the unit test: this predicate is the last thing between
// an unrecognised status string and `applyParseCheck` disabling the
// script it describes, so it is worth testing directly rather than
// only through a sandbox that would have to be made to misbehave.
export function isParseVerdict(value: unknown): value is ParseVerdict {
  const status = (value as { status?: unknown } | null)?.status;
  return PARSE_STATUSES.includes(status as ParseStatus);
}
