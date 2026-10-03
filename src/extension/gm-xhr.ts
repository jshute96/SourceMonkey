// SW-side `GM_xmlhttpRequest` handler. Drives `fetch` against the
// page's request, sends events back to the originating tab via
// `chrome.tabs.sendMessage`. Supports text and binary response types
// (text/json/blob/arraybuffer/document) and `@connect` URL gating.
// Requests are credentialed (the user's cookies go out) unless the
// caller passes `anonymous: true` — see `runXhr`.
// Headers `fetch` refuses to send (Origin / Cookie / Referer /
// Sec-Fetch-*) travel as a declarativeNetRequest rule instead — see
// `gm-xhr-headers.ts`.
//
// Wire protocol:
//
//   (The payload types are in gm-xhr-types.ts.)
//
//   Page → SW: `sm:gm-xhr-start`
//     { type, id, scriptId, request: GmXhrRequestPayload }
//
//   Page → SW: `sm:gm-xhr-abort`
//     { type, id }
//
//   SW → page: `sm:gm-xhr-event`
//     { type, id, event: GmXhrEvent }
//
// `id` is a per-request UUID-ish string the page generates. The SW
// just round-trips it.
//
// Two safety limits live here:
//   - Response size cap (MAX_RESPONSE_BYTES): the body is streamed and
//     the request is aborted if it exceeds the cap, so a userscript
//     fetching a multi-GB resource can't OOM the service worker.
//   - `@connect` redirect re-validation: `fetch` follows redirects by
//     default, so an allowlisted host could 302 to a disallowed one.
//     The caller passes `isFinalUrlAllowed`; if the response came back
//     from a redirected URL whose host fails the policy, we drop the
//     body and return an error instead of handing it to the script.
//     This blocks *reading* responses from non-allowlisted hosts; it
//     can't prevent the request reaching the redirect target (fetch
//     gives no per-hop hook and `redirect:'manual'` yields an opaque
//     response with no readable Location), so the outbound hop still
//     happens — but no disallowed-host data flows back to the script.
//     That hop carries the user's cookies, so a script can provoke a
//     credentialed request to an off-allowlist host it can't read the
//     answer from. Blind, but a real side effect.
//
// AbortController per request. Stored in a Map keyed by id so an
// aborted request can be cancelled mid-fetch.

import { bytesToBase64 } from '../bytes.js';
import {
  connectBlockedMessage,
  headerRuleFailedMessage,
  headerStallMessage,
} from '../gm-connect.js';
import {
  buildHeaderRule,
  splitHeaders,
  whenStaleRulesCleared,
  type HeaderRuleSpec,
} from './gm-xhr-headers.js';
import type { GmXhrEvent, GmXhrRequestPayload } from '../gm-xhr-types.js';

// Per-request abort handles. Key: request id. `tabId` is the tab that
// asked, so closing it can cancel what it left running — see
// `abortXhrsForTab`.
interface ActiveXhr {
  controller: AbortController;
  tabId: number | null;
}
const activeXhrs = new Map<string, ActiveXhr>();

// How long a request may go without *response headers* before the
// worker gives up on it. Deliberately not a request timeout:
//
//   - `GM_xmlhttpRequest` has no default `timeout`, matching TM/VM, and
//     adding one would kill slow but healthy transfers — a 50 MB body
//     on a bad connection can legitimately run for minutes.
//   - What has to be bounded is the *header* phase, because that is
//     exactly what the request's header rule waits on: the rule is
//     removed the moment `fetch` resolves, so a slow body holds
//     nothing, while a server that accepts the connection and never
//     answers would keep a rule (and its id) alive indefinitely.
//   - So the timer covers time-to-first-byte only, and is cleared as
//     soon as headers arrive. A download that takes an hour after that
//     is left alone.
//
// Two minutes is far past any healthy time-to-first-byte and well under
// the page-side `XHR_PAGE_SIDE_TTL_MS` (5 minutes, in
// `wrapper-gm-runtime.js`), so the worker reports a wedged request
// itself rather than racing the page's own giving-up. Keep it that way:
// if it ever exceeds the page TTL, both would fire and a script would
// see whichever won.
const XHR_HEADER_STALL_MS = 2 * 60 * 1000;

// Cap on the response body we'll buffer into the service worker. A
// userscript that fetches a huge resource would otherwise OOM the SW
// (we hold the whole body in memory, and base64 for binary adds ~33%).
// 50 MB is comfortably above any realistic GM_xmlhttpRequest payload
// (icons, JSON, small media) while bounding the blast radius.
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

// Sentinel thrown by `readBodyCapped` when the body exceeds the cap, so
// the catch in `runXhr` can map it to a clean error event.
class ResponseTooLargeError extends Error {
  constructor() {
    super(`response exceeded ${MAX_RESPONSE_BYTES}-byte cap`);
    this.name = 'ResponseTooLargeError';
  }
}

// Stream the body into a single Uint8Array, aborting once the running
// total exceeds the cap. Used for both the binary and text paths so the
// cap applies uniformly. Reading the bytes ourselves (rather than
// res.text() / res.arrayBuffer()) is what lets us bail mid-stream
// instead of materializing an unbounded body first.
async function readBodyCapped(res: Response, cap: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No readable stream (e.g. empty body, 204, some HEADs). Fall back
    // to arrayBuffer, still enforcing the cap after the fact.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > cap) throw new ResponseTooLargeError();
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* already torn down */ }
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// Render the response headers as a single newline-joined string —
// TM/VM convention; userscripts call `getResponseHeader(name)`-style
// helpers on this. Each header is `Name: value\r\n`; we use `\r\n`
// per spec but `\n` would also work.
function serializeHeaders(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, name) => {
    lines.push(`${name}: ${value}`);
  });
  // Trailing CRLF after the last header — TM/VM behavior. Userscripts
  // that split on \r\n and iterate get the expected N entries (rather
  // than N-1 trailing-token-eaten).
  return lines.length === 0 ? '' : lines.join('\r\n') + '\r\n';
}

// Run a fetch on behalf of the page. Always resolves to the event to
// send back, including for aborts and timeouts — the page-side runtime
// fires its own `onabort` immediately as well, so a script sees that
// one first.
//
// `checkFinalUrl`, when supplied, re-checks the response's URL against
// the script's `@connect` policy after redirects. A response that
// landed on a disallowed host (via a redirect the initial check
// couldn't see) is dropped with an error event rather than returned.
// It hands back `undeclared` too, so the error blames the right thing
// — a script with no `@connect` lines has no rules to be blocked BY.
//
// Request headers the browser's `fetch` refuses to send (`Origin`,
// `Cookie`, `Sec-Fetch-*`) go out by a short-lived declarativeNetRequest
// rule around the request (docs/xhr-header-surgery.md).
export type FinalUrlCheck = (url: string) => { allowed: boolean; undeclared: boolean };

export async function runXhr(
  id: string,
  request: GmXhrRequestPayload,
  checkFinalUrl?: FinalUrlCheck,
  tabId: number | null = null,
): Promise<GmXhrEvent> {
  const controller = new AbortController();
  activeXhrs.set(id, { controller, tabId });
  // Timeout: setTimeout that aborts the controller. We track the
  // timer so we can clear it on completion.
  let timeoutFired = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let headerStallFired = false;
  let headerStallTimer: ReturnType<typeof setTimeout> | null = null;
  // Every path out of an aborted controller decides the terminal event
  // here. The script's `timeout`, the header-stall backstop and a plain
  // `abort()` all abort the *same* controller, so the shadow flags are
  // the only thing separating them.
  //
  // The script's own timeout outranks the backstop: if both fired, the
  // one it asked for is the one it should hear about.
  const terminalAbortEvent = (): GmXhrEvent => {
    if (timeoutFired) return { kind: 'timeout' };
    if (headerStallFired) {
      return { kind: 'error', message: headerStallMessage(XHR_HEADER_STALL_MS) };
    }
    return { kind: 'abort' };
  };
  if (request.timeout && request.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      timeoutFired = true;
      controller.abort();
    }, request.timeout);
  }
  const clearHeaderStall = (): void => {
    if (headerStallTimer != null) {
      clearTimeout(headerStallTimer);
      headerStallTimer = null;
    }
  };
  // Header-phase backstop. Armed just before the rule install rather
  // than just before the fetch: the install is the only other await
  // that could wedge, and covering it costs nothing since it normally
  // takes a millisecond.
  const startHeaderStall = (): void => {
    headerStallTimer = setTimeout(() => {
      headerStallFired = true;
      controller.abort();
    }, XHR_HEADER_STALL_MS);
  };
  // Headers `fetch` would drop travel as a DNR rule instead; the rest
  // ride along on the request. `installedRuleId` is held so the rule
  // comes off however the request ends.
  const { passthrough, surgical } = splitHeaders(request.headers);
  let installedRuleId: number | null = null;
  try {
    const method = (request.method ?? 'GET').toUpperCase();
    // Built once: `buildHeaderRule` allocates an id, so asking it twice
    // would burn one and answer a different question the second time.
    // Where there is a rule, `spec.target` is the URL to fetch — the
    // same tagged string the rule matches on, which is what makes the
    // rule apply to this request and no other.
    const spec = buildHeaderRule(request.url, surgical, method);
    startHeaderStall();
    if (spec) {
      installedRuleId = await installHeaderRule(spec);
      // Refuse rather than send something the script didn't ask for.
      // The headers it wanted are the ones the browser won't let it
      // set, so a silent fallback isn't "the request minus a header": a
      // `Cookie` override that doesn't apply sends the user's real
      // session instead of the script's — the opposite of the ask.
      // A rule that exists only to strip our own `Origin` is not the
      // script's request, so that one falls back quietly.
      if (installedRuleId == null && Object.keys(surgical).length > 0) {
        return { kind: 'error', message: headerRuleFailedMessage() };
      }
    }
    const init: RequestInit = {
      method,
      headers: Object.keys(passthrough).length > 0 ? passthrough : undefined,
      // Credentialed by default, matching Tampermonkey/Violentmonkey —
      // the point of GM_xmlhttpRequest is usually to read another site
      // *as the signed-in user*, and `anonymous: true` opts out.
      //
      // 'include' is stated rather than left to the default because the
      // default's behavior here isn't ours to rely on: Chrome already
      // attaches cookies to an extension fetch aimed at a host the
      // extension has permission for (we hold `<all_urls>`), so
      // 'same-origin' happens to send them today. That is a property of
      // the host-permission grant, not of the request we wrote. Saying
      // 'include' pins the intent and gives `anonymous` a symmetric
      // counterpart.
      //
      // The `@connect` allowlist is what gates which hosts a script may
      // act as the user on.
      credentials: request.anonymous ? 'omit' : 'include',
      signal: controller.signal,
    };
    // GET / HEAD with no body — fetch() rejects "body not allowed".
    if (request.data != null && init.method !== 'GET' && init.method !== 'HEAD') {
      init.body = typeof request.data === 'string' ? request.data : String(request.data);
    }
    // The tagged URL where there's a rule: the tag is what the rule
    // matches on, and it never leaves the browser (a fragment isn't
    // transmitted, and `res.url` comes back without it).
    const res = await fetch(spec?.target ?? request.url, init);
    // Headers are in, so the stall backstop has nothing left to guard —
    // whatever the body does from here is the download's business.
    clearHeaderStall();
    // The rule has done its job the moment the request is on the wire,
    // and `fetch` resolving means the response headers are already
    // back. Dropping it here rather than in `finally` keeps a slow
    // download from holding a rule (and its id) for the whole transfer.
    if (installedRuleId != null) {
      const ruleId = installedRuleId;
      installedRuleId = null;
      await removeHeaderRule(ruleId);
    }
    // @connect redirect re-validation: if fetch followed a redirect to
    // a host the policy doesn't allow, refuse to read or return the
    // body. (See the file header for why the outbound hop can't be
    // prevented here.) We only check on actual redirects — an
    // un-redirected response is on the host the initial check already
    // approved.
    const final = res.redirected && checkFinalUrl ? checkFinalUrl(res.url) : null;
    if (final && !final.allowed) {
      let host = res.url;
      try { host = new URL(res.url).hostname; } catch { /* keep full url */ }
      return {
        kind: 'error',
        message: connectBlockedMessage(`redirect to ${host} not allowed`, final.undeclared),
      };
    }
    const rt = request.responseType ?? 'text';
    const isBinary = rt === 'blob' || rt === 'arraybuffer' || rt === 'document';
    const mimeType = res.headers.get('content-type') ?? '';
    const bytes = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    if (isBinary) {
      // Binary path: serialize the body as base64 + carry the MIME
      // type. The page-side reconstructs Blob / ArrayBuffer /
      // Document. We use base64 (text) rather than `Array<byte>` or
      // raw bytes because chrome.tabs.sendMessage's structured-clone
      // path through the event listener doesn't always preserve
      // ArrayBuffer cleanly across worlds; base64 always works.
      const base64 = bytesToBase64(bytes);
      return {
        kind: 'load',
        response: {
          status: res.status,
          statusText: res.statusText,
          responseURL: res.url,
          responseText: '',
          response: null,
          responseBase64: base64,
          responseMimeType: mimeType,
          responseHeaders: serializeHeaders(res.headers),
          finalUrl: res.url,
        },
      };
    }
    // Text path. Response.text() decodes as UTF-8 (ignoring the
    // Content-Type charset) and strips a leading BOM; TextDecoder's
    // default does the same, so decoding the capped bytes here matches
    // the prior res.text() behavior exactly.
    const responseText = new TextDecoder().decode(bytes);
    let response: unknown = responseText;
    if (rt === 'json') {
      // Tolerate a malformed JSON body — return the raw text in
      // `response` if parsing fails. The userscript can still read
      // `responseText` to debug.
      try { response = JSON.parse(responseText); } catch { response = null; }
    }
    return {
      kind: 'load',
      response: {
        status: res.status,
        statusText: res.statusText,
        responseURL: res.url,
        responseText,
        response,
        responseHeaders: serializeHeaders(res.headers),
        finalUrl: res.url,
      },
    };
  } catch (err) {
    // Distinguish abort vs. timeout vs. error. AbortController-driven
    // aborts surface as DOMException name='AbortError'; we use a
    // shadow flag set by the timeout handler to know which one.
    const isAbortError =
      err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
    // Precedence, unchanged: the script's own timeout outranks
    // everything, then the size cap (which aborts the controller itself,
    // so it must be claimed before the abort ladder), then the aborts.
    if (timeoutFired) return terminalAbortEvent();
    if (err instanceof ResponseTooLargeError) {
      return { kind: 'error', message: `[SourceMonkey] ${err.message}` };
    }
    if (headerStallFired || isAbortError) return terminalAbortEvent();
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  } finally {
    if (timeoutTimer != null) clearTimeout(timeoutTimer);
    clearHeaderStall();
    activeXhrs.delete(id);
    // Backstop for the abort, timeout and error paths — the success
    // path already dropped it. `removeHeaderRule` swallows its own
    // failures, so this can't reject out of the `finally`.
    if (installedRuleId != null) await removeHeaderRule(installedRuleId);
  }
}

// Install one request's header rule. Returns the id to remove
// afterwards, or null if it couldn't be installed — the caller decides
// whether that is fatal (it is, when the script asked for the headers).
async function installHeaderRule(spec: HeaderRuleSpec): Promise<number | null> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) return null;
  // The startup sweep reads every session rule and deletes the ones in
  // our band. A rule added while that read is in flight is in its
  // snapshot, so installing first would let the sweep delete a live
  // rule. Wait it out — it runs once per worker life.
  await whenStaleRulesCleared();
  try {
    // Clear the id first: `addRules` rejects a duplicate id outright,
    // and an id can still be occupied if a rule ever escaped its
    // `finally` (the counter wraps). Dropping a stale rule of ours is
    // right anyway — its request is long gone.
    await dnr.updateSessionRules({ removeRuleIds: [spec.id], addRules: [spec.rule] });
    return spec.id;
  } catch (err) {
    console.info('[SourceMonkey] could not apply GM_xmlhttpRequest header rule', err);
    return null;
  }
}

// Take one request's rule back off. A rule that survives its request
// matches nothing *this* worker will request — the counter has moved
// past its tag — but the tag comes back when the next worker restarts
// the counter, so it is worth a second attempt before giving up and
// saying so. What catches the leftover is the startup sweep and the
// id pre-clear in `installHeaderRule`.
async function removeHeaderRule(ruleId: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
      return;
    } catch (err) {
      if (attempt === 1) {
        console.info(
          '[SourceMonkey] could not remove a GM_xmlhttpRequest header rule; it stays live until the next startup sweep',
          err,
        );
      }
    }
  }
}

// Resolve a request URL the way TM/VM do: a relative `url` (`/api/x`,
// `./data.json`) is relative to the **page**, not to the service
// worker. Without this the SW's `new URL(url)` throws and the request
// dies as "invalid URL" — a script doing `GM_xmlhttpRequest({url:
// '/api/x'})` works in every other manager.
//
// `pageUrl` is the sender's document URL, `pageOrigin` its origin.
// The origin is the second try, for a frame whose document URL is no
// base at all (`about:blank`, `srcdoc`) but which inherited a real
// origin. Only a **root**-relative URL (`/api/x`, `//host/x`) falls
// back to it: those mean the same thing against an origin as against
// a full URL, while a document-relative `data.json` would silently
// become `/data.json` — a different request from the one the script
// asked for, which is worse than reporting a URL we can't resolve.
// When neither base works the original string is returned unchanged,
// so the caller's own error handling still applies.
//
// Deliberately NOT resolved against the document's `<base href>`: the
// SW can't see it. A page that sets `<base>` and a script that uses a
// relative GM_xmlhttpRequest URL is rare enough to leave for a real
// report — see `TODO.md`.
export function resolveXhrUrl(
  url: string,
  pageUrl: string | undefined,
  pageOrigin?: string,
): string {
  for (const base of [pageUrl, url.startsWith('/') ? pageOrigin : undefined]) {
    if (!base) continue;
    try {
      return new URL(url, base).href;
    } catch { /* this base is unusable — try the next */ }
  }
  return url;
}

// Cancel an in-flight request by id. Idempotent — calling abort on a
// completed request is a no-op (the entry is gone).
export function abortXhr(id: string): boolean {
  const entry = activeXhrs.get(id);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

// Cancel everything a closed tab left running. Its page is gone, so no
// terminal event can be delivered and nobody is waiting for the body —
// but without this the fetch runs to completion in the worker, holding
// its header rule live for as long as the server keeps the connection
// open.
//
// Safe to iterate while aborting: the entry is removed in `runXhr`'s
// `finally`, which runs in a later microtask, and a Map iterator
// tolerates deletion regardless.
export function abortXhrsForTab(tabId: number): void {
  for (const entry of activeXhrs.values()) {
    if (entry.tabId === tabId) entry.controller.abort();
  }
}
