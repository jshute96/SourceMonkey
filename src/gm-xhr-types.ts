// The `GM_xmlhttpRequest` wire types, between the page and the
// service worker's handler (gm-xhr.ts). Their own module so the
// harness, whose request fakes speak them, can use them without the
// handler.

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
  // see the `credentials` note in `runXhr` (gm-xhr.ts).
  anonymous?: boolean;
  // GET/HEAD requests can't have a body. The runner doesn't enforce
  // it; fetch() will reject and the page sees an error event.
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
