# TODO

## Skeleton

- Injection follow-ups — see the **Limitations / future work**
  section of [docs/injection.md](docs/injection.md): `@grant` /
  `GM_*`, `@require` / `@resource`, `@noframes` / `allFrames`.
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

## File loader — follow-ups for `@require`

- Manifest query-string propagation. `resolveManifestEntryUrl`
  forwards an auth-bearing manifest query string (e.g. `?token=…`)
  onto same-origin entries, but `resolveScriptResource` doesn't —
  `new URL('icon.png', '…/foo.user.js?token=…')` strips the query.
  Fine for `@icon` (a token-gated icon is rare), but `@require` of
  a token-gated companion will 401 once it lands. Port the
  same-origin propagation rule into `resolveScriptResource` when
  `@require` ships.
- 0-byte handling. `fetchFileBytesXhr` rejects empty bodies (right
  for icons — a 0-byte image is useless). `@require` of a 0-byte JS
  file should still succeed (it just does nothing); distinguish
  "missing file" (`onerror`) from "empty file" (`onload` with
  zero bytes) before reusing the helper.
- Surface failed / blocked file loads. Today every failure mode in
  `resolveScriptResource` + `fetchResourceBytes` is silent — a
  rejected `@icon ../secret.png` (or a fetch that 404s, times out,
  or trips the content-type filter) leaves the user with no signal
  that their declared icon didn't work. Options range from a
  one-line `console.warn` at render time (cheap, reaches anyone
  debugging) up to a stored `iconError` field on `StoredScript` so
  the viewer page can surface it in the details panel. Same problem
  will apply to `@require` and is worth solving once for both.

## Local directory sources — follow-ups

- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
- Editing path: if we ever want in-app edits, we'll need either FSA
  handles (re-introduces per-session re-grant) or a Native Messaging
  helper. `file://` URLs are read-only from the extension side.
