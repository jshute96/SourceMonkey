// Shared scan primitives used by every source-kind scanner.
//
// Lives in its own module because both `directories.ts` (local
// directory / manifest scanner) and `github-source.ts` (Contents-API
// scanner) need them — importing them directly between the two
// scanner modules would create a runtime ES-module cycle, since
// `directories.ts` also imports the github dispatcher from
// `github-source.ts`.

// Shape every scanner produces. One entry per discovered `.user.js`
// file, keyed by path relative to the source's root. Optional size /
// mtime are filled in when the scan can supply them (file:// listings
// report both; HTTP and GitHub scans report only size).
export interface FoundScript {
  name: string;         // leaf file name, e.g. "foo.user.js"
  relativePath: string; // path relative to the source root (basename for single-file / manifest entries)
  size?: number;        // file byte size — undefined for HTTP single-file sources
  mtime?: number;       // modification time (opaque integer used only for equality — file:// only)
}

// How many subdirectory levels below the root a scanner walks before
// stopping. Applies to local directory sources AND GitHub directory
// sources (the cost model is different but the cap keeps both bounded).
export const MAX_SCAN_DEPTH = 2;
