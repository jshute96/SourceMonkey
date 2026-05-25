// Pure helpers for the userscript viewer's link rendering. Kept
// DOM-free so the URL-detection + tag-classification rules can be
// unit tested in Node without a Prism-shaped DOM.
//
// Two consumers in src/userscript.ts:
//   - The Details panel renderer (Match / Location / etc.).
//   - The post-Prism walk over the highlighted code box.
// Both call the same classifiers so a header line in the body is
// linkified by the same rules as the corresponding details row.

// Tags whose value is a single resource reference. The body-linkifier
// passes the value through file-loader's `resolveScriptResource`,
// which both linkifies absolute http(s) URLs and resolves relative
// paths against the script's parent directory (the same rule the
// `@icon` favicon path uses). Anything the resolver rejects falls
// back to plain text.
//
// `@resource` is *not* in this set even though its second token is a
// URL — its grammar is two args (`<name> <url>`), so it gets its own
// carve-out in `linkForHeaderTag` (src/userscript.ts) that linkifies
// only the URL portion. Treating it here would mis-resolve
// `myCSS https://example.com/x.css` as a single relative path
// `<parent>/myCSS%20https://...`.
export const RESOLVABLE_HEADER_TAGS: ReadonlySet<string> = new Set([
  'icon', 'iconurl', 'defaulticon', 'icon64', 'icon64url',
  'require',
  'updateurl', 'downloadurl',
  'homepage', 'homepageurl', 'website', 'source',
  'supporturl',
]);

// Tags whose value is shaped like a Chrome `@match` pattern. Formally
// `@include` and `@exclude` are free-form globs over the whole URL
// (or `/regex/` literals), but in practice almost every excluded /
// included pattern is written as a match pattern, and giving the
// user a click target is more useful than rendering plain text.
// `matchTargetInfo` returns null for shapes it can't dewildcard
// (regex literals, `<all_urls>`, host wildcards) and those still
// fall back to plain text.
export const MATCH_HEADER_TAGS: ReadonlySet<string> = new Set([
  'match', 'exclude', 'include',
]);

// Tokenize a chunk of text into alternating literal and URL runs.
// Recognises http(s) and file:// URLs. Trailing punctuation commonly
// adjacent to URLs in prose (`.,;:!?)]`) is stripped off the URL run
// and pushed back as a literal so "see https://example.com." doesn't
// pull the period into the link.
export interface TextRun {
  kind: 'text' | 'url';
  value: string;
}

// Word-boundary anchor keeps `https://…` inside a longer identifier
// (rare but possible inside a string literal) from being picked up
// mid-token. The character class excludes whitespace, quotes, angle
// brackets, and backticks so a URL inside `"…"` or `<…>` stops at
// the delimiter. `*` is also excluded so a `@match` / `@exclude`
// pattern like `https://example.com/athletic/*` yields a clickable
// `https://example.com/athletic/` followed by a literal `*` — `*` is
// technically a legal URL character but in userscript headers it's
// always a glob wildcard, and including it in the href produces a
// link that doesn't navigate anywhere useful.
const URL_RE = /\b(?:https?|file):\/\/[^\s'"<>`*]+/g;
// Trailing punctuation that's commonly adjacent to URLs in prose.
// `)` and `]` are conditional (see peelTrailingPunctuation) so a
// URL with balanced brackets like `…/Foo_(disambig)` keeps them.
const ALWAYS_PEEL_RE = /[.,;:!?]+$/;

export function splitTextByUrls(text: string): TextRun[] {
  const out: TextRun[] = [];
  let cursor = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > cursor) {
      out.push({ kind: 'text', value: text.slice(cursor, start) });
    }
    const { url, trailing } = peelTrailingPunctuation(m[0]);
    out.push({ kind: 'url', value: url });
    if (trailing) out.push({ kind: 'text', value: trailing });
    cursor = start + m[0].length;
  }
  if (cursor < text.length) {
    out.push({ kind: 'text', value: text.slice(cursor) });
  }
  return out;
}

// Peel trailing prose punctuation off a candidate URL. Closing
// brackets `)` and `]` only peel when the URL has no matching open
// bracket — so `(https://example.com/x)` peels the `)` (likely
// surrounding parens in prose) but `https://en.wikipedia.org/wiki/Foo_(disambig)`
// keeps it (URL contains its own `(`). Always-peelable chars
// (`.,;:!?`) come off first.
function peelTrailingPunctuation(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';
  // Always-peelable run first; close-brackets one-at-a-time after,
  // since a single URL might end in `…)?` and we want both gone.
  let progressed = true;
  while (progressed) {
    progressed = false;
    const m = ALWAYS_PEEL_RE.exec(url);
    if (m) {
      trailing = m[0] + trailing;
      url = url.slice(0, url.length - m[0].length);
      progressed = true;
    }
    const last = url.charAt(url.length - 1);
    if ((last === ')' && !url.includes('(')) ||
        (last === ']' && !url.includes('['))) {
      trailing = last + trailing;
      url = url.slice(0, url.length - 1);
      progressed = true;
    }
  }
  return { url, trailing };
}

// Parse a `// @tag[:locale] value` comment line into the segments
// the body-linkifier needs to rebuild the line with the value
// replaced by a link node. Returns null for markers
// (`// ==UserScript==`), bare flag tags with no value, and any
// non-comment line.
export interface ParsedTagLine {
  before: string;   // start of line through the gap after the tag (e.g. "// @match     ")
  tag: string;      // lowercased canonical tag, no locale (e.g. "match")
  locale?: string;  // locale suffix when present (e.g. "de" for @name:de)
  value: string;    // raw value text, no trailing whitespace
  after: string;    // trailing whitespace
}

// Trailing-whitespace class includes `\r` so a CRLF-encoded line
// that reaches us with a stray `\r` at the end still matches. The
// rest of the SourceMonkey pipeline appears LF-normalised but the
// regex stays cheap, and the `\r` fallback keeps `parseTagLine`
// robust against any future input that bypasses normalisation.
const TAG_LINE_RE = /^([ \t]*\/\/[ \t]*@([A-Za-z][\w-]*)(?::([\w-]+))?[ \t]+)(\S.*?)([ \t\r]*)$/;

export function parseTagLine(line: string): ParsedTagLine | null {
  const m = TAG_LINE_RE.exec(line);
  if (!m) return null;
  const [, before, tag, locale, value, after] = m;
  const out: ParsedTagLine = {
    before,
    tag: tag.toLowerCase(),
    value,
    after,
  };
  if (locale) out.locale = locale;
  return out;
}

// Split an `@resource <name> <url>` value into its component spans.
// The pieces concatenate back to the original value exactly, so the
// body-linkifier can wrap just the URL substring in an anchor and
// rebuild the line without losing any whitespace.
//
// Shape: `{ prefix, url, suffix }` where prefix is "<name>" plus the
// whitespace gap after it, url is the second whitespace-separated
// token, and suffix is anything past the URL (typically empty; kept
// for round-trip safety in case a future TM extension grows trailing
// args, or someone added a stray comment).
//
// Returns null when the value doesn't have at least two
// whitespace-separated tokens.
export interface ResourceValueParts {
  prefix: string;
  url: string;
  suffix: string;
}

export function splitResourceValue(value: string): ResourceValueParts | null {
  const gap = value.search(/[ \t]/);
  if (gap < 0) return null;
  const afterGap = value.slice(gap);
  const gapLen = afterGap.match(/^[ \t]+/)![0].length;
  const urlStart = gap + gapLen;
  const rest = value.slice(urlStart);
  const trail = rest.search(/[ \t]/);
  const urlEnd = trail < 0 ? value.length : urlStart + trail;
  const url = value.slice(urlStart, urlEnd);
  if (!url) return null;
  return {
    prefix: value.slice(0, urlStart),
    url,
    suffix: value.slice(urlEnd),
  };
}

// Build a click-through URL for one `@connect` value. The
// body-linkifier wraps the verbatim value text in an anchor pointing
// here; the anchor's `href` is normalised via the URL parser so the
// click goes somewhere navigable even when the header value was just
// a bare host.
//
// Rules:
//   - `*` and `self` → null (no single site to point at).
//   - `<scheme>://…` → verbatim URL (only http/https accepted).
//   - `*.example.com` → `https://example.com/` (dewildcarded apex,
//     matching the same rule `matchTargetInfo` applies for @match
//     subdomain wildcards).
//   - bare host (`example.com`, `localhost`, `1.2.3.4`) →
//     `https://<host>/`.
//   - Anything that doesn't parse as a URL after that → null.
//
// HTTPS is the assumed default for bare hosts even though the
// userscript may issue HTTP requests via GM_xmlhttpRequest — the
// click-through is just "visit this site to look it up", and
// HTTPS is the right default for that.
export function connectLinkUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || t === '*') return null;
  if (t.toLowerCase() === 'self') return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return u.toString();
      }
      return null;
    } catch {
      return null;
    }
  }
  let host = t;
  if (host.startsWith('*.')) host = host.slice(2);
  if (!host || host.includes('*')) return null;
  try {
    return new URL(`https://${host}/`).toString();
  } catch {
    return null;
  }
}

// Sentinel line shapes that bracket the metadata block. Used by the
// body-linkifier to flip its "inside header" state.
const HEADER_OPEN_RE = /^[ \t]*\/\/[ \t]*==UserScript==[ \t]*$/;
const HEADER_CLOSE_RE = /^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*$/;
export function isHeaderOpenLine(line: string): boolean {
  return HEADER_OPEN_RE.test(line);
}
export function isHeaderCloseLine(line: string): boolean {
  return HEADER_CLOSE_RE.test(line);
}
