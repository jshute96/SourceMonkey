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
| ⚪ | **Not in catalog** — not exposed; granting it logs an "unknown @grant" warning. |

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

---

## Compile-in metadata

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_info` / `GM.info` | ✅ | ✓ | ✓ | ✓ | Baked into the wrapper at registration time. Surface: `script.{name, version, namespace, description, matches, includes, excludes, grant, runAt}`, `scriptHandler: "SourceMonkey"`, `version: <extension version>`, `scriptMetaStr` (raw `==UserScript==` block), `uuid` (stored script id). `script.grant` is the **canonicalized** set we emitted bindings for, not the raw `@grant` lines — `@grant GM.setValue` shows up as `GM_setValue`. Matches VM. |
| `unsafeWindow` | 🟡 | ✓ | ✓ |   | Currently a passthrough to USER_SCRIPT world's own `window`, **not** the page's. Userscripts that wanted to poke `window.jQuery` etc. should use `@inject-into page` (MAIN world) instead; a cross-world bridge could land later. |

---

## Logging

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_log` / `GM.log` | ✅ | ✓ |   | ✓ | Thin `console.log` wrapper prefixed with `[SourceMonkey:<scriptId>]`. Arguments are passed through unchanged so Chrome's `%c` / `%o` formatters and DevTools object inspection still work. Returns `undefined`. |

---

## Storage

Page-side cache + batched async writes. `GM_getValue` is a synchronous
read from a cache baked into the wrapper at register time. `GM.setValue`
returns a Promise per GM4 spec. Per-script namespace —
`GM_listValues` from script A never returns script B's keys.

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
  broadcast covers most cases; a SW restart or a write that lands
  during another tab's bootstrap may be missed by that tab until
  its next page reload (re-bake from `chrome.storage.local`).
- A write made in the last ~150 ms before tab close may be lost if
  the SW is idle/suspended and the page goes into bfcache.
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
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | ✅ | ✓ | ✓ | ✓ (`GM.xmlHttpRequest` only) | Returns `{abort}` synchronously. SW-side `fetch` with `AbortController`; events (`load`, `error`, `timeout`, `abort`) are shipped back to the originating tab. |

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

A denied request fires `onerror` with a `"blocked by @connect
policy: …"` message.

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
| `GM_getResourceURL` / `GM.getResourceUrl` | ✅ | ✓ | ✓ | ✓ | Mints (and caches) a `blob:` URL with the fetched Content-Type. Same URL on repeat calls for one name. GM4 form spells it lowercase-`u` (`getResourceUrl`) — deliberate casing mismatch with the legacy form. |

---

## Not in the catalog at all

Granting any of these names logs a "unknown @grant entries dropped"
info line at sync time; the script's call sites get a
`ReferenceError`. Adding any of these is a catalog entry + a body —
nothing structural.

- `GM_cookie` (and `GM.cookie`) — TM's cross-origin cookie store.
- `GM_audio`, `GM_webRequest`, `GM_getTab`, `GM_saveTab`,
  `GM_getTabs` — TM-specific surface.
- `window.onurlchange` — SPA navigation hook. Worth prioritising
  because SPA scripts work badly without it.
- `GM_download` — TM/VM download-to-disk helper.
- `GM.bootstrap`, `GM_NEXT_API_FROM_TM`, etc. — moving targets.

---

## What's been tested

Every implemented API has both a unit test (binding emission,
runtime helpers) and an end-to-end test (real userscript driving
the API in headless Chromium). See [testing.md](testing.md#gm-test-coverage).
