// Writes the backup export's zip (docs/export-format.md), through the
// vendored fflate library (src/vendor/fflate.d.ts).
//
// fflate deflates each entry and marks non-ASCII names as UTF-8, which
// Tampermonkey's and Violentmonkey's readers both honor.

import { zipSync, type Zippable } from '../vendor/fflate.js';

export interface ZipEntry {
  // Path inside the archive, `/`-separated, no leading slash.
  path: string;
  data: Uint8Array;
  // Shown as the entry's modified time; the export time when absent.
  modified?: number;
}

// The archive's bytes. A repeated path is the caller's bug, refused
// rather than letting the later one replace the earlier.
//
// fflate takes the entries as an object, so an integer-like path (`7`)
// is written before the others; the order otherwise holds.
export function buildZip(entries: readonly ZipEntry[], now: number = Date.now()): Uint8Array {
  // fflate writes no zip64, so past this the entry count would wrap.
  if (entries.length > 0xffff) throw new Error('The export has more files than a zip file can hold (65,535)');
  // No prototype, so a path like `__proto__` is an ordinary key.
  const files: Zippable = Object.create(null);
  for (const entry of entries) {
    if (Object.hasOwn(files, entry.path)) throw new Error(`Internal error: The zip has two entries named ${entry.path}`);
    files[entry.path] = [entry.data, { mtime: zipTime(entry.modified ?? now) }];
  }
  return zipSync(files);
}

// A zip's dates run from 1980 to 2099, and fflate refuses one outside
// them. A row that never recorded a load time has 0.
const ZIP_EARLIEST = Date.UTC(1980, 0, 2);
const ZIP_LATEST = Date.UTC(2099, 11, 31);
function zipTime(ms: number): number {
  return Math.min(Math.max(ms, ZIP_EARLIEST), ZIP_LATEST);
}
