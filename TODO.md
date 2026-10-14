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

- Frames follow-ups (see [docs/frames.md](docs/frames.md)):
  - Frames with no URL of their own (`about:blank`, `srcdoc`) get no
    injection: `chrome.userScripts` has no `matchOriginAsFallback`.
    Revisit if Chrome adds it.
  - Removing an iframe sends no event, so the badge can count a run in
    a removed frame until the popup opens or another frame navigates.
  - For `about:blank` / `srcdoc` frames: no match pattern reaches them
    (not even `<all_urls>`), so registration can't. The supported route
    would be on-request injection: watch for such frames and run the
    scripts matching their parent's URL in them with
    `chrome.userScripts.execute` (`documentIds`), as manual runs already
    do for the top frame. Check first that Chrome allows `execute` into
    these frames; only worth it if real scripts need it.
  - Reload fast path for frames: let a frame's check-pending use the
    tab's fast-path entry, so frames (and frame-only scripts) run the
    edited copy on the reload too.
  - A command registered in several frames shows once per frame, with
    nothing to tell them apart. Label it with the frame's host if a real
    script needs it.
  - Every frame's copy asks the worker whether to run
    (`sm:check-pending`) on the document-start path. Fine at normal frame
    counts; a page with dozens of matching frames pays it per frame.
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
  - Hard ceiling either way: the prelude's own 10s `awaitDecision`
    timeout, measured from when the wrapper asked. A window that
    outlives it gets a reply nobody is listening for, and the entry is
    already marked consumed. Leave real margin.
- `@run-at document-start` isn't guaranteed to run before page scripts.
  - The body waits for the async `sm:check-pending` reply, while the
    parser can run the page's early `<head>` scripts. The extension
    usually wins (~1-5ms reply). In a browser sm-dev is connected to,
    every script asks outside the run's own tabs, and often loses (a
    documented caveat in harness-guide.md).
  - Tampermonkey users expect it to run first: scripts that hook
    `fetch`, `XMLHttpRequest` or `addEventListener` miss page code
    otherwise.
  - Plan: `document-start` scripts don't wait for the reply at all;
    they run the registered body immediately.
    - The fast-path swap is given up for them. The reload's own
      `setupReloadFastPath` still refreshes in the background, and the
      badge flips to RELOAD when an update lands, so an edit is picked
      up on the second reload. (For local files the focus-triggered
      refresh usually registers it before the first.)
    - The other use of the reply, the "Reload with no userscripts"
      `skip`, needs a synchronous channel instead: when arming the
      marker, write a flag into the tab's `sessionStorage` before
      reloading, and have the wrapper read and clear it at
      `document-start`. Check subframes (other origins have their own
      `sessionStorage`) and pages that block storage.
    - The sm-dev markers (sm-dev-design.md, Making wrappers ask) would
      go too, so update harness-guide.md, sm-dev-design.md and
      injection.md (Concurrent gates).
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

- **The ungranted-`unsafeWindow` scan doesn't read `@require` bodies.**
  `sourceUsesUnsafeWindow` (`src/unsafe-window-use.ts`) looks at the
  script's own body only, so a script whose reference lives entirely in
  a library still lands in the isolated world with no binding. The
  requires arrive on a later pipeline step (`attachFiles`) than the flag
  is derived on, and a require refresh would have to re-derive it.
  - The scan also has no regex-literal state, so a `/['"]/` opens a
    string, and a literal ending in `\/\/` reads as a line comment;
    either can swallow a later reference. Normally that just leaves the
    script behaving as it did before the feature. The one bad case is a
    swallowed *declaration* with a visible use after it: the script then
    moves to MAIN world for a binding it shadows anyway. No corpus script
    hits it; a real tokenizer (or the one the parse check already has in
    its sandbox) would close it.

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

## `document-start` that really runs first

A `document-start` body runs ahead of the page's own scripts only when
the wrapper can skip the async check-pending round trip (see
[docs/injection.md](docs/injection.md#skipping-the-check-at-document-start)).
Where it can't, an early inline `<head>` script can still win the race.

- **Not consistent.** The same script runs first or not depending on:
  - whether the load is a reload;
  - whether it grants GM storage, or has a `.tld` rule;
  - whether it is in a subframe;
  - whether sm-dev is connected to the browser, outside the run's own
    tabs.
- **Not robust.** The cases that still ask are a timing race, so a
  script that must patch the page first (user-agent spoofing, API
  hooks) works on some loads and not others.
- **Worth finding something else** that makes a `document-start` body
  really run at document start in every case. Ideas, none evaluated:
  - Make the decisions available synchronously, e.g. the GM values
    snapshot from an in-page cache, and per-tab state (skip reload,
    sm-dev claim) from something the wrapper can read without asking.
  - Run the body first and apply a late `skip` / `run-new` some other
    way, accepting that a skipped body has already run.
  - A per-script opt-in that always runs immediately, for scripts
    that need it more than the reload swap or the skip reload.

## Reload fast-path — remaining cost

The window is measured (see
[docs/diagnostics.md](docs/diagnostics.md#measuring-a-missed-reload-swap)),
and the dominant costs are gone: the slowest per-script check is 181 ms
of a 500 ms budget, the decision lands at ~243 ms. What remains:

- **`getKeys()` itself costs ~40 ms** on a 266-row namespace, paid
  inside the window by a storage-granting script's first load after a
  worker start. Later loads come from the value store's memory
  (`src/extension/value-store.ts`).
- **The script-row scans are gone from the worker**: the match index,
  registration sync, log labels and sticky numbers read the row cache,
  loaded once per worker start (77–93 ms for 344 rows).
- **Reload checks were slower in a real profile than in the test
  browser.** Before page-load checks read known paths, one reload check
  of a script with two stand-ins measured `stat 38ms` for a 2-file
  folder and `read-script 22ms`, against about 5 ms and 2 ms in the test
  browser, with nothing else running in the worker. The same reads from
  the worker's console took 2 ms. Not explained yet:
  - an earlier check measured `read-script 125ms` and `write 84ms` on a
    reload, against 13 ms and 12 ms on a focus check of the same
    script; `write` there is mostly waiting for the store's lock;
  - worth re-measuring now that a page load lists no folders.
- **Known stand-ins are read and hashed on every page load.** Checking
  size + modified time first (a `HEAD` gives `Last-Modified`, not the
  size) could reuse the stored bytes, as the script file's skip does.
  Each read is about 2 ms, so only worth it for large libraries.
- **A script with a UTF-8 BOM never takes the size+mtime skip.** The
  stored `size` is the decoded text's byte length (BOM dropped), the
  listing and the direct read report the file's, so they differ by 3
  and every check rebuilds. Recording the file's byte length on the
  rebuild path would fix it.
- **A script's `@require` / `@resource` loads all start at once.**
  Unbounded per script (the entries around them are bounded), and they
  keep going after one fails. Fine for local files; a script with many
  CDN requires would fetch them all at once.
- **The searching checks still list roots one after another.** Focus
  checks and Refresh stop at the first root with the file, but a miss
  lists each root in turn. Listing them all at once would cost more
  reads on a hit; only worth it if a miss shows up in measurements.
- **`build-specs` costs ~320 ms on the sync right after a swap**, 2 ms
  on the next. That is the deferred parse check landing in
  `revalidateCandidates` — expected, and off the user-visible path, but
  it means the fresh body is re-registered a beat later than the log
  suggests.

## Parse check — follow-ups

The compile-only check is in (see
[docs/parse-check.md](docs/parse-check.md)). What it doesn't do yet:

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
- **Don't fetch dependencies twice on install-from-preview.** The
  preview fills `previewFetchCache` to run its check; clicking Install
  then runs `addCollection` → `attachFiles` against the store's own cache,
  so every `@require` / `@resource` is fetched again. Bridging the two
  caches (or handing the preview's typed entries to the install) would
  halve the third-party traffic that eager fetching introduced.

## GreasyFork corpus findings

Running the install-time checks over the top-2000 GreasyFork scripts
(`validate-corpus.mjs`, see
[docs/corpus-validation.md](docs/corpus-validation.md)) turns
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

## Corpus test findings — compatibility gaps

Gaps that made corpus scripts fail on their live sites (see
`tests/greasyfork-examples/`; `record-results.mjs list --tag T` finds
the scripts). Comparisons are against Violentmonkey's source; Tampermonkey
wasn't checked.

- **Granted `GM_*` names are `const`** (`gm-reassign`: 2129, 2128,
  419798, 438053, 2130).
  - A shim like `GM_xmlhttpRequest = GM.xmlHttpRequest;` throws
    "Assignment to constant variable" at startup.
  - VM resolves names through `with(this)` over a wrapper, so the
    assignment works. Granted scripts now do too, since they run in
    the page with a sandbox `window` holding the names; this is left
    for scripts that ask to be isolated. Fix there: declare them with
    `let`.
  - About 50 corpus files assign to a `GM_*` name; some are guarded.
- **Follow-ups from the page-world default** (docs/injection.md, "Costs
  of running in MAIN"):
  - The channel key keeps the page off the bridge and away from our
    runtime, but a page that targets SourceMonkey can still hook
    built-ins we haven't captured, and methods on a script's own values
    (a `toJSON`, an `Array.prototype` method the storage codec calls),
    and see values passing through (docs/injection.md, "What it doesn't
    stop").
    - `GM_xmlhttpRequest`'s request and response are covered (the one
      path where the page could see what it couldn't read itself).
    - The rest: storage values through the codec, `GM_addElement`'s
      DOM calls, the transport's other messages (their payloads still
      inherit `Object.prototype`, so its `toJSON` sees them), menu and
      notification plumbing.
    - Closing it fully means VM-style safe built-ins throughout the
      MAIN-world runtime and prelude (docs/GM-API-strategy.md, section
      3). Low priority: a page that does this can as easily hook the
      built-ins a script's own code calls on the same values, which
      scripts don't guard against either.
  - Any installed userscript reaches the registry (`__smReg` is in its
    scope), so a page-world script can call the runtime as a sibling
    script on the same page. Per-script keys would stop that.
  - No CSP exemption for a MAIN-world `GM_addStyle` / `GM_addElement`
    into a closed shadow root, another frame's document or a detached
    parent; the runtime inserts those itself (docs/GM-APIs.md).
  - Page code can tamper with the built-ins a granted page-world
    script uses itself (docs/GM-API-strategy.md, section 3, decided
    against VM's safe-builtins when granted scripts ran isolated).
- **`GM_cookie`** (463802) is the whole failure for a Reddit script.
  See "GM_* APIs not yet in the catalog".

The next items were checked against Tampermonkey 5.5.0 and
Violentmonkey 2.49.0 with a throwaway `tests/examples/` probe script
(2026-10-04).

- **`GM_setClipboard` ignores its callback** (`setclipboard-callback`:
  483847).
  - TM documents `GM_setClipboard(data, info, cb)`; the binding in
    `src/extension/gm-bindings.ts` takes `(text, type)`, so the
    script's "copied" toast never shows. Fix: call `cb` when the copy
    finishes.

The next items came from testing the oldest corpus scripts, checked
against Tampermonkey with `sm-dev --manager tm` probes (2026-10-05).

- **`unsafeWindow` and `GM_*` aren't properties of `window`/`self`
  in the isolated world** (`unsafewindow-on-window`: 593, 4881, 4882,
  455261, 455855; `gm-on-window`: 456077, 455261, 455855).
  - Greasemonkey-era scripts test `if (this.unsafeWindow)` to pick
    their GM code path, newer ones `!!self.GM_registerMenuCommand`, and
    vite-plugin-monkey builds read every grant off `window` (456077
    throws `GM_getValue is not a function`). TM passes all of these.
  - Page-world scripts get them on their sandbox `window`, and these
    scripts now work (re-tested 2026-10-11); this is left for scripts
    that ask to be isolated.

The next items came from testing the 300 and then 400 oldest corpus
scripts, checked against Tampermonkey 5.5 with `sm-dev --manager tm`
(2026-10-06 and 2026-10-07).

- **`GM_openInTab` refuses `data:` URLs** (`openintab-data-url`:
  24924).
  - 24924 renders the page with html2canvas and opens the PNG as a
    `data:` URL. SourceMonkey logs "GM_openInTab: refusing non-http(s)
    URL data:image/png..."; TM opens the tab.
  - The refusal is deliberate (`isAllowedTabUrl` in
    `src/extension/gm-tab.ts`, documented in docs/GM-APIs.md).
    Possible fix: allow `data:` and `blob:` too, still refusing
    `file:`, `chrome:` and `chrome-extension:`.
- **`GM_registerMenuCommand` without a callback throws**
  (`menu-no-callback`: 406501).
  - 406501 calls `GM.registerMenuCommand("===== START =====")` with
    only a name, using the item as a visual divider.
    `src/wrapper-gm-runtime.js` throws "callback must be a function",
    which stops the whole script.
  - TM documents the callback as required and has no divider form,
    but it doesn't throw: under `--manager tm` the script ran past
    those calls. What TM's menu shows for such an item, and what
    clicking it does, wasn't checked.
  - A copy with `function(){}` added works. Fix: accept a missing
    callback and register an item that does nothing; probe TM's menu
    first to match how it shows them.
- **`@match https://site/X/*` also runs on `https://site/X`**
  (seen on 410968).
  - Chrome's match patterns treat a path ending in `/*` as also
    matching the path without it. A script with only `@match` rules
    goes to Chrome as-is and gets no recheck in the prelude
    (`src/userscript-prelude.js`, the "matcher" block), so it runs
    there. TM doesn't.
  - Reproduced with a probe on `https://example.com/zzz`. sm-dev's
    own matcher (`explainMatch`) prints "skipped" for the URL, then
    the script starts anyway.
  - Fix ideas: register `/X/*` with an `excludeGlobs` entry for
    `/X`, or send these scripts through the prelude recheck.

The next items came from sweeping the last untested valid corpus
scripts, checked against Tampermonkey 5.5.1 with `sm-dev --manager tm`
(2026-10-10).

- **Unhandled rejections aren't reported after `document.write()`**
  (seen on 437625).
  - A `@run-at document-start` script that calls `document.write()`
    and then throws in a promise gets no `threw` report and nothing
    in the console. The same throw without the `document.write()` is
    reported.
  - Likely cause: the implicit `document.open()` drops the
    `unhandledrejection` listener the prelude adds to `window`
    (`src/userscript-prelude.js`). Diagnostics only.
- **`GM_unregisterMenuCommand(caption)` doesn't remove the command**
  (seen on 420475).
  - 420475 unregisters by the caption, not the id
    `GM_registerMenuCommand` returned, so each pause toggle adds a
    menu entry.
  - VM (2.48 source) keys commands by `options.id || caption` and
    returns that key, so its id is normally the caption; its
    unregister also falls back to a caption match. A script tested
    under VM can't tell the two apart.
  - TM documents only the id. What TM does with a caption isn't
    checked: probe it before deciding.
  - Fix, if we follow VM: when the argument matches no id, remove
    this script's commands with that caption.
- **Registering the same caption again adds a second menu entry**
  (seen on 381682 and 477154, h5player).
  - Both re-register their commands with the same captions and never
    unregister, so `menu` lists each one twice (M1-M6, then the same
    as M7-M12). Cosmetic: either copy runs the command.
  - The script's comments say it relies on the manager merging
    commands with the same caption.
  - Both managers merge them:
    - VM keys commands by `options.id || caption` (see the item above),
      so a repeat replaces the first. VM 2.49 (probed 2026-10-13, as
      for TM below) returns `"Same caption"` from both calls, lists it
      once, runs the later callback, and unregistering either id
      removes it entirely: nothing older comes back.
    - TM 5.5 (probed 2026-10-13: the same caption registered twice,
      then TM's popup read with sm-dev) lists the caption once, and
      clicking it runs the later callback. It still returns a new id
      for each call (1, 2, 3).
    - TM keeps both underneath. Unregistering the newer id brings the
      older entry back (clicking runs the first callback); unregistering
      the older id leaves the newer one shown.
  - The managers differ only after an unregister. A script written
    for VM never sees two ids for one caption, so following TM loses
    nothing there.
  - Fix, to match TM: in `src/extension/gm-menu.ts`, keep every
    registration with its own id, but show only the newest of this
    script's commands with a given caption in the same document.
    Unregistering by id removes just that one, so an older one with the
    caption shows again.
- **Unconfirmed: a frame script skipped by the 10 s decision timeout**
  (seen on 446887, Nitro Type).
  - In a headed browser, after the script's own reloads, the race
    iframe's copy was skipped each time with "SourceMonkey did not
    answer whether to run it within 10 seconds"
    (`DECISION_TIMEOUT_MS` in `src/userscript-prelude.js`).
  - Each time the frame had shown nothing for about 30 s and the skip
    landed in the same millisecond as the top frame's start. That
    looks like a stalled renderer firing the timer on resume, before
    the answer it was about to receive. Headless reloads were fine.
  - If it repeats: measure the wait with a clock that excludes stalls,
    or recheck for a late answer before giving up.

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
- **`gm-info`'s stub `@require` / `@resource` / `@icon` refs are
  relative**, so when the script is installed by hand into TM/VM
  (rather than through the sync script's local server) TM reports a
  "forbidden URL" error in `GM_info.script.resources` and VM fails to
  fetch them. Once the repo is public, point them at raw GitHub URLs
  for `tests/examples/gm-info/{lib.js,resource.txt,icon.svg}` so the
  comparison shows a clean fetch under every manager.
- The known divergences to expect across managers are catalogued in
  [docs/supported-GM-APIs.md](docs/supported-GM-APIs.md) and
  [docs/supported-headers.md](docs/supported-headers.md).

## `GM_*` — deferred surface

- **Say which network failure stopped a request.** `fetch` gives the
  same bare "Failed to fetch" for a name that doesn't resolve, a refused
  or dropped connection, a TLS failure, a request another extension
  blocked, and an unsafe port, so `unreachableMessage` lists the causes.
  - `chrome.webRequest.onErrorOccurred` has the real `net::ERR_*` per
    request, but needs the `webRequest` permission, which the manifest
    doesn't have.
  - The message names the request's own host. When a redirect led to the
    dead host, it should name that one.

The Phase 1–10 work shipped the priority APIs; everything below is
either a follow-up gap, a tractable second-tier API, or a research
question. See [docs/supported-GM-APIs.md](docs/supported-GM-APIs.md)
for the current state of the per-API matrix and
[docs/GM-APIs.md](docs/GM-APIs.md) for implementation details.

### XHR header surgery — leftovers

The surgery itself shipped (`src/extension/gm-xhr-headers.ts`): forbidden
request headers, `Sec-Fetch-*` included, travel as a per-request
declarativeNetRequest session rule keyed on a URL-fragment tag, and our
extension `Origin` is removed by default. What's still open:

- **Defaults are unmeasured.** Only `Origin` removal is defaulted;
  `Sec-Fetch-*` is left alone unless a script asks. Whether to match
  Tampermonkey's defaults instead needs TM's actual wire headers,
  which `tests/examples/gm-xmlhttp/gm-xmlhttp-wire-headers.spec.ts`
  reports as a test attachment under the `tampermonkey` project
  (`SM_PRINT_WIRE_HEADERS=1` prints it; see `docs/testing.md`).
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

- **Large `GM_xmlhttpRequest` request bodies fail with Chrome's
  message.** A non-text body goes to the worker as base64 in one
  message, so past roughly 45 MB it hits Chrome's 64 MiB message limit
  and the script gets "Message length exceeded maximum allowed length",
  without our prefix or a fix. Send big bodies in pieces, as responses
  come back, or at least say what the limit is.
- **Value sequence numbers after a backward clock step.** The value
  store starts its counter from `Date.now()` (`src/extension/value-store.ts`).
  If the clock steps back by more than an earlier worker's lifetime,
  open documents hold numbers above the new worker's and drop its
  updates for those keys until they navigate (resync can't repair
  it either). Fix: keep a high-water mark in `chrome.storage.session`
  and start from the larger of the two.
- **A value write can race a wipe.** `wipeValues` lists a script's
  rows, then removes them; a write landing in between saves a key that
  the removal then deletes from disk, while the store's map keeps it.
  The only caller removes an sm-dev run's collection, so it's low
  impact. Fix: hold new saves for the script until the wipe finishes.
- **sm-dev runs never use the back/forward cache.** Playwright turns
  it off in every browser it launches, sm-dev's included, so a page a
  script runs on is never restored from it, as it often is in Chrome.
  `launchExtensionBrowser` takes `backForwardCache` to keep it; sm-dev
  could do so by default, after checking how its tab tracking copes
  (Playwright's own `goBack` loses a restored page).
- **Coalesce value writes per task** if a script floods the worker:
  writes spread across `await`s or animation frames are a message
  and a broadcast each (docs/GM-APIs-storage.md, "Sending writes").

- **Menu commands vanish on a bfcache restore.** `src/extension/gm-menu.ts`
  holds ONE document's commands per tab, so leaving a page drops its
  registrations — and Chrome doesn't re-inject on back/forward, so
  nothing re-registers them. The restored page's callbacks are still
  alive in its document; only the SW-side mirror is gone, and its
  popup rows stay missing until a real document load.
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
  `src/extension/offscreen.ts`, built for the parse check) and the `offscreen`
  permission is declared — MV3 allows only ONE per extension, so
  EXTEND that host rather than adding a second. Needs
  `clipboardWrite` in the manifest and `CLIPBOARD` added to the
  `reasons` array in `parse-check.ts`, which is fixed at creation
  time.
- **`window.close` / `window.focus` failures are filed under the
  first granting script** in the isolated world (a page-world script
  has its own override). The override closes over the scriptId of
  whichever script installed it, so a sibling script's refused close
  lands on the wrong Log tab. Cosmetic, and it disappears with
  per-script worlds (below).
- **`window.*` grant scope is per-document-and-world.** Once any
  script on a page grants `window.onurlchange`, the `urlchange`
  surface exists on that world's shared `window`, so a sibling script
  in the same world that did NOT grant it can also feature-detect and
  subscribe. In the isolated world, `@grant window.close` /
  `window.focus` leak the same way: their overrides replace the
  methods on that same shared `window`. (A page-world script's
  overrides go on its own sandbox `window`, as TM does.) Same
  shared-realm root cause as the storage-spoofing entry below; a real
  fix needs per-script worlds.
  - In MAIN world the shared `window` is the **page's**, so the page
    sees `urlchange` too: it can subscribe to it. It could go on the
    sandbox `window`, where the `window.close` override is.
- **`window.*` reload-fast-path coverage.** The stated reason the
  `urlchange.enable` and `windowControl.enable` / `.make` calls live
  in the
  emitter's `js` (rather than `prelude`) is that a hot-swapped body
  still needs the surface. Only the emitted string's position is
  asserted today; an e2e driving the run-new swap with these grants
  would make the rationale load-bearing. `resource.init` sits in `js`
  for the same reason and now has that e2e
  (`reload-fast-path.spec.ts`), so these are the eager calls whose
  swap behaviour is unasserted.
- **Send the remaining GM pushes to the requesting frame.** Scripts run
  in frames now, but `sm:gm-tab-closed` and `sm:gm-notification-event`
  still go to the whole tab (`chrome.tabs.sendMessage` with no frame;
  `background.ts`). Menu fires and XHR events already go to their
  document or frame.
  - Nothing misfires: each frame's copy drops a request id it doesn't
    know.
  - But any frame where the bridge (`wrapper-bridge.js`) runs relays
    the push into its page, so another frame's page can see a
    page-world script's request id and event.
  - Fix: keep the requesting document with the request, as menu
    commands do, and send to it.
  - `sm:gm-value-update` going to all of a tab's frames is right: each
    frame's copy needs the write.
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
- **Bridge gate vs. matcher divergence.** `bridgeMayActAs` re-runs
  our own `url-match.ts` against the sender's URL, while Chrome
  decided whether to inject with its matcher. A disagreement refuses
  a legitimate script — fatal for a storage-granting one — but loudly
  (a Log line), and the badge depends on the same agreement.
  - The recheck can't be dropped: the SW can't observe which scripts
    Chrome injected, and a MAIN-world script's own report arrives
    over the page-forgeable bridge. Keying off the tab's `expected`
    set uses the same matcher; a per-document token isn't a secret in
    MAIN world.
  - The divergence-proof fix is a USER_SCRIPT-world *witness*
    registered with each MAIN-world GM script's own patterns,
    reporting "X is here" over trusted `chrome.runtime`. Costs a
    registration per script and a document-start race the SW would
    hold early requests for.
  - Do it only if divergence shows up in practice; a matcher bug is
    the cheaper fix.
- **Bridge gate and push stamping read the stored world, not the
  live one.** `scriptWorld` / `bridgeMayActAs` answer from the current
  row, but a document that loaded before an edit flipped the script's
  world keeps running the old one until reload. USER_SCRIPT → MAIN:
  the open isolated document's pushes are stamped MAIN and re-posted
  into the page until reload. MAIN → USER_SCRIPT: the open MAIN
  document's bridged calls are refused. Both self-heal on reload; the
  per-document token above would fix both.
- **The bridge gate can lag a grant-adding edit by one navigation.**
  `scriptGrantsSubsystem` answers from the match-index cache, which
  learns about a refreshed row through storage's `onChanged` — after
  the refresh that `handleCheckPending` just ran. A MAIN-world script
  whose refresh added its first storage grant (with another
  runtime-backed grant already there, so `needsRuntime` doesn't fall
  back) can be refused its snapshot on that one navigation: `run-new`
  with `seedValues` and no `gmValues`, so the previous version runs
  with a console line. Self-heals on reload. Either await the cache's
  own update in the handler, or pin it with an e2e in
  `reload-fast-path.spec.ts` (the "adds a storage grant" case there is
  USER_SCRIPT-world).
- **The hidden-tab flush skips the confirmation check.** `flushAll`
  passes `"pagehide"` for `visibilitychange → hidden` too, so in MAIN
  world a merely-backgrounded tab's flush goes fire-and-forget and the
  "storage flush not confirmed" line is never printed for it. Correct
  (the document may be going away), just one diagnostic less; a
  distinct reason would keep it.
- **A failed own-spec retry leaves its fingerprint recorded.**
  `runIncrementalSync` stores `nextScopes` before `applyPlan`; if an
  own spec is refused and `retryRefusedOwnSpecs` can't rebuild it, the
  fingerprint stays while `state.registered` lacks the id. Harmless
  while `alreadyPlaced` also requires presence, which is the clause
  carrying the invariant.
- **XHR `arraybuffer` takes twice its size on the page while built.**
  `finishXhrBody` (`src/wrapper-gm-runtime.js`) holds the pieces and
  the joined copy at once. With `total` known it could fill one
  `Uint8Array(total)` as pieces arrive. `blob` and `stream` don't copy.
- **No backpressure for an unread XHR `stream`.** The pieces queue in
  the `ReadableStream` however slowly the script reads. A `pull`-driven
  source could pause the worker, which needs a page-to-worker "ready
  for more" message.
- **XHR upload progress** (`upload.onprogress`): `fetch` reports
  nothing as it sends a body. VM runs its XHR in the offscreen
  document, where `xhr.upload` works; that would mean moving requests
  with a body there.
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
- **Listener-id contract.** `addValueChangeListener` returns the id
  as a `String(numericCounter)`. TM returns numeric IDs. Pin the
  contract in `GM-APIs.md` — id should be opaque to callers, but
  document what we return.

## `@connect` follow-ups

- **Connection policy and modes.** The prompt asks per request; the
  wider policy is still open:
  - What to do with the `@connect` hosts a script declares at install,
    and with new ones an update adds. Accept them by default, show them
    for review, let the user revoke one?
  - A global strictness setting (ask / allow / deny undeclared hosts),
    with care: TM's per-request prompting is a known annoyance.
- **Several prompts at once.** A script that reaches several new hosts
  together opens a window per host. One window listing them would be
  kinder.
- **An answer covers one exact host.** "Allow cdn.example.com" doesn't
  cover `img.cdn.example.com`. Consider offering the parent domain.
- **`self` subdomain handling.** TM/VM treat `self` as "the
  script's own origins OR their subdomains"; SourceMonkey matches
  `self` hosts exactly. See `src/gm-connect.ts#hostMatchesRule`. Fix:
  fall through to the subdomain check against `selfHosts` as a set
  of bases. Documented limitation pending a real compat report.
- **`self` with a `.tld` host.** `extractSelfHosts` takes
  `www.google.tld` literally, so `self` never covers the real
  www.google.com. Matching `selfHosts` with the `.tld` reading from
  `url-match.ts` would fix it.
- **Port handling is asymmetric.** A user-supplied port in
  `@connect example.com:8443` (no scheme) lands in the `host`
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

## Development harness

See [docs/harness-design.md](docs/harness-design.md).

- Removing a scratch script from the collections page while
  `writeRunScript` rewrites one of the same name can delete the
  fresh text: the write stores the text row before installing the row
  that reads it, and the remove, in another context, sees no reader in
  between. The install then fails with "The scratch script's text was
  cleared". Narrow, and only with sm-dev pushing while someone
  edits the page.
- A scratch-script error names sm-dev's push as the fix: "Push it
  again" when the text row is gone (`directories.ts`). Word it for the
  writer once anything but sm-dev writes scratch scripts.
- Two `writeRunScript`s of the same new name in one run at once both
  miss the lookup, and the second fails with an `Internal error`.
  sm-dev pushes one at a time, so only another caller of the worker's
  API could. Look the row up inside the install's lock.
- A run whose test collection the extension removed (stalled past its
  lease and grace period while the browser ran on) isn't told: its
  tabs then run nothing. `renewRun` could say the collection is gone,
  so the run pushes its scripts again or says so.
- An sm-dev older than protocol 1.7 shows an extension script whose
  page loaded before the extension started (`UNTRACKED`) as
  `running` in its JSON: that's its fallback for a status it doesn't
  know. Fall back to a neutral state instead (`not-started`, or a new
  `unknown-status`), so a later new status reads as unknown too.
- Publishing: the package is installed from a checkout or a git tag.
  `package.json` keeps `"private": true` until then; drop it to
  publish.
  Once it is on npm, the guide's install step and the consumer's
  `dependenciesMeta.injected` workaround both get simpler.
- A command sent to a run from another shell (or from stdin) exits 0
  when it fails in the run, unless it is a `match` or `validate` miss
  or it threw: the others only print why. Have each return its exit
  code (the run already carries one back), so scripted lines can stop
  on a failure.
- Nothing tests the interactive `> ` prompt, which only turns on with
  `--interactive` at a terminal. A test would run
  `sm-dev --interactive start` in a
  pseudo-terminal (pty: Python's `pty` module, or the native `node-pty`
  package) and cover:
  - Ctrl-C clearing a typed line, exiting on an empty one (and stopping
    the run it started), and dropping an open `eval` block.
  - A second Ctrl-C while a command runs exiting.
  - Streamed output landing above the prompt, with the typed text redrawn.
  - Ctrl-Z then `fg` leaving the prompt still reading keys (readline
    pauses its input on resume). Under a pty with no job control the
    stop signal is dropped, but sending SIGCONT still runs readline's
    resume path.

## sm-dev runs: follow-ups

- **A page's stackless error is labeled `[script error]`.** A
  `SyntaxError` from the page's own `eval` has no stack frames, and
  `pageErrorSource` (`src/harness/page-output.ts`) gives a frameless
  error to the scripts unless `stacklessIsScripts` (`run.ts`) can tell
  otherwise. Seen on www.la7.it with a `@grant none` script that does
  nothing: "Function statements require a function name", before the
  script started. Same on `main`.
- `settleWrites` waits 250 ms after firing a menu command, sized for
  the old 150 ms value-write debounce
  (`src/harness/console-commands.ts`). Writes now reach the worker a
  message later, so it could probably be much shorter.
- After SourceMonkey's worker restarts mid-run, the events from while it
  was stopped are lost (the run says so). The scripts' Log entries are
  read back; the rest (starts, menu commands, values) could be caught
  up from the host's own reads. See
  [docs/sm-dev-design.md](docs/sm-dev-design.md#when-the-sw-restarts).
- A tab a run tab opens is set up after its scripts ran, so their
  console lines from that first load don't reach the run (the reports
  do).
- **A run's commands take turns across all its clients.**
  `commandRunner` (`src/harness/console-commands.ts`) queues every
  command, so one client's `wait 30s` holds up the others.
  - Waits and commands that only look could run alongside others.
  - Needs a per-command context: `ctx.out` and `ctx.json` are swapped
    per command now.
- **`click --at X,Y` in CSS pixels, and `click --force`** to skip the
  covered-element check. Closed shadow roots and covering overlays
  (cookie footers, login panels) defeat `click`/`hover`, and agents
  fall back to raw CDP, dividing screenshot pixels by devicePixelRatio.
- **An init script for the run's lifetime.** `cdp
  Page.addScriptToEvaluateOnNewDocument` ends with that one call's
  session, so an observer can't be put in place before a reload.
- **Browser-level prompts go unseen.** A page that opens a custom
  scheme link (Douyin's `snssdk://`, say) gets Chrome's "Open
  xdg-open?" external-protocol prompt. It isn't a page dialog, so
  Playwright and the dialog tracker never see it, and nothing tells the
  run a tab has one up.
  - It doesn't block the page's JavaScript, but it covers the page in a
    visible browser and may hold up a navigation.
  - Options: turn external-protocol launches off in temp browsers (a
    Chrome preference or policy, to find), and report a navigation to a
    non-web scheme from a run's tab.
- **`open` takes no `--timeout-seconds`**, unlike `start` and `wait`;
  slow sites (Douyin) often pass its 30s load limit.
- **`reload` of a `--noscript` tab printed a script's "no @connect
  lines" note**, though that tab runs no scripts (corpus 518609). Seen
  once; find which path printed it.
- **Downloads leak to `~/Downloads` after a second `start`.** In a
  temp browser run, the first `start`'s downloads go to the run's
  `...-downloads/` folder beside its log; after another `start` in the
  same run, they land in the person's real `~/Downloads`. Reproduced
  in a corpus run (2026-10-04). The download behavior is probably set
  up only for the first start's browser context or tab.
- **A way to trim a saved page.** A raw SeeWhatISee snapshot of Code
  Search was 1.46 MB, mostly a file-tree subtree and inline `<svg>`
  icons, and trimmed by hand to 34 KB. A `savehtml` option (or a
  separate command) could drop given subtrees, inline SVGs and unused
  `<style>` blocks.

## Tabs that predate the first script install

- In a fresh profile (headless Chromium 153), a tab opened before
  SourceMonkey's first script install can't message the extension.
  - A script with a storage grant then logs `Failed reading this
    script's stored GM values during setup`, and its `sm:error`
    report never reaches the Log either. A reload doesn't help; a
    cross-site navigation (a new renderer process) does.
  - Once one script has been installed and removed, later tabs are
    fine. Calling `configureWorld` (with or without a raw `register`)
    before the tab opens did not help, nor did `syncNow()`.
  - Real users mostly have scripts before any tab opens, but a new
    install with tabs already open may hit it. Find the cause.
  - sm-dev works around it (`warmUp` in
    `src/harness/extension-launch.ts`).

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
- **MAIN-world pushes with no headless driver.**
  `tests/e2e/gm-main-world-surface.spec.ts` proves every SW→page push
  the bridge relays reaches MAIN world except two, which nothing can
  drive headlessly: `sm:gm-notification-event` (no way to click a Chrome
  notification) and `sm:gm-download-event` (needs a real download). Both
  go through the same world-gated relay as the covered ones, so the risk
  is low; a manual check with a real browser is what's left.
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

The write mutex in `script-store.ts` covers every write of a script row
(`checkScriptRowWrite`); only the service worker writes at all. What it
still leaves open is catalogued in
[docs/storage.md](docs/storage.md#one-lock-in-the-worker) rather than
here: those are decisions, not proposals.

One thing does have a concrete fix we chose not to make:

- **`setRefreshError` is a lost update waiting on a rare trigger.**
  `src/extension/refresh-error.ts` read-modify-writes one whole map, with nothing
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

## Worker writes — performance follow-ups

Set aside while moving every write into the service worker
([docs/worker-writes.md](docs/worker-writes.md#open)), from timings on a
326-script profile.

- **Full row-cache reads still copy every row.** Enables no longer
  read every row (they use the indexes and the frozen shared rows), but
  `allCachedRows` / `cachedScriptRows` still copy the whole cache, at
  10–30 ms for 326 rows.
  - Their callers: the membership reconcile, the blob sweep, and
    `getAllScriptMetas`.
  - Each would need checking for edits to the rows it reads before it
    could take the frozen rows instead.
- **Cache recently used script bodies in the worker.** The sync's `read
  bodies` takes ~5 ms alone but 60–180 ms while other storage work runs,
  and it is part of what makes enables wait during a sync. A size-capped
  blob cache, kept current the way the row cache is, would remove those
  reads.
- **Re-registering the GM runtime and bridge on pattern changes.** A
  sync that changes a helper's patterns re-registers it, 200–430 ms, and
  storage reads in pages stall meanwhile.
  - Identical patterns already de-dupe (`applyScope` keeps a set), but a
    pattern covered by another (`https://a.com/foo/*` beside
    `https://a.com/*`) still changes the set.
  - Options: per-origin patterns, so a second script on a covered site
    changes nothing; or `<all_urls>`, which `buildGmRuntimeSpecs`
    argues against (the runtime's load on every site).
- **Minify the injected helpers properly.** The build only strips
  comments and whitespace (`minifyForInjection`): the GM runtime goes
  from 131 KB to 55 KB. A real minifier (esbuild or terser) might reach
  25–30 KB.
  - Measure first: Chrome's `register` time against helper size, and
    page parse time where it's injected.
  - Renamed identifiers make the runtime's own stack traces harder to
    read; a source map would cover that.
- **Audit what's in `wrapper-gm-runtime.js`** for code no current API
  needs.

## Storage-key migration — remove after 2026-09-01

- **`ensureCollectionKeysMigrated` in `src/extension/script-store.ts` is
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

## Manual scripts — follow-ups

See [docs/manual-scripts.md](docs/manual-scripts.md).

- **A retired row whose refresh fails keeps a false error.** A row an
  older build refused for `@run-at context-menu` is refreshed on update
  (`retiredHeaderProblemIds`). If that refresh fails (file gone, host
  down), the row keeps "@run-at context-menu … is not supported", which
  is no longer true. Rewrite it to a neutral "needs a refresh" message,
  or log why the recheck failed.
- **Two sources for "is this manual".** `recordScriptReport` asks the
  match index (`isManualScriptId`); `computeBadge` asks the document's
  `manualRuns`. They disagree only after a header edit adds or removes
  `@run-at context-menu` while a page runs the old copy: a stale report
  can then skip the stale check, or a manual-then-load script never
  shows RELOAD there. Deciding from `manualRuns` in both would agree.
- **Fixture `fireMenu('Run this script')` edge cases.** With no manual
  script reported yet, or more than one and no `script` named, it falls
  through to `fireMenuCommand` and returns false, rather than waiting or
  saying which to pick.
- **Pages open across an extension update** have the old bridge, without
  the once-per-document guard, so a page-world manual run there injects
  a second bridge and every message is forwarded twice. Gone with the
  next load of the page.

## Changed files on disk — follow-ups

See [docs/file-changes.md](docs/file-changes.md).

- **New files in a new subdirectory aren't seen.** The "refresh
  pending" probe lists a directory collection's root and the folders
  its known scripts sit in; a `.user.js` dropped into a subdirectory
  nothing is known in yet only shows up on refresh. Listing recursively
  would match the scan, at the scan's cost.
- **A same-size edit within one second is invisible** — to the chip
  and to the refresh's skip alike, since both compare the listing's
  whole-second mtime. A content hash would need the read the skip
  exists to avoid.
- **Showing what changed.** A `MODIFIED` chip says a file differs; a
  diff against the stored copy is the natural next step, and the
  stored body is already there to diff against.
  - The versions panel's Compare column has this: its `DIFF` button
    opens the compare page. The `MODIFIED` chip's diff would be the same page
    with the file on disk as one side.
- **Compare page** (docs/compare.md) follow-ups:
  - Intra-line highlighting: mark the changed span within a replaced
    line pair, the way GitHub does. A common prefix / suffix per pair
    is most of it.
  - Syntax colouring in the diff, with the viewer's Prism setup.
  - Function names in the `@@` seams, git-style: the nearest preceding
    line that looks like a declaration.
  - Follow the store: repaint when either copy is refreshed.

- **http(s) files that are really gone.** A 404 on refresh is treated
  as a transient failure (`REFRESH FAILED`, keep running), because a
  404 is not proof — but a script whose URL has 404'd on every refresh
  for weeks is probably removed. A count of consecutive 404s on the
  row could escalate the badge's wording to "probably removed" without
  changing what runs.
- **`@icon` stand-ins get no chip.** Same reasoning as their missing
  `local` marker (docs/local-file-overrides.md): a 16×16 slot has no
  room, and a wrong icon is cosmetic.
- **The collections page only re-probes for changed files on a
  repaint.** Listings are memoised for a few seconds, so a burst of
  storage writes costs one listing per folder — but a file deleted
  while the page just sits there isn't noticed until something writes
  to storage or the page is reloaded. A `visibilitychange` / `focus`
  re-probe like the delete dialog's would close that.

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
  to delete the file by hand; the dialog watches for that and then
  offers to remove the entry itself. The overwrite trick above would
  close the by-hand step.
- **`exists` is only as fresh as Chrome's last check.** The dialog
  probes the disk itself while it is open, so a file deleted by hand
  is listed as gone rather than attempted. A file that goes between
  the last probe and the click still reaches `removeFile`, which fails
  and is reported; nothing is erased on that path, so a later attempt
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
  keep yet. See `src/extension/refresh-targets.ts`.

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

- **Storage format 2 follow-ups.** Bodies live in shared
  `blob:<sha256>` rows ([storage.md](docs/storage.md#content-blobs)),
  and readers that need only the rows skip them. Still open:
  - The Options page usage table sizes blobs from the refs and
    `getBytesInUse`, without reading them.
  - Compression of large blobs, as a new `encoding`.
  - Refresh still reads the bodies of the copy it starts from, to
    reuse them when the file hasn't changed. Reading them only on that
    outcome would need the rebuild to take the row and load bodies on
    demand.
  - An incremental sync re-sends a registered script's code even when
    it didn't change (a row edit that moved only its patterns, say).
    The full sync compares against `getScripts()`; an incremental one
    would need each placement's code hash kept in its record.
  - A missing blob shows on the pages once a registration sync reads
    the script (each worker start, or a change to its row) and saves it
    `invalid`. Until then they show it as it was. Checking the blob
    keys (`getKeys`) on a repaint would catch it sooner.
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
- **Identity across a file that bounces.** A refresh drops a script
  the scan no longer reports — the per-script refresh on a navigation
  or tab focus included, which widens the window — and the row's UUID
  goes with it, so a file that vanishes and comes back (branch switch,
  an editor that saves by unlink+rename, a sync client rewriting in
  place) returns as a fresh row: `enabled: true`, empty Log, and its `gmval:` values orphaned
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
  ordinary browsing appends `Checked for updates and found no change` per
  script per reload — and two rows for a script that is still failing.
  Dropping the row for non-user-initiated checks would fix it; the
  blocker is that `manual` currently means "not rate-limited", not
  "the user clicked", so the fast-path can't be told apart from a
  Refresh click.
  - Restating parse-time diagnostics rides on the same gate, so a
    permanently-misconfigured script (e.g. `@grant unsafeWindow` with
    `@inject-into content`) now repeats its warning once per reload as
    well. `probe === 'force'` is the signal the rest of the file uses
    for "the user clicked Refresh" — threading it into
    `emitScriptOutcomeLog` would gate both rows properly.
- **Parse-time diagnostics live only in the Log.** A script whose
  header can't do what it asks (the `@grant unsafeWindow` +
  `@inject-into content` case) is badged, but the sentence explaining
  why is a Log row the user has to go find — and one that only gets
  written on boot replay, on new content, or on a manual refresh.
  Showing the current `startupLogs` in the detail panel next to Status
  would make the explanation as durable as the badge, and would remove
  the reason for restating the rows at all (see the poll-noise item
  above).
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
  names — bad or missing scheme, empty host, a host holding characters
  no hostname can, misplaced host wildcard — and stops there, because a
  false positive would drop a pattern that works. A malformed port and
  anything Chrome tightens next still land as REJECTED (a port out of
  range, say — `https://host:65536/*` passes our check and Chrome
  refuses it). Widening it means owning more of a grammar that drifts,
  so each addition wants a probe against a real Chrome first (the one
  in `tests/e2e/rejected-registration.spec.ts`'s header is the record
  of the last such run).
- **The install preview doesn't show parse-time warnings.**
  `checkPreviewSource` builds the row and reports header errors and
  syntax errors, but drops `startupLogs` — so an unsupported `@grant`
  or a dropped `@match` is only visible after installing.
- **Registration has no single owner across contexts.** The lock in
  `src/extension/injector.ts` serializes registration work within one JS context,
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

### Toolbar popup

The popup shipped (see [docs/status-popup.md](docs/status-popup.md)).
Left from its design:

- **Version picker**: a small versions button on a row with other
  copies, opening a list like the viewer's to switch which copy runs.
  Needs the list UI designed first.
- **A script's own `@icon`** on its row, maybe. Site icons were left
  out: on one page they'd nearly all be that site's.
- **More page actions**: Refresh All, disable everything on this site.

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
- show which world a script runs in ("runs in page" vs "runs
  isolated") in the viewer. The world is decided by the header
  (`@grant none` or `@grant unsafeWindow` or `@inject-into` — see
  [docs/injection-modes.md](docs/injection-modes.md)), so today the
  user has to read the grants and know the rules to predict whether
  the script can see page globals. It's also the fact that explains
  the `@inject-into content` + `unsafeWindow` warning.
- surface `GM_download` / `GM_openInTab` in the details panel. The
  panel dropped the `@grant` row on the grounds that `@connect` already
  carries the network story and the rest of the GM surface acts within
  the page's own reach — but these two are the exception: they reach
  the user's download directory and any URL respectively, and neither
  is `@connect`-gated. A `@grant` row for those two names alone would
  be noise-free, but it needs a wording that reads as a capability
  rather than a tag dump.
- large collections still blow past `chrome.storage.local` (and RAM). The
  refresh fan-out is bounded now (`src/extension/concurrency.ts`), but the whole
  result set — every script body, plus prefetched `@require` /
  `@resource` payloads — is still held live and then written in one
  `set`. Open pieces:
  - No `unlimitedStorage` permission, so the whole extension shares a
    10 MB `storage.local` budget. Decide between taking the permission
    and moving bodies out of `storage.local`.
  - Reporting the failure is done (`src/extension/refresh-error.ts`) — what's
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
    (`src/extension/script-store.ts`), and the boot log replay in
    `src/extension/script-updater.ts`. Both want `mapWithConcurrency`.
- a collection whose refresh drops its LAST script says nothing about it.
  The tombstone rows the collections page leaves for dropped scripts
  (`docs/storage.md`, "Tombstones") hang off the script table, and a
  collection with no scripts left shows the "no scripts" message
  instead — so the one case where the whole table emptied out is the one
  case with no explanation on screen. Wants the empty message to carry
  the reason when the refresh that emptied it is the one being shown
  ("the last refresh removed the scripts this collection had"), which
  means the message needs to know what the refresh just did rather than
  only what is stored now. Reachable for any collection kind now that
  an empty scan drops rows too.
- site icons: passively capture `tab.favIconUrl` from live tabs (`chrome.tabs.onUpdated`).
  - Chrome's `/_favicon/` database covers visited URLs directly, so we declined the added service-worker listener and matching plumbing for now.
  - Worth revisiting if scripts whose synthetic `linkUrl` (e.g. `https://host/issues/`) is never visited directly — only deep URLs like `https://host/issues/12345` — miss in `/_favicon/` AND their unauthenticated HTML probe redirects to SSO.
- site icons: Chrome's `/_favicon/` DB can still hand back an SSO (single
  sign-on) host's icon for an app URL — Chrome maps the icon onto every URL
  of the redirect chain, so a tab that bounced to login and never signed in
  poisons the app URL. `isSameHostRedirect` can't see that (no redirect
  happened on our side). Options: compare the DB hit against the DB's own
  answer for the known SSO host, or skip the DB tier for hosts whose HTML
  probe redirected cross-host.
