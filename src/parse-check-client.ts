// Page-side half of the compile-only parse check.
//
// The load pipeline runs wherever it was called from: `addSource` /
// `updateSource` / `updateScript` invoked from the sources page or the
// viewer execute in that PAGE, not in the service worker. A page with
// no checker installed silently skipped the check — which didn't
// merely leave the row unverified, it CLEARED a previous `invalid`
// verdict and reported "loads cleanly again" for a script that still
// doesn't parse.
//
// A page has a DOM, so it embeds its own `parse-sandbox.html` and
// compiles locally — `parse-sandbox-host.ts` does the driving, exactly
// as it does for the offscreen document on the service worker's
// behalf. The service worker is not involved:
//
//   - no SW wake on the path behind an Install click;
//   - no structured clone of the whole script (bodies, `@require`
//     bodies, base64 `@resource` blobs) to every extension context;
//   - no dependency on the SW surviving the round trip;
//   - and pages check in parallel rather than queueing behind one
//     single-threaded worker and its one shared sandbox.
//
// Only the transport differs from the service worker's checker. Both
// compose the checked text with `buildParseCheckSource`, so both judge
// the same program.
//
// Fails open like every other leg of this feature (see
// [docs/parse-check.md]): a sandbox that won't load, a timeout, a
// verdict in an unrecognised shape, or a throw anywhere in between all
// resolve to `null` = "couldn't check", never to "didn't parse". A row
// left unchecked carries no `parseCheckedHash`, so the next
// service-worker refresh performs the check.

import { dlog } from './debug-log.js';
import { isParseCheckDisabled } from './parse-check-protocol.js';
import { createParseSandboxHost, type ParseSandboxHost } from './parse-sandbox-host.js';
import { setParseChecker, type ParseChecker } from './script-store.js';

// Call once at page startup, before anything can touch the store.
// Every extension page that mutates the store needs this — see the
// `addSource` / `updateSource` / `updateScript` callers in
// `sources.ts` and `userscript.ts`.
export function installPageParseChecker(): void {
  setParseChecker(checkScriptParses);
}

// The same check, for a caller that isn't the store: the install
// preview compiles a script it hasn't added yet, so there's no row for
// the store hook to fire on.
export const checkScriptParses: ParseChecker = async (script) => {
  if (await isParseCheckDisabled()) return null;
  try {
    // Imported on demand, not at module scope: `injector.ts` pulls in
    // the GM binding emitter and its catalog, and every page that
    // installs a checker would otherwise pay for that graph during
    // startup — delaying its first render for a check most page loads
    // never run.
    const { buildParseCheckSource } = await import('./injector.js');
    const source = await buildParseCheckSource(script, chrome.runtime.getManifest().version);
    const verdicts = await ensureHost().compile([source]);
    return verdicts ? verdicts[0] : null;
  } catch (err) {
    dlog(`[SourceMonkey] parse check unavailable in this page: ${String(err)}`);
    return null;
  }
};

// One frame per page, created on the first check rather than at
// startup: a page that never adds or refreshes anything (the common
// case for the viewer) never pays for it. Once created it stays for
// the life of the page — checks come in bursts (a Refresh All is one
// per script), and re-creating the frame per check would pay the load
// and readiness handshake every time.
let host: ParseSandboxHost | null = null;

function ensureHost(): ParseSandboxHost {
  if (host) return host;
  const frame = document.createElement('iframe');
  // `src`, not `srcdoc`: the URL has to resolve to the page listed in
  // the manifest's `sandbox.pages`, or the frame inherits this page's
  // CSP and loses the `'unsafe-eval'` that is the entire point.
  frame.src = 'parse-sandbox.html';
  // Belt-and-braces, mirroring offscreen.html: the page is already
  // sandboxed by the manifest key, and this keeps the frame from
  // silently becoming a privileged extension page — with `chrome.*`
  // reachable from whatever it compiles — if that key is ever dropped.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.hidden = true;
  frame.style.display = 'none';
  document.body.append(frame);
  host = createParseSandboxHost(frame);
  return host;
}
