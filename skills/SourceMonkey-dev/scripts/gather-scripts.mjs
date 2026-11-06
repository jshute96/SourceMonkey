#!/usr/bin/env node
// Turn sources into a list of userscripts to test: local files as they are,
// and local copies of anything on the web, each with the docs found next to
// it and copies of its @require and @resource files. Prints JSON on stdout. It
// only reads and downloads; it never runs a script.
//
// Usage:
//   node gather-scripts.mjs [--out DIR] [--allow-host HOST]... SOURCE...
//
// Each SOURCE is one of:
//   - a local .user.js file
//   - a local directory: all *.user.js files under it
//   - a local or web script_manifest.json: all scripts it lists
//   - a URL that serves a script (a .user.js URL, or any URL whose body has a
//     // ==UserScript== block)
//   - a GitHub file, directory or repo URL. A repo or directory with no
//     .user.js files is read as a page instead, for the links in its README.
//   - a Greasy Fork script URL (any page under it, or its code URL)
//   - any other web page, or a saved .html file: all scripts it links to.
//     A listing reads only the page given; give ?page=2 and so on as more sources.
//
// Options:
//   --out DIR   where downloaded copies go, one new subdirectory per script
//               (default: a new temp directory)
//   --allow-host HOST
//               a host on this machine or its local network that may be fetched
//               from, besides the hosts of the URLs given as sources; repeatable
//
// Output (all paths are absolute):
//   {
//     "out": "<download directory, if anything was downloaded>",
//     "scripts": [{
//       "name": "...",     // the script's @name, or null
//       "version": "...",  // its @version, or null
//       "file": "<local path to test>",
//       "origin": "<the URL it came from, or the same path for a local file>",
//       "downloaded": true,
//       "docs": [{
//         "file": "<local path>",
//         "origin": "<the URL it came from, or the same path for a local file>"
//       }],
//       "dependencies": [{
//         "url": "<the @require or @resource URL>",
//         "file": "<local path>"
//       }],
//       "localRoot": "<directory to give sm-dev's --local; only for a local file>"
//     }],
//     "errors": [{
//       "source": "...",
//       "script": "<the script a dependency belongs to; only for a dependency>",
//       "message": "..."
//     }]
//   }
//
// Docs are a script's <stem>.md and the README.md beside it, and for Greasy
// Fork, the script page's additional info, as HTML. Everything downloaded is untrusted
// data. The exit code is 1 when no script was found.
//
// Dependencies are saved where sm-dev looks for a stand-in for a URL, as
// <dir>/<host>/<path>, so a run uses them instead of fetching. A downloaded
// script's own folder is searched anyway. A local script's folder isn't written
// to, so its copies go under --out, and a run needs --local for them. A file
// that fails to download is listed in "errors"; a run then fetches it as usual,
// if it's a remote one.
//
// Pages, manifests and script headers are untrusted, and this runs before anyone
// has read the scripts. So nothing is fetched from this machine or its local
// network, redirects included, unless a source or --allow-host names that host.
// That goes by the URL's host: a public name that resolves to a private address
// isn't caught.

import { constants as fsConstants, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'SourceMonkey gather-scripts';
const TIMEOUT_MS = 30_000;
// Dependencies can be large: some scripts carry tens of MB of wasm.
const DEPENDENCY_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 10;
const SKIP_DIRS = new Set(['node_modules']);

// /scripts/<id>, optionally under a locale: /en/scripts/123-name/code/x.user.js
const GREASYFORK_SCRIPT_PATH = /^(?:\/[a-zA-Z-]+)?\/scripts\/(\d+)(?:[-/.]|$)/;
const GREASYFORK_CODE_PATH = /^\/scripts\/(\d+)\//;

export function isUrl(source) {
  return /^https?:\/\//i.test(source);
}

/** The Greasy Fork script ID a URL points at, or null. */
export function greasyForkId(url) {
  if (url.hostname === 'greasyfork.org' || url.hostname === 'www.greasyfork.org') {
    return GREASYFORK_SCRIPT_PATH.exec(url.pathname)?.[1] ?? null;
  }
  if (url.hostname === 'update.greasyfork.org') return GREASYFORK_CODE_PATH.exec(url.pathname)?.[1] ?? null;
  return null;
}

/** The raw URL of a GitHub file page (`blob` or `raw`), or null for anything else. */
export function githubRawUrl(url) {
  if (url.hostname !== 'github.com') return null;
  const match = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : null;
}

/** The parts of a GitHub repo or directory URL, or null for anything else. */
export function githubTree(url) {
  if (url.hostname !== 'github.com') return null;
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?(?:\/tree\/([^/]+)(?:\/(.+?))?\/?)?$/.exec(url.pathname);
  if (!match) return null;
  // The API's paths aren't percent-encoded, as a URL's are.
  const decoded = (part) => { try { return decodeURIComponent(part); } catch { return part; } };
  return { owner: match[1], repo: match[2], ref: match[3] ? decoded(match[3]) : null, dir: match[4] ? decoded(match[4]) : '' };
}

/** Whether a body is a script. A web page can show a metadata block as an example. */
export function hasMetadataBlock(text) {
  return !/^\s*</.test(text) && /^\s*\/\/\s*==UserScript==/m.test(text);
}

/** The entries of a manifest body, in any of the shapes SourceMonkey accepts. */
export function manifestEntries(body) {
  const parsed = JSON.parse(body);
  const list = Array.isArray(parsed) ? parsed : parsed?.scripts;
  if (!Array.isArray(list)) throw new Error('The manifest has no list of scripts');
  return list.map((item) => (typeof item === 'string' ? item : item?.path)).filter((entry) => typeof entry === 'string');
}

/** A @name or @version from the metadata block. */
function headerValue(text, tag) {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(text)?.[1] ?? '';
  return new RegExp(`^\\s*//\\s*@${tag}\\s+(.+)$`, 'm').exec(block)?.[1].trim() ?? null;
}

/** The @require and @resource values in a script's metadata block, without duplicates. */
export function declaredDependencies(text) {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(text)?.[1] ?? '';
  const found = new Set();
  for (const [, tag, value] of block.matchAll(/^\s*\/\/\s*@(require|resource)\s+(.+)$/gm)) {
    const parts = value.trim().split(/\s+/);
    // A @resource is `name url`, though a bare url also turns up.
    found.add(tag === 'resource' ? parts[1] ?? parts[0] : parts[0]);
  }
  return [...found];
}

/** A hostname on this machine or its local network. */
export function isPrivateHost(hostname) {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return /^(localhost|.+\.localhost|.+\.local)$/.test(host) ||
    /^(0|10|127)\.\d+\.\d+\.\d+$/.test(host) ||
    /^(192\.168|169\.254|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+$/.test(host) ||
    /^\[(::1?|::ffff:[0-9a-f:.]+|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)\]$/.test(host);
}

/**
 * Where sm-dev looks for a stand-in for a remote URL under `root`, or null when
 * it wouldn't: `localFileCandidates` in src/local-file-overrides.ts, whose
 * longest candidate this is. The URL parser has resolved any `..` in the path.
 */
export function standInPath(root, url) {
  if (url.pathname.endsWith('/') || /%2f|%5c/i.test(url.pathname)) return null;
  let file;
  try {
    file = path.join(root, url.host, ...url.pathname.split('/').filter(Boolean).map(decodeURIComponent));
  } catch {
    return null;
  }
  // The parser doesn't normalize a host: `https://../x.js` has the host `..`.
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}

/** URLs of the scripts a page links to: Greasy Fork script pages and .user.js files. */
export function linkedScripts(html, base) {
  const hrefs = [...html.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)]
    .map((match) => (match[1] ?? match[2] ?? match[3]).replaceAll('&amp;', '&'));
  // A .user.js URL written out as text, as in a Markdown file served raw.
  hrefs.push(...(html.match(/https?:\/\/[^\s"'<>()]+\.user\.js/gi) ?? []));
  const found = new Set();
  for (const href of hrefs) {
    let link;
    try { link = new URL(href, base); } catch { continue; }
    if (link.protocol !== 'http:' && link.protocol !== 'https:') continue;
    link.hash = '';
    if (greasyForkId(link) || link.pathname.endsWith('.user.js')) found.add(link.href);
  }
  return [...found];
}

/** The URL a saved page came from, for resolving its relative links. */
function savedPageBase(html, file) {
  return /<!-- saved from url=\(\d+\)(\S+?) -->/.exec(html)?.[1] ??
    /<base\s[^>]*href="([^"]+)"/i.exec(html)?.[1] ??
    /<link\s[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(html)?.[1] ??
    `file://${file}`;
}

/**
 * A file name safe to create from text a web server chose: no path parts, and
 * ending in `.user.js` when `script` is set, since sm-dev goes by that suffix.
 */
export function safeFileName(url, { script = false } = {}) {
  let name = path.posix.basename(new URL(url).pathname);
  try { name = decodeURIComponent(name); } catch { /* keep it encoded */ }
  name = name.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '').slice(-80);
  if (!script) return name || 'doc';
  return `${name.replace(/(\.user)?\.js$/, '') || 'script'}.user.js`;
}

/** All *.user.js files under a directory, sorted, skipping dot directories and node_modules. */
async function walkScripts(dir) {
  const found = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) found.push(...await walkScripts(full));
    } else if (entry.name.endsWith('.user.js')) found.push(full);
  }
  return found;
}

/**
 * A Greasy Fork page's additional info section as an HTML page, or null when
 * it's missing or empty. The site only serves this as rendered HTML: its API
 * doesn't have it, so the author's Markdown isn't available. HTML keeps the
 * tables, links and images that text would lose.
 */
export function greasyForkInfo(html) {
  const match = /id="additional-info"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  if (!match) return null;
  let content = match[1].replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  // The match runs on to the section's end, past the closing tags of the
  // divs around the content. Drop those, which no opening tag here matches.
  let extra = (content.match(/<\/div\s*>/gi) ?? []).length - (content.match(/<div\b/gi) ?? []).length;
  while (extra-- > 0) content = content.replace(/\s*<\/div\s*>\s*$/i, '');
  content = content.trim();
  if (!/\S/.test(content.replace(/<(?!img\b)[^>]+>/gi, ''))) return null;
  return `<!doctype html>\n<meta charset="utf-8">\n${content}`;
}

class Gatherer {
  constructor({ out, allowedHosts }) {
    this.out = out;
    this.allowedHosts = allowedHosts;
    this.candidates = [];
    this.seen = new Set();
    this.errors = [];
    this.docCache = new Map();
    // A dependency's URL to the copy already saved, so that scripts sharing one
    // fetch it once. Each still gets its own copy, to read or change by itself.
    this.dependencyFiles = new Map();
  }

  /** A successful response, with each redirect's target checked before it's fetched. */
  async fetchResponse(url, timeoutMs = TIMEOUT_MS) {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = new URL(url);
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      if (isPrivateHost(current.hostname) && !this.allowedHosts.has(current.hostname)) {
        throw new Error(`The URL ${current.href} is on this machine or its local network, so it wasn't fetched. Use \`--allow-host ${current.hostname}\` to allow it.`);
      }
      const response = await fetch(current, { headers: { 'User-Agent': USER_AGENT }, signal, redirect: 'manual' }).catch((err) => {
        // `fetch failed` alone says nothing: the reason is in its cause.
        throw new Error(`Fetching ${current.href} failed: ${err.cause?.message ?? err.message}`);
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) {
        if (!response.ok) throw new Error(`Fetching ${url} failed: HTTP ${response.status}`);
        return response;
      }
      await response.body?.cancel();
      current = new URL(location, current);
    }
    throw new Error(`Fetching ${url} failed: Too many redirects`);
  }

  async fetchText(url) {
    return (await this.fetchResponse(url)).text();
  }

  async fetchJson(url) {
    return (await this.fetchResponse(url)).json();
  }

  /** A doc's text, or null when it isn't there. A 200 HTML page isn't the doc we asked for. */
  async fetchDoc(url) {
    try {
      const response = await this.fetchResponse(url);
      if ((response.headers.get('content-type') ?? '').includes('text/html')) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  /** The .user.js files in a GitHub repo or directory, as raw URLs. */
  async githubTreeScripts({ owner, repo, ref, dir }, source) {
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const branch = ref ?? (await this.fetchJson(api)).default_branch;
    const { tree, truncated } = await this.fetchJson(`${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (truncated) this.errors.push({ source, message: 'GitHub gave only part of this repo\'s file list, so some scripts may be missing' });
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    return tree
      .filter((item) => item.type === 'blob' && item.path.startsWith(prefix) && item.path.endsWith('.user.js'))
      .map((item) => `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path.split('/').map(encodeURIComponent).join('/')}`);
  }

  /** Queue one script, once. */
  add(candidate) {
    if (this.seen.has(candidate.key)) return;
    this.seen.add(candidate.key);
    this.candidates.push(candidate);
  }

  addFile(file) {
    this.add({ key: `file:${file}`, file });
  }

  /** Queue a URL known to be a script, or the Greasy Fork page of one. */
  addScriptUrl(href) {
    const url = new URL(href);
    const id = greasyForkId(url);
    if (id) { this.add({ key: `greasyfork:${id}`, greasyForkId: id }); return; }
    const raw = githubRawUrl(url) ?? url.href;
    this.add({ key: `url:${raw}`, url: raw });
  }

  async expand(source) {
    if (isUrl(source)) await this.expandUrl(source);
    else await this.expandPath(path.resolve(source));
  }

  async expandPath(file) {
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error('No such file or directory');
    if (info.isDirectory()) {
      const scripts = await walkScripts(file);
      if (!scripts.length) throw new Error('No .user.js files in this directory');
      for (const script of scripts) this.addFile(script);
      return;
    }
    if (file.endsWith('.json')) {
      const dir = path.dirname(file);
      for (const entry of manifestEntries(await readFile(file, 'utf8'))) {
        if (isUrl(entry)) this.addScriptUrl(entry);
        else this.addFile(path.resolve(dir, entry));
      }
    } else if (/\.html?$/i.test(file)) {
      const html = await readFile(file, 'utf8');
      const links = linkedScripts(html, savedPageBase(html, file));
      if (!links.length) throw new Error('This page links to no scripts');
      for (const link of links) this.addScriptUrl(link);
    } else this.addFile(file);
  }

  async expandUrl(source) {
    const url = new URL(source);
    if (greasyForkId(url) || url.pathname.endsWith('.user.js')) { this.addScriptUrl(url.href); return; }
    const tree = githubTree(url);
    if (tree) {
      // Not every github.com URL is a repo, and the API has a rate limit: either
      // way, the page may still link to scripts. Report it, since a repo's page
      // can link to fewer scripts than the repo has.
      const scripts = await this.githubTreeScripts(tree, source).catch((err) => {
        this.errors.push({ source, message: `Listing this repo's files failed, so only the links on its page were read: ${err.message}` });
        return [];
      });
      if (scripts.length) {
        for (const script of scripts) this.addScriptUrl(script);
        return;
      }
    }
    const target = githubRawUrl(url) ?? url.href;
    const body = await this.fetchText(target);
    if (hasMetadataBlock(body)) {
      this.add({ key: `url:${target}`, url: target, body });
    } else if (new URL(target).pathname.endsWith('.json')) {
      for (const entry of manifestEntries(body)) this.addScriptUrl(new URL(entry, target).href);
    } else {
      const links = linkedScripts(body, target);
      if (!links.length) throw new Error('This page has no userscript and links to none');
      for (const link of links) this.addScriptUrl(link);
    }
  }

  async outDir() {
    if (this.out) await mkdir(this.out, { recursive: true });
    else this.out = await mkdtemp(path.join(tmpdir(), 'sm-test-scripts-'));
    return this.out;
  }

  /**
   * A new directory for one script: its copy, docs and dependencies go only
   * there. It's always new, so that a second gather into the same --out doesn't
   * mix with the first.
   */
  async scriptDir(index, fileName) {
    const base = path.join(await this.outDir(), `${String(index).padStart(3, '0')}-${fileName.replace(/\.user\.js$/, '')}`);
    for (let n = 1; ; n++) {
      const dir = n === 1 ? base : `${base}-${n}`;
      try {
        await mkdir(dir);
        return dir;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }

  /** Save one dependency to `file`, fetching it unless another script already did. */
  async saveDependency(url, file) {
    await mkdir(path.dirname(file), { recursive: true });
    const saved = this.dependencyFiles.get(url);
    // Exclusive: a header's path must not overwrite the script or its docs.
    if (saved) await copyFile(saved, file, fsConstants.COPYFILE_EXCL);
    else {
      const bytes = await (await this.fetchResponse(url, DEPENDENCY_TIMEOUT_MS)).arrayBuffer();
      await writeFile(file, new Uint8Array(bytes), { flag: 'wx' });
      this.dependencyFiles.set(url, file);
    }
  }

  /**
   * Where one dependency goes, as [url, file], or null for one that's only
   * readable from the script's own folder (a relative one, for a local script)
   * or isn't a file on the web (`data:`). Throws for one that can't be saved.
   * `dir` is the script's folder; `scriptUrl` is null for a local script.
   */
  dependencyTarget(ref, dir, scriptUrl) {
    const relative = !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);
    if (!scriptUrl && (relative || ref.startsWith('//'))) return null;
    const url = new URL(ref, scriptUrl ?? undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    if (relative) {
      const file = path.resolve(dir, decodeURIComponent(ref.replace(/[?#].*$/, '')));
      if (!file.startsWith(dir + path.sep)) throw new Error('This relative path is outside the script\'s folder, so sm-dev couldn\'t read a copy');
      return [url.href, file];
    }
    const file = standInPath(dir, url);
    if (!file) throw new Error('sm-dev can\'t read a local copy of this URL, so it wasn\'t downloaded');
    return [url.href, file];
  }

  /** Save a script's dependencies under `dir`, reporting any that fail against `script`. */
  async saveDependencies(body, dir, scriptUrl, script) {
    const report = (source, message) => this.errors.push({ source, script, message });
    const urlsByFile = new Map();
    for (const ref of declaredDependencies(body)) {
      try {
        const target = this.dependencyTarget(ref, dir, scriptUrl);
        if (!target) continue;
        const [url, file] = target;
        if (!urlsByFile.has(file)) urlsByFile.set(file, new Set());
        urlsByFile.get(file).add(url);
      } catch (err) {
        report(ref, err.message);
      }
    }
    const dependencies = [];
    for (const [file, urls] of urlsByFile) {
      const [url, ...others] = urls;
      // URLs differing by query have one local path. A run would use one's copy
      // for both, so neither gets a copy, and it fetches each.
      if (others.length) {
        for (const each of urls) report(each, 'Another dependency of this script has the same local path, differing only by query, so neither was downloaded');
        continue;
      }
      try {
        await this.saveDependency(url, file);
        dependencies.push({ url, file });
      } catch (err) {
        report(url, err.code === 'EEXIST' ? 'The script\'s folder already has a file at this path' : err.message);
      }
    }
    return dependencies;
  }

  async localScript(candidate, index) {
    const body = await readFile(candidate.file, 'utf8');
    const dir = path.dirname(candidate.file);
    const base = path.basename(candidate.file);
    const stem = base.replace(/(\.user)?\.js$/, '').toLowerCase();
    const names = await readdir(dir);
    const docs = names
      .filter((name) => [`${stem}.md`, 'readme.md'].includes(name.toLowerCase()))
      .sort((a, b) => Number(a.toLowerCase() === 'readme.md') - Number(b.toLowerCase() === 'readme.md'))
      .map((name) => ({ file: path.join(dir, name), origin: path.join(dir, name) }));
    const entry = this.entry({ body, file: candidate.file, origin: candidate.file, downloaded: false, docs });
    const remote = declaredDependencies(body).some((ref) => /^https?:|^\/\//i.test(ref));
    if (!remote) return entry;
    const localRoot = await this.scriptDir(index, base);
    entry.dependencies = await this.saveDependencies(body, localRoot, null, candidate.file);
    return entry.dependencies.length ? { ...entry, localRoot } : entry;
  }

  async siblingDocs(url, dir) {
    const stem = safeFileName(url, { script: true }).replace(/\.user\.js$/, '');
    const original = path.posix.basename(new URL(url).pathname).replace(/(\.user)?\.js$/, '');
    const docs = [];
    for (const [name, saveAs] of [[`${original}.md`, `${stem}.md`], ['README.md', 'README.md']]) {
      const docUrl = new URL(name, url).href;
      if (!this.docCache.has(docUrl)) this.docCache.set(docUrl, await this.fetchDoc(docUrl));
      const text = this.docCache.get(docUrl);
      if (text === null) continue;
      const file = path.join(dir, saveAs);
      await writeFile(file, text);
      docs.push({ file, origin: docUrl });
    }
    return docs;
  }

  async downloadUrl(candidate, index) {
    const body = candidate.body ?? await this.fetchText(candidate.url);
    const name = safeFileName(candidate.url, { script: true });
    const dir = await this.scriptDir(index, name);
    const file = path.join(dir, name);
    await writeFile(file, body);
    const docs = await this.siblingDocs(candidate.url, dir);
    const dependencies = await this.saveDependencies(body, dir, candidate.url, candidate.url);
    return this.entry({ body, file, origin: candidate.url, downloaded: true, docs, dependencies });
  }

  async downloadGreasyFork(candidate, index) {
    const info = await this.fetchJson(`https://api.greasyfork.org/scripts/${candidate.greasyForkId}.json`);
    const body = await this.fetchText(info.code_url);
    const name = safeFileName(info.code_url, { script: true });
    const dir = await this.scriptDir(index, name);
    const file = path.join(dir, name);
    await writeFile(file, body);
    const docs = [];
    // The page is extra context: the script can still be tested without it.
    const pageInfo = await this.fetchText(info.url).then(greasyForkInfo, () => null);
    if (pageInfo) {
      const doc = path.join(dir, 'greasyfork-additional-info.html');
      await writeFile(doc, `${pageInfo}\n`);
      docs.push({ file: doc, origin: info.url });
    }
    const dependencies = await this.saveDependencies(body, dir, info.code_url, info.url);
    return this.entry({ body, file, origin: info.url, downloaded: true, docs, dependencies });
  }

  entry({ body, file, origin, downloaded, docs, dependencies = [] }) {
    return {
      name: headerValue(body, 'name'),
      version: headerValue(body, 'version'),
      file,
      origin,
      downloaded,
      docs,
      dependencies,
    };
  }

  async materialize() {
    const scripts = [];
    for (const [i, candidate] of this.candidates.entries()) {
      try {
        if (candidate.file) scripts.push(await this.localScript(candidate, i + 1));
        else if (candidate.greasyForkId) scripts.push(await this.downloadGreasyFork(candidate, i + 1));
        else scripts.push(await this.downloadUrl(candidate, i + 1));
      } catch (err) {
        const source = candidate.file ?? candidate.url ?? `https://greasyfork.org/scripts/${candidate.greasyForkId}`;
        this.errors.push({ source, message: err.message });
      }
    }
    return scripts;
  }
}

export async function gather(sources, { out, allowHosts = [] } = {}) {
  // The person named these hosts: a dev server on localhost, say.
  const named = sources.filter(isUrl).flatMap((source) => {
    try { return [new URL(source).hostname]; } catch { return []; }
  });
  const gatherer = new Gatherer({ out, allowedHosts: new Set([...named, ...allowHosts]) });
  for (const source of sources) {
    try {
      await gatherer.expand(source);
    } catch (err) {
      gatherer.errors.push({ source, message: err.message });
    }
  }
  const scripts = await gatherer.materialize();
  return {
    ...(gatherer.out ? { out: gatherer.out } : {}),
    scripts,
    errors: gatherer.errors,
  };
}

const HELP = ['Usage: node gather-scripts.mjs [--out DIR] [--allow-host HOST]... SOURCE...',
  'Sources: a .user.js file or URL, a directory, a script_manifest.json, a GitHub or Greasy Fork URL, or a page of links.',
  'Prints JSON on stdout. The comment at the top of this file has the details.'];

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${HELP.join('\n')}\n`); return 0; }
  const sources = [];
  const allowHosts = [];
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i] ?? '.');
    else if (argv[i] === '--allow-host') allowHosts.push(argv[++i] ?? '');
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option ${argv[i]}. Use --help for usage.`);
    else sources.push(argv[i]);
  }
  if (!sources.length) throw new Error('No sources given. Use --help for usage.');
  const result = await gather(sources, { out, allowHosts });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.scripts.length ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}
