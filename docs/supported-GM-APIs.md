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

`@grant none` (or an absent `@grant`) emits **no** `GM_*` bindings.
A `@grant none` script gets the page's `window` directly (MAIN world);
one with no `@grant` line runs in a sandbox `window`, as in TM and VM
([injection.md](injection.md#the-sandbox-window)).

Strict gating: every other `@grant` name is canonicalized through
the catalog. Names we don't recognize (TM-only `GM_audio`, typos
like `GM_setvalue`) are silently dropped from the binding set —
the script sees a `ReferenceError` at call time, and the SW logs a
`console.info` with the dropped names.

---

## Compile-in metadata

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_info` / `GM.info` | ✅ | ✓ | ✓ | ✓ | Implicit — exposed in every script regardless of `@grant` (including `@grant none` and scripts with no `@grant` line), and in both MAIN and USER_SCRIPT worlds. Also spliced into every `@require` entry. Baked into the wrapper at registration time. Surface: `script.{name, version, namespace, description, matches, includes, excludes, grant, runAt}`, `scriptHandler: "SourceMonkey"`, `version: <extension version>`, `scriptMetaStr` (raw `==UserScript==` block), `uuid` (stored script id). `script.grant` is the **canonicalized** set we emitted bindings for, not the raw `@grant` lines — `@grant GM.setValue` shows up as `GM_setValue`. TM and VM both report the raw lines instead. |
| `unsafeWindow` | ✅ | ✓ | ✓ |   | The page's real `window`. Scripts run in MAIN world unless they ask for isolation (see below), and `unsafeWindow` is the page's own `window`. Unless the script has `@grant none`, its own `window` is a sandbox showing only the browser's built-ins ([injection.md](injection.md#the-sandbox-window)), so `unsafeWindow === window` is `false`, as in TM and VM on Chrome (measured; see [cross-manager-test-results.md](cross-manager-test-results.md)). Reads, writes, and calls through `unsafeWindow` all reach the page's realm. **No grant needed:** a script whose body names `unsafeWindow` without granting it gets the same treatment — TM and VM both expose the name ungranted, so plenty of real scripts never declare it (see below). **Exception:** `@inject-into content` or `@sandbox DOM` pins the script to the isolated world, where it can only be that world's own `window`; that combination is flagged with a startup-log warning. |
| `cloneInto` / `exportFunction` / `createObjectIn` | ✅ | ✓ | ✓ |   | Implicit, in every script. Firefox's helpers for passing values into the page; on Chrome there's nothing to cross, so as in TM and VM they pass through: `cloneInto` returns its argument, `exportFunction` its function and `createObjectIn` a new object, the last two put on the target first when given `defineAs`. |
| `exports` / `module` / `define` | ✅ | ✓ | ✓ |   | Implicit, in every script, as `undefined` (TM and VM give the same), so a bare reference doesn't throw and a `@require`d UMD library sets a global rather than finding a module system. That includes a page's own AMD `define`: a script that wants it uses `unsafeWindow.define`. A script may assign to them or declare its own. |

### `unsafeWindow` and the execution world

- `unsafeWindow` is defined as *the page's* window. In Chrome that
  object exists only in MAIN world, and property access on it is
  synchronous, so there is no async bridge that could stand in.
- Every script runs in MAIN world unless it asks for isolation
  (`@inject-into content` or `@sandbox DOM`), as in Tampermonkey and
  Violentmonkey. So `unsafeWindow` reaches the page with or without a
  grant line.
- The script's `@grant`s work there too. The shared GM runtime is
  registered in MAIN as well, and routes its service-worker traffic
  over the bridge. A secret key keeps the page from reaching either
  ([injection.md](injection.md#the-channel-key)).
- `@inject-into content` / `@sandbox DOM` are explicit requests for
  isolation. The binding stays (matching VM's content mode) but every
  page global reads as `undefined`, so SourceMonkey emits a
  `warning`-level startup log rather than letting that be silent.
- **A reference with no grant line gets the binding.** Neither TM nor
  VM keys `unsafeWindow` off `@grant`, so a script written against
  either may use it and never declare it; 112 of the GreasyFork top
  2000 do exactly that. SourceMonkey scans the body at load time and
  emits the same binding.
  - `GM_info.script.grant` still reports the `@grant` lines the file
    declares. The binding is a `window` alias; it grants no API.
  - What the scan can and can't see (comments and strings are
    stripped, a source that declares the name itself is left alone)
    is in [injection.md](injection.md#unsafewindow-is-the-pages-window)
    and `src/unsafe-window-use.ts`.
- Running in MAIN world has costs the isolated world doesn't: the page
  can see and interfere with the script, and DOM injection is subject
  to the page's CSP. See
  [injection.md](injection.md#costs-of-running-in-main).

---

## Non-GM grants

<!-- Heading kept free of backticks and `_`: GitHub keeps the
     underscore in the slug, so "Non-`GM_*` grants" would anchor as
     `#non-gm_-grants` and every link below would 404. -->

Tampermonkey's `@grant` accepts a handful of names outside the
`GM_*` / `GM.*` pattern. This is the **complete** list — it's the same
set TM's own bundled linter validates against, so anything else
(`window.open`, `window.alert`, …) is invalid under TM too.

| Grant | Status | TM | VM | GM | Notes |
|-------|:------:|:--:|:--:|:--:|-------|
| `none` | ✅ | ✓ | ✓ | ✓ | Opts the script out of the whole GM surface, and out of the sandbox `window`: it gets the page's own. Wins over every other `@grant` line on the same script. Violentmonkey does exactly this (`grant.includes('none')` gates its API wrapper) and warns at install time with "`@grant none` disables all other `@grant` keys"; we say the same in a startup-log warning naming the overridden grants. `GM_info` is still exposed. See [supported-headers.md](supported-headers.md). |
| `unsafeWindow` | ✅ | ✓ | ✓ |   | The page's real `window`, reachable because scripts run in MAIN world unless they ask for isolation; by `@grant` or just by naming it. See [`unsafeWindow` and the execution world](#unsafewindow-and-the-execution-world). |
| `window.onurlchange` | ✅ | ✓ |   |   | SPA navigation hook. `window.onurlchange === null` feature-detects; `window.addEventListener('urlchange', info => …)` and the `window.onurlchange = fn` slot both work. See below. VM has never implemented it (feature request closed unimplemented), so scripts already carry the `=== null` guard. |
| `window.close` | ✅ | ✓ | ✓ (2.6.2+) |   | Closes the tab the script runs in, via the extension — the plain page API refuses to close a tab the script didn't open. See below. |
| `window.focus` | ✅ | ✓ | ✓ (2.12.10+) |   | Selects this tab and raises (un-minimizing) its browser window, neither of which page JS can do. See below. |

Greasemonkey 4 has no `window.*` grant family at all — only `GM.*`
and `none`.

Anything outside this table behaves like every other unknown `@grant`:
dropped from the binding set, reported in the "unknown @grant entries
dropped" diagnostic, and no binding at the call site.

### `window.close` / `window.focus`

Both replace a method the page already has with one the extension
performs, because the browser hobbles the page's own version.

- `window.close()` closes **this** tab. The page's own call is refused
  for any tab the script didn't open with `window.open`.
  - The **last** open tab is not closable — that would quit the
    browser. Same refusal TM gives.
- `window.focus()` brings **this** tab to the front: it selects the tab
  in its window and raises the window, restoring it first if it was
  minimized. The page's own call does nothing for a background tab.
  - Whether the window comes forward is up to the OS window manager —
    several Linux desktops flash the taskbar entry instead. Selecting
    the tab works regardless.
- Both take no arguments and return `undefined` immediately. The work
  itself happens in the background, so a `window.close()` isn't
  guaranteed to have happened by the next statement.
- The override is on the granting script's own `window` (`window.close()`,
  `self.close()`, bare `close()`), not on the page's. The page's own
  `window.close` / `window.focus` are unchanged, so a site can't
  detect the grant.
- **Isolated scripts (`@inject-into content`) share it.** They share
  one isolated world, and there the override replaces the method on
  that world's `window`. So an isolated script that never asked for
  `window.close` can still close your tab if a sibling isolated script
  on the same page did ask.
- A refused close or focus is logged to the page console and to the
  script's Log tab. A successful close takes the page with it, so
  there's nothing to report.

Differences from TM, detailed in
[GM-APIs.md](GM-APIs.md#windowclose--windowfocus): in the isolated
world, grant enforcement is per-document rather than per-script (the
bullet above). What each call does is matched to TM 5.5.0's own
implementation.

### `window.onurlchange`

What a script gets:

- `window.onurlchange === null` when the grant took effect, and
  `undefined` when it didn't. That's TM's documented feature test.
- `window.addEventListener('urlchange', handler)`. The handler
  receives a bare `{ url }` object — a null-prototype object whose
  only own property is the new absolute URL. Not a DOM `Event`; this
  matches TM exactly.
- `window.onurlchange = fn` as a handler slot. It takes a slot in the
  same list as `addEventListener`, so dispatch follows registration
  order across both forms; `= null` clears it without disturbing
  anything registered via `addEventListener`.
- `removeEventListener('urlchange', handler)` unregisters.

What fires it — matched against Tampermonkey 5.5.0:

| Event | Fires? |
|-------|:------:|
| `history.pushState` | ✅ |
| `history.replaceState` | ✅ |
| same-document back / forward | ✅ |
| fragment change (`location.hash = …`) | ✅ |
| `history.replaceState` to the *same* URL | ✅ (no de-duplication — TM doesn't suppress these either) |
| initial document load | ❌ (handle the starting URL directly, then listen — matches TM's own examples) |
| full cross-document navigation / reload | ❌ (a new document runs the script again) |
| a *sub-frame's* navigation, seen from the top frame | ❌ (events are frame-scoped, as in TM — and SourceMonkey doesn't run scripts in sub-frames at all today) |

Differences from TM, detailed in
[GM-APIs.md](GM-APIs.md#windowonurlchange):

- Grant enforcement is per-document, not per-script: once one script
  on a page grants it, sibling SourceMonkey scripts in the same
  isolated world can see it too. TM sandboxes each script's `window`
  and gates exactly.
- `@inject-into page` (MAIN world) is unsupported — as with every
  other non-`GM_info` binding.
- Delivery is asynchronous (a service-worker round-trip). So is TM's,
  which routes through its own background page.

---

## Logging

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_log` / `GM.log` | ✅ | ✓ | ✓ | ✓ | Thin `console.log` wrapper prefixed with `[SourceMonkey:<scriptId>]`. Arguments are passed through unchanged so Chrome's `%c` / `%o` formatters and DevTools object inspection still work. Returns `undefined`. |

---

## Storage

Page-side cache + batched async writes. `GM_getValue` is a synchronous
read from a per-document in-memory cache; the cache is seeded at
document start from a snapshot the SW attaches to the wrapper's
`sm:check-pending` reply. `GM.setValue` returns a Promise per GM4
spec. Per-script namespace — `GM_listValues` from script A never
returns script B's keys.

**Stored values keep their type.** TM and VM both require the value to
be JSON-serializable; we tag the ones JSON would mangle, so `Date`,
`RegExp`, `Map`, `Set`, `undefined`, `NaN`, `±Infinity`, `-0`,
`BigInt`, typed arrays, `ArrayBuffer`, `DataView` and `Error` all come
back as themselves on the next page load. Class prototypes,
`Blob`/`File` and shared-reference identity are not preserved, and a
circular reference throws. See
[GM-APIs-storage.md](GM-APIs-storage.md) for the full story, including
the [comparison with
VM](GM-APIs-storage.md#compared-with-violentmonkey).

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_setValue` / `GM.setValue` | ✅ | ✓ | ✓ | ✓ | Sync return on `GM_x`, Promise on `GM.x`. Writes made in one run of script code go to the worker together, a microtask later; anything left goes on `pagehide` / `visibilitychange → hidden`. Accepts more than JSON — see above; throws on a circular reference. |
| `GM_getValue` / `GM.getValue` | ✅ | ✓ | ✓ | ✓ | Sync read from the in-page cache; returns `defaultValue` for unknown keys. |
| `GM_deleteValue` / `GM.deleteValue` | ✅ | ✓ | ✓ | ✓ | Same flush/batching shape as `setValue`. |
| `GM_listValues` / `GM.listValues` | ✅ | ✓ | ✓ | ✓ | Returns the list of currently-known keys. |
| `GM_addValueChangeListener` / `GM.addValueChangeListener` | ✅ | ✓ | ✓ |   | Fires on local writes (`remote=false`) and on cross-tab broadcasts (`remote=true`). Signature: `cb(key, oldValue, newValue, remote)`. |
| `GM_removeValueChangeListener` / `GM.removeValueChangeListener` | ✅ | ✓ | ✓ |   | Unregister by the id returned from `add…`. |

### Storage caveats

- Writes are eventually-consistent across tabs. A live cross-tab
  broadcast covers already-running documents; new documents always
  fetch a fresh snapshot from the SW on `sm:check-pending`.
- Delivery survives an SW restart (the broadcast target list is
  mirrored to session storage), and a document running a
  value-change listener re-syncs its cache from the SW after an SW
  start or when the tab becomes visible — so a broadcast that does
  get lost is a delay rather than a permanent desync.
- If the SW doesn't answer whether to run within the wrapper's 10 s
  timeout, no script runs, and each says why in the page console. A
  storage-granting script also refuses to run when its stored values
  can't be read (no silent stale data). Reload to retry.
- Same-extension userscripts share the trust boundary —
  technically, userscript A can impersonate userscript B's
  `scriptId` in the storage envelope and corrupt B's keys. This is
  "A messes with B's data," not a privilege escalation against the
  user.

---

## DOM injection

In USER_SCRIPT world the page's CSP doesn't apply to inserted
elements, so these work even on pages with strict
`Content-Security-Policy: script-src 'self'`.

- Styles are exempt from the page's `style-src`.
- Scripts (inline or `src`) are checked against SourceMonkey's
  USER_SCRIPT world CSP instead, which allows both, as Tampermonkey's
  does.

A script running in the page's world gets the same exemption for
these two calls, as Tampermonkey's `GM_addElement` does: SourceMonkey
does the insert from its isolated world. A `<style>` or `<script>` the
script appends itself (`document.head.appendChild(…)`) is the page's,
and the page's CSP applies to it.

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_addStyle` / `GM.addStyle` | ✅ | ✓ | ✓ |   | Creates a `<style>` and appends to `document.head` (or `documentElement` if head isn't there yet). Returns the element. |
| `GM_addElement` / `GM.addElement` | ✅ | ✓ | ✓ |   | Two signatures: `GM_addElement(tag, attrs?)` appends to `<head>` for `script`/`style`/`link`/`meta`/`title`/`base` and to `<body>` for everything else (routing by tag as VM does; TM differs — see below); `GM_addElement(parent, tag, attrs?)` appends to the given parent. `attrs.textContent` is a recognized pseudo-attribute. Boolean `false` attrs are omitted (avoids the `disabled="false"` foot-gun); `true` serializes as `""` per HTML spec. `innerHTML` is **not** recognized as a pseudo-attribute by design — call it on the returned element if you need it. **Cross-manager note:** TM appends to `<head>` regardless of tag in the no-parent form, so a `GM_addElement('p', ...)` lands in `<head>` under TM but in `<body>` under SM/VM. The TM docs don't pin the default parent down, so neither rule is wrong — SM routes by tag as VM does, because that's more useful for non-head tags. SM's head list is a superset: VM's stops at `script`/`style`/`link`/`meta`, so `title` and `base` land in `<body>` there and in `<head>` here. |

---

## Clipboard

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_setClipboard` / `GM.setClipboard` | ✅ | ✓ | ✓ |   | Via `navigator.clipboard.writeText` from USER_SCRIPT world. Returns the underlying Promise (TM's `GM_setClipboard` is fire-and-forget `undefined`; we hand back the Promise so callers can `await`). The `type` argument is not honored — only `text/plain` is written today. May reject with `NotAllowedError` on pages without focus / transient activation. |

---

## XHR

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | ✅ | ✓ | ✓ | ✓ (`GM.xmlHttpRequest` only) | Returns `{abort}` synchronously. SW-side `fetch` with `AbortController`; the body streams back to the originating tab in pieces, with progress events. No size cap. |

### XHR details object

`GM_xmlhttpRequest(details)` accepts (in addition to TM/VM's surface):

| Field | Notes |
|-------|-------|
| `method` | Default `GET`. Uppercased before send. |
| `url` | Required. A `URL` object works too. |
| `headers` | Plain object. Any header, including ones the browser normally forbids a script to set — see [Forbidden headers](#forbidden-headers). |
| `data` | Body. String only today; non-string falls through `String(...)`. |
| `timeout` | Milliseconds. Aborts the request and fires `ontimeout`. |
| `responseType` | `text` (default) / `json` / `blob` / `arraybuffer` / `document` / `stream`. With `stream` (as in TM), `response` is a `ReadableStream` of the body's bytes from `onloadstart` on, fed as they arrive. |
| `anonymous` | `true` sends the request without the user's cookies (and any cached HTTP-auth credentials). Default `false` — see [Credentials](#credentials). |
| `onload`, `onerror`, `ontimeout`, `onabort` | Terminal callbacks: exactly one fires. Callbacks aren't serializable across the SW boundary so they stay on the page side keyed by request id. |
| `onloadstart` | Once the extension has taken the request, with `readyState: 1`. |
| `onreadystatechange` | At `readyState` 2 (headers in), 3 (body arriving) and 4 (just before the terminal callback), the order XMLHttpRequest uses. |
| `onprogress` | Per piece of the body, with `lengthComputable`, `loaded` and `total` beside the response fields. For text types, `responseText` is the text so far. |
| `onloadend` | After the terminal callback, with the same object. |

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
| `readyState` | `4` (done) for the terminal callbacks; 1-3 in the earlier ones. |

For `responseType: 'blob'` / `'arraybuffer'` / `'document'`: same
shape, except `responseText` is empty (`document` populates it) and
`response` is the reconstructed native object (`Blob`,
`ArrayBuffer`, or `Document`). The SW sends the bytes as base64
pieces; the page-side runtime decodes and rebuilds.

For `responseType: 'stream'`: `responseText` is empty and `response`
is the `ReadableStream` in every callback. It closes on `load`, and
on a failure rejects reads with the error (an `AbortError` or
`TimeoutError` for those). Cancelling it aborts the request.

`ontimeout` and `onabort` get the empty shape of a failed request:
`readyState: 4`, `status: 0`, empty `statusText` / `responseText` /
`responseHeaders`, `response: null`, and `finalUrl` set to the request
URL. `onerror` gets the same plus `error`. `onreadystatechange`
receives the same object as the terminal callback that follows it.

### `@connect` gating

A request goes when a `@connect` rule covers its host, or it goes to
the page's own origin (scheme, host and port). For any other http(s)
host, SourceMonkey asks the user, as TM does, and keeps the answer for
the script. Design: [connect-permissions.md](connect-permissions.md).

- **Allow once** or **Cancel** settles just the requests waiting, and
  the next one asks again. Closing the prompt counts as Cancel.
- **Allow** (that site) or **Allow all sites** lasts until reset under
  Network access on the script's page, or the script is removed.
- **Deny** lasts until reset, the same way.
- A request whose prompt gets no answer in 4 minutes fails, and the
  prompt closes. A script gets at most 3 prompts open at once.
- Granting `GM_xmlhttpRequest` with no `@connect` gets an info note at
  install time (viewer Log tab, page console, `sm-dev validate`).
- A relative URL resolves against the page, as in TM and VM.

Grammar:

| Form | Meaning |
|------|---------|
| `@connect *` | Allow any host. |
| `@connect self` | Allow the script's own `@match` / `@include` hosts. |
| `@connect example.com` | Allow `example.com` AND any subdomain (`api.example.com`), as TM documents. Whole labels only: `evilexample.com` doesn't match. An IP or single-label name (`127.0.0.1`, `localhost`) matches only exactly. Multi-label public suffixes aren't special-cased, so `@connect co.uk` covers all of `.co.uk`. |
| `@connect *.example.com` | The same: `example.com` itself AND any subdomain. |
| `@connect https://example.com` | Same as `@connect example.com` (scheme stripped). |

A refused request fires `onerror` with one of these, all from
`gm-connect.ts`, so the pre-flight check and the post-redirect
re-check say the same thing:

- `connectDeniedMessage`: the user denied the host.
- `connectCancelledMessage`: the user cancelled (or closed) the prompt.
- `connectUnansweredMessage`: the prompt had no answer in time.
- `connectPromptFailedMessage`: the prompt couldn't be opened.
- `connectBlockedMessage`: the header can't cover it, only for a URL
  with no host (`file:`, `data:`) under rules other than `@connect *`.

Two near neighbours deliberately name no rule, because the script's
header isn't what refused the call:

- A URL that won't parse. The request fails for a script with
  `@connect *` too.
- A failure to evaluate the rules at all, which carries `Internal
  error:`.

### Credentials

- Requests carry the user's cookies for the target host by default, as
  in Tampermonkey and Violentmonkey. Reading another site *as the
  signed-in user* is most of the reason to reach for
  `GM_xmlhttpRequest`.
- `SameSite=Lax` / `Strict` cookies are sent too.
- `anonymous: true` opts a single request out — no cookies, and no
  cached HTTP-auth credentials.
- Chrome's restricted hosts (the Web Store, policy-blocked hosts) are
  the one place the credentialed default can *lose*: a response that
  allows any origin refuses a credentialed reader. `anonymous: true`
  is the way through.

Why the request is written the way it is — and the rest of the
cookie-handling detail — is in
[`GM-APIs.md`](GM-APIs.md#gm_xmlhttprequest).

### Forbidden headers

- The browser reserves some request headers for itself and refuses to
  let *any* script set them: `Origin`, `Referer`, `Cookie`, `Host`,
  `User-Agent`, the transport ones (`Connection`, `Content-Length`,
  `Transfer-Encoding`, `Accept-Encoding`, …), and everything beginning
  `Sec-` or `Proxy-`. (The
  [Fetch Standard](https://fetch.spec.whatwg.org/) — the web standard
  behind `fetch` — calls them *forbidden request headers*.)
  `GM_xmlhttpRequest` sets them anyway: pass them in `headers` like
  any other header.
- That includes headers that can break a request rather than shape it
  — a wrong `Content-Length` desyncs it. `fetch` used to swallow those
  harmlessly; now the script gets what it asked for.
- `Sec-Fetch-Site` is the one worth knowing about. It tells a server
  whether a request came from its own pages, and a request issued by
  an extension always says `none` — a value no page can produce.
  Sites that gate an API on same-origin requests refuse everything
  `GM_xmlhttpRequest` sends until the script sets
  `'Sec-Fetch-Site': 'same-origin'`.
- Setting it defeats a defense the site put there on purpose, so it is
  never done for the script. `@connect` is the gate that makes it the
  user's decision.
- `Origin` is *removed* by default on the methods that send one (a GET
  or HEAD never carries it). Left alone it would say
  `chrome-extension://<id>`, which tells the target nothing useful and
  advertises that the user runs SourceMonkey. A script that wants one
  can set it.
- A `Cookie` the script sets replaces the browser's own for that
  request — a way to send a different session, or none.

How this is done, and what it can't cover:
[xhr-header-surgery.md](xhr-header-surgery.md).

### What `@connect` grants

- `@connect <host>` lets the script *act as the user* on that host,
  not merely fetch a URL from it. `@connect *` says that about every
  host, and so does answering the prompt with Allow. The script
  details' "Network access" tooltip spells this out, and the prompt
  says so too.
- A redirect off the allowlist still makes its outbound hop, and that
  hop is credentialed too. The script can't read the response (the
  post-redirect re-check drops it), but it can provoke a
  cookie-bearing request to a host `@connect` never named.

### XHR caveats

- HTTP error statuses (404, 500, …) fire `onload` with the
  non-2xx status — matches XHR semantics. Only network-level
  failures (DNS, ECONNREFUSED, etc.) fire `onerror`.
  - Their `error` is `Could not reach <host>. The name may not
    resolve, or the connection was refused, failed or blocked.` rather than
    the browser's bare `Failed to fetch`, which says the same for all
    of these causes.
- No upload progress (`upload.onprogress`).
- Forbidden headers are per-request: overlapping requests to one URL,
  across scripts or within one, each carry only their own overrides.
  SourceMonkey makes none of them wait for another. (Chrome itself
  still serializes two identical concurrent GETs, through its HTTP
  cache — that predates and outlives anything here.)
- There is no default `timeout` (matching Tampermonkey/Violentmonkey),
  but a server that never sends response headers is usually given up on
  after 2 minutes with `The server sent no response headers within 2
  minutes, so this request was given up on`. Only the wait for headers
  is capped — a slow download that has started is left alone.
  - "Usually" because the extension's worker can be shut down while a
    wedged request waits; the script then gets the 5-minute
    no-response error instead.
- Closing the tab cancels its in-flight requests. A `GM_download`
  started from that tab keeps going; a `GM_xmlhttpRequest` does not,
  since its response has nowhere left to go.
- A redirect goes out without the overrides: the rule matches the
  original URL only. A `Cookie` override doesn't follow, so the user's
  own cookies reach the redirect target instead.
- If the headers can't be applied at all, the request fails with
  `The headers this request asked for could not be applied, so it was
  not sent` rather than going out without them.
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

`details.url` is resolved against the page first (its `<base href>`,
else its own URL), so relative URLs (`GM_download('/files/a.zip', …)`)
work like they do in TM.

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
  enumerate in its header. Gating them on `@connect` would prompt for
  nearly every download a script that grants `GM_download` makes.
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

## Cookies

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_cookie` / `GM.cookie` | ✅ | ✓ | ✓ |   | `.list` / `.set` / `.delete` over the browser's cookie jar (`chrome.cookies`), for URLs the script's own rules cover. |

### Cookie call shape

- `GM_cookie.list(details, cb)` — `cb(cookies, error)`.
- `GM_cookie.set(details, cb?)` / `GM_cookie.delete(details, cb?)` —
  `cb(error)`, `undefined` on success.
- `GM_cookie(action, details, cb)` — the same, by name (TM's form).
- The legacy form returns `undefined`; errors reach the callback as
  strings, as in TM.
- `GM.cookie.list(details)` / `.set` / `.delete` return Promises. `list`
  resolves to the cookies; a failure rejects with an `Error`.

### Cookie details

- `url` — the URL the call is about. Defaults to the page's (the
  frame's) URL; a relative one resolves against it.
- `list` filters: `domain`, `name`, `path`, `partitionKey`. A `domain`
  without a `url` lists that domain's cookies, its subdomains'
  included.
- `set`: `name`, `value`, `domain`, `path`, `secure`, `sameSite`,
  `expirationDate` (seconds since the epoch; leave it out for a
  session cookie), `partitionKey`. `secure` defaults to whether the
  URL is https.
- `delete`: `name` (required), `partitionKey`.
- Each listed cookie has `name`, `value`, `domain`, `path`, `secure`,
  `httpOnly`, `sameSite`, `session`, `hostOnly`, and `expirationDate`
  / `partitionKey` when set: TM's fields.

### What a script can reach

- **Only URLs its own `@match` / `@include` rules cover** (and no
  `@exclude` does), as in TM and VM. A `domain`-only `list` is checked
  as `https://<domain>/`. Anything else is refused with an error.
- **No `httpOnly` cookies.** `list` leaves them out, and `set` and
  `delete` refuse any call that could make, replace or remove one: a
  cookie of that name sent to the URL, or on its domain. TM and VM both hide
  them on Chrome by default, and each has a setting to allow them;
  SourceMonkey has no such setting yet.
- Only http(s) URLs: the browser keeps no cookies for the others.
- In an incognito tab, the incognito cookie jar.
- A refused or failed call is also logged on the script's Log tab.

---

## Menu commands

| API | Status | TM | VM | GM | Notes |
|-----|:------:|:--:|:--:|:--:|-------|
| `GM_registerMenuCommand` / `GM.registerMenuCommand` | ✅ | ✓ | ✓ |   | Adds an entry under the script's row in SourceMonkey's toolbar popup. See below. |
| `GM_unregisterMenuCommand` / `GM.unregisterMenuCommand` | ✅ | ✓ | ✓ |   | Removes the entry. Unknown ids are silent. |

### Menu-command call shape

- `GM_registerMenuCommand(name, callback, accessKeyOrOpts?)`:
  - `name` — visible label, shown under the script's row in the
    toolbar popup.
  - `callback` — invoked in the userscript's sandbox when the user
    picks the entry; required.
  - `accessKeyOrOpts.id` — pass a stable id to update an existing
    entry instead of duplicating it (matches TM/VM).
- Returns the command id. Pass that id to
  `GM_unregisterMenuCommand` to remove the entry.

### Menu lifecycle

- Entries are scoped to the (tab, document) the wrapper ran in. SPA
  pushState preserves them; a fresh document load clears them and the
  new wrapper re-registers.
- A bfcache restore (back/forward) does **not** bring them back: the
  entries were dropped when the tab left the page, and Chrome doesn't
  re-run the script on a restore, so the page's menu stays empty until
  a real document load. Re-registering on `pageshow` works around it.
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

Granting any of these names logs an "Ignoring unsupported @grant …"
warning. Detection happens at parse time; the diagnostic is persisted
on the stored script and surfaces two ways:

- a `console.info` in the **page** DevTools console (via the wrapper's
  startup-log channel — see [docs/logging.md][logging]) on every
  matching page load (`console.info`, not `.warn` — injected warn/error
  leak into chrome://extensions/?errors), and
- a `warning`-level row in the viewer's Log tab, emitted once per
  loaded content version right after the "Loaded new content" line.

The script's call sites get a `ReferenceError`. Adding any of these
is a catalog entry + a body — nothing structural.

[logging]: logging.md#page-console-startup-logs

- `GM_getValues` / `GM_setValues` / `GM_deleteValues` — bulk storage
  reads and writes (TM 5.x, VM 2.19.1+). Our per-call storage APIs
  already batch writes, so these are convenience, not throughput.
- `GM_audio`, `GM_webRequest`, `GM_getTab`, `GM_saveTab`,
  `GM_getTabs` — TM-specific surface.
- `GM.bootstrap`, `GM_NEXT_API_FROM_TM`, etc. — moving targets.

---

## What's been tested

Every implemented API has both a unit test (binding emission,
runtime helpers) and an end-to-end test (real userscript driving
the API in headless Chromium). See [testing.md](testing.md#gm-test-coverage).
