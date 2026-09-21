# Compile-only parse check

Answers one question at install / refresh time: **would V8 accept the
code we are about to register?**

## Why

Requires and the body are concatenated into one injected entry (Mode A
— see [injection-modes.md](injection-modes.md)). A syntax error
anywhere in that program makes the *whole* entry fail to parse.

Before this check, that was only discoverable at injection time:

- The seal entry noticed `__smRun` was never called and logged
  "Script source failed to parse (a `@require` or the script body has a
  syntax error); nothing was run".
- It fired only on a page the script actually matched, so a broken
  script looked fine on the collections page until you happened to visit
  one.
- It named no file.

Now the script is marked `invalid` next to its row, at the moment it is
added or refreshed.

## How it works

`new Function(src)` compiles a function body and returns **without
running it**. That is exactly the check — and it is V8's own verdict on
the same text we inject, not another parser's opinion about a similar
text.

But `new Function` is `eval` as far as CSP is concerned, and MV3's
extension CSP forbids it in every context an extension normally uses.
A **sandboxed page** may declare `'unsafe-eval'`, and is the only place
that may.

- A sandboxed page has an opaque origin and no `chrome.*`, so the only
  thing that can talk to it is whoever embeds it, over `postMessage`.
- Its CSP also allows `'unsafe-inline'`, which the location probes need
  to insert a `<script>` at all. That is Chrome's own default for
  sandboxed pages; our manifest had narrowed past it.
- `'unsafe-inline'` **does** grant something `'unsafe-eval'` doesn't —
  inline `<script>` execution. What makes that cost nothing here is an
  invariant, not the opaque origin: **nothing in the sandbox page ever
  writes HTML.** The only DOM write is `el.textContent = text`, so
  there is no injection sink for the new grant to reach. A future edit
  that reaches for `innerHTML` is what would break it.
- **Anything with a DOM can be that embedder.** `parse-sandbox-host.ts`
  is the shared driver: readiness, correlation ids, timeouts, verdict
  validation, circuit breaker.

| Context | Has | Lacks | Reaches the sandbox by |
|---------|-----|-------|------------------------|
| Sandboxed iframe (`parse-sandbox.ts`) | `eval`, DOM | `chrome.*`, any caller but its embedder | — it *is* the sandbox |
| Extension page (`parse-check-client.ts`) | `chrome.*`, DOM | `eval` | embedding its own frame |
| Offscreen document (`offscreen.ts`) | `chrome.*`, DOM | `eval` | embedding its own frame |
| Service worker (`parse-check.ts`) | `chrome.*` | DOM, `eval` | messaging the offscreen document |

The service worker is the only context that needs a relay, and it needs
one for a single reason: **it has no DOM**, so it cannot host an iframe.
That is the whole job of the offscreen document.

## What is checked

The exact text `wrapCombinedEntry` compiles as a function body, built
by `buildParseCheckSource` in `injector.ts`:

- every `@require` body, in declaration order;
- the script's own full source;
- the emitted `GM_*` bindings.

The bindings are included on purpose. They are `const` declarations in
the same scope as the user program, so a library doing
`const unsafeWindow = window.wrappedJSObject || window;` — a real idiom
— is a duplicate declaration and a genuine parse failure.

- The one binding that steps aside is the *implicit* `unsafeWindow`
  one: a script that merely uses the name gets no binding when a
  `@require` declares it, so that idiom keeps compiling.

Not included: the wrap head, its `var` preamble, the `__smE` parameter,
and the GM prelude. The head is ours and always valid, and on its own
it leaves an unbalanced brace.

That leaves a gap, in the safe direction. `var x` beside `var x` is
legal, but `var x` beside `let`/`const`/`class x` is a `SyntaxError`,
and so is redeclaring a parameter. A script writing `const __smE`,
`let __smDecision` or `const __smGmSnap` therefore passes and fails at
injection. All such names are `__sm`-prefixed, and the run-time seal
entry still reports it. Tracked in `TODO.md`.

## Why the composed program, not each file

Some failures only exist once the files are joined. Two libraries that
each declare `const shared` are individually valid and a `SyntaxError`
together. Checking files separately would call that script healthy.

## Failing open

A verdict has three states, not two, and the third is what makes the
guarantee real. **Only V8 answering `SyntaxError` may disable a
script.** Anything else is `unknown`: not stored, not cached, not
surfaced.

Machinery failures that resolve to "don't know":

- the sandbox frame won't load, or (for the service worker) no
  `chrome.offscreen` / the document won't open;
- the sandbox doesn't answer inside the timeout;
- a verdict comes back with a status we don't recognise — validated in
  `parse-sandbox-host.ts`, because `applyParseCheck` treats anything
  that isn't `ok`/`unknown` as `invalid`;
- no checker installed for this context (see below);
- **any throw that isn't a `SyntaxError`.**

That last one carries the weight:

- A `RangeError: Maximum call stack size exceeded` on deeply nested but
  valid source is the parser running out of budget *in the sandbox* —
  not the budget `chrome.userScripts` compiles the real entry with.
- If the sandbox CSP ever stopped applying, `new Function` would throw
  `EvalError` and **every script in the profile** would be branded
  broken at once. Distinguishing the states turns that into "the
  feature is off" rather than "every userscript is disabled".

A circuit breaker stops trying after a few consecutive failures, so a
permanently wedged sandbox costs a few timeouts rather than one per
script forever. It re-arms on a cooldown rather than tripping for good:
the offscreen document lives as long as the browser session does, and a
breaker that never reset would mean three unlucky timeouts turn the
check off until restart — including after the sandbox recovers.

The seal entry stays in place as the run-time backstop, so anything
missed here is still reported exactly as it was before.

## Where the checker is installed

`script-store.ts` does **not** import the injector — a real (not
type-only) module cycle between them is something this codebase avoids.
Instead the dependency is inverted: `setParseChecker` takes the
implementation, and each context installs one at startup.

### The service worker

`background.ts` installs `compileParseChecker`, which composes the
source and drives the offscreen document.

### Extension pages

The load pipeline runs **wherever it was called from**. The collections
page (Add, Refresh, Refresh All) and the viewer (Install,
Refresh) call `addCollection` / `updateCollection` / `updateScript` in the
*page*, not in the service worker.

`parse-check-client.ts` installs a checker there. The page has a DOM,
so it embeds its own `parse-sandbox.html` and compiles locally. The
service worker is not involved, which buys:

- no SW wake on the path behind an Install click;
- no structured clone of the whole script — bodies, `@require` bodies,
  base64 `@resource` blobs — to every extension context;
- no dependency on the SW surviving the round trip;
- **parallelism**: one single-threaded worker with one shared sandbox
  is a queue; per-page frames are not;
- a circuit breaker per page, so one wedged sandbox doesn't turn the
  feature off everywhere.

Only the transport differs from the SW's checker. Both compose the
checked text with `buildParseCheckSource`, so both judge the same
program.

### The install preview

The preview (`userscript.html?preview=…`) has no stored row for the
store hook to fire on, so it calls `checkScriptParses` directly on a
`StoredScript` it builds from the fetched text.

- **Runs before Install**, so a syntax error is visible while the user
  is still deciding — not on the `INVALID` row they land on after.
- **Warns, doesn't block.** Install stays enabled; see
  [script-viewer.md](script-viewer.md#when-the-code-wont-parse).
- **Covers Update as well** — previewing a location already installed
  offers Update, which rebuilds the row the same way.
- Fetches every declared `@require` and `@resource` up front, through
  the **same `attachFiles`** the store uses, because the check judges
  the composed program.
  - Hand-rolling that fetch loop is how the preview accused a healthy
    script: `attachFiles` dedups by canonical URL, so a library
    declared twice is loaded once. Fetching per declared ref
    concatenated it twice, and any top-level `const` in it read as
    `already been declared`.
- A file that can't be fetched is reported as "could not be checked",
  not as a prediction. A flaky dependency host is not grounds for
  telling the user their install will fail — an Update over http keeps
  the working copy running.

### Why not just skip it in pages

Skipping doesn't leave a row *unverified*:

- The rebuild resets `status` to `ok`, so an unchecked page refresh
  **cleared** a prior `invalid` verdict.
- It then reported "Loads cleanly again (was invalid)" for a script
  that still didn't parse.
- The next background refresh flagged it again, so the Log alternated
  between the two.
- Install had the mirror-image hole: a broken script landed as `ok`.

Covered by `tests/e2e/parse-check-pages.spec.ts`, which drives the real
buttons — `sm.*` test helpers run in the SW and can't see this class of
bug.

## Caching

Re-checking every script on every refresh would cost a round trip each.
`parseCheckedHash` on the stored row fingerprints the extension
version, the body's `contentHash`, and each `@require`'s — so a refresh
whose content didn't move reuses the prior verdict.

- The body's hash covers the whole file including the header, so
  `@grant` / `@require` / `@inject-into` edits all move the key.
- The **version** leg matters because the checked text contains code
  *we* emit. Add a `GM_*` binding in a future release and a script that
  already declares that name becomes a parse failure, with nothing
  about the script having changed.
- An `invalid` or `unknown` row deliberately records nothing, so a
  later refresh re-derives the verdict rather than inheriting a stale
  pass.

## Deferring the check on the reload fast path

The check is a **diagnostic**, and one caller cannot afford to wait for
it: the reload fast path has a wrapper in the page blocking on its
reply, with a 500 ms budget the check's round trip was consuming most
of. See [injection.md](injection.md#parse-check-off-the-critical-path).

`ParseCheckMode` is how that caller says so:

- **`'await'`** — the default, and what every other caller uses. The
  verdict is part of the row the pipeline returns.
- **`'defer'`** — `applyParseCheck` returns the row with no
  `parseCheckedHash`, which is the same state a row is in when the
  check couldn't run at all. `refreshScript` then calls
  `checkParsesInBackground` on the row it wrote, and does not await it.

Who picks which is decided by the trigger, not the caller:

- **Navigation-triggered checks defer; user-initiated ones wait.**
- The opportunistic sweep therefore defers too — see
  [injection.md](injection.md#parse-check-off-the-critical-path) for
  why a split rule wouldn't hold.
- The cached-verdict short-circuit still applies first, so a deferring
  caller only leaves a row unchecked when the content actually changed.

**Except where the verdict wouldn't land on the row anyway.**
`keepsPriorOnInvalid` — an http(s) entry with a prior `ok` copy — is
the one place a parse failure is recorded as a *refresh* failure
instead:

- That rule reads the status the pipeline returns, so a verdict
  arriving after it has run would replace a working script with a login
  page and flag it `invalid`.
- `rebuildCollection` therefore decides `'defer'` **per entry**, off
  that same predicate.
- A `file://` edit is flagged immediately whichever mode ran, which is
  what makes deferring outcome-preserving there.

### How a late verdict is written

`checkParsesInBackground` delegates to `verifyParseChecks`, rather than
opening a second write path. That function already survives exactly
this race, because the pass before registration has it too:

- It **re-reads the row inside the write lock** and refuses the verdict
  when `parseCheckKey` no longer matches — a newer refresh's content is
  not what we judged.
- It also refuses when the stored row is **no longer `ok`**. The
  fingerprint doesn't catch that on its own: `applyFetchError` preserves
  the content it is made of, so a verdict landing after a failed read
  would otherwise resurrect the row as `ok`.
- **A refused verdict still hands the caller the stored row**, rather
  than nothing. A caller that gets nothing back keeps the copy it read
  *before* the check — which is the row that still says `ok`, and
  registering that is the exact failure this gate exists to prevent.
- It merges only the verdict's own fields onto the row as it now
  stands, so a concurrent `enabled` toggle or version probe isn't
  rolled back.
- A row it writes as no longer runnable gets a Log entry (`source:
  parser`). Emitted here, by whichever pass won the write, because by
  then the refresh that would normally have reported it has finished.

Two things a user sees change when the verdict is deferred:

- **The Log shows a pair, not a single line.**
  `emitScriptOutcomeLog` runs against the verdict-less row, reads it as
  healthy, and writes `Loaded new content (N bytes)`; the verdict then
  appends the syntax error underneath. The awaited path wrote one
  `invalid` entry and no "loaded" line.
- **The `source` moved.** That error arrives as `parser` rather than
  `manual-refresh` / `background-refresh`, so a Log tab filtered by
  source shows it somewhere else — including in the ordinary
  edit-save-reload loop, which is now a deferring path end to end.

### One compile, not two

Deferring leaves the row without a `parseCheckedHash`, so the
registration gate finds it stale and would compile the same bytes a
second time — concurrently, since the refresh's own write is what
scheduled that sync.

`verifyParseChecks` keys checks in flight by row id **plus**
fingerprint, and a pass that finds one already running joins it and
takes its result. Same row, moved again, is a different key and
therefore different work.

### If the worker dies first

The row stays unchecked, and that is all: it carries no
`parseCheckedHash`, so the gate below finds it stale on any later sync
and derives the verdict before Chrome is offered the body. Timeliness
is what's lost, not the check.

Don't lean on "the refresh's write scheduled a sync" for this. A
refresh that finds the content unchanged skips the write entirely
(`sameStoredValue`) — which is exactly the state a defer leaves behind
after an extension-version bump, since the version is part of
`parseCheckKey`.

## The gate before registration

The load pipeline only checks rows it is *building*. A row stored
before this feature existed — or while the check was failing open —
keeps `status: 'ok'` with no `parseCheckedHash`, and nothing revisits
it.

`runSync` (`src/injector.ts`) closes that. Before it builds specs it
calls `verifyParseChecks` with exactly the rows it is about to
register:

- A row with a matching `parseCheckedHash` is left alone — the normal
  case, and no round trip.
- After a SourceMonkey update every row mismatches at once, because
  `parseCheckKey` carries the extension version (the checked text
  contains our own `GM_*` bindings). That pass is capped —
  `PARSE_RECHECK_CONCURRENCY` — and registration waits for it, so the
  bound is on memory, not on politeness.
- Anything else is compiled now. A `syntax-error` verdict writes the
  row as `invalid` (so the collections page says why) and the script is
  not registered.
- An undecided answer changes nothing and registers as before, so a
  browser without the machinery behaves exactly as it used to.

Why it isn't enough to let the seal entry report it at run time: a
registered entry V8 refuses to compile raises an uncaught `SyntaxError`
that no code of ours can catch, and Chrome files it under
`chrome://extensions/?errors` as an extension error. Not registering is
the only way to keep it out of there. The seal entry remains the
backstop for whatever still slips through — see
[logging.md](logging.md#keeping-the-errors-panel-clean).

## Interaction with refresh policy

The check sets `status: 'invalid'`, and `rebuildCollection`'s existing
soft-failure rule then applies on top:

- **http(s) collection with a prior `ok` copy** — keep the prior copy
  running and record `refreshError`. A 200 that doesn't parse is
  usually a login or error page served in place of the script.
- **`file://` collection** — flag immediately. That is a real local edit,
  and a developer wants to see it now.

## The offscreen document is shared

MV3 allows exactly **one** offscreen document per extension.
`src/offscreen.html` is it. Anything else needing a DOM without a tab —
the clipboard fallback, for instance — must extend this host and its
`reasons` array (fixed at creation time in `parse-check.ts`), not
create a second one. (`GM_download` was once on that list; it turned
out not to need a DOM at all — `chrome.downloads` fetches the URL
itself. See [GM-APIs.md](GM-APIs.md#rejected-alternatives).)

The document is created lazily on the first check and never closed, so
it holds a renderer process for the session.

## Locating the error

The verdict says *whether*; a second step says *where*. They are
separate on purpose — only the verdict can disable a script, and
nothing about locating it may change that.

### Why it takes a second compile

- `new Function` reports **no position at all** — not in the message,
  not in `err.stack`, which stops at `at new Function (<anonymous>)`.
- Chrome *does* report one when a classic `<script>` fails to parse:
  the window `error` event carries `lineno` and `colno`.
- So on `syntax-error` only, the sandbox compiles the same text again
  as a `<script>` purely to find out where.

### Why that does not run the script

Appending a `<script>` normally executes it. Each probe therefore ends
with an unmatched `(`:

- An **opener** cannot be closed — nothing follows it. A closing `}` or
  `)` would be closed *by* whatever the source left dangling; appending
  `}` to a source ending in `if (1) {` yields a valid program, and it
  runs.
- The leading newline matters: without it, a source whose last line is
  a `//` comment swallows the sentinel.
- A parse failure aborts the whole script **before evaluation begins**,
  so not one statement runs.
- V8 reports the *first* error, so the sentinel never masks a real one.
  It only speaks when the source had nothing to say — which makes it a
  tripwire too.

`preventDefault()` on the error event is required, not cosmetic: an
uncaught error in an extension context is forwarded into
`chrome://extensions/?errors`. See CLAUDE.md.

### Why there are two probes

Neither framing is faithful alone:

- **wrapped** (`function __smParseProbe__() { … }`) reproduces
  `new Function`'s semantics exactly, so a top-level `return` stays
  legal — as it is in the entry we inject. But a source with unbalanced
  braces swallows the wrapper's closing `}`, and the parse runs on to a
  later, different error.
- **raw** has no wrapper to swallow, so it places a stray or missing
  brace exactly. But it is a *Script*, where a top-level `return` is an
  error V8 would never have raised for real.

`selectParseLocation` (`src/parse-location.ts`) picks between them, and
the verdict's own message is the discriminator. `new Function` is
*itself* a wrapper, so it shares the wrapped probe's blind spot:

- **messages agree** → the wrapper probably held; trust the wrapped
  probe, subject to the range check below.
- **messages disagree** → both wrappers were escaped; only the raw
  probe describes the real structure.

Agreement is suggestive, not proof. After escaping the wrapper the
wrapped probe hits the closing `}` *we* appended and reports
`Unexpected token '}'` — the same text a stray `}` produces for the
verdict. So the two can agree while the wrapper was escaped after all.

- The tell is **range**: a wrapped probe that truly held lands inside
  the source, or on the sentinel if the source is unterminated.
- Landing outside while the raw probe lands *inside* proves the source
  is not unterminated, so the out-of-range answer is escape fallout and
  the raw probe is taken instead.
- There is no fallback the other way. A wrapped probe that disagreed is
  describing a different parse of a different program — not a second
  opinion about this error.

A further filter applies to the raw probe: it is a *Script*, so it can
raise `Illegal return statement` and `new.target expression is not
allowed here`, which `new Function` never can. Either one proves it
stopped at code that is legal in the real entry, so its answer is
discarded rather than shown. (Those two are the whole list —
`Illegal break statement` and `'super' keyword unexpected here` read
the same from both framings.)

The chosen probe supplies the message *and* the line, except that a
winning wrapped probe reports the *verdict's* message — identical by
construction, and guaranteed free of the DOM prefix. Pairing one
compile's message with another's position is how you get
`Unexpected token 'var'` pointing at a line containing no `var`.

### Mapping back to a file

The reported line is a line of the composed program, which is not a
file anyone can open. `buildParseCheckSource` returns the same
`MappedSegment[]` the source map is built from, and
`lookupGeneratedLine` turns the line into a file plus a line within it
— the machinery the Log tab's stack refs already use.

- Columns pass through unchanged: composition only moves whole lines.
- A line no segment covers is ours (the GM-bindings preamble, a seam),
  so the position is dropped rather than blamed on the user's file.
- A position outside the checked text is the sentinel — the source ends
  mid-construct — so it is reported as the message alone.

### What the caller gets

The verdict's `location` is a `DiagnosticLocation`, the shape every
content-derived verdict in the extension carries — see
[diagnostics.md](diagnostics.md). The parse check is the only producer that always
knows a column, so `ParseLocation` pins both coordinates present.

- The store writes it to `StoredScript.errorLocation` beside the
  message, rather than formatting it into the text. That is what lets
  the viewer render it as a link.
- `errorMessage` therefore has no `(in …)` suffix; anything showing it
  as plain text pairs the two through `describeDiagnostic`.

## Limits

- **A brace imbalance is placed at the brace, not always at its
  cause.** See TODO.md.
- **A top-level `return` above a brace imbalance loses its position
  entirely** — neither probe can describe it honestly. The message
  still says what's wrong. See TODO.md.
- **Parse errors only.** A library that parses and throws when it runs
  is unaffected; running it is exactly what this must not do.

## Outside the browser

The same check runs as a CLI over files on disk — `new Function` under
Node, with `vm.Script` standing in for the `<script>` location probes.
Everything from `selectParseLocation` onward is this code, unchanged.
See [offline-validation.md](offline-validation.md).

## Testing

- `tests/e2e/parse-check.spec.ts` — the mechanism, including
  compile-without-execute and function-body-not-program, and the
  location probes: that they place an error, and that they never run
  the source they place.
- `tests/unit/parse-location.test.mjs` — probe selection and line
  mapping, driven by positions Chromium really reported. The selection
  rule lives in a plain module precisely so it can be tested here
  rather than only through a browser.
- `tests/bad-examples/` — installable by hand, one file per route
  through the location logic (body, `@require`, swallowed brace,
  swallowed brace at end of file, join-only collision, unterminated
  construct). Add the directory as a collection to see the real messages.
  The expectations live in `tests/fixtures/bad-script-cases.mjs` and
  are pinned twice: by `bad-scripts.spec.ts` in Chromium and by
  `tests/unit/validate-userscripts.test.mjs` under Node, which is what
  keeps the two engines' answers verified against each other. The same
  directory covers the header diagnostics — see
  [diagnostics.md](diagnostics.md).
- `tests/unit/parse-check-node.test.mjs` — the Node port of the compile
  and its `vm.Script` location probes.
- `tests/e2e/parse-check-install.spec.ts` — what a user sees.
- `tests/e2e/parse-check-pages.spec.ts` — the page-driven paths, via
  the real Install / Refresh / Refresh All buttons.
- `tests/e2e/reload-fast-path-parse-check.spec.ts` — the deferred mode:
  a fresh body reaches the page on one reload with the verdict still
  outstanding, and a broken edit is swapped in and then flips the row.
- `sm.setParseCheckEnabled(false)` turns the check off so a test can
  drive an unparsable script all the way to injection and exercise the
  run-time backstop.
  - The off-switch is a **session-storage key**, read before every
    compile, so it reaches every checker — the SW's and each page's.
  - `resetAllState` clears session storage, so it resets itself. A
    module variable had to be restored by hand, and one missed restore
    left the check off for the rest of that SW's life.
