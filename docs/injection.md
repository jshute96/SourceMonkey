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

The collections page probes the API at render time and shows a banner with
a copy-pasteable `chrome://extensions/?id=<id>` link when the call
fails.

## Lifecycle

`src/injector.ts` owns Chrome's registration set.

- **On SW startup** — `syncRegistrations()` runs with no scope, in
  parallel with the match-index load. See
  [Startup is a full reconcile](#startup-is-a-full-reconcile).
- **On every cache change** — the match-index already fires
  `onCacheChanged` for `script:*` / `collection:*` mutations, naming
  the rows that moved. The SW subscribes a second listener that
  accumulates those ids and re-runs `syncRegistrations(scope)`,
  alongside the existing badge re-evaluation.
  - **An empty scope is not the same request as no scope.** Nothing
    accumulated means nothing has changed since the last sync, and the
    answer is a sync with no rows to reconsider — which does nothing.
    Only the *absence* of a scope asks for a full reconcile. Confusing
    the two makes a second sync rebuild and re-offer every spec,
    which for an already-refused script writes another identical row
    into its Log; see
    [Rejected registrations](#rejected-registrations).
  - Not every write is reported — see
    [What an incremental sync must not disturb](#what-an-incremental-sync-must-not-disturb).
- **One-time world config** — `chrome.userScripts.configureWorld({
  messaging: true })` is called before the first `register()`. This is
  what lets the injected wrapper call `chrome.runtime.sendMessage`
  back to the SW.

### The sync is incremental

Only the rows that moved are rebuilt, and a script that is staying
registered is **updated in place**.

1. Expand the scope — a collection row that appeared, went away, or
   flipped its enabled flag moves every script under it.
2. `chrome.storage.local.get([...])` for just those rows. Not
   `get(null)`, which pulls every script body and the favicon cache.
3. Rebuild specs for those scripts only.
4. `chrome.userScripts.update([...])` for ids Chrome already holds,
   `register([...])` for genuinely new ones, and unregister+register for
   the narrow case `update` cannot express (see
   [What `update` cannot change](#what-update-cannot-change)). Chrome
   applies a batch all-or-nothing, so a rejected batch falls back to
   per-spec calls and one bad script can't take down every other one.
5. `unregister([...])` for scripts that left the set.

#### Why wipe-and-replace was wrong, not just slow

- **It was a correctness bug.** `unregisterAll()` and the register that
  followed are separate awaits, so between them Chrome held **no**
  userscripts at all. Any document created in that window got nothing
  injected — no error, no badge, no Log row, just a page where the
  script didn't run. Measured `unregister 71–90 ms`.
- **The window opened on every edit.** The sync runs on a 50 ms
  debounce after any `script:*` write, i.e. after every save the user
  reloads for — precisely when a reload is most likely to be in flight.
- **The cost was real too.** On a 192-script profile one row changing
  cost `total 339 ms (read 143, build-specs 18, unregister 71, register
  106)`, all of it competing with the reload fast path for the same
  thread.
- **Nothing is dropped to replace it now.** `chrome.userScripts.update`
  replaces a registration atomically; the `unregister` calls left are
  for scripts that really are going away, plus the one case `update`
  cannot express. See
  [Update, never unregister-then-register](#update-never-unregister-then-register).

#### Startup is a full reconcile

Chrome retains registrations across service-worker restarts, and rows
change while the worker is dead — so a fresh worker has nothing to diff
against and a pure diff would strand stale registrations.

- A sync is incremental only when this JS context holds a record of
  what it last registered. `src/injector.ts` keeps one — ids, worlds
  and pattern shapes, every script's basename, log label and
  collection, and the collection rows. No script bodies, so it stays
  small.
  - The label is in there because a script *arriving* renumbers the
    dupe group it joins (a lone `main.user.js` becomes
    `main.user.js#1`), and the label is baked into the registered
    `//# sourceURL=` directives. Every script whose label just moved is
    rebuilt too, however untouched its own row is.
- With no record, the sync reads everything, rebuilds every spec, and
  reconciles against `chrome.userScripts.getScripts()`: everything
  wanted is updated or registered, and only ids Chrome holds that
  storage no longer wants are dropped. **Still not a wipe** — a script
  that survives the restart is never unregistered.
- The record is dropped whenever it stops being trustworthy: a sync
  that throws part-way, and `unregisterAllRegistrations` (the test
  surface's teardown). The next sync then reconciles fully, which also
  covers whatever ids the failed sync consumed.
- A full reconcile also re-places the bridge and GM-runtime
  registrations, whose code ships with the extension and changes on
  update.

#### What an incremental sync must not disturb

- **Probe-only writes.** `versionProbes` is a display annotation no
  spec reads, and a Refresh All writes one probe result per script — so
  counting those as cache changes cost a re-registration per probed
  script. `onlyProbesChanged` in `src/match-index.ts` keeps them out of
  `onCacheChanged` entirely, and suppresses nothing wider: the check
  diffs the whole stored row, because a spec reads far more of it than
  matching does. See
  [Measuring](diagnostics.md#measuring-where-a-refreshs-time-goes).
- **Ordinary collection-row writes.** A collection row is rewritten on
  every scan; only the enabled flag and the row going away are
  reported, or every refresh would re-register every script under it.
  - Not its arrival either: a collection appears together with the
    scripts under it, which are reported in their own right, and the
    sync fetches a collection row it hasn't seen when a script names
    one. Reporting it would buy nothing and cost a sync per collection
    added.
- **The parse gate.** `revalidateCandidates` / `verifyParseChecks` runs
  over the scripts the sync is about to offer, on both the incremental
  and the full path — see
  [parse-check.md](parse-check.md#the-gate-before-registration).
  - **An incremental sync gates only the rows in its scope**, where the
    old full rebuild re-checked the whole library every time. A row that
    dodged the check — stored before it existed, or while it was failing
    open — is therefore caught by the next write to it or the next full
    reconcile, not by the next sync of any kind.
    - The exposure is bounded by the worker's life: the checker's
      circuit breaker never re-arms within one worker, so "the check
      started working again" always means a new worker, and that starts
      with a full reconcile.
    - Anything that falsifies the record's claim that its registrations
      were gated must call `forgetRegistrationState` — the test
      surface's parse-check toggle does.
  - `retryRejectedRegistrations` does **not** run it, and never has. It
    only ever re-offers rows that are already `ok` and eligible, so what
    it can miss is a row whose *verdict* is absent or stale — which the
    next sync covering it catches. Tracked in [TODO.md](../TODO.md).
- **Other scripts' REJECTED badges** — see
  [Rejected registrations](#rejected-registrations).

### What `update` cannot change

`chrome.userScripts.update` **merges**. The documented contract is "a
property is only updated for the existing script if it is specified" —
and testing against real Chrome adds the part the contract doesn't say.

- **An explicit empty array counts as unspecified.** `excludeGlobs: []`
  leaves the old exclusions in place, exactly as omitting the key does.
- **`matches: []` is refused outright** — *"must specify at least one
  match"*. So there is no way at all to clear a pattern field through
  `update`.
- **An updated registration moves to the END** of Chrome's set, in
  batch order. See [Ordering](#ordering).

Why this bites: `buildRegistrationSpec` emits `matches` / `includeGlobs`
/ `excludeGlobs` only when non-empty. Under wipe-and-replace every
placement was a `register` onto an empty set, so an absent key meant
"unset"; on the update path it means "keep".

- A user deleting their last `@exclude` would get a registration still
  carrying it. The script keeps not running on a site its header no
  longer excludes, our own matcher (badge, tab status) says otherwise,
  and nothing in the UI explains the difference.
- So the injector records which pattern fields each registration
  carries, and a spec that drops one is placed by `replaceRegistration`
  — `unregister` then `register`.
- **That is the one place the closed window reopens**, for one script,
  for the length of one call pair. The trade is narrow and in the right
  direction: a gap costs that script one navigation, and only a script
  whose match set the user is actively rewriting. The alternative is
  Chrome and our own matcher disagreeing indefinitely.

### Ordering

`orderWithOwnSpecs` emits GM runtime → bridge → user scripts, and
because `update` moves a registration to the end of the set, *how* the
calls are grouped decides the result.

- **Our own two registrations are placed first and individually.**
  Grouping the calls by kind (one `update` batch, one `register` batch)
  would put a newly-registered bridge after already-updated user
  scripts.
- **User specs then go out as batches**, since the relative order of two
  user scripts is not something we promise anyway — see
  [`@run-at` gating](#run-at-gating).
- Cross-registration ordering isn't guaranteed by the API; in practice
  Chrome runs registrations in order. The bridge doesn't actually rest
  on it (a MAIN wrapper's postMessage queues to the message task queue,
  so the listener is installed before delivery), and neither does the GM
  runtime (its bindings are spliced inside the wrap function the prelude
  invokes only after its gates resolve). Keeping the order is
  belt-and-braces — but cheap, so we keep it.

### Update, never unregister-then-register

A registration that is *staying* is replaced with
`chrome.userScripts.update`, which swaps it atomically.

- **Unregister-then-register has no safe ordering.** Drop first and a
  document created before the register lands runs nothing; register
  first and Chrome answers `Duplicate script ID`. `update` is the only
  arrangement with no gap at all.
- **`placeSpec` guesses which call to make**: `update` for an id we
  believe Chrome holds, `register` for one we don't.
- **On a refusal it asks Chrome, rather than trying the other call.**
  `getScripts` for the one id says whether it exists.
  - Trying the other call reads as symmetric and isn't. In the
    `register` direction it works — a duplicate means the id is there.
    In the `update` direction the other call is `register`, which is
    *guaranteed* to answer `Duplicate script ID` when the id really is
    there. It carries no information, and treating its failure as
    confirmation let any transient `update` failure demote a
    registration that was working — and filed our own sequencing
    against the script as Chrome's reason.
  - Asking also yields the registration's real *shape*, which is what
    says whether an `update` would silently keep a pattern field.
- **The reported reason is the real refusal**, never the second call's.
- **A refused spec for an id Chrome already holds IS unregistered.**
  Otherwise the previous version keeps injecting while the row reads
  REJECTED — and REJECTED says the script will not run.
- **The remaining `unregister` calls are all for scripts that are
  genuinely going away**: disabled, deleted, newly INVALID, the one case
  above, or a pattern field being cleared.
- **Removals do not consult our record of the set.** Every affected
  script that no longer wants a registration is dropped, whether or not
  this context believes it has one — the collections page and the viewer
  place registrations in *their* contexts, so a script the page-side
  retry placed is one the worker's record has never heard of. Every
  other wrong belief self-corrects because `placeSpec` has a second call
  to disagree with it; removal has none, so it doesn't get to guess. An
  unregister for an id nothing holds costs one refused call and is
  swallowed.

### One registration operation at a time

Placing a spec is a read-modify-write against a single mutable set, and
Chrome makes no part of it atomic.

Two of them interleaving produces `Duplicate script ID '<id>'` against
a script that is registered and *running*: one attempt listed the set,
a second placed the script, and the first then offered the id again.

- **Serialized per context.** Every operation that touches
  `chrome.userScripts` — the sync, the targeted retry, the test
  surface's teardown — runs through one promise-chain lock in
  `src/injector.ts`. Overlap used to be easy to hit: the SW-startup
  sync against the one `onCacheChanged` schedules for boot-time
  storage writes, or a collection refresh's retry against the sync its own
  writes triggered.
- **Queued syncs collapse, and their scopes merge.** A sync waiting on
  the lock has not read storage yet, so a later caller joins it instead
  of queueing a second one — but the joined sync's scope becomes the
  *union* of what everyone asked for, or nobody's rows may be dropped.
  A caller that wants a full reconcile makes the whole queued sync
  full. Callers arriving while one is *running* don't join it — that
  one's read already happened — but they still share a single new
  queued sync between them.
- **Cross-context placement is still possible.** The lock is
  per-JS-context and the collections page and viewer run the retry in
  theirs, so a page-side registration can land mid-sync. Which spec is
  newer isn't knowable from there and doesn't need to be — every
  `script:*` / `collection:*` write schedules its own sync, so the set
  converges on the last write. What matters is that the duplicate is
  our sequencing and not something to badge the script for; `placeSpec`
  is what absorbs it.
- **A failed batch `unregister` falls back to one id at a time.**
  Chrome fails the whole call if any id in the list is unknown, which
  usually means another context already dropped that one. Giving up
  would leave scripts that are *not* wanted — disabled, deleted, newly
  INVALID — still injecting, since nothing replaces them any more.

### Rejected registrations

A spec Chrome refuses is a state of its own — REJECTED — not a load
failure and not an error the script produced. See
[diagnostics.md](diagnostics.md#rejected-registrations) for the wording
rules and why it carries no location.

- **Where it lives.** `src/script-rejection.ts` keeps
  `{script id → reason}` in `chrome.storage.session`, written only by
  the injector and read by the collections page, the viewer, and the tab
  badge in `background.ts`.
- **It describes the current registration set.** A script that has
  since been disabled, deleted, or flipped to INVALID stops being
  REJECTED instead of stranding a badge nobody can clear.
- **Each writer owns exactly what it re-offered.** A full reconcile
  rebuilt everything, so it rewrites the map wholesale. An incremental
  sync and the targeted retry own only the ids they considered:
  - Clearing an entry they never re-offered would drop a REJECTED
    badge Chrome is still earning.
  - Rewriting the map from their own slice would resurrect entries
    another sync had just cleared.
  - An id they considered that produced **no** spec (disabled, deleted,
    newly ineligible) is dropped — being owned is what makes that
    happen.
- **A refresh has to force the retry.** `retryRejectedRegistrations`
  (called from every path in `script-updater.ts`) re-offers the specs
  for whichever of the scripts it just checked are rejected.
  - Without it a rejected script is never retried by a Refresh that
    finds no new content. The normal trigger is `onCacheChanged`, which
    rides on `chrome.storage.onChanged` — and a refresh that changes
    nothing raises no such event, by either of two routes:
    - It skips the write entirely for a row that didn't change (see
      [storage.md](storage.md#only-changed-rows-are-written)).
    - Chrome raises **no change event when a `set` writes a value
      identical to the stored one** anyway.
  - So nothing fires and the spec is never re-offered. For a healthy
    script that's correct (its registration already matches); for a
    rejected one it stranded the row.
  - **Targeted, not a scopeless `syncRegistrations()`.** A retry knows
    exactly which ids it is about, and a reconcile that rebuilt every
    spec would be far too heavy to run per navigation. A rejected
    script is by definition not registered, so re-offering just its own
    spec is cheaper and touches nothing else. The specs still come from
    `collectActiveSpecs`, so the retry can't drift from the sync on
    eligibility or log labels.
    - It also reaches Chrome through the same `placeSpec` /
      rejection-map bookkeeping the sync uses, so the two can't drift
      on how a duplicate id or a cleared badge is handled.
  - The per-script call is deliberately **not awaited** — it must not
    sit in the reload fast-path's 500 ms window. Same reasoning as the
    version probe beside it.
- **Everything that re-checks a script retries it**: the viewer's and
  collections page's Refresh, refresh-collection, refresh-all, and the
  opportunistic check a navigation to a matching page fires. That last
  one matters because the page in front of the user is where the script
  visibly didn't run.
- **At most one automatic attempt per `REJECTION_RETRY_MIN_INTERVAL_MS`
  (10 s).** One navigation fans out into many checks of the same script
  — the reload fast-path plus an opportunistic check per commit event,
  per frame — so without a floor a single page load re-offered the spec
  ten times and wrote ten identical Log rows.
  - A genuine Refresh click bypasses the floor: `probe === 'force'` is
    the only signal the updater has for "the user clicked" (`mode:
    'manual'` just means "not rate-limited", and the fast-path uses it
    for every matched script on every reload). The user asked, so they
    get an answer every time.
  - The floor limits **attempts**, not reporting. Every attempt that is
    refused still writes its row; the answer to a burst is to try less
    often, not to hide what happened.
  - It's module state, and **per JS context**: the collections page and the
    viewer import `script-updater.ts` directly, so their Refresh runs
    the retry — and its own copy of the floor — in the page rather than
    the worker. Each context rate-limits its own automatic retries.
    Harmless, because a click bypasses the floor anyway and the
    rejection map they all read is shared, but it is not one global
    counter.
  - `resetAllState` clears the worker's copy
    (`resetRejectionRetryGate`) — otherwise one e2e test's retry
    silently suppresses the next one's.
- **A fix needs no extra user action**, and is logged: the retry that
  succeeds drops the script from the map, so REJECTED clears, and
  `logRecoveries` writes the matching info row.
  - The row does **not** go back to OK on its own. `loglevel:` is
    monotonic within a session, so the refusal's error rows keep the
    status at ERROR until the log is cleared. That is the same residual
    badge every recovered failure leaves here — see
    [storage.md](storage.md#displayed-status-ui-level) and the sentinel
    note in TODO.md — not something specific to REJECTED.
- **Every refused attempt gets a Log row**, including a re-sync that
  gets the same reason for the same content. The retry is what's being
  reported: a suppressed retry looks exactly like no retry, and a
  "Clear log" followed by a Refresh would otherwise leave a REJECTED
  row with nothing explaining it.
  - The corollary is that **one change must not produce two attempts**.
    Duplicate rows are fixed by not offering the spec twice, never by
    suppressing the second row — the rule above is what makes the Log
    trustworthy. The case that bit: a debounced sync draining the
    accumulated scope, and the `syncNow` behind it reading "nothing
    pending" as "reconcile everything".
  See
  [script-log.md](script-log.md#when-the-log-stays-quiet) for the cost
  (a persistently refused script fills its own log) and why it's
  accepted.
- **Rarer than it was.** The malformed `@match` shapes we are sure
  about are caught at parse time and never reach a registration, and
  the two Chrome merely can't spell are rewritten into a spelling it
  takes (see
  [matching.md](matching.md#lenient-readings-canonicalmatchpatterns)).
  What
  still lands here is the rest of Chrome's grammar — a port out of
  range, a host its canonicalizer rejects — which we don't reproduce
  because a false positive would drop a working pattern.
- **Not predictable earlier.** The install preview and the early stages
  of a refresh can't show REJECTED for those: nothing has been offered
  to Chrome yet.

## What gets registered

For each `status: 'ok'` script whose own `enabled` flag **and** parent
collection's `enabled` flag are both true, we build a
`RegisteredUserScript`:

- `id` — the stored script UUID.
- `matches` — `@match` patterns in their canonical spelling (see
  [matching.md](matching.md#lenient-readings-canonicalmatchpatterns);
  one pattern can expand to more than one), minus any Chrome's grammar
  would still refuse — one of those would take the whole registration
  down.
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

This wait runs alongside the `sm:check-pending` round-trip rather than
after it — see [Concurrent gates](#concurrent-gates).

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
- `// @inject-into auto` / unspecified →
  - MAIN when there are no `@grant` entries or every `@grant` is
    `none`,
  - MAIN when `unsafeWindow` is granted (see below),
  - USER_SCRIPT otherwise.

Why a `@grant none` script defaults to MAIN: scripts that opt out of
`GM_*` (the conventional `@grant none` declaration) almost always
intend to talk to the page directly — read its globals, call its
functions, hook its jQuery. Running them in the isolated world
silently breaks any such script. Tampermonkey runs `@grant none`
scripts in page context for the same reason.

#### `unsafeWindow` forces MAIN world

`unsafeWindow` is defined as **the page's** `window`. Everything else
follows from that:

- Chrome's isolated worlds each get their own `window` per document.
  There is no synchronous channel between an isolated world and the
  page's realm, and `unsafeWindow.foo` is a synchronous property read —
  so no proxy or bridge can stand in for it.
- Therefore the only way to honor the grant is to run the script where
  the page's window already is. `@grant unsafeWindow` resolves to MAIN,
  and the binding is the same `const unsafeWindow = window;` we always
  emitted — what changed is which realm that `window` belongs to.
- TM and VM land in the same place by different routes (TM's
  `@sandbox JavaScript`, VM's page-context injection); both give a
  Chrome script `unsafeWindow === window`.

The isolated-world case that remains:

- `@inject-into content` is an explicit request for isolation and wins
  over the grant. `unsafeWindow` is then that world's own `window`,
  matching VM's content mode.
- Because every page global reads as `undefined` there, that
  combination is **not** left silent: `extractStartupLogs`
  (`src/script-store.ts`) attaches a `warn` startup log, which surfaces
  in the page console and the viewer's Log tab on every matching load.

Scale of the change: of the top 2000 GreasyFork scripts, 224 grant
`unsafeWindow` and 213 of those set no `@inject-into`, so they had no
way to opt into MAIN world themselves. 158 of the 213 also grant real
`GM_*` APIs — which is why moving them required bringing the GM
runtime along, below.

#### `GM_*` in MAIN world

Moving a script to MAIN can't cost it the rest of its grants, so the
whole `GM_*` surface works there too.

- `src/wrapper-gm-runtime.js` — the same source — is registered in
  MAIN as well as USER_SCRIPT (`buildGmRuntimeSpecs`). It detects at
  init whether `chrome.runtime` is reachable and picks its transport
  accordingly. One implementation, two transports; no second copy to
  drift.
- Page → SW requests go out over `wrapper-bridge.js` as
  `sourcemonkey-bridge` postMessages with a `requestId`, the same
  request/reply shape `sm:check-pending` already used.
- SW → page pushes (XHR events, cross-tab value updates, menu fires)
  arrive at the bridge on `chrome.runtime.onMessage`, which MAIN world
  can't listen on; the bridge re-posts them as
  `sourcemonkey-bridge-push`.
- Registration is **per world, per need, and per pattern**:
  - A world only gets the runtime when some active script there grants
    an API that needs it. `GM_info` (a baked literal) and
    `unsafeWindow` (a `window` alias) don't, so an ordinary
    `@grant none` MAIN-world script leaves no `window.__SM_GM__` on the
    page.
  - Its `matches` / `includeGlobs` are the union of those scripts' own,
    not `<all_urls>`. In MAIN world the runtime is a page-visible
    global — a fingerprint and an attack surface — so installing one
    such script must not put it on every page the user visits.

##### Trust model

- In MAIN world `window.__SM_GM__` is a global in the page's own realm.
  The page can call it, and can forge messages in both bridge
  directions. That is inherent, not a leak we can plug: separate
  `chrome.userScripts` registrations can only hand each other
  references through a shared global, and any secret baked into
  MAIN-world source is readable once the page steals the wrap function
  (`self.__smRun` is a page-realm global too).
- What we do bound is the **service worker** side.
  `bridgeMayActAs` in `src/background.ts` honors a bridge-relayed,
  script-scoped request only when the named script actually runs in
  MAIN world on the sending frame's URL — i.e. only for scripts whose
  GM surface the page could already reach directly. It fails closed on
  an unknown id, a non-matching URL, or a missing sender URL.
- The **return** direction needs the same discipline. A push the bridge
  re-posts becomes readable by the page, and pushes carry real payloads
  — a script's stored values on `sm:gm-value-update`, a cross-origin
  response body on `sm:gm-xhr-event`. So the SW stamps every push with
  the destination script's world (`pushWorld`, backed by
  `scriptWorld` in the match index) and the bridge relays only
  `smWorld === "MAIN"`. Unknown ids stamp as USER_SCRIPT, so it fails
  closed.
- Consequences: a page still cannot touch a USER_SCRIPT-world script's
  GM values (the pre-existing read-leak fix still holds — see
  `tests/e2e/gm-storage-read-leak.spec.ts`), cannot read its broadcasts
  or XHR responses just by running a MAIN-world script alongside it,
  and cannot drive a MAIN-world script scoped to some other site.
- `sm:gm-xhr-abort` and `sm:gm-tab-close` are deliberately ungated:
  they name a per-call random request id, not a script, and cancelling
  a request the page can already observe gains it nothing.
- **Failing closed has a cost.** The gate decides "does this script
  match this URL?" with our own matcher (`url-match.ts`), while Chrome
  decided whether to inject with its. Where the two disagree, a
  legitimate MAIN-world script would be refused. For a storage-granting
  script that means no snapshot, which the GM prelude treats as fatal —
  it reports `sm:error` and doesn't run the body. Loud rather than
  silent, and the same matcher agreement the badge already depends on
  (see [matching.md](matching.md)), but it is a new way for a
  divergence to bite.

##### Costs of running in MAIN

- **Page CSP applies to DOM injection.** `GM_addStyle` /
  `GM_addElement` are CSP-exempt in USER_SCRIPT world but not in MAIN.
  A page whose `style-src` omits `'unsafe-inline'` will drop an
  injected `<style>`'s rules on the floor.
- **The page can interfere.** It shares prototypes and globals with the
  script. The runtime's shim cache is captured at `document_start`,
  before any page script, so its own natives are pristine — but user
  code in MAIN is on its own.
- **Storage flushes are less durable at teardown.** A MAIN-world flush
  leaves as a postMessage the bridge picks up in a later task; during
  `pagehide` the document may go away first. USER_SCRIPT-world scripts
  hand theirs straight to `chrome.runtime`.
- **One extra hop per call.** Every `GM_*` SW round-trip pays the
  postMessage relay, like `sm:check-pending` already did from MAIN.

#### MAIN-world traffic — the bridge

`chrome.runtime` is not exposed to MAIN-world scripts, so neither the
wrapper's `sm:start` / `sm:error` reports nor the GM runtime's SW calls
can reach the service worker directly from MAIN. `src/wrapper-bridge.js`
is the relay.

What crosses it:

- **Fire-and-forget reports** — `sm:start` / `sm:error` / `sm:swapped` /
  `sm:abandoned` from `send` in `userscript-prelude.js`.
- **Request/reply** — anything posted with a `requestId`:
  `sm:check-pending` from the prelude, and every SW-backed `GM_*` call
  from the MAIN copy of `wrapper-gm-runtime.js`. The bridge always
  replies, even on failure, so the caller's awaiter settles instead of
  running out its timeout.
- **SW-originated pushes** — `sm:gm-xhr-event`, `sm:gm-value-update`,
  `sm:gm-tab-closed`, `sm:gm-notification-event`, `sm:gm-menu-fire`.
  Those arrive on `chrome.runtime.onMessage`, which only USER_SCRIPT
  world can listen on, so the bridge re-posts them into the page as
  `sourcemonkey-bridge-push`.

Mechanics:

- `send` in `userscript-prelude.js` feature-detects
  `chrome.runtime.sendMessage`. In USER_SCRIPT world it calls it
  directly; in MAIN world it falls back to `window.postMessage({ __sm:
  "sourcemonkey-bridge", payload })`. The GM runtime's `transportSend`
  makes the same choice.
- The bridge validates the marker + `event.source === window`, checks
  the payload type against an allowlist per direction, and forwards.
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
- Script-scoped requests — a `sm:check-pending` asking for `gmValues`,
  or any `sm:gm-*` call — are gated. The bridge stamps
  `__viaBridge:true` on every message it relays (set last, so the page
  can't pre-set it false), and the SW's `bridgeMayActAs` honors such a
  request only for a script that runs in MAIN world on the sending
  page. Reading a USER_SCRIPT-world script's GM values stays blocked,
  which is the original read-leak fix. See
  [`GM_*` in MAIN world](#gm_-in-main-world), `docs/GM-APIs.md`, and
  `tests/e2e/gm-storage-read-leak.spec.ts`.

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
  = ...`, etc.) and the GM prelude (`storage.init`) into the
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

The regular `chrome.runtime.onMessage` event carries one type, from our
own extension PAGES rather than from any script:

- `sm:fetch-bytes` — a page asking the SW to make an http(s) read for
  it, because a document-initiated fetch acts on the response's
  `Link: rel=preload` headers. The handler checks `sender.url` against
  our own origin: the extension holds `<all_urls>`, so answering
  anyone would be an open fetch proxy. See
  [logging.md](logging.md#keeping-the-errors-panel-clean).

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
   `RELOAD_FAST_PATH_WINDOW_MS` (500ms) measured from **reload commit**,
   not from when setup finished — a slow `ensureLoaded()` eats the
   budget rather than extending it. See `startedAt` in
   `setupReloadFastPath`.
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

Every outcome names where the budget went (`asked at Nms, waited Mms`),
and debug logging adds a phase breakdown per script — see
[Measuring a missed reload swap](diagnostics.md#measuring-a-missed-reload-swap).
What the first measurements found, on a 3-script page with an edited
local file:

- **The parse check dominated a changed script** — 448 of a 450 ms
  `rebuild`. It only runs for content that changed, and it pays to open
  an offscreen document; the run right after an extension update, which
  invalidates every cached verdict, cost 2306 ms. Taken off this path —
  see [Parse check off the critical path](#parse-check-off-the-critical-path).
- **The batch used to duplicate its own work.** Scripts matching the
  same page usually share a collection and a folder, and each check
  re-read that row and re-listed that directory. On one thread the
  duplicates landed in each other's measured time — which is why the
  tiny collection row read slower than a 63 KB script row. Fixed by
  the shared batch below.
- **Dependency rechecking is not the cost it looks like.** `manual` mode
  selects `recheckFiles: 'all'`, but measured `deps` was 0.3 ms — the
  risk is real only for a script with HTTP `@require`s.
- The registration sync a refresh triggers is **not** awaited here (the
  swap hands the body over directly), but it reads every row in storage
  and competes for the same thread.

### Purple flash while a swap lands

A swap that works leaves nothing on screen: the new body runs at
document-start and the badge goes straight to green, so it reads the
same as a reload that changed nothing.

The only purple the user ever saw was the *failure* — swap missed its
window, old body ran, [RELOAD badge](matching.md#stale-tab-notification)
asking for a second reload.

So the badge blinks purple on the way through, and the two outcomes
read differently:

- **brief purple, then back** — an update landed on this page;
- **purple that stays up** — reload again to pick the update up.

Mechanics (`reloadFlashByTab` in `background.ts`, in-memory only —
an SW restart means no wrapper is waiting on us):

- Purple goes up when `handleCheckPending` decides `run-new`, and the
  script id joins the tab's pending set. A second script swapping on
  the same reload joins the flash rather than restarting it.
- It comes down when every pending script has sent any `sm:*` report —
  keyed on the id, not the message type, because a wrapper that fell
  back to its baked-in body (page CSP refused the eval) reports
  `sm:start`, not `sm:swapped`. Reports from a *different* document
  don't count: a late one from the page we navigated away from carries
  the same ids.
- `RELOAD_FLASH_MIN_MS` (1.2 s) is a floor: the decision → `sm:swapped`
  round trip is a few milliseconds, which would paint and unpaint
  inside one frame.
- `RELOAD_FLASH_MAX_MS` (5 s) is the backstop for a wrapper that never
  reports, so purple can't stick around looking like the RELOAD state
  it deliberately mimics.
- It's a paint-time override in `renderBadge`, not part of
  `computeBadge`: it describes a swap in flight rather than the tab's
  expected/actual sets. RED still wins — an error the user must act on
  outranks a progress signal.
- The flash records its `documentId`, and a commit for a different
  document in the same tab drops it — including a commit to a
  non-injectable URL, which is a departure like any other. Keyed on the
  document because the flash starts *after* the commit it belongs to
  (the wrapper asks at document-start), so "any navigation clears it"
  would race the swap it is announcing.
- For the same reason a swap for a different document *replaces* the
  flash rather than joining it: on a fast second reload,
  `handleCheckPending` (answered off the message listener) can beat the
  new commit's queued `updateTabMatches` to it.
- A swap that joins a drained flash re-arms the floor and the backstop,
  so a `document-end` wrapper asking later than a `document-start` one
  gets a blink of its own rather than the tail of someone else's.

Two things it deliberately doesn't do:

- **The tooltip is unchanged.** It describes the tab's scripts, and the
  hover it would serve can't happen inside 1.2 s.
- **A terminated worker leaves the paint behind.** Chrome keeps the
  badge color it was last given, and the flash state doesn't survive
  the worker — so an extension reload mid-flash leaves purple up until
  the next navigation or `sm:*` report repaints. Rare (the backstop is
  well inside the keep-alive) and self-healing.

### Shared work across the batch

**The batch covers navigation-triggered checks generally, not just the
reload fast path.** One `RefreshBatch` (`src/script-store.ts`) is
created per `onCommitted` and handed to *both* fan-outs that commit
starts — the fast path and the opportunistic sweep in
`updateTabMatches`. A sweep reached any other way
(`onHistoryStateUpdated`, the `chrome.tabs.onUpdated` fallback) makes
its own, so no navigation-driven fan-out ever runs unbatched — though
"its own" is per *call*, not per navigation: the `tabs.onUpdated`
fallback fires `updateTabMatches` twice for one navigation and so makes
two batches. Harmless, since the second sweep is rate-limited out.

The batch caches what those checks would otherwise each do separately:

- the **collection row**, read once per collection id;
- the **`file://` directory listing**, fetched once per directory;
- the **`@require` / `@resource` bodies**, via the same `fileFetchCache`
  `refreshAllCollections` already threads across collections.

Rules it lives by:

- **Scoped to one commit, no TTL, never global.** That bound is the
  whole safety argument, and it is *not* "the calls all start together"
  — they don't. The fast path fans out after one `ensureLoaded()`; the
  sweep runs inside `enqueueTabWork` and does `ensureLoaded()` plus two
  session-storage round-trips first.
  - So an entry can be written at T0 and read at T0+Δ, Δ being
    page-load scale and widest on a cold worker or a backed-up tab
    queue.
  - The consequence is real but small: a script that joined the match
    set inside Δ reads a listing captured before it started, so a save
    landing in that window looks unchanged and waits for the next
    check. One navigation late — the same lateness a non-reload
    navigation has always had.
  - A cache outliving the commit would make that window unbounded, and
    would need invalidation to be safe at all.
- **Single-script path only.** `refreshCollection` /
  `refreshAllCollections` have their own sharing story (one scan per
  collection, one `fileFetchCache` across them) and are not given one.
- **A coalesced call inherits the running check's batch, and that is
  safe.** `gate()` already hands the second caller the first call's
  whole result, so which cache produced it changes nothing.
- **One batch per commit, not one per fan-out.** A batch each would
  leave the page listing its folder twice — better than once per
  script, but not the intent. Sharing also makes the rule independent
  of which call reaches `gate()` first, the same ordering trap
  `parseCheck` had to be fixed out of.
  - On a *reload* the sharing is belt-and-braces: for the scripts the
    fast path has in flight, the sweep either coalesces onto them or is
    rate-limited out, so it does no reads of its own either way. What
    the shared batch actually buys is a script that joined the match set
    between the two calls.
  - The case that genuinely needed fixing is the **non-reload
    navigation**, where the sweep is the only fan-out and used to run
    one collection read and one listing per script.
- **The phase timer still reports the phases**, annotated
  `collection row shared with batch` / `listing shared with batch` — a
  shared read reads as shared rather than as a phase that vanished. See
  [diagnostics.md](diagnostics.md#measuring-a-missed-reload-swap).
- **Its benefit was invisible until a bigger cost was removed.** On a
  real 192-script profile the annotations confirmed one read and one
  listing, yet `read-collection` didn't move — because a
  full-namespace storage scan was holding the worker thread across the
  whole window. With that gone, joiners cost 12–14ms against the
  owner's 44ms. See
  [diagnostics.md](diagnostics.md#read-collection-is-still-slow) — the
  false starts are recorded there on purpose.

### Parse check off the critical path

`setupReloadFastPath` calls `updateScript(..., parseCheck: 'defer')`.
The refresh reads, hashes and composes the fresh row as before, but
hands it back **without** the compile-only verdict, so the reply can go
out while the check is still to come.

- The check still runs: `refreshScript` calls
  `checkParsesInBackground` on the row it just wrote, and the verdict
  is merged in when it lands. See
  [parse-check.md](parse-check.md#deferring-the-check-on-the-reload-fast-path).
- **Navigation-triggered checks defer; user-initiated ones wait.** The
  opportunistic sweep passes `'defer'` too. It has to: it is queued off
  the same `onCommitted`, and `gate()` coalesces the two calls
  regardless of which arrives first, so a split rule would let the
  opportunistic call decide for the fast path. Install, the Refresh
  buttons, Refresh All and the offline CLI all wait for the verdict.
- Content that didn't move still costs nothing either way — the
  `parseCheckedHash` short-circuit is applied before the mode is
  consulted.
- **An http(s) entry with a prior good copy still waits**, whatever the
  trigger. Deferring its verdict would defeat the "a 200 that doesn't
  parse is a login page, keep the prior copy" rule — see
  [parse-check.md](parse-check.md#deferring-the-check-on-the-reload-fast-path).

#### What it costs

- **One extra row write** per *changed* script, carrying the verdict,
  plus the sync that write schedules. Both land after the reply.
- **Not an extra compile.** The row is written without a
  `parseCheckedHash`, so the registration gate would find it stale and
  compile the same bytes again — `verifyParseChecks` therefore joins a
  check already in flight for the same row and fingerprint instead of
  starting a second one.
- **The sync can wait where the reply no longer does.** That compile
  has to finish before Chrome is offered the body (see
  [parse-check.md](parse-check.md#the-gate-before-registration)), so
  deferring moves it off the wrapper's critical path, not off the
  navigation's entirely. What the user notices is the swap; the sync
  only decides what the NEXT navigation gets.

#### A broken edit gets swapped in

`handleCheckPending` gates the swap on `status === 'ok'`, and with the
verdict outstanding a body with a syntax error reads as `ok`. So the
new body IS handed over, and it throws in the page instead of the
previous version quietly continuing to run.

- **That is the intended behaviour.** The check has always been allowed
  to fail open (no offscreen document, sandbox unavailable → the row
  stays `ok`), and this is the same state for a shorter time.
- **It is reported, but not by the seal entry.** The seal rides on the
  *registered* program, which on this path is the previous body — it
  parses, so the seal never fires. The `try`/`catch` around the swap
  eval in `userscript-prelude.js` is what catches the `SyntaxError`; it
  sends `sm:error`, which turns the badge red and writes the Log entry.
- A developer who just typed the error is better served seeing it than
  watching the version before it run.
- The window is one navigation wide: the deferred verdict flips the row
  to `invalid`, which unregisters the script for the next one.
- **An `invalid` row doesn't heal on its own.** It leaves the match
  index (`toEntry` admits only `ok` / `missing`), so neither the reload
  fast path nor the opportunistic check looks at that script again —
  fixing the file on disk takes a Refresh, on the collections page or
  in the viewer. Pre-existing, and more visible now that `invalid` is a
  normal step in the edit loop.

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
- **Swap replies read the new row instead.** `handleCheckPending`
  loads the snapshot itself when the body it's about to hand back
  grants storage, whatever the wrapper asked for — see the storage
  bullet under [Wrapper protocol](#wrapper-protocol).

See [GM-APIs-storage.md](GM-APIs-storage.md) for the full storage
model.

### Wrapper protocol

The prelude initializes each script's entry, runs the matcher
(which marks the entry inactive on a miss), installs async-error
listeners, then arms **both** gates at once — see
[Concurrent gates](#concurrent-gates). The decision callback receives
`{action}` and branches:

- `run` — the body runs once the declared `@run-at` gate has also
  fired; at that point the prelude sends `sm:start` and calls the
  main-body wrap function. Sync throws are caught and reported as
  `sm:error`.
- `run-new` — calls indirect `eval` with the SW-supplied body
  string plus `//# sourceURL=`. Sends `sm:swapped` and records the
  new `loadedAt` so subsequent async errors attribute to the new
  body. The body `buildSwapEvalBody` hands over is laid out exactly
  like a registered entry, and carries the same inline source map, so
  devtools and the viewer's Log tab report original coordinates for a
  hot-swapped script too. That parity is load-bearing and easy to
  break — see `src/composed-source.ts`, which describes both layouts.
  **Scope caveat:** the swap eval runs at the prelude's function
  scope, not inside the main-body wrap function's closure, so the
  GM_* bindings spliced into the wrap function are NOT visible to
  the swap-evaluated body. `buildSwapEvalBody` compensates by
  prepending the script's own binding block (including the eager
  `resource.init` / `urlchange.enable` / `windowControl.enable`
  calls) to the body it hands
  over. See [GM-APIs.md](GM-APIs.md#bindings-layout-in-the-wrapper)
  for how that block is split.
- **Storage grants on a swap.** The one emitted call that can't be
  prepended is `storage.init` — it reads the snapshot off
  `__smDecision`, which an indirect eval's global scope doesn't
  have. So:
  - The SW sets `seedValues` on the `run-new` reply, computed from
    the **new** script row, and makes sure a `gmValues` snapshot is
    attached. It's an instruction ("seed the cache before you eval"),
    unlike the payload's `needsValues`, which is the wrapper's own
    request based on the registered grant set.
  - The prelude runs `storage.init` itself, in its own scope, right
    before the eval.
  - Missing snapshot or missing runtime → no swap. The prelude logs
    and falls through to the baked-in body, whose own snapshot
    handling (including the hard abort) still applies. Reading an
    empty cache would make a read-modify-write script overwrite the
    user's real values.
  - Computing `seedValues` from the new row is what makes a refresh
    that **adds** a storage grant work: the registered wrapper never
    asked for a snapshot, so the SW loads one itself.
- `skip` — sends `sm:abandoned` and exits without running anything.

Prelude-side safety timeout (2s) protects against the SW vanishing
mid-handshake; on hit it defaults to `run` so the baked-in body
still executes.

### Concurrent gates

The check-pending round-trip and the `@run-at` wait are armed together
in `initScript`, not chained. `flushPending` is the join: it needs a
settled decision **and** `runAtFired`, so the body starts at
`max(decision, run-at)`.

- Never earlier than the decision — a `run-new` swap can't be missed.
- Never earlier than the declared `@run-at` — a `document-end` script
  can't run at document-start.
- `skip` wins whichever order it lands in: `flushPending` re-checks it,
  so a body queued by an already-fired `@run-at` gate is still dropped.

Why it matters:

- For every `@run-at` but `document-start` the wrapper was going to
  wait on a lifecycle event anyway. On a page slower to reach that
  event than the SW is to answer, the decision wait is free.
- That turns the reload fast-path's window from "a race the wrapper
  can lose" into "a budget that only bites when the refresh is slower
  than the page".
- Arming the lifecycle listener up front also decouples it from the
  decision callback running at all.

`document-start` gets no free wait — `waitForRunAt` calls back
synchronously — so the decision is its only gate, and the 2s safety
timeout remains the hard ceiling for every `@run-at`.

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
- **World changes defer the swap.** Adding a script's first real
  `@grant` moves it MAIN → USER_SCRIPT, but the running wrapper is
  stuck in the world Chrome injected it into, and USER_SCRIPT
  bindings dereference `window.__SM_GM__`, which MAIN doesn't have.
  A request relayed over `wrapper-bridge.js` is by definition from a
  MAIN wrapper, so that plus a USER_SCRIPT new row means "defer to
  the next reload". The reverse direction is safe — a MAIN-only
  build is just the `GM_info` literal.
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
  - **What it would break:** the menu-command registry
    (`src/gm-menu.ts`) holds ONE `documentId` per tab, and a register
    naming a different document replaces the state. That is safe only
    because every wrapper in a tab shares the top-level document
    today. With scripts in subframes, a subframe register and a
    top-frame register name different documents and would clobber
    each other's commands, alternating as each fires.
  - Whoever flips `allFrames` needs to key that registry by
    (tabId, documentId) and merge across a tab's live documents for
    the menu render — and to decide what a navigation clear means
    when only one frame navigated. See
    [GM-APIs.md](GM-APIs.md#lifecycle).
