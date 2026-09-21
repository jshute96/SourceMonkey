// One http(s) read, made where it is safe to make it.
//
// ---------- Why this module exists ----------
//
// A `fetch()` issued by a DOCUMENT hands that document the response's
// `Link: <…>; rel=preload; as=script` headers, and Chrome acts on them
// — it tries to preload the named script into the page that asked. Our
// pages are extension pages, whose CSP is `script-src 'self'`, so the
// preload is refused, and Chrome files the refusal under
// `chrome://extensions/?errors`: an uncatchable error, about a script
// the page never asked for, that reads as SourceMonkey being broken.
//
// Nothing exotic triggers it. Any site that preloads its own bundles
// sends the header on every page, and we fetch site HTML (the site-icon
// probe) and arbitrary script URLs (Add / Refresh / the install
// preview) from pages all the time. A response that turns out to be a
// login page — the case `fetchHttpText` already has a branch for — is
// among the most likely of all to carry one.
//
// A service worker has no document for a hint to apply to, so the same
// read there is inert. Hence this module: pages hand the read to the
// worker and get the response back over `chrome.runtime`. Both
// directions are pinned by `tests/e2e/preload-hints.spec.ts`.
//
// ---------- Shape ----------
//
// The worker performs the fetch and reports what came back; every
// caller keeps its own rules about what the response MEANS (which
// statuses are failures, which content types are acceptable, how a 304
// is reported). That split is deliberate: the two callers
// (`fetchResourceBytes` for bytes, `fetchHttpText` for script and
// manifest text) disagree about all of it, and a handler that tried to
// decide for both would have to grow their union.
//
// `as: 'text'` decodes in the worker via `Response.text()` rather than
// shipping bytes for the page to decode, so a response's charset is
// honoured exactly as it was before the hop existed.

import { base64ToBytes, bytesToBase64 } from './bytes.js';
import { isPageContext } from './run-context.js';
import { ensureGithubAuthTokenLoaded, githubAuthHeaders } from './github-auth.js';

export const HTTP_READ_MESSAGE = 'sm:http-read';

export interface HttpReadRequest {
  type: typeof HTTP_READ_MESSAGE;
  url: string;
  // Text is decoded in the worker; bytes travel base64, since
  // `chrome.runtime` messages are JSON and an ArrayBuffer doesn't
  // survive the hop.
  as: 'text' | 'bytes';
  // Conditional-GET headers. The GitHub token is NOT passed here — the
  // worker attaches it from its own copy, so no caller has to hold it
  // and it never rides on a message.
  headers?: Record<string, string>;
  // Omitted means no cap / no timeout, which is what the text callers
  // have always had.
  maxBytes?: number;
  timeoutMs?: number;
}

// What came back, or why nothing did. `status` is reported verbatim,
// including 304 and every error status — deciding which of those is a
// failure is the caller's job.
export type HttpReadReply =
  | {
    kind: 'response';
    status: number;
    contentType: string;
    etag: string | null;
    lastModified: string | null;
    finalUrl: string;
    text?: string;
    bodyBase64?: string;
  }
  | { kind: 'error'; reason: 'timeout' | 'no-response' | 'oversize'; message?: string };

// Service-worker side. `background.ts` owns the listener (and the
// sender check that keeps this from being an open fetch proxy — the
// extension holds `<all_urls>`).
export async function handleHttpReadRequest(req: HttpReadRequest): Promise<HttpReadReply> {
  // The worker may have woken up to answer this, with its startup token
  // read still in flight — a private GitHub raw URL would 404 on a race
  // the page-side fetch never had.
  await ensureGithubAuthTokenLoaded();
  const headers = { ...(req.headers ?? {}), ...githubAuthHeaders(req.url) };
  const controller = new AbortController();
  const timer = req.timeoutMs != null
    ? setTimeout(() => controller.abort(), req.timeoutMs)
    : null;
  let response: Response;
  try {
    response = await fetch(req.url, {
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers,
    });
  } catch (err) {
    // Our own timer is the only thing that aborts this request, so an
    // aborted signal identifies the timeout exactly rather than leaving
    // it merged with a network failure.
    return controller.signal.aborted
      ? { kind: 'error', reason: 'timeout' }
      : { kind: 'error', reason: 'no-response', message: errorText(err) };
  } finally {
    if (timer != null) clearTimeout(timer);
  }

  // Size checks are for a body we are about to read. A 304 has none —
  // its `Content-Length`, where a server sends one at all, describes the
  // entity that WOULD have been sent. Rejecting on it would fail a
  // conditional read as "too large" for a file that didn't change, and
  // only on this leg: the local path tests 304 before any size check, so
  // the two would disagree about the same response.
  const contentLength = response.headers.get('content-length');
  if (
    response.status !== 304 &&
    req.maxBytes != null && contentLength && Number(contentLength) > req.maxBytes
  ) {
    return { kind: 'error', reason: 'oversize' };
  }
  const base = {
    kind: 'response' as const,
    status: response.status,
    // Verbatim, not lowercased: callers quote it back as evidence of
    // what the server actually sent.
    contentType: response.headers.get('content-type') ?? '',
    etag: response.headers.get('ETag'),
    lastModified: response.headers.get('Last-Modified'),
    finalUrl: response.url || req.url,
  };
  try {
    if (req.as === 'text') return { ...base, text: await response.text() };
    const body = await response.arrayBuffer();
    if (req.maxBytes != null && body.byteLength > req.maxBytes) {
      return { kind: 'error', reason: 'oversize' };
    }
    return { ...base, bodyBase64: bytesToBase64(new Uint8Array(body)) };
  } catch (err) {
    // The body never finished arriving (connection dropped mid-read).
    return { kind: 'error', reason: 'no-response', message: errorText(err) };
  }
}

// True when this context must not fetch http(s) itself — i.e. it is a
// page rather than the service worker.
export function mustHopToWorker(): boolean {
  return isPageContext();
}

// Page side. Returns null — not an error — when the request got no
// answer at all, so the caller can fall back to fetching locally. That
// reopens the preload leak for that one read, which beats failing a
// read the user asked for.
export async function readHttpViaWorker(
  req: Omit<HttpReadRequest, 'type'>,
): Promise<HttpReadReply | null> {
  let reply: HttpReadReply | undefined;
  try {
    reply = await chrome.runtime.sendMessage<HttpReadRequest, HttpReadReply>({
      type: HTTP_READ_MESSAGE,
      ...req,
    });
  } catch {
    return null;   // no receiving end
  }
  return reply ?? null;
}

// The bytes of a `kind: 'response'` reply, whichever form it arrived in.
export function replyBytes(reply: { text?: string; bodyBase64?: string }): ArrayBuffer {
  if (reply.bodyBase64 != null) return base64ToBytes(reply.bodyBase64);
  return new TextEncoder().encode(reply.text ?? '').buffer;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
