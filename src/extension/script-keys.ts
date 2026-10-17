// The two keys that say whether two installed rows are copies of one
// script: the same `@namespace` + `@name`, or the same absolute
// location. Kept apart from script-identity.ts (which finds the copies)
// so the store can use them without importing that module, which
// imports the store. See [docs/script-identity.md].

import { canonicalCollectionInput } from './directories.js';
import { getValue, type ParsedHeader } from '../userscript-header.js';

// The ecosystem identity key: `@namespace` and `@name`, trimmed and
// joined by a separator that can't occur in either.
//
// `null` when there is no `@name` — with nothing to key on we decline
// to match rather than fold every nameless script together. A missing
// `@namespace` is NOT the same case: the empty namespace is a real
// (if unwise) value, and two scripts that both omit it and share a
// name are treated as the same script, which is exactly what TM and
// VM do. That is the convention's known weak spot, not ours to fix
// unilaterally.
//
// Comparison is exact after trimming — no case folding, no URL
// normalization of the namespace. `HTTP://Example.com/` and
// `http://example.com/` are different namespaces to every other
// manager, and quietly disagreeing would make our "same script"
// answer differ from the one the user sees in Tampermonkey.
//
// Spelled as an escape, never as a literal NUL byte: a raw NUL makes
// grep treat the whole source file as binary and print nothing for
// every match in it.
const IDENTITY_SEP = '\u0000';

export function identityKey(header: ParsedHeader | null): string | null {
  if (!header) return null;
  const name = getValue(header, 'name')?.trim();
  if (!name) return null;
  const namespace = getValue(header, 'namespace')?.trim() ?? '';
  return `${namespace}${IDENTITY_SEP}${name}`;
}

// The location key: the one true spelling of an absolute script
// location. `canonicalCollectionInput` is the same helper
// `addCollection` uses, so a `file://` URL and the bare path spelling
// of the same file collapse together — which is what lets a directory
// collection's `fileUrl` (always a `file://` URL) match a container
// row's bare path, and what makes a capture's URL match a row stored
// before canonicalization existed.
export function locationKey(absoluteUrl: string): string {
  return canonicalCollectionInput(absoluteUrl);
}

// Whether two rows are copies of one script, by either key.
export function sameScript(
  a: { fileUrl: string; header?: ParsedHeader | null },
  b: { fileUrl: string; header?: ParsedHeader | null },
): boolean {
  if (locationKey(a.fileUrl) === locationKey(b.fileUrl)) return true;
  const ia = identityKey(a.header ?? null);
  return ia !== null && ia === identityKey(b.header ?? null);
}
