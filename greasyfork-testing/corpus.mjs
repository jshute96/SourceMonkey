// Shared helpers for the GreasyFork corpus: reading and updating corpus.json
// (the listing plus test findings), and mapping URLs to their place in the
// downloaded file tree.
//
// Every tool goes through here, so they can't disagree about where a URL lives
// or trample each other's writes to corpus.json.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The corpus record file: the GreasyFork listing plus every test finding. */
export const CORPUS_JSON = fileURLToPath(new URL('./corpus.json', import.meta.url));

/** Descriptions of the statuses and built-in tags the tools produce. */
export const CORPUS_HELP_JS = fileURLToPath(new URL('./corpus-help.js', import.meta.url));

/**
 * Handle `--help` / `-h` for a tool: when `argv` has either, print the
 * comment block at the top of the tool's source (its usage docs, so the two
 * can't drift apart) and return true, for the tool to stop there.
 */
export function printHelp(argv, moduleUrl) {
  if (!argv.includes('--help') && !argv.includes('-h')) return false;
  process.stdout.write(helpText(moduleUrl));
  return true;
}

/** A tool's help: the comment block at the top of its source, uncommented. */
export function helpText(moduleUrl) {
  const lines = [];
  for (const line of readFileSync(fileURLToPath(moduleUrl), 'utf8').split('\n')) {
    if (line.startsWith('#!')) continue;
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * Read the corpus: `{ tags: { name: description }, scripts: { "<id>": record } }`.
 * `tags` defines the hand-added tags; the built-in ones are in corpus-help.js.
 */
export async function readCorpus(file = CORPUS_JSON) {
  const corpus = JSON.parse(await readFile(file, 'utf8'));
  if (!corpus || typeof corpus.scripts !== 'object' || typeof corpus.tags !== 'object') {
    throw new Error(`${file} is not a corpus file: it needs "tags" and "scripts" objects`);
  }
  return corpus;
}

/** An empty corpus, as a new corpus file starts. */
const emptyCorpus = () => ({ tags: {}, scripts: {} });

/**
 * Read corpus-help.js: `{ test, detail, tag }`. It's a script for results.html,
 * holding one strict-JSON object, so the object is parsed out of it.
 */
export function readCorpusHelp(file = CORPUS_HELP_JS) {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('{', text.indexOf('CORPUS_HELP ='));
  return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
}

/**
 * Whether `tag` is built in: one corpus-help.js describes, by its own entry
 * or a `prefix:*` template. The tools produce these, so hand-added tags can't
 * redefine them.
 */
export function isBuiltinTag(help, tag) {
  return builtinTagEntry(help, tag) !== null;
}

/** The corpus-help.js entry that describes `tag` (its own or `prefix:*`), or null. */
export function builtinTagEntry(help, tag) {
  if (Object.hasOwn(help.tag, tag)) return tag;
  const colon = tag.indexOf(':');
  const pattern = colon > 0 ? tag.slice(0, colon) + ':*' : null;
  return pattern && Object.hasOwn(help.tag, pattern) ? pattern : null;
}

/** The label for GreasyFork's top-installs listing, ranked by installs when last read. */
export const TOP_LABEL = 'top2000';

/** A record's rank under `label`, or undefined when it lacks the label or a rank. */
export function labelRank(record, label) {
  return record.labels?.find((entry) => entry.label === label)?.rank;
}

/**
 * Give a record `label`, with `rank` when there is one. A record that already
 * has the label takes the new rank, and keeps its old one when `rank` is
 * undefined. Returns `added`, `reranked`, or false for no change.
 */
export function setLabel(record, label, rank) {
  const entry = record.labels?.find((e) => e.label === label);
  if (!entry) {
    (record.labels ??= []).push(rank === undefined ? { label } : { label, rank });
    return 'added';
  }
  if (rank === undefined || entry.rank === rank) return false;
  entry.rank = rank;
  return 'reranked';
}

/**
 * The listed scripts as flat rows (`id` plus the listing fields), in
 * `TOP_LABEL` rank order, then the rest by id. Each row's `rank` is its
 * `TOP_LABEL` rank, or null.
 */
export function listingRows(corpus) {
  const rank = (row) => row.rank ?? Infinity;
  return Object.entries(corpus.scripts)
    .filter(([, record]) => record.listing)
    .map(([id, record]) => ({ id: Number(id), ...record.listing, rank: labelRank(record, TOP_LABEL) ?? null }))
    .sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

// Record keys in the order they are written, so a record reads the same way
// whichever tool last touched it and a diff shows only what changed.
const RECORD_KEYS = ['listing', 'labels', 'version', 'file', 'sites', 'valid', 'test', 'tags', 'notes'];

function canonicalRecord(record) {
  const out = {};
  for (const key of RECORD_KEYS) if (record[key] !== undefined) out[key] = record[key];
  for (const key of Object.keys(record).sort()) if (!(key in out)) out[key] = record[key];
  return out;
}

// How long a lock may sit untouched before it is presumed abandoned by a
// crashed writer. A real update takes well under a second.
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 120_000;

/**
 * Read-modify-write the corpus under a lock, so parallel writers (several
 * agents recording results at once) each see the others' changes instead of
 * overwriting them. `mutate(corpus)` edits in place; its return value is
 * passed through.
 *
 * - The lock is `<file>.lock`, created with O_EXCL, so exactly one writer holds it.
 * - The new content goes to a temp file renamed over the original, so a reader
 *   never sees a half-written file even without taking the lock.
 * - A lock older than STALE_LOCK_MS is broken. Two waiters could both break the
 *   same stale lock, but that needs a crashed writer first; not worth more.
 */
export async function updateCorpus(file, mutate) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      // Holding the lock from here: don't leave it behind if recording the pid fails.
      try {
        await handle.writeFile(`${process.pid}\n`);
      } catch (err) {
        await rm(lock, { force: true });
        throw err;
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
  try {
    const corpus = (await exists(file)) ? await readCorpus(file) : emptyCorpus();
    const result = await mutate(corpus);
    await writeCorpus(file, corpus);
    return result;
  } finally {
    await rm(lock, { force: true });
  }
}

async function writeCorpus(file, corpus) {
  const tags = {};
  for (const name of Object.keys(corpus.tags).sort()) tags[name] = corpus.tags[name];
  // Integer-like keys enumerate in numeric order, so records stay sorted by id.
  const scripts = {};
  for (const [id, record] of Object.entries(corpus.scripts)) scripts[id] = canonicalRecord(record);
  const out = { tags, scripts };
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

// Percent-encoded CJK script names are long (each character costs 9 bytes as
// `%XX%XX%XX`) and can overrun the filesystem's per-name limit. That's 255
// bytes normally, but only 143 on an eCryptfs-encrypted home (Ubuntu's
// "encrypt my home directory"). Names are cut at 143 everywhere, not at the
// local limit, so a script's path depends only on its URL: corpus.json stores
// it, and every machine agrees. The limit is per name, not per path, so the
// checkout's depth doesn't matter. A cut name keeps its leading text and
// `.user.js` suffix, with a hash of the whole name spliced in to keep it unique.
const MAX_SEGMENT_BYTES = 143;

/**
 * Check the download root before using it. Writers pass `create: true` to make
 * it; read-only callers leave it off, so a mistyped --root fails loudly instead
 * of quietly reporting nothing downloaded.
 *
 * Also records where the root is, in LOCATION_FILE inside it, for results.html:
 * a page from a static server can't otherwise learn the full paths it copies.
 * Rewritten only when it has changed, e.g. after the checkout moved.
 */
export async function checkRoot(root, { create = false } = {}) {
  if (create) await mkdir(root, { recursive: true });
  else if (!(await stat(root).then((i) => i.isDirectory(), () => false))) {
    throw new Error(`Download root does not exist: ${root}`);
  }
  const location = path.join(root, LOCATION_FILE);
  const content = JSON.stringify({ dir: path.resolve(root) }) + '\n';
  if ((await readFile(location, 'utf8').catch(() => '')) !== content) await writeFile(location, content);
}

/** Written by checkRoot. No host name starts with `_`, so it can't clash with a download. */
export const LOCATION_FILE = '_location.json';

function clampSegment(segment) {
  if (Buffer.byteLength(segment) <= MAX_SEGMENT_BYTES) return segment;
  const hash = createHash('sha1').update(segment).digest('hex').slice(0, 8);
  const suffix = segment.endsWith('.user.js') ? '.user.js' : path.extname(segment).slice(0, 16);
  const marker = `~${hash}`;
  // URL path segments are ASCII after `new URL()` percent-encodes them, so a
  // byte budget is a character budget here.
  const keep = MAX_SEGMENT_BYTES - Buffer.byteLength(marker) - Buffer.byteLength(suffix);
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

// ---------- @match / @include patterns ----------

/**
 * A host portion resolves to a single site when stripping one leading `*.`
 * leaves no wildcard: `*.youtube.com` and `www.youtube.com` both attribute to a
 * site, while `*`, `*.the-west.*`, and `` do not.
 */
export function resolveSite(hostPattern) {
  let host = hostPattern.toLowerCase();
  if (host.startsWith('*.')) host = host.slice(2);
  if (host === '' || host.includes('*')) return null;
  return host.replace(/:\d+$/, ''); // ports aren't part of the site identity
}

/**
 * Decompose one `@match` / `@include` argument.
 *
 * `shape` answers "how open-ended is this pattern" over the host and path only:
 * no `*` is absolute, a single trailing `*` is a prefix, and a `*` before the
 * end makes it an inner glob — a wildcard host or a wildcard path segment.
 *
 * The scheme is deliberately left out of that judgement. `*://` is the ordinary
 * way to write "http or https" and says nothing about how broadly a pattern
 * reaches, but counting it would push every `*://site.com/*` into the inner-glob
 * bucket and swamp the patterns that really do match mid-URL. Scheme wildcards
 * are tracked on their own in `scheme_glob`.
 *
 * @include also allows regex forms delimited by slashes, which get their own
 * shape, as does the `<all_urls>` keyword.
 */
export function classifyPattern(raw) {
  const pattern = raw.trim();
  if (!pattern) return null;

  const base = { pattern, scheme: '', host_pattern: '', site: null, scheme_glob: 0, host_glob: 0, path_glob: 0 };
  // @include regexes are delimited by slashes and aren't glob patterns at all.
  // A few lines in the corpus open with `/` but never close (an unterminated
  // regex); those fall through and get classified as globs with an empty host,
  // which is as sensible as anything for a line no manager can honour.
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return { ...base, shape: 'regex' };
  }
  // `<all_urls>` is a keyword, not a URL shape — it means "any scheme, any host".
  if (pattern === '<all_urls>') {
    return { ...base, shape: 'all-urls', scheme: '*', host_pattern: '*', scheme_glob: 1, host_glob: 1, path_glob: 1 };
  }

  const scheme = /^([^:/]*):\/\//.exec(pattern);
  const rest = scheme ? pattern.slice(scheme[0].length) : pattern;
  const slash = rest.indexOf('/');
  const hostPattern = slash === -1 ? rest : rest.slice(0, slash);
  const pathPattern = slash === -1 ? '' : rest.slice(slash);

  const stars = (rest.match(/\*/g) ?? []).length;
  const shape = stars === 0 ? 'absolute'
    : stars === 1 && rest.endsWith('*') ? 'prefix-glob'
    : 'inner-glob';

  return {
    pattern,
    shape,
    scheme: scheme ? scheme[1] : '',
    host_pattern: hostPattern,
    site: resolveSite(hostPattern),
    scheme_glob: scheme && scheme[1].includes('*') ? 1 : 0,
    host_glob: hostPattern.includes('*') ? 1 : 0,
    path_glob: pathPattern.includes('*') ? 1 : 0,
  };
}

/**
 * What one `@match` / `@include` targets, for display: the resolved site, else
 * the host as written (`*.google.*`), else the whole pattern (a regex), and `*`
 * for a pattern that matches any site.
 */
export function patternTarget(raw) {
  const parsed = classifyPattern(raw);
  if (!parsed) return null;
  if (parsed.shape === 'all-urls' || parsed.host_pattern === '*') return '*';
  return parsed.site ?? (parsed.host_pattern || parsed.pattern);
}

/** True when `file` exists (of any type). */
export async function exists(file) {
  return access(file).then(() => true, () => false);
}
