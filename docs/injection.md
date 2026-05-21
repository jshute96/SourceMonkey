# Injection (chrome.userScripts)

How SourceMonkey actually runs the matching userscripts on a page.

Related modules:

- [matching.md](matching.md) — the URL evaluator and the per-tab badge.
  Note: matching and injection use the **same** stored
  `@match`/`@include`/`@exclude` data but evaluate it via two different
  code paths (ours for the badge, Chrome's for actual injection).
- [storage.md](storage.md) — `StoredScript` is the source of truth.

## API choice

Chrome's [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
API (Chrome 120+) is purpose-built for userscript managers and is what
Tampermonkey / Violentmonkey use in MV3. We picked it over
`chrome.scripting.executeScript` because:

- It accepts arbitrary script **strings** (`{ code }`), where
  `chrome.scripting` only takes file references or function objects.
- Registration is **declarative** — we hand Chrome the
  patterns + code + runAt once, and Chrome owns matching + injection
  from there. Injection is **document-creation-scoped**, like content
  scripts: scripts run when Chrome creates a new document for a
  matching URL. Same-document SPA navigations
  (`history.pushState` / `replaceState`) do **not** create a new
  document and do **not** re-fire scripts; nor do bfcache restores
  (back/forward into a cached document). A full reload always creates
  a fresh document, so scripts run.
- It runs in the dedicated `USER_SCRIPT` world, isolated from both the
  page and our content-script world (we currently use no content
  scripts).

## One-time user opt-in

Chrome requires an explicit user toggle before the API will execute:

- **Chrome ≥ 138**: "Allow User Scripts" toggle on the extension's
  details page (`chrome://extensions/?id=<extId>`).
- **Chrome 120–137**: Developer mode toggle on `chrome://extensions`.

Until the user flips that, **every** `register()` call throws. The
badge logic is unaffected (it's local code, not the userScripts API),
so the toolbar still counts matches — only injection is blocked.

The options page probes the API at render time and shows a banner with
a copy-pasteable `chrome://extensions/?id=<id>` link when the call
fails.

## Lifecycle

`src/injector.ts` owns Chrome's registration set.

- **On SW startup** — `syncRegistrations()` runs in parallel with the
  match-index load. Chrome retains registrations across SW restarts,
  so we wipe-and-replace to guarantee the post-startup state matches
  storage exactly.
- **On every cache change** — the match-index already fires
  `onCacheChanged` for `script:*` / `source:*` mutations. The SW
  subscribes a second listener that re-runs `syncRegistrations()`,
  alongside the existing badge re-evaluation.
- **One-time world config** — `chrome.userScripts.configureWorld({
  messaging: true })` is called before the first `register()`. This is
  what lets the injected wrapper call `chrome.runtime.sendMessage`
  back to the SW.

The sync strategy is **full wipe + re-register** every time:

1. `getScripts()` — list everything Chrome currently has registered.
2. `unregister({ ids: [...] })` — drop them all.
3. `register([...])` — install the fresh spec list. If the batch
   rejects (e.g. one script has a malformed pattern), we fall back to
   per-script `register([spec])` calls so a single bad script can't
   take down every other script.

Per-script failures land in `getPerScriptErrors()` keyed by script ID
so the UI can eventually surface them next to the offending script.

This is dramatically simpler than diffing and is cheap at our scale
(tens of scripts, not thousands).

## What gets registered

For each `status: 'ok'` script whose own `enabled` flag **and** parent
source's `enabled` flag are both true, we build a
`RegisteredUserScript`:

- `id` — the stored script UUID.
- `matches` — `@match` patterns, passed through verbatim (Chrome
  match-pattern grammar).
- `includeGlobs` — `@include` glob patterns.
- `excludeGlobs` — `@exclude` glob patterns.
- `js: [{ code: <wrapped body> }]` — the script body wrapped in our
  activation/error shim (see below).
- `runAt` — derived from `@run-at` on the parsed header
  (`document-start` / `document-body` → `document_start`,
  `document-end` → `document_end`, default / anything else →
  `document_idle`).
- `world` — `'MAIN'` (the page's own world) or `'USER_SCRIPT'`
  (Chrome's isolated user-script world), resolved per script — see
  [Execution world](#execution-world) below.

### Execution world

The `world` field decides whether the body runs in the page's own
`window` (MAIN) or in Chrome's isolated user-script context
(USER_SCRIPT). The two worlds share the DOM but have separate
`window` objects, so a USER_SCRIPT-world script cannot see
page-defined globals like `window.jQuery`, `window.map`, or any
function declared by an inline `<script>` tag on the page.

Resolution (`resolveWorld` in `src/injector.ts`) mirrors
Violentmonkey's `@inject-into` and Tampermonkey's `@grant none`
default:

- `// @inject-into page` → MAIN.
- `// @inject-into content` → USER_SCRIPT.
- `// @inject-into auto` / unspecified → MAIN when there are no
  `@grant` entries or every `@grant` is `none`; USER_SCRIPT
  otherwise.

Why a `@grant none` script defaults to MAIN: scripts that opt out of
`GM_*` (the conventional `@grant none` declaration) almost always
intend to talk to the page directly — read its globals, call its
functions, hook its jQuery. Running them in the isolated world
silently breaks any such script. Tampermonkey runs `@grant none`
scripts in page context for the same reason.

#### MAIN-world telemetry — the bridge

`chrome.runtime.sendMessage` is not exposed to MAIN-world scripts, so
the wrapper's `sm:start` / `sm:error` reports can't reach the SW
directly from MAIN. To still get them through:

- `__smSend` in `wrapper-head.js` feature-detects
  `chrome.runtime.sendMessage`. In USER_SCRIPT world it calls it
  directly; in MAIN world it falls back to `window.postMessage({ __sm:
  "sourcemonkey-bridge", payload })`.
- `src/wrapper-bridge.js` is a tiny USER_SCRIPT-world script registered
  alongside user scripts. It listens for those postMessages, validates
  the marker + `event.source === window`, and forwards the payload to
  the SW via `chrome.runtime.sendMessage`.
- `buildBridgeSpec` (in `src/injector.ts`) emits the bridge
  registration when at least one active script resolves to MAIN. The
  bridge matches `<all_urls>` and runs at `document_start` so its
  listener is installed before any wrapper's queued postMessage event
  dispatches.

Trust model:

- The bridge requires `event.source === window` plus the marker, so
  cross-origin frames can't reach it.
- It does **not** stop the host page from forging messages. Once any
  MAIN-world wrapper runs, the page can observe our postMessage
  payloads on its own window and learn the stored script `id` and any
  `sm:error` `message` text, then send fakes with whatever marker /
  ids it just saw.
- A forged `sm:start` flips a script's badge entry from MISSING to OK
  on that document; a forged `sm:error` writes an attacker-controlled
  string into the SW console and per-tab session record. Neither
  grants script execution or SW privilege.
- If a real boundary is needed later, inject a per-document nonce into
  both the MAIN wrapper's head and the bridge spec and require it on
  incoming messages.

`GM_*` is not supported anywhere yet (see Limitations); the
`@grant`-keyed branch just future-proofs the resolver for when it is.

### /regex/ pattern forms

The User Scripts API has no equivalent for `/regex/` `@include` /
`@exclude` patterns, so we work around it with a two-layer approach:

- **Registration layer.** Glob `@include` / `@exclude` patterns go to
  `includeGlobs` / `excludeGlobs`. `@match` goes to `matches`. If a
  script's *only* includes are regexes (no `@match`, no glob
  `@include`), we register with `matches: ['<all_urls>']` so Chrome
  hands us every page.
- **Wrapper layer.** When a script has any regex pattern, the wrapper
  embeds the full `{matches, includes, excludes}` object and a small
  self-contained matcher equivalent to `urlMatchesScript()`. Before
  the body runs, the wrapper re-checks `location.href` and silently
  returns if it doesn't match.

Net effect: badge and injection stay in sync. The wrapper-side
matcher must agree byte-for-byte with `src/url-match.ts`; a unit test
eval's the embedded snippet to verify the regex-relevant cases.

## The activation / error wrapper

The wrapper lives in several plain JavaScript files, which the build
(`scripts/build.mjs`) minifies to a single line each and emits as
exported constants in `dist/generated-wrappers.js`. The type
declarations are hand-written in `src/generated-wrappers.d.ts` (tsc
type-checks against the `.d.ts`; the runtime `.js` is built directly
into `dist/`). The fragments:

- `src/wrapper-head.js` — IIFE open, `__smName` / `__smId` /
  `__smSend` declarations, `__smAwaitDecision` (the [reload
  fast-path](#reload-fast-path) round-trip), the matcher slot (filled
  per script), and the decision callback that branches into
  run / run-new / skip. The default-run branch installs the async
  error listeners, sends `sm:start`, and opens `try {`.
- `src/wrapper-tail.js` — closing `catch (__smErr) {…}` for the body,
  the closing `})` of the decision callback, and the IIFE close
  `})();`.
- `src/wrapper-matcher.js` — the URL recheck (only inserted for
  scripts with `/regex/` patterns; see below).
- `src/wrapper-bridge.js` — USER_SCRIPT-world relay registered
  separately when any MAIN-world script is active (see [MAIN-world
  telemetry — the bridge](#main-world-telemetry--the-bridge)).

Why one line: the HEAD is concatenated immediately before the user's
body with no trailing newline, so the body's line N lands at physical
line N of the registered script — *body* line N, not source-file line
N. The header lines (the `// ==UserScript== … // ==/UserScript==`
block) are stripped before the body is sent to Chrome, so a stack
trace pointing at "line 7" means line 7 of the body, not line 7 of
the `.user.js` file. Column offsets on body line 1 are still shifted
by the HEAD's character count; line numbers are not.

Placeholders the injector substitutes at registration time:

- `"__SM_NAME__"` → JSON-encoded `@name` (or relativePath fallback).
- `"__SM_ID__"` → JSON-encoded stored script UUID.
- `"__SM_SOURCE_URL__"` → JSON-encoded `sourcemonkey://<id>/<name>.user.js`
  string. The injector also appends a `# sourceURL=<same>` directive
  to the wrapped body so devtools labels the script with that URL AND
  the wrapper's async-error listeners can attribute errors by stack
  inspection.
- `"__SM_MATCHER_BLOCK__";` → empty, or the minified matcher source
  (which itself contains a `"__SM_MATCHING__"` placeholder).
- `"__SM_MATCHING__"` (inside the matcher) → JSON-encoded
  `{matches, includes, excludes}`.

Substitutions go through `String.replace(pattern, () => …)` callbacks
so a literal `$&` inside the matcher (used as a regex back-reference
in its escape helper) isn't expanded by `String.replace`'s
replacement-string syntax.

Every registered body is wrapped in a tiny shim that:

- Logs `"[SourceMonkey] script <name> running on <url>"` to the page
  console.
- Sends a `{ type: 'sm:start', id, url }` message to the SW.
- Wraps the body in `try { … } catch (__smErr) { … }`:
  - Logs `"[SourceMonkey] script <name> threw: …"` to the page console.
  - Sends a `{ type: 'sm:error', id, url, message }` message to the SW.
- Installs window `"error"` and `"unhandledrejection"` listeners,
  filtered by the per-script sourceURL (see [Async-error attribution](#async-error-attribution)
  below).
- All telemetry goes through `__smSend`. In USER_SCRIPT world it uses
  `chrome.runtime.sendMessage` (catching the sync throw and silencing
  the returned Promise so an unreachable SW doesn't surface as
  `Uncaught (in promise)` on every page). In MAIN world (where
  `chrome.runtime` is undefined) it falls back to `window.postMessage`
  with a marker the bridge picks up — see [MAIN-world telemetry — the
  bridge](#main-world-telemetry--the-bridge).

### Async-error attribution

The body's `try`/`catch` only catches **synchronous** throws — once
the script returns control to the event loop, anything thrown later
(from `setTimeout`, `addEventListener` callbacks, `fetch().then`,
`MutationObserver`, etc.) escapes it.

To catch those without falsely attributing the page's own errors to
this script, the wrapper:

- Appends `# sourceURL=sourcemonkey://<id>/<safe-name>.user.js` to the
  wrapped body. The JS engine tags stack frames originating in this
  registered script with that URL, and devtools labels the script
  with it.
- Stores the same URL in `__smSourceUrl` inside the wrapper IIFE.
- Installs `window.addEventListener("error", …)` and
  `…("unhandledrejection", …)`, both with the capture flag set.
- Each listener checks the event's `filename` (for `error`) and
  `error.stack` / `reason.stack` for the marker via `indexOf`. Only
  hits are reported via `__smSend({ type: 'sm:error', … })`; the
  default page-side error logging is left in place (no
  `preventDefault`).
- A `WeakSet` de-dupes the error object so the same throw isn't
  reported twice if it reaches both paths.

Trade-offs:

- The sync `try`/`catch` and the async listeners can both fire for a
  single error if the body throws synchronously AND the page re-emits
  it as a global error. The `WeakSet` keeps the listener path silent
  in that case.
- MAIN-world scripts share `window` with the page; the sourceURL
  filter is what keeps attribution honest.
- Multiple userscripts in the same world each install their own
  listeners; only the listener whose `__smSourceUrl` shows up in the
  stack reports, so a single error produces a single `sm:error`.
- Stack-trace-free rejections (e.g. `Promise.reject("string")`) can't
  be attributed and are silently dropped — better than guessing.

### Message flow

`background.ts` owns a single `chrome.runtime.onUserScriptMessage`
listener that handles these wrapper-originated message types:

- `sm:check-pending` — round-trip; the SW replies with `run`,
  `run-new`, or `skip`. See [Reload fast-path](#reload-fast-path).
- `sm:start` — the wrapper's baked-in body started running.
- `sm:swapped` — the wrapper ran a SW-supplied body instead. Treated
  as `started` for badge purposes and clears any prior stale flag for
  this script id.
- `sm:error` — synchronous or attributed-async throw.
- `sm:abandoned` — the wrapper exited without running anything
  (SW replied `skip`). Logged only; no badge change.

For the report types (start / swapped / error) the SW:

- Logs the event to the SW console.
- Looks up the sender tab's state in `chrome.storage.session` and
  merges the report into the tab's `actual` map (script ID → `{state,
  name, message?}`).
- Re-renders the toolbar badge — color + tooltip — from the union of
  expected and actual entries. See
  [matching.md](matching.md#per-tab-badge--tooltip) for the
  classification rules.

Wrapper payloads include `id`, `name`, `url`, plus (for `sm:error`) a
`message`. `name` lets the SW label UNEXPECTED scripts that aren't in
the expected match set.

> **Note:** messages from the USER_SCRIPT world arrive on
> `chrome.runtime.onUserScriptMessage`, NOT the regular
> `chrome.runtime.onMessage` event. Listening on the wrong event
> manifests as `"Receiving end does not exist"` on every send.

## Reload fast-path

When the user explicitly reloads a tab (Ctrl-R, toolbar reload,
`location.reload()`), Chrome sets `transitionType
=== 'reload'` on the `webNavigation.onCommitted` event. SourceMonkey uses
that signal to opportunistically pick up edited userscripts on THIS
reload rather than the next one.

### Why this exists

Without the fast-path, the flow for "edit script, reload tab" is:

1. Reload commits → `sm:start` for the OLD body fires.
2. Opportunistic refresh detects the file changed; storage updates;
   chrome.userScripts re-registers.
3. The badge flips to RELOAD/purple.
4. User clicks reload AGAIN → new body finally runs.

Two clicks per edit gets annoying fast. The fast-path collapses it to
one for the common "edited file is already on disk before reload"
case.

### Setup

`onCommitted` with `transitionType === 'reload'` calls
`setupReloadFastPath(tabId, documentId, url)`. That function:

- Awaits `ensureLoaded()`, then computes the URL's match set via the
  in-memory match index (no I/O).
- Calls `updateScript(id, 'manual')` for each match. Manual mode
  bypasses the opportunistic 10s rate-limit.
- Stashes the resulting promises in `fastPathByDoc[tabId:docId]` with
  a 15s TTL cleanup timer.

Setup is fire-and-forget. The listener does not block on it. If a
wrapper's `sm:check-pending` arrives before setup populates the entry,
it just gets the default `run` reply — the optimization is best-effort.

### sm:check-pending handler

When a wrapper sends `sm:check-pending` with its own `id`, `loadedAt`
(the value baked in at registration), and `url`, the SW:

1. Looks up `fastPathByDoc[tabId:docId]`. **No entry → reply `run`.**
   This is the common case for ordinary navigations and costs ~1–5ms
   round-trip.
2. Finds the script's `FastPathScriptEntry`. **Not present → reply
   `run`.** (Script matched the URL pattern but was added/removed
   between setup and the wrapper firing.)
3. Marks the entry consumed (per-script guard against double-reply).
   If every script has now consumed, deletes the entry early so a
   follow-up wrapper from a different document isn't blocked by the
   consumed-set.
4. Races the script's `updateScript` promise against
   `RELOAD_FAST_PATH_WINDOW_MS` (500ms) from setup start.
   - Timer wins → reply `run`. The refresh keeps running in the
     background; storage.onChanged → `scheduleSync()` will land the
     new body for the NEXT reload.
   - Refresh wins with `status !== 'ok'` OR `loadedAt <=
     wrapper.loadedAt` → reply `run` (no change to apply).
   - Refresh wins with a strictly-newer `ok` row → reply `run-new`
     with `bodyText` and the new `loadedAt`.

There is no separate 5s loading phase. The current updater does
detection + fetch + parse + storage write in one `updateScript` call,
and file:// reads are fast enough that 500ms covers the common case.
If we add HTTP-fetched scripts later, a second timeout for the body
fetch belongs here.

### Wrapper protocol

The wrapper-head opens an outer IIFE, runs the matcher (which `return`s
out early on a non-match), then calls `__smAwaitDecision`. The
decision callback receives `{action}` and branches:

- `run` — installs async error listeners, sends `sm:start`, opens
  the `try {` that wraps the baked-in body. Tail closes it.
- `run-new` — installs the async error listeners with the NEW
  `loadedAt`, sends `sm:swapped`, and `eval`s the SW-supplied body
  string with `//# sourceURL=` appended so async error attribution
  continues to work for the new code. Errors during the new body are
  reported as `sm:error` with the new `loadedAt`.
- `skip` — sends `sm:abandoned` and exits without running anything.

Wrapper-side safety timeout (6s) protects against the SW vanishing
mid-handshake; on hit it defaults to `run` so the baked-in body still
executes.

### Caveats

- **MAIN-world scripts** can't call `chrome.runtime.sendMessage`
  directly, so they round-trip `sm:check-pending` via
  `wrapper-bridge.js` using a `sourcemonkey-bridge-reply` postMessage
  keyed on a per-request nonce. The page can observe and forge these
  postMessages — the threat model is unchanged from the existing
  bridge (the page already runs arbitrary code in MAIN world). Where
  the page's CSP forbids `unsafe-eval`, the swap eval throws; the
  wrapper detects the CSP marker in the error message and falls
  through to running the baked-in body, matching pre-fast-path
  behavior for that site.
- **Latency on every navigation, not just reloads.** Every wrapper
  round-trips `sm:check-pending` regardless of `transitionType` — the
  SW just replies `run` faster when there's no fast-path entry. For
  USER_SCRIPT-world scripts that's ~1–5ms on the document-start
  critical path; for MAIN-world (which routes through `wrapper-bridge.js`
  via postMessage) it's roughly 2–3x that.
- **Race vs. setup.** If a wrapper fires before `setupReloadFastPath`
  finishes its `await ensureLoaded()` step, it gets `run` and the
  reload behaves like before. The opportunistic refresh kicked off by
  `updateTabMatches` still runs and the next reload picks up the
  change.
- **Cleanup.** Entries self-delete once every matched script has
  consumed them, on a 15s TTL, and on `chrome.tabs.onRemoved`.

### Trade-offs of wrapping

- The body's `try`/`catch` only catches synchronous throws; async
  failures are caught by the filtered window listeners described in
  [Async-error attribution](#async-error-attribution).
- Stack-frame filtering is the load-bearing piece. If a future Chrome
  release strips `# sourceURL=` from `error.stack` (it never has, but
  no spec guarantees it), the wrapper would silently stop catching
  async errors. The unit tests for the wrapped output guard against
  the directive being dropped during build.

## Limitations / future work

- **No `@grant` / `GM_*` support.** Only `@grant none` scripts behave
  correctly — anything referencing `GM_setValue` / `GM_xmlhttpRequest`
  / etc. throws on first call. A real bridge means a per-API shim
  injected via `configureWorld({ csp, messaging })` plus SW-side
  message handlers. Tracked in `TODO.md`.
- **`@require` / `@resource`.** Not loaded at all. We'd fetch them at
  registration time and either prepend them to the body or use
  separate entries in `js: []`. Tracked in `TODO.md`.
- **No frame control.** We don't set `allFrames`, so scripts only run
  in the top frame. Adding `@noframes` parsing + a `allFrames` flip
  is straightforward.
