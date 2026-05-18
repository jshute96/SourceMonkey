// Directory I/O for userscript sources.
//
// Owns: path → file:// URL conversion, single-file fetch, Chrome's
// `file://` directory-listing parser, and the recursive scanner that
// finds `*.user.js` files under a registered directory. All
// persistence lives in `src/script-store.ts`; this module is pure I/O.
//
// Why XMLHttpRequest in page contexts: fetch() treats
// chrome-extension:// → file:// as cross-origin and returns an opaque
// response (status 0, unreadable body). XHR doesn't apply that
// restriction. For file:// XHRs, `status` stays 0 even on success
// (there's no HTTP layer), so we infer success from `onload` plus a
// non-empty responseText.
//
// Service-worker fallback: MV3 service workers have no XMLHttpRequest
// at all, so we can't use the XHR path there. fetch() does work from a
// SW for `file://` URLs as long as the manifest grants `file:///*` in
// host_permissions (and the user has flipped "Allow access to file
// URLs") — the cross-origin restriction above is a document-context
// behavior, not a SW one. We pick the path at call time by checking
// for XHR availability.
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

// A source path that points directly at a single `.user.js` file rather
// than a directory containing them. The rest of the pipeline treats
// such a source as if it were a directory holding exactly one script.
export function isSingleFilePath(path: string): boolean {
  return path.endsWith('.user.js');
}

// Return the parent directory of an absolute POSIX path. The result
// has no trailing slash; for a top-level path like `/foo` returns `/`.
export function parentDir(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return '';
  if (slash === 0) return '/';
  return trimmed.slice(0, slash);
}

// Return the leaf name of an absolute POSIX path (the part after the
// last `/`). Trailing slashes are stripped first.
export function baseName(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

// ---------- File / directory fetch ----------

export function fetchFileUrlText(url: string): Promise<string> {
  if (typeof XMLHttpRequest !== 'undefined') return fetchFileUrlTextXhr(url);
  return fetchFileUrlTextFetch(url);
}

function fetchFileUrlTextXhr(url: string): Promise<string> {
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

// Service-worker path: fetch() works for file:// URLs when the SW has
// the matching host permission. `response.ok` is true for file://
// fetches that succeed (Chrome synthesises status 200); a 404-style
// missing file shows up as a network error or response.ok === false,
// not a thrown exception, so we have to inspect both.
async function fetchFileUrlTextFetch(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok && response.status !== 0) {
    throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  }
  // Opaque responses (response.type === 'opaque') have an unreadable
  // body; surface a distinct error rather than returning empty content,
  // so a manual refresh from a page context can succeed where the SW
  // path fell through.
  if (response.type === 'opaque') {
    throw new Error(`opaque response from ${url} (file:// fetch not permitted in this context)`);
  }
  const text = await response.text();
  if (!text) throw new Error(`empty response from ${url}`);
  return text;
}

// Best-effort "does the path point to a readable file" probe. Used to
// turn the otherwise-cryptic "network error fetching …/" message into a
// clearer one when the user types a path to an existing non-userscript
// file. Returns false on any error (including non-existence and
// permission failures) — callers should only rely on a true result.
async function isReadableFile(absolutePath: string): Promise<boolean> {
  try {
    await fetchFileUrlText(pathToFileUrl(absolutePath));
    return true;
  } catch {
    return false;
  }
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
  // Single-file source: behave as if this file is the only entry in
  // its parent directory. We still list the parent so we can capture
  // its listing-reported size+mtime for the unchanged-file skip; if
  // the file isn't in the listing, return [] so the refresh pipeline
  // flags it as missing (same treatment as a vanished file in a
  // directory source).
  if (depth === 0 && isSingleFilePath(absolutePath)) {
    const dir = parentDir(absolutePath);
    const name = baseName(absolutePath);
    const stat = await statFromListing(dir, name);
    if (!stat || stat.isDir) return [];
    const found: FoundScript = { name, relativePath: name };
    if (stat.size !== undefined) found.size = stat.size;
    if (stat.mtime !== undefined) found.mtime = stat.mtime;
    return [found];
  }
  let entries: ListingEntry[];
  try {
    entries = await listDirectory(absolutePath);
  } catch (err) {
    // Common foot-gun at the top level: the user types a path to a file
    // whose name doesn't end with `.user.js` (e.g. `notes.md`). The
    // listing fetch above asks Chrome for `file://…/notes.md/`, which
    // produces an opaque "network error" message. Probe by reading the
    // path as a plain file; if that succeeds we know the path exists
    // but isn't a userscript, so swap in a clearer message.
    if (depth === 0 && await isReadableFile(absolutePath)) {
      throw new Error(
        `path is a file but its name doesn't end with .user.js — only *.user.js files can be added as single-file sources`,
      );
    }
    throw err;
  }
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

// Build a file:// URL for a specific scanned script. For a single-file
// source the relativePath equals the source path's basename, so the
// join would double the name — just return the source path's URL.
export function scriptFileUrl(sourcePath: string, relativePath: string): string {
  return pathToFileUrl(scriptAbsolutePath(sourcePath, relativePath));
}

// Build the absolute filesystem path for a specific scanned script.
// Shared by the URL builder above and the viewer's Filename row so a
// single-file source doesn't get its basename joined twice.
export function scriptAbsolutePath(sourcePath: string, relativePath: string): string {
  if (isSingleFilePath(sourcePath)) return sourcePath;
  return joinPath(sourcePath, relativePath);
}
