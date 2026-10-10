# Site icons

- Each row in the collections page (and the H1 of the script viewer)
  shows a small favicon per site the script targets, next to the
  script name.
- Collection priority:
  - A script-declared `@icon` (or its TM aliases — see below) wins
    outright when set, and collapses the slot to that one icon.
  - Otherwise one icon per distinct site is discovered from the
    matched sites themselves (see [Multiple sites](#multiple-sites)).
- Implemented in [`src/extension/site-icon.ts`](../src/extension/site-icon.ts).

## Debug page

- `/debug/icons.html` ([`src/debug/icons.html`](../src/debug/icons.html) +
  [`src/extension/debug/icons.ts`](../src/extension/debug/icons.ts)) inspects and manages cached
  icons in `chrome.storage.local`.
- Displays a table of all cached rows (`siteIcon:*`, `pathIcon:*`, and
  `iconUrl:*`) with icon preview, target site/URL, scope chip,
  MIME/byte-size details, schema version, freshness status, and
  fetched/expiry timestamps.
- The status badge reads `ok`, `miss` (cached "no icon"), `expired`,
  `stale schema` (written under an older discovery version — its tooltip
  names the row's version and the current one), or `unpaintable`
  (a value `usableCacheHit` would refuse). All but `ok` / `miss` read as
  misses, so the next render that needs the row refetches it.
- Supports per-row **Refresh** and **Delete** buttons, plus a **Delete All**
  action in the header bar.

## Header override (`@icon`)

- Tag priority, smaller-resolution variants first:
  - `@icon` (cross-manager)
  - `@iconURL`, `@defaulticon` (TM aliases)
  - `@icon64URL`, `@icon64` (TM 64×64)
- Accepted reference forms (handled by [`src/file-loader.ts`](../src/file-loader.ts)):
  - Absolute `http(s)://` URL.
  - `data:` URL (rendered inline, no fetch).
  - Relative path — resolved against the script's own URL. Works for
    both file:// and HTTP scripts: an HTTP script's `@icon foo.png`
    reaches `<script-dir>/foo.png` on the same origin.
- Absolute `file://` URLs are *not* accepted — the extension holds
  `file:///*` host permission, so allowing arbitrary file:// refs
  would let a malicious HTTP-sourced script read host files.
- Path-traversal is rejected **for a local script**: from a `file://`
  script the resolved URL must still live at or under the script's
  parent dir. Caught via a post-resolution prefix check on the URL
  string, so `..`, `%2e%2e`, `..\`, and host-absolute `/` paths are all
  rejected uniformly. An HTTP script's icon may climb — it could name
  any absolute URL anyway.
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
- The icon rules (tags, the 128 KB limit, `image/*` only) live in
  [`src/script-icon.ts`](../src/script-icon.ts), shared with the
  load-time check below.

### Load-time check

A slot whose `@icon` can't be shown just keeps its globe, so the reason
is reported when the script loads instead (`checkScriptIcon` in
[`src/external-files.ts`](../src/external-files.ts)).

- Checks the icon resolves, downloads, is an image, and is within
  the limit.
- A problem is a load-time warning on the `@icon` line, e.g.
  `@icon big.png: The file is larger than the 128 KB limit`.
  - It goes in the Log tab and is printed by `sm-dev validate`, like
    the other load-time notes.
  - Like them, it also gives the script a WARNING status once it runs,
    and a console line on each page it runs on.
  - It never makes the script invalid, and an invalid script isn't
    checked.
- Downloaded on the same terms as `@require`, never when the script
  runs:
  - An explicit Refresh looks again.
  - A background refresh keeps the stored answer (`iconCheck` on the
    script row) unless the `@icon` line or the URL it resolves to
    changed.
  - Except a failure that may pass on its own (no response, a
    timeout), which the next refresh looks at again.
  - A local stand-in is re-read every pass, like a `@require`'s. One
    the page couldn't show (too large, not an image) is skipped for the
    declared URL, as the page skips it.
- Not checked:
  - an inline `data:` icon, which has nothing to download;
  - a script sm-dev pushes, which doesn't carry its icon file; sm-dev
    checks the icon on disk itself.

## Multiple sites

- A script whose `@match` set names several sites gets one icon per
  site, in header order, up to a cap. Sites past the cap are not shown.
  - Collections table: `MAX_SITE_ICONS` (`match-targets.ts`). Small —
    the slot sits in a column beside the name.
  - Viewer heading: `HEADING_SITE_ICONS` (`userscript.ts`). Higher —
    the heading has room, and it is the one place the whole target
    list is worth a glance.
- "Same site" means the same `host[:port]` after dropping a leading
  `www.`; the scheme is ignored. `http://www.example.com/*` and
  `https://example.com/*` are one icon (the first pattern's link).
  `localhost:3000` and `localhost:8080` are two.
- `representativeMatches(matching, limit)` returns that list;
  `representativeMatch` is just its first entry.
- Each icon is its own link to its site's `linkUrl` and runs its own
  discovery — so a script's second site shares cache rows with every
  other script on that site.

### Identical favicons collapse

- Different hosts can serve the same favicon (`maps.google.com` and
  `www.google.com`). Once every icon in a slot has loaded, icons whose
  resolved `data:` URL is byte-identical fold into the first one.
  - The survivor keeps its link; its tooltip lists every site it now
    stands for, one per line — the first 10, then `(and N more)`
    (`sitesTooltip`).
  - An `@icon`-declared icon is the script's, not a site's: its
    tooltip leads with the script's `@name`, then lists every site the
    script names, uncapped by the row's icon limit.
  - Globes collapse too: sites that all came up without an icon fold
    into one globe, with the same multi-line tooltip.
  - The globe then moves after the real favicons — unless it is the
    first site's, which keeps its place as the primary site.
  - Identity is the resolved bytes. Two hosts serving the same picture
    in different files (another size, another encoding) do not merge.
- Only the resolved bytes can tell — the hosts differ — so this
  happens after the fetches, not at first paint. `renderSiteIconInto`
  resolves with the final icon count for callers that care.
- Until then the slot shows only the first site's globe. Showing one
  per site would draw a row of identical globes that then collapses,
  shifting the layout; this way the slot only widens, once the icons
  turn out to differ.
- Icons already cached skip all of that. The collections page reads
  every cached icon its rows will need in one storage read
  (`preloadSiteIcons`) before drawing them.
  - A slot whose icons are all known is drawn finished: real icons,
    already merged, with no globe first and no change of width.
  - Answers are also remembered for the life of the page, so a repaint
    reuses them.
- **Fetching runs in the service worker**, which writes all storage
  ([worker-writes.md](worker-writes.md)). A page that misses its own
  read asks it (`ensureCachedIcon`): the worker answers from a row
  another page just fetched, else fetches and caches it.
  - At most six icon fetches run at once there; the rest wait.
  - Local stand-ins for `@icon` (local file overrides) are read by the
    page and never cached, so they stay in the page.

### Layout

- **Collections table**: icons sit side by side with a 2px gap. The
  slot is a fixed width per table — wide enough for the widest row in
  that collection — so all names in one collection start at the same
  x position. `collections.ts` sets `--icon-cols` on the `<table>`
  (`fitIconColumns`) and the stylesheet derives the slot width and the
  name cell's hanging indent from it.
  - Fitted from the slots on screen: first with one globe per slot,
    then again once the rebuilt slots' favicons have settled and
    identical ones collapsed — one shift per pass, not one per row.
  - Every live sync (a refresh that changed `@match`, a script that
    arrived or left) runs the same fit, so the column narrows as well
    as widens.
- **Viewer heading**: same, but the slot grows with the count
  (nothing to align against).

### Per-pattern icons in the viewer

- The viewer's `Match` / `Include` / `Exclude` rows lead every pattern
  with one icon (`renderPatternIconInto`): that pattern's site favicon
  via the same discovery + cache, or the globe when it names no site.
- No de-dup or collapse here — the row lists patterns, so each gets
  its own icon even when two share a site.
- Cost: opening the viewer probes one page per pattern (cache rows
  under `pathIcon:` / `siteIcon:` as usual), including the sites an
  `@exclude` names. A deliberate choice — the row is there to show
  which sites those are.

## How an origin and link URL are picked

Pure transforms over a `@match` pattern; live in
[`src/match-targets.ts`](../src/match-targets.ts) and are also
consumed by the userscript-viewer linkifier for
`@match`/`@exclude`/`@include` rows — see
[script-viewer.md](script-viewer.md#link-rendering). The icon module
takes the `@match` patterns that yield a usable origin via
`representativeMatches`, one per distinct site, and uses each site's
`linkUrl` for both HTML icon discovery and the favicon click-through.
The viewer's
[same-directory fallback](script-viewer.md#same-directory-fallback)
for site-less patterns is not used here — it points at a page beside
the script, which is not a site to take an icon from.

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
  path, once per site. `pageUrl` (e.g.
  `https://connect.garmin.com/app/home`) is that site's
  `representativeMatches` entry and points at a page closer to what
  the script actually targets — many sites only ship the proper
  `<link rel="icon">` on authed/deep pages and serve a barebones SSO
  stub at `/`.

### Two-tier lookup

The lookup is split so deep-targeted scripts (one userscript per
section of a big site) each get their own icon instead of all sharing
the first one discovered for the host.

- **Path-scoped layer** (`pathIcon:<pageUrl>`): when the page URL is
  deeper than `<origin>/`, try Chrome's `/_favicon/` DB and then HTML
  discovery there first. Positive hits are returned immediately; a null
  result (no usable icon on that page) falls through to the origin layer
  instead of refetching.
- **Origin fallback** (`siteIcon:<origin>`): shared across every
  script on the host. Runs Chrome's `/_favicon/` DB → origin-root HTML
  → `/favicon.ico` → Google S2 in order and caches whichever wins.
- When the page URL is already the origin root the path layer is
  skipped — it would just duplicate the origin-root lookup.

### Discovery strategies

- **Chrome `/_favicon/` database (`chrome-extension://<id>/_favicon/`)**:
  reads directly from Chrome's internal favicon database (populated
  when the user visits pages in real tabs — after SSO (single sign-on)
  authentication and after client-side JS updates `<link rel="icon">`).
  - Because `/_favicon/` returns `200 OK` with Chrome's default globe
    PNG on cache misses rather than 404ing, `fetchChromeFavicon` probes
    a known-miss sentinel URL once per context and treats any response
    matching those bytes as a miss (`null`).
  - Chrome falls back to the host's icon for an unvisited page URL by
    default. The path layer asks with `fallbackToHost=0` (`exactPage`)
    so it only reports page-specific hits; the origin layer keeps the
    fallback.
  - Not redirect-proof: Chrome maps an icon onto every URL of the
    redirect chain that led to it, so a tab that bounced to SSO without
    signing in leaves the SSO icon on the app URL, and the DB tier
    returns it. Only the 7-day TTL clears that (see TODO.md).
- **HTML discovery (page URL or origin root)**: fetch the page and
  scan the `<head>` for `<link rel="icon">` (also `shortcut icon`,
  `apple-touch-icon`).
  - **Cross-host redirects are rejected** (`isSameHostRedirect`): if the
    fetch bounces to a different host — `www.` aside, ports and
    subdomains included (e.g. an SSO portal like
    `login.corp.google.com` or `accounts.google.com`, or a marketing
    portal like `workspace.google.com`), the HTML's `<link rel="icon">`
    belongs to that other host and is discarded as `null`.
  - Same-host redirects (including scheme upgrades and `www.` differences)
    are allowed, and relative hrefs resolve against `finalUrl`.
  - The best candidate is selected by [pickBestIconCandidate](#scoring-link-rel-icon-candidates).
    A non-empty `data:` URL declared inline is used verbatim.
- **`/favicon.ico` fallback**: conventional path (`fetchIconAt` with
  `rejectCrossHostRedirect: true`). Origin-layer only.
- **Google S2 fallback**:
  `https://www.google.com/s2/favicons?domain=<host>&sz=64`. The only
  leg that touches a third party — the host name (already public via
  the `@match`) is sent to www.google.com. Reached only when every
  local and direct strategy has failed. Origin-layer only.

### Bounds and freshness

- Every network fetch is bounded:
  - 5s timeout, follows redirects.
  - Allowed by the extension's `<all_urls>` host permission.
  - HTML body capped at 1MB; icon body at 128KB.
  - `referrerPolicy: 'no-referrer'` to avoid leaking the
    `chrome-extension://<id>/...` URL to third-party hosts.
  - Made **by the service worker**, even though the caller is a page.
    A site's HTML routinely carries `Link: rel=preload; as=script`
    headers, and a document-initiated fetch acts on them — see
    [logging.md](logging.md#keeping-the-errors-panel-clean).
- On any failure (network error, cross-host redirect, non-icon
  `Content-Type`, oversized body) the layer caches a `null` entry so
  the same broken page or host doesn't get hammered on every render.
- Successful entries are cached for 7 days; `null` entries for 24h.
  After that the next render triggers a refetch — so sites that swap
  their favicon, or hosts that briefly fell back to Google's globe
  placeholder, self-heal without the user clearing storage.
- A row is only a cache *hit* if it is fresh, matches the current
  discovery schema version (`DISCOVERED_ICON_CACHE_VERSION` for
  `pathIcon:` / `siteIcon:`), **and** holds something we would paint
  (`usableCacheHit`). Anything other than a payload-bearing `data:` URL
  counts as a miss, so it is hidden immediately and the refetch
  overwrites it.
  - The check exists because rows written before the empty-`data:`
    rule or before cross-host redirect rejection stored invalid /
    redirected icons, and only the 7-day TTL would ever have cleared
    them.
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

Parallel cache rows for the icon-collection paths, sharing the same
`{ dataUrl, fetchedAt, v? }` shape and TTLs:

- `pathIcon:<pageUrl>` — discovery result (`/_favicon/` DB + HTML) for
  a specific deep page. Key is the full page URL; lets two scripts on
  the same host but different sections keep distinct icons. A null entry
  here means "no icon on this page" — the lookup falls through to
  the origin row.
- `siteIcon:<origin>` — origin-level fallback favicons (`/_favicon/` DB
  + root HTML + `/favicon.ico` + Google S2). Key is the full
  `scheme://host` string; every script on that host shares the row.
- `iconUrl:<url>` — `@icon`-declared icons. Key is the literal header
  URL; scripts pinning the same icon share one fetch.
- A local stand-in is NOT written here — it's memoized for the life of
  the page instead, so a newly created icon file isn't hidden behind a
  24-hour cached miss. See
  [local-file-overrides.md](local-file-overrides.md#icon-caching).
- `data:` URLs render inline and are never stored.

Rows are not garbage-collected when the last script referencing them
is removed — favicon entries are tiny and removing the row would
just trigger a fresh fetch if the user re-adds the collection.

## Display

- A `<span class="site-icon">` slot of 16×16 icons sits before the
  name link in each row. The viewer page mirrors the same slot inside
  its `<h1>`. Widths are in [Layout](#layout) above.
- `renderSiteIconInto` paints the slot synchronously:
  - One `<a class="site-icon-inner" target="_blank">` per distinct
    site, pointing at that site's `linkUrl`.
  - A script that declares an `@icon` gets a single `<a>` (first
    site's link) painted with that icon.
  - A script with no usable site gets one inert
    `<span class="site-icon-inner">` — file:// scripts, `<all_urls>`,
    host-of-`*`, etc.
- Every inner element starts with a muted globe placeholder so users
  see *something* immediately and rows missing an origin still show a
  consistent placeholder.
- The async swap picks its collection by header priority: if the script
  declares an `@icon`, `ensureIconForUrl` runs; otherwise
  `ensureSiteIcon` runs the origin-discovery pipeline once per icon.
  The resolved icon is wrapped in an `<img>` that replaces the globe
  inside its inner element. No `isConnected` guard — orphan paints
  from re-renders are cheap and unobservable. Only the final step that
  fills the slot with the merged icons checks it still owns the slot.

### Keeping the rendered page small

A big site can have dozens of scripts, and naive rendering inlined a
full copy of each favicon — and the globe SVG — into *every* row,
pushing the live collections-page DOM past half a megabyte (mostly
duplicated bytes). Two measures keep it bounded:

- **Shared globe glyph.** The globe is one `<symbol id="sm-globe">` in
  `src/glyph-sprite.svg`, which the build inlines once per page (see
  *Glyph sprite* in [architecture.md](architecture.md)); each slot
  renders a tiny `<svg class="site-icon-globe"><use href="#sm-globe">`.
  Stroke/fill styling lives in CSS on `.site-icon-globe` (styles.css,
  shared by every page with a slot) so it still inherits `currentColor`.
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

Viewer/collections cross-links are page-relative (`userscript.html?...`,
`collections.html#...`) rather than absolute `chrome.runtime.getURL(...)`,
so the `chrome-extension://<id>/` prefix isn't repeated twice per row.
