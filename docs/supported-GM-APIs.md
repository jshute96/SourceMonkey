# Supported `GM_*` / `GM.*` APIs

Catalogue of every `GM_*` name SourceMonkey recognizes from
`@grant`, what it does today, and how it maps to Tampermonkey,
Violentmonkey, and Greasemonkey 4.

For the engineering picture — the page-side runtime, SW handlers,
binding emitter, `@connect` matcher — see
[GM-APIs.md](GM-APIs.md). For the design rationale and the
strategy/phasing that produced this surface, see
[GM-API-strategy.md](GM-API-strategy.md). For `@grant` /
`@connect` / `@resource` header semantics see
[supported-headers.md](supported-headers.md).

## Status legend

| Symbol | Meaning |
|:------:|---------|
| ✅ | **Implemented** — granting the API exposes a real working binding. |
| 🟡 | **Stubbed** — binding exists, throws "not implemented yet" on call (so the script at least sees a clear error and `typeof` reports `function`). |
| ⚪ | **Not in catalog** — not exposed; granting it logs an "unknown @grant" warning to the page console + Log tab. |

## Granting

A script declares APIs via `@grant`:

```js
// @grant GM_setValue
// @grant GM.getValue       // GM4 form — canonicalizes to the same name
// @grant unsafeWindow
```

Both `GM_x` and `GM.x` forms canonicalize to the same legacy `GM_x`
name. SourceMonkey then emits **both** bindings: the legacy
`GM_setValue` and the GM4 alias `GM.setValue`. Storage APIs return
synchronously from the legacy form and return a Promise from the
`GM.` form (matches the GM4 contract). Most other APIs are
pass-through aliases.

`@grant none` (or an absent `@grant`) emits **no** bindings — the
script gets the page's `window` directly (MAIN world).

Strict gating: every other `@grant` name is canonicalized through
the catalog. Names we don't recognize (TM-only `GM_audio`, typos
like `GM_setvalue`) are silently dropped from the binding set —
the script sees a `ReferenceError` at call time, and the SW logs a
`console.info` with the dropped names.

### Name matching is byte-exact

`@grant` names are compared exactly. `GM_xmlHttpRequest` (capital
`H`) and `GM_Log` are **not** `GM_xmlhttpRequest` and `GM_log`; they
resolve to nothing.

- This is what TM and VM both do. TM's grant table is a set of exact
  name strings tested with `Array.prototype.indexOf`; VM does plain
  property lookup on a null-prototype object. Neither case-folds.
- We deliberately do not case-fold either. A `@grant` that differs
  only in case is a bug in the script; silently accepting it would
  make SourceMonkey the only manager the script runs under.
- What we do instead: the "unknown @grant" warning names the near
  miss — `Ignoring @grant GM_xmlHttpRequest (did you mean
  GM_xmlhttpRequest?) — unsupported APIs`. TM's built-in editor lints the same
  mistake as `'X' is not a valid @grant argument`.

### The re-cased `GM.` spellings

Where GM4 re-cased a name, the API answers to a second `GM.` spelling:

| API | GM4 spelling | Prefix-rewrite spelling |
|-----|--------------|-------------------------|
| `GM_xmlhttpRequest` | `GM.xmlHttpRequest` | `GM.xmlhttpRequest` |
| `GM_getResourceURL` | `GM.getResourceUrl` | `GM.getResourceURL` |

Why we accept the right-hand column:

- VM resolves `GM.foo` by consulting a small alias table and
  otherwise rewriting the name to `'GM_' + foo` verbatim, so both
  spellings work there. TM accepts only the GM4 spelling.
- Real scripts rely on it. In the GreasyFork top-2000 corpus three
  scripts grant `GM.xmlhttpRequest`, and one of them grants nothing
  else — under exact-GM4-only matching it is dead on arrival.
- `GM.getResourceURL` has no corpus hits. It falls out of the same VM
  rule, and excluding it would be an arbitrary exception.
- Every other API's GM4 name is just its legacy name minus `GM_`, so
  the two columns collapse and there is only ever one spelling.

**Granting either spelling exposes both**, along with the legacy
`GM_x`:

- The model is TM's — one boolean gates an API's whole alias group.
  VM instead defines only the exact spelling the script wrote.
- But TM's group for `GM_xmlhttpRequest` does *not* contain
  `GM.xmlhttpRequest`, so we are a **strict superset of both**.
- Portability cost, stated plainly: a script that grants
  `GM_xmlhttpRequest` and calls `GM.xmlhttpRequest` works here and
  nowhere else. That's the same trap the byte-exact rule above guards
  against, accepted here because the alternative is plumbing the raw
  granted spelling all the way to the emitter.
- We do not reproduce VM's quirk where the rewrite spelling loses its
  Promise wrapper — our spellings behave identically.

`tests/examples/grant-case/` demonstrates all of this against a live
page. Its prefix-rewrite assertions are skipped under Tampermonkey,
which rejects those grants — see
[cross-manager-test-results.md](cross-manager-test-results.md).

---

## Compile-in metadata

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_info` / `GM.info` | ✅ | ✓ | ✓ | ✓ | Implicit — exposed in every script regardless of `@grant` (including `@grant none` and scripts with no `@grant` line), and in both MAIN and USER_SCRIPT worlds. Also spliced into every `@require` entry. Baked into the wrapper at registration time. Surface: `script.{name, version, namespace, description, matches, includes, excludes, grant, runAt}`, `scriptHandler: "SourceMonkey"`, `version: <extension version>`, `scriptMetaStr` (raw `==UserScript==` block), `uuid` (stored script id). `script.grant` is the **canonicalized** set we emitted bindings for, not the raw `@grant` lines — `@grant GM.setValue` shows up as `GM_setValue`. Matches VM. |
| `unsafeWindow` | 🟡 | ✓ | ✓ |   | Currently a passthrough to USER_SCRIPT world's own `window`, **not** the page's. Userscripts that wanted to poke `window.jQuery` etc. should use `@inject-into page` (MAIN world) instead; a cross-world bridge could land later. |

---

## Logging

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_log` / `GM.log` | ✅ | ✓ |   | ✓ | Thin `console.log` wrapper prefixed with `[SourceMonkey:<scriptId>]`. Arguments are passed through unchanged so Chrome's `%c` / `%o` formatters and DevTools object inspection still work. Returns `undefined`. |

---

## Storage

Page-side cache + batched async writes. `GM_getValue` is a synchronous
read from a per-document in-memory cache; the cache is seeded at
document start from a snapshot the SW attaches to the wrapper's
`sm:check-pending` reply. `GM.setValue` returns a Promise per GM4
spec. Per-script namespace — `GM_listValues` from script A never
returns script B's keys. See
[GM-APIs-storage.md](GM-APIs-storage.md) for the full story.

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_setValue` / `GM.setValue` | ✅ | ✓ | ✓ | ✓ | Sync return on `GM_x`, Promise on `GM.x`. Writes batched (150 ms debounce, 1 s hard cap) and flushed on `pagehide` / `visibilitychange → hidden`. |
| `GM_getValue` / `GM.getValue` | ✅ | ✓ | ✓ | ✓ | Sync read from the in-page cache; returns `defaultValue` for unknown keys. |
| `GM_deleteValue` / `GM.deleteValue` | ✅ | ✓ | ✓ | ✓ | Same flush/batching shape as `setValue`. |
| `GM_listValues` / `GM.listValues` | ✅ | ✓ | ✓ | ✓ | Returns the list of currently-known keys. |
| `GM_addValueChangeListener` / `GM.addValueChangeListener` | ✅ | ✓ | ✓ |   | Fires on local writes (`remote=false`) and on cross-tab broadcasts (`remote=true`). Signature: `cb(key, oldValue, newValue, remote)`. |
| `GM_removeValueChangeListener` / `GM.removeValueChangeListener` | ✅ | ✓ | ✓ |   | Unregister by the id returned from `add…`. |

### Storage caveats

- Writes are eventually-consistent across tabs. A live cross-tab
  broadcast covers already-running documents; new documents always
  fetch a fresh snapshot from the SW on `sm:check-pending`.
- A write made in the last ~150 ms before tab close may be lost if
  the SW is idle/suspended and the page goes into bfcache.
- If the SW is unreachable past the wrapper's 2 s safety timeout,
  storage-granting scripts log a console error and refuse to run
  (no silent stale-data). Reload to retry.
- Same-extension userscripts share the trust boundary —
  technically, userscript A can impersonate userscript B's
  `scriptId` in the storage envelope and corrupt B's keys. This is
  "A messes with B's data," not a privilege escalation against the
  user.

---

## DOM injection

USER_SCRIPT world's DOM mutations are CSP-exempt (the same
dispensation content scripts get), so these work even on pages with
strict `Content-Security-Policy: script-src 'self'`.

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_addStyle` / `GM.addStyle` | ✅ | ✓ | ✓ |   | Creates a `<style>` and appends to `document.head` (or `documentElement` if head isn't there yet). Returns the element. |
| `GM_addElement` / `GM.addElement` | ✅ | ✓ |   |   | Two signatures: `GM_addElement(tag, attrs?)` appends to `<head>` for `script`/`style`/`link`/`meta`/`title`/`base` and to `<body>` for everything else (matches VM; TM differs — see below); `GM_addElement(parent, tag, attrs?)` appends to the given parent. `attrs.textContent` is a recognized pseudo-attribute. Boolean `false` attrs are omitted (avoids the `disabled="false"` foot-gun); `true` serializes as `""` per HTML spec. `innerHTML` is **not** recognized as a pseudo-attribute by design — call it on the returned element if you need it. **Cross-manager note:** TM appends to `<head>` regardless of tag in the no-parent form, so a `GM_addElement('p', ...)` lands in `<head>` under TM but in `<body>` under SM/VM. The TM docs don't pin the default parent down, so neither rule is wrong — SM picks VM's rule because it's more useful for non-head tags. |

---

## Clipboard

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_setClipboard` / `GM.setClipboard` | ✅ | ✓ | ✓ |   | Via `navigator.clipboard.writeText` from USER_SCRIPT world. Returns the underlying Promise (TM's `GM_setClipboard` is fire-and-forget `undefined`; we hand back the Promise so callers can `await`). The `type` argument is not honored — only `text/plain` is written today. May reject with `NotAllowedError` on pages without focus / transient activation. |

---

## XHR

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | ✅ | ✓ | ✓ | ✓ (`GM.xmlHttpRequest` only) | Also answers to `GM.xmlhttpRequest` (see [Granting](#the-re-cased-gm-spellings)). Returns `{abort}` synchronously. SW-side `fetch` with `AbortController`; events (`load`, `error`, `timeout`, `abort`) are shipped back to the originating tab. |

### XHR details object

`GM_xmlhttpRequest(details)` accepts (in addition to TM/VM's surface):

| Field | Notes |
|-------|-------|
| `method` | Default `GET`. Uppercased before send. |
| `url` | Required. |
| `headers` | Plain object. Passed verbatim to `fetch()` — forbidden headers (Origin, Cookie when overriding, etc.) are silently stripped by the browser. **Header surgery to override forbidden headers is not yet implemented.** |
| `data` | Body. String only today; non-string falls through `String(...)`. |
| `timeout` | Milliseconds. Aborts the request and fires `ontimeout`. |
| `responseType` | `text` (default) / `json` / `blob` / `arraybuffer` / `document`. |
| `onload`, `onerror`, `ontimeout`, `onabort` | Callbacks. Callbacks aren't serializable across the SW boundary so they stay on the page side keyed by request id. |

### XHR response shape

For `responseType: 'text'` (default) and `'json'`:

| Field | Notes |
|-------|-------|
| `status` | HTTP status number. |
| `statusText` | HTTP status text. |
| `responseURL` / `finalUrl` | Final URL after redirects. |
| `responseText` | Body as text. |
| `response` | Same as `responseText` for `text`; parsed object for `json` (or `null` on parse failure). |
| `responseHeaders` | Multi-line `Name: value\r\n…` (TM/VM convention; trailing CRLF). |

For `responseType: 'blob'` / `'arraybuffer'` / `'document'`: same
shape, except `responseText` is empty (`document` populates it) and
`response` is the reconstructed native object (`Blob`,
`ArrayBuffer`, or `Document`). The SW serializes bytes as base64;
the page-side runtime decodes and rebuilds.

### `@connect` gating

Strict-by-default. A script with **no** `@connect` lines is blocked
from every `GM_xmlhttpRequest` call. Grammar:

| Form | Meaning |
|------|---------|
| `@connect *` | Allow any host. |
| `@connect self` | Allow the script's own `@match` / `@include` hosts. |
| `@connect example.com` | Allow this exact host. |
| `@connect *.example.com` | Allow `example.com` itself AND any subdomain. |
| `@connect https://example.com` | Same as `@connect example.com` (scheme stripped). |

A denied request fires `onerror` with
`"[SourceMonkey] GM_xmlhttpRequest: blocked by this script's @connect
rules: …"` — built by `connectBlockedMessage` in `gm-connect.ts`, so
the pre-flight check and the post-redirect re-check say the same thing.

Two near neighbours deliberately do *not* use that wording, because
the script's header isn't what refused the call:

- A URL that won't parse (a relative one, say) — the request fails for
  a script with `@connect *` too.
- A failure to evaluate the rules at all, which carries `internal
  error:`.

### XHR caveats

- HTTP error statuses (404, 500, …) fire `onload` with the
  non-2xx status — matches XHR semantics. Only network-level
  failures (DNS, ECONNREFUSED, etc.) fire `onerror`.
- No `onprogress` events — only the final terminal event lands.
- No header surgery: `Origin` is the extension's origin, Cookies
  are SW-managed, forbidden headers can't be overridden. (Future
  phase.)
- A narrow abort-after-response race can fire `onabort` instead of
  `onload` if the page calls `abort()` while the load event is in
  the in-flight message queue.
- Page-side TTL of 5 minutes — if the SW crashes and never sends
  a terminal event, the page synthesizes an `error` so
  `activeRequests` doesn't leak forever.

---

## Notifications

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_notification` / `GM.notification` | ✅ | ✓ | ✓ |   | System notification via `chrome.notifications.create`. See below for call shapes, details fields, callback semantics, and the icon fallback. |

### Notification call shape

- `GM_notification(details, ondone?)` — modern TM shape.
- `GM_notification(text, title?, image?, onclick?)` — legacy
  positional.
- Returns a Promise resolving to the chrome-assigned notification id.

### Details fields

- `text` (required), `title`, `image`, `timeout` (auto-clear ms),
  `silent`, `tag`.
- `details.onclick` fires on user click (non-terminal — may fire
  before `ondone`).
- `details.ondone` (or the second positional arg) fires when the
  notification is closed.
- Default icon falls back to SourceMonkey's extension icon when
  `image` is omitted (`chrome.notifications.create` requires one).

### Notification caveats

- Browser availability — `chrome.notifications` requires the
  `notifications` permission (declared in the manifest) and the
  OS-level notification permission. Headless Chromium silently
  drops the toast but still resolves the Promise; production
  browsers show the toast when permitted.
- Callback dispatch is **best-effort cross-tab**. If the originating
  tab closes before the user clicks or dismisses, the SW drops the
  per-originator mapping and the `onclick` / `ondone` callbacks
  never fire (the tab they targeted is gone).
- SW restart loses in-flight notification mappings: a notification
  created before the SW idled out won't deliver its click / done
  event to the userscript on restart. The notification itself stays
  on screen (chrome.notifications survives the SW lifecycle).

---

## Tabs

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_openInTab` / `GM.openInTab` | ✅ | ✓ | ✓ |   | `chrome.tabs.create` wrapper. Returns a control object synchronously: `{ close(), closed, onclose }`. See below for call shapes and options. |

### Open-in-tab call shape

- `GM_openInTab(url, options?)` — options:
  `{ active, loadInBackground, insert }`. `active` and
  `loadInBackground` are inverses.
- `GM_openInTab(url, loadInBackground)` — TM-legacy boolean shortcut.
- `insert: true` biases Chrome to place the new tab next to the
  originator (via `openerTabId`).
- `onclose` fires when the tab is closed (by user, by `ctl.close()`,
  or by another extension).

### Tab caveats

- `insert` is **best-effort positional** — Chrome's `openerTabId`
  hints placement but doesn't guarantee an exact index.
- If the originating tab closes while opened tabs are still alive,
  the opened tabs stay open (matches TM/VM) but the SW drops the
  mapping, so the `onclose` callback can't be routed anywhere.

---

## Downloads

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_download` / `GM.download` | ✅ | ✓ | ✓ |   | Saves a file to the browser's download directory. Returns `{ abort() }` synchronously (TM's documented return). `http(s)` URLs go through `chrome.downloads`; `blob:` / `data:` URLs are downloaded in-page. Requires the extension's `downloads` permission. |

### Download call shape

- `GM_download(details)` — details:
  `{ url, name, headers, saveAs, timeout, onload, onerror, onprogress, ontimeout, onabort }`.
- `GM_download(url, name)` — TM's two-argument shorthand.
- `url` is required; a missing one throws synchronously.
- `name` is optional (TM requires it). Omit it and the browser
  derives the filename from the URL / `Content-Disposition`.
- `name` may contain relative subdirectories (`pics/cat.png`, resolved
  under the download directory). Absolute paths and `..` traversal are
  refused.
- `onabort` is a SourceMonkey extension — see the abort note below.

### Download transports

| URL scheme | Path | Consequences |
|------------|------|--------------|
| `http:` / `https:` | `chrome.downloads` in the service worker | Real download-manager entry: `saveAs` dialog, `headers`, progress, resume, Chrome's own dangerous-file prompts. |
| `blob:` / `data:` | An `<a download>` click in the page | `saveAs`, `headers`, `timeout` and progress are all ignored, and there's no completion signal — `onload` fires once the click is handed to the browser. |
| anything else | refused | `onerror` with `not_permitted`. |

Why `blob:` gets its own path:

- Most media-downloader scripts build their bytes in the page and pass
  `URL.createObjectURL(...)`.
- A page-minted blob URL can't be resolved from the extension's own
  context, so the download has to start in the page.
- That anchor click is exactly what the script could do with no
  `@grant` at all — the path grants nothing new.

`details.url` is resolved against the page first, so relative URLs
(`GM_download('/files/a.zip', …)`) work like they do in TM.

### Download callbacks

| Callback | Fires when | Argument |
|----------|-----------|----------|
| `onload` | The download manager reports `complete` (or, on the in-page path, the click was handed off). | `{ downloadId, filename, finalUrl, totalBytes }` |
| `onerror` | Refused, or the transfer was interrupted. | `{ error, details }` — see the error table. |
| `onprogress` | Poll tick while bytes are arriving (http(s) only, and only when you supply the callback). | `{ lengthComputable, loaded, total }` |
| `ontimeout` | `details.timeout` elapsed; the transfer is canceled. | `{}` |
| `onabort` | You called `abort()` — **SourceMonkey extension**, not part of TM's surface. | `{ error: 'download_canceled', details }` |

### Download error values

TM's documented reason set, with `{error, details}` on `onerror`:

- `details` mirrors the `chrome.downloads` interrupt shape
  (`{current, previous}`) — that's what TM passes through.
- Real scripts branch on it (Twitter Media Downloader checks
  `err.details.current === 'USER_CANCELED'` to stop retrying).
- Failures that never reached the download manager add
  `details.message` instead.

| `error` | When SourceMonkey emits it |
|---------|----------------------------|
| `not_permitted` | Non-`http(s)`/`blob:`/`data:` URL, a `name` that escapes the download directory, or the `downloads` permission missing at runtime. |
| `not_succeeded` | The download manager refused the request, or the transfer was interrupted (`details.current` carries Chrome's reason: `NETWORK_FAILED`, `USER_CANCELED`, `FILE_ACCESS_DENIED`, …). |
| `not_supported` | No route to the service worker at all (e.g. a MAIN-world script). |
| `download_canceled` | The script called `abort()`. |
| `not_enabled` | **Never emitted.** TM's global "downloads off" setting; SourceMonkey has none. |
| `not_whitelisted` | **Never emitted.** TM's per-extension file-extension allowlist; SourceMonkey relies on Chrome's own dangerous-download prompts instead. |

### `@connect` does NOT gate downloads

Deliberate, and a divergence from how SourceMonkey treats
`GM_xmlhttpRequest`:

- TM doesn't gate downloads on `@connect` either — it uses a separate
  file-extension allowlist.
- Download URLs are runtime-discovered CDN hosts (`*.googlevideo.com`,
  `pbs.twimg.com`, per-object signed URLs) that a script can't
  enumerate in its header. Strict-by-default `@connect` would break
  essentially every script that grants `GM_download`.
- The threat model differs: the bytes go to the user's disk, not back
  into the script, so the response-exfiltration risk `@connect` exists
  to contain doesn't apply.

What guards the API instead: the scheme allowlist, the filename check,
the visible entry in Chrome's download UI, and Chrome's own
Safe-Browsing prompt for dangerous file types.

Worth stating plainly, since `@connect` isn't in the way: `GM_download`
is a way for a script to issue a cookie-bearing GET to any host with
headers of its choosing. The script can't read the response — so it's
not an exfiltration channel — but it *is* a request-side-effect
primitive, and any host that acts on a plain GET is reachable.

### Download caveats

- **Chrome's `downloads` permission is required** and declared in the
  manifest. Existing installs see a new "Manage your downloads"
  permission on update. The `chrome.downloads.onChanged` listener that
  comes with it sees every download in the browser (the API has no
  per-extension filter); SourceMonkey ignores any id it didn't start.
- **`abort()` settles the call locally, immediately** (matching
  `GM_xmlhttpRequest`), then asks the SW to cancel. On the in-page
  `blob:` / `data:` path there is nothing to cancel — the browser
  already owns the transfer — so `abort()` only suppresses the
  synthetic `onload`.
- **`blob:` / `data:` only: `onload` does not mean "on disk".** Those
  two schemes never reach the service worker — the wrapper clicks a
  hidden `<a download>` in the page, and the browser owns the transfer
  from there with no completion event available to the script.
  - `onload` on that path means "handed to the browser". It's
    synthetic, fired ~250 ms after the click so the common
    `URL.revokeObjectURL` in `onload` doesn't race the download
    manager.
  - **http(s) is unaffected**: those go through `chrome.downloads`, and
    their `onload` is a real transition to `complete`.
  - Closing the gap is possible — see the entry in
    [TODO.md](../TODO.md).
- **Progress is polled** (~500 ms) because `chrome.downloads.onChanged`
  doesn't carry byte counts. Nothing is polled unless you supply
  `onprogress`.
- **Downloads outlive their tab.** Closing the originating tab stops
  event routing (the callbacks can't fire anywhere) but does not
  cancel the transfer.
- **A dead service worker loses in-flight tracking.** While a download
  runs, SourceMonkey polls the download manager, which keeps the SW
  alive; but if it dies anyway (browser restart, crash) the file keeps
  downloading and the script simply stops hearing about it. Unlike
  `GM_xmlhttpRequest` there's no page-side timeout that eventually
  synthesizes an error — a download can legitimately run for hours, so
  there's no honest deadline to pick.
- **Failures land on the script's Log tab**, `gm-download` source, so
  a "nothing downloaded" report has somewhere to look.
  - At `warning`, not `error`: a refused or interrupted download is an
    outcome the script can handle, not a SourceMonkey malfunction.
    `error` wouldn't turn the toolbar icon red either, so it would
    only raise the noise floor.
  - Successful downloads are not logged: a batch downloader would
    flood the capped log.

---

## Menu commands

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_registerMenuCommand` / `GM.registerMenuCommand` | ✅ | ✓ | ✓ |   | Adds an entry indented under the script's row in SourceMonkey's toolbar-icon right-click menu. See below. |
| `GM_unregisterMenuCommand` / `GM.unregisterMenuCommand` | ✅ | ✓ | ✓ |   | Removes the entry. Unknown ids are silent. |

### Menu-command call shape

- `GM_registerMenuCommand(name, callback, accessKeyOrOpts?)`:
  - `name` — visible label rendered as `↳ <name>` under the script's
    row in the action context menu.
  - `callback` — invoked in the userscript's sandbox when the user
    picks the entry; required.
  - `accessKeyOrOpts.id` — pass a stable id to update an existing
    entry instead of duplicating it (matches TM/VM).
- Returns the command id. Pass that id to
  `GM_unregisterMenuCommand` to remove the entry.

### Menu lifecycle

- Entries are scoped to the (tab, document) the wrapper ran in. SPA
  pushState / bfcache restore preserves them; a fresh document load
  clears them and the new wrapper re-registers.
- The SW restart drops the mirror; the page-side callbacks vanish
  with the document anyway, so there's nothing for the SW to route
  a fire event to. After SW restart, the script must re-register
  (most do this at script entry).
- Other userscript managers expose the same APIs but render
  entries in their own surfaces (TM/VM toolbar popups). The
  catalog matches; the UI doesn't.

---

## Resource lookups

`@resource` entries are prefetched at script load / refresh time and
baked into the per-script wrapper. See
[resources.md](resources.md) for the storage shape and lifecycle.

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_getResourceText` / `GM.getResourceText` | ✅ | ✓ | ✓ | ✓ | UTF-8 decode on demand. Returns `undefined` for an unknown name. Binary resources still decode (mojibake-tolerant); use `GM_getResourceURL` instead. |
| `GM_getResourceURL` / `GM.getResourceUrl` | ✅ | ✓ | ✓ | ✓ | Mints (and caches) a `blob:` URL with the fetched Content-Type. Same URL on repeat calls for one name. GM4 form spells it lowercase-`u` (`getResourceUrl`) — deliberate casing mismatch with the legacy form; `GM.getResourceURL` also resolves (see [Granting](#the-re-cased-gm-spellings)). |

---

## Not in the catalog at all

Granting any of these names logs an "Ignoring @grant … — unsupported
APIs" warning. Detection happens at parse time; the diagnostic is persisted
on the stored script and surfaces two ways:

- a `console.info` in the **page** DevTools console (via the wrapper's
  startup-log channel — see [docs/logging.md][logging]) on every
  matching page load (`console.info`, not `.warn` — injected warn/error
  leak into chrome://extensions/?errors), and
- a `warning`-level row in the viewer's Log tab, emitted once per
  loaded content version right after the "Loaded new content" line.

The script's call sites get a `ReferenceError`. Adding any of these
is a catalog entry + a body — nothing structural.

When the dropped name differs from a known one only in
capitalization, the warning names the near miss: `GM_xmlHttpRequest
(did you mean GM_xmlhttpRequest?)`. The suggestion is diagnostic
only — matching itself stays byte-exact (see
[Granting](#name-matching-is-byte-exact)).

[logging]: logging.md#page-console-startup-logs

- `GM_cookie` (and `GM.cookie`) — TM's cross-origin cookie store.
- `GM_audio`, `GM_webRequest`, `GM_getTab`, `GM_saveTab`,
  `GM_getTabs` — TM-specific surface.
- `window.onurlchange` — SPA navigation hook. Worth prioritising
  because SPA scripts work badly without it.
- `GM.bootstrap`, `GM_NEXT_API_FROM_TM`, etc. — moving targets.

---

## What's been tested

Every implemented API has both a unit test (binding emission,
runtime helpers) and an end-to-end test (real userscript driving
the API in headless Chromium). See [testing.md](testing.md#gm-test-coverage).
