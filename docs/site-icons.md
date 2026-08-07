# Site icons

- Each row in the sources page (and the H1 of the script viewer)
  shows a small favicon next to the script filename.
- Source priority:
  - A script-declared `@icon` (or its TM aliases — see below) wins
    outright when set.
  - Otherwise the icon is discovered from the matched site itself.
- Implemented in [`src/site-icon.ts`](../src/site-icon.ts).

## Header override (`@icon`)

- Tag priority, smaller-resolution variants first:
  - `@icon` (cross-manager)
  - `@iconURL`, `@defaulticon` (TM aliases)
  - `@icon64URL`, `@icon64` (TM 64×64)
- Accepted reference forms (handled by [`src/file-loader.ts`](../src/file-loader.ts)):
  - Absolute `http(s)://` URL.
  - `data:` URL (rendered inline, no fetch).
  - Relative path — resolved against the script's parent directory.
    Works for both file:// and HTTP scripts: an HTTP script's
    `@icon foo.png` reaches `<script-dir>/foo.png` on the same origin.
- Absolute `file://` URLs are *not* accepted — the extension holds
  `file:///*` host permission, so allowing arbitrary file:// refs
  would let a malicious HTTP-sourced script read host files.
- Path-traversal is rejected: the resolved URL must still live at or
  under the script's parent dir. Caught textually via a post-resolution
  prefix check on the URL string, so `..`, `%2e%2e`, `..\`, and
  host-absolute `/` paths are all rejected uniformly.
- An absolute `http(s)` `@icon` can be served from a **local file**
  beside the script — same rule `@require` / `@resource` use, so a
  script keeps its portable URL while an icon on disk stands in during
  development. See
  [local-file-overrides.md](local-file-overrides.md#icon-caching) for
  the rule, the safety gate, and why the local candidate bypasses the
  storage cache below.
- `data:` URLs are length-capped to the same ~170 KB ceiling we apply
  to inline `<link rel="icon">` hrefs.
- An *empty* `data:` URL (`data:,`, or a `;base64,` with no payload)
  is treated as "no icon", not as an icon.
  - It's the standard "this site has no favicon, stop asking" marker
    — example.com's `<link rel=icon>` is literally `data:,`.
  - Painting it puts a blank broken `<img>` where the globe
    placeholder belongs.
  - `dataUrlHasPayload` is the single rule, applied everywhere an
    icon can enter or leave:
    - the two inline entry points — discovered
      `<link href="data:…">` and a script's own `@icon data:…`
      (`usableDataUrl`, which pairs it with the size cap);
    - the `<link>` candidate filter (see the scoring section);
    - the fetched-bytes path, so a zero-byte 200 is stored as
      "no icon" instead of an unpaintable data URL;
    - the cache read (see below).
- Fetched URLs (http(s) or file://) go through the same bounded-fetch
  + storage cache the origin-discovery path uses, keyed by the
  resolved URL itself so multiple scripts pointing at the same icon
  share one fetch.
- The click-through link is *always* the `@match`-derived `linkUrl`.
  `@icon` is purely a visual override — it doesn't change which site
  the favicon links to.

## How an origin and link URL are picked

Pure transforms over a `@match` pattern; live in
[`src/match-targets.ts`](../src/match-targets.ts) and are also
consumed by the userscript-viewer linkifier for
`@match`/`@exclude`/`@include` rows — see
[script-viewer.md](script-viewer.md#link-rendering). The icon module
picks the first `@match` whose pattern yields a usable origin via
`representativeMatch`; it then uses the same `linkUrl` for both
HTML icon discovery and the favicon click-through.

`@include` patterns are not consulted: they're free-form globs and
regexes over the whole URL, not URL templates, so the origin you'd
extract from `*://*/foo.html` would be misleading.

Worked examples:

| `@match`                              | Origin                  | Link URL                          |
|---------------------------------------|-------------------------|-----------------------------------|
| `https://example.com/*`               | `https://example.com`   | `https://example.com/`            |
| `https://example.com/app/*`           | `https://example.com`   | `https://example.com/app/`        |
| `https://example.com/posts/*/edit`    | `https://example.com`   | `https://example.com/posts/`      |
| `*://*.example.com/foo/bar*`          | `https://example.com`   | `https://example.com/foo/bar`     |
| `https://x.example/ol.php?type=p*`    | `https://x.example`     | `https://x.example/ol.php?type=p` |
| `https://example.com/a/b*c`           | `https://example.com`   | `https://example.com/a/`          |
| `http://localhost:8080/app/*`         | `http://localhost:8080` | `http://localhost:8080/app/`      |
| `*.example.com/*`                     | `https://example.com`   | `https://example.com/`            |
| `http://localhost:*/path`             | *(no usable target)*    | *(no usable target)*              |

The scheme-less row is not a special case here: the pattern is read
through `canonicalMatchPatterns` first, so a site named without a
scheme gets an icon like any other (see
[matching.md](matching.md#lenient-readings-canonicalmatchpatterns)).
A host slot that isn't a host we could navigate to yields no target.

## Fetch + cache

- `ensureSiteIcon(origin, pageUrl)` is called from each row's render
  path. `pageUrl` (e.g. `https://connect.garmin.com/app/home`) comes
  from `representativeMatch` and points at a page closer to what the
  script actually targets — many sites only ship the proper
  `<link rel="icon">` on authed/deep pages and serve a barebones SSO
  stub at `/`.

### Two-tier lookup

The lookup is split so deep-targeted scripts (one userscript per
section of a big site) each get their own icon instead of all sharing
the first one discovered for the host.

- **Path-scoped layer** (`pathIcon:<pageUrl>`): when the page URL is
  deeper than `<origin>/`, try HTML discovery there first. Positive
  hits are returned immediately; a null result (no usable icon on
  that page) falls through to the origin layer instead of refetching.
- **Origin fallback** (`siteIcon:<origin>`): shared across every
  script on the host. Runs origin-root HTML → `/favicon.ico` →
  Google S2 in order and caches whichever wins.
- When the page URL is already the origin root the path layer is
  skipped — it would just duplicate the origin-root HTML fetch.

### Discovery strategies

- **HTML discovery (page URL or origin root)**: fetch the page,
  scan the `<head>` for `<link rel="icon">` (also `shortcut icon`,
  `apple-touch-icon`). The fetch follows redirects, so even when the
  server bounces us to an SSO host we still get that page's icon
  tag. Relative hrefs resolve against the final post-redirect URL.
  The best candidate is selected by [pickBestIconCandidate](#scoring-link-rel-icon-candidates).
  A non-empty `data:` URL declared inline is used verbatim.
- **`/favicon.ico` fallback**: conventional path. Origin-layer only.
- **Google S2 fallback**:
  `https://www.google.com/s2/favicons?domain=<host>&sz=64`. The only
  leg that touches a third party — the host name (already public via
  the `@match`) is sent to www.google.com. Reached only when every
  direct strategy has failed. Google returns a generic globe for
  hosts it can't resolve; we cache that as "better than nothing."
  Origin-layer only.

### Bounds and freshness

- Every fetch is bounded:
  - 5s timeout, follows redirects.
  - Allowed by the extension's `<all_urls>` host permission.
  - HTML body capped at 1MB; icon body at 128KB.
  - `referrerPolicy: 'no-referrer'` to avoid leaking the
    `chrome-extension://<id>/...` URL to third-party hosts.
- On any failure (network error, non-icon `Content-Type`, oversized
  body) the layer caches a `null` entry so the same broken page or
  host doesn't get hammered on every render.
- Successful entries are cached for 7 days; `null` entries for 24h.
  After that the next render triggers a refetch — so sites that swap
  their favicon, or hosts that briefly fell back to Google's globe
  placeholder, self-heal without the user clearing storage.
- A row is only a cache *hit* if it is fresh **and** holds something
  we would paint (`usableCacheHit`). Anything other than a
  payload-bearing `data:` URL counts as a miss, so it is hidden
  immediately and the refetch overwrites it.
  - The check exists because rows written before the empty-`data:`
    rule existed stored example.com's `data:,` as though it were an
    icon, and only the 7-day TTL would ever have cleared them.
  - It defaults *closed*: the point is distrusting rows written by
    other builds, so an unrecognized shape is refetched rather than
    painted.
  - A stored `null` is a real answer — "we looked, there is none" —
    and still suppresses refetches for its own TTL.
  - Everything the fetch path stores already satisfies the rule, so a
    miss always converges after one refetch.
- An in-flight `Map` de-dups concurrent fetches per cache key —
  multiple rows targeting the same page URL or origin share one
  network round trip.

### Scoring `<link rel="icon">` candidates

`pickBestIconCandidate` rewards:

- `rel="icon"` / `shortcut icon` over `apple-touch-icon` (Apple
  touch icons are commonly 180px and padded with background colour);
- `mask-icon` is dropped entirely — it's a monochrome Safari
  pinned-tab SVG mask and renders as a black silhouette in `<img>`;
- an empty `data:` href is dropped too, before scoring — it is the
  page saying it has *no* icon, and since `rel="icon"` outscores
  `apple-touch-icon` it would otherwise beat a real icon on the same
  page;
- file types we know render: PNG > SVG > ICO > JPEG/WebP;
- `sizes` near the 32px target (i.e. 16×16 @ 2x dpi) over both
  smaller and much larger entries; `sizes="any"` (vector) wins.

## Storage shape

Parallel cache rows for the icon-source paths, sharing the same
`{ dataUrl, fetchedAt }` shape and TTLs:

- `pathIcon:<pageUrl>` — HTML-discovery result for a specific
  deep page. Key is the full page URL; lets two scripts on the
  same host but different sections keep distinct icons. A null entry
  here means "no icon on this page" — the lookup falls through to
  the origin row.
- `siteIcon:<origin>` — origin-level fallback favicons (root HTML
  + `/favicon.ico` + Google S2). Key is the full `scheme://host`
  string; every script on that host shares the row.
- `iconUrl:<url>` — `@icon`-declared icons. Key is the literal header
  URL; scripts pinning the same icon share one fetch.
- A local stand-in is NOT written here — it's memoized for the life of
  the page instead, so a newly created icon file isn't hidden behind a
  24-hour cached miss. See
  [local-file-overrides.md](local-file-overrides.md#icon-caching).
- `data:` URLs render inline and are never stored.

Rows are not garbage-collected when the last script referencing them
is removed — favicon entries are tiny and removing the row would
just trigger a fresh fetch if the user re-adds the source.

## Display

- A 16×16 `<span class="site-icon">` slot sits before the filename
  link in each row. The viewer page mirrors the same slot inside its
  `<h1>`.
- `renderSiteIconInto` paints the slot synchronously:
  - When the script has a representative origin, the slot contains an `<a class="site-icon-inner" target="_blank">` pointing at `linkUrl`.
  - Otherwise it contains an inert `<span class="site-icon-inner">` — file:// scripts, `<all_urls>`, host-of-`*`, etc.
- The inner element always starts with a muted globe placeholder so
  users see *something* immediately and rows missing an origin still
  show a consistent placeholder.
- The async swap picks its source by header priority: if the script
  declares an `@icon`, `ensureIconForUrl` runs; otherwise
  `ensureSiteIcon` runs the origin-discovery pipeline. The resolved
  icon is wrapped in an `<img>` that replaces the globe inside
  the inner element. No `isConnected` guard — orphan paints from
  re-renders are cheap and unobservable.

### Keeping the rendered page small

A big site can have dozens of scripts, and naive rendering inlined a
full copy of each favicon — and the globe SVG — into *every* row,
pushing the live sources-page DOM past half a megabyte (mostly
duplicated bytes). Two measures keep it bounded:

- **Shared globe glyph.** The globe is defined once per page as an SVG
  `<symbol id="sm-globe">` (in `sources.html` / `userscript.html`);
  each slot renders a tiny `<svg class="site-icon-globe"><use
  href="#sm-globe">`. Stroke/fill styling lives in CSS on
  `.site-icon-globe` so it still inherits `currentColor`.
- **Deduped blob: URLs for large icons.** `iconImgSrc` converts a
  cached icon `data:` URL above `ICON_INLINE_MAX_LEN` (512 chars) into
  a `blob:` URL once — via `dataUrlToBlob` + `URL.createObjectURL` —
  and caches it in a per-page `Map` keyed by the data URL. Every row
  using that icon then shares the same ~55-char `blob:` handle instead
  of inlining the base64. Small icons stay inline (a blob doesn't beat
  them). The blob set is bounded by the number of *distinct* icons on
  the page and lives for the document's lifetime (never revoked) —
  matching the `GM_getResourceURL` policy and staying bfcache-safe.
  Storage is unaffected: icons are still cached as base64 `data:` URLs
  (one row per origin/URL); the blob is minted fresh at render time.

Viewer/sources cross-links are page-relative (`userscript.html?...`,
`sources.html#...`) rather than absolute `chrome.runtime.getURL(...)`,
so the `chrome-extension://<id>/` prefix isn't repeated twice per row.
