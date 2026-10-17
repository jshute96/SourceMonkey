// Page-side compile-only parse check, for the install preview: it
// compiles a script it hasn't added yet, before the user decides, so
// there's no stored row for the store's checker to run on.
//
// Every stored row is checked in the service worker, which runs every
// refresh, add and install (docs/worker-writes.md), through the
// offscreen document.
//
// A page has a DOM, so it embeds its own `parse-sandbox.html` and
// compiles locally — `parse-sandbox-host.ts` does the driving, exactly
// as it does for the offscreen document on the service worker's
// behalf. The service worker is not involved: no wake, and no copy of
// the script across contexts, before the user has even chosen to
// install.
//
// Only the transport differs from the service worker's checker. Both
// compose the checked text with `buildParseCheckSource`, so both judge
// the same program.
//
// Fails open like every other leg of this feature (see
// [docs/parse-check.md]): a sandbox that won't load, a timeout, a
// verdict in an unrecognised shape, or a throw anywhere in between all
// resolve to `null` = "couldn't check", never to "didn't parse".

import { buildParseCheckSource } from '../composed-source.js';
import { dlog } from '../debug-log.js';
import { attachParseLocation } from '../parse-location.js';
import { isParseCheckDisabled } from '../parse-check-protocol.js';
import { createParseSandboxHost, type ParseSandboxHost } from './parse-sandbox-host.js';
import type { ParseChecker } from '../script-build.js';

export const checkScriptParses: ParseChecker = async (script) => {
  if (await isParseCheckDisabled()) return null;
  try {
    const source = buildParseCheckSource(script);
    const verdicts = await ensureHost().compile([source.text]);
    // Resolved here rather than by the caller: `source` is what maps a
    // reported line back to a file, and this is the last point where
    // we still hold it.
    return verdicts ? attachParseLocation(verdicts[0], source) : null;
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
