import { fetchResourceBytes, resolveScriptResource } from './file-loader.js';

// Site-icon (favicon) extraction + cache. Used by the options page
// and userscript viewer to show a 16x16 icon next to each script.
//
// Pipeline (per origin):
//   probe-URL HTML → origin-root HTML → /favicon.ico → Google S2.
// Probe URL comes from the literal prefix of the first useful @match
// — many sites only ship the proper <link rel="icon"> on authed
// or deep pages, so fetching closer to the script's target lands on
// a page more likely to declare the real icon.
//
// Cache: `siteIcon:<origin>` in chrome.storage.local. Success entries
// live 7d, null (every leg failed) entries live 24h so a transient
// outage doesn't permanently blank the row.

export interface SiteIconEntry {
  dataUrl: string | null;
  fetchedAt: number;
}

const KEY_PREFIX = 'siteIcon:';
const siteIconKey = (origin: string): string => `${KEY_PREFIX}${origin}`;

// Separate cache prefix for icons declared via `@icon`/`@iconURL`/etc.
// Same `SiteIconEntry` shape and TTLs as the origin-discovered path; the
// prefix split keeps URL strings (which can be long) from colliding
// with origin strings and lets either path be invalidated independently.
const URL_ICON_KEY_PREFIX = 'iconUrl:';
const urlIconKey = (url: string): string => `${URL_ICON_KEY_PREFIX}${url}`;

const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NULL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ICON_BYTES = 128 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
// Cap on inline-`data:`-URL icons declared in `<link href="data:...">`.
// Base64 inflates by ~4/3 and the `data:image/...;base64,` prefix adds
// a few dozen chars; round up and add slack rather than guess.
const MAX_INLINE_DATA_URL_LEN = Math.ceil((MAX_ICON_BYTES * 4) / 3) + 64;

// ---------- Origin extraction ----------

// Parsed shape of a Chrome `@match` pattern that survived our
// origin-extraction filter. `path` keeps the original path so probe-URL
// construction can extract its literal prefix.
interface ParsedMatch {
  scheme: 'http' | 'https';
  host: string;
  path: string;
}

// Pull a Chrome match pattern apart and dewildcard its host. Returns
// null when the pattern can't identify a single site (`<all_urls>`,
// host of `*`, non-http(s) schemes, embedded `*` after dewildcard,
// or syntactically invalid).
function parseMatchPattern(pattern: string): ParsedMatch | null {
  if (pattern === '<all_urls>') return null;
  const parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!parts) return null;
  const [, rawScheme, rawHost] = parts;
  const scheme = rawScheme === '*' ? 'https' : rawScheme.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  // Strip an optional :port. Custom-port sites are rare in userscripts,
  // and targeting the default port gives the broadest favicon hit rate.
  const colon = rawHost.lastIndexOf(':');
  const hasPort = colon > 0 && /^\d+$/.test(rawHost.slice(colon + 1));
  let host = (hasPort ? rawHost.slice(0, colon) : rawHost).toLowerCase();
  if (host === '*' || host === '') return null;
  if (host.startsWith('*.')) host = host.slice(2);
  if (!host || host.includes('*')) return null;

  return { scheme, host, path: parts[3] ?? '/' };
}

export function originFromMatchPattern(pattern: string): string | null {
  const p = parseMatchPattern(pattern);
  return p ? `${p.scheme}://${p.host}` : null;
}

// Iterate `matching.matches` and return the first origin we can
// extract. @include patterns are intentionally skipped: they're
// free-form globs/regexes over the whole URL, not URL templates.
export function representativeOrigin(matching: {
  matches: string[];
}): string | null {
  return representativeMatch(matching)?.origin ?? null;
}

// Like representativeOrigin, but also yields a probe URL one step
// deeper than the origin root — see file header — and a linkUrl
// suitable for opening in a new tab from the favicon (segment-based,
// not partial-segment, so it's always a valid path to navigate to).
//   https://example.com/*              → probe `/`,        link `/`
//   https://example.com/app/home/*     → probe `/app/home/`, link `/app/home/`
//   https://example.com/posts/*/edit   → probe `/posts/`,  link `/posts/`
//   https://example.com/foo/bar*       → probe `/foo/bar`, link `/foo/`
export function representativeMatch(matching: {
  matches: string[];
}): { origin: string; probeUrl: string; linkUrl: string } | null {
  for (const m of matching.matches) {
    const got = matchTargetInfo(m);
    if (got) return got;
  }
  return null;
}

function matchTargetInfo(pattern: string): { origin: string; probeUrl: string; linkUrl: string } | null {
  const p = parseMatchPattern(pattern);
  if (!p) return null;
  const origin = `${p.scheme}://${p.host}`;
  const star = p.path.indexOf('*');
  const literalPath = star < 0 ? p.path : p.path.slice(0, star);
  // Empty prefix means the path started with `*`. Use `/` for a
  // well-formed URL.
  const probeUrl = origin + (literalPath || '/');
  const linkUrl = origin + linkPathFromMatchPath(p.path);
  return { origin, probeUrl, linkUrl };
}

// Build the path for the favicon click-through. Walk segments
// left-to-right and stop at the first segment containing a `*`; trim
// off that partial segment so the URL ends on a clean directory
// boundary the server is likely to actually serve. Pure-literal paths
// (no `*` anywhere) pass through unchanged.
export function linkPathFromMatchPath(path: string): string {
  const segments = path.split('/');
  const kept: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.includes('*')) {
      // Trailing slash when we kept at least one segment; bare `/`
      // when the first segment was already a wildcard.
      return '/' + (kept.length ? kept.join('/') + '/' : '');
    }
    kept.push(seg);
  }
  return '/' + kept.join('/');
}

// ---------- Header-icon extraction ----------

// Tag priority for a script-declared icon. `@icon` is the only form
// documented by all three managers (TM/VM/GM); the rest are TM-only
// aliases. The smaller variants come first so a script that declares
// both a regular and a 64×64 icon picks the one closer to our 16×16
// display size.
const ICON_HEADER_TAGS = ['icon', 'iconurl', 'defaulticon', 'icon64url', 'icon64'];

// Read the highest-priority icon reference declared in the parsed
// metadata, or null when none is set. The reference comes back raw
// (just trimmed + non-empty); resolving it into an absolute URL —
// including the relative-path-against-script-parent rules and `..`
// rejection — is the file-loader's job and happens at render time
// when the script's `fileUrl` is in scope.
export function iconRefFromHeader(
  header: { tags: { tag: string; locale?: string; value: string }[] } | null,
): string | null {
  if (!header) return null;
  for (const tag of ICON_HEADER_TAGS) {
    for (const e of header.tags) {
      if (e.tag !== tag || e.locale !== undefined) continue;
      const trimmed = e.value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

// ---------- Storage I/O ----------

export async function loadSiteIcons(
  origins: Iterable<string>,
): Promise<Map<string, SiteIconEntry>> {
  const unique = Array.from(new Set(origins));
  if (unique.length === 0) return new Map();
  const keys = unique.map(siteIconKey);
  const got = await chrome.storage.local.get(keys);
  const out = new Map<string, SiteIconEntry>();
  for (const o of unique) {
    const entry = got[siteIconKey(o)] as SiteIconEntry | undefined;
    if (entry) out.set(o, entry);
  }
  return out;
}

async function storeSiteIcon(origin: string, entry: SiteIconEntry): Promise<void> {
  await chrome.storage.local.set({ [siteIconKey(origin)]: entry });
}

async function loadUrlIcon(url: string): Promise<SiteIconEntry | undefined> {
  const got = await chrome.storage.local.get(urlIconKey(url));
  return got[urlIconKey(url)] as SiteIconEntry | undefined;
}

async function storeUrlIcon(url: string, entry: SiteIconEntry): Promise<void> {
  await chrome.storage.local.set({ [urlIconKey(url)]: entry });
}

export function isCacheFresh(entry: SiteIconEntry, now: number = Date.now()): boolean {
  const ttl = entry.dataUrl !== null ? SUCCESS_TTL_MS : NULL_TTL_MS;
  return now - entry.fetchedAt < ttl;
}

// ---------- Favicon fetch ----------

// Resolve a favicon for `origin` and write the result (positive or
// negative) into storage. Cache is keyed by origin — multiple scripts
// on the same origin share one icon — so any probe URL for that
// origin works without polluting the cache key.
export async function fetchAndCacheSiteIcon(
  origin: string,
  probeUrl: string = origin + '/',
): Promise<string | null> {
  const dataUrl = await fetchFaviconAsDataUrl(origin, probeUrl);
  await storeSiteIcon(origin, { dataUrl, fetchedAt: Date.now() });
  return dataUrl;
}

async function fetchFaviconAsDataUrl(
  origin: string,
  probeUrl: string,
): Promise<string | null> {
  const fromProbe = await tryDiscoverIconViaHtml(probeUrl);
  if (fromProbe) return fromProbe;
  const rootUrl = origin + '/';
  if (probeUrl !== rootUrl) {
    const fromRoot = await tryDiscoverIconViaHtml(rootUrl);
    if (fromRoot) return fromRoot;
  }
  const fromIco = await fetchIconAt(`${origin}/favicon.ico`);
  if (fromIco) return fromIco;
  // Google S2 is the only leg that touches a third party. The host
  // name is already public via the @match; the request still leaks
  // "we couldn't find this site's icon ourselves" to Google. Reached
  // only when every direct leg has failed.
  return await fetchGoogleS2Icon(origin);
}

async function fetchGoogleS2Icon(origin: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  // sz=64 is sharp at 16x16 even on 2x dpi displays.
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  return await fetchIconAt(url);
}

// ---------- HTML discovery path ----------

export interface IconCandidate {
  href: string;
  rel: string;
  sizes: string | null;
  type: string | null;
}

async function tryDiscoverIconViaHtml(pageUrl: string): Promise<string | null> {
  const got = await fetchHtml(pageUrl);
  if (!got) return null;
  const best = pickBestIconCandidate(parseIconLinks(got.text));
  if (!best) return null;

  let absUrl: string;
  try {
    // Resolve against the post-redirect URL: when the server bounces
    // us to e.g. an SSO host, a relative href in the SSO HTML belongs
    // to the SSO origin, not the URL we originally requested.
    absUrl = new URL(best.href, got.finalUrl).toString();
  } catch {
    return null;
  }
  if (absUrl.startsWith('data:')) {
    return absUrl.length <= MAX_INLINE_DATA_URL_LEN ? absUrl : null;
  }
  return await fetchIconAt(absUrl);
}

// Pull out every `<link rel="...icon...">` tag from an HTML string.
// Scans only the `<head>` segment when one is delimited; otherwise the
// whole document. Tolerant of attribute ordering, unquoted values,
// and self-closing slashes.
export function parseIconLinks(html: string): IconCandidate[] {
  const headEnd = html.search(/<\/head\s*>/i);
  const region = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const out: IconCandidate[] = [];
  const linkRe = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(region)) !== null) {
    const attrs = parseAttrs(m[1]);
    const rel = (attrs.rel ?? '').toLowerCase();
    if (!rel.includes('icon')) continue;
    if (!attrs.href) continue;
    out.push({
      href: attrs.href,
      rel,
      sizes: attrs.sizes ?? null,
      type: attrs.type ?? null,
    });
  }
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[m[1].toLowerCase()] = value;
  }
  return out;
}

// Pick the candidate most likely to look good at 16x16. mask-icon is
// dropped entirely — it's a Safari pinned-tab monochrome SVG mask and
// renders as a black silhouette in <img>.
export function pickBestIconCandidate(
  candidates: IconCandidate[],
): IconCandidate | null {
  if (candidates.length === 0) return null;
  const viable = candidates.filter((c) => !c.rel.includes('mask-icon'));
  if (viable.length === 0) return null;
  return viable
    .map((c) => ({ c, score: scoreIcon(c) }))
    .sort((a, b) => b.score - a.score)[0].c;
}

function scoreIcon(c: IconCandidate): number {
  let s = 0;
  // Apple touch icons are usually 180px and padded with background
  // colour — usable but a worse fit at 16x16 than a plain "icon".
  s += c.rel.includes('apple-touch') ? 20 : 60;

  const t = (c.type ?? '').toLowerCase();
  if (t === 'image/png') s += 20;
  else if (t === 'image/svg+xml') s += 15;
  else if (t === 'image/x-icon' || t === 'image/vnd.microsoft.icon') s += 10;
  else if (t === 'image/jpeg' || t === 'image/webp') s += 5;

  const size = maxDeclaredSize(c.sizes);
  if (size === null) s += 3;
  else if (size === Infinity) s += 25;          // sizes="any" → vector
  else if (size >= 32 && size <= 64) s += 30;   // 16px @ 2x dpi target
  else if (size >= 16 && size < 32) s += 18;
  else if (size > 64 && size <= 192) s += 12;
  else s += 1;
  return s;
}

// Read the largest `<width>x<height>` pair out of a `sizes` attribute,
// returning Infinity for the literal `any` (used by vector icons) and
// null when nothing parses.
export function maxDeclaredSize(sizes: string | null): number | null {
  if (!sizes) return null;
  const lc = sizes.toLowerCase().trim();
  if (lc === 'any') return Infinity;
  let max: number | null = null;
  for (const m of lc.matchAll(/(\d+)x(\d+)/g)) {
    const n = Math.max(Number(m[1]), Number(m[2]));
    if (max === null || n > max) max = n;
  }
  return max;
}

// ---------- Icon + HTML retrieval ----------
//
// Both legs delegate to file-loader's `fetchResourceBytes`. The icon
// path supports http(s) and file:// uniformly (the latter via the
// page-context XHR fallback). HTML probing is http-only with a more
// permissive content-type gate. Size caps are enforced inside
// fetchResourceBytes against both Content-Length (when the server
// supplies it) and the buffered body.

async function fetchHtml(url: string): Promise<{ text: string; finalUrl: string } | null> {
  const res = await fetchResourceBytes(url, {
    maxBytes: MAX_HTML_BYTES,
    acceptContentType: (ct) => ct.includes('html'),
  });
  if (!res) return null;
  // Decode as UTF-8. Real-world HTML in non-UTF-8 charsets is rare
  // enough today that we accept the occasional mojibake — and even
  // then the icon link tags are ASCII attributes that decode fine.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(res.body);
  return { text, finalUrl: res.finalUrl };
}

// Scheme-aware icon fetch. Used by both the origin-discovery path
// (always http(s)) and the `@icon`-header path (any of http(s)/file://).
// Goes through file-loader's bounded byte fetcher so the page-context
// chrome-extension → file:// opaque-response trap is sidestepped.
async function fetchIconAt(url: string): Promise<string | null> {
  const res = await fetchResourceBytes(url, {
    maxBytes: MAX_ICON_BYTES,
    acceptContentType: (ct) => ct.startsWith('image/'),
  });
  if (!res) return null;
  // Strip any `; charset=…` parameter; default to image/x-icon when
  // the server omitted Content-Type so the data URL still renders.
  const mime = res.contentType.split(';')[0].trim() || 'image/x-icon';
  return arrayBufferToDataUrl(res.body, mime);
}

function arrayBufferToDataUrl(buffer: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buffer);
  // Build the binary string in chunks; passing the whole array to
  // String.fromCharCode blows the call stack for large icons.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// ---------- Higher-level helpers ----------

// In-flight de-dup: simultaneous calls for the same cache key share one
// Promise. Cache rows that go stale and trigger a refetch land here
// too — the second caller waits on the first. The map is keyed by the
// full storage key (e.g. `siteIcon:<origin>` vs `iconUrl:<url>`) so the
// two icon-source paths don't collide.
const inflight = new Map<string, Promise<string | null>>();

export async function ensureSiteIcon(
  origin: string,
  probeUrl?: string,
): Promise<string | null> {
  const key = siteIconKey(origin);
  const pending = inflight.get(key);
  if (pending) return pending;

  const cached = (await loadSiteIcons([origin])).get(origin);
  if (cached && isCacheFresh(cached)) return cached.dataUrl;

  // Re-check after the storage await: another caller may have started
  // a fetch while we were reading.
  const racing = inflight.get(key);
  if (racing) return racing;

  const p = fetchAndCacheSiteIcon(origin, probeUrl).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

// Resolve a script-declared icon URL (`@icon` / `@iconURL` / etc.).
// Inline `data:` URLs are returned directly when within the size cap;
// http(s) and file:// URLs go through the same bounded fetch + storage
// cache the origin-discovery path uses, keyed by the URL itself so
// multiple scripts sharing a URL share one fetch.
export async function ensureIconForUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) {
    return url.length <= MAX_INLINE_DATA_URL_LEN ? url : null;
  }
  const key = urlIconKey(url);
  const pending = inflight.get(key);
  if (pending) return pending;

  const cached = await loadUrlIcon(url);
  if (cached && isCacheFresh(cached)) return cached.dataUrl;

  const racing = inflight.get(key);
  if (racing) return racing;

  const p = (async () => {
    const dataUrl = await fetchIconAt(url);
    await storeUrlIcon(url, { dataUrl, fetchedAt: Date.now() });
    return dataUrl;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

// ---------- DOM rendering ----------

// Minimum subset of StoredScript needed to render an icon slot. The
// header is consulted for `@icon` / `@iconURL` / etc. — when set, that
// URL takes priority over origin-based favicon discovery. `fileUrl` is
// the script's canonical fetchable URL, used as the base for resolving
// relative `@icon` paths against the script's parent directory.
// Declared locally so this module stays free of a dependency on
// script-store.
interface ScriptWithMatching {
  matching: { matches: string[] };
  fileUrl: string;
  header?: { tags: { tag: string; locale?: string; value: string }[] } | null;
}

// Build the favicon slot for a script row / viewer header. Always
// renders something synchronously: when the script's @match yields a
// usable origin, the slot becomes a clickable `<a>` opening linkUrl
// in a new tab; otherwise it holds an inert `<span>` (file:// scripts,
// `<all_urls>`, etc.). Either wrapper starts with a globe placeholder,
// swapped for the real favicon once it loads.
//
// Icon source priority: a script-declared `@icon` (or its aliases)
// wins outright over the origin-discovered favicon. The click-through
// link is always the site's linkUrl regardless — the @icon header is
// only a visual override.
export function renderSiteIconInto(slot: HTMLElement, script: ScriptWithMatching): void {
  const target = representativeMatch(script.matching);
  // The header value is raw (URL, data:, or relative path). Resolve it
  // against the script's own URL so `@icon foo.png` reaches the
  // sibling file alongside the script — and a `..`-bearing or
  // host-absolute ref drops back to origin discovery.
  const iconRef = iconRefFromHeader(script.header ?? null);
  const resolvedIcon = iconRef
    ? resolveScriptResource(iconRef, script.fileUrl)
    : null;
  const inner = slot.ownerDocument.createElement(target ? 'a' : 'span');
  inner.className = 'site-icon-inner';
  inner.appendChild(buildGlobeSvg(slot.ownerDocument));
  if (target) {
    const a = inner as HTMLAnchorElement;
    a.href = target.linkUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = target.linkUrl;
  }
  slot.replaceChildren(inner);
  if (!target && !resolvedIcon) return;

  void (async () => {
    let dataUrl: string | null;
    try {
      // Header-declared icon wins. Origin-based discovery only runs
      // when the script doesn't pin its own icon.
      dataUrl = resolvedIcon
        ? await ensureIconForUrl(resolvedIcon.url)
        : await ensureSiteIcon(target!.origin, target!.probeUrl);
    } catch {
      return;
    }
    if (!dataUrl) return;
    // No isConnected guard: a re-render replaces the whole slot, so
    // any paint into an orphaned `inner` decorates a subtree the user
    // never sees.
    const img = slot.ownerDocument.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    inner.replaceChildren(img);
  })();
}

function buildGlobeSvg(doc: Document): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'site-icon-globe');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const circle = doc.createElementNS(NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  svg.appendChild(circle);
  const equator = doc.createElementNS(NS, 'path');
  equator.setAttribute('d', 'M2 12h20');
  svg.appendChild(equator);
  const meridian = doc.createElementNS(NS, 'path');
  meridian.setAttribute('d', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z');
  svg.appendChild(meridian);
  return svg;
}
