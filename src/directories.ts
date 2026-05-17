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
}

// Chrome's file:// directory listing is an HTML page that injects
// entries via JavaScript calls like:
//   addRow("name", "url", isdir, size, "size_str", date, "date_str")
// where `isdir` is 0/1 (older Chrome) or true/false. We pull the name
// (first arg) and the third positional argument to classify entries.
//
// This is intentionally tolerant: Chrome's exact listing format isn't
// a stable contract, so the regex matches the common shape and ignores
// any addRow calls it can't parse.
export function parseListing(html: string): ListingEntry[] {
  const entries: ListingEntry[] = [];
  const re = /addRow\("((?:\\.|[^"\\])*)"\s*,\s*"(?:\\.|[^"\\])*"\s*,\s*(0|1|true|false)\b/g;
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
    entries.push({ name, isDir });
  }
  return entries;
}

async function listDirectory(absolutePath: string): Promise<ListingEntry[]> {
  // Chrome only serves the directory listing for URLs ending with `/`.
  const url = pathToFileUrl(absolutePath) + '/';
  return parseListing(await fetchFileUrlText(url));
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
      results.push({ name: entry.name, relativePath: prefix + entry.name });
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
