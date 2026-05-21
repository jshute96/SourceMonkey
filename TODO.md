# TODO

## Skeleton

- Injection follow-ups — see the **Limitations / future work**
  section of [docs/injection.md](docs/injection.md): `@grant` /
  `GM_*`, `@resource`, `@noframes` / `allFrames`. (`@require`
  itself is implemented; see the dedicated follow-ups section
  below.)
- Reload fast-path: once HTTP-fetched scripts land, split the current
  single 500ms timeout in `handleCheckPending` into a 500ms detection
  window and a separate ~5s loading window. File:// reads finish well
  inside 500ms so the phases collapse today, but a remote `@updateURL`
  fetch can easily exceed that — we want to detect "an update is
  coming" fast, then patiently wait for the body to arrive before
  giving up and running the prior version. See
  `docs/injection.md#smcheck-pending-handler` for the current
  single-phase semantics.
- Make an icon that works

## HTTP sources — follow-ups

- GitHub-aware adapter so users can point at a repo (or subpath +
  ref) and have SourceMonkey enumerate `*.user.js` via the Git Trees /
  Contents API rather than maintaining a manifest by hand.
- Conditional GET on the manifest itself. Today every refresh
  re-fetches and re-parses the manifest body even when nothing
  changed. Stashing the manifest's ETag/Last-Modified on the source
  row would let us skip the manifest-level fetch on 304.
- End-to-end test coverage for the HTTP pipeline (the in-test
  fixture server can already serve arbitrary files; needs a
  `*.user.js` route plus a manifest route, then `sm.addSource(url)`).
- Authenticated sources (basic-auth header, GitHub PAT, etc.) for
  private repos or unlisted gists. The current design only handles
  publicly-fetchable URLs.

## `@require` follow-ups

- **Shared storage of common require files.** Today each script stores
  its own copy of every required file inline on its `StoredScript`
  row. Five scripts requiring jQuery = jQuery stored five times. Move
  to a content-addressed `require:<sha256>` row keyed by `contentHash`,
  with each `StoredScript.requires[i]` holding only `{ ref, url,
  contentHash, validators, loadedAt }`. Add a sweeper that drops a
  `require:<hash>` row when its refcount across scripts hits zero.
- **UI surface for prefetched requires.** The options page row and
  viewer detail panel don't expose require state. At minimum: a
  count badge / chip per row ("3 requires"); ideally the viewer
  shows each require's URL, size, and loadedAt as a sub-list.
- **HTTP conditional GETs on require fetches.** `fetchResourceText`
  doesn't thread `If-None-Match` / `If-Modified-Since` through the
  byte fetcher, so every explicit Refresh re-downloads every require
  body even when the server would have answered 304. Extend
  fetchResourceBytes (or the require fetcher itself) to send the
  prior `httpEtag` / `httpLastModified` and to surface a 304 to the
  caller for the "preserve prior" shortcut.
- **SRI hash validation.** Tampermonkey honors
  `@require <url>#sha256=…` (and `md5/sha1/sha384/sha512`); we parse
  the URL through resolveScriptResource verbatim and never check the
  fragment. Either validate post-fetch and reject on mismatch, or
  document explicitly that the hash is informational.
- **`@resource` support.** Companion to `GM_getResourceText` /
  `GM_getResourceURL`. Same fetch + storage pipeline as `@require`;
  moot until the `GM_*` API is wired up.
- **Absolute `file://` URLs in `@require`.** Tampermonkey supports
  these; SourceMonkey rejects them, sharing the rule with `@icon`
  (the extension holds `file:///*` host permission, so an HTTP-
  sourced script could otherwise read arbitrary host files). Decide
  whether to allow absolute `file://` requires when the host script
  is itself file://-loaded — that's the case where the user clearly
  trusts the local filesystem already. Today the relative-path
  resolution covers same-directory and subdirectory cases; this
  would unblock requiring a file in a sibling directory or under a
  user-supplied absolute path.

## File loader — follow-ups

- Manifest query-string propagation. `resolveManifestEntryUrl`
  forwards an auth-bearing manifest query string (e.g. `?token=…`)
  onto same-origin entries, but `resolveScriptResource` doesn't —
  `new URL('icon.png', '…/foo.user.js?token=…')` strips the query.
  Fine for `@icon` and same-origin HTTP requires today, but a
  token-gated companion library reached via `@require` will 401.
  Port the same-origin propagation rule into `resolveScriptResource`.
- 0-byte handling. `fetchFileBytesXhr` rejects empty bodies (right
  for icons — a 0-byte image is useless, and right for `@require`
  too in practice — a 0-byte require is almost always a missing
  file). Worth revisiting if a real use case turns up; today the
  reject is uniform.
- Surface failed / blocked file loads. Today every failure mode in
  `resolveScriptResource` + `fetchResourceBytes` for `@icon` is
  silent (the corresponding `@require` path correctly flips the
  script to status: 'error' with a message, so the user sees it).
  Consider an `iconError?: string` field on `StoredScript` so the
  viewer can surface a rejected `@icon ../secret.png` in the
  details panel.

## Local directory sources — follow-ups

- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
- Editing path: if we ever want in-app edits, we'll need either FSA
  handles (re-introduces per-session re-grant) or a Native Messaging
  helper. `file://` URLs are read-only from the extension side.
