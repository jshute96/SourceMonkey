# `@require`

SourceMonkey honors `@require <ref>` metadata lines: the referenced
JavaScript file is fetched at script load / refresh time, stored
alongside the userscript, and prepended before the main body when
the script is registered with `chrome.userScripts`.

## Accepted reference forms

Resolution goes through [`src/file-loader.ts`](../src/file-loader.ts) —
same rules as `@icon`:

- Absolute `http(s)://` URL.
- Relative path — resolved against the parent directory of the host
  script's own URL. Works for both file:// and HTTP-loaded scripts.
- **Not accepted:** absolute `file://`, `data:`, `tampermonkey://vendor/`,
  `..` / `%2e%2e` / leading `/` (escape rules from file-loader).

Extension over TM/VM/GM: relative paths. None of the major managers
support them — a script that relies on this will only work in
SourceMonkey.

## `.js` suffix gate

The resolved URL's pathname (sans query / fragment) must end in `.js`.
So `https://cdn.example.com/jquery.js?v=3` is fine; `lib.json` or
`bundle.txt` is rejected with a "must end in .js" error.

## Storage

Each `StoredScript` carries an inline `requires?: StoredRequire[]`
array — declaration order, deduplicated by canonical URL.

Per-entry fields:

- `ref` — verbatim from the `@require` line (trimmed).
- `url` — canonical resolved URL. Dedup key.
- `source` — fetched JS text.
- `size` — UTF-8 byte length of `source`.
- `contentHash` — SHA-256 of `source`. Drives the unchanged-content
  short-circuit so unchanged bytes preserve `loadedAt`.
- `loadedAt` — epoch ms; bumps only on a true content change.
- `httpEtag?`, `httpLastModified?` — captured from the last HTTP
  fetch. Not yet round-tripped to the byte fetcher — see TODO.

Storage layout today: every script stores its own copy of every
required file, so two scripts requiring jQuery store jQuery twice.
Shared (content-addressed) storage is a planned follow-up — see
[TODO.md](../TODO.md).

## Refresh policy

The refresh path takes a `recheckFiles: 'all' | 'preserve'` option
(same policy now covers both `@require` and `@resource`):

- **Explicit Refresh** (manual button click) → `'all'`: refetch every
  declared dep so the user can pick up remote updates even when the
  main script body hasn't changed.
- **Opportunistic refresh** (background check on navigation) →
  `'preserve'`: reuse every cached entry verbatim; only fetch refs
  the script newly declares. Keeps per-navigation cost bounded — the
  user can always click Refresh to surface remote updates.

If both the `@require` and `@resource` lists on a script are
unchanged across an opportunistic refresh, the work short-circuits
entirely — no resolution, no fetching.

Consequence for `file://` sources: editing a require file on disk
(without touching the host script) does **not** surface on the next
navigation. The opportunistic path treats requires as opaque-by-URL
and only the explicit Refresh button rechecks remote (or local)
require bodies. Mirrors how TM/VM treat requires — they're fetched
on install, not on every page load — and keeps per-navigation cost
bounded for users with many requires.

## Cross-script + cross-kind dedup

A `FileFetchCache` is threaded through every refresh entry point.
Two scripts (within or across sources) that reference the same
canonical URL in the same refresh pass share one fetch.

- A `@require` and a `@resource` pointing at the same URL also share
  one fetch — the cache stores raw bytes + Content-Type, and each
  call site does its own typed assembly.
- The cache only lives for one top-level refresh; the next refresh
  starts fresh.

## Failure handling

Any of these flips the parent script to `status: 'error'` with a
message naming the offending URL:

- Resolution rejection (traversal, disallowed scheme, etc.).
- Non-`.js` suffix.
- Fetch failure (404, oversize, content-type rejected, timeout).
- `data:` URLs (resolution accepts them; the require gate rejects).
- **Non-UTF-8 response body** (strict decode fails). A `.js` URL that
  serves binary slips past the suffix gate and the content-type
  predicate but gets caught here, so the user sees "not valid UTF-8"
  rather than a confusing `SyntaxError` at eval.

Accepted Content-Type for `@require`: anything with `javascript`
or starting with `text/`. `application/octet-stream` is *not*
accepted — it was a "give us anything binary" hole when combined
with the `.js` suffix-only URL gate.

Running a userscript without its declared deps almost always breaks
worse than not injecting; erroring out is safer than running headless.

## Reload fast-path interaction

The reload fast-path (see [injection.md](injection.md#reload-fast-path))
ships the script's freshly-updated body to the in-page prelude for
in-place `eval`. The shipped payload concatenates every `@require`
body before the main body via `composeRequiredBody` in
`src/injector.ts`, so the eval'd swap can see require-set-up
globals. Without that, the swapped body's references to a require
that was added between the registered version and the refreshed
version would throw `ReferenceError` on the swap and only resolve
on the *next* reload (because by then `chrome.userScripts` has
re-registered the script with the new requires as separate entries).

`handleCheckPending` in `src/background.ts` therefore returns
`composeRequiredBody(refreshed)` rather than the raw body text.

The eval-based swap path is the only place we still concatenate;
the default-run path injects each require as its own `js[]` entry
for clean stack traces — see
[injection-modes.md](injection-modes.md).

## Injection

In the default-run path, each `@require` becomes its own `{code}`
entry in the script's `js[]` array, wrapped in
`if(self.__smActive("<id>")){try{<body>}catch(e){...}}` with a
trailing `//# sourceURL=<require URL>` directive. Devtools shows
each require as its own file with original line numbers; a stack
trace from inside a require points at that require's URL, not at
the host userscript.

Top-level `var` declarations in a require still become globals on
`globalThis` (top-level `var` writes a property on the global
object), so libraries that attach to `window` work unchanged.
Top-level `let`/`const` becomes script-scoped — a require that
defines a cross-piece binding that way won't be visible to other
requires or to the main body. Workaround: assign explicitly to
`globalThis` / `window`.

See [injection-modes.md](injection-modes.md) for the alternative
arrangements considered (concatenated single blob, eval-per-require)
and why we picked separate entries.

## Limits

- Per-require body: **1 MB**. Big enough for jQuery / chunky libraries;
  small enough that a runaway can't drain the 10 MB
  `chrome.storage.local` quota in one row.
- Per-fetch timeout: 5 s (file-loader default).
- Empty bodies are rejected (the fetcher treats them as failure). A
  future `@require` of a 0-byte JS file would need to distinguish
  "file missing" from "file is empty" — see TODO.

## SRI hash fragments

Tampermonkey honors `@require <url>#sha256=…` (and `#md5=`, `#sha1=`,
`#sha384=`, `#sha512=`). SourceMonkey currently passes the fragment
through the URL resolver verbatim and never validates it — listed in
[TODO.md](../TODO.md).
