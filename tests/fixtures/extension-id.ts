// Compute Chrome's deterministic extension ID for an unpacked
// extension. The algorithm is well-known but undocumented in the
// extension docs: SHA256(absolute path bytes), take the first 16 bytes
// (32 hex chars), then map each hex digit '0'-'f' to 'a'-'p'.
//
// Needed because Chrome ≥138 gates chrome.userScripts behind a
// per-extension "Allow User Scripts" toggle. We pre-write that flag in
// the user-data-dir's Preferences file before launch, keyed by the
// computed ID, so the API is callable in headless tests.

import crypto from 'node:crypto';

export function extensionIdFromPath(absolutePath: string): string {
  const hash = crypto.createHash('sha256').update(absolutePath).digest('hex');
  return hash
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
    .join('');
}
