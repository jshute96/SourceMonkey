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
// Why we encode `#`: the log label may carry a `#N` dedup suffix
// (`bar.user.js#2`) when multiple scripts share a basename. A bare
// `#` in a URL is the fragment separator, so URL parsers (including
// devtools') would split there and put everything after the `#` in
// the fragment. We percent-encode `#` to `%23` to keep the folder
// name intact; devtools displays the encoded form, which a reader
// can decode mentally (or we can swap encoding if it ever becomes
// painful).

const ROOT = 'sourcemonkey://SourceMonkey';

// Folder name for a script's artifacts. Strips the conventional
// `.user.js` extension from the log label (the folder sits ABOVE the
// main-body file, so the `.js` looks misleading on a folder), and
// percent-encodes the `#N` dedup suffix.
//
// Examples:
//   `foo.user.js`       → `foo`
//   `foo.user.js#2`     → `foo%232`
//   `foo`               → `foo`      (no .user.js to strip)
function folderForLabel(label: string): string {
  return label.replace(/\.user\.js(?=$|#)/, '').replace(/#/g, '%23');
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
  return label.replace(/\.user\.js(?=$|#)/, '').replace(/#\d+$/, '') + '.user.js';
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
// query strings would land at the same synthetic URL — stack-trace
// attribution would point at whichever require tab the viewer
// matched first. Rare in practice; the file-loader already dedups
// by canonical URL with query, so it'd take two legitimately
// different `@require` lines pointing at distinct stored copies.
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
