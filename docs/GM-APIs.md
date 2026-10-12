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
- **`src/extension/gm-bindings.ts`** — per-script emitter. Given the granted set
  + the script's parsed header, returns the JS source to splice into
  the wrapper. Always emits `GM_info` (matching TM/VM: implicit, no
  `@grant` required); emits a `const GM_x = function (...){...}` for
  each granted legacy name; emits a `const GM = {...}` GM4 namespace
  covering the granted APIs with `gmDotName` plus `GM.info`. Neither
  `GM` nor `GM_info` is frozen, as in TM and VM: GM_config and other
  libraries add to `GM`.
- Every script also gets `exports`, `module` and `define` as
  `undefined`, and pass-through `cloneInto` / `exportFunction` /
  `createObjectIn`, as TM and VM give them
  (`FIREFOX_AND_MODULE_NAMES`).
- **`src/wrapper-gm-runtime.js`** — shared runtime (`reg.gm`, in the world's registry; see [injection.md](injection.md#the-channel-key)),
  registered once per page **per execution world** at `document_start`.
  The same source runs in USER_SCRIPT and in MAIN; it picks its
  transport at init (direct `chrome.runtime` vs. the DOM-event
  bridge). Provides:
  - Shim cache of native references (Promise, Error, JSON.parse/
    stringify, etc.) — defends against sibling userscripts that
    monkey-patch builtins.
  - `sendAsync(payload)` — SW round-trip helper. In USER_SCRIPT world
    it routes through a captured `bind`-ed
    `chrome.runtime.sendMessage`; in MAIN world it dispatches a
    `sourcemonkey-sync-<key>` event that `wrapper-bridge.js` forwards,
    keyed on a per-call `requestId`.
  - `onPush(handler)` — SW-originated events (XHR settling, value
    broadcasts, menu fires). `chrome.runtime.onMessage` in USER_SCRIPT
    world; `sourcemonkey-push-<key>` events in MAIN.
  - `notImplemented(name)` — Phase 2 placeholder; later phases
    replace per-subsystem methods.
- **`src/extension/injector.ts`** — wires the emitter and runtime into the
  registration pipeline. `buildGmBindingsForScript` produces the
  per-script collection; `buildGmRuntimeSpecs` returns one runtime
  registration per world that needs it, alongside `buildBridgeSpec`.
- **`src/extension/gm-url-change.ts`** — SW-side driver for
  `@grant window.onurlchange`. Forwards
  `chrome.webNavigation.onHistoryStateUpdated` to the document that
  changed as an `sm:url-change` message.
- **`src/extension/gm-window-control.ts`** — SW-side driver for
  `@grant window.close` / `@grant window.focus`. Re-issues the call as
  `chrome.tabs.remove` / `chrome.windows.update` on the sender's own
  tab.

## Bindings layout in the wrapper

`emitGmBindings` returns `{js, prelude}` — both strings are
spliced into the combined user-program wrap function
(`wrapCombinedEntry` in `src/extension/injector.ts`), so they're locals of that
function and visible to the user body via closure. The user program
runs in a scope nested inside it, so a script declaring one of these
names shadows ours (see
[injection.md](injection.md#the-user-program-scope)):

- `js` — lazy `const GM_X = ...` declarations plus the GM4 alias
  object. Each declaration only dereferences `reg.gm`
  from inside its own function body, so emitting them this early
  is safe even when the runtime spec hasn't run yet — the
  dereference doesn't fire until the user body actually calls a
  `GM_*` API. The eager calls ride along at the end —
  `urlchange.enable`, `windowControl.enable` / `.make`, and
  `resource.init` —
  because they need nothing but the runtime and baked literals, which
  makes them safe in the swap eval that also gets this string.
- `prelude` — eager `reg.gm.*` calls that need identifiers only
  the wrap function has — today just
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
  swap-evaluated body doesn't see the spliced bindings —
  `buildSwapEvalBody` prepends its own copy of the `js` block
  instead. `storage.init` is the exception (it needs
  `__smDecision`): the prelude runs that one itself before the eval,
  from the `gmValues` the SW attaches to the `run-new` reply. See
  [injection.md](injection.md#wrapper-protocol).

## World gating

Binding emission is world-independent — the same `emitGmBindings`
output ships whether the script lands in USER_SCRIPT or MAIN.

- `GM_info` is emitted for every script regardless of `@grant`. It's a
  baked literal with no runtime dependency. Matches TM/VM (both expose
  GM_info implicitly).
- `unsafeWindow` is a plain `const unsafeWindow = window;` in both
  worlds. What makes it correct is the world, not the binding — see
  [injection.md](injection.md#unsafewindow-is-the-pages-window).
  - Emitted for a script that only *uses* the name too, with no
    `@grant` line for it (`StoredScript.usesUnsafeWindow`).
- Everything else — including the `window.onurlchange` event surface
  and the `window.close` / `window.focus` overrides — delegates to
  `reg.gm`, which is registered in whichever worlds have a
  script granting a runtime-backed API (`buildGmRuntimeSpecs`). A
  `@grant none` MAIN-world script needs none of it, so its page stays
  free of the runtime.
- MAIN-world SW traffic rides `wrapper-bridge.js` in both directions,
  and script-scoped requests are gated SW-side by `bridgeMayActAs`.
  See [`GM_*` in MAIN world](injection.md#gm_-in-main-world).

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
  in-page via the GM runtime — no SW round-trip. The Phase-2
  stub calls `reg.gm.notImplemented(name)` which throws an
  explanatory error.
- **Async** APIs (`GM_xmlhttpRequest`/`GM_setClipboard`/...) build a
  message envelope (`{type: 'sm:gm-call', api, scriptId, args}`) and
  route through `reg.gm.sendAsync(...)` to the SW. Phase 2 has no
  SW-side handler yet — the call ultimately rejects.

## Caveats and Phase-2 limitations

- **`unsafeWindow` is real.** Scripts run in MAIN world unless they
  ask for isolation, so it is the page's own `window`, granted or just
  used. The only case where it can't be is `@inject-into content` or
  `@sandbox DOM`, which pin the script to the isolated world; that
  combination gets a startup-log warning instead of a silent wrong
  answer. See
  [injection.md](injection.md#unsafewindow-is-the-pages-window).
- **Runtime ordering safety rests on the wrap function, not on
  laziness.** Everything the emitter produces — the `const GM_X = ...`
  declarations, the eager `urlchange.enable` /
  `windowControl.enable` / `.make` / `resource.init` at the end of
  `js`, and the
  eager `prelude` call (`storage.init`) — is
  spliced into the main-body wrap function, which the prelude invokes
  only after its `awaitDecision` + `waitForRunAt` gates resolve (both
  `sm:check-pending` and the declared `@run-at` event). So
  `chrome.userScripts`'s document_start registration order doesn't
  have to be a guarantee.
  - The declarations are additionally lazy (they read
    `reg.gm` only from inside their own bodies), which is
    belt-and-braces rather than the load-bearing argument.
  - The eager forms differ deliberately on failure: a missing runtime
    makes `urlchange.enable` / `windowControl.enable` / `.make` a no-op
    (the script runs without the feature), while a missing storage snapshot
    aborts the body (running with stale values would corrupt the
    user's data).

- **Prelude throws bypass the body's try/catch.** The GM prelude
  is spliced into the same main-body wrap function as the body,
  AHEAD of the body — a `storage.init` throw (only possible if
  `reg.gm` is somehow *still* undefined after `waitForRunAt`) is
  caught by the prelude's `try { fn() } catch` in `runMain` and
  surfaces as a normal `sm:error`. In normal operation the runtime is
  guaranteed installed by then, so this is mostly theoretical.

- **Cross-tab `applyRemoteUpdate` ignores writes before init.** The
  remote-update handler early-returns when the per-script store
  isn't `ready`. Since the GM prelude runs only after the
  `waitForRunAt` gate resolves,
  `ready` flips later than it used to (after the declared `@run-at`
  lifecycle event). For `@run-at document-idle` the gap can stretch
  to `readyState` `complete`, or 200ms after `DOMContentLoaded` when
  `load` is later. A sibling tab's `GM_setValue` that broadcasts
  during that window gets dropped on the floor by this document. In
  the common case the same write is already reflected in the
  check-pending snapshot the SW sent us (the SW persisted it before
  broadcasting), so the body sees it anyway. The edge case: the
  write hits the SW AFTER we've issued check-pending but BEFORE
  `ready` flips — the snapshot is older than the broadcast and we
  drop the broadcast. Rare in practice (cross-tab traffic during
  page load is uncommon) but worth knowing. A script with a
  value-change listener catches up on the next resync
  ([GM-APIs-storage.md](GM-APIs-storage.md#resync-recovering-a-document-that-missed-one));
  one without stays behind until its next document.
- **`GM_info.script.grant` is the canonicalized set, not the raw
  `@grant` lines.** `@grant GM.setValue` shows up as `GM_setValue` in
  `GM_info.script.grant`. TM and VM both report the raw declared form
  instead (VM's `GM_info.script` is its parsed metadata object —
  deduped, not rewritten). Worth revisiting if any real compat
  reports come in.
- **`GM_info` carries the fields TM and VM both expose.** Beyond
  `script.{name,version,namespace,description,matches,includes,excludes,grant,run-at}`,
  `scriptHandler`, `version`, `scriptMetaStr` and `uuid`:
  - Where TM and VM disagree on a key (TM `run-at` vs VM `runAt`, TM
    `connects` vs VM `connect`), the spelling that matches the header
    tag wins.
  - `script.require` — `@require` refs; `script.resources` — `{name,
    url}` per `@resource`. Both carry the ref as written (`./lib.js`),
    like TM/VM, not the resolved URL; they list the loaded files
    (deduped, and the prior good set after a failed refresh).
  - `script.connect` — `@connect` hosts; `script.noframes` — whether
    `@noframes` is present.
  - `script.author` / `homepage` / `icon` / `icon64` / `supportURL` /
    `updateURL` / `downloadURL` / `copyright` / `license` — header
    values, `null` when absent (TM's shape; TM's aliases fold in —
    `@homepageURL` / `@website` / `@source` → `homepage`, `@iconURL` /
    `@defaulticon` → `icon`, `@icon64URL` → `icon64`).
  - `scriptWillUpdate: true` (scripts are re-read from their
    collection on refresh) and `userAgentData` (a snapshot of
    `navigator.userAgentData`, taken in the SW at bake time).
  - Not provided: `isIncognito` (GM_info is baked per script, not per
    tab, so the value isn't knowable at bake time), `downloadMode`,
    and the manager-internal `script.options` blob.
  - The `gm-info` example page shows each manager's output side by
    side.
- **Unknown `@grant` names log a console warning.** A typo like
  `@grant GM_setvalue` (lowercase) is dropped from the binding set
  and the script gets a `ReferenceError` at call time. The injector
  logs the dropped names at `console.info` so a debugger can spot
  the cause.
- **Async-envelope `scriptId` is wrapper-supplied.** Sibling
  userscripts in the same USER_SCRIPT world can in principle call
  `reg.gm.sendAsync({api, scriptId: 'other-id', args})` to
  impersonate each other's `@connect` allowlist. Same-extension
  scripts are inside the trust boundary, so this is a "userscript A
  borrows userscript B's permissions" situation, not a privilege
  escalation against the user. The Phase-8/10 SW handler should
  still treat the scriptId as wrapper-supplied data, not authenticated.

## GM4 alias namespace

`GM` is a `const` built at compile time, and not frozen, as in TM and
VM (GM_config and other libraries add to it). Each granted API
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
Response types `text` (default), `json`, `blob`, `arraybuffer`,
`document` and `stream`, with the body streamed to the page; header surgery and
`@connect` gating are below.

Architecture:

- Page-side `GM_xmlhttpRequest(details)` returns `{abort}`
  synchronously. The runtime stores the callbacks
  (`onloadstart`/`onprogress`/`onreadystatechange`/`onload`/
  `onerror`/`ontimeout`/`onabort`/`onloadend`) keyed by a generated
  request id (callbacks aren't serializable
  across the bridge), and ships a `sm:gm-xhr-start` envelope to the
  SW with the serializable request fields.
  - A `URL` object as `url` is taken as its `href`, as in VM.
    `GM_download` and `GM_openInTab` accept one too (`urlArg`).
- SW (`src/extension/gm-xhr.ts`) runs `fetch(url, init)` against an
  `AbortController`, and sends `sm:gm-xhr-event`s back to the
  originating frame via `chrome.tabs.sendMessage`. The page-side
  listener dispatches them by request id. See
  [Streaming the response](#streaming-the-response).
- `abort()` fires `onabort` synchronously on the page side AND
  sends a `sm:gm-xhr-abort` to the SW (which `AbortController`s
  the fetch).
- Timeout: SW-side `setTimeout` that calls
  `controller.abort()`. A shadow flag distinguishes timeout from
  user-initiated abort so the right callback fires.
- There is no default `timeout`, so a second SW-side timer
  (`XHR_HEADER_STALL_MS`) bounds the wait for *response headers* only —
  the phase the header rule is live for. A slow body is untouched. See
  [xhr-header-surgery.md](xhr-header-surgery.md#what-ends-a-rule).
- Closing a tab aborts its in-flight requests (`abortXhrsForTab`, from
  the `chrome.tabs.onRemoved` listener) — the response has nowhere to
  go, and leaving it running would hold a header rule live.

Credentials:

- `runXhr` (`src/extension/gm-xhr.ts`) passes `credentials: 'include'` in the
  options object it hands `fetch`, so requests carry the user's
  cookies for the target host. TM/VM do the same.
- `anonymous: true` in the details object opts one request out
  (`'omit'`).
- `'include'` is explicitness rather than a behavior fix. Chrome
  already sends cookies on an extension fetch to a host the extension
  has permission for, and we hold `<all_urls>` — measured: the
  default-case e2e test passes with the option removed. What the
  option buys is that the behavior stops depending on that grant, and
  `anonymous` gets a symmetric counterpart.
- Off-permission hosts (Chrome's restricted set) become ordinary CORS
  requests, where `'include'` rejects an
  `Access-Control-Allow-Origin: *` response the default mode would
  have taken. `anonymous: true` restores the wildcard-compatible mode.
- `@connect` is the gate: allowlisting a host lets the script act as
  the user there. The off-allowlist redirect hop described under
  "Known limitations" is credentialed too — unreadable by the script,
  but a real side effect on a host the header never named.

Forbidden request headers:

- `fetch()` silently drops the headers the Fetch Standard (the web
  standard behind `fetch`) reserves for the browser to set
  (`Origin`, `Referer`, `Cookie`, `User-Agent`, `Sec-*`, …), in the
  service worker exactly as on a page. `src/extension/gm-xhr-headers.ts` puts
  them back: they're compiled into a short-lived
  `declarativeNetRequest` session rule instead of being handed to
  `fetch`, because MV3 has no blocking `webRequest`.
- The request goes out as `<url>#sm-xhr-<rule id>`, and the rule is
  keyed on that exact string plus `tabIds: [-1]` and our own extension
  id as the initiator. It comes off as soon as `fetch` resolves.
- The fragment is a per-request discriminator that never reaches the
  server, so a rule applies to the one request that installed it and
  overlapping same-URL requests can't contaminate each other.
- `Origin` is the one header changed unasked (removed, on methods that
  send one). `Sec-Fetch-Site` — the header the feature exists for — is
  never defaulted.
- Full treatment, including targeting, failure handling and the blind
  spots: [xhr-header-surgery.md](xhr-header-surgery.md).

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
| `responseText`   | Body as text, for `text`, `json` and `document`; `''` for `blob` and `arraybuffer`. |
| `response`       | The text for `text`; parsed object for `json`; a `Blob`, `ArrayBuffer` or `Document` for the others. |
| `responseHeaders`| Multi-line `Name: value\r\n…` (TM/VM convention).  |
| `finalUrl`       | Same as `responseURL`.                             |
| `readyState`     | `4`, set page-side on every terminal event.        |

Binary responseTypes are rebuilt page-side from the body's bytes and
the `Content-Type` (`responseMimeType`):

- `arraybuffer` → one `ArrayBuffer` of all the pieces.
- `blob` → `new Blob(pieces, { type: responseMimeType })`.
- `document` → the text, then `new DOMParser().parseFromString(text,
  parseMime)`, where `parseMime` is `application/xml` if the MIME type
  contains "xml", otherwise `text/html`. `responseText` is also
  populated so userscripts can read the raw text.

No offscreen document is involved — the SW serializes response bytes
and the page rebuilds them.

- TM uses an offscreen doc to get a real `Blob` constructor, and
  VM's MV3 build does too: its `XMLHttpRequest` runs there and
  leases blob URLs, falling back to base64 chunks in incognito,
  where Chrome won't fetch a blob URL.
- We don't need one because USER_SCRIPT world has `new Blob(...)`
  directly.
- The base64 round-trip costs ~33% wire overhead vs raw bytes but is
  robust across the SW/page boundary.

### Streaming the response

The body goes to the page in pieces as it arrives, never whole, so
there's no size cap and the worker never holds much of it.

- Events per request, in order (`GmXhrStreamEvent`, then `GmXhrEvent`
  in `src/gm-xhr-types.ts`):
  - `headers`: status, final URL, response headers, and the body's
    length when known.
  - `progress`, per piece: up to 1 MiB of the body, base64, with the
    bytes so far.
  - One terminal event: `load` (with no body of its own), `error`,
    `timeout` or `abort`.
- SW side (`streamBody` in `gm-xhr.ts`):
  - Each event's `sendMessage` is awaited, so events arrive in order.
  - A piece goes out as soon as the previous one is delivered,
    holding what arrived meanwhile. A trickle reaches the page
    promptly; a fast download goes in 1 MiB pieces.
  - Reading waits only when a full piece is queued behind a send, so a
    slow page holds back the download rather than the worker
    buffering it.
    - The brake works because a send resolves once the page's
      listeners have run (none calls `sendResponse`).
    - For a page-world script the listener is the bridge, which only
      re-posts the piece, so there the page's own pace doesn't slow
      the download.
  - Sends are addressed to the requesting document (`documentId`), so
    one fails once that page is closed or navigated away. A failed
    send aborts the fetch.
- The body's length (`total`, so `lengthComputable`) is the
  `Content-Length`, except with a `Content-Encoding`: that header
  counts the encoded bytes, and the reader gives decoded ones.
- Page side (`wrapper-gm-runtime.js`):
  - Text types go through a streaming `TextDecoder`, so `responseText`
    grows during `onprogress` (a multi-byte character split across
    pieces is joined). Binary types keep the byte pieces.
  - `responseType: 'stream'` (TM's): `response` is a `ReadableStream`,
    made with the request so `onloadstart` already has it, and each
    piece is enqueued as it arrives.
    - The runtime keeps no pieces; the stream's queue holds what the
      script hasn't read. Nothing slows the worker for an unread one.
    - `load` closes it. A failure errors it, as a fetch body's would:
      with the error's message, or an `AbortError` / `TimeoutError`.
    - Cancelling it gives up on the request: the worker stops, and the
      request ends as aborted.
  - Callbacks, in XMLHttpRequest's order: `onloadstart` when the SW
    acks the start; `onreadystatechange` at 2 (headers) and 3 (first
    piece); `onprogress` per piece (`lengthComputable`, `loaded`,
    `total`); then `onreadystatechange` at 4, the terminal callback,
    and `onloadend`.
  - The page's 5-minute give-up timer is re-armed by every event, so
    it times silence from the worker, not the whole transfer.
  - A body too big for the page to hold (past a string's length limit,
    say) ends the request with an `error` naming the cause and
    suggesting `blob` or `stream`, and the worker is told to stop.
  - A callback that aborts the request ends its callbacks there.

## `@connect` URL gating

Which sites a script's `GM_xmlhttpRequest` may reach, and the prompt
that asks about the rest: see
[connect-permissions.md](connect-permissions.md).

## `GM_xmlhttpRequest` known limitations

- **Header surgery has blind spots** — redirects lose the overrides.
  (Same-URL overlap is closed by the per-request URL tag.) Described in
  [xhr-header-surgery.md](xhr-header-surgery.md#blind-spots).
- **No upload progress** (`upload.onprogress`): the request body goes
  out in one `fetch`, which reports nothing as it sends.
- **Abort-after-response-arrived narrow race.** If the page calls
  `handle.abort()` AFTER the SW has fired its load event but BEFORE
  the page processes it, the userscript sees `onabort` instead of
  `onload`. A real fix needs a SW round-trip on abort; for v1 the
  page-side abort is synchronous (TM/VM-matching) and the race
  window is small.
- **A 5-minute silence timer on the page side.** If the SW crashes and
  never sends a terminal event, the page synthesizes an `error` event
  so `activeRequests` doesn't leak forever. Every event re-arms it, so
  it times silence, not the transfer, and when it fires it tells the
  SW to stop.

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

- **Values not yet saved are lost if the worker is killed.** The
  worker saves writes to disk just behind taking them, so values from
  the last moments before the browser exits or crashes, or the
  extension reloads or updates, can be lost. See
  [GM-APIs-storage.md](GM-APIs-storage.md#the-workers-value-store).
- **Storage quota errors reach the Log, not the script.**
  `chrome.storage.local` has per-row and per-extension byte ceilings.
  A value-store save that fails puts an error on the script's Log
  (naming how full storage is, when it's nearly full), so the badge
  shows it. The value stays only in memory, in the store's map and
  the page caches, until the worker shuts down. The userscript itself
  sees no error. See
  [GM-APIs-storage.md](GM-APIs-storage.md#the-workers-value-store).
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
  missed by this tab until the next document — or until its next
  resync, for a script with a value-change listener. The window
  closes once sm:start lands; subsequent writes broadcast normally.
- **The writer's own tab is sent to frame by frame.** The openers
  table dedupes by tabId, so the writer's tab gets the update in each
  of its frames but the writer's (`chrome.webNavigation.getAllFrames`),
  rather than one tab-wide send that would echo back to the writer.
  See [frames.md](frames.md#gm-apis).
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
  - VM raises the bar a little without changing the model: each
    script gets its own bound `GM` wrapper, and the script id lives
    in that closure inside VM's injected bundle — the content side
    neither binds nor checks it. A sibling has to reach the wrapper
    (or the module-scoped bridge) rather than just name another id in
    a message. Sharing a realm still means sharing everything else.
  - Why it has no cheap fix: every USER_SCRIPT-world script shares
    ONE world per frame (one `configureWorld`, no per-script
    `worldId`) and can read sibling ids straight from
    `reg.prelude.scripts`. A sibling doesn't *forge* anything —
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
  the write path, this one would be reachable from a hostile **page**
  that got onto the MAIN-world bridge, which forwards `sm:check-pending`.
  The channel key keeps the page off the bridge
  ([injection.md](injection.md#the-channel-key)); behind it:
  - The bridge (`wrapper-bridge.js`) now stamps `__viaBridge:true` on
    every message it relays. The page can't strip the marker (it's
    added in USER_SCRIPT world) and can't reach the SW any other way
    (no `chrome.runtime` in MAIN world), so any potentially-page-forged
    request carries it.
  - The check-pending handler runs every `__viaBridge` request through
    `bridgeMayActAs` before attaching `gmValues`: only a script that
    actually runs in MAIN world on the sending page, with a storage
    grant, gets its snapshot. A USER_SCRIPT-world script is never in
    that set.
  - USER_SCRIPT-world scripts request values over their own direct
    `chrome.runtime` path (no marker) and skip the gate entirely, so
    nothing legitimate is withheld.
  - The push direction is gated symmetrically: `wrapper-bridge.js`
    re-sends an SW push into MAIN world only when the SW stamped it
    `smWorld: 'MAIN'`, so an isolated script's `sm:gm-value-update`
    writes and `sm:gm-xhr-event` response bodies never go into the
    page's world.
  - Regression coverage: `tests/e2e/gm-storage-read-leak.spec.ts`, plus
    the forged-GM-call and broadcast-relay cases in
    `tests/e2e/gm-unsafe-window.spec.ts`.

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
  for an interaction. TM and VM both use an offscreen-doc +
  `execCommand('copy')` workaround that doesn't require focus (VM's
  is `src/common/clipboard.js`, run in its MV3 offscreen document,
  and it honors the `type` argument through
  `clipboardData.setData`) — we may revisit if real reports come in.

## `GM_log`

Page-side wrapper around `console.log` with an SW-side fan-out so
the call also lands on the script's Log tab in the collections-page
viewer. The binding emitter routes `GM_log(...)` to
`reg.gm.log.write(scriptId, arguments)`.

Two channels per call:

- **Page DevTools console.** The runtime captures `console.log` at
  init time (so a sibling userscript reassigning `console.log` later
  can't subvert the wrapper) and prepends a
  `[SourceMonkey:<scriptId>]` prefix before forwarding the rest of
  the arguments verbatim. Chrome's `%c`/`%o` formatters and DevTools
  object expansion stay intact because we pass through the original
  argument list.
- **Script Log tab.** A fire-and-forget `sm:gm-log` message is sent
  to the SW (via `reg.gm.sendAsync`). The SW handler appends an
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

- `src/extension/gm-tab.ts` calls `chrome.tabs.create`.
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

- `src/extension/gm-notification.ts` calls `chrome.notifications.create('',
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

## `GM_download`

User-facing surface (call shapes, error values, caveats) lives in
[supported-GM-APIs.md](supported-GM-APIs.md#downloads). This section
records the implementation and the choices behind it.

### Split transport

The page-side runtime picks by URL scheme:

- `http(s)` → `sm:gm-download-start` to the SW, which drives
  `chrome.downloads` (`src/extension/gm-download.ts`).
- `blob:` / `data:` → an `<a download>` click in the page; the SW is
  never involved.

Why the split:

- A page-minted `blob:` URL is registered against the *page's* origin.
  The extension's SW can't resolve it, and MV3 service workers have no
  `URL.createObjectURL` to re-mint one.
- Streaming a multi-GB video through `chrome.runtime.sendMessage` to
  re-materialize it elsewhere would burn memory for a worse result.
- The anchor click is what the same userscript would do with no
  `@grant` at all, so the in-page path grants no capability the script
  didn't already have.

### Rejected alternatives

- **Offscreen document + `BLOBS` reason** (the shape TODO.md
  originally sketched): only needed if the SW had to fetch bytes and
  hand them to something that can mint a blob URL.
  `chrome.downloads.download` fetches the URL itself — including
  `headers` — so the whole detour disappears.
- **Fetch in the SW, then download from the result**: loses
  `Content-Disposition` handling, resume, progress accounting and the
  Save-As dialog, and re-introduces the memory problem.
- **`@connect` gating** — see
  [supported-GM-APIs.md](supported-GM-APIs.md#connect-does-not-gate-downloads)
  for why download URLs can't live in a header allowlist and why the
  exfiltration threat `@connect` addresses doesn't apply here.

### SW-side state

- `requestId → entry` plus a `downloadId → requestId` index, both
  in-memory (same lifetime story as `gm-tab` / `gm-notification`).
- Each entry carries the emit closure the message handler built, the
  timeout timer, and the progress interval.
- `chrome.downloads.onChanged` is the terminal-event collection:
  `state.current === 'complete'` → `load` (after a
  `chrome.downloads.search` for filename + size), `'interrupted'` →
  `error`/`not_succeeded` with `delta.error` passed through as
  `{current, previous}`.
- The poll (`chrome.downloads.search`, 500 ms) runs for every in-flight
  download, not just the ones that asked for progress. It has three
  jobs: byte counts for `onprogress` (the onChanged delta doesn't carry
  `bytesReceived`), a backstop for a missed terminal delta, and
  keep-alive — each API call postpones the SW's ~30 s idle shutdown,
  which a minutes-long download would otherwise hit, taking the
  in-memory routing tables with it.
- Terminal handlers release the entry *before* emitting, so a callback
  that immediately starts another download can't collide with the one
  it just settled.
- **Terminal-state catch-up.** The onChanged delta is keyed by download
  id, which we only learn when `chrome.downloads.download` resolves —
  a small or cached file can settle inside that window and its delta
  is dropped. The poll's first tick fires immediately for that reason.
  Racing the real delta is harmless: the first one through releases the
  entry, the loser finds nothing.
- **The timeout is armed before the download is created**, not after.
  Chrome doesn't return a download id until the server answers, so a
  timer armed after the await could never fire for the case that most
  needs it — a host that accepts the connection and then stalls.

### Cancellation

- The page settles `abort()` locally and immediately (matching
  `GM_xmlhttpRequest`), then fires `sm:gm-download-abort`.
- The SW cancels via `chrome.downloads.cancel` and drops the entry, so
  the `USER_CANCELED` interrupt that follows finds nothing and can't
  double-report.
- `abort()` racing the initial `chrome.downloads.download` sets
  `cancelRequested`; the start path cancels as soon as it has an id
  (same shape as `gm-tab.ts`'s `closeRequested`). A timeout that fires
  in the same window takes the same handoff.
- A tab that closes mid-start is checked for explicitly: the start path
  re-reads the entry after the await, because `dropOriginator` may have
  swept it, and re-registering would leave a poll timer nobody can
  clear.

### Safety gates

- Scheme allowlist in the SW (`http(s)` only) — the URL is
  page-supplied, so without it a script could ask the privileged SW to
  pull `file:///…` onto disk.
- `validateDownloadName` rejects absolute paths, `..` traversal,
  control characters and empty segments; relative subdirectories are
  allowed. Chrome would reject most of these anyway, but doing it here
  turns an opaque `not_succeeded` into a clean `not_permitted`.
- Both checks run in the SW (not page-side) so refusals also reach the
  per-script Log.

## `GM_registerMenuCommand` / `GM_unregisterMenuCommand`

### Surface

- Userscripts register entries that surface as rows in SourceMonkey's
  toolbar popup, under the script's row. A list longer than four
  starts collapsed. See [status-popup.md](status-popup.md).
- `register` returns an opaque id; pass it to `unregister` to
  remove the entry. Passing `{id: 'stable'}` as the third arg
  locks a stable id so a re-register updates the entry in place.

### Components

- **Page side (`src/wrapper-gm-runtime.js`, `menu` subsystem)** —
  keeps a `commandId → {scriptId, callback}` map. `register` stashes
  the callback locally and sends `sm:gm-menu-register` with
  `{scriptId, commandId, name}`; `unregister` drops the local
  entry and sends `sm:gm-menu-unregister`.
- **SW side (`src/extension/gm-menu.ts`)** — mirrors the (tabId → scriptId →
  commands[]) registry that the popup renders from, tagged
  with the `documentId` those commands came from. No callbacks live
  here — only the name + id needed to render the row and route a
  fire event back.
  - Register and unregister both carry the sender's documentId, so a
    message from a document we're no longer holding commands for
    can't reach into the current document's entries. That is
    reachable with an explicit `{id: '...'}`, where the same
    commandId legitimately exists in both documents.
- **Popup (`src/extension/popup-view.ts`, `src/extension/popup.ts`)** —
  the worker folds the per-tab mirror into the popup's view, listing
  each running script's commands under its row, and tells an open
  popup when the mirror changes (`sm:popup-changed`).
- **Click routing** — a click in the popup sends `sm:popup-command`
  to the worker, which checks the command is still registered and
  sends `sm:gm-menu-fire` to the tab. The runtime listener invokes
  the matching local callback.

### Lifecycle

- Registration is scoped to the (tab, document), and the mirror
  stores the `documentId` its commands came from.
- **The invariant**: the mirror holds commands for the document the
  tab is on *now*. The callbacks live in that document, so a mirror
  pointing anywhere else renders rows that can never fire.
- One rule enforces it on navigation, keyed on the document being
  entered: **drop the mirror unless it already belongs to that
  document.**
  - Fresh document → the old commands go; the new wrapper
    re-registers from scratch.
  - bfcache restore back to an *earlier* document → the later
    document's commands go too.
    - **Known gap**: the restored document's own commands do not come
      back. The clear that ran when the tab left it dropped them, and
      Chrome does not re-inject on a bfcache restore, so nothing
      re-registers — that page's menu stays empty until a real
      document load. Pre-existing; the fix is a mirror per document
      rather than one per tab. Filed in TODO.md.
  - SPA pushState within the same document → kept, which is the
    page-side "callbacks survive in this document" lifecycle.
  - Why "unless" and not an unconditional wipe: the navigation
    handler clears after several awaits, so a `document-end` wrapper
    in the new document can register first. Dropping those leaves the
    tab with no menu commands until the next navigation — nothing
    resends them.
- The mirror is left alone when no navigation happened: a
  script-set-driven re-evaluation (`refreshAllOpenTabs`, which passes
  no `documentId`) must not touch it.
- Cleared unconditionally on:
  - Navigating to a non-injectable URL (`chrome://`, `about:blank`,
    ...).
  - Tab close (`chrome.tabs.onRemoved`).
- **A tab holds commands from several documents** when scripts run
  in its frames. The registry is keyed by document, each filed under
  the tab's top document, and the popup merges them. See
  [frames.md](frames.md#menu-commands).
- SW restart wipes the in-memory mirror. Page-side callbacks are
  scoped to the same document so they're already gone; the symmetric
  drop is correct.

### Test surface

- These keep the names of the context menu the popup replaced.
- `self.SourceMonkey.getActionContextMenu(tabId)` returns the
  registered (scriptId, commands[]) groups, used by
  `tests/e2e/gm-menu.spec.ts` to assert on registration state
  without driving the real Chrome UI.
- `self.SourceMonkey.getPopupView(tabId)` returns the popup's view of
  the tab, commands included.
- `self.SourceMonkey.fireActionContextMenuItem(tabId, scriptId,
  commandId)` fires a command through the same path as a click in the
  popup. sm-dev calls it too, so its name stays.
  Returns `{ok:false}` for stale or unknown ids.
- `self.SourceMonkey.reloadWithoutScripts(tabId)` stands in for the
  popup's and right-click menu's "Reload page with no userscripts" (see
  [matching.md](matching.md#reload-with-no-userscripts)).

## `window.onurlchange`

`@grant window.onurlchange` is the one grant whose payload is an
**event surface**, not a callable. See
[supported-GM-APIs.md](supported-GM-APIs.md#non-gm-grants) for the
user-facing contract.

### What the grant emits

- No `const` binding — `window.onurlchange` isn't a legal identifier.
- The binding emitter appends one eager statement to `js`:
  `reg.gm.urlchange.enable(scriptId)`.
- It lives in `js` rather than `prelude` on purpose: both strings are
  spliced into the same main-body wrap function (so the runtime is
  equally guaranteed to be installed), but only `js` is also
  prepended by `buildSwapEvalBody`, so a hot-swapped script keeps the
  surface. `resource.init` sits there for the same reason.
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

Both are forwarded to the exact document that changed as an
`sm:url-change` message carrying the reported URL, which the page-side
runtime replays verbatim to its listeners.

The targeting is load-bearing with scripts in frames (see
[frames.md](frames.md)): without it, an ad iframe's navigation would
arrive at the top frame's listeners as if the document had moved.

We address by `documentId`, falling back to `frameId` on builds that
don't report one. A frame ID names a slot rather than a document, so
a cross-document navigation landing between the event and the send
would deliver the URL into a document that was never on it.

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
real event either, so nothing outside its own sandbox `window` — not
`unsafeWindow`, not `document` — can subscribe. Ours is a superset in
one narrow way: the runtime patches the `window` of whichever world
the script runs in, and a script that grants `unsafeWindow` runs in
MAIN world, where that is the page's own `window`, so
`unsafeWindow.addEventListener('urlchange', …)` does work here.
`document.addEventListener('urlchange', …)` is dead in both.

### Payload and handler slot

- Listeners receive a **null-prototype plain object whose only own
  property is `url`** — matching TM byte for byte. Not an `Event`, no
  `type`, no `oldURL`. (TM declined a request to add `oldURL` in
  Tampermonkey#2601.)
- Handlers are invoked with no `this`, as TM does.
- `window.onurlchange = fn` takes a slot in the **same** list as
  `addEventListener`, because TM's setter literally calls its sandbox
  `add`/`removeEventListener`. So dispatch order is true registration
  order across both forms; `= null` makes the slot idle; re-assigning
  swaps the handler without moving its position.
- What the list actually holds for the slot is a fixed trampoline, not
  the user's function. Registering the user's function directly would
  make the two forms alias: with `addEventListener('urlchange', f)`
  already live, `onurlchange = f; onurlchange = null` would revoke the
  `addEventListener` registration the script never touched, and
  `removeEventListener('urlchange', f)` would silence a slot handler
  the getter still reported. Covered by
  `tests/e2e/window-onurlchange.spec.ts`.
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
- **Navigations before the script runs are lost.** Events are
  dropped until the first granting script calls `enable()`, so an
  SPA that routes during page load can navigate several times before
  a `@run-at document-idle` script ever sees one. Buffering them
  would need a per-document queue with no idea how long to hold it.
  Grant `@run-at document-start` if the first route matters; TM has
  the same gap.
- Every same-document navigation in every tab costs one
  `chrome.tabs.sendMessage`. It is deliberately **not** gated on
  "some script here granted the API": that state would have to
  survive SW restarts (userScripts registrations do; SW memory
  doesn't) and would fail silently when it didn't. Frames with no
  SourceMonkey runtime just reject the send, which we swallow.
- If `chrome.webNavigation`'s same-document events are unavailable,
  the feature is inert and the SW logs one `console.info` at startup
  (TM logs the same).

## `window.close` / `window.focus`

`@grant window.close` and `@grant window.focus` replace methods that
already exist rather than adding new names. See
[supported-GM-APIs.md](supported-GM-APIs.md#non-gm-grants) for the
user-facing contract.

### Why the grant exists at all

Both methods are present on every page and both are hobbled there:

- `window.close()` is refused for any tab the script didn't itself
  open with `window.open` — Chrome logs "Scripts may close only the
  windows that were opened by them".
- `window.focus()` does nothing for a background tab; no page code can
  select another tab or raise the OS window.

An extension is not bound by either rule, so the granted call is
routed to the service worker and re-issued as `chrome.tabs.remove` /
`chrome.tabs.update` + `chrome.windows.update`. That is what TM does
too.

### What the grant emits

- No `GM_*`-style binding — `window.close` isn't a legal identifier
  either.
- One eager statement appended to `js` per granted name. Which one
  depends on the world:
  - **The page's world** (a sandboxed script):
    `const __smWin_close = reg.gm.windowControl.make(scriptId, "close")`.
    The sandbox `window` holds it as its own `close`, so that script's
    `window.close()`, `self.close()`, bare `close()`, and `top.close()`
    in the top frame reach it. The page's `window` and other scripts
    keep the native method, and so do the script's own
    `unsafeWindow.close()` and `this.close()` in an event handler,
    which name the page's window.
    The channel key keeps the page from the runtime and the bridge,
    and the worker's check (`bridgeMayActAs`) is the backstop behind
    it.
  - **The isolated world:**
    `reg.gm.windowControl.enable(scriptId, "close" | "focus")`,
    which replaces the method on that world's `window`. The page's own
    `window.close` / `window.focus` are untouched, since the two worlds
    have separate global objects.
- In `js` rather than `prelude` for the same reasons as
  `urlchange.enable`: same ordering guarantees, and only `js` is
  prepended by `buildSwapEvalBody`, so a hot-swapped script gets its
  overrides back.
- Either way, a site cannot detect the grant, and its own close/focus
  behavior is unchanged.

### Call semantics

- Both take no arguments and return `undefined` synchronously, like
  TM's. The SW round-trip is fire-and-forget.
- `window.close()` closes the tab the script runs in. The payload
  names no target: the SW acts on `sender.tab`, so there is nothing a
  script could point elsewhere.
  - **The last remaining tab is refused.** Chrome would allow it and
    quit the browser; letting a userscript do that is a different
    order of capability from closing a tab. The count is read across
    every normal window (`tabs.query({windowType: 'normal'})`), so
    emptying one window while another is open still works. TM 5.5.0
    refuses the same case ("refused to close last tab!").
- `window.focus()` brings the calling tab to the front: it selects the
  tab within its window (`chrome.tabs.update`, `active: true`) **and**
  raises the window, restoring it first when it is minimized
  (`focused: true` alone leaves a minimized window minimized, and
  Chrome rejects it combined with `state: 'minimized'`).
  - Both halves are needed for the call to do anything visible.
    Raising alone is a no-op in the common single-window case — the
    window is already frontmost and the user is simply on another tab.
    Selecting alone leaves the tab hidden behind another window.
  - Whether the window really comes forward is the **OS window
    manager's** call. Several Linux desktops answer a programmatic
    raise by flashing the taskbar entry instead. Chrome reports no
    error for that, so neither can we; the tab selection still lands.
  - A window restored from minimized comes back `normal`, even if the
    user had it maximized. Chrome's API has no "restore to previous
    state".
- A failure (a tab that has since gone, `chrome.windows`
  unavailable) is reported both to the page console and, from the SW
  side, to the script's Log tab at `warning` level. There is nothing
  to report on success: a successful close takes the document with it.
- **The target is the sender's whole tab.** So a frame keeps the
  page's own `window.close` (a no-op there), and the worker refuses a
  close sent from a frame. See the sub-frames note below.
- **The `@grant` line is the whole gate** — no confirmation prompt at
  call time, same as TM. Closing the user's tab out from under them is
  a real capability, and the only thing standing in front of it is
  that the user installed a script that declares it.

### Observable differences from Tampermonkey

- **In the isolated world, grant enforcement is per-document, not
  per-script** — the same shared-realm caveat as `window.onurlchange`
  above. Once one script on the page grants `window.close`, a sibling
  SourceMonkey script in the same isolated world calls the override
  too. In the page's world each script's sandbox `window` has its own,
  as in TM.
  - Worse here than there: the onurlchange leak hands a non-granting
    script an observation channel, this one hands it the user's tab.
    The fix is the same (per-script worlds) and equally out of reach
    today, so it's pinned by a test rather than closed — see
    `tests/e2e/window-close-focus.spec.ts`.
- **Sub-frames.** As TM does (`page.js` hands a sub-frame the page's
  own `close`), we override `window.close` in the **top** frame only.
  `window.focus` has no such guard in either: it focuses the tab.
## DOM injection (`GM_addStyle` / `GM_addElement`)

Both run without an SW round-trip or per-script state. The page's CSP
(Content Security Policy) doesn't apply to what they insert from
USER_SCRIPT world:

- `<style>` rules apply even where the page's `style-src` omits
  `'unsafe-inline'`.
- `<script>` elements are checked against the USER_SCRIPT world's
  own CSP instead, which allows inline code and any `src` (as in
  Tampermonkey). So they run even under a strict page `script-src`.
  See [injection.md](injection.md#lifecycle) for the
  world config.
- The same holds for elements a script inserts itself
  (`document.createElement('script')`), not just via the GM API.

### In MAIN world

What a script inserts itself is the page's and under the page's CSP.
The two GM calls get the exemption anyway, as TM's `GM_addElement`
does:

- The runtime builds the element in MAIN world, then hands the insert
  to the bridge (`insertNode` in `wrapper-gm-runtime.js`): a
  `MouseEvent` dispatched on the parent, carrying the element in
  `relatedTarget`, the event field that can carry a second node across
  worlds. `composed`, so a parent in an open shadow root works too.
- The bridge's listener (on `window`, capturing, added at
  `document_start` ahead of any page listener) appends it from
  USER_SCRIPT world and cancels the event to say so. It runs inside
  the dispatch, so the element is in the document when the call
  returns, and it is the same element the script holds.
- Changes the script makes to the element afterwards (a new
  `textContent`) are its own, under the page's CSP again.
- The page can send the bridge's event too, for an element of its
  own, and so get the same exemption: inline code and `<script src>` /
  stylesheet loads from any host. See the bridge's Trust model in
  [injection.md](injection.md#main-world-traffic--the-bridge).

Where the bridge can't do the insert, the runtime does it, under the
page's CSP:

- **A parent in a closed shadow root.** Outside the tree, the event's
  path stops at the host, so the bridge would insert there instead.
- **A parent in another frame's document.** The event goes to that
  frame, where the element isn't one of its own nodes.
- **A detached parent.** The element is checked when the script later
  attaches it, from MAIN world.

A `<style>` blocked there (in the document, with no `.sheet`) is
reported once per script per document as a Log warning. One under a
detached parent isn't, since it's checked only at insert.

### The calls

- `GM_addStyle(css)` — creates a `<style>`, sets `textContent`,
  appends to `document.head || document.documentElement`. Returns
  the element.
- `GM_addElement(tagName, attrs?)` — tag-aware default parent:
  `<head>` for `script`/`style`/`link`/`meta`/`title`/`base`,
  `<body>` for everything else. VM routes by tag the same way with a
  shorter head list (`script`/`style`/`link`/`meta`), so `title` and
  `base` differ; TM always uses `<head>`. Falls back through head /
  documentElement when body doesn't exist yet (very-early `runAt`).
  Returns the element.
- `GM_addElement(parent, tagName, attrs?)` — appends to the given
  parent node. Two-arg vs three-arg signatures are distinguished by
  whether `arg1` has a `.nodeType`.
- `attrs` is a plain object of attribute names → string values. The
  pseudo-attribute `textContent` sets inner text directly (TM
  convention).
