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

// One serialized HTTP response, as the terminal `load` event carries
// it. Field names roughly match TM/VM's onload payload shape so
// userscripts that move between managers don't have to learn three
// slightly different APIs.
//
// The worker never puts the body here: it streams it ahead of the
// `load` as `progress` events (`GmXhrStreamEvent`), and the page-side
// runtime fills `responseText` and `response` from those before
// invoking onload. A harness request fake (`RequestInterceptor`) does
// fill `responseText`: that answer is served at the network level, and
// the body then streams like any other.
export interface GmXhrResponse {
  status: number;
  statusText: string;
  responseURL: string;
  // The body as text, for the text-based responseTypes ('text'
  // default, 'json', 'document'). '' for 'blob' and 'arraybuffer'.
  responseText: string;
  // What the user gets: the text for 'text', the parsed value for
  // 'json', and a Blob / ArrayBuffer / Document for the others.
  response: unknown;
  // Content-Type, for the Blob's type and the Document's parse mode.
  responseMimeType?: string;
  responseHeaders: string;  // RFC 2616-style multi-line "Name: value\r\n..."
  finalUrl: string;
}

// The terminal events: exactly one ends each request.
export type GmXhrEvent =
  | { kind: 'load'; response: GmXhrResponse }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'abort' };

// The events before the terminal one, in order: `headers` once, when
// the response headers are in, then a `progress` per piece of the body.
// `total` is the body's length when it's known (a Content-Length on a
// response with no Content-Encoding, since the bytes counted are the
// decoded ones), else null.
export type GmXhrStreamEvent =
  | {
    kind: 'headers';
    status: number;
    statusText: string;
    finalUrl: string;
    responseHeaders: string;
    total: number | null;
  }
  | {
    kind: 'progress';
    // This piece of the body, base64: a message hop can't be trusted
    // to carry an ArrayBuffer intact across worlds.
    data: string;
    // Bytes so far, this piece included.
    loaded: number;
    total: number | null;
  };
