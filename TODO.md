# TODO

## Skeleton

- Injection follow-ups — see the **Limitations / future work**
  section of [docs/injection.md](docs/injection.md): `@noframes` /
  `allFrames`. (`@grant` / `GM_*`, `@require`, and `@resource` are
  all implemented; per-area follow-ups below.)
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

## Source maps for stack traces

Requires and the body are concatenated into one injected entry (Mode
A — see [docs/injection-modes.md](docs/injection-modes.md)), and an
inline source map restores per-require devtools files and original
line numbers. The viewer's Log tab applies the same layout to
`err.stack` strings, which V8 leaves in generated coordinates — see
[docs/script-log.md](docs/script-log.md#stack-refs-are-source-mapped-first).

What is still unmapped:

- **`err.stack` as a script itself sees it.** We rewrite the string on
  the way into our Log tab; the value the userscript reads is
  untouched. A script that ships its own error reporter (Sentry and
  friends) will report generated line numbers. Fixing that would mean
  rewriting stacks inside the injected scope — a much bigger surface,
  and not obviously ours to do.
- **Columns on a no-`@require` script's first line.** With nothing to
  concatenate the body starts on the same physical line as the wrap
  head, so a frame at line 1 reports a column offset by the head's
  length. Line 1 of a userscript is its `// ==UserScript==` marker, so
  this has never been observed in practice; the code view already
  suppresses the column accent there.
- **The code pane counts lines differently from the mapper.** Mapped
  line numbers are counted the way V8 counts them (`\r`, `\r\n`,
  U+2028, U+2029), but Prism's gutter splits on `\n` only — so a
  `@require` with CR-only endings maps to a line the gutter numbers
  differently. Fixing it means teaching the code view V8's rule, which
  also affects gutter clicks and the `#file:line` deep link.
  - Header diagnostics are a third rule again: `parseHeader` counts
    `\r`, `\r\n` and `\n`, matching the regex it splits the block by
    (see [docs/diagnostics.md](docs/diagnostics.md)). It agrees with
    the gutter for everything except CR-only files, which is the same
    population as above — so all three converge if the code view
    learns V8's rule.
- **A stale log entry can't be mapped at all.** Entries older than the
  current `loadedAt` are left unmapped, because the layout they were
  generated against is gone. A tab still running the previous body
  slips through with a fresh timestamp. Stamping wrapper reports with
  the `loadedAt` they ran under would close both.

## Injection payload

- **Find the real `chrome.userScripts.register()` size limit.** One
  script with four 90 KB requires measures ~1 MB of `js[]` (the source
  map runs ~1.6x the code it maps). Nothing caps require count × size,
  and no documented limit was found. An earlier 512 KB cap on the
  map's embedded sources was removed as an invented number guarding a
  failure that already reports itself (`registerWithFallback` names
  the offending script). Worth an e2e smoke test that registers
  progressively larger scripts until it rejects, so the ceiling is a
  measured fact — and a check that the failure really is as visible as
  the fallback path suggests.
- **Wrap identifiers a `@require` can collide with.** The wrap
  declares `GM`, `GM_info`, every granted `GM_*`, `unsafeWindow` and
  `__sm*` in the same scope as the user program, so a library doing
  `const unsafeWindow = window.wrappedJSObject || window;` — a real
  idiom — is a parse failure. The install-time parse check now catches
  it and names the script (see [docs/parse-check.md](docs/parse-check.md)),
  so it fails visibly rather than silently — but the script still can't
  run. Renaming our internals (or moving the preamble reads onto
  `__smE`, which would also fix the `self` / `window` TDZ case) would
  make it work instead.
  - Measured over the GreasyFork top 2000: this is the *only* thing
    that made a real-world script fail to compile — 3 scripts, all of
    them fine under Tampermonkey (`var …, GM;`, the
    `if (typeof GM_setValue === 'undefined') { var GM_setValue = … }`
    polyfill, and a script shipping its own `function GM_addStyle`).
    See [docs/corpus-validation-results.md](docs/corpus-validation-results.md).

## Parse check — follow-ups

The compile-only check is in (see
[docs/parse-check.md](docs/parse-check.md)). What it doesn't do yet:

- **Compile with the wrap's own declarations.** The check omits the
  wrap head's `var` preamble, the `__smE` parameter and the GM
  prelude, so a script declaring `const __smE`, `let __smDecision` or
  `const __smGmSnap` passes and then fails at injection. Every such
  name is `__sm`-prefixed so the risk is small, and it errs toward
  false-accept. Compiling with `new Function('__smE', preamble + src)`
  would close it.
- **Place a brace imbalance at its cause, not its symptom.** A stray or
  missing `}` is reported by the raw probe at the brace itself, which
  is right — but only when the raw probe is the one chosen, via a
  disagreeing message or an out-of-range wrapped probe. Where the two
  probes both parse past the brace and land in range, the reported line
  is a real error that the imbalance *caused*, further down the file.
  Reporting the imbalance itself would mean tracking brace depth, which
  is a parser.
- **A top-level `return` above a brace imbalance loses the position.**
  The raw probe stops at the `return` with a Script-only diagnostic, so
  it's discarded; the wrapped probe escaped, so it disagrees. Nothing
  is left to place the error and only the message is shown. Correct —
  the alternative was naming a legal line — but a third probe framing
  (async function body, say) might reach it.
- **Batch per refresh pass.** The check is one round trip per changed
  script. `parseCheckedHash` keeps unchanged content free, so this only
  bites on a first-add of many scripts at once.
- **Don't let a failed check clear a real `invalid` verdict.**
  `applyParseCheck` returns the freshly-built row unchanged when the
  verdict is null or `unknown`, and that row starts out `ok`. So a
  refresh whose check couldn't run resets a script that genuinely
  doesn't parse back to `ok` and logs a recovery.
  - Installing checkers in extension pages (this change) removes the
    common cause, but not the shape.
  - Fix: when the verdict is inconclusive AND the prior row was
    `invalid` at the same `parseCheckKey`, carry the prior status and
    message forward. Nothing was re-derived, so nothing justifies the
    recovery.
- **Don't fetch dependencies twice on install-from-preview.** The
  preview fills `previewFetchCache` to run its check; clicking Install
  then runs `addSource` → `attachFiles` against the store's own cache,
  so every `@require` / `@resource` is fetched again. Bridging the two
  caches (or handing the preview's typed entries to the install) would
  halve the third-party traffic that eager fetching introduced.

## GreasyFork corpus findings

Running the install-time checks over the top-2000 GreasyFork scripts
(`npm run validate`, see
[docs/offline-validation.md](docs/offline-validation.md)) turns
"scripts SourceMonkey would refuse" into a measured list. Full results,
with the evidence behind each item, are in
[docs/corpus-validation-results.md](docs/corpus-validation-results.md);
what follows is the fix list it implies.

Worth re-running after any change to the header parser, the `@require`
gates, or the emitted wrap — the rate is the regression signal.

- **`@require` URLs with no `.js` suffix.** `isJsResourceUrl` gates on
  the URL path, and the CDN shorthand forms
  (`cdn.jsdelivr.net/npm/sweetalert2@11`, `unpkg.com/file-saver`,
  `bundle.run/p-queue@6.3.0`) carry no extension at all. Every
  rejection in the corpus was one of these — no case where the gate
  caught something that wasn't JavaScript. Tampermonkey does no suffix
  gating. Either drop the gate in favour of the content-type + UTF-8
  checks that already run on the response, or extend it to accept
  extension-less paths.
- **The 1 MB per-file cap.** `MAX_FILE_BYTES` rejects `opencv.js`,
  `babylon.min.js`, MathJax's `tex-mml-chtml.js`, `video.js` and
  `babel-standalone` — libraries a script legitimately pins. Splitting
  the cap per kind is the obvious first move: a `@require` becomes part
  of the registered `js[]`, while a `@resource` becomes a
  `chrome.storage.local` row, and those have different budgets. Pairs
  with "Find the real `chrome.userScripts.register()` size limit"
  above, which is what a `@require` cap should actually be derived
  from.
- **Metadata-block markers are matched more strictly than the
  ecosystem's.** `BLOCK_START` / `BLOCK_END` anchor to end-of-line, so
  `// ==/UserScript==////` and `// ==/UserScript==vvvvar thisUrl = …`
  read as unterminated, and `/// ==UserScript==` reads as no block at
  all. GreasyFork serves all three, so something upstream accepts them.
  Decide whether to match loosely (TM matches the marker anywhere on
  the line) or to keep the strictness and say so in the error.
- **Wrap-identifier collisions are real, not theoretical.** Every
  parse failure in the corpus was one — see the item under "Injection
  payload" above, which now has a measured rate behind it.
- **`data:` URL `@require`.** Rejected outright today. One corpus
  script inlines a shim that way
  (`data:application/javascript,%3Bwindow.Vue%3DVue%3B…`). Cheap to
  support for the `application/javascript` form, since the bytes are
  in the ref and no fetch is involved.

## Cross-manager coverage

- **No `tests/examples/` script exercises `@require` under
  Tampermonkey.** `require-scope/` covers both injection worlds, but
  skips under `--project=tampermonkey`: it uses a relative `@require`,
  which is a SourceMonkey extension, and TM installs these examples
  from a local file so there's no base URL to resolve against. Baking
  in an absolute URL doesn't work either — the fixture server's port
  is assigned per run.
- Closing this needs either a fixed-port fixture server for the TM
  project, or a rewrite step that stamps the server URL into a
  generated copy of the script before TM installs it. Until then the
  TM-compatibility claim for `@require` — the whole premise of the
  concatenated arrangement — rests on unit and SM-only e2e coverage.

## `GM_*` — deferred surface

The Phase 1–10 work shipped the priority APIs; everything below is
either a follow-up gap, a tractable second-tier API, or a research
question. See [docs/supported-GM-APIs.md](docs/supported-GM-APIs.md)
for the current state of the per-API matrix and
[docs/GM-APIs.md](docs/GM-APIs.md) for implementation details.

### XHR header surgery (originally planned with Phase 10)

The Phase 10 promise was "@connect gating AND header surgery." Only
the gating piece shipped. Surgery is needed so userscripts can set
forbidden headers (Origin, Cookie when overriding the SW default,
Host, Referer, User-Agent). Today `fetch()` silently strips them.

- Add `webRequest` permission to `src/manifest.json`.
- Install `webRequest.onBeforeSendHeaders` listener (or
  `declarativeNetRequest` session rules — TM's MV3 path).
- Tag SW-issued `GM_xmlhttpRequest`s with a `VM-Verify`-style header
  (VM's approach in `requests-core.js`) so the listener can
  distinguish them from page traffic.
- Strip our `Origin` header by default; apply caller-supplied
  overrides for forbidden headers; capture redirected URLs in
  `finalUrl` accurately.

### GM_* APIs not yet in the catalog

Adding any of these is a catalog entry + a body — nothing structural.

- `GM_cookie.list` / `.set` / `.delete` — `chrome.cookies` wrapped
  with per-script `@match` validation. VM's `checkCookieOpts` is
  the reference shape.
- `window.onurlchange` — SPA navigation hook. **Priority**: SPA
  scripts work badly without it. Could be page-side via
  `MutationObserver` on `location.href` + `pushState` / `popstate`
  listeners.
- `GM_download` — TM/VM download-to-disk helper. Needs `BLOBS` added
  to the existing offscreen document's `reasons` (see the clipboard
  entry — there is only one such document).
- `window.close` / `window.focus` — TM-only surface.

### GM_* implementation follow-ups

- **Live `@grant` revocation.** Today `@grant` is baked into the
  wrapper at register time, so changes only take effect on reload.
  Worth doing per-call permission checks (with caching + invalidation
  broadcasts) if users start expecting sources-page edits to take
  effect immediately.
- **Offscreen-doc fallback for clipboard.** `navigator.clipboard.
  writeText` may reject without focus / transient activation. TM/VM
  use an offscreen `execCommand('copy')` to avoid the requirement.
  The offscreen document already exists (`src/offscreen.html` +
  `src/offscreen.ts`, built for the parse check) and the `offscreen`
  permission is declared — MV3 allows only ONE per extension, so
  EXTEND that host rather than adding a second. Needs
  `clipboardWrite` in the manifest and `CLIPBOARD` added to the
  `reasons` array in `parse-check.ts`, which is fixed at creation
  time.
- **`unsafeWindow` cross-world bridge.** Today it's a passthrough to
  USER_SCRIPT world's own `window`, not the page's. A real bridge
  would need a MAIN-world helper + postMessage protocol, or a
  per-call DOM-event ferry à la VM's `MouseEvent.relatedTarget`
  trick.
- **XHR `onprogress` events.** Needs a streaming wire format from
  the SW (chunked sends or a per-request port).
- **Page-side TTL for XHR active requests.** Currently 5 min. Fine
  for now; revisit if real workloads hit it.
- **Abort-after-response narrow race.** A SW round-trip on abort
  would close it. Today the local abort is synchronous (TM/VM
  match) and the race window is small.
- **Cross-script storage spoofing inside the trust boundary.** The
  wrapper-supplied `scriptId` in the storage / XHR envelopes can
  be impersonated by sibling userscripts (they share one USER_SCRIPT
  world per frame and can read each other's ids). Documented
  limitation; within the user's trust boundary and matches TM/VM.
  NOT the same as the page-reachable forged-`sm:check-pending` read
  leak, which is now closed. No cheap fix: verifying the id against
  the tab's active registration set does NOT stop impersonation (the
  victim is active too) — it's hygiene, not security. A real fix
  needs a per-script boundary the shared world lacks (in-closure
  capability tokens + frozen runtime, or per-script `worldId`
  isolation). See the rationale in `docs/GM-APIs.md`.
- **Cross-tab broadcast start-race window.** A write that lands
  between a tab's wrapper registration and its `sm:start` arrival
  isn't broadcast to that tab. The compile-in cache covers the
  state at register time; live broadcasts kick in once `sm:start`
  fires. Closing the window would require registering openers at
  registration time, not on `sm:start`.
- **Iframe-of-same-tab broadcast skip.** The openers table dedupes
  by tabId, so a write in the main frame of tab T doesn't broadcast
  to other frames of T. Each frame stays consistent at register
  time and diverges on writes until next reload. Acceptable for
  v1.
- **Storage quota error surfacing.** A `chrome.storage.local.set`
  rejection (quota exceeded) only `console.warn`s; the userscript
  sees no error. Surface on the per-script log.
- **Storage value type-tag encoding.** Today we round-trip values
  through `chrome.storage.local`'s JSON-ish serialization. VM/TM
  encode with type tags (`o`/`n`/`b`/`s`/`u`) so `Date` and other
  non-JSON-clean values survive. Add when a real userscript needs
  it.
- **Cache the gmValues snapshot in SW memory.** Every storage-
  granting script's `sm:check-pending` reply triggers a
  `chrome.storage.local.get(null)` on the document-start critical
  path. A per-script in-SW cache invalidated by `handleBatchWrite`
  would skip it on cache hit. See
  [docs/GM-APIs-storage.md](docs/GM-APIs-storage.md#cost-on-the-document-start-critical-path).
- **Shim cache audit.** The page-side runtime captures `Promise`,
  `Error`, `Object.keys`, `Object.create`, `Object.prototype.
  hasOwnProperty`, `document.createElement`, `Node.appendChild`,
  `Element.setAttribute`, `chrome.runtime.sendMessage`,
  `navigator.clipboard.writeText`, `console.log`. New subsystems
  should extend the capture set if they reach for new builtins.
- **`GM_notification` SW-restart survival.** Click / done callback
  mappings are in-memory; an SW restart between create and event
  drops them. Open notifications keep showing but their events
  don't reach the userscript. A future phase could persist the
  mapping in `chrome.storage.session` to ride out idle-suspends.
- **`GM_notification.tag` coalescing.** TM uses `tag` to replace an
  existing notification with the same tag in place. We accept the
  field but don't coalesce — each call creates a new notification.
- **`GM_openInTab` exact-position insert.** `insert: true` biases
  Chrome via `openerTabId`, but doesn't guarantee an index. An
  exact `index = opener.index + 1` would need a
  `chrome.tabs.get(opener)` round-trip first.
- **`GM_openInTab` SW-restart survival.** The (requestId ↔ chromeTabId
  ↔ originator) mapping is in-memory; on SW restart already-open
  tabs stay open but `onclose` events from them won't route back
  to the userscript.
- **`GM_notification` click-path e2e coverage.** Headless Chromium
  suppresses notification UI so we can't drive a click from a
  Playwright test. Either drive
  `chrome.notifications.onClicked` directly via the SW test surface
  (similar to `sm.syncNow`) or land a manual-test checklist for
  prod-Chrome verification.
- **`GM_info` data files.** Compare what we return for GM_info vs
  what TM/VM/etc return.
- **`applyRemoteUpdate` listener delivery without storage grant.**
  `wrapper-gm-runtime.js#applyRemoteUpdate` short-circuits on
  `!s.ready`, which is only set by `storage.init`. A script that
  grants ONLY `GM_addValueChangeListener` (no read/write APIs) never
  receives broadcasts. Fix: emit `storage.init` whenever any storage
  subsystem (read/write OR listener) is granted, or dispatch
  listeners independent of `s.ready`.
- **Cross-window incognito broadcast filtering.** `broadcastValueUpdate`
  doesn't filter targets by `tab.incognito`, so a write from an
  incognito tab can fan out to normal-window tabs running the same
  scriptId (and vice versa). Same caveat applies to value-change
  listener dispatch. Should match Chrome's extension incognito
  isolation contract.
- **`GM_xmlhttpRequest` binary request bodies.** FormData / Blob /
  ArrayBuffer request bodies aren't supported — non-string `data`
  stringifies to `[object …]` at the SW boundary. Wire format
  needs a binary-tagged envelope (mirroring the binary RESPONSE
  path) for non-text bodies.
- **`composeWrapperErrorMessage` substring dedup.** The first-line
  dedup in `background.ts` checks `firstLine.includes(msg)`, so a
  message like `"ok"` substring-matches a stack first line of
  `"OkayThenError: foo"` and drops the prepend. Switch to
  word-boundary or `": " + msg` matching.
- **`GM_addElement` attribute sinks doc note.** `applyAttr` passes
  caller-supplied attribute name/value to `setAttribute` unchanged —
  intentionally matches TM/VM (userscripts have full DOM authority).
  Worth one line in `supported-GM-APIs.md` calling out
  `src=javascript:`, event-handler attributes, and `<script src>`
  as deliberately un-sanitized sinks.
- **`unsafeWindow` USER_SCRIPT-world clarity.** Currently a quiet
  passthrough to USER_SCRIPT-world `window`. Either throw with a
  "use `@inject-into page`" hint on access, or document the
  passthrough more loudly so the gotcha is obvious. Today
  `unsafeWindow.<page-global>` returns undefined with no signal.
- **Listener-id contract.** `addValueChangeListener` returns the id
  as a `String(numericCounter)`. TM returns numeric IDs. Pin the
  contract in `GM-APIs.md` — id should be opaque to callers, but
  document what we return.

## `@connect` follow-ups

- **`self` subdomain handling.** TM/VM treat `self` as "the
  script's own origins OR their subdomains"; SourceMonkey matches
  exact host only. See `src/gm-connect.ts#hostMatchesRule`. Fix:
  fall through to the subdomain check against `selfHosts` as a set
  of bases. Documented limitation pending a real compat report.
- **Port handling is asymmetric.** A user-supplied port in
  `@connect example.com:8443` (no scheme) lands in the `exact`
  branch as `host = "example.com:8443"`, but request matching
  goes through `URL.hostname` which strips the port — so the rule
  never matches. Either strip ports consistently when parsing rules
  or preserve them end-to-end through matching.
- **IDN / Unicode host normalization.** `parseConnectEntry` lowercases
  but doesn't punycode-normalize bare-host entries. A rule
  `@connect börse.example` byte-compares against `URL.hostname`
  which returns the punycode form (`xn--brse-5qa.example`) on most
  browsers. Normalize both sides via `new URL('https://' +
  host).hostname` before storing.
- **IPv6 host handling.** `URL.hostname` returns IPv6 addresses in
  bracketed form (`[::1]`). `@connect ::1` (no brackets) won't
  match. Decide whether to require brackets in rules, or
  bracketize bare IPv6 in `parseConnectEntry`.
- **Wildcard-with-port rule.** `parseConnectEntry` on
  `*.example.com:8443` treats the port as part of the host string,
  so the wildcard branch's `endsWith` check never finds the port.
  Same root cause as the bare-host port issue above.
- **`@connect *` install-time warning.** A wildcard `@connect`
  effectively asks for cross-origin fetch reach against any host.
  TM prompts, VM logs a warning. Surface a "this script wants to
  talk to any host" signal in the sources-page row at install /
  refresh time.

## Test coverage gaps

Negative-path / edge-case tests that would catch real bugs noticed
during cumulative review of the GM_* phases:

- **Storage**: circular-object `GM_setValue` (silent cycle drop on
  JSON serialize), `chrome.storage.local.set` quota rejection (cache
  diverges from storage), listener-throws (sibling listeners should
  still fire), 1000-key prefix-scan perf smoke.
- **Value-change listeners**: two listeners on the same key both
  fire; cross-tab broadcast start-race window; iframe-of-same-tab
  broadcast skip.
- **`@connect`**: IPv6 hosts (`[::1]`), wildcard-with-port
  (`*.example.com:8443`), forbidden-request-header strip surfacing,
  GET / HEAD with `data` body (silent drop vs. surfaced).
- **`@grant`**: `GM.GM_setValue` typo lands in `unknown` and
  ReferenceError at runtime + SW logs dropped name.
- **`GM_notification`**: image-less notification falls back to
  `icons/icon-128.png` correctly.

## HTTP sources — follow-ups

- GitHub directory sources are scanned via the unauthenticated Contents
  API (60 req/hour/IP). Worth optimising: stash the listing's ETag and
  send `If-None-Match` on refresh so unchanged dirs don't burn budget.
- GitHub Contents API pagination. `scanGithubDir` reads only the first
  page; trees with >1000 entries silently truncate. Add `?per_page=100`
  + Link-header following when a real source hits the cap.
- Branch names containing slashes (e.g. `feature/foo`) aren't supported
  by the github URL parser — the first ref segment is taken as the ref
  and everything after as the path. Disambiguating would need an extra
  branches/tags lookup.
- Conditional GET on the manifest itself. Today every refresh
  re-fetches and re-parses the manifest body even when nothing
  changed. Stashing the manifest's ETag/Last-Modified on the source
  row would let us skip the manifest-level fetch on 304.
- End-to-end test coverage for the HTTP pipeline (the in-test
  fixture server can already serve arbitrary files; needs a
  `*.user.js` route plus a manifest route, then `sm.addSource(url)`).
- Authenticated sources for non-GitHub hosts (basic-auth header,
  per-source bearer token, etc.). GitHub PATs are wired up via
  `src/github-auth.ts`; everything else still relies on URLs being
  publicly fetchable.

## `@require` follow-ups

- **Shared storage of common require files.** Today each script stores
  its own copy of every required file inline on its `StoredScript`
  row. Five scripts requiring jQuery = jQuery stored five times. Move
  to a content-addressed `require:<sha256>` row keyed by `contentHash`,
  with each `StoredScript.requires[i]` holding only `{ ref, url,
  contentHash, validators, loadedAt }`. Add a sweeper that drops a
  `require:<hash>` row when its refcount across scripts hits zero.
- **UI surface for prefetched requires.** The viewer now shows one
  tab per require with its full source, but the sources page row and
  the viewer's details panel still don't expose require state. Add a
  count badge / chip per sources-page row ("3 requires") and a sub-
  list in the viewer details panel showing each require's URL, size,
  and loadedAt.
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

## Install capture — follow-ups

The shipped design and its known gaps live in
[docs/install-capture.md](docs/install-capture.md) (see its
**Limitations / future work** section — `Content-Disposition`
downloads, mixed-case suffixes, `@version` awareness). Only the items
that need doing *here* rather than describing there:

- **Say when `file://` capture is unavailable.** The capture covers
  local `.user.js` files, but only when the user has granted "Allow
  access to file URLs". With the grant missing nothing fires and
  nothing explains why. The options page should read
  `chrome.extension.isAllowedFileSchemeAccess()` and say so next to
  the capture toggle. The sources page already has a file-access
  banner slot to model it on.
- **Manual check: capture with file access OFF.** Chrome grants file
  access unconditionally to `--load-extension` builds (writing
  `allow_file_access: false` into Preferences does not override it),
  so the e2e suite can only ever exercise the ON case.
- **Drop the Chrome < 152 download workaround** once 152 is the
  supported floor. The DNR session rule, `needsDownloadWorkaround`,
  `parseChromeMajor`, and their tests go together, and the
  `declarativeNetRequestWithHostAccess` permission can come out of the
  manifest with them.

## Script preview — follow-ups

The preview (`userscript.html?preview=<url>`) is where a captured
`.user.js` click and a single-script Add Source both land. See
[docs/script-viewer.md](docs/script-viewer.md#preview-mode).

- **Compare against the installed copy.** When the URL is already
  installed the banner prints both `@version` strings if they differ,
  and nothing else. It should say which is newer (`compareVersions`
  in `src/version-compare.ts`), and whether the
  bodies are identical at all — an unchanged body under a bumped
  version, or a changed body under the same version, are both worth
  saying out loud.
- **Diff view.** Follow-on from the comparison: a two-pane
  before/after per tab, so "what would Update actually change" is
  answerable without leaving the page. Applies to `@require` tabs too.
- **Preview a whole source.** Directory / manifest / github-dir adds
  still go straight to `addSource`. Previewing a listing needs a
  different UI — a table of the scripts that would be added, with
  per-script drill-in — not the single-script layout.

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

## Missing script functionality

- @grant window.onurlchange

## Per-script log follow-ups

Every failure the UI surfaces now lands in the script's Log (see
[docs/script-log.md](docs/script-log.md#every-surfaced-failure-lands-in-the-log)).
Two rough edges are left:

- **The `loglevel:` sentinel is monotonic.** A script that hit
  WARNING/ERROR keeps that badge for the rest of the Chrome session
  even after the Log's newest entry says it recovered. Now that
  recoveries are logged, the badge is the only thing still lying.
  - It is also why source-level fan-out rows are logged at `info`:
    anything higher would badge every script under a source from one
    transient listing failure.
  - Recomputing the max on every append is too expensive. A recovery
    entry could reset it — but only if the reset can tell "the failure
    this supersedes" from an unrelated `sm:error` still in the log.
- **Poll noise still fills the cap.** The reload fast-path runs in
  `manual` mode for every matched script on every tab reload, so
  ordinary browsing appends `checked for updates — no change` per
  script per reload — and two rows for a script that is still failing.
  Dropping the row for non-user-initiated checks would fix it; the
  blocker is that `manual` currently means "not rate-limited", not
  "the user clicked", so the fast-path can't be told apart from a
  Refresh click.
- **`refreshAllSources` uses `Promise.all`**, so one source throwing
  rejects the whole batch — contradicting its own docstring, which
  claims a failed source doesn't take the rest down. `allSettled`
  would make the doc true; the updater currently compensates by
  fanning the throw out to every script.
- **Vanished manifest entries leak their log rows.** `refreshSource`
  drops the `script:` key but not the `log:` / `loglevel:` session
  rows; only `removeScript` cleans both up.
- **The add-to-existing-container path emits no recovery rows.** It
  refreshes every sibling but only restates load failures, so a
  sibling that recovered during that refresh never logs it (and the
  next refresh compares against the already-healthy row). Sharing
  `summarizeSourceOutcome` would fix it, but that lives in
  `script-updater.ts`, which imports `script-store.ts`.

## Log and error message quality

The Source labels are written for users (`manual-refresh`,
`extension-startup`, `script-wrapper` — see
[docs/script-log.md](docs/script-log.md#source-labels)), and the
messages a **script validation** failure produces have now had the same
pass (the rules they follow are in
[docs/diagnostics.md](docs/diagnostics.md#wording)). What's left:

- **The messages that aren't about script content.** The pass covered
  `errorMessage` / the header and dependency wording. Not yet audited:
  anything reporting on the extension's own machinery, where
  implementation jargon leaks — "SW" for the service worker is the
  known example — plus the viewer's `setMessage` copy for states that
  aren't diagnostics.
- **The version-probe rows keep their own wording.**
  `version-probe-fetch.ts` still says `no metadata block` where the
  viewer now says `no // ==UserScript== metadata block, so this is not a
  userscript`. Deliberate — `probe.error` renders as a value in a
  definition-list cell (`script-details.ts`), beside `could not fetch`
  and `no @version`, so a full message doesn't fit. Revisit if that row
  ever gets room, or if the split starts confusing people.
- **Say which fetch failure it was.** `FETCH_FAILED`
  (`external-files.ts`) lists three possibilities because
  `fetchResourceBytes` returns `null` for all of them: no response, a
  non-ok status, and over the size cap. Every one of those is known at
  the point it returns. Making it report a reason would let the message
  state the fact, and would retire the fetch-log reconstruction the
  offline validator does to recover it (`REASON_TEXT` in
  `scripts/validate-userscripts.mjs`).
- **Split "not a usable reference".** `resolveScriptResource` returns
  `null` both for an unsupported scheme and for a relative path that
  climbs out of the script's folder — two different mistakes with
  different fixes. The message states the rule instead of naming the
  problem, because the resolver doesn't say which.

## Testing and example TOODs

- API explorer page with forms to call any GM API with any args
- examples for all supported GM APIs, all headers
- examples for injection scenarios - main world vs userscript world, etc
- examples with absolute (TM-compatible) vs relative paths

## Feature TOODs and ideas

- nice UI for sources page
- nice UI for script page and logging
- status widget instead of context menu for running scripts
- smoother add source/script flow, maybe a dialog box
- relative paths for dev, absolute paths for release (for requires & resources)
- fix caveats with the new multi-file script injection model:
  - reload fast-path doesn't work right?
  - global vars don't go across scripts (except with exports)
- download a script to local disk for editing / debugging
- keep links between local and remote version of a script, select which
  to run. (The *reporting* half shipped — see
  [docs/updates.md](docs/updates.md); picking a different copy to run
  is what's left.)
- `@updateURL` as a bandwidth optimization: fetch the small `.meta.js`
  first and skip the body fetch when the version hasn't moved. Probing
  already fetches it for the OUTDATED status, but the two paths are
  separate — the refresh still does its own conditional GET. Worth
  little for hosts that return ETags; worth more for a large script on
  a host that doesn't.


