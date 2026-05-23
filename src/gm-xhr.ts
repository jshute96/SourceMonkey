// SW-side `GM_xmlhttpRequest` handler. Drives `fetch` against the
// page's request, sends events back to the originating tab via
// `chrome.tabs.sendMessage`. Phase 8 is the **text** path only —
// `responseType: 'text'` (default) or `'json'`. Binary types
// (blob, arraybuffer, document) land in Phase 9. Header surgery
// + `@connect` validation land in Phase 10.
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
// AbortController per request. Stored in a Map keyed by id so an
// aborted request can be cancelled mid-fetch.

export interface GmXhrRequestPayload {
  // HTTP method. Default GET. Uppercased before sending.
  method?: string;
  url: string;
  // Headers object — { header-name: value }.
  headers?: Record<string, string>;
  // Body text. Phase 9 may extend to ArrayBuffer / FormData. For
  // Phase 8 we accept strings; non-string bodies stringify via
  // String() at the SW boundary.
  data?: string;
  // Timeout in ms. 0 / undefined = no timeout.
  timeout?: number;
  // 'text' | 'json'. Anything else is treated as 'text' for now.
  responseType?: string;
  // GET/HEAD requests can't have a body — we don't enforce here;
  // fetch() will reject and the page sees an error event.
}

// One serialized HTTP response. Field names roughly match TM/VM's
// onload payload shape so userscripts that move between managers
// don't have to learn three slightly different APIs.
export interface GmXhrResponse {
  status: number;
  statusText: string;
  responseURL: string;
  // For Phase 8 we always serialize the body as text. `responseText`
  // is the canonical field; `response` mirrors it for compatibility
  // with TM/VM's "response is the typed object" convention. For
  // `responseType: 'json'`, we parse here and `response` becomes the
  // parsed object.
  responseText: string;
  response: unknown;
  responseHeaders: string;  // RFC 2616-style multi-line "Name: value\n..."
  finalUrl: string;
}

export type GmXhrEvent =
  | { kind: 'load'; response: GmXhrResponse }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'abort' };

// Per-request abort handles. Key: request id.
const activeXhrs = new Map<string, AbortController>();

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
export async function runXhr(
  id: string,
  request: GmXhrRequestPayload,
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
  try {
    const init: RequestInit = {
      method: (request.method ?? 'GET').toUpperCase(),
      headers: request.headers ?? undefined,
      signal: controller.signal,
    };
    // GET / HEAD with no body — fetch() rejects "body not allowed".
    if (request.data != null && init.method !== 'GET' && init.method !== 'HEAD') {
      init.body = typeof request.data === 'string' ? request.data : String(request.data);
    }
    const res = await fetch(request.url, init);
    const responseText = await res.text();
    let response: unknown = responseText;
    if (request.responseType === 'json') {
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
    if (isAbortError) return { kind: 'abort' };
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  } finally {
    if (timeoutTimer != null) clearTimeout(timeoutTimer);
    activeXhrs.delete(id);
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
