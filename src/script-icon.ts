// A script's own icon (`@icon` and its aliases): which header tag names
// it, and the rules an icon file has to meet to be shown. Shared by the
// pages that paint icons (`extension/site-icon.ts`) and the load-time
// check that warns about an icon that can't be shown
// (`checkScriptIcon` in `external-files.ts`), so both apply one rule.

// Tag priority for a script-declared icon. `@icon` is the only form
// documented by all three managers (TM/VM/GM, i.e. Tampermonkey,
// Violentmonkey, Greasemonkey); the rest are TM-only aliases. The
// smaller variants come first so a script that declares both a regular
// and a 64×64 icon picks the one closer to our 16×16 display size.
const ICON_HEADER_TAGS = ['icon', 'iconurl', 'defaulticon', 'icon64url', 'icon64'];

// Largest icon file we will show. An icon is drawn at 16px, so anything
// near this is far bigger than it needs to be.
export const MAX_ICON_BYTES = 128 * 1024;

// Whether a response's Content-Type is one an icon can have.
export function isIconContentType(contentType: string): boolean {
  return contentType.startsWith('image/');
}

interface IconHeader {
  tags: { tag: string; locale?: string; value: string; line?: number }[];
}

// The icon declaration that wins: its reference, raw (just trimmed and
// non-empty), and the header line it is on. Null when none is set.
export function iconDeclFromHeader(
  header: IconHeader | null,
): { ref: string; line?: number } | null {
  if (!header) return null;
  for (const tag of ICON_HEADER_TAGS) {
    for (const e of header.tags) {
      if (e.tag !== tag || e.locale !== undefined) continue;
      const trimmed = e.value.trim();
      if (trimmed) return e.line === undefined ? { ref: trimmed } : { ref: trimmed, line: e.line };
    }
  }
  return null;
}

// Read the highest-priority icon reference declared in the parsed
// metadata, or null when none is set. The reference comes back raw
// (just trimmed + non-empty); resolving it into an absolute URL —
// including the relative-path-against-script-parent rules and `..`
// rejection — is the file-loader's job and happens at render time
// when the script's `fileUrl` is in scope.
export function iconRefFromHeader(header: IconHeader | null): string | null {
  return iconDeclFromHeader(header)?.ref ?? null;
}
