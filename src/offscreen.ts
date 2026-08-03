// Offscreen-document relay for the sandboxed parse check.
//
// The service worker sends `sm:parse-check` here over
// `chrome.runtime.sendMessage`; we forward it to the sandboxed iframe
// over postMessage and hand the verdicts back. See `offscreen.html`
// for why the work is split across two contexts, and
// `parse-sandbox.html` for why the compile has to happen in a sandbox.
//
// This document is the extension's ONE offscreen document — MV3 allows
// no more — so anything else that needs a DOM without a tab (the
// clipboard fallback, `GM_download`) must be added here rather than
// creating its own. Adding a consumer means extending the `reasons`
// array in `parse-check.ts`, which is fixed at creation time.

import {
  PARSE_CHECK_MSG,
  PARSE_CHECK_RESULT_MSG,
  PARSE_SANDBOX_READY_MSG,
  type ParseVerdict,
} from './parse-check-protocol.js';

const frame = document.getElementById('parse-sandbox') as HTMLIFrameElement;

// Requests waiting on the sandbox, by correlation id.
const pending = new Map<string, (verdicts: ParseVerdict[] | null) => void>();

// Readiness cannot be observed from out here. A sandboxed frame is
// opaque-origin, so `frame.contentDocument` is ALWAYS null and its
// `readyState` is unreadable — an "is it loaded?" fast path looks reasonable
// and can never fire. That leaves two signals, and we take whichever
// arrives first:
//
//   - the sandbox's own ready ping, sent as the last thing it does;
//   - the iframe's `load` event, in case the ping was posted before
//     this listener existed.
//
// The timeout is the third leg, and the important one: without it, a
// missed signal wedges `frameReady` forever and every check silently
// times out for the rest of the browser session. Resolving anyway lets
// the request through — the sandbox is almost certainly up, and if it
// isn't the per-request timeout reports "unknown" rather than lying.
const FRAME_READY_TIMEOUT_MS = 2_000;

const frameReady: Promise<void> = new Promise((resolve) => {
  const done = () => resolve();
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    if ((event.data as { type?: string } | null)?.type === PARSE_SANDBOX_READY_MSG) done();
  });
  frame.addEventListener('load', done, { once: true });
  setTimeout(done, FRAME_READY_TIMEOUT_MS);
});

window.addEventListener('message', (event: MessageEvent) => {
  // Only the sandboxed frame can reach us in practice (an offscreen
  // document is not web-accessible), but check the source anyway so a
  // future embedder can't be spoofed into resolving a request.
  if (event.source !== frame.contentWindow) return;
  const data = event.data as { type?: string; id?: string; verdicts?: ParseVerdict[] } | null;
  if (!data || data.type !== PARSE_CHECK_RESULT_MSG) return;
  if (typeof data.id !== 'string' || !Array.isArray(data.verdicts)) return;
  const resolve = pending.get(data.id);
  if (!resolve) return;
  pending.delete(data.id);
  resolve(data.verdicts);
});

// Per-request ceiling. Distinct from the service worker's own timeout:
// this one exists so `pending` can't grow a dead resolver per abandoned
// request. The offscreen document outlives service-worker restarts, so
// "leaks slowly, forever" is a real shape here rather than a
// theoretical one.
const REQUEST_TIMEOUT_MS = 8_000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type?: string; id?: string; sources?: string[] } | null;
  if (!msg || msg.type !== PARSE_CHECK_MSG) return undefined;
  const id = msg.id;
  if (typeof id !== 'string' || !Array.isArray(msg.sources)) return undefined;
  void (async () => {
    await frameReady;
    const win = frame.contentWindow;
    if (!win) {
      // The frame went away (document teardown racing a request).
      // Report it as "couldn't check" rather than "didn't parse" — the
      // caller must not flip a working script to invalid because our
      // plumbing failed.
      sendResponse({ error: 'parse sandbox unavailable' });
      return;
    }
    const verdicts = await new Promise<ParseVerdict[] | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
      win.postMessage({ type: PARSE_CHECK_MSG, id, sources: msg.sources }, '*');
    });
    sendResponse(verdicts ? { verdicts } : { error: 'parse sandbox timed out' });
  })();
  // Keep the message channel open for the async reply.
  return true;
});
