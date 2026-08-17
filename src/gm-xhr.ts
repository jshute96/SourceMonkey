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

import { bytesToBase64 } from './bytes.js';
import { connectBlockedMessage, headerRuleFailedMessage } from './gm-connect.js';
import {
  buildHeaderRule,
  splitHeaders,
  whenStaleRulesCleared,
  type HeaderRuleSpec,
} from './gm-xhr-headers.js';

export interface GmXhrRequestPayload {
  // HTTP method. Default GET. Uppercased before sending.
  method?: string;
  url: string;
  // Headers object — { header-name: value }.
  headers?: Record<string, string>;
  // Body text. Non-string request bodies (FormData / Blob /
  // ArrayBuffer) are not yet supported — see TODO.md "XHR binary
  // request bodies". Non-string values stringify via String() at the
  // SW boundary.
  data?: string;
  // Timeout in ms. 0 / undefined = no timeout.
  timeout?: number;
  // 'text' | 'json'. Anything else is treated as 'text' for now.
  responseType?: string;
  // Opt out of sending the user's cookies / HTTP auth for the target
  // origin. Requests are credentialed by default (TM/VM behavior) —
  // see the `credentials` note in `runXhr`.
  anonymous?: boolean;
  // GET/HEAD requests can't have a body — we don't enforce here;
  // fetch() will reject and the page sees an error event.
}

// One serialized HTTP response. Field names roughly match TM/VM's
// onload payload shape so userscripts that move between managers
// don't have to learn three slightly different APIs.
//
// For binary responseTypes (blob, arraybuffer, document) we send the
// body as `responseBase64` (base64-encoded bytes) + `responseMimeType`
// (Content-Type) and the page-side runtime reconstructs the Blob /
// ArrayBuffer / Document. `responseText` stays empty for those types
// — TM/VM behavior matches.
export interface GmXhrResponse {
  status: number;
  statusText: string;
  responseURL: string;
  // For text-based responseTypes ('text' default, 'json'),
  // responseText is the raw body text. For binary responseTypes it
  // is '' — the body comes through responseBase64 instead.
  responseText: string;
  // `response` is what the page-side runtime reconstructs and hands
  // to the user. For text it's responseText; for json it's the
  // parsed value; for blob/arraybuffer/document the SW sends null
  // and the page-side fills in the right object before invoking
  // onload.
  response: unknown;
  // Binary transport. Populated when the requested responseType is
  // 'blob', 'arraybuffer', or 'document'. The page-side decodes
  // from base64 to bytes; for 'blob' it builds a `new Blob(...)`,
  // for 'arraybuffer' an `ArrayBuffer`, for 'document' it parses
  // the bytes-as-utf8 through DOMParser.
  responseBase64?: string;
  responseMimeType?: string;
  responseHeaders: string;  // RFC 2616-style multi-line "Name: value\r\n..."
  finalUrl: string;
}

export type GmXhrEvent =
  | { kind: 'load'; response: GmXhrResponse }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'abort' };

// Per-request abort handles. Key: request id.
const activeXhrs = new Map<string, AbortController>();

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

// Run a fetch on behalf of the page. Returns the event to send back
// (or null if the request was aborted before fetch resolved — the
// abort handler dispatches its own event).
//
// `isFinalUrlAllowed`, when supplied, re-checks the response's URL
// against the script's `@connect` policy after redirects. A response
// that landed on a disallowed host (via a redirect the initial check
// couldn't see) is dropped with an error event rather than returned.
export async function runXhr(
  id: string,
  request: GmXhrRequestPayload,
  isFinalUrlAllowed?: (url: string) => boolean,
): Promise<GmXhrEvent> {
  const controller = new AbortController();
  activeXhrs.set(id, controller);
  // Timeout: setTimeout that aborts the controller. We track the
  // timer so we can clear it on completion.
  let timeoutFired = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (request.timeout && request.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      timeoutFired = true;
      controller.abort();
    }, request.timeout);
  }
  // Headers `fetch` would drop travel as a DNR rule instead; the rest
  // ride along on the request. `installedRuleId` is held so the rule
  // comes off however the request ends.
  const { passthrough, surgical } = splitHeaders(request.headers);
  let installedRuleId: number | null = null;
  try {
    const method = (request.method ?? 'GET').toUpperCase();
    // Built once: `buildHeaderRule` allocates an id, so asking it twice
    // would burn one and answer a different question the second time.
    const spec = buildHeaderRule(request.url, surgical, method);
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
    const res = await fetch(request.url, init);
    // The rule has done its job the moment the request is on the wire,
    // and `fetch` resolving means the response headers are already
    // back. Dropping it here rather than in `finally` keeps a slow
    // download from holding a rule live — the window in which another
    // tab-less request to the same URL would pick up these headers.
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
    if (res.redirected && isFinalUrlAllowed && !isFinalUrlAllowed(res.url)) {
      let host = res.url;
      try { host = new URL(res.url).hostname; } catch { /* keep full url */ }
      return {
        kind: 'error',
        message: connectBlockedMessage(`redirect to ${host} not allowed`),
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
    if (timeoutFired) return { kind: 'timeout' };
    if (err instanceof ResponseTooLargeError) {
      return { kind: 'error', message: `[SourceMonkey] ${err.message}` };
    }
    if (isAbortError) return { kind: 'abort' };
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  } finally {
    if (timeoutTimer != null) clearTimeout(timeoutTimer);
    activeXhrs.delete(id);
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

async function removeHeaderRule(ruleId: number): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch (err) {
    // A rule left behind would keep rewriting later same-URL requests,
    // so this is worth a log — but there is nothing to retry against
    // and the request itself already succeeded.
    console.info('[SourceMonkey] could not remove a GM_xmlhttpRequest header rule', err);
  }
}

// Cancel an in-flight request by id. Idempotent — calling abort on a
// completed request is a no-op (the entry is gone).
export function abortXhr(id: string): boolean {
  const ctrl = activeXhrs.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}
