// Shared scan primitives used by every collection-kind scanner.
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
  relativePath: string; // path relative to the collection root (the raw entry string for manifest entries)
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
