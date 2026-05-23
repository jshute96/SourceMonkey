// Compute Chrome's deterministic extension ID.
//
// Chrome picks ONE of two IDs depending on the manifest:
//   - If manifest.json has a `"key"` (base64-encoded public key),
//     Chrome derives the ID from the key bytes. That gives a stable
//     ID across machines and unpacked-load paths.
//   - Otherwise Chrome derives the ID from the absolute filesystem
//     path of the extension dir.
//
// In both cases the algorithm is: SHA256 → first 16 bytes (32 hex
// chars) → map each hex digit `0`–`f` to `a`–`p`. The hash input is
// the public-key bytes (key-case) or the path bytes (path-case).
//
// Needed because Chrome ≥138 gates chrome.userScripts behind a
// per-extension "Allow User Scripts" toggle. We pre-write that flag in
// the user-data-dir's Preferences file before launch, keyed by the
// computed ID, so the API is callable in headless tests. Writing to
// the wrong ID silently no-ops — the SW boots, runs, never gets the
// user-scripts API surface, and every test that tries to register a
// userscript sees an empty registration set.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Apply the "first 16 hex bytes, mapped a–p" finishing step.
function finishId(sha256HexDigest: string): string {
  return sha256HexDigest
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
    .join('');
}

// Path-only ID derivation. Exposed for callers that know there's no
// `key` in the manifest.
export function extensionIdFromPathOnly(absolutePath: string): string {
  return finishId(crypto.createHash('sha256').update(absolutePath).digest('hex'));
}

// Public-key derivation. Chrome uses the raw bytes of the key, NOT
// the base64-encoded form.
export function extensionIdFromKey(base64Key: string): string {
  const keyBytes = Buffer.from(base64Key, 'base64');
  return finishId(crypto.createHash('sha256').update(keyBytes).digest('hex'));
}

// Computes the ID Chrome will actually use for the unpacked extension
// at `absolutePath`. Reads <absolutePath>/manifest.json and uses the
// `key` field if present; otherwise falls back to the path-based
// derivation.
export function extensionIdFromPath(absolutePath: string): string {
  const manifestPath = path.join(absolutePath, 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.key === 'string' && manifest.key.length > 0) {
      return extensionIdFromKey(manifest.key);
    }
  } catch {
    // Fall through to path-based ID. Most likely cause is that the
    // build hasn't run yet, so dist/manifest.json doesn't exist —
    // either way the path-based ID is the safe default.
  }
  return extensionIdFromPathOnly(absolutePath);
}
