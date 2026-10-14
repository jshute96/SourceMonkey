// SW-side `GM_xmlhttpRequest` handler. Drives `fetch` against the
// page's request, sends events back to the originating tab via
// `chrome.tabs.sendMessage`. Supports text and binary request bodies
// and response types (text/json/blob/arraybuffer/document/stream),
// and `@connect` URL gating.
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
//     { type, id, event: GmXhrStreamEvent | GmXhrEvent }
//     The stream events (headers, then the body's pieces) first, then
//     one terminal event.
//
// `id` is a per-request UUID-ish string the page generates. The SW
// just round-trips it.
//
// The response body streams to the page in `progress` pieces ahead of
// the terminal `load` (see `streamBody`), so the worker never holds the
// whole of it and no size cap is needed.
//
// One safety limit lives here:
//   - `@connect` redirect re-validation: `fetch` follows redirects by
//     default, so an allowlisted host could 302 to a disallowed one.
//     The caller passes `checkFinalUrl`; if the response came back
//     from a redirected URL the policy refuses (the user can be asked
//     about it, as for the first URL), we drop the body and return the
//     policy's error instead of handing it to the script.
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

import { base64ToBytes, bytesToBase64 } from '../bytes.js';
import {
  headerRuleFailedMessage,
  headerStallMessage,
  redirectRefusedMessage,
  unreachableMessage,
} from '../gm-connect.js';
import {
  buildHeaderRule,
  splitHeaders,
  whenStaleRulesCleared,
  type HeaderRuleSpec,
} from './gm-xhr-headers.js';
import type { GmXhrBody, GmXhrEvent, GmXhrRequestPayload, GmXhrStreamEvent } from '../gm-xhr-types.js';

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

// How much of the body goes in one `progress` message, at most. Big
// enough that a large download isn't thousands of messages, small
// enough that the worker never holds much of it and a message stays far
// under Chrome's 64 MiB limit (base64 adds a third).
const MAX_PIECE_BYTES = 1024 * 1024;

// One run of the body's pieces into a single array.
function joinPieces(pieces: Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1) return pieces[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of pieces) { out.set(p, offset); offset += p.byteLength; }
  return out;
}

// The body's length when the response says it, for `lengthComputable`.
// Not with a Content-Encoding: Content-Length then counts the encoded
// bytes, and the reader hands over decoded ones.
function bodyLength(headers: Headers): number | null {
  const encoding = headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return null;
  const length = Number(headers.get('content-length'));
  return headers.has('content-length') && Number.isFinite(length) && length >= 0 ? length : null;
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

// A stream event that couldn't be delivered: the page that asked is
// gone (closed, or navigated away). Chrome's own error says so in its
// terms; this says it in ours.
class PageGoneError extends Error {
  constructor() {
    super('The page that made the request is gone, so the request was stopped');
    this.name = 'PageGoneError';
  }
}

// A request that got no response at all, said in our words.
class UnreachableError extends Error {
  constructor(url: string) {
    super(unreachableMessage(URL.parse(url)?.host || url));
    this.name = 'UnreachableError';
  }
}

// Run a fetch on behalf of the page. Always resolves to the terminal
// event to send back, including for aborts and timeouts — the page-side
// runtime fires its own `onabort` immediately as well, so a script sees
// that one first.
//
// Before that, `push` delivers the stream events: the headers, then the
// body in pieces as it arrives (`streamBody`). Each push is awaited, so
// they arrive in order and a slow page holds back the reading rather
// than letting the worker buffer the body. A push that throws (the tab
// is gone) aborts the request.
//
// `checkFinalUrl`, when supplied, re-checks the response's URL against
// the script's `@connect` policy after redirects, resolving to null when
// allowed or else the error to report. A response that landed on a
// refused host (via a redirect the initial check couldn't see) is
// dropped with that error rather than returned.
//
// Request headers the browser's `fetch` refuses to send (`Origin`,
// `Cookie`, `Sec-Fetch-*`) go out by a short-lived declarativeNetRequest
// rule around the request (docs/xhr-header-surgery.md).

export async function runXhr(
  id: string,
  request: GmXhrRequestPayload,
  push: (event: GmXhrStreamEvent) => Promise<void>,
  checkFinalUrl?: (url: string, signal: AbortSignal) => Promise<string | null>,
  tabId: number | null = null,
): Promise<GmXhrEvent> {
  // Taken over from `reserveXhr` when the caller made one, so an abort
  // that came while the request waited on the policy counts.
  const controller = activeXhrs.get(id)?.controller ?? new AbortController();
  activeXhrs.set(id, { controller, tabId });
  if (controller.signal.aborted) {
    activeXhrs.delete(id);
    return { kind: 'abort' };
  }
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
    if (init.method !== 'GET' && init.method !== 'HEAD') {
      if (request.body) init.body = requestBody(request.body);
      else if (request.data != null) init.body = typeof request.data === 'string' ? request.data : String(request.data);
    }
    if (request.nocache) init.cache = 'no-store';
    else if (request.revalidate) init.cache = 'no-cache';
    // 'manual' keeps the redirect from being followed, and the response
    // it gives says it was one.
    if (request.redirect === 'error') init.redirect = 'manual';
    // The tagged URL where there's a rule: the tag is what the rule
    // matches on, and it never leaves the browser (a fragment isn't
    // transmitted, and `res.url` comes back without it).
    //
    // Chrome's message for a network failure is exactly "Failed to
    // fetch"; other `TypeError`s (a header name `fetch` won't take)
    // name their own problem and pass through.
    const res = await fetch(spec?.target ?? request.url, init).catch((err: unknown) => {
      if (!controller.signal.aborted && err instanceof TypeError && err.message === 'Failed to fetch') {
        throw new UnreachableError(request.url);
      }
      throw err;
    });
    if (res.type === 'opaqueredirect') {
      return { kind: 'error', message: redirectRefusedMessage() };
    }
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
    const refusal = res.redirected && checkFinalUrl ? await checkFinalUrl(res.url, controller.signal) : null;
    // Aborted (or timed out) while the check asked the user.
    if (controller.signal.aborted) return terminalAbortEvent();
    if (refusal !== null) return { kind: 'error', message: refusal };
    const total = bodyLength(res.headers);
    const responseHeaders = serializeHeaders(res.headers);
    // A push that fails means the page is gone; said in our words.
    const pushOrStop = (event: GmXhrStreamEvent): Promise<void> => push(event).catch(() => {
      throw new PageGoneError();
    });
    await pushOrStop({
      kind: 'headers', status: res.status, statusText: res.statusText, finalUrl: res.url, responseHeaders,
      mimeType: res.headers.get('content-type') ?? '', total,
    });
    await streamBody(res, total, pushOrStop, controller);
    // The body went ahead in `progress` events; the page-side runtime
    // builds `responseText` and `response` from them.
    return {
      kind: 'load',
      response: {
        status: res.status,
        statusText: res.statusText,
        responseURL: res.url,
        responseText: '',
        response: null,
        responseMimeType: res.headers.get('content-type') ?? '',
        responseHeaders,
        finalUrl: res.url,
      },
    };
  } catch (err) {
    // Distinguish abort vs. timeout vs. error. AbortController-driven
    // aborts surface as DOMException name='AbortError'; we use a
    // shadow flag set by the timeout handler to know which one.
    const isAbortError =
      err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
    // The script's own timeout outranks everything, then the aborts.
    if (timeoutFired) return terminalAbortEvent();
    if (err instanceof PageGoneError || err instanceof UnreachableError) {
      return { kind: 'error', message: err.message };
    }
    if (headerStallFired || isAbortError) return terminalAbortEvent();
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  } finally {
    if (timeoutTimer != null) clearTimeout(timeoutTimer);
    clearHeaderStall();
    activeXhrs.delete(id);
    // Ends a body nobody read (a redirect refused, a page gone before
    // the headers went out), which would otherwise hold its connection.
    // Nothing once the request is done.
    controller.abort();
    // Backstop for the abort, timeout and error paths — the success
    // path already dropped it. `removeHeaderRule` swallows its own
    // failures, so this can't reject out of the `finally`.
    if (installedRuleId != null) await removeHeaderRule(installedRuleId);
  }
}

// A non-text request body as `fetch` takes it. `fetch` sets the
// Content-Type from it (a Blob's type, the multipart boundary, or
// form-urlencoded) unless the script's headers set one.
function requestBody(body: GmXhrBody): BodyInit {
  switch (body.kind) {
    case 'bytes':
      return new Blob([base64ToBytes(body.data)], { type: body.type });
    case 'params':
      return new URLSearchParams(body.data);
    case 'form': {
      const form = new FormData();
      for (const entry of body.entries) {
        if ('value' in entry) form.append(entry.name, entry.value);
        else form.append(entry.name, new Blob([base64ToBytes(entry.data)], { type: entry.type }), entry.filename);
      }
      return form;
    }
  }
}

// Read the body and push it in pieces. A piece goes out as soon as the
// previous push is done, holding whatever arrived meanwhile (up to
// MAX_PIECE_BYTES), so a trickle of small reads still reaches the page
// promptly while a fast download goes out in large pieces. Reading
// waits only when a full piece is already waiting behind a push, so the
// worker holds at most about two pieces.
//
// A push resolves once the page's listeners have run (none of them
// answers with `sendResponse`), which is what makes it a brake: an
// isolated-world page takes each piece as it comes. A page-world
// script's pieces go through the bridge, which only re-posts them, so
// there the brake is the bridge, not the script.
//
// A failed push aborts `controller` at once, so a read still waiting on
// the network ends now rather than with the next chunk.
async function streamBody(
  res: Response,
  total: number | null,
  push: (event: GmXhrStreamEvent) => Promise<void>,
  controller: AbortController,
): Promise<void> {
  const reader = res.body?.getReader();
  // No body at all (a 204, a HEAD).
  if (!reader) return;
  // In an object, as the push's callbacks change it.
  const state = {
    waiting: [] as Uint8Array[],
    waitingBytes: 0,
    loaded: 0,
    sending: null as Promise<void> | null,
    failed: null as { err: unknown } | null,
  };
  const send = (): void => {
    const piece = joinPieces(state.waiting, state.waitingBytes);
    state.waiting = [];
    state.waitingBytes = 0;
    state.loaded += piece.byteLength;
    state.sending = push({ kind: 'progress', data: bytesToBase64(piece), loaded: state.loaded, total })
      .then(() => {
        state.sending = null;
        // What arrived meanwhile goes now, not with the next read: on
        // a trickle that could be a long way off.
        if (state.waitingBytes > 0) send();
      }, (err: unknown) => {
        state.sending = null;
        state.failed = { err };
        controller.abort();
      });
  };
  // The pushes in flight done, and a failed one thrown.
  const settle = async (): Promise<void> => {
    while (state.sending) await state.sending;
    if (state.failed) throw state.failed.err;
  };
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        // Our own abort, for a failed push: that failure is the cause.
        if (state.failed) throw state.failed.err;
        throw err;
      }
      const { done, value } = result;
      if (done) break;
      if (state.failed) throw state.failed.err;
      if (!value) continue;
      // A read bigger than a piece is split, so no message outgrows one.
      for (let at = 0; at < value.byteLength; at += MAX_PIECE_BYTES) {
        const part = value.subarray(at, at + MAX_PIECE_BYTES);
        // A full piece waiting: it goes next, once the pushes ahead of
        // it are done.
        if (state.waitingBytes > 0 && state.waitingBytes + part.byteLength > MAX_PIECE_BYTES) {
          await settle();
          if (state.waitingBytes > 0) send();
        }
        state.waiting.push(part);
        state.waitingBytes += part.byteLength;
        if (!state.sending) send();
      }
    }
    await settle();
    if (state.waitingBytes > 0) {
      send();
      await settle();
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* already torn down */ }
    throw err;
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

// Make a request abortable before `runXhr` starts it: while it waits
// on the user's answer to the connection prompt, the script may call
// `abort()` or its tab may close. `runXhr` takes the entry over; a
// caller that ends up not running the request calls `releaseXhr`.
export function reserveXhr(id: string, tabId: number | null): AbortSignal {
  const controller = new AbortController();
  activeXhrs.set(id, { controller, tabId });
  if (earlyAborts.delete(id)) controller.abort();
  return controller.signal;
}

// Ids aborted before the worker took their request: an `abort()` right
// after the call can overtake the start message, which first waits on
// checks (whose bridge it came through) before `reserveXhr`. Kept a
// minute, far longer than that wait; without them the request would
// still go out.
const earlyAborts = new Set<string>();
const EARLY_ABORT_TTL_MS = 60 * 1000;

export function releaseXhr(id: string): void {
  activeXhrs.delete(id);
}

// Cancel an in-flight request by id. Idempotent — calling abort on a
// completed request is a no-op (the entry is gone). An id not seen yet
// is remembered, for a start message still on its way.
export function abortXhr(id: string): boolean {
  const entry = activeXhrs.get(id);
  if (!entry) {
    earlyAborts.add(id);
    setTimeout(() => earlyAborts.delete(id), EARLY_ABORT_TTL_MS);
    return false;
  }
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
