# Injection (chrome.userScripts)

How VibeMonkey actually runs the matching userscripts on a page.

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
  from there (including for sub-frames and SPA-style navigations
  managed by the page).
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
- `world: 'USER_SCRIPT'` — Chrome's isolated user-script world.

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

The wrapper lives in three plain JavaScript files, which the build
(`scripts/build.mjs`) minifies to a single line each and emits as
exported constants in `dist/generated-wrappers.js`. The type
declarations are hand-written in `src/generated-wrappers.d.ts` (tsc
type-checks against the `.d.ts`; the runtime `.js` is built directly
into `dist/`). The fragments:

- `src/wrapper-head.js` — IIFE open, `__vmName` / `__vmId` /
  `__vmSend` declarations, the matcher slot (filled per script), the
  activation `console.log`, the `vm:start` send, and the opening
  `try {`.
- `src/wrapper-tail.js` — closing `catch (__vmErr) {…}`, `vm:error`
  send, IIFE close.
- `src/wrapper-matcher.js` — the URL recheck (only inserted for
  scripts with `/regex/` patterns; see below).

Why one line: the HEAD is concatenated immediately before the user's
body with no trailing newline, so the body's line N lands at physical
line N of the registered script — *body* line N, not source-file line
N. The header lines (the `// ==UserScript== … // ==/UserScript==`
block) are stripped before the body is sent to Chrome, so a stack
trace pointing at "line 7" means line 7 of the body, not line 7 of
the `.user.js` file. Column offsets on body line 1 are still shifted
by the HEAD's character count; line numbers are not.

Placeholders the injector substitutes at registration time:

- `"__VM_NAME__"` → JSON-encoded `@name` (or relativePath fallback).
- `"__VM_ID__"` → JSON-encoded stored script UUID.
- `"__VM_MATCHER_BLOCK__";` → empty, or the minified matcher source
  (which itself contains a `"__VM_MATCHING__"` placeholder).
- `"__VM_MATCHING__"` (inside the matcher) → JSON-encoded
  `{matches, includes, excludes}`.

Substitutions go through `String.replace(pattern, () => …)` callbacks
so a literal `$&` inside the matcher (used as a regex back-reference
in its escape helper) isn't expanded by `String.replace`'s
replacement-string syntax.

Every registered body is wrapped in a tiny shim that:

- Logs `"[VibeMonkey] script <name> running on <url>"` to the page
  console.
- Sends a `{ type: 'vm:start', id, url }` message to the SW.
- Wraps the body in `try { … } catch (__vmErr) { … }`:
  - Logs `"[VibeMonkey] script <name> threw: …"` to the page console.
  - Sends a `{ type: 'vm:error', id, url, message }` message to the SW.
- All `sendMessage` calls go through `__vmSend`, which catches the
  synchronous throw AND attaches `.catch(() => {})` to the returned
  Promise. Without that, an unreachable SW would surface as an
  `Uncaught (in promise) Error: Could not establish connection` in
  every page console.

The SW installs a single `chrome.runtime.onUserScriptMessage` listener
(`installMessageListener`) that logs `vm:start` / `vm:error` events to
the SW console with the tab ID. There is no UI surface for this yet —
it's diagnostic only.

> **Note:** messages from the USER_SCRIPT world arrive on
> `chrome.runtime.onUserScriptMessage`, NOT the regular
> `chrome.runtime.onMessage` event. Listening on the wrong event
> manifests as `"Receiving end does not exist"` on every send.

### Trade-offs of wrapping

- The `try`/`catch` around the body only catches **synchronous**
  throws. Async failures (rejected Promises, errors thrown out of
  `setTimeout`) escape it. We deliberately do NOT install a global
  `unhandledrejection` listener — it would catch the page's own
  rejections (and every other userscript's) and falsely attribute
  them to whichever script registered the handler. If we want async
  coverage later it needs to be per-script-promise instrumentation,
  not a global listener.

## Limitations / future work

- **No `@grant` / `GM_*` support.** Only `@grant none` scripts behave
  correctly — anything referencing `GM_setValue` / `GM_xmlhttpRequest`
  / etc. throws on first call. A real bridge means a per-API shim
  injected via `configureWorld({ csp, messaging })` plus SW-side
  message handlers. Tracked in `TODO.md`.
- **`@require` / `@resource`.** Not loaded at all. We'd fetch them at
  registration time and either prepend them to the body or use
  separate entries in `js: []`. Tracked in `TODO.md`.
- **No per-tab status UI.** `vm:start` / `vm:error` go to the SW
  console only. A natural next step is persisting them per-tab in
  `chrome.storage.session` and rendering ✓/✗ marks next to each
  matching script in the toolbar tooltip.
- **No frame control.** We don't set `allFrames`, so scripts only run
  in the top frame. Adding `@noframes` parsing + a `allFrames` flip
  is straightforward.
