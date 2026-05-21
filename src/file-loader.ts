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
// having us inline a host file into the options-page DOM. A file://
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

export type ResolvedKind = 'http' | 'file' | 'data';

export interface ResolvedResource {
  kind: ResolvedKind;
  // For 'data', the literal `data:` URL the caller can render inline.
  // For 'http' / 'file', a fully-qualified absolute URL ready to fetch.
  url: string;
}

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveScriptResource(
  ref: string,
  scriptFileUrl: string,
): ResolvedResource | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

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
      return null;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { kind: 'http', url: parsed.toString() };
    }
    return null;
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
    return null;
  }
  const parentStr = parentBase.toString();
  const resolvedStr = resolved.toString();
  if (!resolvedStr.startsWith(parentStr)) return null;

  if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
    return { kind: 'http', url: resolvedStr };
  }
  if (resolved.protocol === 'file:') {
    return { kind: 'file', url: resolvedStr };
  }
  return null;
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
  // returns false. Callers like the icon fetcher use this to require
  // `image/*`, while @require would require text/JavaScript.
  acceptContentType?: (contentType: string) => boolean;
}

export interface FetchedBytes {
  body: ArrayBuffer;
  contentType: string;
  finalUrl: string;
}

export async function fetchResourceBytes(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | null> {
  if (isHttpUrl(url)) return fetchHttpBytes(url, opts);
  if (isFileUrl(url)) return fetchFileBytes(url, opts);
  return null;
}

async function fetchHttpBytes(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | null> {
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
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (opts.acceptContentType && contentType && !opts.acceptContentType(contentType)) {
    return null;
  }
  const cl = response.headers.get('content-length');
  if (cl && Number(cl) > opts.maxBytes) return null;

  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (body.byteLength === 0 || body.byteLength > opts.maxBytes) return null;

  return { body, contentType, finalUrl: response.url || url };
}

async function fetchFileBytes(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | null> {
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
): Promise<FetchedBytes | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (value: FetchedBytes | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { xhr.abort(); } catch { /* ignore */ }
      finish(null);
    }, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);

    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      clearTimeout(timer);
      const body = xhr.response as ArrayBuffer | null;
      if (!body || body.byteLength === 0 || body.byteLength > opts.maxBytes) {
        finish(null);
        return;
      }
      // file:// XHRs don't carry an HTTP layer, so Content-Type is
      // whatever Chrome inferred from the extension (often '' or
      // text/plain for images). Run the predicate only when we have
      // something usable; otherwise let the caller infer from the
      // filename / bytes.
      const ct = (xhr.getResponseHeader('content-type') ?? '').toLowerCase();
      if (opts.acceptContentType && ct && !opts.acceptContentType(ct)) {
        finish(null);
        return;
      }
      finish({ body, contentType: ct, finalUrl: url });
    };
    xhr.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    try {
      xhr.send();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function fetchFileBytesFetch(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchedBytes | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok && response.status !== 0) return null;
  if (response.type === 'opaque') return null;

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (opts.acceptContentType && contentType && !opts.acceptContentType(contentType)) {
    return null;
  }
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (body.byteLength === 0 || body.byteLength > opts.maxBytes) return null;

  return { body, contentType, finalUrl: response.url || url };
}

// ---------- Text + suffix helpers ----------

// Convenience for text-shaped consumers (e.g. `@require`). Wraps
// fetchResourceBytes and decodes UTF-8. Returns null on any failure
// the bytes-fetcher reports, plus null on a decode failure (rare —
// `fatal: false` rules out throws).
export async function fetchResourceText(
  url: string,
  opts: FetchBytesOptions,
): Promise<string | null> {
  const res = await fetchResourceBytes(url, opts);
  if (!res) return null;
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

