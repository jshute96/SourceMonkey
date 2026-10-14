// SW-side handler for `GM_cookie` / `GM.cookie` (`list`, `set`,
// `delete`), over `chrome.cookies`.
//
// What a script may reach, as in TM and VM:
//   - Only URLs its own `@match` / `@include` rules cover (and no
//     `@exclude` does). Without a `url` the call is about the page the
//     script runs on; a relative `url` resolves against that page.
//   - `list` by `domain` alone is checked as `https://<domain>/`.
//   - `httpOnly` cookies stay hidden: `list` leaves them out, and `set`
//     and `delete` refuse to make or touch one. Both managers hide them
//     on Chrome by default (TM's "Allow scripts to access cookies"
//     setting, VM's per-script opt-in); we have no opt-in yet.
//
// Wire protocol (page → SW, `chrome.runtime.sendMessage`):
//   `{ type: 'sm:gm-cookie', scriptId, action, details }`
//   → `{ ok: true, cookies? }` or `{ ok: false, error }`.
// The page's URL comes from the sender, never the payload.

export const SM_GM_COOKIE_MSG = 'sm:gm-cookie';

export type CookieAction = 'list' | 'set' | 'delete';

export interface GmCookiePayload {
  type: typeof SM_GM_COOKIE_MSG;
  scriptId?: unknown;
  action?: unknown;
  details?: unknown;
}

// What `list` hands the script for each cookie: the fields TM gives.
// `storeId` is left out, as there.
export interface GmCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: chrome.cookies.SameSiteStatus;
  session: boolean;
  hostOnly: boolean;
  expirationDate?: number;
  partitionKey?: chrome.cookies.CookiePartitionKey;
}

export interface GmCookieResult {
  ok: boolean;
  cookies?: GmCookie[];
  error?: string;
}

export interface GmCookieContext {
  // The URL of the frame the call came from.
  pageUrl: string;
  // Whether the calling script's rules cover `url`.
  scriptMatches: (url: string) => boolean;
  // The cookie store of the caller's tab, when it isn't the default one
  // (an incognito tab). Undefined uses the extension's own store.
  storeId?: string;
}

export const HTTP_ONLY_HIDDEN = 'Userscripts cannot read or change httpOnly cookies';

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg === '' ? 'The browser gave no reason' : msg;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// The partition key as Chrome takes it, or undefined when the script
// gave none (or something that isn't one).
function partitionKeyOf(v: unknown): chrome.cookies.CookiePartitionKey | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { topLevelSite, hasCrossSiteAncestor } = v as Record<string, unknown>;
  const out: chrome.cookies.CookiePartitionKey = {};
  if (typeof topLevelSite === 'string') out.topLevelSite = topLevelSite;
  if (typeof hasCrossSiteAncestor === 'boolean') out.hasCrossSiteAncestor = hasCrossSiteAncestor;
  return out;
}

// The URL the call is about, checked against the script's rules, or the
// error to give back.
function targetUrl(
  raw: string | undefined, ctx: GmCookieContext,
): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw ?? ctx.pageUrl, ctx.pageUrl);
  } catch {
    return { error: `The cookie URL is not valid: ${raw}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Cookies can only be used on http and https URLs, not ${parsed.href}` };
  }
  if (!ctx.scriptMatches(parsed.href)) return { error: mustMatch(parsed.href) };
  return { url: parsed.href };
}

function mustMatch(url: string): string {
  return `The script's @match and @include rules must cover the cookie URL ${url}`;
}

function toGmCookie(c: chrome.cookies.Cookie): GmCookie {
  const out: GmCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
    hostOnly: c.hostOnly,
  };
  if (c.expirationDate !== undefined) out.expirationDate = c.expirationDate;
  if (c.partitionKey !== undefined) out.partitionKey = c.partitionKey;
  return out;
}

// Whether a `set` or `delete` of `name` could land on an httpOnly
// cookie, which the script must not be able to replace or remove.
// `get` would give only one cookie of that name, while a site can have
// several (by path, or host vs parent domain): `remove` can take more
// than one, and a `set` with its own `domain` / `path` another. So this
// looks at every cookie of that name sent to `url`, and every one on
// `domain` and its subdomains. That can refuse a call that would have
// missed the httpOnly one, which is the safe side.
async function touchesHttpOnly(
  url: string, name: string, domain: string,
  partitionKey: chrome.cookies.CookiePartitionKey | undefined, storeId: string | undefined,
): Promise<boolean> {
  const extra = { ...(partitionKey ? { partitionKey } : {}), ...(storeId ? { storeId } : {}) };
  const [byUrl, byDomain] = await Promise.all([
    chrome.cookies.getAll({ url, name, ...extra }),
    chrome.cookies.getAll({ domain, name, ...extra }),
  ]);
  return byUrl.some((c) => c.httpOnly) || byDomain.some((c) => c.httpOnly);
}

// The values Chrome takes for `sameSite`.
const SAME_SITE: readonly string[] = ['no_restriction', 'lax', 'strict', 'unspecified'];

export async function runCookieCall(
  action: unknown, rawDetails: unknown, ctx: GmCookieContext,
): Promise<GmCookieResult> {
  if (!chrome.cookies) {
    return { ok: false, error: 'Cookie access is not available in this browser' };
  }
  if (action !== 'list' && action !== 'set' && action !== 'delete') {
    return { ok: false, error: `Unknown action ${String(action)}; use list, set or delete` };
  }
  const d = (rawDetails && typeof rawDetails === 'object' ? rawDetails : {}) as Record<string, unknown>;
  const partitionKey = partitionKeyOf(d.partitionKey);
  const storeId = ctx.storeId;
  try {
    if (action === 'list') return await list(d, ctx, partitionKey, storeId);
    if (action === 'set') return await set(d, ctx, partitionKey, storeId);
    return await remove(d, ctx, partitionKey, storeId);
  } catch (err) {
    const what = action === 'list' ? 'list the cookies' : `${action} the cookie`;
    return { ok: false, error: `The browser could not ${what}: ${reason(err)}` };
  }
}

async function list(
  d: Record<string, unknown>, ctx: GmCookieContext,
  partitionKey: chrome.cookies.CookiePartitionKey | undefined, storeId: string | undefined,
): Promise<GmCookieResult> {
  const query: chrome.cookies.GetAllDetails = {};
  const domain = str(d.domain);
  // A `domain` without a `url` lists that domain's cookies (its
  // subdomains' too), wherever the page is.
  if (domain && d.url === undefined) {
    const checkUrl = `https://${domain.replace(/^\./, '')}/`;
    if (!ctx.scriptMatches(checkUrl)) return { ok: false, error: mustMatch(checkUrl) };
  } else {
    const t = targetUrl(str(d.url), ctx);
    if ('error' in t) return { ok: false, error: t.error };
    query.url = t.url;
  }
  if (domain) query.domain = domain;
  if (str(d.name) !== undefined) query.name = str(d.name);
  if (str(d.path) !== undefined) query.path = str(d.path);
  if (partitionKey) query.partitionKey = partitionKey;
  if (storeId) query.storeId = storeId;
  const found = await chrome.cookies.getAll(query);
  return { ok: true, cookies: found.filter((c) => !c.httpOnly).map(toGmCookie) };
}

async function set(
  d: Record<string, unknown>, ctx: GmCookieContext,
  partitionKey: chrome.cookies.CookiePartitionKey | undefined, storeId: string | undefined,
): Promise<GmCookieResult> {
  const t = targetUrl(str(d.url), ctx);
  if ('error' in t) return { ok: false, error: t.error };
  if (d.httpOnly === true) return { ok: false, error: HTTP_ONLY_HIDDEN };
  // TM's coercion: a missing name or value is an empty string.
  const name = d.name === undefined ? '' : String(d.name);
  const value = d.value === undefined ? '' : String(d.value);
  const details: chrome.cookies.SetDetails = {
    url: t.url,
    name,
    value,
    // Chrome defaults `secure` to false; an https page's cookie should
    // be secure unless asked otherwise (VM does the same).
    secure: typeof d.secure === 'boolean' ? d.secure : t.url.startsWith('https:'),
  };
  if (str(d.domain) !== undefined) details.domain = str(d.domain);
  if (str(d.path) !== undefined) details.path = str(d.path);
  if (d.sameSite !== undefined) {
    if (typeof d.sameSite !== 'string' || !SAME_SITE.includes(d.sameSite)) {
      return { ok: false, error: `sameSite must be one of ${SAME_SITE.join(', ')}, not ${String(d.sameSite)}` };
    }
    details.sameSite = d.sameSite as chrome.cookies.SameSiteStatus;
  }
  if (typeof d.expirationDate === 'number') details.expirationDate = d.expirationDate;
  if (partitionKey) details.partitionKey = partitionKey;
  if (storeId) details.storeId = storeId;
  const domain = details.domain ?? new URL(t.url).hostname;
  if (await touchesHttpOnly(t.url, name, domain, partitionKey, storeId)) {
    return { ok: false, error: HTTP_ONLY_HIDDEN };
  }
  const made = await chrome.cookies.set(details);
  // Chrome resolves null, with no error, for a cookie it won't store
  // (a bad domain, a secure cookie on http).
  if (!made) return { ok: false, error: `The browser refused to set the cookie ${name}` };
  return { ok: true };
}

async function remove(
  d: Record<string, unknown>, ctx: GmCookieContext,
  partitionKey: chrome.cookies.CookiePartitionKey | undefined, storeId: string | undefined,
): Promise<GmCookieResult> {
  const name = str(d.name);
  if (!name) return { ok: false, error: 'The cookie to delete needs a name' };
  const t = targetUrl(str(d.url), ctx);
  if ('error' in t) return { ok: false, error: t.error };
  const details: chrome.cookies.CookieDetails = { url: t.url, name };
  if (partitionKey) details.partitionKey = partitionKey;
  if (storeId) details.storeId = storeId;
  if (await touchesHttpOnly(t.url, name, new URL(t.url).hostname, partitionKey, storeId)) {
    return { ok: false, error: HTTP_ONLY_HIDDEN };
  }
  await chrome.cookies.remove(details);
  return { ok: true };
}

// The cookie store of an incognito tab. Chrome's extension APIs default
// to the regular profile's store, so without this a script on an
// incognito page would read and write the user's regular cookies.
export async function incognitoStoreId(tabId: number): Promise<string | undefined> {
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((s) => s.tabIds.includes(tabId))?.id;
}
