# HTTP and manifest sources

SourceMonkey accepts userscripts from `http(s)://` URLs in addition to
local `file://` paths, and supports a JSON **manifest** format that
works for both local and remote sources. Implemented in
`src/directories.ts` (URL detection, fetchers, scanners) and consumed
by the [script store](storage.md). Companion to
[file-access.md](file-access.md) for the local-filesystem story.

## What you can point at

- An **http(s) URL ending in `.user.js`** → fetched as a single-script
  source (mirrors the local single-file mode).
- **Anything whose pathname ends in `.json`** → treated as a
  **manifest** that lists script URLs. The manifest itself can live at:
  - an `http(s)://` URL,
  - a `file://` URL, or
  - an absolute local filesystem path.

The URL's *pathname* drives the suffix test, so query strings and
fragments don't break detection (`…/foo.user.js?v=2` still classifies
as a single-file source).

Anything else (an http URL with no recognised suffix, etc.) is
rejected with `URL must end in .user.js (single script) or .json
(manifest)`.

## Manifest format

The manifest body is JSON. Two shapes are accepted:

- A bare array of strings:
  ```json
  ["foo.user.js", "sub/bar.user.js", "https://elsewhere/baz.user.js"]
  ```
- An object with a `scripts` array:
  ```json
  { "scripts": ["foo.user.js", "sub/bar.user.js"] }
  ```

Each entry is a URL (string). Resolution rules:

- **Absolute** URLs are used verbatim (any scheme `fetch()` accepts).
- **Relative** URLs resolve against the manifest URL via standard
  RFC 3986 semantics — the manifest's last path segment is replaced.
  So `foo.user.js` listed in
  `https://example.com/scripts/manifest.json` becomes
  `https://example.com/scripts/foo.user.js`; the same entry in
  `/home/me/scripts/manifest.json` becomes
  `file:///home/me/scripts/foo.user.js`.

Entries are trimmed; empty strings are dropped. Duplicates collapse
to the first occurrence. A non-string entry, or a body that isn't one
of the two supported shapes, fails the whole source with a `scanError`.

### Local vs HTTP — same manifest, different scheme

Because a manifest's entries resolve against *its own* URL, the same
manifest JSON can be tested locally and then served unchanged over
HTTP. A typical workflow:

1. Write `manifest.json` next to your `*.user.js` files (or generate
   it with `scripts/make_manifest.sh`).
2. Add the local path (e.g. `/home/me/scripts/manifest.json`) as a
   source in SourceMonkey to verify the entries load and inject.
3. Serve the directory over HTTP; replace the source with the
   `https://…/manifest.json` URL. The script contents and stable IDs
   come from `relativePath` (the raw entry text), so identity carries
   across the swap.

## Conditional GETs (the `unchanged` path)

The fetch-or-skip optimisation is per *entry URL*, not per source.
That means a manifest can mix schemes and each entry picks the right
strategy:

- **http(s)://** entries use a conditional GET. After every successful
  fetch we store the response's `ETag` and `Last-Modified` headers on
  the script row (`httpEtag` / `httpLastModified`, see
  [storage.md](storage.md)). On the next refresh those values are
  replayed as `If-None-Match` and `If-Modified-Since`. A `304` response
  surfaces as `FetchResult.unchanged` and `rebuildSource` keeps the
  prior content + validators verbatim — no re-parse, no `loadedAt`
  bump. A `200` response replaces both the body and the validators.
- **file://** entries reached through a manifest are always re-fetched
  (file:// fetches are cheap; there's no listing-step skip the way
  local-directory sources have).
- **Local-directory** sources keep their existing pre-fetch listing
  skip: if Chrome's `addRow(...)` listing reports the same `size +
  mtime` as the stored entry, no fetch happens at all.

When none of the cheap pre-fetch skips fire (manifest entries; HTTP
servers that don't return validators), `buildScriptFromText` falls
back to a content-hash compare against the prior row's `contentHash`
and preserves `loadedAt` if the bytes are identical. So the
"unchanged → no flash" outcome is uniform across every source/scheme
combination; see [storage.md](storage.md#change-detection-the-last-change-token).

We pass `cache: 'no-store'` on the underlying HTTP `fetch()` so the
browser's HTTP cache can't serve a stale 200 without revalidation —
our own stored validators are the source of truth.

**Manifest body**: only the per-script fetches use conditional GETs
today. The manifest URL itself is re-downloaded every refresh — the
parsed list is small, and stashing a manifest-level ETag on the
source row is tracked in `TODO.md`.

## Vanished entries (manifest only)

- **Detection**: if a manifest used to list a script and no longer
  does, the script row is **deleted**. The manifest is the user's
  source of truth — removing an entry is an explicit removal, not a
  "maybe gone" signal (unlike a local directory, where a file may
  reappear).
- **Re-adding an entry mints a fresh row.** Identity isn't preserved
  across a delete + re-add — the new row gets a new UUID and starts
  `enabled: true`. This is an intentional asymmetry with directory
  sources, where a `missing` file that returns keeps its prior
  `enabled: false` (the user has to opt back in).
- **Identity is by raw entry text**: `relativePath` for manifest
  sources is the literal string from the JSON, so reformatting
  `foo.user.js` to `./foo.user.js` is treated as deleting the old
  entry and adding a new one — the old row's `enabled` state is lost.
- **Single-file sources can't vanish**: the URL either fetches or
  errors; there's no listing for it to disappear from.

## Unreadable manifest

- If the manifest body itself can't be fetched (network error, 404,
  …) or doesn't parse as JSON / one of the supported shapes, the
  source records a `scanError` and **leaves every script untouched** —
  content, status, and `enabled` state all preserved.
- This matches the [storage.md](storage.md) policy for unreadable
  directory listings: we don't auto-disable scripts because the source
  is temporarily unreachable (timed-out creds, flaky network).
- The options page surfaces the `scanError` as a banner on the source
  section so the failure is visible.

## Query-string propagation

- The manifest URL's query string is propagated onto each *same-origin
  relative* entry's resolved URL.
- Use case: GitHub raw URLs that carry a `?token=…` for private repos —
  one token on the manifest URL flows through to every script entry
  without having to repeat it per row.
- Propagation rules (in `resolveManifestEntryUrl`):
  - If the entry brings its own `?…`, the entry's query wins.
  - If the resolved entry is cross-origin from the manifest, the
    manifest's query is **not** copied (the token is scoped to its
    origin).
  - If the entry is same-origin and has no query of its own, it
    inherits the manifest's `?…`.

## Permissions

- `<all_urls>` in `host_permissions` covers any `http(s)` origin, so
  no per-host grant is needed for HTTP manifests or entries.
- Local manifests + file:// entries still need the
  `chrome://extensions` "Allow access to file URLs" toggle (the same
  one local directory sources already require).
- Manifest entries are scheme-gated: a resolved entry URL must use
  `http:`, `https:`, or `file:`. Anything else (`data:`,
  `chrome-extension:`, `blob:`, …) fails the source with a clear
  error. This mirrors the suffix-test policy on the source URL
  itself — a manifest the user added shouldn't be able to escalate
  the SW's `<all_urls>` reach into smuggled inline content or
  cross-extension probing.

## Where `relativePath` and `fileUrl` come from

| Source kind            | `relativePath` (display + identity)    | `fileUrl` (what gets fetched)                       |
|------------------------|----------------------------------------|-----------------------------------------------------|
| Local directory        | path relative to the root              | `pathToFileUrl(join(root, rel))`                    |
| Local single-file      | basename                               | `pathToFileUrl(sourcePath)`                         |
| HTTP single-file       | basename of URL pathname               | `sourcePath` (the URL itself)                       |
| Manifest entry         | raw manifest entry (relative or abs)   | `resolveManifestEntryUrl(rel, sourceCanonicalUrl(manifest)).href` |

`sourceCanonicalUrl()` turns a raw local path into its `file://` URL;
URLs pass through. `scriptAbsolutePath()` returns the resolved URL
for any URL-backed source so the viewer's **Location** row works the
same way for all kinds.

## Module surface

Source-kind classifiers (all scheme-agnostic — they classify by the
input's pathname suffix, regardless of `http://`, `file://`, or raw
path form):

- `isSingleFileSource(s)` — pathname ends in `.user.js`.
- `isManifestSource(s)` — pathname ends in `.json`.

Scheme classifiers (used at the rare call sites that genuinely care):

- `isHttpUrl(s)` / `isFileUrl(s)`.

Normalisers (turn whichever input form the user gave into the form
needed for I/O — used everywhere instead of branching on scheme):

- `sourceCanonicalUrl(s)` — to URL form (raw paths get wrapped as
  `file://`, URLs pass through).
- `sourceFsPath(s)` — the inverse for local inputs (file:// → bare
  fs path with percent-decoded segments; raw paths pass through).

Fetchers and parsers:

- `fetchHttpText(url, opts?)` — conditional `fetch()`; returns
  `{kind: 'ok', text, etag?, lastModified?}` or `{kind: 'unchanged'}`,
  throws on 4xx/5xx.
- `parseManifest(body)` — array-or-`{scripts}` JSON parser, exported
  for tests.
