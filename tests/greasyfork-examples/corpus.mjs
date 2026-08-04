// Shared helpers for the GreasyFork corpus: reading the CSV the extractor
// writes, and mapping URLs to their place in the downloaded file tree.
//
// Both download-scripts.mjs (which writes the tree) and build-db.mjs (which
// reads it) go through here, so the two can't disagree about where a URL lives.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Minimal RFC-4180 CSV reader — enough for the files fetch-top-scripts.mjs writes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

// Percent-encoded CJK script names are long — each character costs 9 bytes as
// `%XX%XX%XX` — and blow past the filesystem's per-name limit. That limit isn't
// always the familiar 255: an eCryptfs-encrypted home (Ubuntu's "encrypt my
// home directory") caps names at 143 bytes, so we probe for the real ceiling
// instead of assuming. Over-long names get truncated with a hash of the full
// segment spliced in, keeping them unique and deterministic while the leading
// text and the `.user.js` suffix stay readable.
let maxSegmentBytes = 255;

/**
 * Probe the per-filename limit under `root` and remember it. Every tool touching
 * the tree must call this first, or it will compute different paths than the one
 * that wrote the files. The ladder finds the largest value that works, which is
 * the real ceiling only when it is one of the listed sizes — good enough, since
 * the point is to stay under it.
 *
 * Read-only callers pass `create: false` so a mistyped --root fails loudly
 * instead of quietly creating an empty tree and reporting nothing downloaded.
 */
export async function detectMaxFilename(root, { create = true } = {}) {
  if (create) await mkdir(root, { recursive: true });
  else if (!(await stat(root).then((i) => i.isDirectory(), () => false))) {
    throw new Error(`Download root does not exist: ${root}`);
  }
  for (const limit of [255, 143, 120, 64]) {
    const probe = path.join(root, 'x'.repeat(limit));
    try {
      await writeFile(probe, '');
      await rm(probe);
      maxSegmentBytes = limit;
      return limit;
    } catch (err) {
      if (err.code !== 'ENAMETOOLONG') throw err;
    }
  }
  throw new Error(`Could not find a usable filename length under ${root}`);
}

function clampSegment(segment) {
  if (Buffer.byteLength(segment) <= maxSegmentBytes) return segment;
  const hash = createHash('sha1').update(segment).digest('hex').slice(0, 8);
  const suffix = segment.endsWith('.user.js') ? '.user.js' : path.extname(segment).slice(0, 16);
  const marker = `~${hash}`;
  // URL path segments are ASCII after `new URL()` percent-encodes them, so a
  // byte budget is a character budget here.
  const keep = maxSegmentBytes - Buffer.byteLength(marker) - Buffer.byteLength(suffix);
  // Don't cut through a `%XX` escape. A partial multi-byte sequence can still
  // survive (a whole `%E9` that needed two more bytes), so the prefix is
  // readable rather than guaranteed-decodable; the hash keeps it unique.
  const prefix = segment.slice(0, keep).replace(/%[0-9a-fA-F]?$/, '');
  return prefix + marker + suffix;
}

/**
 * Map a URL to its on-disk path. Path segments keep their percent-encoding, so
 * the filename round-trips back to the URL and odd characters (spaces, `!`,
 * non-ASCII) never reach the filesystem. A query string is appended verbatim,
 * since some @require URLs differ only there.
 */
export function urlToPath(root, url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  // A URL ending in `/` (or with no path) still needs a filename.
  if (segments.length === 0 || parsed.pathname.endsWith('/')) segments.push('index');
  if (parsed.search) segments[segments.length - 1] += parsed.search;
  const target = path.join(root, parsed.host, ...segments.map(clampSegment));
  // Belt and braces: `new URL()` already resolves `..` out of `pathname`, and
  // path.join() normalizes, so this should be unreachable — but a path escaping
  // the root is bad enough to be worth one comparison.
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside the download root: ${url}`);
  }
  return target;
}

/**
 * The same host can serve one URL path as a file and use it as a directory
 * prefix for another:
 *   https://cdn.jsdelivr.net/npm/sweetalert2@11             → a file
 *   https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/x.js   → needs it as a dir
 * A filesystem can't have both. Resolve it the way a web server does — the bare
 * path becomes a directory index — so `<path>` is stored as `<path>/index`,
 * matching what urlToPath() already does for URLs ending in `/`.
 *
 * Whichever URL we happen to fetch first, the outcome is the same: an existing
 * file in the way gets moved down into its own directory.
 */
export async function resolveTarget(target, root, { onMove } = {}) {
  const parts = path.relative(root, path.dirname(target)).split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    const ancestor = path.join(root, ...parts.slice(0, i));
    const info = await stat(ancestor).catch(() => null);
    if (!info?.isFile()) continue;
    const staged = `${ancestor}.__relocating`;
    await rename(ancestor, staged);
    await mkdir(ancestor, { recursive: true });
    await rename(staged, path.join(ancestor, 'index'));
    onMove?.(path.relative(root, ancestor));
  }
  const info = await stat(target).catch(() => null);
  return info?.isDirectory() ? path.join(target, 'index') : target;
}

/**
 * Read-only counterpart to resolveTarget: where does this URL's content
 * actually live? Returns null when it was never downloaded.
 */
export async function findExisting(root, url) {
  let target;
  try {
    target = urlToPath(root, url);
  } catch {
    return null;
  }
  const info = await stat(target).catch(() => null);
  if (info?.isFile()) return target;
  if (info?.isDirectory()) {
    const index = path.join(target, 'index');
    if (await access(index).then(() => true, () => false)) return index;
  }
  return null;
}

/** Read a downloaded file's text, wherever findExisting() says it lives. */
export async function readDownloaded(root, url) {
  const file = await findExisting(root, url);
  return file === null ? null : { file, text: await readFile(file, 'utf8') };
}

/**
 * `@resource NAME URL`. A handful of scripts in the corpus omit the name and
 * write a bare URL, so a lone token is treated as the URL with an empty name.
 * Shared so the downloader and the database agree on which URL a line names.
 */
export function parseResourceValue(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return null;
  if (parts.length === 1) return { name: '', url: parts[0] };
  return { name: parts[0], url: parts[1] };
}

/**
 * Absolute form of a dependency URL, or null when it isn't usable http(s).
 * Relative and `//host/path` forms resolve against the script's own URL.
 */
export function resolveDependencyUrl(raw, scriptUrl) {
  try {
    const resolved = new URL(raw.trim(), scriptUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

/** The URL a dependency line points at, for either tag. Null when unusable. */
export function dependencyUrlFor(tag, value, scriptUrl) {
  if (tag === 'resource') {
    const parsed = parseResourceValue(value);
    return parsed ? resolveDependencyUrl(parsed.url, scriptUrl) : null;
  }
  return resolveDependencyUrl(value, scriptUrl);
}

/** True when `file` exists (of any type). */
export async function exists(file) {
  return access(file).then(() => true, () => false);
}
