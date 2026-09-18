# TODO

A backlog of **candidates**, not a list of obligations.

- Most entries record a deliberate trade-off and the conditions under
  which it would be worth revisiting — not a defect awaiting a fix.
  Shipping without any given item here is a valid outcome.
- Entries exist so a choice already made and reasoned about isn't
  re-litigated from scratch later. The reasoning matters more than the
  proposal.
- Nothing here is scheduled or prioritized. If something genuinely
  needs doing before release, it belongs in the relevant design doc or
  an issue, not buried in this file.

## Skeleton

- Injection follow-ups — see the **Limitations / future work**
  section of [docs/injection.md](docs/injection.md): `@noframes` /
  `allFrames`. (`@grant` / `GM_*`, `@require`, and `@resource` are
  all implemented; per-area follow-ups below.)
  - `allFrames` is no longer a self-contained change: `src/gm-menu.ts`
    keys menu commands by one `documentId` per tab, which only works
    while every wrapper shares the top-level document. Re-key it by
    (tabId, documentId) first, or subframe and top-frame scripts will
    wipe each other's menu commands.
- Reload fast-path: once HTTP-fetched scripts land, split the current
  single 500ms timeout in `handleCheckPending` into a 500ms detection
  window and a separate ~5s loading window. File:// reads finish well
  inside 500ms so the phases collapse today, but a remote `@updateURL`
  fetch can easily exceed that — we want to detect "an update is
  coming" fast, then patiently wait for the body to arrive before
  giving up and running the prior version. See
  `docs/injection.md#smcheck-pending-handler` for the current
  single-phase semantics.
- Reload fast-path: make `RELOAD_FAST_PATH_WINDOW_MS` depend on the
  script's declared `@run-at` rather than raising it flat.
  - The wrapper joins the decision and the `@run-at` gate at
    `max(...)` (see `docs/injection.md#concurrent-gates`), so on a page
    that reaches `document-end` / `document-idle` late the wait is free
    — a measured swap on `slow-dcl.html` decided at 176ms against a
    lifecycle event ~1s out.
  - It is NOT free for `@run-at document-start`, which has nothing to
    hide behind, nor for the other lifecycles on a fast page. A flat
    raise buys the slow case by delaying every fast one.
  - `runAt` is already on the wrapper's config blob, so adding it to
    the `sm:check-pending` payload is the whole plumbing cost.
  - Hard ceiling either way: the prelude's own 2s `awaitDecision`
    timeout, measured from when the wrapper asked. A window that
    outlives it gets a reply nobody is listening for, and the entry is
    already marked consumed. Leave real margin.
- Make an icon that works

## Source maps for stack traces

Requires and the body are concatenated into one injected entry (Mode
A — see [docs/injection-modes.md](docs/injection-modes.md)), and an
inline source map restores per-require devtools files and original
line numbers. The viewer's Log tab applies the same layout to
`err.stack` strings, which V8 leaves in generated coordinates — see
[docs/script-log.md](docs/script-log.md#stack-refs-are-source-mapped-first).

What is still unmapped:

- **`err.stack` as a script itself sees it.** We rewrite the string on
  the way into our Log tab; the value the userscript reads is
  untouched. A script that ships its own error reporter (Sentry and
  friends) will report generated line numbers. Fixing that would mean
  rewriting stacks inside the injected scope — a much bigger surface,
  and not obviously ours to do.
- **Columns on a no-`@require` script's first line.** With nothing to
  concatenate the body starts on the same physical line as the wrap
  head, so a frame at line 1 reports a column offset by the head's
  length. Line 1 of a userscript is its `// ==UserScript==` marker, so
  this has never been observed in practice; the code view already
  suppresses the column accent there.
- **The code pane counts lines differently from the mapper.** Mapped
  line numbers are counted the way V8 counts them (`\r`, `\r\n`,
  U+2028, U+2029), but Prism's gutter splits on `\n` only — so a
  `@require` with CR-only endings maps to a line the gutter numbers
  differently. Fixing it means teaching the code view V8's rule, which
  also affects gutter clicks and the `#file:line` deep link.
  - Header diagnostics are a third rule again: `parseHeader` counts
    `\r`, `\r\n` and `\n`, matching the regex it splits the block by
    (see [docs/diagnostics.md](docs/diagnostics.md)). It agrees with
    the gutter for everything except CR-only files, which is the same
    population as above — so all three converge if the code view
    learns V8's rule.
- **A stale log entry can't be mapped at all.** Entries older than the
  current `loadedAt` are left unmapped, because the layout they were
  generated against is gone. A tab still running the previous body
  slips through with a fresh timestamp. Stamping wrapper reports with
  the `loadedAt` they ran under would close both.

## Injection payload

- **Find the real `chrome.userScripts.register()` size limit.** One
  script with four 90 KB requires measures ~1 MB of `js[]` (the source
  map runs ~1.6x the code it maps). Nothing caps require count × size,
  and no documented limit was found. An earlier 512 KB cap on the
  map's embedded sources was removed as an invented number guarding a
  failure that already reports itself (`registerWithFallback` names
  the offending script). Worth an e2e smoke test that registers
  progressively larger scripts until it rejects, so the ceiling is a
  measured fact — and a check that the failure really is as visible as
  the fallback path suggests.
- **Wrap identifiers a `@require` can collide with.** The wrap
  declares `GM`, `GM_info`, every granted `GM_*`, `unsafeWindow` and
  `__sm*` in the same scope as the user program, so a library doing
  `const unsafeWindow = window.wrappedJSObject || window;` — a real
  idiom — is a parse failure. The install-time parse check now catches
  it and names the script (see [docs/parse-check.md](docs/parse-check.md)),
  so it fails visibly rather than silently — but the script still can't
  run. Renaming our internals (or moving the preamble reads onto
  `__smE`, which would also fix the `self` / `window` TDZ case) would
  make it work instead.
  - Measured over the GreasyFork top 2000: this is the *only* thing
    that made a real-world script fail to compile — 3 scripts, all of
    them fine under Tampermonkey (`var …, GM;`, the
    `if (typeof GM_setValue === 'undefined') { var GM_setValue = … }`
    polyfill, and a script shipping its own `function GM_addStyle`).
    See [docs/corpus-validation-results.md](docs/corpus-validation-results.md).

## Reload fast-path — remaining cost

The window is measured (see
[docs/diagnostics.md](docs/diagnostics.md#measuring-a-missed-reload-swap)),
and the dominant costs are gone: the slowest per-script check is 181 ms
of a 500 ms budget, the decision lands at ~243 ms. What remains:

- **`getKeys()` itself costs ~40 ms** on a 266-row namespace, paid
  inside the window by every storage-granting script. A per-script
  in-memory value cache in the SW (invalidated by `gmval:` writes)
  would remove it — see the GM storage note below.
- **The remaining `get(null)` scans are still full-namespace** —
  `match index`, `registration sync`, `all scripts`, `log id table`.
  They measured 129–193 ms each on a 266-row profile. Unlike the GM
  snapshot they genuinely want script rows, so narrowing them means a
  storage-layout change (bodies in their own rows), not a `getKeys()`
  swap.
- **`build-specs` costs ~320 ms on the sync right after a swap**, 2 ms
  on the next. That is the deferred parse check landing in
  `revalidateCandidates` — expected, and off the user-visible path, but
  it means the fresh body is re-registered a beat later than the log
  suggests.

## Parse check — follow-ups

The compile-only check is in (see
[docs/parse-check.md](docs/parse-check.md)). What it doesn't do yet:

- **Compile with the wrap's own declarations.** The check omits the
  wrap head's `var` preamble, the `__smE` parameter and the GM
  prelude, so a script declaring `const __smE`, `let __smDecision` or
  `const __smGmSnap` passes and then fails at injection. Every such
  name is `__sm`-prefixed so the risk is small, and it errs toward
  false-accept. Compiling with `new Function('__smE', preamble + src)`
  would close it.
- **Place a brace imbalance at its cause, not its symptom.** A stray or
  missing `}` is reported by the raw probe at the brace itself, which
  is right — but only when the raw probe is the one chosen, via a
  disagreeing message or an out-of-range wrapped probe. Where the two
  probes both parse past the brace and land in range, the reported line
  is a real error that the imbalance *caused*, further down the file.
  Reporting the imbalance itself would mean tracking brace depth, which
  is a parser.
- **A top-level `return` above a brace imbalance loses the position.**
  The raw probe stops at the `return` with a Script-only diagnostic, so
  it's discarded; the wrapped probe escaped, so it disagrees. Nothing
  is left to place the error and only the message is shown. Correct —
  the alternative was naming a legal line — but a third probe framing
  (async function body, say) might reach it.
- **Batch per refresh pass.** The check is one round trip per changed
  script. `parseCheckedHash` keeps unchanged content free, so this only
  bites on a first-add of many scripts at once.
- **Don't let a failed check clear a real `invalid` verdict.**
  `applyParseCheck` returns the freshly-built row unchanged when the
  verdict is null or `unknown`, and that row starts out `ok`. So a
  refresh whose check couldn't run resets a script that genuinely
  doesn't parse back to `ok` and logs a recovery.
  - Installing checkers in extension pages (this change) removes the
    common cause, but not the shape.
  - Fix: when the verdict is inconclusive AND the prior row was
    `invalid` at the same `parseCheckKey`, carry the prior status and
    message forward. Nothing was re-derived, so nothing justifies the
    recovery.
- **A sync-time `invalid` writes no Log entry.** The install/refresh
  paths seed the script's Log tab; `verifyParseChecks` only flips the
  row and writes a line to the SW console. So the collections page
  says "Syntax error: …" while the script's own Log tab can stay empty
  for the session. Whether the boot-time replay picks it up is a race
  with `syncRegistrations`.
- **A tripped sandbox breaker still costs a composed source per row
  per sync.** `compileParseChecker` builds the checked text *before*
  `checkParses` reports that the circuit breaker is open, so a browser
  whose offscreen document never works pays that build for every
  candidate on every sync. Asking the breaker first would make the
  degraded case free.
- **Re-verify `missing` rows too.** The `runSync` gate only re-checks
  candidates whose status is `ok`; a `missing` row re-enabled from its
  cached body registers on whatever verdict it last had. Those bodies
  were checked when they were `ok`, so the hole is narrow — but a row
  stored before the check existed and then flipped to `missing` skips
  it entirely.
- **Don't fetch dependencies twice on install-from-preview.** The
  preview fills `previewFetchCache` to run its check; clicking Install
  then runs `addCollection` → `attachFiles` against the store's own cache,
  so every `@require` / `@resource` is fetched again. Bridging the two
  caches (or handing the preview's typed entries to the install) would
  halve the third-party traffic that eager fetching introduced.

## GreasyFork corpus findings

Running the install-time checks over the top-2000 GreasyFork scripts
(`pnpm run validate`, see
[docs/offline-validation.md](docs/offline-validation.md)) turns
"scripts SourceMonkey would refuse" into a measured list. Full results,
with the evidence behind each item, are in
[docs/corpus-validation-results.md](docs/corpus-validation-results.md);
what follows is the fix list it implies.

Worth re-running after any change to the header parser, the `@require`
gates, or the emitted wrap — the rate is the regression signal.

- **`@require` URLs with no `.js` suffix.** `isJsResourceUrl` gates on
  the URL path, and the CDN shorthand forms
  (`cdn.jsdelivr.net/npm/sweetalert2@11`, `unpkg.com/file-saver`,
  `bundle.run/p-queue@6.3.0`) carry no extension at all. Every
  rejection in the corpus was one of these — no case where the gate
  caught something that wasn't JavaScript. Tampermonkey does no suffix
  gating. Either drop the gate in favour of the content-type + UTF-8
  checks that already run on the response, or extend it to accept
  extension-less paths.
- **The 1 MB per-file cap.** `MAX_FILE_BYTES` rejects `opencv.js`,
  `babylon.min.js`, MathJax's `tex-mml-chtml.js`, `video.js` and
  `babel-standalone` — libraries a script legitimately pins. Splitting
  the cap per kind is the obvious first move: a `@require` becomes part
  of the registered `js[]`, while a `@resource` becomes a
  `chrome.storage.local` row, and those have different budgets. Pairs
  with "Find the real `chrome.userScripts.register()` size limit"
  above, which is what a `@require` cap should actually be derived
  from.
- **Metadata-block markers are matched more strictly than the
  ecosystem's.** `BLOCK_START` / `BLOCK_END` anchor to end-of-line, so
  `// ==/UserScript==////` and `// ==/UserScript==vvvvar thisUrl = …`
  read as unterminated, and `/// ==UserScript==` reads as no block at
  all. GreasyFork serves all three, so something upstream accepts them.
  Decide whether to match loosely (TM matches the marker anywhere on
  the line) or to keep the strictness and say so in the error.
- **Wrap-identifier collisions are real, not theoretical.** Every
  parse failure in the corpus was one — see the item under "Injection
  payload" above, which now has a measured rate behind it.
- **`data:` URL `@require`.** Rejected outright today. One corpus
  script inlines a shim that way
  (`data:application/javascript,%3Bwindow.Vue%3DVue%3B…`). Cheap to
  support for the `application/javascript` form, since the bytes are
  in the ref and no fetch is involved.

## Cross-manager coverage

- **No `tests/examples/` script exercises `@require` under
  Tampermonkey.** `require-scope/` covers both injection worlds, but
  skips under `--project=tampermonkey`: it uses a relative `@require`,
  which TM doesn't resolve, and TM installs these examples from a
  local file so there's no base URL to resolve against. Baking in an
  absolute URL doesn't work either — the fixture server's port is
  assigned per run.
  - Closing it needs either a fixed-port fixture server for the TM
    project, or a rewrite step that stamps the server URL into a
    generated copy of the script before TM installs it. Until then
    the TM-compatibility claim for `@require` — the whole premise of
    the concatenated arrangement — rests on unit and SM-only e2e
    coverage, plus the VM project below.
  - The `violentmonkey` project does exercise it: VM installs from
    the fixture server's URL and resolves the relative ref against it.
- **VM doesn't inject into `file://` pages in the test profile**, so
  `gm-info`'s file:// case is skipped there. Verified it isn't the
  file-access toggle: the grant is live, the script is installed with
  its `file://` `@match`, and a reloaded VM still doesn't run it. VM
  registers one `chrome.userScripts` entry matching `<all_urls>` and
  matches internally, so whether the cause is VM, Chrome's MV3
  `userScripts` API, or that registration's persistence is unresolved.
  Worth pinning down before we claim anything about VM and local
  files. See
  [docs/cross-manager-test-results.md](docs/cross-manager-test-results.md).
- The known divergences to expect across managers are catalogued in
  [docs/supported-GM-APIs.md](docs/supported-GM-APIs.md) and
  [docs/supported-headers.md](docs/supported-headers.md).

## `GM_*` — deferred surface

The Phase 1–10 work shipped the priority APIs; everything below is
either a follow-up gap, a tractable second-tier API, or a research
question. See [docs/supported-GM-APIs.md](docs/supported-GM-APIs.md)
for the current state of the per-API matrix and
[docs/GM-APIs.md](docs/GM-APIs.md) for implementation details.

### XHR header surgery — leftovers

The surgery itself shipped (`src/gm-xhr-headers.ts`): forbidden
request headers, `Sec-Fetch-*` included, travel as a per-request
declarativeNetRequest session rule keyed on a URL-fragment tag, and our
extension `Origin` is removed by default. What's still open:

- **Defaults are unmeasured.** Only `Origin` removal is defaulted;
  `Sec-Fetch-*` is left alone unless a script asks. Whether to match
  Tampermonkey's defaults instead needs TM's actual wire headers,
  which `tests/examples/gm-xmlhttp/gm-xmlhttp-wire-headers.spec.ts`
  will report once a TM profile exists on the machine
  (`docs/cross-manager-testing.md`).
- **Redirects skip the surgery.** The rule matches the original URL,
  so a 30x hop goes out without the overrides and without the `Origin`
  removal. Fixing it means predicting the target (can't) or rewriting
  on `onBeforeRedirect`, which MV3 doesn't offer for this.
- **`finalUrl` across redirects** is still `res.url`, which is right
  for what fetch reports but doesn't expose the intermediate hops.
- **The header-stall backstop has no test.** `XHR_HEADER_STALL_MS` is a
  module-private 2 minutes, so exercising it needs a seam (export it,
  or let `runXhr` take an override) — no test waits two minutes. The
  paths around it are covered; the firing itself is not.
- **A `timeout` over 5 minutes can't be honored.** The page-side
  `XHR_PAGE_SIDE_TTL_MS` abandons any request without a terminal event
  at 5 minutes and synthesizes an error, so a script asking for longer
  gets that instead of its own `ontimeout`. Predates the header work
  and is unrelated to it; fixing it means letting the TTL follow the
  request's own timeout rather than being a flat constant.

### GM_* APIs not yet in the catalog

Adding any of these is a catalog entry + a body — nothing structural.

- `GM_cookie.list` / `.set` / `.delete` — `chrome.cookies` wrapped
  with per-script `@match` validation. VM's `checkCookieOpts`
  (`src/background/utils/cookies.js`, shipped in VM 2.35.1) is the
  reference shape: validate the target URL against the calling
  script's `@match`, and hide `httpOnly` cookies unless the user
  opted in.
- `GM_getValues` / `GM_setValues` / `GM_deleteValues` — bulk storage
  calls that both TM (5.x) and VM (2.19.1+) have. Convenience over our
  existing per-key APIs, which already batch writes.

### GM_* implementation follow-ups

- **Menu commands vanish on a bfcache restore.** `src/gm-menu.ts`
  holds ONE document's commands per tab, so leaving a page drops its
  registrations — and Chrome doesn't re-inject on back/forward, so
  nothing re-registers them. The restored page's callbacks are still
  alive in its document; only the SW-side mirror is gone, and its
  action-menu rows stay missing until a real document load.
  - Fix is a mirror per (tab, document) with an LRU like the one
    `updateTabMatches` already keeps for `TabMatchState` (see
    [docs/matching.md](docs/matching.md#per-tab-document-lru-bfcache-restore)),
    plus a render path that reads the tab's *current* document.
  - Pre-existing, not introduced by the documentId keying — that
    only changed the symptom from "shows the previous document's
    dead rows" to "shows none".
- **Live `@grant` revocation.** Today `@grant` is baked into the
  wrapper at register time, so changes only take effect on reload.
  Worth doing per-call permission checks (with caching + invalidation
  broadcasts) if users start expecting collections-page edits to take
  effect immediately.
- **Offscreen-doc fallback for clipboard.** `navigator.clipboard.
  writeText` may reject without focus / transient activation. TM/VM
  use an offscreen `execCommand('copy')` to avoid the requirement.
  The offscreen document already exists (`src/offscreen.html` +
  `src/offscreen.ts`, built for the parse check) and the `offscreen`
  permission is declared — MV3 allows only ONE per extension, so
  EXTEND that host rather than adding a second. Needs
  `clipboardWrite` in the manifest and `CLIPBOARD` added to the
  `reasons` array in `parse-check.ts`, which is fixed at creation
  time.
- **Binary XHR encoding monopolizes the SW loop.** `runXhr` buffers
  the whole body and calls `bytesToBase64` once (`src/gm-xhr.ts`),
  bounded only by the 50 MB `MAX_RESPONSE_BYTES` cap.
  `String.fromCharCode` is chunked at 32 KB but the closing `btoa` is
  a single call over the whole string, and the worker holds the bytes
  and the string at once.
  - It matters because that same loop answers `sm:check-pending` on
    the document-start critical path, so one script pulling a large
    binary can delay injection in unrelated tabs.
  - VM doesn't have the problem: its XHR and encoding run in the
    offscreen document, chunked at 1 MB precisely so neither the
    extension nor the page stops responding
    (`src/offscreen/xhr.js`).
  - Two ways out. Cheap: chunk the encode and yield between chunks,
    which keeps it in the worker but stops the monopolization.
    Thorough: move the binary path to our offscreen document, which
    also gets us `xhr.upload` progress events — `fetch` can't report
    upload progress at all, so that's the one part of the
    `GM_xmlhttpRequest` surface the worker cannot reach.
  - Either way, measure first: we have no data on real-world
    response sizes, and most `GM_xmlhttpRequest` payloads are small
    enough that this never fires.
  - If it goes to the offscreen document, it shares the host with
    the clipboard item above — `reasons` is fixed at creation time,
    so both consumers' reasons (`BLOBS`, and `WORKERS` if the encode
    moves to a worker) have to be added in the same change.
- **`window.close` / `window.focus` failures are filed under the
  first granting script.** The override closes over the scriptId of
  whichever script installed it, so a sibling script's refused close
  lands on the wrong Log tab. Cosmetic, and it disappears with
  per-script worlds (below).
- **`window.*` grant scope is per-document-and-world.** Once any
  script on a page grants `window.onurlchange`, the `urlchange`
  surface exists on that world's shared `window`, so a sibling script
  in the same world that did NOT grant it can also feature-detect and
  subscribe. `@grant window.close` / `window.focus` leak the same way
  — their overrides replace the methods on that same shared `window`.
  TM sandboxes each script's `window` and gets exact per-script
  gating. Same shared-realm root cause as the storage-spoofing entry
  below; a real fix needs per-script worlds.
  - In MAIN world the shared `window` is the **page's**, so the page
    sees these too: it can subscribe to `urlchange`, and its own
    `window.close()` reaches our override. The override is
    scriptId-scoped SW-side (`bridgeMayActAs`), so the page gets no
    more than the MAIN-world script it shares a realm with already
    had — but "the page can close its own tab" is a behavior change
    worth knowing about. TM has the same exposure in its page-context
    mode.
- **`window.*` reload-fast-path coverage.** The stated reason the
  `urlchange.enable` and `windowControl.enable` calls live in the
  emitter's `js` (rather than `prelude`) is that a hot-swapped body
  still needs the surface. Only the emitted string's position is
  asserted today; an e2e driving the run-new swap with these grants
  would make the rationale load-bearing. `resource.init` sits in `js`
  for the same reason and now has that e2e
  (`reload-fast-path.spec.ts`), so these are the eager calls whose
  swap behaviour is unasserted.
- **CSP-exempt DOM injection for MAIN-world scripts.** `GM_addStyle` /
  `GM_addElement` bypass page CSP from USER_SCRIPT world but not from
  MAIN, so a `@grant unsafeWindow` script on a site with a strict
  `style-src` inserts a `<style>` whose rules never apply. A
  `styleEl.sheet === null` check after append is a reliable
  blocked-detector; the fallback would be an async bridge request
  asking the USER_SCRIPT-world runtime to insert a CSP-exempt copy,
  at the cost of the returned element no longer being the live one.
  TM/VM have the same limitation today.
- **Frame-scope the remaining SW pushes.** `sm:gm-xhr-event` now goes
  to `sender.frameId`, but `sm:gm-tab-closed`,
  `sm:gm-notification-event` and `sm:gm-menu-fire` still go tab-wide,
  and `sm:gm-value-update` is inherently tab-scoped (the openers table
  keys on tabId). Harmless while nothing registers with `allFrames` —
  the bridge only exists in the top frame — but the day `@noframes`
  work turns that on, a MAIN-world script's events would be posted
  into every subframe's realm. Needs a per-frame openers table.
- **Gate `sm:start` over the bridge too.** It's what populates the
  `gmOpeners` table, i.e. who receives value broadcasts. A forged one
  can only name an id the page can already see, and the push relay is
  world-gated, so there's no live hole — but `bridgeMayActAs` exists
  now and applying it would close the shape rather than relying on id
  entropy.
- **Shim-cache `setTimeout` / `clearTimeout` in the GM runtime.** Every
  other primitive it uses is captured at init; timers are still read
  off the live global, which a MAIN-world page can replace. No impact
  today (the runtime installs at `document_start`), just inconsistent
  with the file's stated discipline.
- **Bridge gate vs. matcher divergence.** `bridgeMayActAs` decides
  whether a MAIN-world script may act by re-running our own
  `url-match.ts` against the sender's URL, while Chrome decided
  whether to inject with its matcher. A disagreement refuses a
  legitimate script — fatal for a storage-granting one. Worth a
  cheaper, divergence-proof signal (e.g. keying off the tab's recorded
  `expected` set, or a per-document token minted at `sm:start`).
- **Bridge gate and push stamping read the stored world, not the
  live one.** `scriptWorld` / `bridgeMayActAs` answer from the current
  row, but a document that loaded before an edit flipped the script's
  world keeps running the old one until reload. USER_SCRIPT → MAIN:
  the open isolated document's pushes are stamped MAIN and re-posted
  into the page until reload. MAIN → USER_SCRIPT: the open MAIN
  document's bridged calls are refused. Both self-heal on reload; the
  per-document token above would fix both.
- **MAIN-world transport detection keys on `chrome.runtime.sendMessage`
  existing.** A page listed in another extension's
  `externally_connectable` has it in MAIN world too; there the runtime
  takes the direct transport and every SW call throws ("must specify an
  Extension ID"). Detect the world by `chrome.runtime.id` (undefined on
  a web page) in the runtime and the prelude's `send` / `awaitDecision`.
- **A refused runtime pattern takes GM_* down for its whole world.**
  The runtime registers on the union of its scripts' patterns, so one
  pattern Chrome rejects (the case the rejection map exists for) fails
  the runtime spec itself and every GM_* call in that world with it.
  Retry a refused runtime spec at `<all_urls>` (the pre-scoping
  fingerprint, not an outage), or drop patterns `matchPatternProblem`
  flags from the union.
- **MAIN-world storage flush at teardown.** A MAIN-world
  `GM_setValue` batch leaves as a postMessage the bridge relays in a
  later task, so a `pagehide` flush can be dropped where a
  USER_SCRIPT-world one wouldn't be. Options: shorten the debounce in
  MAIN, or have the bridge hold a mirror of pending writes.
- **XHR `onprogress` events.** Needs a streaming wire format from
  the SW (chunked sends or a per-request port).
- **`GM_download` follow-ups.**
  - **Make `downloads` an optional permission.** TM's `not_enabled` /
    `not_permitted` errors exist because its download support is
    opt-in. We declare `downloads` unconditionally, which adds a
    "Manage your downloads" prompt for every user including those who
    run no downloading scripts. `chrome.permissions.request` needs a
    user gesture on an extension page, so this means an Options-page
    toggle plus a `not_permitted` path when it's off (already
    implemented — the SW checks `chrome.downloads` at call time).
  - **TM-style file-extension allowlist** (`not_whitelisted`). We rely
    on Chrome's dangerous-download prompts today. Worth revisiting
    with the optional-permission work, since both want the same
    Options-page surface.
  - **Completion signal for the in-page `blob:` / `data:` path.** The
    anchor click has none, so `onload` fires ~250 ms after the click
    rather than on completion — "handed to the browser", not "written
    to disk". http(s) is unaffected; documented under
    [download caveats](docs/supported-GM-APIs.md#download-caveats).
    - The click *does* create a real `chrome.downloads` item and the
      SW already sees every `onChanged`, so the transfer is
      observable — we just don't tie it back to a request.
    - Correlating means matching an unclaimed new download to a
      pending in-page request by `finalUrl` plus a time window. Two
      scripts downloading the same blob URL in the same instant are
      indistinguishable.
    - The timer would stay as a fallback: a `data:` URL that completes
      before the SW hears about it must still settle.
  - **Progress polling interval is fixed at 500 ms.** Fine for a
    progress bar; a per-request interval (or a rate proportional to
    file size) would be nicer for very large files. The poll is also
    what keeps the SW alive across a long download, so a slower rate
    needs to stay under the ~30 s idle shutdown.
  - **No recovery after the SW really dies** (browser restart, crash).
    The `requestId → downloadId → tab` mapping is in-memory, so a
    download in flight at that moment never reports back. Persisting it
    in `chrome.storage.session` and re-attaching on SW startup would
    fix it. Deliberately NOT solved with a page-side TTL the way
    `GM_xmlhttpRequest` does it — a download can legitimately run for
    hours, so there's no honest deadline.
  - **`interrupted` is treated as terminal even when `item.canResume`
    is true.** Chrome's UI would offer "Resume", and a download the
    user resumes to completion still reported `not_succeeded` (plus a
    Log warning). Waiting instead would risk never settling the script
    at all, so this stays until someone hits it in practice.
- **Page-side TTL for XHR active requests.** Currently 5 min. Fine
  for now; revisit if real workloads hit it.
- **Abort-after-response narrow race.** A SW round-trip on abort
  would close it. Today the local abort is synchronous (TM/VM
  match) and the race window is small.
- **Cross-script storage spoofing inside the trust boundary.** The
  wrapper-supplied `scriptId` in the storage / XHR envelopes can
  be impersonated by sibling userscripts (they share one USER_SCRIPT
  world per frame and can read each other's ids). Documented
  limitation; within the user's trust boundary and matches TM/VM.
  NOT the same as the page-reachable forged-`sm:check-pending` read
  leak, which is now closed. No cheap fix: verifying the id against
  the tab's active registration set does NOT stop impersonation (the
  victim is active too) — it's hygiene, not security. A real fix
  needs a per-script boundary the shared world lacks (in-closure
  capability tokens + frozen runtime, or per-script `worldId`
  isolation). See the rationale in `docs/GM-APIs.md`.
- **Cross-tab broadcast start-race window.** A write that lands
  between a tab's wrapper registration and its `sm:start` arrival
  isn't broadcast to that tab. The compile-in cache covers the
  state at register time; live broadcasts kick in once `sm:start`
  fires. Closing the window would require registering openers at
  registration time, not on `sm:start`. Narrower than it was: a
  script with a value-change listener recovers on the next resync
  (docs/GM-APIs-storage.md), so this only strands a listener-less
  script's cache.
- **Iframe-of-same-tab broadcast skip.** The openers table dedupes
  by tabId, so a write in the main frame of tab T doesn't broadcast
  to other frames of T. Each frame stays consistent at register
  time and diverges on writes until next reload. Acceptable for
  v1.
- **A refused reload swap is only visible in the page console.** When
  the prelude can't seed the storage cache for a `run-new` body it
  runs the prior version instead and logs there — no `sm:*` report, so
  the Log tab and the badge show an ordinary run while the user is
  looking at a stale script. `sm:error` would be wrong (the script did
  run); a warning-level Log row would fit. Same gap for the SW-side
  deferrals (world change, snapshot read failed).
- **Storage quota error surfacing.** A `chrome.storage.local.set`
  rejection (quota exceeded) only `console.warn`s; the userscript
  sees no error. Surface on the per-script log.
- **Tagged-string storage as a read-path optimization.** VM/TM store
  each value as a tagged *string* — VM's `dumpScriptValue`
  (`src/common/util.js`) writes `s`/`n`/`b` plus the literal for
  primitives and `o` plus JSON for everything else — so reads of
  primitives skip `JSON.parse` entirely.
  - Not a correctness gap: type fidelity is handled, by a different
    scheme that stores values structurally rather than as strings.
    See
    [docs/GM-APIs-storage.md](docs/GM-APIs-storage.md#value-type-fidelity).
  - Also worth being clear that VM's own tags don't buy fidelity:
    `Date` and other non-JSON-clean values go through
    `JSON.stringify` there too.
  - Copy only if storage reads ever show up in a profile, and note
    the win is smaller for us — `chrome.storage.local` deserializes
    the row either way.
- **Cache the gmValues snapshot in SW memory.** Every storage-
  granting script's `sm:check-pending` reply triggers a
  `chrome.storage.local.get(null)` on the document-start critical
  path. A per-script in-SW cache invalidated by `handleBatchWrite`
  would skip it on cache hit. See
  [docs/GM-APIs-storage.md](docs/GM-APIs-storage.md#cost-on-the-document-start-critical-path).
- **Shim cache audit.** The page-side runtime captures `Promise`,
  `Error`, `Object.keys`, `Object.create`, `Object.prototype.
  hasOwnProperty`, `document.createElement`, `Node.appendChild`,
  `Element.setAttribute`, `chrome.runtime.sendMessage`,
  `navigator.clipboard.writeText`, `console.log`,
  `Object.defineProperty`. The `window.onurlchange` surface also
  captures the world's own `window.addEventListener` /
  `removeEventListener`, but deliberately at install time rather than
  init time so a sibling userscript's legitimate wrapper stays in the
  chain. New subsystems should extend the capture set if they reach
  for new builtins.
- **`GM_notification` SW-restart survival.** Click / done callback
  mappings are in-memory; an SW restart between create and event
  drops them. Open notifications keep showing but their events
  don't reach the userscript. A future phase could persist the
  mapping in `chrome.storage.session` to ride out idle-suspends.
- **`GM_notification.tag` coalescing.** TM uses `tag` to replace an
  existing notification with the same tag in place. We accept the
  field but don't coalesce — each call creates a new notification.
- **`GM_openInTab` exact-position insert.** `insert: true` biases
  Chrome via `openerTabId`, but doesn't guarantee an index. An
  exact `index = opener.index + 1` would need a
  `chrome.tabs.get(opener)` round-trip first.
- **`GM_openInTab` SW-restart survival.** The (requestId ↔ chromeTabId
  ↔ originator) mapping is in-memory; on SW restart already-open
  tabs stay open but `onclose` events from them won't route back
  to the userscript.
- **`GM_notification` click-path e2e coverage.** Headless Chromium
  suppresses notification UI so we can't drive a click from a
  Playwright test. Either drive
  `chrome.notifications.onClicked` directly via the SW test surface
  (similar to `sm.syncNow`) or land a manual-test checklist for
  prod-Chrome verification.
- **`GM_info` data files.** Compare what we return for GM_info vs
  what TM/VM/etc return.
- **`applyRemoteUpdate` listener delivery without storage grant.**
  `wrapper-gm-runtime.js#applyRemoteUpdate` short-circuits on
  `!s.ready`, which is only set by `storage.init`. A script that
  grants ONLY `GM_addValueChangeListener` (no read/write APIs) never
  receives broadcasts. `requestResync` / `applyResyncSnapshot` gate on
  the same flag, so the resync path doesn't rescue that script either.
  Fix: emit `storage.init` whenever any storage subsystem (read/write
  OR listener) is granted, or dispatch listeners independent of
  `s.ready`.
- **Cross-window incognito broadcast filtering.** `broadcastValueUpdate`
  doesn't filter targets by `tab.incognito`, so a write from an
  incognito tab can fan out to normal-window tabs running the same
  scriptId (and vice versa). Same caveat applies to value-change
  listener dispatch, to the resync snapshot (`handleGmResync` hands
  back the one shared value map), and to the resync nudge (which
  sweeps every tab). Should match Chrome's extension incognito
  isolation contract.
- **Openers rows accumulate across a tab's navigations.** A row is
  added per (scriptId, tabId) at document start and only removed when
  the tab closes, so a long-lived tab keeps rows for every script it
  has ever run — now for the whole Chrome session, since the table is
  mirrored to session storage. Cost is a wasted `tabs.sendMessage` per
  stale row per write; the receiving document just has no store for
  that scriptId. Fix: drop a tab's rows on committed navigation and
  let the new document's sm:start re-add them.
- **`GM_xmlhttpRequest` binary request bodies.** FormData / Blob /
  ArrayBuffer request bodies aren't supported — non-string `data`
  stringifies to `[object …]` at the SW boundary. Wire format
  needs a binary-tagged envelope (mirroring the binary RESPONSE
  path) for non-text bodies.
- **`composeWrapperErrorMessage` substring dedup.** The first-line
  dedup in `background.ts` checks `firstLine.includes(msg)`, so a
  message like `"ok"` substring-matches a stack first line of
  `"OkayThenError: foo"` and drops the prepend. Switch to
  word-boundary or `": " + msg` matching.
- **`GM_addElement` attribute sinks doc note.** `applyAttr` passes
  caller-supplied attribute name/value to `setAttribute` unchanged —
  intentionally matches TM/VM (userscripts have full DOM authority).
  Worth one line in `supported-GM-APIs.md` calling out
  `src=javascript:`, event-handler attributes, and `<script src>`
  as deliberately un-sanitized sinks.
- **`@grant none` mixed with real grants.** `resolveGrants` says a
  `none` line anywhere wins (so the script gets no bindings), but
  `resolveWorld` only takes the MAIN branch when EVERY line is
  `none` — so `@grant none` + `@grant unsafeWindow` lands isolated
  with nothing at all. Only 4 of the top-2000 GreasyFork scripts mix
  `none` with anything, and none of those pair it with
  `unsafeWindow`, so this is documented rather than changed. Pick one
  rule and apply it in both places.
- **Listener-id contract.** `addValueChangeListener` returns the id
  as a `String(numericCounter)`. TM returns numeric IDs. Pin the
  contract in `GM-APIs.md` — id should be opaque to callers, but
  document what we return.

## `@connect` follow-ups

- **`self` subdomain handling.** TM/VM treat `self` as "the
  script's own origins OR their subdomains"; SourceMonkey matches
  exact host only. See `src/gm-connect.ts#hostMatchesRule`. Fix:
  fall through to the subdomain check against `selfHosts` as a set
  of bases. Documented limitation pending a real compat report.
- **Port handling is asymmetric.** A user-supplied port in
  `@connect example.com:8443` (no scheme) lands in the `exact`
  branch as `host = "example.com:8443"`, but request matching
  goes through `URL.hostname` which strips the port — so the rule
  never matches. Either strip ports consistently when parsing rules
  or preserve them end-to-end through matching.
- **IDN / Unicode host normalization.** `parseConnectEntry` lowercases
  but doesn't punycode-normalize bare-host entries. A rule
  `@connect börse.example` byte-compares against `URL.hostname`
  which returns the punycode form (`xn--brse-5qa.example`) on most
  browsers. Normalize both sides via `new URL('https://' +
  host).hostname` before storing.
- **IPv6 host handling.** `URL.hostname` returns IPv6 addresses in
  bracketed form (`[::1]`). `@connect ::1` (no brackets) won't
  match. Decide whether to require brackets in rules, or
  bracketize bare IPv6 in `parseConnectEntry`.
- **Wildcard-with-port rule.** `parseConnectEntry` on
  `*.example.com:8443` treats the port as part of the host string,
  so the wildcard branch's `endsWith` check never finds the port.
  Same root cause as the bare-host port issue above.
- **`@connect *` install-time warning.** A wildcard `@connect`
  effectively asks for cross-origin fetch reach against any host.
  TM prompts the user at request time; VM doesn't enforce `@connect`
  at all, it just lists the declared hosts on its install-confirm
  page. Surface a "this script wants to talk to any host" signal in
  the collections-page row at install / refresh time.

## Test coverage gaps

Negative-path / edge-case tests that would catch real bugs noticed
during cumulative review of the GM_* phases:

- **Storage**: circular-object `GM_setValue` (silent cycle drop on
  JSON serialize), `chrome.storage.local.set` quota rejection (cache
  diverges from storage), listener-throws (sibling listeners should
  still fire), 1000-key prefix-scan perf smoke.
- **Value-change listeners**: two listeners on the same key both
  fire; cross-tab broadcast start-race window; iframe-of-same-tab
  broadcast skip.
- **`@connect`**: IPv6 hosts (`[::1]`), wildcard-with-port
  (`*.example.com:8443`), forbidden-request-header strip surfacing,
  GET / HEAD with `data` body (silent drop vs. surfaced).
- **`@grant`**: `GM.GM_setValue` typo lands in `unknown` and
  ReferenceError at runtime + SW logs dropped name.
- **`GM_notification`**: image-less notification falls back to
  `icons/icon-128.png` correctly.
- **Live repaint** (collections page): a `collections`-index reorder arriving
  from another origin, and the `.busy-spinner` guards that stop a
  repaint from overwriting a control the user just clicked. The reorder
  case has no test because nothing on the SW test surface moves a
  collection — `moveCollection` would have to be exposed first.
- **`repaintPage()`'s serialization contract** — that a burst of writes
  collapses into one pass, and that `await repaintPage()` observes the
  caller's own write. The add / remove / refresh tests depend on it but
  only cover it incidentally.
- **`chrome.userScripts.update` behaviours with no live probe.** Two
  facts the registration path is built on are modelled by the fake in
  `tests/unit/injector.test.mjs` but never re-measured against Chrome:
  that `matches: []` is refused (so `matches` can be changed but not
  cleared), and that an updated registration moves to the END of
  Chrome's set. The glob half now has a probe in
  `tests/e2e/exclude-globs.spec.ts`; these two should join it, so a
  Chrome change that invalidates them fails a test rather than silently
  changing injection order or leaving a stale match set.

## Concurrency — accepted races

The write mutex in `script-store.ts` is per JS context. The interleaves
that leaves are catalogued in
[docs/storage.md](docs/storage.md#the-lock-is-per-context) rather than
here — they are decisions, not proposals.

One thing does have a concrete fix we chose not to make:

- **`setRefreshError` is a lost update waiting on a rare trigger.**
  `src/refresh-error.ts` read-modify-writes one whole map, with nothing
  serializing it, and `refreshAllCollections` runs collections two at a
  time. Two collections failing in one pass can drop each other's entry;
  a healthy collection's clear can resurrect a sibling's error.
  - The fix is to stop sharing the map: one `refresherror:<cid>` key per
    collection, which makes every write independent and deletes the
    read-modify-write entirely. The collections page would read them
    with one prefix scan, as it already does for log levels.
  - Not done because the map only ever fills when a refresh **write**
    fails — in practice an exhausted `chrome.storage.local` quota — so
    reaching it means the profile is already degraded, and what is lost
    is a diagnostic message rather than any state. Worth doing if the
    banner ever becomes load-bearing, or alongside any other change to
    that module.

## Storage-key migration — remove after 2026-09-01

- **`ensureCollectionKeysMigrated` in `src/script-store.ts` is
  temporary.** "Sources" were renamed to "collections" in August 2026,
  which moved the `"sources"` index to `"collections"`, every
  `source:<id>` row to `collection:<id>`, and each script's `sourceId`
  field to `collectionId`.
- The helper rewrites a pre-rename profile in place on the first storage
  read in each JS context, so an upgrade doesn't read as a wiped
  profile. Every read path in the store awaits it, and `match-index.ts`
  / `injector.ts` await it before their direct `storage.local` reads.
- **After 2026-09-01**, delete `ensureCollectionKeysMigrated`,
  `migrateLegacyCollectionKeys`, `LEGACY_INDEX_KEY`,
  `LEGACY_COLLECTION_PREFIX`, and the three `await` sites. Any profile
  still on the old spelling by then re-adds its collections by hand,
  which is a one-time cost paid by nobody in practice.

## Local copies — follow-ups

See [docs/local-copy.md](docs/local-copy.md#whats-next) for the list;
the items with a trade-off worth recording:

- **Destinations outside Downloads.** The FSA directory picker is the
  only one-dialog way to write N files anywhere, and its missing
  absolute path is recoverable by reading the expected paths back over
  `file://`. Costs the user one navigate-to-the-folder pick per
  collection, and whether a stored handle's grant survives a restart on
  an extension origin is unverified.
- **The "Ask where to save each file" preference.** Chrome honours it
  regardless of `saveAs: false` (verified), so those users get a Save As
  box per file. A copy with dependencies then means N boxes; the
  dialog could warn when the setting is on, but nothing exposes it —
  the first cancelled download is the only signal.
- **`@icon` beside the copy.** The cached icon is on hand; the layout
  rule is the same. Left out until someone edits an icon.
- **Provenance** (`copiedFrom`) needs an explicit carry through
  `rebuildCollection`, which keeps only `enabled` from a prior row.
- **The dialog checks the OLD copies directory after Chrome's download
  location moves.** `OpenContext.copiesDir` comes from the stored
  setting, which is only corrected by a completed write — so the
  existence check, the Replace wording and the copy-of-itself guard all
  run against the stale path, and a file already at the NEW location is
  found only by Chrome uniquifying around it. The write reports that
  clearly now; detecting it up front needs a way to ask where Downloads
  is, which no API offers.
- **Two dependency URLs can collapse onto one file.** `mirrorPath`
  falls back to a shorter suffix when the host carries a `:`, so
  `localhost:8080/lib/util.js` and `localhost:9090/lib/util.js` both
  become `lib/util.js`; the second is dropped by the dedupe and both
  `@require`s then resolve to the first one's bytes. The dialog should
  flag the collision rather than dropping a row.
- **A `@require` whose URL ends in `.user.js`** is written into the
  copies collection and scanned in as a script of its own on the next
  refresh. A dependency subdirectory the scan skips would fix it, but
  that is exactly what the local-override suffix rule searches.
- **Windows paths.** `downloadsDirFromSaved` and `dirKey` assume `/`
  separators, so every copy on Windows would report "saved outside the
  collection directory". The rest of the extension is POSIX-first too
  (`isNonPosixFileUrl` aside), so this is a note rather than a
  regression.
- **The Downloads-folder field takes any absolute path**, with no
  readability probe — unlike the search-roots box above it, which
  checks. Same probe would do.

## Deleting local copies — follow-ups

See [docs/local-delete.md](docs/local-delete.md#whats-next); the items
with a trade-off worth recording:

- **A copy with no download record can't be deleted.** `removeFile`
  needs a download-history entry, which the user can clear. The way
  round it is to `download` a one-line "deleted by SourceMonkey"
  comment over the file with `conflictAction: 'overwrite'` and then
  remove that download — deliberately not done yet: it destroys the
  file's content *before* it can fail, Chrome's "Ask where to save each
  file" turns it into a Save As box aimed at a file we are erasing, and
  it writes to a path we only believe is the file's (see the stale
  copies-directory item above). A comment rather than zero bytes,
  because an empty `.user.js` reads as a broken script.
- **Shared dependency files are never deleted**, only listed. So the
  last copy to go leaves the library behind for whichever sibling
  claimed it — until that one is deleted too, when the file counts as
  its own. Cleaning up a file nothing claims needs a sweep of the
  collection, not a per-script plan.
- **No control over what goes.** The dialog reports three outcomes and
  offers no choice, because each follows from a fact it can state.
  Keeping a file that only this script uses, or deleting a shared one
  anyway, would need a control — and a reason to want one.
- **Empty directories are left behind.** `removeFile` deletes files;
  nothing in the extension can remove a directory, so a mirrored
  `cdn.example.com/lib/` outlives the file it held.
- **Only the copies collection's own rows can be deleted.** Eligibility
  needs the row to sit in the directory collection at
  `<Downloads>/SourceMonkey`, not just to have its file there, because
  the shared/own split is computed from that collection's scripts. An
  individual-file row pointing into the directory, a second directory
  collection overlapping it, or a manifest listing the same files would
  each make "which scripts read this file?" a different question — and
  getting it wrong deletes a library another copy needs. Widening this
  means answering that question globally first.
- **A copy Chrome has marked deleted cannot be removed at all.** The
  file is on disk, `removeFile` refuses it, and the row has no plain
  trash can of its own (a directory collection's rows are removed by
  refreshing, which would scan it straight back in). The user is told
  to delete the file by hand, and the next refresh then drops the row.
  The overwrite trick above would close this; a record-only "forget
  this script" would not, since the scan undoes it.
- **`exists` is only as fresh as Chrome's last check.** A file Chrome
  believes is there but isn't still reaches `removeFile`, which fails
  and is reported. Nothing is erased on that path, so a later attempt
  has the same handles it had.

## Collections page — follow-ups

- **No way to move a script between scripts collections.** Today it is
  install-into-the-other-then-remove (two clicks on two pages), which
  loses the row's enabled state and log. A "Move to…" on the per-row
  remove button's spot, or on the viewer's Collection row, would be the
  natural home; the store side is a `scriptIds` splice plus a
  `collectionId` rewrite under `mutate`.

- **Creating from a location scans it twice.** The dialog's
  `probeCollectionLocation` lists the directory / fetches the manifest /
  calls the GitHub Contents API, and `createCollection` then refreshes
  and does it again. Cheap for local; for GitHub it is a second
  unauthenticated API call against the rate limit. Threading the probe's
  scan into the first refresh would need `refreshCollection` to accept a
  pre-computed scan.

- **A `file://` row inside an http(s) collection can't be targeted.**
  `?refresh_file=` decides "local" from the collection's own location,
  so a `script_manifest.json` served over http that lists a `file://`
  entry is skipped — the caller gets "No local collection or script
  covers …" for a path that really is on disk. Refreshing just that row
  (`updateScript`) would avoid re-reading the manifest over the network,
  but the shape is rare enough that the extra branch hasn't earned its
  keep yet. See `src/refresh-targets.ts`.

- **`setToggleBusy` is not re-entrant.** Two quick clicks on the same
  toggle produce overlapping `onToggleScript` calls sharing one spinner
  element, so the first handler's `finally` removes it while the second
  write is still in flight. A repaint arriving in that window sees no
  spinner and paints the first write's value over the user's second
  click; the second write then lands and corrects it. A refcount on the
  label would close it.

## HTTP collections — follow-ups

- GitHub directory collections are scanned via the unauthenticated Contents
  API (60 req/hour/IP). Worth optimising: stash the listing's ETag and
  send `If-None-Match` on refresh so unchanged dirs don't burn budget.
- GitHub Contents API pagination. `scanGithubDir` reads only the first
  page; trees with >1000 entries silently truncate. Add `?per_page=100`
  + Link-header following when a real collection hits the cap.
- Branch names containing slashes (e.g. `feature/foo`) aren't supported
  by the github URL parser — the first ref segment is taken as the ref
  and everything after as the path. Disambiguating would need an extra
  branches/tags lookup.
- Conditional GET on the manifest itself. Today every refresh
  re-fetches and re-parses the manifest body even when nothing
  changed. Stashing the manifest's ETag/Last-Modified on the collection
  row would let us skip the manifest-level fetch on 304.
- End-to-end test coverage for the HTTP pipeline (the in-test
  fixture server can already serve arbitrary files; needs a
  `*.user.js` route plus a manifest route, then `sm.addCollection(url)`).
- Authenticated collections for non-GitHub hosts (basic-auth header,
  per-collection bearer token, etc.). GitHub PATs are wired up via
  `src/github-auth.ts`; everything else still relies on URLs being
  publicly fetchable.

## `@require` follow-ups

- **Shared storage of common require files.** Today each script stores
  its own copy of every required file inline on its `StoredScript`
  row. Five scripts requiring jQuery = jQuery stored five times. Move
  to a content-addressed `require:<sha256>` row keyed by `contentHash`,
  with each `StoredScript.requires[i]` holding only `{ ref, url,
  contentHash, validators, loadedAt }`. Add a sweeper that drops a
  `require:<hash>` row when its refcount across scripts hits zero.
- **UI surface for prefetched requires.** The viewer now shows one
  tab per require with its full source, but the collections page row and
  the viewer's details panel still don't expose require state. Add a
  count badge / chip per collections-page row ("3 requires") and a sub-
  list in the viewer details panel showing each require's URL, size,
  and loadedAt.
- **SRI hash validation.** Tampermonkey honors
  `@require <url>#sha256=…` (and `md5/sha1/sha384/sha512`); we parse
  the URL through resolveScriptResource verbatim and never check the
  fragment. Either validate post-fetch and reject on mismatch, or
  document explicitly that the hash is informational.
- **Absolute `file://` URLs in `@require`.** Tampermonkey supports
  these; SourceMonkey rejects them, sharing the rule with `@icon`
  (the extension holds `file:///*` host permission, so an HTTP-
  sourced script could otherwise read arbitrary host files). Decide
  whether to allow absolute `file://` requires when the host script
  is itself file://-loaded — that's the case where the user clearly
  trusts the local filesystem already. Today the relative-path
  resolution covers same-directory and subdirectory cases; this
  would unblock requiring a file in a sibling directory or under a
  user-supplied absolute path. Note the portable answer for that case
  now exists — see "Local file overrides" below — so this is only about
  TM-compatible *input*, not about the capability.

## Local file overrides — follow-ups

Shipped design in [docs/local-file-overrides.md](docs/local-file-overrides.md). Search
roots today: the host script's own folder, then the collection's own
root, then the global list from the options page.

- **Extra per-collection search roots.** A collection already searches
  its own root; a configurable per-collection list would let one
  directory of scripts also search somewhere the rest don't.
  `StoredCollection.localRoots?: string[]`, ordered implicit-folder →
  collection root → collection list → global.
  - Roots are absolute paths the user types, for the same reason
    collections are: `<input type="file">` gives no absolute path in
    Chrome, and `webkitdirectory` only gives relative ones, so a
    picker can't produce something storable across sessions.
- **Explicit per-file overrides.** A path the user names for one
  specific ref, stored as `StoredScript.fileOverrides?: {ref,
  localPath}[]`, offered from the details panel's dependency rows and
  from the install preview. Unlike the inferred forms these are safe
  for an http(s)-sourced host script too — naming the file IS the
  authorization — which is the case of developing against a script
  you already installed from the web.
- **Collections-page visibility.** A collection whose scripts are running on
  local stand-ins says so only in the viewer today. A per-row marker
  (or a count on the collection header) would make it visible from the
  list.
- **`@icon` stand-ins are not re-read within a page.** They're memoized
  for the page's lifetime (deliberately — see
  [docs/local-file-overrides.md](docs/local-file-overrides.md#icon-caching)),
  so editing an icon needs a reload where editing a `@require` doesn't.
  Fine today; revisit if icon iteration ever becomes a real workflow.

## Install capture — follow-ups

The shipped design and its known gaps live in
[docs/install-capture.md](docs/install-capture.md) (see its
**Limitations / future work** section — `Content-Disposition`
downloads, mixed-case suffixes, `@version` awareness). Only the items
that need doing *here* rather than describing there:

- **Say when `file://` capture is unavailable.** The capture covers
  local `.user.js` files, but only when the user has granted "Allow
  access to file URLs". With the grant missing nothing fires and
  nothing explains why. The options page should read
  `chrome.extension.isAllowedFileSchemeAccess()` and say so next to
  the capture toggle. The collections page already has a file-access
  banner slot to model it on.
- **Manual check: capture with file access OFF.** Chrome grants file
  access unconditionally to `--load-extension` builds (writing
  `allow_file_access: false` into Preferences does not override it),
  so the e2e suite can only ever exercise the ON case.
- **Widen the forge page-view list as needed.** `CODE_HOST_PAGE_VIEWS`
  (`install-capture.ts`) knows github / gitlab / bitbucket / codeberg.
  An unlisted forge's blob view is still captured; it costs one wasted
  fetch before the markup guard sends the user on to the page, so this
  is a polish item, not a correctness one.
- **Markup gate for `file://` manifests.** `fetchHttpText` rejects a
  markup response, so an http manifest that answers with a login page
  is named properly. The `file://` leg of `fetchManifestText` has no
  such check, and a directory read there surfaces as a `JSON.parse`
  complaint about `<`.

## Script preview — follow-ups

The preview (`userscript.html?preview=<url>`) is where a captured
`.user.js` click and a single-script Add Collection both land. See
[docs/script-viewer.md](docs/script-viewer.md#preview-mode).

- **Compare against the installed copy.** When the URL is already
  installed the banner prints both `@version` strings if they differ,
  and nothing else. It should say which is newer (`compareVersions`
  in `src/version-compare.ts`), and whether the
  bodies are identical at all — an unchanged body under a bumped
  version, or a changed body under the same version, are both worth
  saying out loud.
- **Diff view.** Follow-on from the comparison: a two-pane
  before/after per tab, so "what would Update actually change" is
  answerable without leaving the page. Applies to `@require` tabs too.
- **Preview a whole source.** Directory / manifest / github-dir adds
  still go straight to `addCollection`. Previewing a listing needs a
  different UI — a table of the scripts that would be added, with
  per-script drill-in — not the single-script layout.

## File loader — follow-ups

- Manifest query-string propagation. `resolveManifestEntryUrl`
  forwards an auth-bearing manifest query string (e.g. `?token=…`)
  onto same-origin entries, but `resolveScriptResource` doesn't —
  `new URL('icon.png', '…/foo.user.js?token=…')` strips the query.
  Fine for `@icon` and same-origin HTTP requires today, but a
  token-gated companion library reached via `@require` will 401.
  Port the same-origin propagation rule into `resolveScriptResource`.
- 0-byte handling. `fetchFileBytesXhr` rejects empty bodies (right
  for icons — a 0-byte image is useless, and right for `@require`
  too in practice — a 0-byte require is almost always a missing
  file). Worth revisiting if a real use case turns up; today the
  reject is uniform.
- Page http(s) reads hop to the service worker so a response's
  `Link: rel=preload` header can't be applied to an extension page
  (`src/http-read.ts`, and
  [docs/logging.md](docs/logging.md#keeping-the-errors-panel-clean)).
  Two loose ends: the hop falls back to fetching in the page when the
  worker can't be reached, which reopens the leak for that request;
  and the `acceptContentType` predicate now runs after the body has
  been downloaded, since a function can't cross the message boundary.
  Passing a serializable content-type rule instead would restore the
  early reject.
- Surface failed / blocked file loads. Today every failure mode in
  `resolveScriptResource` + `fetchResourceBytes` for `@icon` is
  silent (the corresponding `@require` path correctly flips the
  script to status: 'error' with a message, so the user sees it).
  Consider an `iconError?: string` field on `StoredScript` so the
  viewer can surface a rejected `@icon ../secret.png` in the
  details panel.

## Local directory collections — follow-ups

- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
- Editing path: if we ever want in-app edits, we'll need either FSA
  handles (re-introduces per-session re-grant) or a Native Messaging
  helper. `file://` URLs are read-only from the extension side.
- **Identity across a file that bounces.** A refresh now drops a script
  the scan no longer reports, and the row's UUID goes with it — so a
  file that vanishes and comes back (branch switch, an editor that saves
  by unlink+rename, a sync client rewriting in place) returns as a fresh
  row: `enabled: true`, empty Log, and its `gmval:` values orphaned
  rather than restored (`gm-values.ts` deliberately keeps them for
  exactly that restore). Remembering `relativePath → id` for recently
  dropped rows on the collection row would close it; the cost is a
  tombstone list to bound and expire, which is what we just got rid of.

## Missing script functionality

- (nothing outstanding — `@grant window.onurlchange`, `window.close`,
  and `window.focus` shipped; see the `GM_*` deferred-surface section
  above for what's left)

## Per-script log follow-ups

Every failure the UI surfaces now lands in the script's Log (see
[docs/script-log.md](docs/script-log.md#every-surfaced-failure-lands-in-the-log)).
Rough edges left:

- **The `loglevel:` sentinel is monotonic within one version.** A
  script whose own code hit WARNING/ERROR keeps that badge until the
  log is cleared or a refresh loads new content.
  - Load-state transitions (REFRESH FAILED, INVALID, REJECTED,
    OUTDATED…) don't feed it: they carry a `state` on the log entry and
    are badged by the row, which clears on recovery.
  - `Loaded new content` resets it, which covers the edit-and-retry
    loop. What's left is a script that keeps running the same code,
    where "sticky until cleared" is the intended meaning.
  - A second tab still running the old version undoes the reset with
    its next error, and reloading it doesn't reset again. Tagging
    runtime reports with the content hash they ran under would let the
    sentinel ignore reports from a superseded version.
  - Siblings that changed on disk during an add-to-existing-container
    pass get neither a `Loaded new content` row nor a reset (that path
    bypasses `emitScriptOutcomeLog`) — same gap as the missing recovery
    rows noted below.
- **Poll noise still fills the cap.** The reload fast-path runs in
  `manual` mode for every matched script on every tab reload, so
  ordinary browsing appends `Checked for updates — no change` per
  script per reload — and two rows for a script that is still failing.
  Dropping the row for non-user-initiated checks would fix it; the
  blocker is that `manual` currently means "not rate-limited", not
  "the user clicked", so the fast-path can't be told apart from a
  Refresh click.
- **`refreshAllCollections` uses `Promise.all`**, so one collection throwing
  rejects the whole batch — contradicting its own docstring, which
  claims a failed collection doesn't take the rest down. `allSettled`
  would make the doc true; the updater currently compensates by
  fanning the throw out to every script.
- **The add-to-existing-container path emits no recovery rows.** It
  refreshes every sibling but only restates load failures, so a
  sibling that recovered during that refresh never logs it (and the
  next refresh compares against the already-healthy row). Sharing
  `summarizeCollectionOutcome` would fix it, but that lives in
  `script-updater.ts`, which imports `script-store.ts`.

## Registration rejections — follow-ups

REJECTED is in (see
[docs/injection.md](docs/injection.md#rejected-registrations)): a script
Chrome refuses shows the state, keeps the reason in its Log, and clears
itself once a sync places it. What's missing:

- **The match-pattern check is narrower than Chrome's parser.**
  `matchPatternProblem` (`src/url-match.ts`) covers the shapes Chrome
  names — no path, bad scheme, empty host, a host holding characters no
  hostname can, misplaced host wildcard — and stops there, because a
  false positive would drop a pattern that works. A malformed port and
  anything Chrome tightens next still land as REJECTED (a port out of
  range, say — `https://host:65536/*` passes our check and Chrome
  refuses it). Widening it means owning more of a grammar that drifts,
  so each addition wants a probe against a real Chrome first (the one
  in `tests/e2e/rejected-registration.spec.ts`'s header is the record
  of the last such run).
- **Two Chrome-refused shapes are left unread.** The scheme-less and
  scheme-glob shapes are now rewritten into Chrome's spelling
  (`canonicalMatchPatterns`, see
  [docs/matching.md](docs/matching.md#lenient-readings-canonicalmatchpatterns)),
  which took the corpus from 1,035 refused patterns / 81 dead scripts
  down to 158 / 34. What still fails, and why neither is as clear-cut:
    - **A bare origin, no path** (92 patterns: `https://example.com`,
      `zombs.io`). Chrome says "Empty path". The reading is either
      "that one page" or "the whole host", and the two differ — TM
      matches the exact URL. Probe TM before picking.
    - **A `*` in the middle of a host** (62: `*://*brainly.com/*`,
      `https://video.sina.*/*`). Chrome's host wildcard is only the
      whole host or its first label, so a TLD glob or a bare prefix
      has no Chrome spelling at all. Registering `<all_urls>` and
      deciding in the prelude is the only route, and it means giving
      the script every page in exchange.
  `pnpm run test:e2e:tm` drives a real TM, which is where "what does TM
  run for this" gets answered.
- **The install preview doesn't show parse-time warnings.**
  `checkPreviewSource` builds the row and reports header errors and
  syntax errors, but drops `startupLogs` — so an unsupported `@grant`
  or a dropped `@match` is only visible after installing.
- **Registration has no single owner across contexts.** The lock in
  `src/injector.ts` serializes registration work within one JS context,
  but the collections page and the viewer call
  `retryRejectedRegistrations` in theirs, so a page-side registration
  can still land in the middle of the SW's sync. `placeSpec` makes that
  survivable (the id is placed either way, not reported as a duplicate)
  and the end state converges, but the fix in principle is for the SW to
  be the only context that touches `chrome.userScripts` — which needs a
  page→SW message channel that doesn't exist yet
  (`chrome.runtime.onMessage` has no listener in `background.ts`;
  pages coordinate with the SW through storage today).
  - It costs more than tidiness now that the sync is incremental: the
    SW's record of the registration set can't see what a page placed,
    so the sync pays a wrong-guess round trip per such id until it
    re-places one itself. Removals already refuse to trust the record
    for exactly this reason.
- **A row that dodged the parse check waits for a full reconcile.**
  An incremental sync runs `revalidateCandidates` over the rows in its
  scope; the old full rebuild re-checked the whole library on every
  sync. So a row stored `ok` with no verdict — written before the check
  existed, or while it was failing open — keeps its registration until
  something writes it or the worker restarts. Bounded, because the
  checker's circuit breaker never re-arms within a worker's life, so a
  recovered check always means a new worker and therefore a full
  reconcile. Closing it properly means a cheap way to ask "are there
  any ungated rows?" without reading them all.
- **The targeted retry skips the parse gate.**
  `retryRejectedRegistrations` re-offers a spec without running
  `revalidateCandidates`, so a row whose compile verdict is missing or
  stale can reach `chrome.userScripts.register` through it. Narrow — it
  only ever re-offers rows already stored `ok` and eligible, and the
  next sync re-checks them — but it is the one registering path the
  gate doesn't cover. Adding it there means running the parse check
  from an extension PAGE, where `chrome.offscreen` isn't available and
  the check fails open, so it needs the page→SW channel above rather
  than a call in place.
- **A no-`@match` script is registered on every page.**
  Chrome ORs `includeGlobs` with `matches` (measured — see
  [docs/injection.md](docs/injection.md#how-chrome-reads-includeglobs)),
  so `matches: ['<all_urls>']` can't be narrowed by the globs beside
  it, and the wrapper's in-page matcher is what holds an `@include`-only
  script to its header. Correct, but it costs a wrapper run on every
  page such a script's collection is enabled for. Narrowing it means
  translating globs into `@match` patterns where they convert, and
  falling back to `<all_urls>` only for the ones that don't.
- **The message is Chrome's, so it speaks Chrome's coordinates.**
  `matches[1]: Invalid port` counts within the spec we built, not the
  lines of the file. Deliberate — the alternative is inventing a
  mapping that could point at the wrong tag — but it means REJECTED is
  the one user-visible verdict with no clickable location.

## Log and error message quality

The Source labels are written for users (`manual-refresh`,
`extension-startup`, `script-wrapper` — see
[docs/script-log.md](docs/script-log.md#source-labels)), and both the
**script validation** messages and the ones reporting on the
extension's **own machinery** have now had the same pass (the rules
they follow are in
[docs/diagnostics.md](docs/diagnostics.md#wording)). What's left:

- **`handleXhrStart` fails silently when it can't identify the tab.**
  `background.ts` returns without sending anything, so the calling
  script dangles until the page-side 5-minute TTL fires and reports a
  timeout — a misleading account of what happened. The other two GM
  handlers with the same guard reply with `NO_ORIGINATOR_TAB`; this one
  can't, because the reply path it would use *is* the tab. Needs a
  different route, not a different string.
- **`sm:abandoned` has no real reasons to report.** The Log row says
  `Did not run on this page (<reason>)`, but the SW's
  `{action: 'skip', reason}` branch is unused, so the only value that
  reaches it is the wrapper's own `"skip"` fallback. Either give the
  skip decision real reasons or drop the parenthetical.
- **The version-probe rows keep their own wording.**
  `version-probe-fetch.ts` still says `no metadata block` where the
  viewer now says `No // ==UserScript== metadata block, so this is not a
  userscript`. Deliberate — `probe.error` renders as a value in a
  definition-list cell (`script-details.ts`), beside `could not fetch`
  and `no @version`, so a full message doesn't fit. Revisit if that row
  ever gets room, or if the split starts confusing people.
  - Same condition covers `fetchResourceText`, which still returns
    `string | null`: the bytes fetcher knows which failure it was, and
    the probe is the only caller that throws that away.
  - A probe URL that answers with a web page is the same story: nothing
    on that path applies the markup gate (`markup-response.ts`), so a
    login wall reads as `no @version` rather than as a page. Worth
    folding in whenever the row's wording is revisited.

## Testing and example TODOs

- **Chromium segfaults on shutdown.** A full run can finish with every
  test passing and still exit 139: the browser dies during teardown,
  after the last assertion. Seen once in six runs since registration
  work was serialized — the earlier, more damaging form (the worker
  dying mid-run, so the next test reported a 0ms failure it never ran)
  has not recurred.
  - Invisible in the reporter: stats read 0 unexpected, 0 flaky. Only
    the process exit code shows it, which is what CI would gate on.
  - Check `echo $?` after a run, not just the summary.

- API explorer page with forms to call any GM API with any args
- examples for all supported GM APIs, all headers
- examples for injection scenarios - main world vs userscript world, etc
- examples with absolute (TM-compatible) vs relative paths

## Feature TODOs and ideas

### Collections page

- control to view by file/url location or by name
- sort by name or location
- filtered view
- collapse a collection
- smoother add collection/script flow, maybe a dialog box

### Page status menu / widget

- status widget instead of context menu for running scripts
- enable / disable a script on that page
- choose which version of a script to use

### Other

- auto-reload any page if scripts on it have updated (maybe just for manual focused refresh, and do double-refresh if a new script is discovered but not ready)
  - the detection half shipped: switching to a tab re-checks its local
    scripts, so the new body is ready and the badge is purple before
    the user reloads — see
    [docs/updates.md](docs/updates.md#focus-triggered-refresh). What's
    left is doing the reload for them.
- relative paths for dev, absolute paths for release (for requires & resources)
- ~~download a script to local disk for editing / debugging~~ — shipped
  as **Local copy…** ([docs/local-copy.md](docs/local-copy.md)); what's
  left is destinations outside Downloads.
- keep links between local and remote version of a script, select which
  to run. (The *reporting* half shipped — see
  [docs/updates.md](docs/updates.md); picking a different copy to run
  is what's left.)
- `@updateURL` as a bandwidth optimization: fetch the small `.meta.js`
  first and skip the body fetch when the version hasn't moved. Probing
  already fetches it for the OUTDATED status, but the two paths are
  separate — the refresh still does its own conditional GET. Worth
  little for hosts that return ETags; worth more for a large script on
  a host that doesn't.
- surface `GM_download` / `GM_openInTab` in the details panel. The
  panel dropped the `@grant` row on the grounds that `@connect` already
  carries the network story and the rest of the GM surface acts within
  the page's own reach — but these two are the exception: they reach
  the user's download directory and any URL respectively, and neither
  is `@connect`-gated. A `@grant` row for those two names alone would
  be noise-free, but it needs a wording that reads as a capability
  rather than a tag dump.
- large collections still blow past `chrome.storage.local` (and RAM). The
  refresh fan-out is bounded now (`src/concurrency.ts`), but the whole
  result set — every script body, plus prefetched `@require` /
  `@resource` payloads — is still held live and then written in one
  `set`. Open pieces:
  - No `unlimitedStorage` permission, so the whole extension shares a
    10 MB `storage.local` budget. Decide between taking the permission
    and moving bodies out of `storage.local`.
  - Reporting the failure is done (`src/refresh-error.ts`) — what's
    left is not hitting it. The user still has to work out for
    themselves that one enormous collection is what filled the budget;
    the banner names total usage, not the collection responsible. A
    per-collection size figure would point straight at the culprit, and
    needs a cheap way to measure one collection's share.
  - No cap on scripts per collection; a directory of a few thousand is
    accepted silently and then fails late.
  - Other unbounded `Promise.all` fan-outs on the same
    thousands-of-scripts path, all of them storage writes rather than
    fetches (so lighter per item, but still one-per-script):
    `emitInitialLoadLog` over a freshly added collection
    (`src/script-store.ts`), and the boot log replay in
    `src/script-updater.ts`. Both want `mapWithConcurrency`.
- a collection whose refresh drops its LAST script says nothing about it.
  The tombstone rows the collections page leaves for dropped scripts
  (`docs/storage.md`, "Tombstones") hang off the script table, and a
  collection with no scripts left shows the "no scripts" message
  instead — so the one case where the whole table emptied out is the one
  case with no explanation on screen. Wants the empty message to carry
  the reason when the refresh that emptied it is the one being shown
  ("the last refresh removed the scripts this collection had"), which
  means the message needs to know what the refresh just did rather than
  only what is stored now. Only reachable for a manifest collection: a
  directory that scans completely empty marks its rows `missing` rather
  than dropping them.
