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

The sources page probes the API at render time and shows a banner with
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
- `js` — the per-script config blob, the inlined prelude, the user
  program (every `@require` concatenated ahead of the script's own
  body, so they share one lexical scope), and a trailing
  parse-failure sentinel. The combined entry carries a
  `//# sourceURL=…` directive,
  plus an inline source map when requires are present so devtools
  still reports the original file and line per frame; the prelude
  shares one page-wide `__prelude.js` URL across all N inclusions
  so devtools tree-dedups them into a single visible entry. See
  [injection-modes.md](injection-modes.md) for the full per-entry
  layout, why we inline the prelude rather than registering it
  once, and the alternative arrangements tried or considered
  (separate entries per require, eval-per-require); see
  [requires.md](requires.md) for the `@require`-specific details.
- `runAt` — always `document_start`, regardless of the script's
  declared `@run-at`. See [`@run-at` gating](#run-at-gating) below.
- `world` — `'MAIN'` (the page's own world) or `'USER_SCRIPT'`
  (Chrome's isolated user-script world), resolved per script — see
  [Execution world](#execution-world) below.

### `@run-at` gating

We register every userscript at Chrome's `document_start` and the
wrapper itself awaits the matching lifecycle event before invoking
the user body. This is the TM/VM pattern.

- `document-start` — wrapper runs the body immediately.
- `document-body` — wrapper waits for `document.body` (via a
  `MutationObserver` on `documentElement` if body isn't there yet).
- `document-end` — wrapper waits for `DOMContentLoaded`.
- `document-idle` (default / unknown values) — wrapper waits for
  `window`'s `load` event.

Why not just pass `runAt` through to `chrome.userScripts.register`:

- Chrome's scheduler batches `document_end` and `document_idle` into
  a single post-`load` injection burst. Userscripts that declare
  `@run-at document-end` then observe `readyState=complete` instead
  of `interactive`, which breaks scripts that mutate the DOM before
  subresource load.
- Registering at `document_start` and gating in-page side-steps the
  batching: `DOMContentLoaded` listeners fire when the parser hits
  DCL, not when Chrome's injection scheduler gets around to it.

**Not guaranteed: relative order of two scripts that resolve on the
same event.** Every script registers at `document_start`, so two
scripts whose gates both settle at `DOMContentLoaded` run in whatever
order Chrome executed their entries — it doesn't promise a stable
order across separately-registered userscripts. `@run-at` places a
script in a lifecycle *window*; it isn't a sequencing primitive
between scripts.

The gating is implemented in `waitForRunAt` inside
`src/userscript-prelude.js`. The declared `@run-at` is delivered
via the per-script config blob (`buildConfigBlob` in
`src/injector.ts`) and stored on the prelude's per-script entry.

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

- `send` in `userscript-prelude.js` feature-detects
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
- Reading another script's GM values via a forged `sm:check-pending`
  IS blocked: the bridge stamps `__viaBridge:true` on every message it
  relays (set last, so the page can't pre-set it false), and the SW
  refuses to attach a `gmValues` snapshot to any `__viaBridge` request.
  Legitimate value reads ride a USER_SCRIPT-world script's own direct
  `chrome.runtime` channel and carry no marker. See
  `docs/GM-APIs.md` and `tests/e2e/gm-storage-read-leak.spec.ts`.

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

The wrapper lives in plain JavaScript source files in `src/`. The
build (`scripts/build.mjs`) minifies each to a single line and emits
them as exported constants in `dist/generated-wrappers.js`. The type
declarations are hand-written in `src/generated-wrappers.d.ts` (tsc
type-checks against the `.d.ts`; the runtime `.js` is built directly
into `dist/`). The pieces:

- `src/userscript-prelude.js` → `WRAPPER_PRELUDE` — static, byte-
  identical across every script. Contains the IIFE, helpers
  (`__smRun`, `__smSealed`), the check-pending round-trip,
  the matcher recheck, the async-error listeners, and the
  `@run-at` gate. Per-script identity comes via a tiny config
  blob `{code}` entry that the injector emits ahead of this in the
  `js[]` array — see [injection-modes.md](injection-modes.md).
- `src/wrapper-bridge.js` → `WRAPPER_BRIDGE` — USER_SCRIPT-world
  relay registered separately when any MAIN-world script is active
  (see [MAIN-world telemetry — the bridge](#main-world-telemetry--the-bridge)).
- `src/wrapper-gm-runtime.js` → `WRAPPER_GM_RUNTIME` — shared
  USER_SCRIPT-world runtime for `GM_*` APIs. See
  [GM-APIs.md](GM-APIs.md).

Why one line per file: per-script wrap entries (the require and
main-body entries) place a thin prefix on the same physical line as
the body's first line. The injector also splices the **full on-disk
source** — leading text + metadata block + body — into the main-body
entry's body slot (the metadata block is comment-only JS, so the
engine treats it as inert noise). The combination means a stack
trace pointing at "line 7" of the main body's `//# sourceURL=`
attribution lines up with line 7 of the `.user.js` file. Column
offsets on physical line 1 are still shifted by the prefix's
character count; line numbers are not.

With `@require`s present the body no longer starts on physical
line 1 — the requires are concatenated ahead of it in the same entry.
An inline source map restores the original file and line in devtools;
`Error.stack` strings keep the generated coordinates. See
[injection-modes.md](injection-modes.md) and [TODO.md](../TODO.md).

The per-script config blob carries every value that varies between
scripts — `id`, `name`, `sourceUrl`, `runAt`, `loadedAt`,
`needsGmValues`, the optional matcher block, and the optional startup
logs. The prelude reads it once and stashes a
per-script entry on `self.__smPrelude.scripts[id]`.

The combined user-program entry is wrapped (in `wrapCombinedEntry`) to:

- Defer execution until the prelude's matcher + check-pending +
  `@run-at` gates resolve (via `self.__smRun(id, fn)`).
- Splice the GM bindings (`const GM_info = ...`, `const GM_setValue
  = ...`, etc.) and the GM prelude (`storage.init` etc.) into the
  function so they're locals visible to the body — and, because the
  requires are concatenated into the same function, to library
  top-level code too. One copy serves both; see
  [GM-APIs.md](GM-APIs.md#bindings-layout-in-the-wrapper).
- Carry a `//# sourceURL=sourcemonkey://SourceMonkey/<folder>/<name>.user.js`
  directive so devtools labels the script and the prelude's
  async-error listeners can attribute errors by stack inspection.

When the body fires (inside the prelude's `runMain`), the prelude:

- Logs `"[SourceMonkey] script <name> running on <url>"`.
- Sends `{ type: 'sm:start', id, url }` to the SW.
- Wraps the body call in `try { … } catch { … }`:
  - Logs `"[SourceMonkey] script <name> threw: …"` on a sync throw.
  - Sends `{ type: 'sm:error', id, url, message }`.
- Async failures are attributed via the window error listeners
  installed at init time — see
  [Async-error attribution](#async-error-attribution).
- All telemetry goes through the prelude's `send` helper. In
  USER_SCRIPT world it uses `chrome.runtime.sendMessage` (silencing
  the returned Promise so an unreachable SW doesn't surface as
  `Uncaught (in promise)`). In MAIN world (where `chrome.runtime`
  is undefined) it falls back to `window.postMessage` with a
  marker the bridge picks up — see [MAIN-world telemetry — the
  bridge](#main-world-telemetry--the-bridge).

### Async-error attribution

The body's `try`/`catch` only catches **synchronous** throws — once
the script returns control to the event loop, anything thrown later
(from `setTimeout`, `addEventListener` callbacks, `fetch().then`,
`MutationObserver`, etc.) escapes it.

To catch those without falsely attributing the page's own errors to
this script, the prelude:

- Appends `# sourceURL=sourcemonkey://SourceMonkey/<folder>/<name>.user.js` to
  the combined entry, plus an inline source map when the script has
  `@require`s. The JS engine tags stack frames with the entry's
  sourceURL; devtools applies the map to split them back into the
  original per-require files.
- Stores the `sourceUrl` on the per-script entry
  (`entry.cfg.sourceUrl`). One entry means one marker, so attribution
  is a single substring test.
- Installs `window.addEventListener("error", …)` and
  `…("unhandledrejection", …)` once per script (in
  `installAsyncListeners`), both with the capture flag set.
- Each listener checks the event's `filename` (for `error`) and
  `error.stack` / `reason.stack` for this script's
  sourceURL markers via `indexOf`. Only hits are reported via
  `send({ type: 'sm:error', … })`; the default page-side error
  logging is left in place (no `preventDefault`).
- A module-shared `WeakSet` de-dupes the error object so the same
  throw isn't reported twice if it reaches both paths.

Trade-offs:

- The sync `try`/`catch` and the async listeners can both fire for a
  single error if the body throws synchronously AND the page re-emits
  it as a global error. The `WeakSet` keeps the listener path silent
  in that case.
- MAIN-world scripts share `window` with the page; the sourceURL
  filter is what keeps attribution honest.
- Multiple userscripts in the same world each install their own
  listeners; only the listener whose `sourceUrl` shows up in the
  stack reports. Every frame from a script's code — its requires
  included — carries that one URL, so attribution is unambiguous.
  (Under the previous separate-entries arrangement two scripts
  sharing an `@require` URL could both match a throw from inside
  that library, and attribution was non-deterministic.)
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

### Snapshot piggyback for storage-granting scripts

The check-pending reply doubles as the channel that delivers the
script's initial GM_setValue cache contents:

- **Wrapper side.** Sends `needsValues: true` in its
  `sm:check-pending` payload iff it @grants a storage API
  (computed at register time).
- **SW side.** For `needsValues: true` payloads, attaches a
  `gmValues` field carrying the script's current snapshot
  (`chrome.storage.local` rows merged with the in-flight overlay).
- **No fallback.** This is the **only** way the wrapper learns
  its initial storage state — there's no baked literal.
- **On missing snapshot.** Prelude logs a console error, sends
  `sm:error`, and `return`s out before the body runs. Triggers
  when the SW is unreachable past the wrapper's 2 s safety timer
  or `handleCheckPending` errored.
- **Non-storage scripts.** Skip the snapshot read; the message
  handler short-circuits before `loadSnapshotForCheckPending`.

See [GM-APIs-storage.md](GM-APIs-storage.md) for the full storage
model.

### Wrapper protocol

The prelude initializes each script's entry, runs the matcher
(which marks the entry inactive on a miss), installs async-error
listeners, then calls `awaitDecision`. The decision callback
receives `{action}` and branches:

- `run` — gates body execution on the declared `@run-at`; when the
  lifecycle event fires, sends `sm:start` and calls the main-body
  wrap function. Sync throws are caught and reported as `sm:error`.
- `run-new` — calls indirect `eval` with the SW-supplied body
  string plus `//# sourceURL=`. Sends `sm:swapped` and records the
  new `loadedAt` so subsequent async errors attribute to the new
  body. **Caveat:** the swap eval runs at the prelude's function
  scope, not inside the main-body wrap function's closure, so the
  GM_* bindings spliced into the wrap function are NOT visible to
  the swap-evaluated body. A storage-granting script that takes
  this branch will see `ReferenceError` for `GM_setValue` etc.
  Storage scripts should generally not be served `run-new`. See
  [injection-modes.md](injection-modes.md#cons--caveats).
- `skip` — sends `sm:abandoned` and exits without running anything.

Prelude-side safety timeout (2s) protects against the SW vanishing
mid-handshake; on hit it defaults to `run` so the baked-in body
still executes.

### Caveats

- **MAIN-world scripts** can't call `chrome.runtime.sendMessage`
  directly, so they round-trip `sm:check-pending` via
  `wrapper-bridge.js` using a `sourcemonkey-bridge-reply` postMessage
  keyed on a per-request nonce. The page can observe and forge these
  postMessages — the threat model is unchanged from the existing
  bridge (the page already runs arbitrary code in MAIN world). Where
  the page's CSP forbids `unsafe-eval`, the swap eval throws; the
  prelude detects the CSP marker in the error message and falls
  through to running the baked-in main body, matching pre-fast-path
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

- **No frame control.** We don't set `allFrames`, so scripts only run
  in the top frame. Adding `@noframes` parsing + a `allFrames` flip
  is straightforward.
