# GM_* / GM.* API Implementation

Implementation status and design notes for the `GM_*` / `GM.*` API
surface. Strategy and tradeoffs live in
[`GM_API_strategy.md`](GM_API_strategy.md); this doc records what
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
  the wrapper. Always emits `GM_info` when ANY grant is present;
  emits a `const GM_x = function (...){...}` for each granted
  legacy name; emits a `const GM = Object.freeze({...})` GM4
  namespace covering the granted APIs with `gmDotName`.
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

## Bindings layout in the wrapper

The wrapper-head has a placeholder `"__SM_GM_BINDINGS__"` placed
inside the outer IIFE but BEFORE `__smAwaitDecision(...)`. The
substituted text contains the per-script `const GM_X = ...`
declarations. Two consequences:

- Both the baked-in body (run path) AND the run-new swap eval see
  the bindings via closure.
- Bindings are in scope before the SW round-trip, but the runtime
  `__SM_GM__` may not be installed yet for early `document_start`
  scripts. Sync bodies dereference `window.__SM_GM__` lazily (at
  call time), so the runtime just has to be there by the time the
  script makes a GM call.

## World gating

GM_* bindings are emitted ONLY for scripts that resolve to the
`USER_SCRIPT` world. Scripts with an explicit `@inject-into page` or
otherwise running in MAIN do not get bindings — they'd be unable to
reach `__SM_GM__` (different world) or `chrome.runtime` (undefined
in MAIN). Calls to any GM_* name in such a script throw a natural
`ReferenceError`. This is a deliberate Phase-2 limitation; a future
phase can route MAIN-world GM calls through the postMessage bridge
if needed.

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
- **Runtime ordering safety relies on lazy dereference.** The wrapper
  reads `window.__SM_GM__` at GM-call time, not at binding-emission
  time. Sync calls happen inside the `__smAwaitDecision` microtask
  (a turn after the wrapper's synchronous init), giving the GM
  runtime time to install. So `chrome.userScripts`'s document_start
  registration order doesn't have to be a guarantee — the lazy
  deref is the real safety net.
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

End-to-end shape:

- **Backing store.** SW-side, `chrome.storage.local` with
  `gmval:<scriptId>:<key>` rows per value. Per-key rows so a write
  doesn't churn sibling rows and so we don't bump the per-row size
  ceiling on a large value.
- **Page-side cache.** Baked into the wrapper at register time
  (`emitGmBindings` reads `chrome.storage.local`, JSON-encodes the
  snapshot, and emits a `window.__SM_GM__.storage.init(scriptId,
  {...})` call). Sync reads (`GM_getValue`) hit the cache; default
  values are returned when the key isn't present.
- **Batched writes.** `GM_setValue` / `GM_deleteValue` update the
  cache synchronously and queue a write. The runtime debounces 150 ms
  after each write with a 1 s hard cap, then ships a single
  `sm:gm-batch-write` envelope to the SW. `pagehide` and
  `visibilitychange → hidden` force-flush so bfcache eviction doesn't
  drop in-flight writes.
- **Last-write-wins** semantics inside one batch — same as a
  sequence of `set` / `delete` calls run one after the other.
- **Deletion sentinel.** Page-side `DELETED_SENTINEL` is a private
  reference; on the wire it travels as `{key, deleted: true}` so the
  JSON round-trip preserves intent. The SW translates back to its own
  symbol when calling `applyBatchValues`.
- **GM4 promise forms.** `GM.setValue` / `GM.getValue` / etc are
  emitted by the binding emitter as Promise wrappers around the
  legacy `GM_x` calls — same behavior, async return.

Persistence model (Phase 3): writes are eventually-consistent
across documents. A write on page A is visible to page B only AFTER
the next re-registration of B's wrapper (since the page-side cache
is baked at register time). Cross-tab live broadcast comes in Phase
6.

Cross-script isolation: each script's `(scriptId, key)` namespace
is independent — `GM_listValues` from script A never returns script
B's keys.

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
  (it has the value the SW doesn't). The SW logs a
  `console.warn`; the userscript sees no error. Future phases can
  surface this on the per-script log.
- **`applyBatchValues` is not transactional.** A batch with both
  sets and removes runs them as two parallel `chrome.storage`
  operations; a failure of one leaves the other applied. Acceptable
  given how reliable `chrome.storage.local` is in practice.
- **Cross-script storage spoofing is within the trust boundary.**
  The `scriptId` in the `sm:gm-batch-write` envelope is supplied
  by the wrapper's compiled-in literal. A misbehaving userscript
  in the same USER_SCRIPT realm CAN send a `chrome.runtime.sendMessage`
  with another script's scriptId and overwrite its values. Same
  trust model as the async-envelope `scriptId` for
  `GM_xmlhttpRequest`. All same-extension userscripts are within
  the user's trust boundary; this is "userscript A messes with
  userscript B's data", not a privilege escalation against the
  user. A future phase can verify the scriptId against the active
  registration set in the sender's tab if a real compat report
  comes in.

## Phase status

- ✅ **Phase 1** — catalog
- ✅ **Phase 2** — compile-in surface (stubs throw "not implemented yet")
- ✅ **Phase 3** — storage v1 (page-side cache, batched writes, persistence)
- ⏳ **Phase 4** — `GM_addStyle` / `GM_addElement`
- ⏳ **Phase 5** — `GM_setClipboard`
- ⏳ **Phase 6** — cross-tab value broadcast
- ⏳ **Phase 7** — value-change listeners
- ⏳ **Phase 8** — `GM_xmlhttpRequest` text
- ⏳ **Phase 9** — `GM_xmlhttpRequest` binary (serialize-to-bytes wire, no offscreen doc)
- ⏳ **Phase 10** — XHR header surgery + `@connect` gating
