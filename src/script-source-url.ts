// Canonical `sourcemonkey://SourceMonkey/...` URLs the injector
// emits as `//# sourceURL=` directives, and that the viewer matches
// stack-trace refs against.
//
// Why this URL shape:
//
// - The `sourcemonkey:` scheme is arbitrary — it just has to be
//   URL-shaped, unique to us (the wrapper's async-error filter
//   greps stack frames for it), and recognizable in stack traces.
// - The literal `SourceMonkey` host puts everything we register
//   under a single top folder in devtools' Sources tree. Devtools
//   strips the scheme and uses the URL's authority as the first
//   visible folder; without the host slot, our scripts would
//   scatter at the top level.
// - The next folder is the script's human-readable log label
//   (`bar`, `bar%232`, etc.) — see `script-log-id.ts`. We use the
//   log label rather than the script's UUID because the UUID is a
//   debug-grade hash that's useless when you're scanning the tree.
//   Per-script artifacts (`__config.js`, the main body, each
//   `@require`) live under that folder so they cluster together
//   by script.
// - Page-wide URLs (`__bridge.js`, `__gm-runtime.js`, `__prelude.js`)
//   live directly under `SourceMonkey/`. The bridge and GM runtime
//   are true singletons (one chrome.userScripts registration each);
//   the prelude is inlined per-script but every inclusion uses the
//   same `__prelude.js` URL so devtools' Sources tree dedups them
//   into a single visible entry.
//
// Why we percent-encode the label: it is a *display* string
// (`script-log-id.ts` decodes URL-derived filenames so the user sees
// `My Script.user.js`), and several of the characters that survive
// that decode would break a URL. A bare `#` is the fragment
// separator, so the `#N` dedup suffix would split the path; a space
// or a paren ends the URL run that `stack-link.ts` matches, so a
// stack-trace ref would stop linkifying to its tab. Everything
// outside an unreserved-character whitelist is re-encoded — devtools
// shows the encoded form, same as it always has.

const ROOT = 'sourcemonkey://SourceMonkey';

// Strip characters that would break out of the `//# sourceURL=<url>`
// comment these URLs are spliced into. The log label is derived from
// the on-disk filename (`script-log-id.ts`), which is attacker-
// controlled for an untrusted script bundle. A JS line terminator
// (LF/CR/U+2028/U+2029) ends the single-line `//` comment, so anything
// after it on the line would become live code in the config blob —
// which runs at document_start, before the script's own gating. Other
// control chars can't break the comment but have no business in a
// devtools tree path either; replace the lot with `_`. (The @require
// URL builder already does per-segment whitelisting; this covers the
// main/config/prelude labels that don't go through it.)
function sanitizeLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  return label.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '_');
}

// Percent-encode everything outside the URL unreserved set, so the
// segment is safe in a path AND carries nothing that would terminate
// the stack-trace ref pattern in `stack-link.ts`. Applied last, after
// the `.user.js` / `#N` surgery below has matched against the literal
// characters.
// The `u` flag matters: without it the character class matches single
// UTF-16 code units, so an emoji (surrogate pair — GreasyFork names
// are full of them) would be handed to encodeURIComponent half at a
// time and throw URIError on the lone surrogate.
function encodeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._~-]/gu, (c) => {
    let enc: string;
    try {
      enc = encodeURIComponent(c);
    } catch {
      // An UNPAIRED surrogate — `u` makes the class match it as a
      // single code point, but there's no UTF-8 encoding for it and
      // encodeURIComponent throws. A manifest entry is user-authored
      // JSON, so `"\ud800.user.js"` really can reach us. Letting the
      // throw escape would reject the whole `Promise.all` in
      // collectActiveSpecs and register NOTHING.
      return '_';
    }
    // encodeURIComponent passes `!'()*` through untouched, and parens
    // are exactly what would truncate a `at fn (URL:L:C)` frame — so
    // hex-encode anything it declined to. All such characters are
    // single-byte ASCII.
    return enc === c ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : enc;
  });
}

// Folder name for a script's artifacts. Strips the conventional
// `.user.js` extension from the log label (the folder sits ABOVE the
// main-body file, so the `.js` looks misleading on a folder), then
// encodes what's left — which is where the `#N` dedup suffix becomes
// `%23N`.
//
// Examples:
//   `foo.user.js`       → `foo`
//   `foo.user.js#2`     → `foo%232`
//   `My foo.user.js`    → `My%20foo`
//   `foo`               → `foo`      (no .user.js to strip)
function folderForLabel(label: string): string {
  return encodeSegment(sanitizeLabel(label).replace(/\.user\.js(?=$|#)/, ''));
}

// Main-body file basename for a script. Same as the folder but with
// the dedup suffix dropped and `.user.js` restored — so the file's
// name reflects the script's natural filename without the
// disambiguator (each script lives in a different folder anyway).
//
// Examples:
//   `foo.user.js`       → `foo.user.js`
//   `foo.user.js#2`     → `foo.user.js`
//   `foo`               → `foo.user.js`
function mainBaseForLabel(label: string): string {
  // Dedup suffix first, extension second. The other order would eat a
  // `#2` that's part of the name itself (`Chapter #2.user.js`) — which
  // a decoded `%23` now makes reachable.
  const base = sanitizeLabel(label).replace(/#\d+$/, '').replace(/\.user\.js$/, '');
  return encodeSegment(base) + '.user.js';
}

// Per-script folder root.
function scriptRoot(logLabel: string): string {
  return `${ROOT}/${folderForLabel(logLabel)}`;
}

// Canonical URL for the main script body.
export function buildSourceUrl(logLabel: string): string {
  return `${scriptRoot(logLabel)}/${mainBaseForLabel(logLabel)}`;
}

// Canonical URL for the per-script config blob — the tiny {code}
// entry the injector emits as the first js[] entry.
export function buildConfigSourceUrl(logLabel: string): string {
  return `${scriptRoot(logLabel)}/__config.js`;
}

// Canonical URL for the per-script parse-failure sentinel — the last
// js[] entry. Distinct from the config blob's URL on purpose: devtools
// dedups Sources-tree nodes by URL, which is safe for the prelude only
// because every copy of it is byte-identical. The sentinel and the
// config blob are different code, so sharing a URL would show one node
// whose text matches just one of them.
export function buildSealSourceUrl(logLabel: string): string {
  return `${scriptRoot(logLabel)}/__seal.js`;
}

// Canonical URL for the prelude. Bytes (WRAPPER_PRELUDE) are
// byte-identical for every script, so every per-script inclusion
// tags itself with this same URL — devtools' Sources tree groups
// the N inclusions into a single visible entry alongside the
// bridge / GM runtime at the SourceMonkey/ top level. See
// wrapPreludeEntry in injector.ts.
export const PRELUDE_SOURCE_URL = `${ROOT}/__prelude.js`;

// Canonical URL for the page-wide MAIN-world bridge.
export const BRIDGE_SOURCE_URL = `${ROOT}/__bridge.js`;

// Canonical URL for the page-wide GM_* runtime.
export const GM_RUNTIME_SOURCE_URL = `${ROOT}/__gm-runtime.js`;

// Canonical URL for one of a script's `@require` entries. We map
// the require's real fetch URL into our synthetic scheme so:
//   - the entry clusters with its owning script in devtools, and
//   - stack frames are honest about the fact that we stored a
//     snapshot of the bytes (we're not re-fetching at run time).
//
// Shape: `sourcemonkey://SourceMonkey/<folder>/<host>/<path>` — the
// original URL's host + path become subfolders so the user can still
// see the provenance in the Sources tree. Query strings and fragments
// are dropped (the cached bytes don't depend on them). Two requires
// on the same script with the same host+path but different `?…`
// query strings would land at the same synthetic URL. The viewer's
// tab lookup takes the FIRST match, so a mapped stack frame from the
// second require opens the first require's tab — the source map picks
// the right segment, only the tab lookup is ambiguous. Rare in
// practice; the file-loader already dedups by canonical URL with
// query, so it'd take two legitimately different `@require` lines
// pointing at distinct stored copies. Worth revisiting if it ever
// shows up: including a hash of the query in the path would fix it at
// the cost of an uglier devtools tree.
//
// `file://` requires (resolved local files) use the synthetic host
// `file` so they land under `<folder>/file/<path>` rather than
// dropping out of the tree.
//
// On a URL we can't parse (shouldn't happen — the file-loader
// validates before storage) we fall back to `<folder>/require` so we
// still emit *something* parseable.
export function buildRequireSourceUrl(logLabel: string, requireUrl: string): string {
  let host: string;
  let path: string;
  try {
    const u = new URL(requireUrl);
    host = u.protocol === 'file:' ? 'file' : u.hostname;
    if (!host) host = u.protocol.replace(/:$/, '');
    path = u.pathname.replace(/^\/+/, '');
  } catch {
    return `${scriptRoot(logLabel)}/require`;
  }
  // Sanitize each path segment. `new URL()` above already normalized
  // `a/../b` to `b`, so the `..` / `.` filter is belt-and-suspenders
  // — kept in case the input ever reaches us by a path that bypasses
  // URL parsing (it doesn't today). The real work here is the
  // per-segment character whitelist, which keeps spaces / special
  // chars from confusing the devtools tree.
  const cleanPath = path
    .split('/')
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  const safeHost = host.replace(/[^a-zA-Z0-9._-]/g, '_') || 'require';
  return cleanPath
    ? `${scriptRoot(logLabel)}/${safeHost}/${cleanPath}`
    : `${scriptRoot(logLabel)}/${safeHost}/require`;
}
