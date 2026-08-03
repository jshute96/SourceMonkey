// Offscreen-document relay for the sandboxed parse check.
//
// The service worker sends `sm:parse-check` here over
// `chrome.runtime.sendMessage`; we forward it to the sandboxed iframe
// over postMessage and hand the verdicts back. See `offscreen.html`
// for why the work is split across two contexts, and
// `parse-sandbox.html` for why the compile has to happen in a sandbox.

import { PARSE_CHECK_MSG, PARSE_CHECK_RESULT_MSG, type ParseVerdict } from './parse-check-protocol.js';

const frame = document.getElementById('parse-sandbox') as HTMLIFrameElement;

// Requests waiting on the sandbox, by correlation id.
const pending = new Map<string, (verdicts: ParseVerdict[]) => void>();

// The iframe may still be loading when the first request arrives — the
// service worker creates this document and messages it immediately.
// Resolve once, then reuse.
const frameReady: Promise<void> = new Promise((resolve) => {
  if (frame.contentWindow && frame.contentDocument?.readyState === 'complete') {
    resolve();
    return;
  }
  frame.addEventListener('load', () => resolve(), { once: true });
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type?: string; id?: string; sources?: string[] } | null;
  if (!msg || msg.type !== PARSE_CHECK_MSG) return undefined;
  if (typeof msg.id !== 'string' || !Array.isArray(msg.sources)) return undefined;
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
    const verdicts = await new Promise<ParseVerdict[]>((resolve) => {
      pending.set(msg.id!, resolve);
      win.postMessage({ type: PARSE_CHECK_MSG, id: msg.id, sources: msg.sources }, '*');
    });
    sendResponse({ verdicts });
  })();
  // Keep the message channel open for the async reply.
  return true;
});
