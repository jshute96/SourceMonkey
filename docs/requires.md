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
SourceMonkey. To keep a script portable *and* develop it locally, write
the absolute URL and let a file on disk stand in for it — see
[local-file-overrides.md](local-file-overrides.md).

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
- `localUrl?` — the local file read instead of `url`, when one stood
  in. See [local-file-overrides.md](local-file-overrides.md#storage).

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
  - **Conditionally.** The stored `httpEtag` / `httpLastModified` go
    back as `If-None-Match` / `If-Modified-Since`, and a 304 keeps the
    entry — body, `contentHash`, and `loadedAt` — exactly as it was.
    ETag wins where a server offers both: it is exact, where
    `Last-Modified` cannot distinguish two edits in the same second.
  - Measured on a 46-script collection: 13 unique requires, every one
    of them offering a validator, ~924 KB of transfer replaced by 13
    empty 304s. The wall-clock saving is modest on a fast link — the
    dedup below is what already collapsed those 76 declarations to 13
    — so this is a bandwidth fix first and a latency fix second.
- **Opportunistic refresh** (background check on navigation) →
  `'preserve'`: reuse every cached entry verbatim; only fetch refs
  the script newly declares. Keeps per-navigation cost bounded — the
  user can always click Refresh to surface remote updates.

If both the `@require` and `@resource` lists on a script are
unchanged across an opportunistic refresh, the work short-circuits
entirely — no resolution, no fetching.

Consequence for a require reached by its declared URL: editing it
(without touching the host script) does **not** surface on the next
navigation. The opportunistic path treats requires as opaque-by-URL
and only the explicit Refresh button rechecks those bodies. Mirrors how
TM/VM treat requires — they're fetched on install, not on every page
load — and keeps per-navigation cost bounded for users with many
requires.

A require served by a **local stand-in** is the deliberate exception:
it is re-read every pass, so an edit shows up on the next navigation.
See [local-file-overrides.md](local-file-overrides.md#refresh-policy).

## Cross-script + cross-kind dedup

A `FileFetchCache` is threaded through every refresh entry point.
Two scripts (within or across collections) that reference the same
canonical URL in the same refresh pass share one fetch.

- A `@require` and a `@resource` pointing at the same URL also share
  one fetch — the cache stores raw bytes + Content-Type, and each
  call site does its own typed assembly.
- The cache only lives for one top-level refresh; the next refresh
  starts fresh.

## Failure handling

Any of these is a dependency failure, named by the offending URL:

- Resolution rejection — the message names *which* rule refused it: a
  path climbing out of the script's folder and an unsupported scheme
  are different mistakes with different fixes.
- Non-`.js` suffix.
- Fetch failure — likewise named: `HTTP 404`, over the size limit, an
  empty body, a timeout, or no response at all. A `file://` ref that
  won't read says so rather than blaming the network, and both
  `file://` legs (page XHR, service-worker `fetch`) report it the same
  way.
- An HTML response — see [below](#markup-gate). Checked after the
  fetch, not as part of it, and by two tests: the `Content-Type` and
  the bytes.
- `data:` URLs (resolution accepts them; the require gate rejects).
- **Non-UTF-8 response body** (strict decode fails). A `.js` URL that
  serves binary slips past the suffix gate and the content-type
  predicate but gets caught here, so the user sees "not valid UTF-8"
  rather than a confusing `SyntaxError` at eval.

### Markup gate

Two tests for one problem, because each catches what the other misses.
Both use the shared helpers in `markup-response.ts`, so the `@require`
gate and the script-body fetchers agree on what markup is and say the
same thing about it.

**Not applied to `@resource`** (either test) — an HTML resource is a
legitimate thing to fetch and hand to `GM_getResourceText`. The shared
fetch cache stores raw bytes and each call site applies its own rules,
so a `@require` and a `@resource` on the same URL still share one fetch
without poisoning each other.

**By `Content-Type`:**

- **Markup is the only rejected family** — `text/html*` (which covers
  `text/html-sandboxed`) and `application/xhtml*`. A `@require` is
  always JavaScript, so an HTML 200 is the classic soft-failure
  signature: a login / error page served in place of the library.
  Rejecting it turns that into a clean fetch failure rather than
  silently swapping the working dependency for markup.
- **Everything else is accepted**, `application/octet-stream` included.
  Binary is the UTF-8 decode's job, not the type's. An absent
  Content-Type (the `file://` XHR case) is accepted too.
- `application/json` is *not* rejected, though a JSON error envelope is
  another soft-failure shape. A mislabelling host serving real JS is at
  least as likely, and the per-require `try`/`catch` at eval contains
  the damage either way.
- Octet-stream used to be rejected as a "give us anything binary" hole
  next to the suffix-only `.js` URL gate. It isn't exotic in practice:
  GitHub serves *every* release asset as octet-stream regardless of
  extension, and pinning a library to a release URL is normal. It broke
  real scripts — Greasy Fork Enhance `@require`s `GM_config` from a
  GitHub release, and installing it failed outright.
- Tampermonkey does no content-type gating on `@require` at all.

**By the bytes** (`looksLikeMarkup`), after the UTF-8 decode:

- The first thing in the body, past a BOM and any whitespace, is `<`.
- Catches what the header can't: a response with **no** `Content-Type`
  at all — the `file://` case, and the one where the ref names a local
  *directory*, which Chrome answers with a generated HTML listing — and
  a server that labels its login page `text/plain`.
- Position is the whole point. A forge's file-browser page embeds the
  file's own lines, metadata block included, so any "does it contain
  JavaScript / a header" test would call that page the script.
- Not "the metadata block must be first": a license banner above the
  block is common and supported (`leadingText`). A `.js` file starts
  with code or a comment; only markup starts with a tag.
- Known false positive, accepted: `<!--` at the top of a file is valid
  JavaScript (Annex B HTML-like comments). That spelling belongs to
  1990s inline `<script>` blocks.

### Effect on the parent script

Depends on whether we already had a good copy:

- **No prior good copy** (first load, or the script was already
  `invalid`) → `status: 'invalid'` with the dependency message.
  Running a userscript without its declared deps almost always breaks
  worse than not injecting, so erroring out is safer than running
  headless.
- **Prior `ok` copy** → the script keeps running on its cached deps;
  `status` stays `ok` and the reason is recorded in `refreshError`
  (REFRESH FAILED). A flaky dep host must not disable a working
  script. See [storage.md](storage.md#refresh-failures-keep-the-good-copy-running).
- Either way the reason is copied into the script's Log — error for
  the `invalid` case, warning for the still-running one. See
  [script-log.md](script-log.md#every-surfaced-failure-lands-in-the-log).

- `@resource` bodies are arbitrary bytes with no "is this valid"
  check, so a `@resource` soft failure (a 200 login page) can't be
  detected the way the `@require` markup gate detects it — and an HTML
  resource is legitimate, so the gate would be wrong there anyway. Only
  a hard `@resource` fetch failure gets the keep-the-good-copy
  treatment.

## Reload fast-path interaction

The reload fast-path (see [injection.md](injection.md#reload-fast-path))
ships the script's freshly-updated body to the in-page prelude for
in-place `eval`.

- The payload concatenates every `@require` body before the main body
  via `composeRequiredBody` in `src/injector.ts`, so the eval'd swap
  sees whatever the requires set up.
- Without that, a body referencing a require added between the
  registered version and the refreshed one would throw
  `ReferenceError` on the swap, resolving only on the *next* reload.
- `handleCheckPending` in `src/background.ts` therefore returns
  `composeRequiredBody(refreshed)` rather than the raw body text.

Both paths now share that one concatenation, so the swap and the
registration agree on scope by construction. Previously the swap was
the only place requires and the body shared a scope, and the two
arrangements had to be reasoned about separately.

## Injection

Every `@require` is concatenated ahead of the script's own body into
ONE `{code}` entry in the `js[]` array:

- Declaration order, deduplicated by canonical URL.
- Each preceded by a `// @require <url>` line, and followed by a `;`
  that guards the seam against ASI (Automatic Semicolon Insertion) —
  see [injection-modes.md](injection-modes.md#mode-a--concatenated-user-program-current)
  for why concatenation needs it.
- See [injection-modes.md](injection-modes.md) for the full entry
  shape and the two arrangements considered instead.

### Scope

Requires and the body share one lexical scope, exactly as in TM/VM:

- **`let` / `const` / `class`** at a require's top level are visible
  to later requires and to the body. Nothing is analysed or
  forwarded — they're in scope because they're in the same script.
- **`var` / `function`** are function-scoped locals of the wrap, NOT
  properties of `globalThis`. This matches TM/VM (they wrap in an IIFE
  too), but it is a change from the previous separate-entries
  arrangement, where a require's top-level `var` did become a global.
  A library that expects page code to see `window.MyLib` must assign
  it explicitly.
- **GM bindings** are emitted once, ahead of the first require, so
  library top-level code sees `GM_info` / `GM_setValue` / etc. too.
- **The GM prelude runs first**, so a require's top-level
  `GM_setValue` reads a live storage cache.

Consequences of the shared scope, all matching TM/VM:

- Two top-level `const x` declarations — one in a require, one in the
  body — are a `SyntaxError` and the script does not run. Wrap the
  body in an IIFE (as nearly every real userscript does) and the
  shadowing is ordinary.
- A require that throws at top level aborts the whole script,
  including the body.
- A require declaring any identifier the wrap itself declares — `GM`,
  `GM_info` (both emitted even under `@grant none`), any granted
  `GM_*`, `unsafeWindow`, `__sm*` — is a redeclaration `SyntaxError`.
  `const unsafeWindow = window.wrappedJSObject || window;` is a real
  userscript-library idiom that this now rejects.
- A require declaring top-level `self` or `window` also breaks the
  wrap, whose own preamble dereferences both. See
  [injection-modes.md](injection-modes.md#cons--caveats).
- Any of the above is a parse failure, which means the script does not
  run at all. A trailing sentinel entry detects that and reports it to
  the Log tab and the badge, so it fails loudly rather than silently.

### Timing

`@require` code runs inside the `@run-at` gate along with the body.
Under the previous separate-entries arrangement requires fired early,
in Chrome's `document_start` injection burst, regardless of the
script's declared `@run-at`.

### Devtools and stack traces

Concatenation costs line-number fidelity, and an inline source map
buys most of it back:

- The entry carries a `//# sourceMappingURL=data:…` map with one
  mapping per generated line, plus `sourcesContent` for each require
  and for the body (synthetic `sourcemonkey://` URLs aren't fetchable,
  so the text has to be embedded). Devtools splits the single
  generated script back into the original files at the original line
  numbers.
- What that looks like in the Sources panel, verified in Chrome: a
  script with one `@require` shows two entries under its folder — the
  `.user.js` itself, and the require nested under a `<host>/<path>`
  subtree named for where it was fetched from — each showing its own
  original text. The map's `file` is the same URL as the entry's
  `//# sourceURL=` and as the body's entry in `sources`; the mapped
  source shadows the generated script rather than duplicating it.
- The map is emitted **only** when the script has requires. Without
  them nothing shifts and no map is paid for.
- The reload fast-path's swapped body carries the same map, and lays
  its lines out the same way, so a hot-swapped script reports original
  coordinates exactly as a freshly registered one does.
- `Error.stack` *strings* are not mapped by V8 — it maps positions for
  the devtools UI but leaves the string in generated coordinates. The
  viewer's Log tab parses those strings, so it applies the layout
  itself and re-renders each ref at its original file and line; see
  [script-log.md](script-log.md#stack-refs-are-source-mapped-first).
  A script that reads its own `err.stack` still sees generated
  coordinates — we rewrite the string on the way into our views, not
  at the collection.
- `sourcesContent` is embedded without a size cap: `sourcemonkey://`
  URLs aren't fetchable, so dropping the text would leave a map with
  nothing to show. The real limit is whatever
  `chrome.userScripts.register()` accepts, and that already surfaces
  as a named per-script error rather than silently.

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
