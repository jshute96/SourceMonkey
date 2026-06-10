// Small byte / crypto helpers shared across modules so the SHA-256 and
// binary→base64 logic lives in one place (script content hashes in
// script-store, @require/@resource byte hashes + transport in
// external-files, GM_xmlhttpRequest response transport in gm-xhr).

// SHA-256 → lowercase hex. Accepts a string (UTF-8 encoded first) or an
// ArrayBuffer. Async because SubtleCrypto has no sync form on the web
// platform.
export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
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
