import { fetchResourceBytes, isNotModified, resolveScriptResource } from './file-loader.js';
import { presentLocalFileCandidates } from './local-file-overrides.js';
import type { DirectoryListingCache } from './directories.js';
import { MAX_SITE_ICONS, representativeMatches, type MatchTarget } from './match-targets.js';
import { renderGlyph } from './glyph.js';
import { getValue } from './userscript-header.js';

// Site-icon (favicon) extraction + cache. Used by the collections page
// and userscript viewer to show a 16x16 icon per targeted site (up to
// MAX_SITE_ICONS distinct sites) next to each script.
//
// Two-tier lookup, so deep-targeted scripts (e.g. one userscript per
// section of a big site) each get their own icon instead of sharing
// the first one discovered for the origin:
//   1. page URL → HTML discovery there (cached per page URL).
//   2. origin fallback → origin-root HTML → /favicon.ico → Google S2
//      (cached per origin, shared across every script on that host).
// The page URL is each site's `linkUrl` from `representativeMatches` —
// the same URL that site's favicon click-through navigates to.
//
// Caches in chrome.storage.local:
//   `pathIcon:<pageUrl>`  — HTML-discovery result for that specific
//      page. Null means "no icon on this page" — we fall back to
//      the origin cache, not refetch the page.
//   `siteIcon:<origin>`   — origin-level fallback result (root HTML
//      + /favicon.ico + Google S2). Shared across all scripts on
//      the origin.
// Success entries live 7d, null entries 24h so a transient outage
// doesn't permanently blank the row. The page-URL cache layer is
// skipped entirely when the page URL is just the origin root — the
// two would otherwise duplicate the same fetch.
//
// Reads go through `usableCacheHit`, which counts a row we wouldn't
// paint as a miss — so a row written by an older, laxer build heals on
// the next render instead of waiting out its TTL.

export interface SiteIconEntry {
  dataUrl: string | null;
  fetchedAt: number;
}

const KEY_PREFIX = 'siteIcon:';
const siteIconKey = (origin: string): string => `${KEY_PREFIX}${origin}`;

// Path-scoped cache for icons discovered by probing a non-root URL.
// Key is the full page URL (origin + `linkUrl` path) — each deep
// section gets its own entry so e.g. nytimes.com/puzzles/spelling-bee/
// can have a different icon from nytimes.com/athletic/. Hits here are
// strictly the HTML-discovery result; origin-level fallbacks live in
// `siteIcon:` so the /favicon.ico + S2 fetches happen at most once
// per host.
const PATH_ICON_KEY_PREFIX = 'pathIcon:';
const pathIconKey = (pageUrl: string): string => `${PATH_ICON_KEY_PREFIX}${pageUrl}`;

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

function isDataUrl(url: string): boolean {
  return /^data:/i.test(url);
}

// Does a `data:` URL actually carry bytes? `data:,` (empty) is the
// standard "this site has no favicon, stop asking" marker —
// example.com serves exactly that — and painting it yields a blank
// broken `<img>` where the globe placeholder belongs. A missing comma
// counts as empty too: that's not a well-formed `data:` URL at all.
// The one rule; every place an icon can enter or leave applies it.
function dataUrlHasPayload(url: string): boolean {
  const comma = url.indexOf(',');
  return comma >= 0 && url.slice(comma + 1).trim() !== '';
}

// A `data:` URL is usable as an icon only when it's within the inline
// cap AND carries a payload. Shared by both entry points for an inline
// icon: the `<link href="data:...">` discovery path and a script's own
// `@icon data:...`. Both check the scheme before calling.
function usableDataUrl(url: string): string | null {
  if (url.length > MAX_INLINE_DATA_URL_LEN) return null;
  return dataUrlHasPayload(url) ? url : null;
}

// Would we put this stored string in an `<img src>`? Every icon we
// store is a payload-bearing `data:` URL, so anything else is a row
// this build didn't write — and the point of asking is to distrust
// rows written by other builds. Defaulting closed keeps an unknown
// shape (say a bare `https:` URL, which an extension page would fetch
// remotely and most likely have blocked) out of the DOM.
function paintableIcon(dataUrl: string): boolean {
  return isDataUrl(dataUrl) && dataUrlHasPayload(dataUrl);
}

// An `href="data:,"` is the page declaring it HAS no icon, not a
// candidate. Drop it before scoring, so a page offering both that
// marker and a real icon doesn't hand the win to the marker — `icon`
// outscores `apple-touch-icon`, so the marker would take it. Unlike
// `paintableIcon` this defaults open: most hrefs are ordinary paths,
// and only the marker shape is disqualifying.
function emptyDataHref(href: string): boolean {
  const h = href.trim();
  return isDataUrl(h) && !dataUrlHasPayload(h);
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

async function loadPathIcon(pageUrl: string): Promise<SiteIconEntry | undefined> {
  const got = await chrome.storage.local.get(pathIconKey(pageUrl));
  return got[pathIconKey(pageUrl)] as SiteIconEntry | undefined;
}

async function storePathIcon(pageUrl: string, entry: SiteIconEntry): Promise<void> {
  await chrome.storage.local.set({ [pathIconKey(pageUrl)]: entry });
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

// Read a cache row as a settled answer, or null meaning "go fetch".
// Stale is a miss, and so is a row holding a dataUrl we would refuse
// to paint — a build predating the empty-`data:` check stored
// example.com's `data:,` marker as though it were an icon, and nothing
// but the 7-day success TTL would ever have cleared it. Treating it as
// a miss both hides it now and overwrites the row with the correct
// "no icon" on the refetch.
export function usableCacheHit(entry: SiteIconEntry | undefined): SiteIconEntry | null {
  if (!entry || !isCacheFresh(entry)) return null;
  if (entry.dataUrl !== null && !paintableIcon(entry.dataUrl)) return null;
  return entry;
}

// ---------- Favicon fetch ----------

// Discover an icon by HTML-probing `pageUrl` only — no fallbacks.
// Cached under `pathIcon:<pageUrl>` so each deep-targeted script gets
// its own entry. A null result means "no usable icon on this page";
// callers fall back to the origin-level cache rather than retrying.
async function fetchAndCachePathIcon(pageUrl: string): Promise<string | null> {
  const dataUrl = await tryDiscoverIconViaHtml(pageUrl);
  await storePathIcon(pageUrl, { dataUrl, fetchedAt: Date.now() });
  return dataUrl;
}

// Discover an icon for `origin` via the shared fallback chain
// (origin-root HTML → /favicon.ico → Google S2). Cached under
// `siteIcon:<origin>` and shared across every script on the host —
// the path-scoped lookup hits this when its own probe came up empty.
async function fetchAndCacheOriginIcon(origin: string): Promise<string | null> {
  const dataUrl = await fetchOriginFallbackAsDataUrl(origin);
  await storeSiteIcon(origin, { dataUrl, fetchedAt: Date.now() });
  return dataUrl;
}

async function fetchOriginFallbackAsDataUrl(origin: string): Promise<string | null> {
  const fromRoot = await tryDiscoverIconViaHtml(origin + '/');
  if (fromRoot) return fromRoot;
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
  if (absUrl.startsWith('data:')) return usableDataUrl(absUrl);
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

// Pick the candidate most likely to look good at 16x16. Two kinds are
// dropped before scoring rather than ranked low: mask-icon (a Safari
// pinned-tab monochrome SVG mask, which renders as a black silhouette
// in <img>) and an empty `data:` href (see `emptyDataHref`).
export function pickBestIconCandidate(
  candidates: IconCandidate[],
): IconCandidate | null {
  if (candidates.length === 0) return null;
  const viable = candidates.filter(
    (c) => !c.rel.includes('mask-icon') && !emptyDataHref(c.href),
  );
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
  // `isNotModified` can't fire — neither icon fetch passes `conditional`
  // — but it is in the return type, and narrowing it here is cheaper
  // than a cast that would go stale if one ever did.
  if ('failed' in res || isNotModified(res)) return null;
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
  // Icons fail quietly — a missing favicon is cosmetic, and there is
  // no surface that would show a reason.
  if ('failed' in res || isNotModified(res)) return null;
  // Strip any `; charset=…` parameter; default to image/x-icon when
  // the server omitted Content-Type so the data URL still renders.
  const mime = res.contentType.split(';')[0].trim() || 'image/x-icon';
  const dataUrl = arrayBufferToDataUrl(res.body, mime);
  // Keep the stored-icons-are-paintable invariant local. A zero-byte
  // 200 would encode to a payload-less `data:<mime>;base64,`, which
  // the read side rejects — so storing it would mean refetching on
  // every single paint, forever, and silently. `fetchResourceBytes`
  // already refuses empty bodies, but that lives in another module.
  return paintableIcon(dataUrl) ? dataUrl : null;
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
// two icon-collection paths don't collide.
const inflight = new Map<string, Promise<string | null>>();

export async function ensureSiteIcon(
  origin: string,
  pageUrl?: string,
): Promise<string | null> {
  const rootUrl = origin + '/';
  // The path-scoped layer only earns its keep when the probe is deeper
  // than the origin root — otherwise it would just duplicate the
  // origin-root HTML fetch the fallback chain already does.
  const usePath = pageUrl !== undefined && pageUrl !== rootUrl && pageUrl !== origin;
  if (usePath) {
    const pathHit = await ensurePathIcon(pageUrl!);
    if (pathHit !== null) return pathHit;
  }
  return ensureOriginIcon(origin);
}

async function ensurePathIcon(pageUrl: string): Promise<string | null> {
  const key = pathIconKey(pageUrl);
  const pending = inflight.get(key);
  if (pending) return pending;

  const cached = usableCacheHit(await loadPathIcon(pageUrl));
  if (cached) return cached.dataUrl;

  // Re-check after the storage await: another caller may have started
  // a fetch while we were reading.
  const racing = inflight.get(key);
  if (racing) return racing;

  const p = fetchAndCachePathIcon(pageUrl).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

async function ensureOriginIcon(origin: string): Promise<string | null> {
  const key = siteIconKey(origin);
  const pending = inflight.get(key);
  if (pending) return pending;

  const cached = usableCacheHit((await loadSiteIcons([origin])).get(origin));
  if (cached) return cached.dataUrl;

  const racing = inflight.get(key);
  if (racing) return racing;

  const p = fetchAndCacheOriginIcon(origin).finally(() => {
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
//
// `localRoots` opts this into the same local-override rule `@require`
// and `@resource` use — see docs/local-file-overrides.md. Without it
// (the default) nothing changes and no local reads happen. A script
// that declares its icon by absolute URL while developing locally would
// otherwise be the one file reference that ignored the copy on disk,
// which reads as a gap rather than a policy.
export async function ensureIconForUrl(
  url: string,
  localRoots: readonly string[] = [],
): Promise<string | null> {
  if (url.startsWith('data:')) return usableDataUrl(url);
  for (const candidate of await presentLocalFileCandidates(url, localRoots, iconRootListings)) {
    const local = await localIconCandidate(candidate);
    if (local) return local;
  }
  return ensureIconAt(url);
}

// A local stand-in candidate, memoized for the life of the page rather
// than written to the storage cache.
//
// Deliberately NOT the storage cache: a miss there is remembered for 24
// hours, so an icon file created after the first paint wouldn't appear
// until the next day — the same "why isn't my edit showing up" trap the
// require path exists to avoid. A page-lifetime memo instead means the
// cost is one local read per icon per page load (repaints are free) and
// a reload always sees the current state of the disk.
//
// A candidate that isn't there, or isn't an image, just returns null and
// the caller falls through to the declared URL.
const localIconMemo = new Map<string, Promise<string | null>>();

// Root listings for the candidate gate, memoized for the life of the
// page for the same reason as `localIconMemo`: the page-lifetime memo
// already means a file created after first paint waits for a reload,
// so a listing of the same age hides nothing the memo didn't.
const iconRootListings: DirectoryListingCache = new Map();

function localIconCandidate(url: string): Promise<string | null> {
  const memo = localIconMemo.get(url);
  if (memo) return memo;
  const p = fetchIconAt(url);
  localIconMemo.set(url, p);
  return p;
}

async function ensureIconAt(url: string): Promise<string | null> {
  const key = urlIconKey(url);
  const pending = inflight.get(key);
  if (pending) return pending;

  const cached = usableCacheHit(await loadUrlIcon(url));
  if (cached) return cached.dataUrl;

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
// relative `@icon` paths.
// Declared locally so this module stays free of a dependency on
// script-store.
interface ScriptWithMatching {
  matching: { matches: string[] };
  fileUrl: string;
  header?: { tags: { tag: string; locale?: string; value: string }[] } | null;
}

// How many sites a page heading shows — the viewer's and the compare
// page's. More than a collections row: the heading is the one place a
// script's whole target list is worth a glance, and nothing beside it
// needs to line up.
export const HEADING_SITE_ICONS = 10;

// Build the favicon slot for a script row / viewer header. Always
// renders something synchronously: one clickable `<a>` per distinct
// site the script's @match set names (opening that site's linkUrl in
// a new tab, at most `limit` of them — a table row has less room than
// a heading), or a single inert `<span>` when no pattern yields a
// usable origin (file:// scripts, `<all_urls>`, etc.). Every wrapper
// starts with a globe placeholder, swapped for the real favicon once
// it loads.
//
// Two sites that turn out to share one favicon image (maps.google.com
// and www.google.com, say) — or that both came up empty and show the
// globe — collapse to the first icon once both have loaded: the
// duplicate is removed and the survivor's tooltip lists every site it
// now stands for. Compared by the resolved data URL, which is the only
// way to know — the hosts differ.
//
// Icon collection priority: a script-declared `@icon` (or its aliases)
// wins outright over the origin-discovered favicons and collapses the
// slot to that one icon — a script that pins its icon has said what
// it wants to look like. Its click-through link is still the first
// site's linkUrl — the @icon header is only a visual override.
//
// Resolves, once every fetch has settled, with the number of icons the
// slot ended up holding.
export async function renderSiteIconInto(
  slot: HTMLElement,
  script: ScriptWithMatching,
  // Local override roots for a script-declared `@icon`, from the
  // caller's `StoredCollection`. Passed in rather than derived here
  // because the per-collection opt-out lives on the collection row,
  // which this module has no reason to load. Omitted → no overrides, no
  // local reads.
  localRoots: readonly string[] = [],
  limit: number = MAX_SITE_ICONS,
): Promise<number> {
  const targets = representativeMatches(script.matching, limit);
  // The header value is raw (URL, data:, or relative path). Resolve it
  // against the script's own URL so `@icon foo.png` reaches the
  // sibling file alongside the script. A ref that climbs out of a
  // LOCAL script's folder is rejected and drops back to origin
  // discovery; from a remote script it resolves like any other URL.
  const iconRef = iconRefFromHeader(script.header ?? null);
  const resolvedIcon = iconRef
    ? resolveScriptResource(iconRef, script.fileUrl)
    : null;

  if (targets.length === 0) {
    // No usable target URL for this script's @match set (file://,
    // `<all_urls>`, malformed pattern, …). Surface that explicitly so
    // hovering the inert globe isn't silent.
    const inner = buildInner(slot, null);
    slot.replaceChildren(inner);
    if (resolvedIcon) await paintIcon(inner, ensureIconForUrl(resolvedIcon.url, localRoots));
    return 1;
  }

  if (resolvedIcon) {
    // This is the script's own icon, not a site's, so the tooltip leads
    // with the script's name; every site it names follows — all of
    // them, not just the `limit` a row would show.
    const inner = buildInner(slot, targets[0]);
    const sites = representativeMatches(script.matching, Infinity).map((t) => t.linkUrl);
    const name = script.header ? getValue(script.header, 'name')?.trim() : undefined;
    inner.title = name ? `${name}\n${sitesTooltip(sites)}` : sitesTooltip(sites);
    slot.replaceChildren(inner);
    await paintIcon(inner, ensureIconForUrl(resolvedIcon.url, localRoots));
    return 1;
  }

  const inners = targets.map((t) => buildInner(slot, t));
  slot.replaceChildren(...inners);
  const painted = await Promise.all(
    targets.map((t, i) => paintIcon(inners[i], ensureSiteIcon(t.origin, t.linkUrl))),
  );

  // Collapse sites whose favicon came back byte-identical — and sites
  // that all ended on the globe, which look identical too; a row of
  // three globes says nothing three times.
  const firstByIcon = new Map<string, number>();
  const mergedInto: string[][] = targets.map((t) => [t.linkUrl]);
  for (let i = 0; i < inners.length; i++) {
    const icon = painted[i] ?? '';
    const first = firstByIcon.get(icon);
    if (first === undefined) {
      firstByIcon.set(icon, i);
      continue;
    }
    inners[i].remove();
    mergedInto[first].push(targets[i].linkUrl);
    inners[first].title = sitesTooltip(mergedInto[first]);
  }
  // Real favicons before the globe: a globe says only "a site", so it
  // goes last where it isn't in the way. The first site stays first
  // even as a globe — it is the script's primary site, and the header
  // order is what the reader expects to find there.
  for (let i = 1; i < inners.length; i++) {
    if (inners[i].isConnected && painted[i] === null) slot.appendChild(inners[i]);
  }
  return slot.childElementCount;
}

// Lines a merged icon's tooltip can show before it turns into a count.
const TOOLTIP_SITES_MAX = 10;

// Tooltip for an icon standing for several sites: one URL per line,
// then `(and N more)` once the list runs long — a fifty-site tooltip
// is a wall, not a hint.
export function sitesTooltip(urls: readonly string[]): string {
  if (urls.length <= TOOLTIP_SITES_MAX) return urls.join('\n');
  const shown = urls.slice(0, TOOLTIP_SITES_MAX);
  return `${shown.join('\n')}\n(and ${urls.length - TOOLTIP_SITES_MAX} more)`;
}

// The icon for ONE `@match` pattern, as the viewer's Match rows show
// beside each entry. Linked to `linkUrl` when the pattern gave us one
// (the site, or the same-directory fallback for a site-less pattern),
// inert otherwise. The favicon comes from `target`'s site; a linkable
// pattern that names no site (`*://*/x/page.html`) keeps the globe.
export function renderPatternIconInto(
  slot: HTMLElement,
  target: MatchTarget | null,
  linkUrl: string | null,
): void {
  const inner = buildInner(slot, linkUrl);
  slot.replaceChildren(inner);
  if (target) void paintIcon(inner, ensureSiteIcon(target.origin, target.linkUrl));
}

// One icon's wrapper: a link when there is a URL to open, an inert
// span otherwise. Starts out holding the globe placeholder.
function buildInner(slot: HTMLElement, target: MatchTarget | string | null): HTMLElement {
  const linkUrl = typeof target === 'string' ? target : target?.linkUrl ?? null;
  const inner = slot.ownerDocument.createElement(linkUrl ? 'a' : 'span');
  inner.className = 'site-icon-inner';
  inner.appendChild(buildGlobeSvg(slot.ownerDocument));
  if (linkUrl) {
    const a = inner as HTMLAnchorElement;
    a.href = linkUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = linkUrl;
  } else {
    inner.title = 'Unable to extract link to target site';
  }
  return inner;
}

// Swap the globe inside `inner` for the icon `pending` resolves to,
// and hand back that icon's data URL (null when there is none, or the
// fetch failed — the globe stays). No isConnected guard: a re-render
// replaces the whole slot, so any paint into an orphaned `inner`
// decorates a subtree the user never sees.
async function paintIcon(
  inner: HTMLElement,
  pending: Promise<string | null>,
): Promise<string | null> {
  let dataUrl: string | null;
  try {
    dataUrl = await pending;
  } catch {
    return null;
  }
  if (!dataUrl) return null;
  const img = inner.ownerDocument.createElement('img');
  img.src = iconImgSrc(dataUrl);
  img.alt = '';
  inner.replaceChildren(img);
  return dataUrl;
}

// Per-document registry: one blob: URL per distinct large icon. With
// dozens of scripts targeting the same site, every row otherwise
// inlined its own copy of the favicon's base64 `data:` URL — a handful
// of distinct icons re-inlined across ~every row, which ballooned the
// collections page past half a megabyte. Pointing every row at a shared
// ~55-char blob: handle instead drops all that duplication out of the
// DOM; the bytes live once in the browser's blob table.
//
// Document-lifetime, never revoked: the set is bounded by the number of
// DISTINCT icons on the page (tiny), and not revoking keeps it
// bfcache-safe — a restored page's <img>s still resolve. This mirrors
// the GM_getResourceURL policy (see wrapper-gm-runtime.js). Keyed by the
// data: URL string, so a re-render reuses the existing blob for an
// unchanged icon and only mints one for genuinely new icons.
const iconObjectUrls = new Map<string, string>();

// Icons whose `data:` URL is at or below this many chars stay inline —
// below it a blob: URL (plus its table entry) doesn't beat the data URL
// it would replace, and de-duping a handful of tiny bytes isn't worth
// it. Sits well above the favicons used in tests and well below
// real-world ones (smallest observed ≈ 1.2 KB).
const ICON_INLINE_MAX_LEN = 512;

// Map a cached icon `data:` URL to what we actually put in `<img src>`:
// large icons become a shared blob: URL (deduped by the data URL
// string); small ones pass through unchanged.
function iconImgSrc(dataUrl: string): string {
  if (dataUrl.length <= ICON_INLINE_MAX_LEN) return dataUrl;
  const existing = iconObjectUrls.get(dataUrl);
  if (existing) return existing;
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return dataUrl;       // unparseable → fall back to inline
  const url = URL.createObjectURL(blob);
  iconObjectUrls.set(dataUrl, url);
  return url;
}

// Decode a `data:[<mime>][;base64],<payload>` URL into a Blob
// synchronously (no fetch round-trip) so the caller can swap `src`
// without an extra await. Handles base64 and plain (percent-encoded)
// payloads; returns null on anything it can't parse. The non-base64
// branch assumes a TEXT payload (it round-trips through a JS string, so
// raw binary would be UTF-8-mangled) — fine here because real binary
// icon data URLs are always `;base64`; the only non-base64 icons we
// see are inline SVG/text.
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const meta = dataUrl.slice(5, comma);          // e.g. "image/png;base64"
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const mime = (isBase64 ? meta.slice(0, -7) : meta).split(';')[0] || 'application/octet-stream';
  try {
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
}

// The globe placeholder shown until a favicon loads (and the permanent
// icon for scripts with no resolvable origin). Rendered as a tiny
// `<use>` of the shared `#sm-globe` <symbol> defined once per page, so
// 100+ rows don't each inline the full circle+meridian path data. The
// stroke/fill presentation lives in CSS on `.site-icon-globe`.
function buildGlobeSvg(doc: Document): SVGSVGElement {
  return renderGlyph(doc, '#sm-globe', 'site-icon-globe');
}
