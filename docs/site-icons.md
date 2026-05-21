# Site icons

- Each row in the options page (and the H1 of the script viewer)
  shows a small favicon next to the script filename.
- The icon comes from the matched site itself, not from the
  userscript's own metadata.
- Implemented in [`src/site-icon.ts`](../src/site-icon.ts).

## How an origin is picked

- Iterate the script's `@match` list in order.
- For each pattern, parse it as `<scheme>://<host>/<path>`:
  - Scheme `*` is treated as `https`. `http` / `https` are taken
    verbatim. Other schemes (`file`, `ftp`) are skipped.
  - Host `*` is too broad and is skipped.
  - Host `*.example.com` collapses to `example.com`.
  - A trailing `:port` is stripped (favicons are origin-scoped in
    practice; default-port hits are the broadest).
- Return the first pattern that yields an `https://host` (or
  `http://host`) string. If none do, the script gets no icon.

`@include` patterns are not consulted: they're free-form globs and
regexes over the whole URL, not URL templates, so the origin you'd
extract from `*://*/foo.html` would be misleading.

## Probe and link URLs

`representativeMatch` returns a set of URLs derived from the first
usable `@match`:

- `origin` — cache key (`scheme://host`, no path).
- `probeUrl` — the page to fetch when discovering `<link rel="icon">`. Cut at the literal prefix of the `@match` path (just before the first `*`).
- `linkUrl` — where to navigate when the user clicks the favicon. Cut at the last complete path segment without a wildcard, so the click always lands on a valid directory.

| `@match`                              | Probe URL                       | Link URL                         |
|---------------------------------------|---------------------------------|----------------------------------|
| `https://example.com/*`               | `https://example.com/`          | `https://example.com/`           |
| `https://example.com/app/*`           | `https://example.com/app/`      | `https://example.com/app/`       |
| `https://example.com/posts/*/edit`    | `https://example.com/posts/`    | `https://example.com/posts/`     |
| `*://*.example.com/foo/bar*`          | `https://example.com/foo/bar`   | `https://example.com/foo/`       |

## Fetch + cache

- `ensureSiteIcon(origin, probeUrl)` is called from each row's render
  path. `probeUrl` (e.g. `https://connect.garmin.com/app/home`) comes
  from `representativeMatch` and points at a page closer to what the
  script actually targets — many sites only ship the proper
  `<link rel="icon">` on authed/deep pages and serve a barebones SSO
  stub at `/`.
- On a cache miss the fetcher tries the following strategies in order:
  - **HTML discovery (probe URL)**: fetch `probeUrl`, scan the
    `<head>` for `<link rel="icon">` (also `shortcut icon`,
    `apple-touch-icon`). The fetch follows redirects, so even when
    the server bounces us to an SSO host we still get that page's
    icon tag. Relative hrefs resolve against the final post-redirect
    URL. The best candidate is selected by [pickBestIconCandidate](#scoring-link-rel-icon-candidates).
    `data:` URLs declared inline are used verbatim.
  - **HTML discovery (origin root)**: if the probe URL wasn't already
    the root and yielded nothing, retry with `<origin>/`. Catches
    sites whose deep paths return a stripped page but whose marketing
    root has a full `<head>`.
  - **`/favicon.ico` fallback**: conventional path.
  - **Google S2 fallback**: `https://www.google.com/s2/favicons?domain=<host>&sz=64`.
    The only leg that touches a third party — the host name (already
    public via the `@match`) is sent to www.google.com. Reached only
    when every direct strategy has failed, so the set of sites that
    touch this path is small. Google returns a generic globe for
    hosts it can't resolve; we cache that as "better than nothing."
- Every fetch is bounded:
  - 5s timeout, follows redirects.
  - Allowed by the extension's `<all_urls>` host permission.
  - HTML body capped at 1MB; icon body at 128KB.
  - `referrerPolicy: 'no-referrer'` to avoid leaking the
    `chrome-extension://<id>/...` URL to third-party hosts.
- On any failure (network error, non-icon `Content-Type`, oversized
  body) the origin caches a `null` entry so the same broken host
  doesn't get hammered on every render.
- Successful entries are cached for 7 days; `null` entries for 24h.
  After that the next render triggers a refetch — so sites that swap
  their favicon, or hosts that briefly fell back to Google's globe
  placeholder, self-heal without the user clearing storage.
- An in-flight `Map` de-dups concurrent fetches for the same origin
  — multiple rows targeting the same site share one network round
  trip.

### Scoring `<link rel="icon">` candidates

`pickBestIconCandidate` rewards:

- `rel="icon"` / `shortcut icon` over `apple-touch-icon` (Apple
  touch icons are commonly 180px and padded with background colour);
- `mask-icon` is dropped entirely — it's a monochrome Safari
  pinned-tab SVG mask and renders as a black silhouette in `<img>`;
- file types we know render: PNG > SVG > ICO > JPEG/WebP;
- `sizes` near the 32px target (i.e. 16×16 @ 2x dpi) over both
  smaller and much larger entries; `sizes="any"` (vector) wins.

## Storage shape

`siteIcon:<origin>` →
```ts
{ dataUrl: string | null; fetchedAt: number }
```

The key is the full `https://host` string. There is no per-script
copy of the icon: every script targeting the same site looks up the
same row.

Rows are not garbage-collected when the last script referencing an
origin is removed — favicon entries are tiny and removing the row
would just trigger a fresh fetch if the user re-adds the source.

## Display

- A 16×16 `<span class="site-icon">` slot sits before the filename
  link in each row. The viewer page mirrors the same slot inside its
  `<h1>`.
- `renderSiteIconInto` paints the slot synchronously:
  - When the script has a representative origin, the slot contains an `<a class="site-icon-inner" target="_blank">` pointing at `linkUrl`.
  - Otherwise it contains an inert `<span class="site-icon-inner">` — file:// scripts, `<all_urls>`, host-of-`*`, etc.
- The inner element always starts with a muted globe SVG
  (`.site-icon-globe`) so users see *something* immediately and
  rows missing an origin still show a consistent placeholder.
- Once `ensureSiteIcon` resolves, the globe is swapped for an `<img>`
  with the data URL. If a re-render replaced the inner element
  before the fetch finished, the paint is suppressed via
  `isConnected`.
