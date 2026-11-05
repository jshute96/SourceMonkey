# `@resource`

SourceMonkey honors `@resource <name> <ref>` metadata lines:
the referenced file is fetched at script load / refresh time, stored
alongside the userscript as raw bytes, and exposed to the userscript
at runtime via:

- `GM_getResourceText(name)` — body decoded as UTF-8 (mojibake-tolerant).
- `GM_getResourceURL(name)` — `blob:` URL minted in the page with the
  fetched Content-Type as the blob MIME.
  - `GM_getResourceURL(name, false)` gives a base64 `data:` URL
    instead, as in VM, for pages whose CSP blocks `blob:` images.

Both `GM_` forms are synchronous (the `GM.` forms return a Promise):
the wrapper bakes the bytes (base64) into the per-script registration,
so no runtime fetch happens on access.

## Accepted reference forms

Same rules as `@require` / `@icon` — see
[`src/file-loader.ts`](../src/file-loader.ts):

- Absolute `http(s)://` URL.
- Relative path — resolved against the host script's own URL. May
  climb out of the script's directory from an HTTP-loaded script;
  confined to it from a local one.
- `data:` URL — decoded in place of a fetch, as for `@require`. Its
  MIME type is the URL's own (`text/plain` when it names none).
- **Not accepted:** absolute `file://`.

A resource declared by absolute URL can still be served from a file on
disk next to the script — same rule and same gate as `@require`; see
[local-file-overrides.md](local-file-overrides.md).

## No suffix gate

- Resources can be any media type. The fetch accepts any
  Content-Type (or no Content-Type, for file:// XHR).
- No `image/*` filter, no `text/*` filter, nothing.
- Example: `@resource logo https://example.com/a.png` fetches a PNG;
  `GM_getResourceURL("logo")` mints a `blob:` URL with
  `type=image/png`.

## Storage shape

Each `StoredScript` carries a `resources?: StoredResource[]` array —
declaration order, deduplicated by name. The bodies themselves are
[content blobs](storage.md#content-blobs) (format 2; see the status
note there).

Per-entry fields:

- `name` — the `@resource` name. Duplicate names: first declaration
  wins; we're lenient so a typo only costs the one entry. TM rejects
  the script outright, and VM silently keeps the *last* declaration —
  see [supported-headers.md](supported-headers.md).
- `ref` — verbatim from the metadata line.
- `url` — canonical resolved URL.
- `blobRef` — `{hash, size}` of the body bytes: the hash is the key of
  its blob. Written
  as base64 for JSON-friendly storage in `chrome.storage.local`, but a
  blob first written as text (by a `@require` with the same bytes) is
  read back as bytes just the same.
- `contentType` — server-reported Content-Type (lowercased), or `''`
  when unavailable (file:// XHR often omits it).
- `size`, `contentHash`, `loadedAt`, `httpEtag?`, `httpLastModified?`,
  `localUrl?` — same semantics as `StoredRequire`.

Storage cost:

- Base64 encoding adds ~33% to the raw byte size.
- Per-file cap: 2 MB, for fetched files. A `data:` resource is bounded
  by the script's own size instead. `chrome.storage.local` quota: 10 MB.
- SourceMonkey doesn't declare `unlimitedStorage`, so users who push
  past 10 MB total stored will see refresh failures.

## Wrapper plumbing

For scripts that `@grant` `GM_getResourceText` or `GM_getResourceURL`
the injector emits:

```js
__smReg.gm.resource.init("<scriptId>", {
  "<name>": { b64: "<base64>", ct: "<contentType>" },
  …
});
```

…in the wrapper's prelude (right after `storage.init`). Emitted even
when the resource map is empty (`{}`) so the runtime's per-script box
is reset on every reload — a removed `@resource` line doesn't leave
stale bytes resident.

The runtime keeps a per-script box of:

- `byName[name] = { b64, ct }` — raw entries.
- `textCache[name]` — first `GM_getResourceText` call decodes and
  caches.
- `urlCache[name]` — first `GM_getResourceURL` call mints a `Blob`
  and `URL.createObjectURL`, caches the URL.
- `dataUrlCache[name]` — the same for the `data:` URL that
  `GM_getResourceURL(name, false)` builds.

- Empty Content-Type for the blob falls back to
  `application/octet-stream` so the browser has something to dispatch
  on. VM leaves the type empty in that case (its stored resource is
  literally `<content-type>,<base64>`, and a missing header makes the
  first field blank), so a typeless resource is one of the few places
  the two blob URLs differ.
- The minted blob URL is valid for the document's lifetime — we
  don't `URL.revokeObjectURL` since the runtime stays around.
- Memory cost is ≈ 2× the resource size per document in the worst
  case (base64 in `byName` + Blob bytes copy). Gated by the 2 MB
  per-file cap.

## Failure handling

Unlike a `@require`, a `@resource` that doesn't load doesn't stop the
script: the script may use it on only some paths, or not need it to
work. Any of these counts, with a message naming the resource:

- Resolution rejection, naming which rule refused it.
- Fetch failure, naming which one; both kinds share
  `describeFetchFailure` / `describeResolveFailure` with `@require`
  ([requires.md](requires.md#failure-handling)).
- A `data:` URL whose payload doesn't decode.
- A file over the size limit.

### What happens

- **At load:** a note on the `@resource` line in the Log tab and
  `sm-dev validate`, and a Warning status where the script runs.
  - It's a **warning**, or an **error** for a file over the limit.
    The limit fails on every load until the script changes, and the
    others can come right by themselves or are outside the author's
    hands.
  - The script stays `ok`, and the row records it in `resourceProblems`.
- **When the script asks:** `GM_getResourceText` and `GM_getResourceURL`
  give `""` (as TM does; a name that was never declared gives
  `undefined`).
  - The first ask for each name per document logs an **error**, worded
    by the worker from the row, and a `console.info` line in the page.
- `GM_info.script.resources` still lists it, since the script declares it.

### Earlier copies and retrying

- **With a good copy already loaded** under that name or URL, a failure
  is a failed refresh, as for `@require`: the whole script stays on its
  prior copy and `refreshError` records why
  ([requires.md](requires.md#failure-handling)).
  - So an update that moves a resource to a URL that fails doesn't land.
- **Without one,** the recorded failure is kept until a refresh tries
  the file again, so a dead URL isn't fetched on each page load:
  - An explicit Refresh always tries again.
  - A background refresh does too for a failure that may pass by
    itself (no response, a timeout), as for `@icon`.
  - A local stand-in is read every pass, as usual.
- A retry that loads the file clears the problem and counts as new
  content, so open pages are marked for a reload.

## Refresh policy

Shared with `@require`. See
[requires.md](requires.md#refresh-policy) for the full description.
Short form: the `recheckFiles` option drives both kinds together.

- Explicit Refresh → `'all'`: refetch every declared dep.
- Opportunistic refresh → `'preserve'`: reuse cached priors verbatim
  unless the declaration list changed.
- Exception: a resource served by a **local stand-in** is re-read every
  pass — see [local-file-overrides.md](local-file-overrides.md#refresh-policy).

## Cross-script + cross-kind dedup

The same `FileFetchCache` underpins both `@require` and `@resource`.
A require and a resource pointing at the same URL in the same refresh
pass share one byte fetch — the typed assembly (`StoredRequire` vs
`StoredResource`) happens after the cache hit.

## Limits

- Per-resource body: **2 MB** (shared cap with `@require`, applied by the
  extension as [there](requires.md#limits)). A resource over it doesn't
  make the script invalid: see [Failure handling](#failure-handling).
- Per-fetch timeout: 5 s (file-loader default).
- Empty bodies rejected.

## SRI hash fragments

Same as `@require`: parsed-and-preserved but not validated. See
[supported-headers.md](supported-headers.md).
