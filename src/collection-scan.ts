// Shared scan primitives used by every collection-kind scanner, and
// the manifest format, which sm-dev reads too (`start` and `validate`
// take a `script_manifest.json`).
//
// Lives in its own module because both `directories.ts` (local
// directory / manifest scanner) and `github-provider.ts` (Contents-API
// scanner) need them — importing them directly between the two
// scanner modules would create a runtime ES-module cycle, since
// `directories.ts` also imports the github dispatcher from
// `github-provider.ts`.

// Shape every scanner produces. One entry per discovered `.user.js`
// file, keyed by path relative to the collection's root. Optional size
// / mtime are filled in when the scan can supply them (file:// listings
// report both; HTTP and GitHub scans report only size).
export interface FoundScript {
  name: string;         // leaf file name, e.g. "foo.user.js"
  relativePath: string; // path relative to the collection root (the entry's path text for manifest entries)
  size?: number;        // file byte size — undefined for URL-style scans
  mtime?: number;       // modification time (opaque integer used only for equality — file:// only)
}

// How many subdirectory levels below the root a scanner walks before
// stopping. Applies to local directory collections AND GitHub directory
// collections (the cost model is different but the cap keeps both
// bounded).
export const MAX_SCAN_DEPTH = 2;

// The one and only filename SourceMonkey recognises as a userscript
// manifest. Lives here (not in `directories.ts`) so `github-provider.ts`
// can import it without forming a runtime cycle with `directories.ts`.
export const MANIFEST_FILENAME = 'script_manifest.json';

// ---------- Manifests ----------

// Parse a manifest body. Accepts either a bare JSON array or
// `{scripts: [...]}`. Anything else is rejected with a message that
// points at the supported shapes. Empty strings inside the list are
// dropped so a trailing newline / typo doesn't fail the whole source.
//
// List elements are either a URL string or an object with a `path`
// holding that string. The object form lets a manifest carry extra
// per-script bookkeeping (author's notes, tags, …) alongside the URL;
// every field other than `path` is ignored here, so unknown keys are
// forward-compatible rather than an error.
export function parseManifest(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { scripts?: unknown }).scripts)) {
    arr = (parsed as { scripts: unknown[] }).scripts;
  } else {
    throw new Error('Manifest must be a JSON array of entries, or `{"scripts": [...]}`');
  }
  const entries: string[] = [];
  for (const item of arr as unknown[]) {
    let value: string;
    if (typeof item === 'string') {
      value = item;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      // An array is also `typeof 'object'`, hence the isArray guard —
      // otherwise `[["a.user.js"]]` would look for a `path` field on it.
      const entryPath = (item as { path?: unknown }).path;
      if (typeof entryPath !== 'string') {
        throw new Error('Manifest entry objects must have a "path" string');
      }
      value = entryPath;
    } else {
      throw new Error('Manifest entries must all be URL strings or objects with a "path"');
    }
    const trimmed = value.trim();
    if (trimmed) entries.push(trimmed);
  }
  return entries;
}

// Schemes a manifest entry's *resolved* URL is allowed to use. We mirror the
// suffix-test policy on the collection URL itself (which only accepts
// http(s) / file: / raw path): a manifest the user added shouldn't be
// able to escalate the SW's `<all_urls>` reach into things like `data:`
// (arbitrary inline content), `chrome-extension:` (cross-extension
// probing), or `blob:` (off-origin smuggling). The user can always add
// such collections directly if they want them.
export const ALLOWED_ENTRY_SCHEMES = new Set(['http:', 'https:', 'file:']);

// Resolve a manifest entry against the manifest's canonical URL.
//
// On top of plain RFC 3986 resolution, if the entry doesn't bring its
// own query string and lands in the same origin as the manifest, the
// manifest's query string is propagated onto the resolved URL. This
// lets a single auth-bearing manifest URL (e.g. GitHub's
// `…/script_manifest.json?token=…`) reach its companion scripts
// without each manifest entry having to repeat the token. Cross-origin
// or self-querying entries are left alone — the propagation rule only
// fires when the entry is clearly "another file alongside the
// manifest". Throws on a malformed entry; the caller layers
// scheme-gating on top.
export function resolveManifestEntryUrl(entry: string, canonicalUrl: string): URL {
  const base = new URL(canonicalUrl);
  let resolved: URL;
  try {
    resolved = new URL(entry, canonicalUrl);
  } catch {
    throw new Error(`Manifest entry is not a valid URL: ${entry}`);
  }
  if (!resolved.search && base.search && resolved.origin === base.origin) {
    resolved.search = base.search;
  }
  return resolved;
}
