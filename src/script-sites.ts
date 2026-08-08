// Maps a script's URL on a userscript-hosting site back to the
// human-facing page it was published on.
//
// Why this exists: what we store and fetch from these sites is the
// *raw code* URL, which is not a page a person would want to open —
// the listing page with the description, version history, and comments
// is a sibling URL. Each site encodes the script's identity in its
// code URL, so the page URL is a pure rewrite: no network call, no
// stored field.
//
// The per-site URL shapes live in `SITE_RULES` below and nowhere else;
// `docs/script-viewer.md` tabulates them for readers who aren't in
// this file.
//
// Pure string/URL logic, no DOM and no chrome.* calls, so the table is
// unit testable.

export interface ScriptSitePage {
  // Display name of the hosting site, as its own branding writes it.
  // The details panel builds a row label out of it ("Greasy Fork
  // page"), so it should read as a proper noun.
  siteName: string;
  // Absolute https URL of the script's page on that site.
  url: string;
  // Identity of the script on that site, stable across the URL
  // spellings the site accepts (code vs page URL, locale prefix,
  // cosmetic slug). Compare keys, never URLs, to ask "same script?".
  key: string;
}

// One site's rewrite. Each rule recognises BOTH the code URL and the
// page URL, so `key` names the script whichever spelling it was handed
// — that is what lets the details panel tell "my `@homepage` already
// points at this page" from "it points somewhere else", across two
// URLs that share no common prefix.
interface SiteRule {
  siteName: string;
  // Matched against the lowercased host of the URL.
  hosts: readonly string[];
  // Given the parsed URL, return the page URL and identity key, or
  // null when the path doesn't have a recognised shape (someone's
  // arbitrary file hosted on the same domain).
  page: (url: URL) => { url: string; key: string } | null;
}

// Greasy Fork and its adult-content sibling Sleazy Fork run the same
// software, so one rule builder serves both:
//
//   https://greasyfork.org/en/scripts/12345-my-script/code/my%20script.user.js
//   https://greasyfork.org/en/scripts/12345-my-script          (page)
//     → https://greasyfork.org/en/scripts/12345-my-script
//   https://update.greasyfork.org/scripts/12345/my%20script.user.js
//     → https://greasyfork.org/scripts/12345
//
// The numeric id alone resolves the page and is the whole identity, so
// the `-<slug>` tail and the locale prefix are display-only and stay
// out of the key. The locale (`/en/`, `/zh-CN/`, `/es-419/`) is
// matched loosely on purpose: an unrecognised shape would fail the
// whole match and drop the row, rather than fall back to the
// locale-less page.
//
// The path is read WITHOUT `decodeURI`: both captures are
// encoding-agnostic, and decoding would splice a raw space or a
// decoded CJK slug into the href, disagreeing with every other URL
// the panel prints.
const FORK_PATH_RE =
  /^\/(?:([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,})?)\/)?scripts\/(\d+)(-[^/]*)?(?:\/|$)/;

function forkRule(siteName: string, host: string): SiteRule {
  return {
    siteName,
    hosts: [host, `www.${host}`, `update.${host}`],
    page: (url) => {
      const m = FORK_PATH_RE.exec(url.pathname);
      if (!m) return null;
      const locale = m[1] ? `/${m[1]}` : '';
      return {
        url: `https://${host}${locale}/scripts/${m[2]}${m[3] ?? ''}`,
        key: `${host}:${m[2]}`,
      };
    },
  };
}

// GitHub proper is deliberately absent: `raw.githubusercontent.com`
// URLs are already rewritten to their `github.com/<o>/<r>/blob/...`
// page form before they reach the viewer (see `githubRawToBlobUrl` in
// `github-source.ts`), so the Location row is the page link. Gists get
// a rule because that rewrite doesn't cover them.
const SITE_RULES: readonly SiteRule[] = [
  forkRule('Greasy Fork', 'greasyfork.org'),
  forkRule('Sleazy Fork', 'sleazyfork.org'),
  {
    // https://openuserjs.org/install/User/Script_Name.user.js
    // https://openuserjs.org/src/scripts/User/Script_Name.user.js
    // https://openuserjs.org/scripts/User/Script_Name          (page)
    //   → https://openuserjs.org/scripts/User/Script_Name
    siteName: 'OpenUserJS',
    hosts: ['openuserjs.org', 'www.openuserjs.org'],
    page: (url) => {
      const code = /^\/(?:install|src\/scripts)\/([^/]+)\/(.+?)\.user\.js$/.exec(url.pathname);
      // The page form may carry trailing sections (`/issues`), which
      // name the same script.
      const page = /^\/scripts\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
      const m = code ?? page;
      if (!m) return null;
      return {
        url: `https://openuserjs.org/scripts/${m[1]}/${m[2]}`,
        key: `openuserjs.org:${m[1]}/${m[2]}`,
      };
    },
  },
  {
    // https://gist.githubusercontent.com/user/<id>/raw/<sha>/file.user.js
    // https://gist.github.com/user/<id>                        (page)
    //   → https://gist.github.com/user/<id>
    // The gist id is unique on its own, and the user segment's case
    // can differ between spellings, so only the id goes in the key.
    siteName: 'GitHub Gist',
    hosts: ['gist.githubusercontent.com', 'gist.github.com'],
    page: (url) => {
      const m = /^\/([^/]+)\/([0-9a-fA-F]+)(?:\/raw(?:\/|$)|\/?$)/.exec(url.pathname);
      if (!m) return null;
      return {
        url: `https://gist.github.com/${m[1]}/${m[2]}`,
        key: `gist.github.com:${m[2].toLowerCase()}`,
      };
    },
  },
];

// The publishing site's page for a script URL, or null when the URL
// isn't from a site we know how to rewrite — the common case (a local
// file, a plain web server, a GitHub blob).
export function scriptSitePage(scriptUrl: string): ScriptSitePage | null {
  let url: URL;
  try {
    url = new URL(scriptUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  for (const rule of SITE_RULES) {
    if (!rule.hosts.includes(host)) continue;
    const page = rule.page(url);
    return page ? { siteName: rule.siteName, url: page.url, key: page.key } : null;
  }
  return null;
}

export interface SitePageRow {
  label: string;
  url: string;
}

// The details panel's whole decision about the hosting-site row, kept
// here (rather than in the DOM builder) so the interesting part is
// unit testable: which label, which URL, and when NOT to show a row.
//
// No row when it would only repeat something already on screen: the
// script's own `@homepage` names the same script (the Homepage row
// above already links it), or the Location row is itself the page URL
// (possible when a script was installed from a page-shaped URL).
export function sitePageRow(
  locationUrl: string,
  declaredHomepage: string | undefined,
): SitePageRow | null {
  const site = scriptSitePage(locationUrl);
  if (!site) return null;
  if (samePageUrl(site.url, locationUrl)) return null;
  if (declaredHomepage && scriptSitePage(declaredHomepage)?.key === site.key) return null;
  return { label: `${site.siteName} page`, url: site.url };
}

// True when two URLs point at the same page: a literal comparison
// modulo trailing slash, host case, and fragment. Only used for the
// location-is-already-the-page check — for "same script?" across
// spellings, compare `ScriptSitePage.key` instead.
function samePageUrl(a: string, b: string): boolean {
  const norm = (s: string): string | null => {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {
      return null;
    }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}
