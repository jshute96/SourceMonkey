// Directory I/O for userscript sources.
//
// Owns: path → file:// URL conversion, single-file fetch, Chrome's
// `file://` directory-listing parser, and the recursive scanner that
// finds `*.user.js` files under a registered directory. All
// persistence lives in `src/script-store.ts`; this module is pure I/O.
//
// Why XMLHttpRequest instead of fetch(): fetch() treats
// chrome-extension:// → file:// as cross-origin and returns an opaque
// response (status 0, unreadable body). XHR doesn't apply that
// restriction. For file:// XHRs, `status` stays 0 even on success
// (there's no HTTP layer), so we infer success from `onload` plus a
// non-empty responseText.
//
// Requirements:
//   - manifest: "file:///*" in host_permissions
//   - user: enabled "Allow access to file URLs" on chrome://extensions
// The toggle is persistent across browser sessions, so unlike the File
// System Access API there is no per-session re-grant.

export interface FoundScript {
  name: string;         // leaf file name, e.g. "foo.user.js"
  relativePath: string; // path relative to the directory root, e.g. "sub/foo.user.js"
  size?: number;        // file byte size as reported by Chrome's listing (undefined if listing didn't include it)
  mtime?: number;       // modification time as reported by Chrome's listing — opaque integer used only for equality
}

// ---------- URL / path helpers ----------

// Build a file:// URL from an absolute filesystem path, percent-encoding
// each segment so spaces and other reserved characters produce a valid
// URL. POSIX paths get the conventional `file://` + leading slash.
export function pathToFileUrl(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

export function joinPath(base: string, child: string): string {
  return base.replace(/\/+$/, '') + '/' + child;
}

// ---------- File / directory fetch ----------

export function fetchFileUrlText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'text';
    xhr.onload = () => {
      // For file:// XHRs the status is always 0; non-empty responseText
      // is our signal that the read actually returned content.
      if (xhr.responseText) resolve(xhr.responseText);
      else reject(new Error(`empty response from ${url}`));
    };
    xhr.onerror = () => reject(new Error(`network error fetching ${url}`));
    xhr.send();
  });
}

// ---------- Directory listing parser ----------

export interface ListingEntry {
  name: string;
  isDir: boolean;
  size?: number;     // bytes; undefined if the listing didn't supply it
  mtime?: number;    // opaque modification-time integer for equality only
}

// Chrome's file:// directory listing is an HTML page that injects
// entries via JavaScript calls like:
//   addRow("name", "url", isdir, size, "size_str", date, "date_str")
// where `isdir` is 0/1 (older Chrome) or true/false. We pull:
//   - the name (first arg) and the isdir flag (third) to classify;
//   - the numeric size (fourth) and date (sixth) so the refresh
//     pipeline can skip refetching files whose size+mtime are
//     unchanged.
//
// This is intentionally tolerant: Chrome's exact listing format isn't
// a stable contract, so the regex matches the common shape and ignores
// any addRow calls it can't parse. The size/mtime captures are
// optional — entries without them parse but with size/mtime undefined,
// at which point the refresh pipeline falls back to always-refetch
// for those files.
export function parseListing(html: string): ListingEntry[] {
  const entries: ListingEntry[] = [];
  const re = /addRow\("((?:\\.|[^"\\])*)"\s*,\s*"(?:\\.|[^"\\])*"\s*,\s*(0|1|true|false)\b(?:\s*,\s*(-?\d+))?(?:\s*,\s*"(?:\\.|[^"\\])*")?(?:\s*,\s*(-?\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let name: string;
    try {
      // The captured first argument is a JS string literal body —
      // JSON.parse round-trips the standard \" \\ \n \uXXXX escapes.
      name = JSON.parse('"' + m[1] + '"');
    } catch {
      continue;
    }
    if (name === '..' || name === '.') continue;
    const isDir = m[2] === '1' || m[2] === 'true';
    const entry: ListingEntry = { name, isDir };
    if (m[3] !== undefined) entry.size = Number(m[3]);
    if (m[4] !== undefined) entry.mtime = Number(m[4]);
    entries.push(entry);
  }
  return entries;
}

async function listDirectory(absolutePath: string): Promise<ListingEntry[]> {
  // Chrome only serves the directory listing for URLs ending with `/`.
  const url = pathToFileUrl(absolutePath) + '/';
  return parseListing(await fetchFileUrlText(url));
}

// Targeted version of listDirectory: list a single directory and return
// just the entry for `fileName` (or null if absent). Used by the
// single-file refresh path so it can capture the file's current
// size/mtime without doing a full recursive scan — keeps the
// unchanged-file skip honest for the next Refresh All.
export async function statFromListing(
  absoluteDir: string,
  fileName: string,
): Promise<ListingEntry | null> {
  const entries = await listDirectory(absoluteDir);
  return entries.find((e) => e.name === fileName) ?? null;
}

// ---------- Scanning ----------

export const MAX_SCAN_DEPTH = 2; // levels of subdirectory below the root

export async function scanForUserScripts(
  absolutePath: string,
  depth = 0,
  prefix = '',
): Promise<FoundScript[]> {
  const entries = await listDirectory(absolutePath);
  const results: FoundScript[] = [];
  for (const entry of entries) {
    if (!entry.isDir && entry.name.endsWith('.user.js')) {
      const found: FoundScript = { name: entry.name, relativePath: prefix + entry.name };
      if (entry.size !== undefined) found.size = entry.size;
      if (entry.mtime !== undefined) found.mtime = entry.mtime;
      results.push(found);
    } else if (entry.isDir && depth < MAX_SCAN_DEPTH) {
      const sub = await scanForUserScripts(
        joinPath(absolutePath, entry.name),
        depth + 1,
        prefix + entry.name + '/',
      );
      results.push(...sub);
    }
  }
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

// Build a file:// URL for a specific scanned script.
export function scriptFileUrl(absoluteDir: string, relativePath: string): string {
  return pathToFileUrl(joinPath(absoluteDir, relativePath));
}
