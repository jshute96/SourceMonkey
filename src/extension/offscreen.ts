// Offscreen-document relay for the sandboxed parse check.
//
// The service worker sends `sm:parse-check` here over
// `chrome.runtime.sendMessage`; we hand it to the sandboxed iframe via
// `parse-sandbox-host.ts` and pass the verdicts back. See
// `offscreen.html` for why the work is split across two contexts, and
// `parse-sandbox.html` for why the compile has to happen in a sandbox.
//
// This document exists only because the SERVICE WORKER has no DOM.
// Extension pages have one and embed their own sandbox frame directly
// (`parse-check-client.ts`) — they never come through here.
//
// This is the extension's ONE offscreen document — MV3 allows no more
// — so anything else that needs a DOM without a tab (the clipboard
// fallback, say) must be added here rather than creating its own.
// Adding a consumer means extending the `reasons` array in
// `parse-check.ts`, which is fixed at creation time.

import { PARSE_CHECK_MSG } from '../parse-check-protocol.js';
import { createParseSandboxHost } from './parse-sandbox-host.js';

const host = createParseSandboxHost(
  document.getElementById('parse-sandbox') as HTMLIFrameElement,
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type?: string; sources?: string[] } | null;
  if (!msg || msg.type !== PARSE_CHECK_MSG) return undefined;
  const sources = msg.sources;
  if (!Array.isArray(sources)) return undefined;
  void (async () => {
    const verdicts = await host.compile(sources);
    // No verdicts means the machinery failed, not that the source is
    // bad. The caller must read this as "couldn't check" — never flip a
    // working script to invalid because our plumbing broke.
    sendResponse(verdicts ? { verdicts } : { error: 'parse sandbox unavailable' });
  })();
  // Keep the message channel open for the async reply.
  return true;
});
