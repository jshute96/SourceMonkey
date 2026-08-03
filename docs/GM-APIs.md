# GM_* / GM.* API Implementation

Implementation status and design notes for the `GM_*` / `GM.*` API
surface. Strategy and tradeoffs live in
[`GM-API-strategy.md`](GM-API-strategy.md); this doc records what
SourceMonkey actually does today.

## Components

- **`src/gm-api-catalog.ts`** — pure data. Each supported API has a
  spec: legacy `GM_x` name, GM4 `GM.x` alias, `sync`/`async` kind,
  subsystem tag, optional `requires` (extra header dependencies like
  `@connect` for XHR, `@resource` for `GM_getResource*`). Helpers
  canonicalize `@grant` lines and resolve the script's granted set,
  surfacing `unknown` names so the SW can warn.
- **`src/gm-bindings.ts`** — per-script emitter. Given the granted set
  + the script's parsed header, returns the JS source to splice into
  the wrapper. Always emits `GM_info` (matching TM/VM: implicit, no
  `@grant` required); emits a `const GM_x = function (...){...}` for
  each granted legacy name; emits a `const GM = Object.freeze({...})`
  GM4 namespace covering the granted APIs with `gmDotName` plus
  `GM.info`.
- **`src/wrapper-gm-runtime.js`** — USER_SCRIPT-world shared runtime
  (`window.__SM_GM__`). Registered once per page at `document_start`
  like the MAIN-world bridge. Provides:
  - Shim cache of native references (Promise, Error, JSON.parse/
    stringify, etc.) — defends against sibling userscripts that
    monkey-patch builtins.
  - `sendAsync(payload)` — chrome.runtime.sendMessage helper that
    routes through a captured `bind`-ed reference.
  - `notImplemented(name)` — Phase 2 placeholder; later phases
    replace per-subsystem methods.
- **`src/injector.ts`** — wires the emitter and runtime into the
  registration pipeline. `buildGmBindingsForScript` produces the
  per-script source; `buildGmRuntimeSpec` returns the runtime
  registration alongside `buildBridgeSpec`.
- **`src/gm-url-change.ts`** — SW-side driver for
  `@grant window.onurlchange`. Forwards
  `chrome.webNavigation.onHistoryStateUpdated` to the frame that
  changed as an `sm:url-change` message.

## Bindings layout in the wrapper

`emitGmBindings` returns `{js, prelude}` — both strings are
spliced into the combined user-program wrap function
(`wrapCombinedEntry` in `src/injector.ts`), so they're locals of that
function and visible to the user body via closure:

- `js` — lazy `const GM_X = ...` declarations plus the GM4 alias
  object. Each declaration only dereferences `window.__SM_GM__`
  from inside its own function body, so emitting them this early
  is safe even when the runtime spec hasn't run yet — the
  dereference doesn't fire until the user body actually calls a
  `GM_*` API.
- `prelude` — eager `__SM_GM__.*` calls — today just
  `storage.init(scriptId, __smDecision.gmValues)` for scripts
  with a storage grant. The snapshot is attached to the
  `sm:check-pending` reply by the SW; if it's missing the prelude
  hard-aborts (see [GM-APIs-storage.md](GM-APIs-storage.md)). By
  the time the main-body wrap function fires, both
  `sm:check-pending` (microtask) and the declared `@run-at`
  lifecycle event have resolved, so the GM runtime is installed
  and `__smDecision` (pulled out of the entry the prelude passes
  in) is in scope.

Both `js` and `prelude` are single-line strings occupying the entry's
opening physical line:

- With no `@require`s the user body starts on that same line, so body
  line N is physical line N.
- With requires the body moves down past them, and an inline source
  map restores the original positions — see
  [injection-modes.md](injection-modes.md).

Scope notes:

- `@require` bodies are concatenated into the SAME wrap function,
  after the bindings and before the script's own body, so library
  top-level code sees the `GM_*` surface it expects (e.g.
  `gm4-polyfill.js`) with one copy of the block rather than one per
  require. Under the previous separate-entries arrangement each entry
  was its own V8 script and the prefix had to be repeated — tens of KB
  of duplication for a verbose header with several requires. See
  [injection-modes.md](injection-modes.md).
- The `prelude` block (`storage.init` etc.) is emitted once, ahead of
  the requires, so a require's top-level `GM_setValue` reads a live
  cache. Under separate entries the prelude couldn't be repeated (it
  references `__smDecision` / `__smE`, which existed only in the
  main-body wrap) and require entries fired before it ran — so that
  same call hit an uninitialized cache.
- The reload-fast-path's `eval` swap runs at the prelude's function
  scope, not inside the wrap function's closure, so the
  swap-evaluated body doesn't see the bindings; the SW refuses
  run-new when `needsValues: true` to avoid this trap.

## World gating

- `GM_info` is emitted in **every** world (USER_SCRIPT and MAIN) and
  for every script regardless of `@grant`. It's a baked literal with
  no runtime dependency, so it works in MAIN with no `__SM_GM__`
  needed. Matches TM/VM (both expose GM_info implicitly).
- The rest of the GM_* surface — including the `window.onurlchange`
  event surface — is emitted ONLY in `USER_SCRIPT` world.
  Scripts with an explicit `@inject-into page` or otherwise running
  in MAIN don't get the non-info bindings — they'd be unable to reach
  `__SM_GM__` (different world) or `chrome.runtime` (undefined in
  MAIN). Calls to any non-info GM_* name in such a script throw a
  natural `ReferenceError`. This is a known limitation; the TODO in
  [GM-API-strategy.md](GM-API-strategy.md#things-to-revisit-later)
  tracks bridging the rest of the surface into MAIN.

## `@grant` resolution

- `@grant GM_setValue` and `@grant GM.setValue` both canonicalize to
  the legacy `GM_setValue` and emit the same set of bindings (legacy
  + GM4 alias).
- `@grant none` wins over every other `@grant` line. Matches TM/VM
  behavior — a script declaring both `@grant none` and `@grant
  GM_setValue` is treated as ungranted.
- Unknown names (e.g. TM-only `GM_audio`) are dropped silently from
  the granted set and surfaced via the catalog's `unknown` return,
  available for future warning surfacing.

## API kinds

- **Sync** APIs (`GM_setValue`/`GM_getValue`/`GM_addStyle`/...) resolve
  in-page via the `__SM_GM__` runtime — no SW round-trip. The Phase-2
  stub calls `__SM_GM__.notImplemented(name)` which throws an
  explanatory error.
- **Async** APIs (`GM_xmlhttpRequest`/`GM_setClipboard`/...) build a
  message envelope (`{type: 'sm:gm-call', api, scriptId, args}`) and
  route through `__SM_GM__.sendAsync(...)` to the SW. Phase 2 has no
  SW-side handler yet — the call ultimately rejects.

## Caveats and Phase-2 limitations

- **`unsafeWindow` is the USER_SCRIPT world's `window`, not the
  page's.** Userscripts in MAIN world (`@inject-into page` or
  `@grant none`) get the page's `window` directly anyway, so they
  don't need (and don't get) `unsafeWindow`. Scripts in USER_SCRIPT
  world that grant `unsafeWindow` currently receive a passthrough to
  the local isolated `window` — no cross-world reach into page
  globals. A future phase can bridge to MAIN via postMessage if
  needed.
- **Runtime ordering safety has two layers.** The lazy `const GM_X =
  ...` declarations read `window.__SM_GM__` only inside their own
  bodies — first GM call wins, by which point the runtime is
  installed. The one eager call (`storage.init`) does NOT live with
  the consts; it's emitted into the main-body wrap function and
  runs only after the prelude's `awaitDecision` + `waitForRunAt`
  gates resolve (both `sm:check-pending` and the declared `@run-at`
  event). So `chrome.userScripts`'s document_start registration
  order doesn't have to be a guarantee.

- **Prelude throws bypass the body's try/catch.** The GM prelude
  is spliced into the same main-body wrap function as the body,
  AHEAD of the body — a `storage.init` throw (only possible if
  `__SM_GM__` is somehow *still* undefined after `waitForRunAt`)
  is caught by the prelude's `try { fn() } catch` in `runMain` and
  surfaces as a normal `sm:error`. In normal operation `__SM_GM__`
  is guaranteed installed by then, so this is mostly theoretical.

- **Cross-tab `applyRemoteUpdate` ignores writes before init.** The
  remote-update handler early-returns when the per-script store
  isn't `ready`. Since the GM prelude runs only after the
  `waitForRunAt` gate resolves,
  `ready` flips later than it used to (after the declared `@run-at`
  lifecycle event). For `@run-at document-idle` the gap can stretch
  to `window.load`. A sibling tab's `GM_setValue` that broadcasts
  during that window gets dropped on the floor by this document. In
  the common case the same write is already reflected in the
  check-pending snapshot the SW sent us (the SW persisted it before
  broadcasting), so the body sees it anyway. The edge case: the
  write hits the SW AFTER we've issued check-pending but BEFORE
  `ready` flips — the snapshot is older than the broadcast and we
  drop the broadcast. Rare in practice (cross-tab traffic during
  page load is uncommon) but worth knowing.
- **`GM_info.script.grant` is the canonicalized set, not the raw
  `@grant` lines.** `@grant GM.setValue` shows up as `GM_setValue` in
  `GM_info.script.grant`. Matches VM; TM exposes the raw declared
  form. Worth revisiting if any real compat reports come in.
- **Unknown `@grant` names log a console warning.** A typo like
  `@grant GM_setvalue` (lowercase) is dropped from the binding set
  and the script gets a `ReferenceError` at call time. The injector
  logs the dropped names at `console.info` so a debugger can spot
  the cause.
- **Async-envelope `scriptId` is wrapper-supplied.** Sibling
  userscripts in the same USER_SCRIPT world can in principle call
  `window.__SM_GM__.sendAsync({api, scriptId: 'other-id', args})` to
  impersonate each other's `@connect` allowlist. Same-extension
  scripts are inside the trust boundary, so this is a "userscript A
  borrows userscript B's permissions" situation, not a privilege
  escalation against the user. The Phase-8/10 SW handler should
  still treat the scriptId as wrapper-supplied data, not authenticated.

## GM4 alias namespace

`GM` is a `const` Object.freeze'd at compile time. Each granted API
with a `gmDotName` becomes a property. Where `gmDotPromised` is true
(storage primitives), the GM4 form wraps the legacy `GM_x` call in
`Promise.resolve` so callers can `await` it uniformly — matching the
GM4 spec.

`GM.info` aliases the literal `GM_info` object. There is no
`GM.unsafeWindow` (the legacy form lacks a `gmDotName`).

## Storage (`GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`)

See [`GM-APIs-storage.md`](GM-APIs-storage.md) for the full
treatment: why values have to sit in the document's realm, how the
snapshot gets seeded at document start, the freshness mechanisms
that keep running and newly-starting documents up to date after a
`GM_setValue`, and the wire format / batched-write details.

## `GM_xmlhttpRequest`

Cross-origin HTTP from the SW, fanned back to the originating tab.
Phase 8 ships the **text path**: `responseType: 'text'` (default)
and `'json'`. Binary types land in Phase 9; header surgery + `@connect`
gating in Phase 10.

Architecture:

- Page-side `GM_xmlhttpRequest(details)` returns `{abort}`
  synchronously. The runtime stores the callbacks
  (`onload`/`onerror`/`ontimeout`/`onabort`) keyed by a generated
  request id (callbacks aren't serializable across postMessage), and
  ships a `sm:gm-xhr-start` envelope to the SW with the serializable
  request fields.
- SW (`src/gm-xhr.ts`) runs `fetch(url, init)` against an
  `AbortController`. On settle it ships a single `sm:gm-xhr-event`
  back to the originating tab via `chrome.tabs.sendMessage`. The
  page-side listener dispatches by request id and invokes the
  stored callback.
- `abort()` fires `onabort` synchronously on the page side AND
  sends a `sm:gm-xhr-abort` to the SW (which `AbortController`s
  the fetch).
- Timeout: SW-side `setTimeout` that calls
  `controller.abort()`. A shadow flag distinguishes timeout from
  user-initiated abort so the right callback fires.

HTTP error statuses (404, 500, …) fire **`onload`** with the error
status — matches XHR semantics; non-network errors are still
"loads". Only network-level failures (DNS, ECONNREFUSED, etc.) and
the `AbortController`-driven aborts fire `onerror` / `ontimeout` /
`onabort`.

Response shape on `onload`:

| Field            | Notes                                              |
|------------------|----------------------------------------------------|
| `status`         | HTTP status number.                                |
| `statusText`     | HTTP status text.                                  |
| `responseURL`    | Final URL after redirects (`res.url`).             |
| `responseText`   | Body as text. Always populated in Phase 8.         |
| `response`       | `responseText` for `text`; parsed object for `json`. |
| `responseHeaders`| Multi-line `Name: value\r\n…` (TM/VM convention).  |
| `finalUrl`       | Same as `responseURL`.                             |

Binary responseTypes (Phase 9): `blob`, `arraybuffer`, `document`.
The SW reads `await res.arrayBuffer()` and ships the bytes back as
base64 + `responseMimeType`. The page-side runtime decodes:

- `arraybuffer` → `Uint8Array.buffer` (plain `ArrayBuffer`).
- `blob` → `new Blob([bytes], { type: responseMimeType })`.
- `document` → bytes decoded as UTF-8 then `new DOMParser()
  .parseFromString(text, parseMime)`, where `parseMime` is
  `application/xml` if the MIME type contains "xml", otherwise
  `text/html`. `responseText` is also populated so userscripts can
  read the raw text.

No offscreen document is involved — the SW serializes response bytes
and the page rebuilds them. TM uses an offscreen doc to get a real
`Blob` constructor; we don't need one because USER_SCRIPT world has
`new Blob(...)` directly. The base64 round-trip costs ~33% wire
overhead vs raw bytes but is robust across the SW/page boundary.

## `@connect` URL gating (Phase 10)

VM-style strict-by-default: a script with no `@connect` lines
in its header is **blocked** from every `GM_xmlhttpRequest`. Scripts
must declare the hosts they intend to reach.

Grammar (lower-case before matching):

- `*` — wildcard, allow any host.
- `self` — allow the script's own `@match`/`@include` hosts (and
  `*.host` subdomains in those globs contribute `host`).
- `example.com` — exact host match.
- `*.example.com` — `example.com` itself **and** any subdomain.
- A scheme-prefixed URL like `https://example.com` is accepted and
  normalized to its host.

The check runs in `handleXhrStart` before `fetch`: the SW looks up
the script's stored header, calls `parseConnectRules` +
`extractSelfHosts`, and `isUrlConnectAllowed`. A denied request
ships an `error` event back to the page with the policy reason as
the message, so the userscript's `onerror` catches it.

The policy is resolved once into a reusable predicate
(`loadConnectPolicy`) that is applied to **both** the initial URL and
the post-redirect URL. `fetch` follows redirects by default, so an
allowlisted host could otherwise 302 to a disallowed one; `runXhr`
re-checks `res.url` whenever the response was redirected and drops the
body (returning an `error`) if the final host fails the policy. See
the redirect note under "Known limitations".

The same trust caveat as the other async-envelope handlers applies:
the message-supplied `scriptId` is wrapper-supplied, so a sibling
userscript that knows another script's id can spoof an XHR under
that script's `@connect` allowlist. Same-extension userscripts are
within the user's trust boundary. Documented limitation; revisit
if real reports come in.

Known limitations (post-Phase 10):

- **No header surgery yet.** `Origin` is the SW's origin
  (`chrome-extension://<id>`), Cookies are SW-managed, forbidden
  headers (Host, Origin, Cookie when overriding the SW's default,
  etc.) silently get stripped by `fetch()`. A future phase will
  add `webRequest.onBeforeSendHeaders` (or DNR session rules) to
  let scripts override these — VM's `requests-core.js` is the
  reference shape. Tagging via a custom request header that the
  listener strips will be the wiring.
- **Redirect re-check blocks reads, not the outbound hop.** The
  post-redirect host check refuses to hand a script the response from
  a non-allowlisted host, but `fetch` has already performed the
  outbound request to the redirect target (it gives no per-hop hook,
  and `redirect:'manual'` yields an opaque response with no readable
  `Location`). So a redirect can still cause an outbound request to a
  disallowed host; no disallowed-host data flows *back* to the script.
- **Response size cap of 50 MB.** The body is streamed and the request
  is aborted once it exceeds `MAX_RESPONSE_BYTES`, so a script can't
  OOM the service worker with a huge fetch. The script sees an `error`
  event. Raise the constant if a real payload needs more headroom.
- **No `onprogress` events** — only the final `load`/`error`/
  `timeout`/`abort` event lands on the page. Adding progress
  would need a streaming wire format.
- **Abort-after-response-arrived narrow race.** If the page calls
  `handle.abort()` AFTER the SW has fired its load event but BEFORE
  the page processes it, the userscript sees `onabort` instead of
  `onload`. A real fix needs a SW round-trip on abort; for v1 the
  page-side abort is synchronous (TM/VM-matching) and the race
  window is small.
- **Per-request TTL of 5 minutes on the page side.** If the SW
  crashes and never sends a terminal event, the page eventually
  synthesizes an `error` event so `activeRequests` doesn't leak
  forever.

## Value-change listeners (`GM_addValueChangeListener` / `GM_removeValueChangeListener`)

Per-script, per-key listener registry living in the page-side
runtime. Listeners fire synchronously on:

- Local `GM_setValue` / `GM_deleteValue` — `remote=false`.
- Remote cross-tab broadcasts — `remote=true`.

Pre-flight cache load (`storage.init`) does NOT fire listeners —
the cache hasn't observably changed from the page's perspective.

API shape matches TM/VM:
- `GM_addValueChangeListener(key, callback)` returns a stable
  listener-id string. `callback(key, oldValue, newValue, remote)`.
- `GM_removeValueChangeListener(listenerId)` unregisters.

Listener throws are caught and logged; one bad listener doesn't
stop sibling listeners from firing. Iteration uses a copy of the
id list so a listener that calls `removeValueChangeListener` during
its own dispatch doesn't corrupt iteration.

### Known limitations

- **Last-150ms-before-tab-close writes can be lost.** The page-side
  cache flushes on `pagehide` and `visibilitychange → hidden`, but
  the resulting `chrome.runtime.sendMessage` is fire-and-forget. If
  the SW is idle/suspended and the tab is closing into bfcache, the
  message can be dropped before the SW listener fires. Writes that
  haven't yet hit the SW are lost. Real-world impact: a write made
  within ~150ms of tab close on the last open tab. Future phases
  can promote this to "write per call" or a synchronous-flush
  option.
- **Storage quota errors are silent.** `chrome.storage.local` has
  per-row and per-extension byte ceilings. If `applyBatchValues`
  fails because of quota, the page-side cache stays inconsistent
  (it has the value the SW doesn't). The `applyBatchValues` rejection
  propagates to the message handler with no SW console line (per the
  no-warn/no-error policy — see [logging.md](logging.md)); the
  userscript sees no error. Future phases can surface this on the
  per-script log.
- **`applyBatchValues` is not transactional.** A batch with both
  sets and removes runs them as two parallel `chrome.storage`
  operations; a failure of one leaves the other applied. Acceptable
  given how reliable `chrome.storage.local` is in practice.
- **Start-race window: a write that fires between a tab's wrapper
  registration and its sm:start arrival isn't broadcast to that
  tab.** The openers table is populated on sm:start, so a write
  during that small window goes only to tabs whose sm:start has
  already been received. The target tab's check-pending snapshot
  already incorporated whatever was in storage when the SW handled
  it; a write that lands after that but before sm:start arrives is
  missed by this tab until the next document. The window closes
  once sm:start lands; subsequent writes broadcast normally.
- **Iframe-of-same-tab broadcast skip.** The openers table dedupes
  by tabId, so a write in the main frame of tab T doesn't broadcast
  to other frames of T (the `tabId === excludeTabId` guard fires
  for every frame in T). Each frame gets its own check-pending
  snapshot at load time; they're consistent at that moment and
  diverge on writes until each frame's next reload. Acceptable for
  now.
- **Cross-script storage spoofing is within the trust boundary.**
  The `scriptId` in the `sm:gm-batch-write` envelope is supplied
  by the wrapper's compiled-in literal. A misbehaving userscript
  in the same USER_SCRIPT realm CAN send a `chrome.runtime.sendMessage`
  with another script's scriptId and overwrite (or read) its values.
  Same trust model as the async-envelope `scriptId` for
  `GM_xmlhttpRequest`. All same-extension userscripts are within
  the user's trust boundary; this is "userscript A messes with
  userscript B's data", not a privilege escalation against the
  user — and it matches what TM/VM actually provide (same-world
  userscripts aren't isolated from each other).
  - Why it has no cheap fix: every USER_SCRIPT-world script shares
    ONE world per frame (one `configureWorld`, no per-script
    `worldId`) and can read sibling ids straight from
    `self.__smPrelude.scripts`. A sibling doesn't *forge* anything —
    it just calls with an id it can see, and the SW can't tell the
    co-world senders apart.
  - Note this is **not** the same as the page-reachable read leak,
    which crossed a real world boundary and IS closed (see the
    forged-`sm:check-pending` entry below).
  - Verifying the envelope's `scriptId` against the tab's active
    registration set does NOT fix this: the victim is active on the
    tab, so an impersonating sibling passes that check. It would only
    reject ids that aren't installed/active — hygiene, not security.
  - A real fix needs a per-script boundary the shared world doesn't
    give us: per-script capability tokens baked into each script's
    in-closure bindings (+ a frozen runtime + shared-builtin tamper
    audit), or per-script isolated `worldId`s (a large redesign — the
    single prelude/runtime/bridge per frame all assume one shared
    world). Deferred until a real compat report justifies the cost.
- **Cross-script storage *reads* via forged `sm:check-pending` — closed.**
  A request with `needsValues:true` and another script's id would
  otherwise get that script's full `GM_setValue` snapshot back in the
  reply (`gmValues`, attached by `loadSnapshotForCheckPending`). Unlike
  the write path, this one is reachable from a hostile **page**, because
  the MAIN-world bridge forwards `sm:check-pending`.
  - The bridge (`wrapper-bridge.js`) now stamps `__viaBridge:true` on
    every message it relays. The page can't strip the marker (it's
    added in USER_SCRIPT world) and can't reach the SW any other way
    (no `chrome.runtime` in MAIN world), so any potentially-page-forged
    request carries it.
  - The check-pending handler refuses to attach `gmValues` to a
    `__viaBridge` request. Storage scripts are always USER_SCRIPT world
    and request values over their own direct `chrome.runtime` path (no
    marker), so nothing legitimate is withheld.
  - Regression coverage: `tests/e2e/gm-storage-read-leak.spec.ts`.

## Clipboard (`GM_setClipboard`)

Page-side via `navigator.clipboard.writeText` (USER_SCRIPT world's
own `navigator`, no SW round-trip). Returns the underlying Promise
so callers can `await`; TM/VM's API returns undefined and is fire-
and-forget — handing back the Promise is the only behavioral
deviation.

Known limitations:

- `type` argument is not honored — only `text/plain` is written.
  `text/html` via `navigator.clipboard.write({ data: new
  ClipboardItem(...) })` is a future-phase upgrade.
- `navigator.clipboard.writeText` may reject with `NotAllowedError`
  on documents that lack focus / transient activation. Most user-
  initiated GM_setClipboard calls (button click, keyboard shortcut)
  have transient activation; idle-timer scripts may need to wait
  for an interaction. TM/VM use an offscreen-doc + `execCommand
  ('copy')` workaround that doesn't require focus — we may revisit
  if real reports come in.

## `GM_log`

Page-side wrapper around `console.log` with an SW-side fan-out so
the call also lands on the script's Log tab in the sources-page
viewer. The binding emitter routes `GM_log(...)` to
`window.__SM_GM__.log.write(scriptId, arguments)`.

Two channels per call:

- **Page DevTools console.** The runtime captures `console.log` at
  init time (so a sibling userscript reassigning `console.log` later
  can't subvert the wrapper) and prepends a
  `[SourceMonkey:<scriptId>]` prefix before forwarding the rest of
  the arguments verbatim. Chrome's `%c`/`%o` formatters and DevTools
  object expansion stay intact because we pass through the original
  argument list.
- **Script Log tab.** A fire-and-forget `sm:gm-log` message is sent
  to the SW (via `__SM_GM__.sendAsync`). The SW handler appends an
  info-level entry with `source: 'gm-log'` and the originating tab
  id. Args are stringified at the page boundary (primitives via
  `String()`, objects via `JSON.stringify`, Errors flattened to
  message + stack, joined by spaces) because the messaging channel
  can only carry structured-cloneable data and the Log tab is
  text-only. Failures in the SW fan-out don't affect the page
  console output — the script's `GM_log` call is sync and never
  awaits the round-trip.

Returns `undefined` (matches TM/VM signature).

## `GM_openInTab`

### Call shape

- `GM_openInTab(url, options?)` — options:
  `{ active?, loadInBackground?, insert? }`. `active` and
  `loadInBackground` are inverses.
- `GM_openInTab(url, loadInBackground)` — legacy positional boolean.
- Returns a control object `{ close, closed, onclose }`
  synchronously.

### SW handler

- `src/gm-tab.ts` calls `chrome.tabs.create`.
- **Only `http(s)` URLs are honored.** The URL is page-supplied, so a
  scheme gate keeps a script from asking the privileged SW to open
  `file://` / `chrome://` / `chrome-extension://` tabs. A rejected URL
  returns `ok:false` and the control's `onclose` never fires.
- `chrome.tabs.onRemoved` routes a `sm:gm-tab-close` back to the
  originating tab so the control's `onclose` fires.

### `insert` positioning

- `insert: true` passes `openerTabId` to `chrome.tabs.create`,
  biasing Chrome to place the new tab adjacent to the originator.
- Best-effort positional only — exact-index would need an extra
  `chrome.tabs.get(opener).index` round-trip we haven't paid yet.

### Per-call state

- Three maps in-memory: `requestId` (page-generated) ↔ `chromeTabId`
  (assigned by `chrome.tabs.create`) ↔ `originatorTabId`.
- On SW restart all three go empty; userscripts holding control
  handles from the prior SW lifetime stop receiving `onclose`
  events. Opened tabs stay open — we don't clean up after a restart.

## `GM_notification`

### Call shape

- Two TM signatures accepted: `GM_notification(details, ondone?)`
  and the legacy positional `GM_notification(text, title?, image?,
  onclick?)`.
- The page-side runtime normalizes both to one `details` payload.
- Per-call `onclick` / `ondone` callbacks stay page-side (not
  serializable) keyed by a generated `requestId`.

### SW handler

- `src/gm-notification.ts` calls `chrome.notifications.create('',
  options)` (letting Chrome assign the id).
- Stores `chromeNotificationId → (originator, requestId)`.
- Replies with the chrome id; the page-side `GM_notification`
  Promise resolves to it.

### Icon fallback

- `chrome.notifications` requires a non-empty `iconUrl` and
  silently rejects without one.
- When `details.image` is omitted, we fall back to the extension's
  own icon.
- The page-supplied `image` is honored only for `http(s)` / `data:`
  schemes (Chrome fetches `iconUrl` from the privileged extension
  context, so `file://` / `chrome-extension://` images are rejected and
  fall back to the default icon).

### Timeout

- `details.timeout > 0` schedules a SW-side `setTimeout` that calls
  `chrome.notifications.clear`.
- Clearing fires the normal `onClosed` event flow, which routes
  back to the userscript's `ondone`.

### Event routing

- `chrome.notifications.onClicked` → `sm:gm-notification-event`
  (`event: 'clicked'`) to the originating tab.
- `onClicked` is **not** terminal — the user may click then
  dismiss; the page-side keeps the entry alive so `ondone` can
  still fire.
- `onClosed` IS terminal: SW frees the mapping, page-side frees
  the callback slot.

### Manifest

- Requires the `notifications` permission. Without it
  `chrome.notifications` is `undefined`; the SW handler short-
  circuits with `ok:false, error: 'chrome.notifications
  unavailable'` and the page-side Promise re-throws.

### Known limitations

- Click / done callbacks don't survive SW restart — in-memory
  mapping is lost. Open notifications keep showing; events just
  don't reach the userscript.
- Originating-tab close drops the mapping. The notification stays
  on screen but events have nowhere to route.
- `tag` is parsed but unused today — `chrome.notifications` has
  its own notification id semantics; we don't coalesce by tag.

## `GM_registerMenuCommand` / `GM_unregisterMenuCommand`

### Surface

- Userscripts register entries that surface as indented rows in
  SourceMonkey's toolbar-icon right-click menu, one row per
  command, beneath the script's `name | status` line.
- `register` returns an opaque id; pass it to `unregister` to
  remove the entry. Passing `{id: 'stable'}` as the third arg
  locks a stable id so a re-register updates the entry in place.

### Components

- **Page side (`src/wrapper-gm-runtime.js`, `menu` subsystem)** —
  keeps a `commandId → {scriptId, callback}` map. `register` stashes
  the callback locally and sends `sm:gm-menu-register` with
  `{scriptId, commandId, name}`; `unregister` drops the local
  entry and sends `sm:gm-menu-unregister`.
- **SW side (`src/gm-menu.ts`)** — mirrors the (tabId → scriptId →
  commands[]) registry that the action menu renders from. No
  callbacks live here — only the name + id needed to render the
  row and route a fire event back.
- **Action menu rebuild (`src/background.ts`,
  `doRebuildActionContextMenu`)** — folds the per-tab mirror into
  the rebuild after the script rows: each script row gets its
  registered commands appended as `↳ <name>` entries.
- **Overflow planner (`src/action-menu.ts`,
  `planActionMenu`)** — caps the top level at Chrome's 6-item limit
  by reserving one slot for a "More" submenu when the (script row +
  N commands) totals would exceed it. Splits happen between groups,
  never within one — see [matching.md](matching.md#per-tab-badge--tooltip) for the rules.
- **Click routing** — `chrome.contextMenus.onClicked` for an
  `sm-menucmd:<scriptId>:<commandId>` item sends `sm:gm-menu-fire`
  to the active tab. The runtime listener invokes the matching
  local callback.

### Lifecycle

- Registration is scoped to the (tab, document). The SW clears
  the mirror on:
  - Fresh-document navigation (the new wrapper's `sm:start` will
    re-register from scratch).
  - Navigating to a non-injectable URL (`chrome://`, `about:blank`,
    ...).
  - Tab close (`chrome.tabs.onRemoved`).
- SPA pushState / bfcache restore preserves the document, so
  registered commands stay live — matches the page-side
  "callbacks survive in this document" invariant.
- SW restart wipes the in-memory mirror. Page-side callbacks are
  scoped to the same document so they're already gone; the symmetric
  drop is correct.

### Test surface

- `self.SourceMonkey.getActionContextMenu(tabId)` returns the
  rendered (scriptId, commands[]) groups, used by
  `tests/e2e/gm-menu.spec.ts` to assert on registration state
  without driving the real Chrome UI.
- `self.SourceMonkey.getActionContextMenuPlan(tabId)` returns the
  planned `{ top, more }` layout the SW would hand to
  `chrome.contextMenus`. Lets tests verify overflow packing without
  inspecting the real Chrome menu (which Playwright can't reach).
- `self.SourceMonkey.fireActionContextMenuItem(tabId, scriptId,
  commandId)` synthesizes a click on a specific entry by sending
  the same `sm:gm-menu-fire` message the real click handler does.
  Returns `{ok:false}` for stale or unknown ids.

## `window.onurlchange`

`@grant window.onurlchange` is the one grant whose payload is an
**event surface**, not a callable. See
[supported-GM-APIs.md](supported-GM-APIs.md#non-gm-grants) for the
user-facing contract.

### What the grant emits

- No `const` binding — `window.onurlchange` isn't a legal identifier.
- The binding emitter appends one eager statement to `js`:
  `window.__SM_GM__.urlchange.enable(scriptId)`.
- It lives in `js` rather than `prelude` on purpose: both strings are
  spliced into the same main-body wrap function (so the runtime is
  equally guaranteed to be installed), but only `js` is also
  prepended by `buildSwapEvalBody`, so a hot-swapped script keeps the
  surface.
- Installation is **lazy per document**: the surface only appears once
  some script calls `enable`. An ungranted script must see
  `window.onurlchange === undefined` so its feature test correctly
  reports "unsupported".

### Where the signal comes from

USER_SCRIPT world does not share `window.history` with the page.
Patching `history.pushState` there produces a function only
isolated-world code ever calls; the page's own SPA router keeps
calling the real one. So the signal comes from the service worker:

| Navigation | `chrome.webNavigation` event |
|---|---|
| `pushState` / `replaceState` | `onHistoryStateUpdated` |
| same-document back / forward | `onHistoryStateUpdated` |
| fragment change (`location.hash = …`) | `onReferenceFragmentUpdated` |

Both are forwarded to the exact `(tabId, frameId)` that changed as an
`sm:url-change` message carrying the reported URL, which the page-side
runtime replays verbatim to its listeners.

**These are the same two events Tampermonkey uses.** Verified in TM
5.5.0's `background.js`, which logs "webNavigation
onReferenceFragmentUpdated or onHistoryStateUpdated not supported,
onurlchange will not work!" when they're missing.

Sourcing them identically is what buys us TM's firing rules without
reverse-engineering them:

- nothing on initial load;
- nothing on a cross-document navigation;
- one event per reported history update;
- **no de-duplication** — a `replaceState` back to the current URL
  fires under TM, and fires here.

An earlier draft tapped page-side `popstate` / `hashchange` as a
second source and de-duped on `location.href`. Dropped because it:

- coalesced bursts of history updates into one event,
- swallowed same-URL replaces, and
- needed the de-dup only to stop the two sources double-firing.

### Why not a MAIN-world history patch

- It would put a SourceMonkey wrapper on `history.pushState` on every
  page, visible to the page, un-patchable by us if the page replaces
  it back, and usable by the page to forge navigations.
- Chrome already reports exactly the missing case for free, under a
  permission (`webNavigation`) the manifest already holds and
  `background.ts` already subscribes to for tab status.

### Why an internal listener table, not a real DOM event

The obvious implementation — `window.dispatchEvent(new
CustomEvent('urlchange', …))` — needs no patching and would even
reach MAIN-world scripts. It's rejected because events dispatched at
the shared `window` cross the world boundary:

- the page could **observe** every urlchange we deliver, and
- the page could **forge** one with an arbitrary `url`, feeding a
  userscript a URL the document was never at.

So the runtime keeps its own handler list and patches
`window.addEventListener` / `removeEventListener` on the isolated
world's `window`:

- only the `urlchange` type is intercepted; every other type forwards
  to the captured original,
- the receiver is normalized so a detached
  `var add = window.addEventListener` still works,
- the originals are captured at install time, not runtime-init time,
  so a sibling userscript's legitimate wrapper stays in the chain.

TM lands in the same place from the other direction: it dispatches no
real event either, so `unsafeWindow.addEventListener('urlchange', …)`
and `document.addEventListener('urlchange', …)` are dead under TM too.

### Payload and handler slot

- Listeners receive a **null-prototype plain object whose only own
  property is `url`** — matching TM byte for byte. Not an `Event`, no
  `type`, no `oldURL`. (TM declined a request to add `oldURL` in
  Tampermonkey#2601.)
- Handlers are invoked with no `this`, as TM does.
- `window.onurlchange = fn` registers into the **same** list as
  `addEventListener`, because TM's setter literally calls its sandbox
  `add`/`removeEventListener`. So dispatch order is true registration
  order across both forms, `= null` unregisters, and re-assigning
  swaps the handler.
- Assigning a non-function stores the value (so the getter
  round-trips) but registers nothing, and logs a `console.info`. TM
  warns in the same situation.

### Observable differences from Tampermonkey

- **Grant enforcement is per-document, not per-script.** USER_SCRIPT
  world is one realm per extension per document, so once any script on
  the page grants the API, a sibling SourceMonkey script that did NOT
  grant it can also see `window.onurlchange` and register listeners.
  TM gives each script its own sandboxed `window` and gates the
  background subscription per script, so its enforcement is exact.
  Same shared-realm root cause as the cross-script storage caveat
  above; a real fix needs per-script worlds.
- **MAIN world is unsupported.** A script with an explicit
  `@inject-into page` gets no `urlchange` surface, because MAIN-world
  scripts get no GM bindings at all (see *World gating*) and because
  installing the patch there would mutate the page's own `window`.
  `@grant window.onurlchange` on its own puts the script in
  USER_SCRIPT world, so this only bites the explicit combination.
- **Latency.** Both managers round-trip through their background
  page, so both are asynchronous rather than synchronous with the
  `pushState` call. TM measures ~20–40 ms locally; we do one less hop
  (no MAIN↔content relay) but a cold MV3 service worker can add to
  either.
- Everything else — which navigations fire, the absence of an
  initial-load event, no de-duplication, frame scoping, the payload
  shape — is matched deliberately.

### Known limitations

- Listener `options` are ignored for the `urlchange` type — no
  `once`, no `capture`, no `signal`, and object listeners with a
  `handleEvent` method aren't accepted (functions only). Whether TM
  honors any of these is unverified.
- A listener registered by script A is removable by script B if it
  holds the same function reference — a consequence of the shared
  table, and not reachable in practice.
- Every same-document navigation in every tab costs one
  `chrome.tabs.sendMessage`. It is deliberately **not** gated on
  "some script here granted the API": that state would have to
  survive SW restarts (userScripts registrations do; SW memory
  doesn't) and would fail silently when it didn't. Frames with no
  SourceMonkey runtime just reject the send, which we swallow.
- If `chrome.webNavigation`'s same-document events are unavailable,
  the feature is inert and the SW logs one `console.info` at startup
  (TM logs the same).

## DOM injection (`GM_addStyle` / `GM_addElement`)

Both run entirely in USER_SCRIPT world — no SW round-trip, no per-
script state. USER_SCRIPT-world DOM mutations are CSP-exempt (the
same dispensation content scripts get), so userscripts can inject
into pages that ship strict `Content-Security-Policy: script-src
'self'` without `unsafe-inline`.

- `GM_addStyle(css)` — creates a `<style>`, sets `textContent`,
  appends to `document.head || document.documentElement`. Returns
  the element.
- `GM_addElement(tagName, attrs?)` — tag-aware default parent:
  `<head>` for `script`/`style`/`link`/`meta`/`title`/`base`,
  `<body>` for everything else (matches TM/VM). Falls back through
  head / documentElement when body doesn't exist yet (very-early
  `runAt`). Returns the element.
- `GM_addElement(parent, tagName, attrs?)` — appends to the given
  parent node. Two-arg vs three-arg signatures are distinguished by
  whether `arg1` has a `.nodeType`.
- `attrs` is a plain object of attribute names → string values. The
  pseudo-attribute `textContent` sets inner text directly (TM
  convention).

## Phase status

- ✅ **Phase 1** — catalog
- ✅ **Phase 2** — compile-in surface (stubs throw "not implemented yet")
- ✅ **Phase 3** — storage v1 (page-side cache, batched writes, persistence)
- ✅ **Phase 4** — `GM_addStyle` / `GM_addElement` (in-page DOM injection)
- ✅ **Phase 5** — `GM_setClipboard` (via `navigator.clipboard.writeText`)
- ✅ **Phase 6** — cross-tab `GM_setValue` broadcast (openers table + tabs.sendMessage)
- ✅ **Phase 7** — `GM_addValueChangeListener` / `GM_removeValueChangeListener`
- ✅ **Phase 8** — `GM_xmlhttpRequest` text path (GET/POST, text + json, abort, timeout)
- ✅ **Phase 9** — `GM_xmlhttpRequest` binary path (blob, arraybuffer, document; base64 wire, no offscreen doc)
- ✅ **Phase 10** — `@connect` URL gating for `GM_xmlhttpRequest` (header surgery deferred to a future phase)
- ✅ **Post-Phase 10 add-ons** — `GM_log` (page-side `console.log` wrapper), `GM_openInTab` (SW-side `chrome.tabs.create`), `GM_notification` (SW-side `chrome.notifications`), `GM_registerMenuCommand` / `GM_unregisterMenuCommand` (`chrome.contextMenus` entries indented under each script in the action's right-click menu), `window.onurlchange` (SPA `urlchange` event fed by `chrome.webNavigation`'s same-document events, matching TM's own source)
