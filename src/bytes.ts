// Small byte / crypto helpers shared across modules so the SHA-256 and
// binary→base64 logic lives in one place (script content hashes in
// script-store, @require/@resource byte hashes + transport in
// external-files, GM_xmlhttpRequest response transport in gm-xhr).

// SHA-256 → lowercase hex. Accepts a string (UTF-8 encoded first) or
// bytes. Async because SubtleCrypto has no sync form on the web
// platform.
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

// base64→binary. The inverse of `bytesToBase64`, used on the receiving
// end of message hops that can't carry an ArrayBuffer, and to rebuild a
// stored `@resource` body when a conditional GET answers 304 and the
// server sends no bytes of its own.
export function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Chunked binary→base64. `String.fromCharCode(...hugeArray)` throws
// "Maximum call stack size exceeded" past ~125k args in V8, so we walk
// the buffer in 32 KiB slices and concatenate. Linear and bounded.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Decode a `data:[<mime>][;base64],<payload>` URL into its bytes and
// MIME type, or null when it isn't well-formed (no comma, bad base64).
//
// A plain payload is percent-decoded to bytes, not through
// `decodeURIComponent`, so `%FF` and other non-UTF-8 bytes survive. A
// missing MIME type means `text/plain`, as RFC 2397 (the `data:` URL
// spec) gives. Parameters such as `;charset=` are dropped.
export function decodeDataUrl(dataUrl: string): { contentType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const comma = dataUrl.indexOf(',');
  if (!/^data:/i.test(dataUrl) || comma < 0) return null;
  const meta = dataUrl.slice(5, comma);          // e.g. "image/png;base64"
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const contentType = (isBase64 ? meta.slice(0, -7) : meta).split(';')[0].trim() || 'text/plain';
  if (isBase64) {
    try {
      return { contentType, bytes: new Uint8Array(base64ToBytes(payload.replace(/\s+/g, ''))) };
    } catch {
      return null;
    }
  }
  const raw = new TextEncoder().encode(payload);
  const out = new Uint8Array(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const hex = raw[i] === 0x25 /* % */ && i + 2 < raw.length
      ? String.fromCharCode(raw[i + 1], raw[i + 2]) : '';
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[n++] = raw[i];
    }
  }
  return { contentType, bytes: out.slice(0, n) };
}
