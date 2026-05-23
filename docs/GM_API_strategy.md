# GM_* API Strategy

How to add `GM_*` / `GM.*` support to SourceMonkey. Compares
embedding Violentmonkey's implementation vs. writing our own, and
recommends a path.

> **Status:** Phases 1–10 landed (catalog, compile-in surface,
> storage v1 + cross-tab broadcast + value-change listeners,
> `GM_addStyle` / `GM_addElement`, `GM_setClipboard`,
> `GM_xmlhttpRequest` text + binary, `@connect` URL gating). XHR
> header surgery is deferred. See [gm-apis.md](gm-apis.md) for the
> implementation status and known limitations; deferred follow-ups
> are tracked in [TODO.md](../TODO.md).

## Goals

- Ship the **commonly used** GM4 / GM_* surface — enough that
  real-world userscripts work without modification.
- Particular priorities (from the user's perspective):
  - `GM_xmlhttpRequest` (and `GM.xmlHttpRequest`) — most-used; the
    only API that solves cross-origin fetching for userscripts.
  - `GM_setValue` / `GM_getValue` / listeners — persistent state.
  - `GM_addStyle` / `GM_addElement` — DOM injection that bypasses
    page CSP.
  - `GM_setClipboard`, `GM_openInTab`, `GM_notification`,
    `GM_registerMenuCommand`, `GM_getResourceText` / `URL`.
- **Not** a goal: the long tail of TM-specific surface
  (`GM_webRequest`, `GM_audio`, `GM_getTab` / `saveTab` / `getTabs`,
  `window.onurlchange`, `GM.backgroundControl`). These can come
  later if real users need them.
- Compatibility with userscripts already written against
  Tampermonkey or Violentmonkey on the supported surface is a
  significant secondary goal.

## Background — what we have, what they have

### SourceMonkey today

- MV3 service worker (no `background` page, no DOM).
- Per-page injection via `chrome.userScripts.register({world,
  matches, runAt, js: [{code}]})`. Chrome owns matching + injection.
- Two realms in use:
  - `USER_SCRIPT` world (default for `@grant`-using scripts). An
    isolated world Chrome provides specifically for userscript
    managers. Shares the DOM with the page but has its own globals.
  - `MAIN` world (default for `@grant none`). Shares both DOM and
    globals with the page.
- Each script body is wrapped in an IIFE that already sends
  `sm:start` / `sm:error` / etc. to the SW. USER_SCRIPT world calls
  `chrome.runtime.sendMessage` directly (after
  `configureWorld({messaging: true})`); MAIN world goes through
  `wrapper-bridge.js`, a small USER_SCRIPT-world content script that
  relays `window.postMessage` traffic.
- No `GM_*` yet. Scripts that touch GM globals throw on first call.

### Violentmonkey (MIT, OSS, copy-able)

- Webpack-bundled, two injected entries: `injected-web` (page-world
  bundle) and `injected` (content-world bundle, contains the page
  bundle as a string for `eval`-injection).
- Topology: PAGE ↔ CONTENT ↔ BG with a bespoke bridge
  (`bridge.post/call/promise`) over `dispatchEvent(CustomEvent)` for
  PAGE↔CONTENT and `chrome.runtime.sendMessage` for CONTENT↔BG.
- Userscript runs in PAGE or CONTENT realm chosen by
  `@inject-into auto|page|content`. CSP-blocked pages run the
  userscript itself in CONTENT to bypass page CSP.
- Per-API split across `src/injected/web/{gm-api,requests,
  notifications,tabs,gm-values}.js` plus `src/background/utils/
  {requests,requests-core,values,cookies,notifications,clipboard,
  tabs}.js`.
- Paranoid runtime: `safe-globals*.js` snapshots every native it
  touches before page code runs; a Babel transform rewrites
  `obj::method()` into `safeCall(method, obj)` — 121 such call
  sites in `src/injected/*` alone. Uses `cloneInto` /
  `exportFunction` for Firefox cross-realm safety.
- MV2-shaped. The MV3 build path exists but the SW-side request
  handler still does `new XMLHttpRequest()` and constructs Blobs
  directly — works in MV2 / Firefox background pages, breaks in an
  MV3 service worker (no DOM, no reliable `URL.createObjectURL`).
- ~2900 lines `src/injected/*` + ~1150 lines of relevant
  `background/utils/*`, plus shared `src/common/*` helpers.

### Tampermonkey (closed-source, reference only)

- Also `chrome.userScripts`-based on Chrome 120+. Same realm story
  as us (`MAIN` page + `USER_SCRIPT` isolated).
- All `GM_*` bodies live in `page.js` (MAIN-world) behind a vault.
  USER_SCRIPT-side `content.js` listens on
  `chrome.userScripts.onBeforeScript`, installs a setter on each
  userscript's global, then evals a self-contained wrapper that
  hands the page bundle's API surface back to the script.
- Uses an **offscreen document** (`chrome.offscreen`) for the work
  the MV3 SW can't do directly: binary XHR responses, Blob /
  ObjectURL creation, `DOMParser`, downloads helpers.
- Header surgery for forbidden XHR headers via
  `declarativeNetRequest` session rules (MV3-blessed equivalent of
  VM's `webRequest` rewriting — VM-style still works under
  `webRequestBlocking` if we ask for it, but DNR is the
  MV3-preferred path).

## The fundamental mismatches

These are the reasons embedding VM as-is is harder than it sounds.

### 1. No bundler

VM is webpack-bundled with two entry points and several custom
plugins. SourceMonkey has **no** bundler — `scripts/build.mjs` just
runs `tsc` once and copies files. Embedding VM's `src/injected/*`
means standing up a bundler stage *and* the safe-bind Babel
transform that ~all of VM's injected code depends on. That's a real
build-system change.

### 2. VM's bridge topology doesn't match ours

VM's GM_* implementations are written against `bridge.post('Foo',
data)` / `bridge.call(...)` / `bridge.promise(...)`. Those
primitives:

- Dispatch `CustomEvent`s page↔content (the
  `injected-web`↔`injected` boundary).
- Use a `MouseEvent.relatedTarget` trick to ferry DOM nodes
  across the boundary (used by `GM_addElement`).
- Forward "true"-marked handlers to BG via `sendCmd`.

We don't have a PAGE↔CONTENT boundary. Our userscripts run in
USER_SCRIPT (or MAIN) and talk to the SW directly via
`chrome.runtime.sendMessage`. To embed VM's code we'd have to either
(a) replace `bridge.post/call/promise` everywhere with shims over
chrome.runtime, or (b) keep VM's bridge and add a fake "content"
hop. (a) is invasive across every GM_* body; (b) is wasted
indirection.

### 3. VM's safe-globals / paranoia is mostly redundant for us

VM's PAGE-realm code defends against a hostile page that has
already poisoned every builtin. Our `@grant`-using scripts run in
USER_SCRIPT world, where the page **cannot** mutate our prototypes —
that's the point of the isolated world. We'd be carrying hundreds
of lines of `safeCall` / `createNullObj` / `setOwnProp` plumbing for
a threat model we don't have.

(For MAIN-world `@grant none` scripts the threat model returns, but
those scripts don't use GM_* anyway.)

### 4. VM's MV3 story is incomplete; ours is MV3-only

VM's BG-side `GM_xmlhttpRequest` does `new XMLHttpRequest()` plus
`URL.createObjectURL(blob)` directly in the background context. In
MV3 (Chrome) the SW has no DOM, can't construct Blobs reliably, and
ObjectURLs created there don't survive into the page. Either we
follow Tampermonkey's lead and add an offscreen document, or we use
`fetch()` and stream chunks back as base64 (works without an
offscreen doc but loses native Blob/ArrayBuffer). VM has neither
piece today.

### 5. VM's openers / preinject hook into things we don't have

VM's cross-tab value-broadcast (the `openers[id][tabId][frameId]`
table in `background/utils/values.js`) hooks into VM's preinject
pipeline to know which frames have the script loaded. We don't have
a comparable hook — Chrome's `chrome.userScripts` owns the matching
and we never see "this frame loaded this script" events. To do the
diff-broadcast we'd need our wrapper to send a registration ping at
`sm:start` time.

(Not blocking; just means the openers table comes from a different
signal than VM's preinject hook.)

## Prototype-poisoning defense (the "vault" question)

Both TM and VM build a **vault** — a frozen snapshot of native
prototype methods captured before any userscript runs. TM's is
centralised (a single `i({…})` factory near the top of `page.js`);
VM's is distributed across `safe-globals*.js` plus the `obj::method`
→ `safeCall` Babel transform. Either way, every GM_* implementation
calls primitives via the captured reference, not the live prototype,
so a page that has overwritten e.g. `Array.prototype.forEach`
doesn't break GM_*.

**Do we need this?** Mostly no, with one narrow case worth a small
local defense.

### Why most of the threat goes away

- TM's vault is load-bearing because all GM_* bodies live in **MAIN
  world** (`page.js`). MAIN shares prototypes with the page, so
  page code that runs before a GM_* call can poison anything the
  implementation touches.
- VM's safe-globals are load-bearing because PAGE-realm scripts run
  in MAIN. (CONTENT-realm scripts get partial isolation; even there
  VM defends against userscripts running in the same realm.)
- **Our GM_* implementations live in USER_SCRIPT world.** Chrome
  guarantees that USER_SCRIPT world is isolated from the page —
  the page literally cannot reach into our prototypes. The whole
  reason this world exists is to remove this threat. That's the
  same primitive cross-realm safety TM and VM are trying to
  reconstruct, and we get it from the browser.

So for the page-as-attacker model that motivates TM/VM's vaults:
nothing to do.

### What USER_SCRIPT world does not protect against

USER_SCRIPT world is **one realm per extension per document** —
shared across all userscripts SourceMonkey injects on the same page.
That means:

- Userscript A can mutate `Array.prototype.forEach`, and userscript
  B (and our GM_* shim) running in the same document will see the
  mutated version.
- The mutator is the user's own code, run on the user's own
  trusted sources. So it's a "didn't mean to break things"
  scenario, not a "hostile actor" one.

VM's vault does protect against this case (the snapshot is taken
before *any* userscript runs). TM's vault, ditto.

### What's also unaffected: MAIN-world `@grant none` scripts

`@grant none` scripts run in MAIN and we don't give them any GM_*
surface — so there's nothing to vault. Our wrapper itself runs
there, but it only uses `chrome.runtime` (unreachable in MAIN, so
we fall back to `postMessage`), `setTimeout`, `addEventListener`,
and `String.indexOf`. All of those touch prototypes the page could
have poisoned by `document_start`-after-first-inline-script time.
That's an existing concern with the current `wrapper-head.js`,
unchanged by GM_* work. (Discussion of hardening that lives in
[injection.md](injection.md), not here.)

### Recommendation: a tiny "shim cache", not a full vault

At the top of our USER_SCRIPT-world GM_* bootstrap (runs once per
document, before any userscript body), capture local references
to the small set of primitives our GM_* implementations rely on,
e.g.:

```ts
const _Promise = Promise;
const _JSONstringify = JSON.stringify;
const _JSONparse = JSON.parse;
const _ArrayIsArray = Array.isArray;
const _Object_keys = Object.keys;
const _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
// ...maybe 6–10 entries total
```

…and use those references inside the GM_* bodies. This is one short
module, no Babel transform, no `obj::method()` syntax. It protects
the GM_* shim from a sibling userscript that monkey-patches
builtins — without the cost or readability hit of a full vault.

What we **do not** do:

- No safe-bind Babel transform (we're not Webpack-ing).
- No `createNullObj` / `setOwnProp` style — plain TypeScript.
- No `cloneInto` / `exportFunction` (those are Firefox primitives;
  we're Chrome MV3-only).
- No defensive copy of every Array / String / RegExp method. The
  trade-off above ("hostile other userscript" is low-stakes) makes
  going further not worth the readability cost.

## Options

### Option A — Embed VM's `src/injected/*` and `src/background/utils/*` wholesale

What it looks like:

- Pull VM's `injected/{web,content}` and the relevant
  `background/utils/{requests,requests-core,values,cookies,
  notifications,clipboard,tabs}.js`, plus shared `src/common/*`
  helpers.
- Add webpack (or esbuild) for `injected-web` / `injected` /
  background entries. Bring along the safe-bind Babel transform.
- Replace VM's `<script>`-injection path with our
  `chrome.userScripts` registration.
- Rewrite the BG-side XHR to use a SourceMonkey offscreen document
  (or `fetch` + chunks).
- Glue: replace VM's `preinject` openers hook with a wrapper-side
  ping that registers the (tab, frame, script) tuple for value
  broadcast.

Realistic effort: **largest**. We end up rewriting the load-bearing
parts (XHR, openers) anyway, plus standing up the bundler and
Babel transform.

Pros:
- Maximum re-use of VM's well-tested per-API bodies.
- Future VM releases can be re-merged.
- Strong VM compatibility story by construction.

Cons:
- Adopts webpack + Babel + the safe-bind transform — a big
  step-change in build complexity for a no-bundler project.
- Drags in VM's PAGE↔CONTENT bridge model that we don't otherwise
  need.
- Drags in paranoia helpers that USER_SCRIPT world makes redundant.
- The two highest-value pieces (XHR + values-broadcast) are
  precisely the ones that have to be rewritten anyway.

### Option B — Own implementation, VM as reference

What it looks like:

- New TypeScript modules, no bundler change. Each per-API body
  lives in `src/gm/*.ts` and compiles to its own `dist/gm-*.js`.
- Wrapper-head adds a GM_* surface to the userscript's scope at
  inject time, gated by `@grant` (matching what VM and TM both do).
- One bridge: `chrome.runtime.sendMessage` between
  USER_SCRIPT-world wrapper and SW. MAIN-world bridge already
  exists (`wrapper-bridge.js`) and gets reused for the few APIs
  worth supporting under `@grant none` (`GM_addStyle`, etc.).
- New SW-side handlers under `src/sw-gm/*.ts`:
  - `gm-values.ts` — `chrome.storage.local` namespace + cross-tab
    broadcast, openers fed by the wrapper.
  - `gm-cookies.ts` — `chrome.cookies` wrapped with per-script
    `@match` validation (cribbing VM's `checkCookieOpts` shape).
  - `gm-clipboard.ts` — offscreen-doc-based `execCommand('copy')`.
  - `gm-notifications.ts`, `gm-tabs.ts` — thin `chrome.notifications`
    / `chrome.tabs` wrappers.
  - `gm-xhr.ts` — the hairy one; see below.
- Offscreen document (new `src/offscreen.html` + `src/offscreen.ts`)
  for the binary-response XHR path, blobs/object URLs, downloads.

Realistic effort: **medium**. The per-API bodies are short; the
hard pieces (XHR, values broadcast) need attention either way.

What we copy verbatim from VM (with attribution comments and the
MIT notice retained):

- The storage value type-tag encoding scheme (`o`/`n`/`b`/`s`/`u`
  in `src/common/util.js`) — small, well-tested, no reason to
  reinvent.
- The XHR response-getter laziness pattern (`response` /
  `responseText` / `responseXML` as getters on the event data) —
  drop-in correctness win.
- The chunked binary transport sizing constants (1 MB binary, 10 MB
  text on Chrome) — already tuned against real-world payloads.

What we crib **strategy** from but rewrite:

- `webRequest.onBeforeSendHeaders` / `onHeadersReceived` for header
  surgery on XHR (drop our Origin, optional Cookie merge, capture
  redirected URL, encode response headers safely). VM's
  `requests-core.js` is the canonical reference.
- The `VM-Verify`-style request-id tagging so the webRequest
  listeners can correlate to our originating script.
- The openers table shape for cross-tab value broadcast.
- The per-script `@match` validation in `GM_cookie`.

What we don't carry:

- The bridge primitives (`CustomEvent` dispatch, the `MouseEvent`
  node-passing trick).
- The PAGE↔CONTENT dual-realm injection — irrelevant for us.
- Most of `safe-globals*.js` / safe-bind / cloneInto/exportFunction
  — USER_SCRIPT world isolation gives us that for free.
- Firefox-specific paths (we're Chrome MV3).

Pros:
- Stays in TypeScript with no new build tooling.
- Code matches our topology (USER_SCRIPT ↔ SW), no wasted hops.
- Smaller surface to audit; idiomatic with the rest of the repo.
- We get the *correctness lessons* from VM (and the comparison
  doc's notes on TM) without the bridge and bundler tax.
- Easier to keep current with future Chrome MV3 changes — we own
  every line.

Cons:
- Up-front cost is real; every API gets written and tested fresh.
- "Compatible with VM scripts" is a claim we have to validate
  test-by-test, not a guarantee by construction.
- If we want to track a new VM API later, we port it rather than
  cherry-picking a commit.

### Option C — Hybrid: VM-as-library for SW side, fresh for page side

What it looks like:

- Page side (Option B): fresh TS, no bundler change.
- SW side: copy VM's `background/utils/{requests,requests-core,
  values,cookies,notifications,clipboard,tabs}.js` mostly intact,
  with minimal adaptation (route through our `commands` registry,
  swap `sendTabCmd` for our equivalent, point XHR responses at
  our offscreen doc instead of VM's direct path).

Pros:
- Saves work on the SW handlers, which are the most subtle (XHR
  header surgery, cookie validation).
- Skips the bundler problem because VM's BG code is comparatively
  vanilla (no `obj::method` syntax in SW utils — checked).
- Page side stays clean.

Cons:
- The SW pieces still drag in VM's helpers (`forEachEntry`,
  `objectPick`, `sendTabCmd`, `commands` registry, the
  `addPublicCommands` shape). Either we adopt those helpers or
  rewrite them on the way in.
- BG-side XHR still has to be rewritten for MV3 (offscreen doc) —
  the biggest piece of work doesn't actually get saved by
  borrowing VM's BG code.
- We carry two coding styles in the codebase, which is its own
  cost.

### Recommendation

**Option B — own implementation with VM as reference.**

Reasons, in priority order:

- **The XHR rewrite is unavoidable.** VM's BG `XMLHttpRequest` +
  direct `createObjectURL` path doesn't work in an MV3 SW. Whether
  we start from VM's code or from a blank file, the offscreen-doc
  piece is new work. That removes Option C's biggest argument.
- **Our topology is closer to TM's than VM's.** Both we and TM
  inject via `chrome.userScripts` into USER_SCRIPT world. VM's
  PAGE↔CONTENT bridge solves problems we don't have. Code that
  reads like "the canonical thing for our topology" is easier to
  read in five lines of TS than in five files of VM's safe-bind'd
  JS.
- **The per-API bodies are small.** VM's whole `gm-api.js` is 256
  lines; that's the entire functional core of the page-side
  surface. Rewriting it as TS is a day's work; understanding it
  enough to embed it cleanly is most of that anyway.
- **No bundler.** Adopting webpack + Babel to host borrowed code
  is a big tax on a project that has deliberately stayed
  no-bundler. We'd be paying the bundler cost forever for a
  one-time savings.
- **VM compatibility is a *behavior* claim, not a *code* claim.**
  Users care that their VM script runs unmodified. As long as our
  GM_* semantics match (and we test that), they don't care whether
  the implementation came from VM's tree. The comparison doc
  documents VM behavior well enough to test against.

The places where we should be unapologetic about copying from VM
(with attribution + MIT notice) are the small, isolated correctness
wins — the value-tag encoder, the lazy-response-getter pattern, the
header-surgery strategy in `requests-core.js`. Those don't carry
their bridge/topology baggage.

## Design decisions inside Option B

Before the phasing, four concrete decisions that shape it.

### Compile-in vs runtime-registered surface

Two ways to give a script its GM_* bindings:

- **(a) Compile-in.** The injector emits all granted GM_*
  declarations as JS source ahead of the user body, gated by
  `@grant`. Each body is a thin wrapper; the heavy lifting lives in
  a USER_SCRIPT-world shared runtime registered alongside.
- **(b) Single shared runtime in scope.** A separate
  USER_SCRIPT-world script (`gm-runtime.js`) registered ahead of
  every userscript exposes the API; per-script wrapper-head just
  installs the granted bindings as locals at userscript-start time.

(a) avoids any "did the shared runtime register first?" ordering
question — the function definitions are literally in the body that
runs. (b) avoids duplicating the wrapper code for each registered
script. For our scale (tens of scripts, not thousands) the
duplication is small, and (a) is the cleaner story. **Recommend (a).**

### Explicit sync / async API catalog up front

Classify every API as `SYNC` (resolves in-page, no SW round-trip) or
`ASYNC` (sends a `chrome.runtime.sendMessage` to the SW and awaits a
reply) in a single catalog file. All later phases reference it.

- Sync APIs: storage reads, `GM_addStyle`, `GM_addElement`, `GM_log`,
  `GM_getResource*`, `GM_registerMenuCommand`, value-change listeners.
- Async APIs: `GM_xmlhttpRequest`, `GM_setClipboard`,
  `GM_notification`, `GM_openInTab`, `GM_cookie`, `GM_download`.

Classifying up front prevents the slow accidental drift where
"everything goes through the SW" — the failure mode that makes TM
feel sluggish on storage reads.

### Defer the offscreen document for binary XHR

Two ways to handle `responseType: 'blob' | 'arraybuffer' | 'document'`:

- **Byte-serialization in the SW.** SW `fetch`es the URL, reads the
  body as bytes, ships them to the page as base64 (or a typed-array
  payload); the page rebuilds the requested type. No offscreen doc.
- **Offscreen document.** Spin up an offscreen page so the SW can
  delegate to a real `Blob` constructor + `URL.createObjectURL`
  (TM's approach).

Byte-serialization is simpler and gets us a working binary path
without standing up an offscreen page. The base64 round-trip costs
~33% wire overhead on large payloads; the offscreen doc avoids that
but adds a whole new realm + lifecycle to manage. **Start with
byte-serialization**; upgrade to an offscreen doc if real users hit
the size ceiling.

### Bake `@grant` in at register time, not per-call

Our wrapper compiles GM_* bindings into the registered script source,
so `@grant` is naturally a register-time decision: changing it
requires a reload. The alternative — per-call permission checks
backed by a cache and invalidation broadcasts — gives instantaneous
options-page edits but adds an IPC on every call. **Default to
bake-in for v1**; revisit if real users want live revocation.

## A loose phasing for Option B

Not a commitment, just shape. Driven by the design decisions above.

1. **Catalog + plumbing.** A single `gm-api-catalog.ts` lists every
   API name, its `SYNC` / `ASYNC` classification, its `@grant`
   keys, and any extra validation (e.g. `@connect` for
   `GM_xmlhttpRequest`). All later phases reference this catalog.
2. **Compile-in surface.** Extend the wrapper-head emitter so that
   for each granted name on a script, an inline
   `const GM_X = function(...) {...}` is concatenated ahead of the
   body. SYNC names delegate to a shared `__SM_GM__` global (set up
   by a USER_SCRIPT-world helper registered alongside); ASYNC names
   `chrome.runtime.sendMessage` to the SW. Start with all bodies
   stubbed to throw "not implemented yet".
3. **Storage v1.** `GM_setValue` / `GM_getValue` / `GM_deleteValue` /
   `GM_listValues` end-to-end (no cross-tab broadcast yet). VM-style
   page-side cache + batched writes. Backed by
   `chrome.storage.local` with a `gmval:<scriptId>:<key>` namespace.
4. **`GM_addStyle` / `GM_addElement`.** Direct `document.createElement`
   from USER_SCRIPT world. (USER_SCRIPT-world DOM mutations are
   exempt from page CSP, same as content scripts.)
5. **`GM_setClipboard`.** Offscreen doc + `execCommand('copy')`.
6. **Cross-tab value broadcast.** Wrapper ping at `sm:start` to
   register `(tabId, frameId, scriptId)` with an SW openers table;
   `GM_setValue` writes diff-broadcast only changed keys to other
   frames running the same script.
7. **`GM_addValueChangeListener` / `GM_removeValueChangeListener`**
   on top of (6).
8. **`GM_xmlhttpRequest` text path.** SW-side `fetch` with text
   responseType; result returned via `sendMessage`. No header surgery
   yet (default `fetch` headers).
9. **`GM_xmlhttpRequest` binary path.** Add `blob` / `arraybuffer` /
   `document` responseTypes via serialize-to-bytes in the SW +
   rebuild in-page. **No offscreen document yet** — see the
   binary-XHR decision above.
10. **`GM_xmlhttpRequest` header surgery + `@connect` gating.** Add
    the `webRequest.onBeforeSendHeaders` / `onHeadersReceived` hook
    (cribbing VM's `requests-core.js` strategy) so forbidden headers,
    custom Cookie, Origin drop, and redirected-URL capture work.
    Validate the URL against `@connect` at the SW boundary before
    dispatching.
11. **`GM_notification`, `GM_openInTab`, `GM_registerMenuCommand`.**
12. **`GM_getResourceText` / `GM_getResourceURL`** — depends on
    `@resource` parsing, which is its own follow-up.
13. **`GM_cookie` with per-script `@match` validation.**
14. **(Deferred, on demand)** Add an offscreen document for binary
    XHR if real users hit the byte-serialization size ceiling.

At each step we want a few unit tests for pure helpers plus an e2e
spec that drives the API from a userscript on the fixture server.

## Things to revisit later

- TM-only surface (`GM_webRequest`, `GM_audio`, `GM_getTab`,
  `window.onurlchange`). Specifically `window.onurlchange` is worth
  prioritising because SPA scripts work badly without it.
- Whether to add a `@inject-into` option (currently we infer from
  `@grant`). Some scripts assume the VM keyword.
- Per-script `@match` validation gate that's stricter than VM's —
  e.g., when scripts use `*://*/*`, do we still let them touch any
  cookie? VM does; TM doesn't appear to. We can pick the safer
  default.
