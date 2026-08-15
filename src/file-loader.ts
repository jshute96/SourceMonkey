// Resolution + loading of resources referenced from a userscript
// metadata block — e.g. `@icon` today, `@require` planned. Centralizes
// the scheme-dispatch + relative-path-against-script-parent rule so
// each consumer doesn't reinvent it.
//
// Reference forms accepted by `resolveScriptResource`:
//   - absolute http(s):// URL → kind 'http' (passed through verbatim;
//                               any origin is allowed — the script
//                               author explicitly pointed there)
//   - `data:` URL             → kind 'data' (caller handles inline;
//                               not fetched here)
//   - relative path           → resolved against `scriptFileUrl`'s
//                               parent directory; the result must
//                               still live at or under that parent
//                               (containment check on the resolved URL)
//
// Notably absent: absolute `file://` URLs. The extension holds
// `file:///*` host permission so any caller code can read arbitrary
// local files via the byte fetcher; we don't want a malicious
// HTTP-sourced userscript pointing `@icon file:///etc/passwd` and
// having us inline a host file into the collections-page DOM. A file://
// result is only reachable as the *resolution* of a relative path
// against a file:// script, in which case the containment check
// confines it to the script's own directory tree.
//
// Containment check vs. textual `..` filter: a textual filter on the
// raw reference can be bypassed by percent-encoding (`%2e%2e` is
// normalized into a `..` directory-up move by the URL parser before
// we ever see the resolved form). Comparing the resolved URL string
// against the parent-directory URL string catches every encoding —
// literal `..`, `%2e%2e`, leading `/`, etc. — in one rule.
//
// The host script's parent dir is derived from `scriptFileUrl`, which
// is the canonical fetchable URL we already store on every script
// record — works uniformly for file://, http(s)://, and entries
// reached via a manifest.

import { isFileUrl, isHttpUrl } from './directories.js';
import { githubAuthHeaders } from './github-auth.js';
import { mustHopToWorker, readHttpViaWorker, replyBytes } from './http-read.js';

export type ResolvedKind = 'http' | 'file' | 'data';

export interface ResolvedResource {
  kind: ResolvedKind;
  // For 'data', the literal `data:` URL the caller can render inline.
  // For 'http' / 'file', a fully-qualified absolute URL ready to fetch.
  url: string;
}

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

// Why a ref couldn't be resolved. The distinctions exist because they
// have different fixes: a wrong scheme is a typo in the URL, a path
// that climbs out of the folder is a layout the loader won't allow.
// `external-files.ts` turns these into the text the user reads.
export type ResolveFailReason =
  | 'empty'
  | 'malformed-url'
  | 'unsupported-scheme'
  | 'outside-script-folder';

// A discriminated union for the same reason `FetchFailure` is one: the
// scheme is always known where it belongs, so making it optional would
// only buy an unreachable — and ungrammatical — fallback in the message.
export type ResolveFailure =
  | { failed: true; reason: Exclude<ResolveFailReason, 'unsupported-scheme'> }
  // Carried rather than re-derived so the message names what the
  // author actually wrote.
  | { failed: true; reason: 'unsupported-scheme'; scheme: string };

// Yes/no form, for the callers that only need a URL or nothing —
// syntax highlighting's link detection, the icon resolver, the offline
// validator. A thin wrapper rather than a second implementation: the
// two used to be one function and the rules must not drift.
export function resolveScriptResource(
  ref: string,
  scriptFileUrl: string,
): ResolvedResource | null {
  const result = resolveScriptResourceDetailed(ref, scriptFileUrl);
  return 'failed' in result ? null : result;
}

// Same rules, but says which one rejected the ref. Used where the
// answer becomes a message a user reads.
export function resolveScriptResourceDetailed(
  ref: string,
  scriptFileUrl: string,
): ResolvedResource | ResolveFailure {
  const trimmed = ref.trim();
  if (!trimmed) return { failed: true, reason: 'empty' };

  if (trimmed.startsWith('data:')) {
    return { kind: 'data', url: trimmed };
  }

  // Absolute http(s):// URL: the script author wrote a complete URL,
  // any origin is allowed. Note that absolute `file://` is *not*
  // accepted here — see module header for why.
  if (ABSOLUTE_URL_RE.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { failed: true, reason: 'malformed-url' };
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { kind: 'http', url: parsed.toString() };
    }
    return { failed: true, reason: 'unsupported-scheme', scheme: parsed.protocol };
  }

  // Relative path. Resolve against the script's parent directory and
  // then verify the result is still confined to that directory tree.
  // We compare URL strings rather than path strings so the check
  // accounts for origin, scheme, host, and port atomically — the
  // resolved URL must share the same prefix as `<parentBase>/`.
  let resolved: URL;
  let parentBase: URL;
  try {
    resolved = new URL(trimmed, scriptFileUrl);
    parentBase = new URL('./', scriptFileUrl);
  } catch {
    return { failed: true, reason: 'malformed-url' };
  }
  const parentStr = parentBase.toString();
  const resolvedStr = resolved.toString();
  if (!resolvedStr.startsWith(parentStr)) {
    return { failed: true, reason: 'outside-script-folder' };
  }

  if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
    return { kind: 'http', url: resolvedStr };
  }
  if (resolved.protocol === 'file:') {
    return { kind: 'file', url: resolvedStr };
  }
  // A relative ref that lands on some other scheme — only reachable
  // when the script's own URL has one, which the collection pipeline
  // doesn't produce today.
  return { failed: true, reason: 'unsupported-scheme', scheme: resolved.protocol };
}

// ---------- Bounded byte fetch ----------
//
// Scheme-aware bounded fetcher used by resource loaders. http(s) goes
// through `fetch()`; file:// goes through XMLHttpRequest in page
// contexts (where `fetch()` would return an opaque chrome-extension →
// file:// response) and falls back to `fetch()` in service-worker
// contexts (no XHR). Both legs apply the same size cap and timeout.

const DEFAULT_FETCH_TIMEOUT_MS = 5000;

export interface FetchBytesOptions {
  maxBytes: number;
  timeoutMs?: number;
  // Optional content-type predicate; the fetch is rejected when this
  // returns false. Used by the icon fetcher to require `image/*`.
  // Note @require deliberately does *not* use this: its predicate runs
  // after the shared FileFetchCache hit (see external-files.ts) so a
  // @resource pointing at the same URL isn't rejected by the require's
  // rule. An empty content-type skips the predicate entirely.
  acceptContentType?: (contentType: string) => boolean;
}

export interface FetchedBytes {
  body: ArrayBuffer;
  contentType: string;
  finalUrl: string;
}

// Why a fetch produced no bytes. Each is known at the point the fetcher
// gives up. `external-files.ts` turns them into text —
// `describeFetchFailure`.
//
// `timeout` is separate from `no-response` because we can tell: our own
// abort sets `controller.signal.aborted`. Without that split both would
// have to share a message naming two causes, which is the thing these
// reasons exist to avoid.
export type FetchFailReason =
  | 'unsupported-scheme'
  | 'no-response'
  | 'timeout'
  | 'unreadable-file'
  | 'http-error'
  | 'wrong-content-type'
  | 'empty'
  | 'oversize';

// A discriminated union, not one shape with optional extras: `status`
// is always known where it belongs and never meaningful elsewhere, so
// making it optional would only buy an unreachable "the request failed"
// fallback in the message layer.
export type FetchFailure =
  | { failed: true; reason: Exclude<FetchFailReason, 'http-error'> }
  | { failed: true; reason: 'http-error'; status: number };

const fetchFailed = (reason: Exclude<FetchFailReason, 'http-error'>): FetchFailure =>
  ({ failed: true, reason });

const httpError = (status: number): FetchFailure =>
  ({ failed: true, reason: 'http-error', status });

export async function fetchResourceBytes(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure> {
  if (isHttpUrl(url)) return fetchHttpBytes(url, opts);
  if (isFileUrl(url)) return fetchFileBytes(url, opts);
  return fetchFailed('unsupported-scheme');
}

// Page contexts hand the read to the service worker — a document
// fetch acts on the response's `Link: rel=preload` headers, which our
// pages can't have. See src/http-read.ts for the whole story.
async function fetchHttpBytes(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure> {
  if (mustHopToWorker()) {
    const viaSw = await fetchHttpBytesViaWorker(url, opts);
    if (viaSw) return viaSw;
  }
  return fetchHttpBytesHere(url, opts);
}

// Map the worker's report of what came back onto this module's own
// verdict about it — which statuses are failures, which content types
// are acceptable, what counts as too big. Returns null when the worker
// never answered, so the caller falls back to fetching here.
async function fetchHttpBytesViaWorker(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure | null> {
  const reply = await readHttpViaWorker({
    url,
    as: 'bytes',
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });
  if (!reply) return null;
  if (reply.kind === 'error') return fetchFailed(reply.reason);
  if (reply.status < 200 || reply.status > 299) return httpError(reply.status);
  const contentType = reply.contentType.toLowerCase();
  if (opts.acceptContentType && contentType && !opts.acceptContentType(contentType)) {
    return fetchFailed('wrong-content-type');
  }
  const body = replyBytes(reply);
  // Re-checked here rather than trusted: these caps are what each
  // caller's own limit is expressed in, and `body` is what they get.
  if (body.byteLength === 0) return fetchFailed('empty');
  if (body.byteLength > opts.maxBytes) return fetchFailed('oversize');
  return { body, contentType, finalUrl: reply.finalUrl };
}

// The fetch itself. Runs in the service worker for page-initiated
// reads (see above) and directly in whatever context asked otherwise.
async function fetchHttpBytesHere(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      // Attach GitHub auth header when the URL targets a GitHub host so
      // `@require` / `@resource` / icon fetches against private raw
      // URLs work. Host-gated inside `githubAuthHeaders` so non-GitHub
      // hosts never see the token.
      headers: { ...githubAuthHeaders(url) },
    });
  } catch {
    // Our own timer is the only thing that aborts this request, so an
    // aborted signal identifies the timeout exactly rather than
    // leaving it merged with a network failure.
    return controller.signal.aborted ? fetchFailed('timeout') : fetchFailed('no-response');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return httpError(response.status);

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (opts.acceptContentType && contentType && !opts.acceptContentType(contentType)) {
    return fetchFailed('wrong-content-type');
  }
  const cl = response.headers.get('content-length');
  if (cl && Number(cl) > opts.maxBytes) return fetchFailed('oversize');

  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch {
    return fetchFailed('no-response');
  }
  if (body.byteLength === 0) return fetchFailed('empty');
  if (body.byteLength > opts.maxBytes) return fetchFailed('oversize');

  return { body, contentType, finalUrl: response.url || url };
}

async function fetchFileBytes(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure> {
  // Page contexts: XHR avoids the chrome-extension → file:// CORS
  // opaque-response trap that bites `fetch()`. SW contexts: no XHR,
  // but `fetch()` is permitted for file:// when host_permissions
  // grants `file:///*`.
  if (typeof XMLHttpRequest !== 'undefined') {
    return fetchFileBytesXhr(url, opts);
  }
  return fetchFileBytesFetch(url, opts);
}

function fetchFileBytesXhr(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (value: FetchedBytes | FetchFailure) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // The one branch here that knows its cause with certainty: we are
    // inside our own timer.
    const timer = setTimeout(() => {
      try { xhr.abort(); } catch { /* ignore */ }
      finish(fetchFailed('timeout'));
    }, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);

    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      clearTimeout(timer);
      const body = xhr.response as ArrayBuffer | null;
      // Defensive: `onload` with no body shouldn't happen — a failed
      // load fires `onerror`, and a 0-byte file yields an empty buffer,
      // not null. Guarded so that if it ever does, it isn't mistaken
      // for an empty file.
      if (!body) {
        finish(fetchFailed('unreadable-file'));
        return;
      }
      if (body.byteLength === 0) {
        finish(fetchFailed('empty'));
        return;
      }
      if (body.byteLength > opts.maxBytes) {
        finish(fetchFailed('oversize'));
        return;
      }
      // file:// XHRs don't carry an HTTP layer, so Content-Type is
      // whatever Chrome inferred from the extension (often '' or
      // text/plain for images). Run the predicate only when we have
      // something usable; otherwise let the caller infer from the
      // filename / bytes.
      const ct = (xhr.getResponseHeader('content-type') ?? '').toLowerCase();
      if (opts.acceptContentType && ct && !opts.acceptContentType(ct)) {
        finish(fetchFailed('wrong-content-type'));
        return;
      }
      finish({ body, contentType: ct, finalUrl: url });
    };
    // A file:// XHR carries no HTTP layer, so a file that isn't there
    // and one we're not allowed to read arrive identically — hence one
    // reason covering both, rather than a guess between them.
    xhr.onerror = () => {
      clearTimeout(timer);
      finish(fetchFailed('unreadable-file'));
    };
    try {
      xhr.send();
    } catch {
      clearTimeout(timer);
      finish(fetchFailed('unreadable-file'));
    }
  });
}

async function fetchFileBytesFetch(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | FetchFailure> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch {
    return controller.signal.aborted ? fetchFailed('timeout') : fetchFailed('unreadable-file');
  } finally {
    clearTimeout(timer);
  }
  // `status === 0` is normal for a successful file:// read. A non-ok
  // status is NOT reported as an HTTP error: a `file:` URL has no HTTP
  // layer, and whatever status this leg's `fetch` synthesises means the
  // same thing the XHR leg's `onerror` does — the file wouldn't read.
  // Reporting it as `HTTP <n>` would make the two legs describe one
  // situation differently, which is what the offline validator's fetch
  // shim exposed.
  if (!response.ok && response.status !== 0) return fetchFailed('unreadable-file');
  // Answered, but we aren't allowed to look.
  if (response.type === 'opaque') return fetchFailed('unreadable-file');

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (opts.acceptContentType && contentType && !opts.acceptContentType(contentType)) {
    return fetchFailed('wrong-content-type');
  }
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch {
    // Same leg, same file — matches the `unreadable-file` above rather
    // than blaming the network for a local read.
    return fetchFailed('unreadable-file');
  }
  if (body.byteLength === 0) return fetchFailed('empty');
  if (body.byteLength > opts.maxBytes) return fetchFailed('oversize');

  return { body, contentType, finalUrl: response.url || url };
}

// ---------- Text + suffix helpers ----------

// Convenience for text-shaped consumers. Wraps fetchResourceBytes and
// decodes UTF-8. Returns null on any failure the bytes-fetcher
// reports, plus null on a decode failure (rare — `fatal: false` rules
// out throws).
//
// Still yes/no: its one caller is the version probe, whose row renders
// in a definition-list cell with no space for a reason. Switch it to
// the failure shape if that row ever gets room — the same condition
// TODO.md attaches to the probe's own wording.
export async function fetchResourceText(
  url: string,
  opts: FetchBytesOptions,
): Promise<string | null> {
  const res = await fetchResourceBytes(url, opts);
  if ('failed' in res) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(res.body);
  } catch {
    return null;
  }
}

// Strict `.js`-suffix check used by the `@require` gate: the pathname
// (sans query/fragment) must end in `.js`. So `jquery.js?v=3` and
// `lib.user.js` both pass; `lib.js.txt`, `foo.json`, and `foo.js/` do
// not. Comparison is case-insensitive — `lib.JS` is common on
// Windows-origin and some CDNs, and TM/VM don't gate on suffix at all,
// so being permissive about case keeps us interoperable. Returns
// false for malformed URLs.
export function isJsResourceUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.js');
  } catch {
    return false;
  }
}

