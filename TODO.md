# TODO

## Skeleton

- Injection follow-ups — see the **Limitations / future work**
  section of [docs/injection.md](docs/injection.md): `@resource`,
  `@noframes` / `allFrames`. (`@grant` / `GM_*` and `@require`
  themselves are implemented; per-area follow-ups below.)
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

### GM_* APIs still stubbed (bindings emit, body throws)

- `GM_registerMenuCommand` / `GM_unregisterMenuCommand` — needs a
  per-page command surface in the action popup (or via
  `chrome.contextMenus`). Discovery: where the menu lives in our
  UI is a design decision, not just implementation.
- `GM_getResourceText` / `GM_getResourceURL` — depends on `@resource`
  storage landing (see require/resource follow-ups below).

### GM_* APIs not yet in the catalog

Adding any of these is a catalog entry + a body — nothing structural.

- `GM_cookie.list` / `.set` / `.delete` — `chrome.cookies` wrapped
  with per-script `@match` validation. VM's `checkCookieOpts` is
  the reference shape.
- `window.onurlchange` — SPA navigation hook. **Priority**: SPA
  scripts work badly without it. Could be page-side via
  `MutationObserver` on `location.href` + `pushState` / `popstate`
  listeners.
- `GM_download` — TM/VM download-to-disk helper. Needs an offscreen
  document for `URL.createObjectURL`.
- `window.close` / `window.focus` — TM-only surface.

### GM_* implementation follow-ups

- **Live `@grant` revocation.** Today `@grant` is baked into the
  wrapper at register time, so changes only take effect on reload.
  Worth doing per-call permission checks (with caching + invalidation
  broadcasts) if users start expecting options-page edits to take
  effect immediately.
- **Offscreen-doc fallback for clipboard.** `navigator.clipboard.
  writeText` may reject without focus / transient activation. TM/VM
  use an offscreen `execCommand('copy')` to avoid the requirement.
  Add `offscreen` + `clipboardWrite` manifest permissions, build
  `src/offscreen.html` + `src/offscreen.ts`, route the fallback
  through it.
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
  be impersonated by sibling userscripts. Documented limitation.
  A future phase could verify the scriptId against the active
  registration set in the sender's tab if compat reports come in.
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
- **UI surface for prefetched requires.** The viewer now shows one
  tab per require with its full source, but the options page row and
  the viewer's details panel still don't expose require state. Add a
  count badge / chip per options-page row ("3 requires") and a sub-
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
