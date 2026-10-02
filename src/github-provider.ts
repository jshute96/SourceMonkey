// GitHub-specific collection handling: URL parsing, default-branch
// resolution, raw-URL normalization, recursive Contents-API scanner,
// and the per-script file/display URL builders for the github-dir
// collection kind. `directories.ts` dispatches to the exports here from
// its collection-kind branches; nothing in this file is aware of file://
// or local-filesystem collections.
//
// Two ergonomic problems we paper over here:
//
// 1. `github.com/<o>/<r>/blob/<ref>/<path>` URLs (what the user copies
//    from the browser address bar) serve an HTML rendering of the
//    file, not the raw bytes. `normalizeGithubInput` rewrites those to
//    their `raw.githubusercontent.com` counterpart at add-collection time
//    so the rest of the pipeline treats them as ordinary HTTP single-
//    file / manifest collections. Recognised file shapes are `.user.js`
//    files and the fixed `script_manifest.json` manifest filename.
// 2. GitHub directory URLs (`/tree/<ref>/<path>` and, by extension, a
//    misused `/blob/<ref>/<dir>` form) have no direct "give me all the
//    `.user.js` files inside" endpoint. `scanGithubDir` uses the
//    Contents API to walk the tree at scan time, returning the same
//    `FoundScript` shape the other collection kinds produce.
//
// Bare repo URLs (`github.com/<o>/<r>` with no `/blob|tree/...`
// segment) resolve to `tree/<default-branch>` via one repo-metadata
// API call at add time; the resolved branch is baked into the stored
// collection path so refreshes are deterministic afterwards.
//
// Branch names containing slashes (e.g. `feature/foo`) aren't
// supported — the matcher takes the first ref segment and assumes the
// rest is the path.

import { type FoundScript, MAX_SCAN_DEPTH, MANIFEST_FILENAME } from './collection-scan.js';
import { githubAuthHeaders, getGithubAuthToken } from './github-auth.js';
import { mapWithConcurrency, SCAN_GITHUB_DIRS_CONCURRENCY } from './concurrency.js';

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^\/?#]+)\/([^\/?#]+)\/(blob|tree)\/([^\/?#]+)(?:\/([^?#]*))?(?:\?[^#]*)?(?:#.*)?$/i;

// Matches a bare `https://github.com/<owner>/<repo>` URL — no
// `/blob|tree/...` segment, no path. Used to recognise repo-root
// inputs at add time so we can resolve the default branch and store
// a canonical `/tree/<branch>` URL.
const GITHUB_REPO_ROOT_RE = /^https?:\/\/github\.com\/([^\/?#]+)\/([^\/?#]+?)(?:\.git)?\/?(?:\?[^#]*)?(?:#.*)?$/i;

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  kind: 'blob' | 'tree';
  ref: string;
  path: string;       // empty when the URL points at the directory root for that ref
}

// Parse a github.com browser URL. Returns null for anything that
// doesn't match the `(blob|tree)/<ref>/...` shape (including repo-root
// URLs and any non-github host).
export function parseGithubUrl(input: string): ParsedGithubUrl | null {
  const m = GITHUB_URL_RE.exec(input);
  if (!m) return null;
  return {
    owner: m[1]!,
    repo: m[2]!.replace(/\.git$/, ''),
    kind: m[3]!.toLowerCase() as 'blob' | 'tree',
    ref: m[4]!,
    path: (m[5] ?? '').replace(/\/+$/, ''),
  };
}

// True for a github.com URL pointing at a directory. `/tree/...` is the
// canonical form, but we also accept `/blob/<ref>/<dir>` (the form a
// user might end up with by editing a blob URL by hand) as long as the
// path doesn't look like a recognised file: `.user.js` (single script)
// or basename `script_manifest.json` (manifest).
export function isGithubDirCollection(input: string): boolean {
  const p = parseGithubUrl(input);
  if (!p) return false;
  return !isGithubFilePath(p.path);
}

// True when the parsed GitHub path points at one of the file shapes we
// recognise (a userscript or a manifest under its fixed filename).
function isGithubFilePath(p: string): boolean {
  if (p.endsWith('.user.js')) return true;
  if (p === MANIFEST_FILENAME) return true;
  if (p.endsWith('/' + MANIFEST_FILENAME)) return true;
  return false;
}

// Build the raw.githubusercontent.com URL for a parsed file URL. Caller
// must have already verified the URL's path is a recognised file shape
// (see `isGithubFilePath` / `normalizeGithubInput`'s inline check).
function githubFileUrlToRaw(p: ParsedGithubUrl): string {
  return `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${p.ref}/${p.path}`;
}

// Reverse of `githubFileUrlToRaw`: take a raw-content GitHub URL and
// return its `github.com/<o>/<r>/blob/<ref>/<path>` counterpart — the
// page a human would open in a browser. Used wherever the UI surfaces
// a github URL for clicking (collections-page bubble, viewer Location
// row): the raw URL is what we fetch from, but the blob URL is what
// the user wants to see.
//
// "Raw" here covers both hosts GitHub serves raw bytes from:
//   - `raw.githubusercontent.com/<o>/<r>/[refs/<type>/]<ref>/<path>`
//   - `github.com/<o>/<r>/raw/[refs/<type>/]<ref>/<path>` (the form
//     produced by github.com's own "Raw" button — it 302s to the
//     `raw.githubusercontent.com` host but we may store the URL in
//     this form when the user pastes it directly, or when a manifest
//     entry resolves to a URL in this shape).
//
// The optional `/refs/<type>/` segment is the new-style raw URL.
// `<type>` is typically `heads` (branch) but can also be `tags` or
// `pull` — we accept any single segment there so tag URLs map
// correctly to `blob/<tag>/<path>`. Both stripped shapes resolve to
// the same content.
//
// Limitation inherited from the rest of this module: branch names
// containing `/` (e.g. `feature/foo`) are not supported — the
// first ref segment is taken and the rest folded into the path.
//
// Returns null for any URL that isn't a recognised raw URL — callers
// fall back to the original URL.
//
// Query strings + fragments get stripped — they don't carry over to
// the github.com page (a `?token=…` is raw-only; an `#L42` fragment
// would point at the wrong viewer anchor).
export function githubRawToBlobUrl(rawUrl: string): string | null {
  // Two regexes (rather than one with alternation) because owner/repo
  // sit at different positions in the two shapes.
  let m = /^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(?:refs\/[^\/]+\/)?([^\/]+)\/([^?#]+)/i.exec(rawUrl);
  if (!m) {
    m = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/raw\/(?:refs\/[^\/]+\/)?([^\/]+)\/([^?#]+)/i.exec(rawUrl);
  }
  if (!m) return null;
  const [, owner, repo, ref, path] = m;
  return `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
}

// Resolve a per-script entry under a github-dir collection to its raw
// URL (what `fetchHttpText` reads). Exported for `directories.ts`'s
// `scriptFileUrl` dispatch.
export function githubDirScriptFileUrl(collectionPath: string, relativePath: string): string {
  const p = parseGithubUrl(collectionPath);
  if (!p) throw new Error(`Not a GitHub URL: ${collectionPath}`);
  const full = p.path ? `${p.path}/${relativePath}` : relativePath;
  return `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${p.ref}/${full}`;
}

// Resolve a per-script entry under a github-dir collection to its
// human-displayable github.com URL (what the viewer's Location row
// shows). Exported for `directories.ts`'s `scriptAbsolutePath`
// dispatch.
export function githubDirScriptDisplayUrl(collectionPath: string, relativePath: string): string {
  const p = parseGithubUrl(collectionPath);
  if (!p) throw new Error(`Not a GitHub URL: ${collectionPath}`);
  const full = p.path ? `${p.path}/${relativePath}` : relativePath;
  return `https://github.com/${p.owner}/${p.repo}/blob/${p.ref}/${full}`;
}

// Parse a bare `github.com/<owner>/<repo>` URL — repo root, no ref.
// Returns null for anything that already parses via `parseGithubUrl`
// (i.e. URLs that bring their own `/blob|tree/...` segment).
function parseGithubRepoRoot(input: string): { owner: string; repo: string } | null {
  if (parseGithubUrl(input)) return null;
  const m = GITHUB_REPO_ROOT_RE.exec(input);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, '') };
}

// True for any GitHub input a collection can be built from without
// naming a file: a `/tree/...` (or file-less `/blob/...`) directory URL,
// or a bare repo root. The repo root needs one API call to resolve its
// default branch before it can be stored (`normalizeGithubInput`), but
// recognising it takes none — which is what lets the collection
// dialog classify a location on every keystroke.
export function isGithubDirInput(input: string): boolean {
  return isGithubDirCollection(input) || parseGithubRepoRoot(input) !== null;
}

// Fetch a repo's default branch via the GitHub repository metadata
// endpoint. One API call (counts against the same 60/hr/IP budget as
// the Contents API for unauthenticated callers). Called only at
// add-collection time for bare-repo URLs; resolved branch gets baked
// into the canonical collection path so refresh is deterministic
// afterwards.
async function fetchGithubDefaultBranch(owner: string, repo: string): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
  let response: Response;
  try {
    response = await fetch(apiUrl, {
      cache: 'no-store',
      headers: {
        'Accept': 'application/vnd.github+json',
        ...githubAuthHeaders(apiUrl),
      },
    });
  } catch (err) {
    throw new Error(`Could not read ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Every failure below shares the `Could not read <url>: <reason>`
  // shape the rest of the fetch pipeline uses (`directories.ts`), so a
  // GitHub failure and a plain HTTP one read the same way. "Repo
  // metadata" was our name for this request, not something the reader
  // asked for.
  if (!response.ok) {
    throw new Error(
      `Could not read ${apiUrl}: HTTP ${response.status}${githubAuthHint(response.status)}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    // The parser's own complaint is kept: `Unexpected token <` is how a
    // captive portal or proxy error page announces itself, and dropping
    // it would leave "not valid JSON" with nothing to act on.
    throw new Error(
      `Could not read ${apiUrl}: the response is not valid JSON (${
        err instanceof Error ? err.message : String(err)})`,
    );
  }
  const branch = (json as { default_branch?: unknown } | null)?.default_branch;
  if (typeof branch !== 'string' || !branch) {
    throw new Error(`Could not read ${apiUrl}: GitHub did not report the repo's default branch`);
  }
  return branch;
}

// At add-collection time, transparently rewrite a github.com input into
// the canonical form the rest of the pipeline expects:
//   - File URL — `/blob/<ref>/<path>.user.js` or a path whose basename
//     is `script_manifest.json` — gets rewritten to its raw URL.
//   - Bare repo URL (`github.com/<o>/<r>` with no ref) → `/tree/<default-branch>`,
//     resolved via the repo metadata endpoint (one API call).
//   - Directory URLs (`/tree/<ref>/...`) pass through unchanged.
//   - Non-github inputs pass through unchanged (no network call).
// Async because the repo-root case needs to consult the GitHub API to
// resolve the default branch. Idempotent on canonical outputs so the
// caller-and-callee normalize pattern (see `addCollection`) doesn't
// double-up on API calls.
export async function normalizeGithubInput(input: string): Promise<string> {
  const p = parseGithubUrl(input);
  if (p) {
    if (p.path && isGithubFilePath(p.path)) {
      return githubFileUrlToRaw(p);
    }
    return input;
  }
  const root = parseGithubRepoRoot(input);
  if (root) {
    const branch = await fetchGithubDefaultBranch(root.owner, root.repo);
    return `https://github.com/${root.owner}/${root.repo}/tree/${branch}`;
  }
  return input;
}

// Build the GitHub Contents API URL for a directory inside a repo.
// Empty `path` lists the repo root at the given ref.
function githubContentsApiUrl(p: ParsedGithubUrl, subPath: string): string {
  const base = `https://api.github.com/repos/${p.owner}/${p.repo}/contents`;
  const full = subPath ? `${p.path ? p.path + '/' : ''}${subPath}` : p.path;
  const encPath = full
    ? '/' + full.split('/').map(encodeURIComponent).join('/')
    : '';
  return `${base}${encPath}?ref=${encodeURIComponent(p.ref)}`;
}

// Tack a private-repo / rate-limit hint onto the GitHub API error so
// the failure is self-diagnosing. GitHub returns the same 404 for
// "repo doesn't exist" and "repo exists but you can't see it without
// auth", so the hint covers both. 403 unauthenticated almost always
// means the per-IP rate limit ran out; an authenticated 403 means the
// token doesn't have access to the repo or is missing a scope.
// The hint text branches on whether a token is configured so the
// user gets a next-step pointer rather than stale advice.
function githubAuthHint(status: number): string {
  const hasToken = !!getGithubAuthToken();
  if (status === 404) {
    if (hasToken) {
      return ' (repo / path not found, or your token can\'t see this repo; check the token\'s repo access on github.com)';
    }
    return ' (repo / path not found, or repo is private; set a GitHub token on the Options page to fetch private repos)';
  }
  if (status === 403 || status === 429) {
    if (hasToken) {
      return ' (rate limit hit, or your token lacks the required scope; authenticated requests get 5000/hour against api.github.com)';
    }
    return ' (likely the unauthenticated 60/hr API rate limit; set a GitHub token on the Options page to raise it to 5000/hr)';
  }
  if (status === 401) {
    return ' (token rejected; re-check the value on the Options page)';
  }
  return '';
}

interface GithubContentsEntry {
  // GitHub returns 'file' | 'dir' | 'submodule' | 'symlink'; we only
  // act on the first two and skip everything else.
  type: string;
  name: string;
  path: string;
  size?: number;
}

// Fetch a single Contents API response. Returns the parsed JSON array.
// Throws on non-2xx, non-array, or network failure — caller
// (refreshCollection) turns the error into a per-collection
// `scanError`.
async function fetchGithubContents(apiUrl: string): Promise<GithubContentsEntry[]> {
  let response: Response;
  try {
    response = await fetch(apiUrl, {
      cache: 'no-store',
      headers: {
        'Accept': 'application/vnd.github+json',
        ...githubAuthHeaders(apiUrl),
      },
    });
  } catch (err) {
    throw new Error(`Could not read ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    // 403 with rate-limit headers is the common failure mode for
    // unauthenticated repeat callers; 404 means either the repo / path
    // doesn't exist OR it's a private repo (GitHub returns the same
    // status for both unauthenticated). Surface the status plus the
    // private-repo hint so the user has something concrete to act on.
    throw new Error(
      `Could not read ${apiUrl}: HTTP ${response.status}${githubAuthHint(response.status)}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    // The parser's own complaint is kept: `Unexpected token <` is how a
    // captive portal or proxy error page announces itself, and dropping
    // it would leave "not valid JSON" with nothing to act on.
    throw new Error(
      `Could not read ${apiUrl}: the response is not valid JSON (${
        err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!Array.isArray(json)) {
    // GitHub answers a file path with an object rather than a listing,
    // so this is the "you pointed at a file" case, not a broken API.
    throw new Error(`Could not read ${apiUrl}: that path is not a folder in the repo`);
  }
  return json as GithubContentsEntry[];
}

// Recursive scan of a GitHub directory collection via the Contents API.
// Mirrors the shape of `scanForUserScripts` / `scanManifest`: returns a
// flat `FoundScript[]` keyed by paths relative to the collection's root
// dir, capped at MAX_SCAN_DEPTH levels deep.
//
// Cost: one Contents API call per directory walked. Unauthenticated
// callers share a 60/hour budget per IP, so deep trees can drain
// quickly; authenticated-collections support is in TODO.md.
export async function scanGithubDir(
  input: string,
  depth = 0,
  prefix = '',
): Promise<FoundScript[]> {
  const p = parseGithubUrl(input);
  if (!p) throw new Error(`Not a GitHub URL: ${input}`);
  // `prefix` carries a trailing slash on every recursive call
  // (`prefix + entry.name + '/'`); strip it so the Contents-API path
  // ends in the directory name without an extra `/`.
  const subPath = prefix.replace(/\/+$/, '');
  const apiUrl = githubContentsApiUrl(p, subPath);
  const entries = await fetchGithubContents(apiUrl);
  const results: FoundScript[] = [];
  const subdirs: GithubContentsEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'file' && entry.name.endsWith('.user.js')) {
      const found: FoundScript = {
        name: entry.name,
        relativePath: prefix + entry.name,
      };
      if (typeof entry.size === 'number') found.size = entry.size;
      results.push(found);
    } else if (entry.type === 'dir' && depth < MAX_SCAN_DEPTH) {
      subdirs.push(entry);
    }
  }
  // Listed together rather than one after another — same reasoning as
  // the local scan, but the round trips here are API calls rather than
  // disk reads, so the saving is far bigger per directory. A repo whose
  // root holds three subdirectories cost four serialized calls before.
  //
  // Bounded tighter than the local walk: these all hit api.github.com,
  // which throttles concurrent bursts on top of the hourly quota. The
  // request COUNT is unchanged either way, which is what the quota
  // actually meters.
  const nested = await mapWithConcurrency(
    subdirs, SCAN_GITHUB_DIRS_CONCURRENCY,
    (entry) => scanGithubDir(input, depth + 1, prefix + entry.name + '/'),
  );
  for (const sub of nested) results.push(...sub);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}
