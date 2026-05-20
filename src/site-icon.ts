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

const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NULL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ICON_BYTES = 128 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
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
// deeper than the origin root — see file header.
//   https://example.com/*              → probe `/`
//   https://example.com/app/home/*     → probe `/app/home/`
//   https://example.com/posts/*/edit   → probe `/posts/`
export function representativeMatch(matching: {
  matches: string[];
}): { origin: string; probeUrl: string } | null {
  for (const m of matching.matches) {
    const got = matchTargetInfo(m);
    if (got) return got;
  }
  return null;
}

function matchTargetInfo(pattern: string): { origin: string; probeUrl: string } | null {
  const p = parseMatchPattern(pattern);
  if (!p) return null;
  const origin = `${p.scheme}://${p.host}`;
  const star = p.path.indexOf('*');
  const literalPath = star < 0 ? p.path : p.path.slice(0, star);
  // Empty prefix means the path started with `*`. Use `/` for a
  // well-formed URL.
  return { origin, probeUrl: origin + (literalPath || '/') };
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

// ---------- Bounded fetch ----------

// Shared scaffolding for the HTML and icon-image fetches: aborting
// timeout, redirect-following, no-referrer (to avoid leaking the
// chrome-extension:// origin to third parties), content-type filter,
// and a size cap. The size cap is checked against Content-Length when
// the server provides it, and again against the buffered body — so an
// honest server with an oversized payload is rejected before the read,
// and a server that omits Content-Length still can't overrun by more
// than one buffered body. Streaming-read enforcement would be tighter
// but is not worth the complexity at our threat model (we only probe
// origins the user opted into via their userscripts).
type FetchKind = 'html' | 'image';

interface FetchedBytes {
  body: ArrayBuffer;
  contentType: string;
  finalUrl: string;
}

async function fetchBounded(
  url: string,
  kind: FetchKind,
  maxBytes: number,
): Promise<FetchedBytes | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType) {
    const acceptable = kind === 'html'
      ? contentType.includes('html')
      : contentType.startsWith('image/');
    if (!acceptable) return null;
  }

  const cl = response.headers.get('content-length');
  if (cl && Number(cl) > maxBytes) return null;

  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (body.byteLength === 0 || body.byteLength > maxBytes) return null;

  return { body, contentType, finalUrl: response.url || url };
}

async function fetchHtml(url: string): Promise<{ text: string; finalUrl: string } | null> {
  const res = await fetchBounded(url, 'html', MAX_HTML_BYTES);
  if (!res) return null;
  // Decode as UTF-8. Real-world HTML in non-UTF-8 charsets is rare
  // enough today that we accept the occasional mojibake — and even
  // then the icon link tags are ASCII attributes that decode fine.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(res.body);
  return { text, finalUrl: res.finalUrl };
}

async function fetchIconAt(url: string): Promise<string | null> {
  const res = await fetchBounded(url, 'image', MAX_ICON_BYTES);
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

// In-flight de-dup: simultaneous calls for the same origin share one
// Promise. Cache rows that go stale and trigger a refetch land here
// too — the second caller waits on the first.
const inflight = new Map<string, Promise<string | null>>();

export async function ensureSiteIcon(
  origin: string,
  probeUrl?: string,
): Promise<string | null> {
  // Synchronous inflight check first: simultaneous calls for the same
  // origin should not race storage reads only to converge on the same
  // pending fetch a moment later.
  const pending = inflight.get(origin);
  if (pending) return pending;

  const cached = (await loadSiteIcons([origin])).get(origin);
  if (cached && isCacheFresh(cached)) return cached.dataUrl;

  // Re-check after the storage await: another caller may have started
  // a fetch while we were reading.
  const racing = inflight.get(origin);
  if (racing) return racing;

  const p = fetchAndCacheSiteIcon(origin, probeUrl).finally(() => {
    inflight.delete(origin);
  });
  inflight.set(origin, p);
  return p;
}
