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

### How Violentmonkey uses the same API

Worth knowing when comparing behavior, since "both use
`chrome.userScripts`" hides the interesting part. Verified against
VM 2.48.0.

- **VM registers its own injector, not your scripts.** One
  registration for `<all_urls>` carries VM's content bundle; VM keeps
  its own URL matcher and decides what to run. We hand Chrome one
  registration per script and let Chrome match.
- **VM's content-realm userscripts run via
  `chrome.userScripts.execute`** — a per-navigation call, which is
  why its MV3 build needs Chrome ≥ 135. Ours are declarative, so no
  worker wake-up sits on the injection path.
- **VM's page-realm scripts don't use `world: 'MAIN'`** — they go in
  through a `<script>` element appended from the content realm, so a
  page CSP can block them and VM falls back to running them in the
  content realm. Our MAIN-world registration isn't subject to page
  CSP, so `@inject-into page` means what it says.
- **VM registers a second script per URL to carry its data.** The
  payload for one page is `JSON.stringify`d into a
  `chrome.userScripts.register` whose `matches` is that exact URL,
  registered ahead of the injector. We bake each script's data into
  that script's own registration instead, so nothing is keyed by URL.
- **VM has an opt-in path that beats the parser.** With "synchronous
  page mode" on (`xhrInject`, off by default), a DNR rule appends a
  `Set-Cookie` naming a blob and the content script reads it with a
  *synchronous* XHR at `document_start` — for scripts that would
  otherwise run too late. We have no equivalent.

## One-time user opt-in

Chrome requires an explicit user toggle before the API will execute:
the **"Allow User Scripts"** switch on the extension's details page
(`chrome://extensions/?id=<extId>`).

- Not a SourceMonkey quirk: Violentmonkey's MV3 build prompts for the
  same toggle, then tells the user to reload the tab.
- Chrome below 138 used the browser-wide Developer mode toggle instead.
  That is under the extension's Chrome 152 floor, so only the one case
  is live.

Until the user flips that, **every** `register()` call throws. The
badge logic is unaffected (it's local code, not the userScripts API),
so the toolbar still counts matches — only injection is blocked.

The collections page probes the API at render time and shows a banner with
a copy-pasteable `chrome://extensions/?id=<id>` link when the call
fails.

## Lifecycle

`src/extension/injector.ts` owns Chrome's registration set.

- **On SW startup** — `syncRegistrations()` runs with no scope, in
  parallel with the match-index load.
  - That first sync may take the last worker's record. See
    [Startup: the record, or a full reconcile](#startup-the-record-or-a-full-reconcile).
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
- **One-time world config** — `chrome.userScripts.configureWorld()`
  is called before the first `register()`.
  - `messaging: true` lets the injected wrapper call
    `chrome.runtime.sendMessage` back to the SW.
  - `csp: "script-src 'self' 'unsafe-eval' 'unsafe-inline' *"` is the
    USER_SCRIPT world's own CSP. `'unsafe-eval'` lets the reload
    fast-path eval the script body.
  - Chrome also checks `<script>` elements inserted from this world
    against it, instead of the page's CSP. `'unsafe-inline'` and `*`
    let userscripts inject page code (inline, or by `src`), which is
    otherwise refused on every page.
  - The new capability this grants: userscript-inserted `<script>`
    elements run in the page realm even under a strict page
    `script-src`. Tampermonkey 5.5 sets the same world CSP, so it
    allows this too.
  - Inline event handlers and `javascript:` URLs a userscript adds
    stay under the page CSP.

### The sync is incremental

Only the rows that moved are rebuilt, and a script that is staying
registered is **updated in place**.

1. Expand the scope — a collection row that appeared, went away, or
   flipped its enabled flag moves every script under it.
2. `chrome.storage.local.get([...])` for just those rows, without
   their bodies. Not `get(null)`, which pulls every script body and the
   favicon cache.
3. Read the bodies of the scripts among them that will be registered
   (`withBodies`), and rebuild specs for those only. A sync that only
   removes registrations (a script or collection turned off) reads no
   bodies.
4. `unregister([...])` for scripts that left the set and that this
   worker believes Chrome holds.
5. Nothing for a script whose rebuilt registration, code and settings,
   hashes the same as the one an incremental sync placed (`specHash`
   on the record). A row change the registration doesn't show, such as
   a refresh that only moved the file's modified time, then costs
   Chrome nothing.
   - Only incremental syncs hash, for the few scripts they rebuild; a
     full sync doesn't stringify every script's code for it. So the
     first incremental sync of a script after a full one sends it.
   - Not when one of our own registrations is sent too: an updated
     helper can move behind the user scripts in Chrome's order, and
     sending these again keeps them after it.
   - It trusts the record, as the rest of an incremental sync does; a
     full reconcile corrects a wrong one.
6. `chrome.userScripts.update([...])` for ids Chrome already holds,
   `register([...])` for genuinely new ones, and unregister+register for
   the narrow case `update` cannot express (see
   [What `update` cannot change](#what-update-cannot-change)). Chrome
   applies a batch all-or-nothing, so a rejected batch falls back to
   per-spec calls and one bad script can't take down every other one.
7. `unregister([...])` for the rest of the scripts that left the set,
   which Chrome may hold though this worker's record says not, and for
   any script Chrome just refused that it already held (see
   [Update, never unregister-then-register](#update-never-unregister-then-register)).
   Usually Chrome holds none of the former, which fails the batch call
   and falls back to one call per id, so they wait until after
   registering.

Removals go before registering. When a change swaps one copy of a
script for another, a page loading in between then gets neither copy
rather than both, so the script never runs twice. A reload fixes the
missing one.

Our own helpers (the GM runtime, the bridge) are updated **without
their code** when only their patterns moved.

- `update` keeps any property it isn't given, and the GM runtime's code
  is over 100 KB.
- Their code is fixed when the extension is built.
- A worker's first sync places them with code: a full one does, and a
  record is taken only from a worker of the same version, whose first
  sync did (see [Startup: the record, or a full reconcile](#startup-the-record-or-a-full-reconcile)).

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

#### Startup: the record, or a full reconcile

Chrome retains registrations across service-worker restarts, and rows
change while the worker is dead — so a fresh worker can't diff against
nothing: that would strand stale registrations.

- **The last worker's record, when it left one.** The sync's record is
  saved in session storage, which outlives a stopped worker but not a
  browser or extension restart. A new worker's first sync takes it, and
  syncs incrementally only the rows that changed since (`restoreRecord`
  in `src/extension/injector.ts`):
  - Saved once syncs have been quiet for two seconds, not after each
    one: every session write reaches every open extension page. A small
    marker written before a sync changes Chrome's set says the saved
    record may be stale until then; a worker that finds it reconciles
    in full.
  - The record also keeps a fingerprint of each script and collection
    row as the syncs read it. A row whose fingerprint differs, or that
    appeared or went away, is in the scope.
    - A script's fingerprint leaves out `versionProbes`, which a probe
      rewrites without a sync; a collection's is only whether it is
      enabled, the one field the sync reads, to keep the record small.
  - Taken only when made by this extension version, and when Chrome
    still holds our helpers with the patterns the record last gave them
    (`stillHeld`). Only the helpers: there is no ids-only call, and
    asking for every registration returns all their code. A wipe of the set takes the helpers too. With no helpers, one
    user script is checked instead.
    - Not caught: a single user script dropped while the helpers stay.
      Only our own syncs drop one, and they save the record after.
  - A script row's fingerprint is its JSON, keys in the order the row
    cache and storage keep them (sorted). A row read in another order
    would only be synced again.
  - Removed when it's dropped on purpose (`forgetRegistrationState`,
    `unregisterAllRegistrations`).
  - Its own timing line, `registration record`, says whether it was
    taken and, if not, why.
- **Otherwise, a full reconcile**, below.

- A sync is incremental only when this worker holds a record of
  what it last registered. `src/extension/injector.ts` keeps one — ids, worlds
  and pattern shapes, every script's basename, log label and
  collection, and the collection rows. No script bodies, so it stays
  small.
  - The label is in there because a script *arriving* renumbers the
    dupe group it joins (a lone `main.user.js` becomes
    `main.user.js#1`), and the label is baked into the registered
    `//# sourceURL=` directives. Every script whose label just moved is
    rebuilt too, however untouched its own row is.
- With no record, the sync reads every script and collection row,
  rebuilds every spec, and reconciles against
  `chrome.userScripts.getScripts()`: everything wanted is updated or
  registered, and only ids Chrome holds that storage no longer wants are
  dropped. **Still not a wipe** — a script that survives the restart is
  never unregistered.
  - Bodies are read only for the scripts it registers.
  - `getScripts()` returns each registration's code and settings too.
    A spec Chrome already holds exactly (code, patterns, world, run
    time: `sameRegistrations`) gets no call at all, so a worker start
    with nothing changed sends Chrome nothing. Every call costs about
    the same however little it carries (Chrome saves the set and sends
    it to every renderer), so skipping them is most of a start's sync.
  - An update whose code alone is what Chrome holds leaves the code out
    (`sameCode`). For our helpers that is a pattern change; a user
    script's code carries its own patterns, so its code changes with
    them.
- The record in memory is dropped whenever it stops being trustworthy.
  The next sync then reconciles fully, which also covers whatever ids
  a failed sync consumed. It is dropped by:
  - a sync that throws part-way;
  - `forgetRegistrationState` (the parse checker turned back on). A
    sync already running when it is called drops its result too;
  - a sync that finds the `chrome.userScripts` API unavailable;
  - `unregisterAllRegistrations` (the test surface's teardown).
- All but the throwing sync remove the session copy too. A sync that
  throws leaves it, but if it had changed Chrome's set it wrote the
  stale marker first, so the next worker reconciles in full.
- A full reconcile also covers the bridge and GM-runtime registrations,
  whose code ships with the extension and changes on update. The same
  comparison applies to them: one Chrome holds exactly gets no call.

#### What an incremental sync must not disturb

- **Annotation-only writes.** Two fields no spec reads are written on
  their own:
  - `versionProbes`, an update check's result. A Refresh All writes one
    per script, so counting those as cache changes cost a
    re-registration per probed script. See
    [Measuring](diagnostics.md#measuring-where-a-refreshs-time-goes).
  - `parseCheckedHash`, a passing parse check's verdict, which lands
    just after the change it checked was synced. Counting it cost a
    second sync per edit. A failing verdict changes `status` too, and
    does count.
  - `onlyAnnotationsChanged` in `src/extension/match-index.ts` keeps
    them out of `onCacheChanged` entirely, and suppresses nothing
    wider: the check diffs the whole stored row, because a spec reads
    far more of it than matching does.
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

- **`includeGlobs` / `excludeGlobs` are ignored entirely.** `update`
  cannot add them, change them, or clear them. The call succeeds and
  `getScripts` keeps reporting whatever was registered, so nothing
  surfaces the loss. Only `matches` really updates.
- **An explicit empty array counts as unspecified.** `matches: []` is
  refused outright — *"must specify at least one match"* — so `matches`
  can be changed but never cleared.
- **An updated registration moves to the END** of Chrome's set, in
  batch order. See [Ordering](#ordering).

Only the glob behaviour has a live probe
(`tests/e2e/exclude-globs.spec.ts`). The `matches` and ordering
behaviours were measured against Chrome when they were first relied on,
and today are only *modelled* by the fake in
`tests/unit/injector.test.mjs` — a fake encodes the assumption, it does
not re-establish it. Probes for those two are filed in
[TODO.md](../TODO.md).

Why this bites: `buildRegistrationSpec` emits `matches` / `includeGlobs`
/ `excludeGlobs` only when non-empty. Under wipe-and-replace every
placement was a `register` onto an empty set, so an absent key meant
"unset"; on the update path it means "keep" — and for the globs, it
means "keep" no matter what the key says.

- A user **adding** an `@exclude` would get a registration without it.
  The script keeps running on the site its header now excludes, our own
  matcher (badge, tab status) says it shouldn't, and the row reads
  UNEXPECTED with nothing the user can do about it.
- A user **deleting** their last `@exclude` is the mirror case: a
  registration still carrying an exclusion the header no longer
  declares.
- So the injector records the pattern fields each registration carries —
  the glob **values**, since those never update, and presence only for
  `matches` — and any spec `update` would not faithfully apply is placed
  by `replaceRegistration` — `unregister` then `register`.
- **That is the one place the closed window reopens**, for one script,
  for the length of one call pair. The trade is narrow and in the right
  direction: a gap costs that script one navigation, and only a script
  whose match set the user is actively rewriting. The alternative is
  Chrome and our own matcher disagreeing indefinitely.

### Ordering

`orderWithOwnSpecs` emits GM runtimes (one per world) → bridge → user
scripts, and because `update` moves a registration to the end of the
set, *how* the calls are grouped decides the result.

- **Our own registrations are placed first and individually.**
  Grouping the calls by kind (one `update` batch, one `register` batch)
  would put a newly-registered bridge after already-updated user
  scripts.
- **An incremental sync that moves an own spec's pattern union updates
  it**, which lands it after the user scripts already registered. Not
  repaired, and re-placing the world's scripts behind it would cost
  each an injection gap:
  - the runtime: a wrapper checks for it lazily (see the reload fast
    path's `needsRuntime`), and a `document-start` script that needs it
    asks the SW before running when it isn't in yet (below);
  - the bridge: whatever is sent before it listens is held and sent
    again when the bridge announces itself (below).
- **User specs then go out as batches**, since the relative order of two
  user scripts is not something we promise anyway — see
  [`@run-at` gating](#run-at-gating).
- Cross-registration ordering isn't guaranteed by the API; in practice
  Chrome runs registrations in order.
  - The GM runtime and the bridge can both land after a wrapper, and
    a `document-start` script on a first load runs its body at once,
    without the check-pending round trip (`canSkipDecision`). So
    neither can be assumed in place when the body runs.
  - The GM runtime: such a script that needs it (`needsGmRuntime` in
    its config) asks the SW instead when the registry has no `gm` yet
    (`hasGmRuntime`). The answer takes long enough for every `document_start`
    registration to run.
  - The bridge: a request is a synchronous event dispatch, so a bridge
    that hasn't installed its listener yet misses it.
    - The bridge cancels every event it takes, as a receipt: its
      listener runs inside the sender's dispatch, so the sender sees
      at once whether it was taken.
    - What wasn't taken is held, and sent again when the bridge
      announces itself (`sourcemonkey-bridge-ready`). The prelude
      (reports, check-pending) and the MAIN-world GM runtime (every
      `GM_*` call) each hold their own.
    - Held, a check-pending still gets its answer, a report still
      arrives, and a `GM_*` call's reply comes a little later. Lost,
      a script would show as MISSING or go unrun, and a `GM_*` call
      would time out.
    - A request whose caller stops waiting (check-pending's timeout,
      a `GM_*` call's) is dropped from the list, so a bridge landing
      after that doesn't start work nobody is waiting on.
    - The two lists are sent separately, so the SW can get what the
      prelude held (reports) before what the runtime held (`GM_*`
      calls), whatever order they were made in. No SW handler depends
      on that order.
  - Keeping our specs first means that usually nothing is held, and
    no script needs to ask for the runtime.

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
    says whether an `update` would silently keep the pattern fields it
    already holds.
- **The reported reason is the real refusal**, never the second call's.
- **A refused spec for an id Chrome already holds IS unregistered.**
  Otherwise the previous version keeps injecting while the row reads
  REJECTED — and REJECTED says the script will not run.
- **The remaining `unregister` calls are all for scripts that are
  genuinely going away**: disabled, deleted, newly INVALID, the one case
  above, or a pattern field `update` cannot apply.
- **Removals do not consult our record of the set.** Every affected
  script that no longer wants a registration is dropped, whether or not
  this worker believes Chrome holds it: the record can be wrong (a
  reset, a record lost with a stopped worker). Every other wrong belief
  self-corrects because `placeSpec` has a second call to disagree with
  it; removal has none, so it doesn't get to guess. An unregister for an
  id nothing holds costs one refused call and is swallowed.

### One registration operation at a time

Placing a spec is a read-modify-write against a single mutable set, and
Chrome makes no part of it atomic.

Two of them interleaving produces `Duplicate script ID '<id>'` against
a script that is registered and *running*: one attempt listed the set,
a second placed the script, and the first then offered the id again.

- **Serialized in the worker**, the only context that places
  registrations ([worker-writes.md](worker-writes.md)); the lock throws
  in a page. Every operation that touches
  `chrome.userScripts` — the sync, the targeted retry, the test
  surface's teardown — runs through one promise-chain lock in
  `src/extension/injector.ts`. Overlap used to be easy to hit: the SW-startup
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
- **A failed batch `unregister` falls back to one id at a time.**
  Chrome fails the whole call if any id in the list is unknown, which
  usually means the worker's record was wrong about that one. Giving up
  would leave scripts that are *not* wanted — disabled, deleted, newly
  INVALID — still injecting, since nothing replaces them any more.

### Rejected registrations

A spec Chrome refuses is a state of its own — REJECTED — not a load
failure and not an error the script produced. See
[diagnostics.md](diagnostics.md#rejected-registrations) for the wording
rules and why it carries no location.

- **Where it lives.** `src/extension/script-rejection.ts` keeps
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
  - It's module state in the worker, which runs every refresh, so it
    is one counter for all of them.
  - `resetAllState` clears the worker's copy
    (`resetRejectionRetryGate`) — otherwise one e2e test's retry
    silently suppresses the next one's.
- **A fix needs no extra user action**, and is logged: the retry that
  succeeds drops the script from the map, so REJECTED clears, and
  `logRecoveries` writes the matching info row.
  - The row goes back to OK on its own: the refusal rows carry
    `state: 'rejected'` and the recovery `state: 'ok'`, so neither
    touched the `loglevel:` sentinel — see
    [script-log.md](script-log.md#entry-shape).
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
- `includeGlobs` — `@include` glob patterns. Chrome ORs these with
  `matches` rather than filtering within them (see
  [How Chrome reads includeGlobs](#how-chrome-reads-includeglobs)).
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

- `document-start` — the gate opens immediately, once
  `document.documentElement` (`<html>`) exists.
  - Chrome injects `document_start` scripts after `<html>` exists, so
    it always does by then.
  - Were it missing, the wrapper would wait for it with a
    `MutationObserver` on `document`, whose records are delivered
    before the first page `<script>` runs.
  - Where the [check-pending decision](#reload-fast-path) could only
    be `run`, the body runs right away, ahead of the page's own
    scripts. Elsewhere it waits for that async answer, so early page
    scripts can run first. See
    [Skipping the check at document-start](#skipping-the-check-at-document-start).
  - If `<html>` is still missing at `DOMContentLoaded`, the body runs
    anyway.
- `document-body` — wrapper waits for `document.body` (via a
  `MutationObserver` on `document`, with `subtree` so it also sees a
  `<body>` added under an `<html>` that didn't exist yet).
  - Observing `document` rather than `<html>` also keeps the wait
    alive across a `document.open()` rewrite, which replaces `<html>`.
  - A document with no `<body>` by `DOMContentLoaded` (XML, SVG)
    never runs the script, as in Tampermonkey ("injected if the body
    element exists"). The observer is dropped then, so it doesn't wake
    on every later DOM change.
- `document-end` — wrapper waits for `DOMContentLoaded`.
- `document-idle` (default / unknown values) — wrapper waits for
  `readyState` to reach `complete`, just before `load`.
  - A subresource that never finishes (a stalled third-party script)
    holds `load` back forever. So the gate also opens 200ms after
    `DOMContentLoaded` (`IDLE_AFTER_DCL_MS`), whichever comes first,
    about when Chrome's own `document_idle` would.
  - A page with slow images or ads thus runs it while `readyState` is
    still `interactive`.
  - A page that calls `window.stop()` never fires `load`, but its
    `readyState` still reaches `complete`, so the body runs there too.
  - A script injected after the page has loaded (say, into a tab open
    before the install) runs at once.
  - Why `complete` and not `load`, and how a body held past `load`
    still sees it: [`document-idle` and the `load` event](#document-idle-and-the-load-event).
  - An unknown value (a typo) gets a parse-time warning
    (`unsupportedRunAtWarning`): Log tab, `sm-dev validate`, and
    sm-dev's warning lines when it loads the script.

**`@run-at context-menu` is a manual script**: never registered, and
run on request from the popup, each time asked. See
[manual-scripts.md](manual-scripts.md).

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
`src/extension/injector.ts`) and stored on the prelude's per-script entry.

This wait runs alongside the `sm:check-pending` round-trip rather than
after it — see [Concurrent gates](#concurrent-gates).

#### `document-idle` and the `load` event

Many old scripts do all their setup in a load listener:

```js
window.addEventListener('load', function () { /* everything */ });
```

That only works if the body runs before `load` fires. A listener added
after `load` never runs, and nothing happens.

**What other managers do** (sm-dev `--manager tm` / `vm` probes,
2026-10-06, on example.com and the `headers-run-at` example page,
whose `load` comes about 480ms in):

- Tampermonkey, sandboxed script (granted): runs with `readyState`
  already `complete`, and the load listener fires, on both pages. Also
  seen on the live sites of five corpus scripts.
- Tampermonkey, `@grant none` (page world): on the example page it
  runs after `load`, and the listener doesn't fire.
- Violentmonkey: at `interactive` on example.com, where the listener
  fires; after `load` on the example page, where it doesn't.

**What we do:** fire it in both worlds. Old load-listener scripts
mostly grant something, so they match Tampermonkey's sandbox case. A
page-world script gets the same timing rather than a different one:
seeing `load` is never worse for it than missing it.

**The timing we use.** On a normal page these happen in one task, with
nothing able to run in between:

```
readyState → complete    readystatechange: the idle gate opens here
load                     window load listeners run
```

- The gate opens synchronously in that `readystatechange` handler, so a
  body that runs there adds its listener in time.
- The body also needs the [run decision](#concurrent-gates), an async
  round trip to the SW. Two cases follow.

##### Decision first: the body runs before `load`

- The usual case on a page that takes more than a few ms to load.
- The body runs at `complete`; its load listeners fire natively.
- The page's own `load` handlers haven't run yet, as in Tampermonkey.

##### Decision after `load`: the replay

- On a fast page (a small or cached one) `load` can fire before the SW
  answers, so the body runs after `load`. Without help, its load
  listener would never fire.
- `entry.replayLoad` records that the gate opened before `load` was
  over. When it's set and `load` has fired, `flushPending` runs the
  body inside `runWithLoadReplay`.
- The real load event is kept by a `once` listener the prelude adds at
  `document_start`, in each world it runs in.

What `runWithLoadReplay` does:

1. Puts a stand-in `addEventListener` on `window`, as an own property,
   for the body's synchronous run only.
   - A `load` listener for `window` is queued, not added. A bare
     `addEventListener(...)` from strict code counts as `window`.
   - Every other call goes to the real method.
2. Notes `window.onload` before the run.
3. Runs the body.
4. Restores `addEventListener`: puts back an own property the page had,
   or deletes ours. Then, if the body set a new `window.onload`, queues
   that too.
5. Calls each queued listener on its own task (`setTimeout`), with the
   real load event and `this` as `window` (or the object, for a
   `handleEvent` listener).
   - Separate tasks make an error in one listener an ordinary uncaught
     error, attributed to the script, without stopping the rest.

Who sees the stand-in:

- Only code the body runs synchronously.
- In the isolated (USER_SCRIPT) world, `window` is that world's own, so
  the page never sees it.
- In MAIN world, page code the body triggers synchronously (a
  dispatched event's handler) shares it, so a load listener that code
  adds gets replayed too.

##### Limits

- No replay for a listener added after the synchronous run (after an
  `await`, or in a timer).
- No replay for one added by a page `<script>` that an isolated-world
  body injects: that code runs in the page's world, without the
  stand-in.
- Replayed listeners don't follow every native rule: one added twice is
  called twice, `removeEventListener` doesn't cancel a queued one, and
  `onload` is called last.
- Which case happens depends on the race, so the page's own `load`
  handlers may or may not have run when the body starts.
- No replay for a script injected after the page had loaded (the gate
  opened at `complete` with `load` long over), as in any manager.

##### Tests

- `tests/e2e/injection.spec.ts`: "document-idle runs before load, so a
  load listener it adds fires" (both worlds, and `window.onload`). Its
  fast fixture page mostly takes the replay path.
- `tests/examples/headers-run-at/`: the same check under every manager.

### Execution world

The `world` field decides whether the body runs in the page's own
`window` (MAIN) or in Chrome's isolated user-script context
(USER_SCRIPT). The two worlds share the DOM but have separate
`window` objects, so a USER_SCRIPT-world script cannot see
page-defined globals like `window.jQuery`, `window.map`, or any
function declared by an inline `<script>` tag on the page.

#### How the world is picked

Like Tampermonkey and Violentmonkey, every script starts in the page
and leaves only when its header asks (`resolveWorld` in
`src/script-world.ts`):

- `@inject-into page` → MAIN; `@inject-into content` → USER_SCRIPT.
  This is VM's header, and it is read first.
- `@sandbox raw` and `@sandbox JavaScript` → MAIN; `@sandbox DOM` →
  USER_SCRIPT. This is TM's header.
  - TM's `JavaScript` uses a separate world only on Firefox; on Chrome
    it falls back to the page, as here.
- Anything else, `@inject-into auto`, or neither → MAIN, granted or
  not.

Why the page by default:

- Scripts written against TM and VM read the page's globals (its `$`,
  an app's state, `customElements`) without `unsafeWindow`, since there
  they run in the page. In USER_SCRIPT world those read as `undefined`
  and the script silently breaks.
- Any script but a `@grant none` one still keeps its own writes off
  the page's `window`: it runs in a
  [sandbox `window`](#the-sandbox-window), as under TM and VM. That
  includes a script with no `@grant` line at all, as both run it
  (measured in TM 5.5.0 and VM 2.49.0). A `@grant none` one gets the
  page's `window`.
- What the page costs a script is under
  [Costs of running in MAIN](#costs-of-running-in-main).
  `@inject-into content` / `@sandbox DOM` are the way out.

`none` wins over other `@grant` lines for the bindings
(`resolveGrants`): a script mixing `none` with `GM_setValue` is a plain
`@grant none` script, with no GM APIs and no sandbox.

- Violentmonkey reads it the same way: its API wrapper builds nothing
  (not even `unsafeWindow`) when `grant` contains `none`.
- It also flags the combination at install time ("`@grant none`
  disables all other `@grant` keys"). Our `warning`-level startup log is
  the equivalent, naming the overridden grants so the author sees why
  they're missing.

#### `unsafeWindow` is the page's window

`unsafeWindow` is defined as **the page's** `window`, and the binding
is `const unsafeWindow = window;`, emitted outside any sandbox:

- In MAIN world that is the real thing.
- Chrome's isolated worlds each get their own `window` per document,
  with no synchronous channel to the page's realm, so nothing can stand
  in for it there.
- A sandboxed script's own `window` is a sandbox of the browser's
  built-ins, so `unsafeWindow !== window` for it, as in TM. The sandbox
  always carries `unsafeWindow` as its own property, binding or not
  (TM and VM's do), so `const { unsafeWindow } = window` works.
- A `@grant none` script without the binding has no `unsafeWindow`,
  as in TM and VM.

The isolated-world case:

- `@inject-into content` or `@sandbox DOM` is an explicit request for
  isolation. `unsafeWindow` is then that world's own `window`, matching
  VM's content mode.
- Because every page global reads as `undefined` there, that
  combination is **not** left silent: `extractStartupLogs`
  (`src/script-build.ts`) attaches a `warn` startup log naming the
  header, which surfaces in the page console and the viewer's Log tab
  on every matching load.

##### Without a grant

Neither TM nor VM keys `unsafeWindow` off a grant line, so a script
written against either may use the name and never declare it. It gets
the same binding here.

- Measured, not read off their docs:
  `tests/examples/unsafe-window/ungranted.user.js` uses the name with no
  grant, and both TM 5.5.0 and VM 2.49.0 hand over the page's own
  object; see
  [cross-manager-test-results.md](cross-manager-test-results.md).
- Over the GreasyFork top 2000, 313 scripts mention the name and 187
  grant it; 112 of the rest are real references.
- **`GM_info.script.grant` is unchanged.** A script reading its own
  metadata sees its own metadata, and the name buys nothing at the SW
  gate: `bridgeMayActAs` checks header-derived subsystems and
  `unsafeWindow` has none.

###### How the reference is found

`sourceUsesUnsafeWindow` (`src/unsafe-window-use.ts`) scans the body at
load time; the answer is persisted as `StoredScript.usesUnsafeWindow`
and read when the bindings are built. It is a text scan, not a parse:
the extension has no JS parser (the install-time check compiles in a
sandboxed page and returns a verdict, see
[parse-check.md](parse-check.md)).

- Comments and string literals are stripped first, and `${…}` inside a
  template is scanned as code.
- `foo.unsafeWindow` and `unsafeWindows` don't count; `typeof
  unsafeWindow` does.
- A source that **declares** the name (`const unsafeWindow =
  window.wrappedJSObject || window;`, a real cross-browser idiom) is
  left alone: it reads its own binding, never ours.
  - Our binding would be harmless beside it: the script's declaration
    shadows it (see [The user program scope](#the-user-program-scope)).
    So a `@require` declaring the name needs no special case either.
- Two limits: regex literals are not recognized (a `/['"]/` opens a
  string state, and a literal ending in `\/\/` reads as a line
  comment, either of which can swallow a later reference), and only the
  script's own body is scanned, not its `@require` bodies; see TODO.md.

Persisted rather than recomputed, so every build of the script's
bindings gives the same answer.

- A row stored before the field existed reads as false, and a row is
  only rebuilt when a fetch actually happens: the cheap-skip paths
  (unchanged size+mtime, a 304) leave it exactly as it was. So
  `backfillUsesUnsafeWindow` (`src/extension/script-store.ts`) fills
  those rows in on `onInstalled` and re-syncs when any changed.

#### `GM_*` in MAIN world

The whole `GM_*` surface works in MAIN, the default world, as well as
in the isolated one.

- `src/wrapper-gm-runtime.js` — the same source — is registered in
  MAIN as well as USER_SCRIPT (`buildGmRuntimeSpecs`). It detects at
  init whether `chrome.runtime` is reachable and picks its transport
  accordingly. One implementation, two transports; no second copy to
  drift.
- Page → SW requests go out over `wrapper-bridge.js` as
  `sourcemonkey-sync-<key>` DOM events with a `requestId`, the same
  request/reply shape `sm:check-pending` already used.
- SW → page pushes (XHR events, cross-tab value updates, menu fires)
  arrive at the bridge on `chrome.runtime.onMessage`, which MAIN world
  can't listen on; the bridge re-sends them as
  `sourcemonkey-push-<key>` events.
- `<key>` is the channel key, which keeps the page out of all of it
  (see [The channel key](#the-channel-key)).
- Registration is **per world, per need, and per pattern**:
  - A world only gets the runtime when some active script there grants
    an API that needs it. `GM_info` (a baked literal) and
    `unsafeWindow` (a `window` alias) don't, so an ordinary
    `@grant none` MAIN-world script brings no runtime onto the page.
  - Its `matches` / `includeGlobs` are the union of those scripts' own,
    not `<all_urls>`, so installing one such script doesn't put it on
    every page the user visits.

##### The channel key

Our MAIN-world pieces share the page's realm, so what keeps the page
out of them is a secret: the channel key, a random value per install
(`src/extension/channel.ts`).

###### Where it lives

- Made once and kept in `chrome.storage.local`, and made again for
  each new extension version, so a key that leaked stops working at the
  next update (which places every registration again anyway).
- Baked into the code we register: the static wrapper files are
  written with a `"__SM_KEY__"` stand-in that `withChannelKey` swaps
  for it (and throws if it's missing), and generated code gets it from
  `registryExpr`.
- A registration record made under another key isn't restored, so a
  new key means every registration is placed again.

###### The registry

- Our entries are separate scripts (each script's config, prelude,
  program and seal, plus the GM runtime), so they meet through the
  document. Each asks `document.__smGate(key)` for the world's one
  registry object, which holds the prelude (`prelude`, `run`, `sealed`,
  `cfgQueue`) and the runtime (`gm`).
- The first of our entries to run (at `document_start`, before any page
  script) defines the gate, non-writable and non-configurable, so the
  page can't replace it to catch the key.
  - On `document`, not `window`: a frame's initial `about:blank` keeps
    its Window when it navigates to a same-origin page, so a parent
    could plant a gate there first. Each navigation gets a new
    Document.
- The gate keeps one registry per key, so only our key gets ours; any
  other string gets an empty one of its own. Its own source doesn't
  contain the key.
- The registries, the gate's table of them and the runtime's tables
  keyed by script id have no prototype, so a lookup that misses can't
  reach a getter the page put on `Object.prototype`.
- Three copies of the gate's code (`registryExpr`, the prelude, the
  runtime) are checked against each other by
  `tests/unit/channel.test.mjs`.
- None of our pieces is a page global: `__smGate` on `document` is the
  only name we put on the page's objects.

###### The bridge's events

- Every event in either direction is named with the key
  (`sourcemonkey-sync-<key>`, `-reply-`, `-push-`, `-insert-`), so the
  page can neither send one nor hear one. Replies and pushes are events
  too, not postMessages the page could read.
- The two bare announcements stay public: the bridge's ready event
  (which makes a waiting wrapper send its check-pending again) and
  `sourcemonkey-main-ready` (which only keeps the sandboxed-page
  fallback off).

###### Keeping the key from the page

It is only in code Chrome injects, which the page can't read, and only
where the page can't get hold of it later:

- The static files keep it in their strict IIFEs, which run before any
  page script.
- Generated code has it only in the registry expression, at the end of
  each script's entry, as the argument of an outer function that runs
  at `document_start`. The wrap function gets the registry as a
  parameter, so its own source has no key.
- The wrap function is sloppy mode, and its `arguments` hold the
  script's entry (its stored values among them). Two ways a page could
  reach it, both closed:
  - `.caller`, from a page function the wrap's top level calls
    directly. So that top level (the GM bindings) calls nothing the
    page could have replaced: `console.info`, `Reflect.apply` and
    promise-making are the registry's copies (`info`, `apply`,
    `resolve` / `reject`), taken when the gate was made.
  - V8's stack-trace API (`Error.prepareStackTrace` with
    `CallSite.getFunction`), which hands a page every sloppy function
    on the stack down to the first strict one. So the user program
    (and the `GM.*` aliases' calls) run through strict frames: the
    prelude's `callAs` for the program, the runtime for every GM call.
- The reload swap evals a body carrying the key, through the `eval`
  the prelude captured at load.
- Our MAIN-world code calls captured functions through the captured
  `Reflect.apply`, never `fn.call(...)` (the page's to replace, and
  handed what we pass: a script's value cache, the keyed insert
  event). It reads events' `detail` through the getter captured at
  load, builds events and property descriptors from objects with no
  prototype, and copies replies and pushes into objects with none
  before reading them.
- It decides once, at load, whether it has its own `chrome.runtime`
  channel: in MAIN world `chrome` is the page's to replace, and a page
  that made it look like ours would be sent our reports.

###### Manual runs

A manual run's page-world code is injected long after the page's own,
so the built-ins it captures may be the page's replacements. It never
gets the install's key: see
[manual-scripts.md](manual-scripts.md#the-bridge-gate).

###### What it doesn't stop

- **A page that targets SourceMonkey** can still hook built-ins our
  MAIN-world code uses after `document_start` that we haven't
  captured, and the methods on the script's own values (a `toJSON`, an
  `Array.prototype` method the storage codec calls). That can show it
  values passing through, and in places let it alter them. TM's page
  mode is in the same position.
  - Except `GM_xmlhttpRequest`, whose response can be something the
    page could never read itself (another site's, with the user's
    cookies). Our handling of its request and response uses
    built-ins captured at `document_start`.
  - Objects we build or read for it have no prototype, or their fields
    defined outright (`setOwn`), so `Object.prototype` getters, setters
    and `toJSON` see nothing. That includes the script's `details`,
    read from an own-fields copy.
  - `tests/e2e/gm-xhr-hostile-page.spec.ts` hooks `TextDecoder`,
    `atob`, typed arrays, `Blob`, `URL`, `JSON`, `DOMParser`, the
    stream controller, array methods and iteration, and those
    `Object.prototype` members, and checks the page sees none of it.
  - What the script does with it is the script's business: its own
    code calls the page's built-ins like any page-world code, and so
    does serializing a non-string `data` (its `toJSON`), or reading a
    field the response object lacks.
- The listeners for the bridge's keyed events only read them, and
  handle what they carry in a microtask once the dispatch is over:
  while one runs, `window.event` is the event, whose type carries the
  key, and handling it can call into page code (the script's
  callbacks, our timers). Our promise chains use their own `then` and
  `catch`, the ones of `document_start`.
- **Any installed userscript** reaches the registry: `__smReg` is in its
  scope. So a page-world script can call the runtime as a sibling
  script on the same page (TODO.md, per-script keying).
- **sm-dev's eval hook** (test collections only) reaches the registry
  too; see `src/eval-hook.ts`.

##### Trust model

- The channel key keeps the page off the bridge (above). Behind it,
  as a backstop should the key ever leak, the **service worker** bounds
  what a bridge-relayed request can do.
- `bridgeMayActAs` in `src/extension/background.ts` honors a
  bridge-relayed, script-scoped request only when the named script
  actually runs in MAIN world on the sending frame's URL **and**
  granted the API the request exercises (in catalog-subsystem terms:
  `tab` for `sm:gm-tab-open`, `storage` for a value read or write, …).
  A `@grant none` script matching the page is not a handle for opening
  tabs or starting downloads. It fails closed on an unknown id, a
  non-matching URL, a missing sender URL, or an ungranted API.
- The **return** direction needs the same discipline. A push the bridge
  re-sends goes into the page's world, and pushes carry real payloads
  — a script's stored values on `sm:gm-value-update`, a cross-origin
  response body on `sm:gm-xhr-event`. So the SW stamps every push with
  the destination script's world (`pushWorld`, backed by
  `scriptWorld` in the match index) and the bridge relays only
  `smWorld === "MAIN"`. Unknown ids stamp as USER_SCRIPT, so it fails
  closed.
- Two pushes carry nothing script-scoped and are relayed regardless:
  `sm:gm-resync-hint` (a bare "ask again" nudge) and `sm:url-change`
  (the URL of the very document being posted into). Neither hands the
  page anything it doesn't already have.
- Consequences: a page still cannot touch a USER_SCRIPT-world script's
  GM values (the pre-existing read-leak fix still holds — see
  `tests/e2e/gm-storage-read-leak.spec.ts`), cannot read its broadcasts
  or XHR responses just by running a MAIN-world script alongside it,
  and cannot drive a MAIN-world script scoped to some other site.
- `sm:gm-xhr-abort`, `sm:gm-tab-close` and `sm:gm-download-abort` are
  deliberately ungated: they name a per-call random request id, not a
  script, and cancelling a request the page can already observe gains
  it nothing.
- Everything script-scoped goes through the gate, including the
  handlers that used to refuse a bridge-relayed request outright —
  `sm:gm-window-close` / `sm:gm-window-focus`, `sm:gm-resync`, and
  `sm:gm-download-start`. Refusing outright was right while no
  MAIN-world script could need them; now one can, and the gate is a
  tighter statement of the same rule. `window.close` is the sharpest
  case: the override sits on the granting script's sandbox `window`,
  not the page's, and with the key, a forged request is bounded to
  closing the page's own tab.
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

- **Page CSP applies to what the script inserts itself.** A `<style>`
  or `<script>` it appends is the page's, so a strict `style-src` or
  `script-src` blocks it.
  - `GM_addStyle` / `GM_addElement` are exempt: the runtime hands their
    insert to the bridge in USER_SCRIPT world (see
    [GM-APIs.md](GM-APIs.md#dom-injection-gm_addstyle--gm_addelement)).
  - Where that can't happen (a closed shadow root, another frame's
    document, a detached parent), a blocked `<style>` that's in the
    document (with no `.sheet`) is reported once per script per
    document in its Log (`source: gm-dom`).
- **The page can interfere.** It shares prototypes and globals with the
  script. The runtime's shim cache is captured at `document_start`,
  before any page script, so its own natives are pristine — but user
  code in MAIN is on its own.
- **A determined page can still look in.** The channel key keeps the
  page off the bridge and away from our runtime, but a page that
  targets SourceMonkey can hook the built-ins our MAIN-world code uses
  and see some of a granted script's traffic (see
  [The channel key](#the-channel-key)). The isolated world is out of
  its reach entirely; a script that needs that says
  `@inject-into content`.
- **A CSP `sandbox` page runs them isolated.** Chrome injects no
  MAIN-world script where the page's own world has script turned off,
  so they run in USER_SCRIPT world there instead, a little later (see
  [CSP sandbox pages](#csp-sandbox-pages)).

##### CSP sandbox pages

A CSP `sandbox` directive without `allow-scripts` (or an
`<iframe sandbox>` without it) turns off script in the document's own
world. Chrome then injects no MAIN-world script there, without a word,
while USER_SCRIPT-world ones still run. VM falls back to its content
world in that case, and so do we:

- **Spotting it.** The bridge runs in USER_SCRIPT world, on every page
  a MAIN-world script matches. Each MAIN-world prelude announces itself
  to it (`sourcemonkey-main-ready`, sent on load and again when the
  bridge announces itself). A bridge that has heard none one task after
  it started sends `sm:main-blocked` to the SW itself.
  - One task is enough: every `document_start` registration is in by
    then.
  - Silence also happens on ordinary pages: while a sync is
    registering a script, and where the bridge's patterns match but no
    MAIN-world script runs (a frame where all are `@noframes`, a page
    one `@exclude`s).
  - So the SW first finds the MAIN-world scripts that match, and stops
    if there are none. Then it runs a bare `true` in the document's MAIN
    world (`pageWorldRuns`). Chrome drops it on a sandboxed page with no
    error; if it comes back `true`, the page runs script and nothing
    falls back.
  - This covers `sandbox allow-same-origin` too, which keeps the real
    origin (common in `<iframe sandbox="allow-same-origin">` for
    untrusted HTML).
  - `sandbox allow-scripts` runs MAIN-world scripts, which announce, so
    nothing runs twice.
  - The page can send the announcement too. That only keeps the
    fallback off, and a page that can send it isn't one that needs it.
- **Running them.** `runBlockedMainScripts` in `background.ts` finds the
  MAIN-world scripts that match the document (honouring `@noframes`,
  sm-dev claims, and leaving out any Chrome refused to register) and
  injects each into it with
  `chrome.userScripts.execute`, built as a registration of the same
  script with `@inject-into content` ahead of its own headers
  (`buildIsolatedFallbackInjections`). The GM runtime goes first, a
  no-op where it is already there.
  - Each still asks check-pending whether to run, as a registered copy
    does, and reports as an isolated script.
  - Each injected copy puts an info line in the script's Log (source
    `sandbox-fallback`) saying it runs in the isolated world, and why.
  - On a reload, each is built after the reload's refresh of it (up to
    5 seconds), so an edit runs.
  - The SW ignores a second ask for a document while it runs. After a
    worker restart, the prelude's own per-world check keeps a second
    copy of a script from starting.
- **What it costs.** Such a page runs no script of its own, so there
  are no page globals the script could have wanted. Scripts start late:
  after a bridge task, a worker wake-up and a build each, which can be
  after `DOMContentLoaded`. A `document-start` script's
  MutationObserver finds the page already parsed.
- **Manual runs.** "Run this script" for a MAIN-world manual script
  first runs a bare `true` in the document's MAIN world
  (`pageWorldRuns`): Chrome drops it on such a page with no error, so
  no result means the page turns its script off. The run is then built
  with `@inject-into content` ahead, and logged, as above.
- The badge's MISSING hint for a sandboxed page
  ([matching.md](matching.md#scripts-that-never-start)) covers a
  fallback that failed to start a script.
- sm-dev's `eval --script` looks for a page-world script's scope in the
  isolated world too, so it reaches the fallback copy.
- **One extra hop per call.** Every `GM_*` SW round-trip pays the
  bridge relay, like `sm:check-pending` already did from MAIN. The
  request leg costs no task hop (it is a synchronous event dispatch);
  the reply comes back as an event once the SW has answered.

#### MAIN-world traffic — the bridge

`chrome.runtime` is not exposed to MAIN-world scripts, so neither the
wrapper's `sm:start` / `sm:error` reports nor the GM runtime's SW calls
can reach the service worker directly from MAIN. `src/wrapper-bridge.js`
is the relay.

What crosses it:

- **Fire-and-forget reports** — `sm:start` / `sm:error` / `sm:swapped` /
  `sm:abandoned` from `send` in `userscript-prelude.js`, and the
  storage flush at teardown.
- **Request/reply** — anything sent with a `requestId`:
  `sm:check-pending` from the prelude, and every SW-backed `GM_*` call
  from the MAIN copy of `wrapper-gm-runtime.js`. The bridge always
  replies, even on failure, so the caller's awaiter settles instead of
  running out its timeout.
- **SW-originated pushes** — `sm:gm-xhr-event`, `sm:gm-value-update`,
  `sm:gm-values-stale`, `sm:gm-tab-closed`, `sm:gm-notification-event`, `sm:gm-menu-fire`,
  `sm:gm-download-event` (the bridge's `PUSHED` list is authoritative).
  Those arrive on `chrome.runtime.onMessage`, which only USER_SCRIPT
  world can listen on, so the bridge re-sends them into the page as
  `sourcemonkey-push-<key>` events.
- **DOM inserts** for `GM_addStyle` / `GM_addElement`, which the bridge
  appends from USER_SCRIPT world so the page's CSP doesn't apply
  (`sourcemonkey-insert-<key>`; see
  [GM-APIs.md](GM-APIs.md#dom-injection-gm_addstyle--gm_addelement)).
  This one never reaches the SW.

Mechanics (`<key>` is the channel key; see
[The channel key](#the-channel-key)):

- `send` in `userscript-prelude.js` asks whether `chrome.runtime.id`
  is a string — true only in a real extension context. In USER_SCRIPT
  world it then calls `chrome.runtime.sendMessage` directly; in MAIN
  world it falls back to the bridge event. The GM runtime's
  `transportSend` makes the same choice. Not keyed on `sendMessage` existing: a web
  page listed in another extension's `externally_connectable` has a
  partial `chrome.runtime` (`sendMessage` and `connect`) in MAIN world
  for talking to that extension, and calling it without an extension
  id throws.
- **Page → SW is a DOM event**, not a postMessage: a `CustomEvent`
  named `sourcemonkey-sync-<key>` dispatched on `document`, carrying
  `{requestId, payload}` as a JSON string in `detail` (objects don't
  cross realms).
  - Event dispatch runs *every* world's listeners in the **dispatching
    task**, so the bridge's `chrome.runtime.sendMessage` happens before
    the caller returns. A postMessage is delivered on a later task, and
    a document in `pagehide` never gets one — `GM_setValue()` before
    `location.href = …` or a tab close lost the write every time.
  - It also saves a task hop on `sm:check-pending`, which a
    MAIN-world script waits on at `document_start` unless it can
    [skip it](#skipping-the-check-at-document-start). The hop is small at
    rest — a `postMessage` to one's own window round-trips in well under
    a millisecond on an idle page, against roughly a millisecond for the
    whole SW round-trip — but it is a *queued task*, so it grows with
    whatever else the page has pending, which at `document_start` is the
    page's own boot.
  - JSON costs nothing the wire didn't already: the bridge's
    `chrome.runtime.sendMessage` JSON-serializes regardless, so a value
    that survives `JSON.stringify` here is exactly a value the SW could
    have received.
  - `requestId` is omitted for fire-and-forget sends, and that absence
    is what selects the bridge's reply-less path.
- **SW → page is a DOM event too** — `sourcemonkey-reply-<key>` for
  replies, `sourcemonkey-push-<key>` for pushes, JSON in `detail`. Not
  a postMessage, which the page could read.
- The bridge checks the payload type against an allowlist per
  direction and forwards. An unallowlisted request gets no reply at
  all, so the bridge can't be used as an "is this type relayed?"
  oracle. Cross-frame relay is not a concern on the request side: a DOM
  event on `document` only reaches listeners in that same document, so
  a frame can only reach the bridge instance injected into it, already
  scoped to that frame's URL.
- `buildBridgeSpec` (in `src/extension/injector.ts`) emits the bridge
  registration when at least one active script resolves to MAIN. It
  runs at `document_start`, ahead of the wrapper specs, because the
  request path is synchronous: an event dispatched before the bridge's
  listener exists finds no one. Senders hold what the bridge didn't
  take and send it again when the bridge announces itself (see
  [Ordering](#ordering)).
- The bridge is scoped like the runtime: its patterns are the union of
  every MAIN-world script's (granted or not — telemetry and the reload
  handshake ride it too), fingerprinted so an incremental sync
  re-offers it when the union moves. It is not `<all_urls>`: on a page
  with no MAIN-world script it would still cost a whole USER_SCRIPT
  world for that document, a V8 context per navigation.
- Our own specs go in before the user scripts (injection order), so
  they are built from patterns Chrome hasn't ruled on. If Chrome
  refuses one, it is rebuilt from the placements Chrome accepted —
  which exclude the refused script, whose row reads REJECTED — and
  offered again (`retryRefusedOwnSpecs`). Not `<all_urls>`: a bad
  pattern in one script must not put our code on every page.
  - Chrome moves an updated registration to the end of its list, so a
    helper updated alone (a retry, a pattern change) lands behind the
    user scripts. A full sync that finds one there places everything
    again, helpers first (`helpersFirst`); otherwise it skips what
    Chrome already holds.
  - A full sync that has to send a helper re-sends the user scripts
    too (`keepHelpersFirst`). Skipping them would leave the updated
    helper behind them.

Trust model:

- Cross-origin frames can't reach a bridge instance that isn't theirs:
  the request is a DOM event, which stays inside its own document.
- The host page can't use the bridge: every event's name carries the
  channel key, so it can neither send a request (or the insert event,
  for the CSP exemption) nor hear a reply or push. What follows is the
  backstop, should the key ever leak.
- A forged `sm:start` would flip a script's badge entry from MISSING to
  OK on that document; a forged `sm:error` would write an
  attacker-controlled string into the SW console and per-tab session
  record. Neither grants script execution or SW privilege.
- Script-scoped requests — a `sm:check-pending` asking for `gmValues`,
  or any `sm:gm-*` call — are gated. The bridge stamps
  `__viaBridge:true` on every message it relays (set last, so the page
  can't pre-set it false), and the SW's `bridgeMayActAs` honors such a
  request only for a script that runs in MAIN world on the sending
  page and granted the API being called. Reading a USER_SCRIPT-world script's GM values stays blocked,
  which is the original read-leak fix. See
  [`GM_*` in MAIN world](#gm_-in-main-world), `docs/GM-APIs.md`, and
  `tests/e2e/gm-storage-read-leak.spec.ts`.

### /regex/ pattern forms

The User Scripts API has no equivalent for `/regex/` `@include` /
`@exclude` patterns, so we work around it with a two-layer approach:

- **Registration layer.** Glob `@include` / `@exclude` patterns go to
  `includeGlobs` / `excludeGlobs`. `@match` goes to `matches`.
  - Any script with `includeGlobs` also gets a stand-in in `matches`,
    `NO_PAGE_MATCH` (`*://*/__sourcemonkey_no_page__/*`): any host,
    a path no real page uses. Chrome ORs the globs with `matches`
    (see below), so the globs say where it injects. Two reasons:
    - Chrome refuses a registration with no `matches` (*"must specify
      'matches'"*), so a script with only `@include`s needs one.
    - Chrome kills the renderer ("Page crashed") when the service
      worker messages a USER_SCRIPT-world listener (the bridge, the GM
      runtime) in a page covered only by `includeGlobs`, on a host no
      `matches` entry names. The `*` host avoids that.
    - The wrapper's matcher runs for these scripts, so the stand-in's
      own path never runs one.
  - A script with a regex `@include` gets `<all_urls>`, even beside
    `@match` lines: the regex can cover pages nothing Chrome reads
    does, and Chrome would never inject there.
  - A pattern whose host ends in `.tld` ("any public suffix", see
    [matching.md](matching.md#tld-hosts)) would be read by Chrome as a
    literal host no page has. A `.tld` `@match` or `@include`
    registers a coarse glob instead, `.tld` replaced by `.*`
    (`*://www.google.*/*`), and the wrapper narrows it. A `.tld`
    `@exclude` is enforced only in the wrapper: widened, it would
    exclude pages it shouldn't.
  - Cost: a regex `@include` script is injected and parsed on every
    page and frame, and only its body is skipped off-target. A `.tld`
    script pays that only on pages its coarse glob reaches.
- **Wrapper layer.** When a script has any regex, `.tld` or glob
  pattern,
  the wrapper embeds the full `{matches, includes, excludes}` object
  and a small self-contained matcher equivalent to
  `urlMatchesScript()`. Before the body runs, the wrapper re-checks
  `location.href` and silently returns if it doesn't match.
  - A regex is tested ignoring case, as Tampermonkey and Violentmonkey
    test it. A glob stays case-sensitive, as Chrome tests it.

Net effect: badge and injection stay in sync. The wrapper-side
matcher must agree byte-for-byte with `src/url-match.ts`; a unit test
eval's the embedded snippet to verify the regex-relevant cases.

### How Chrome reads includeGlobs

Measured against real Chrome, not taken from the docs — the probe lives
in `tests/e2e/include-only.spec.ts` and re-checks this on whatever
Chrome the suite runs:

- `chrome.userScripts` **ORs** `includeGlobs` with `matches`: a page
  matching either one runs the script. That is userscript `@include`
  semantics, and it differs from the content-script API, whose
  `include_globs` filters *within* `matches`.
- So a script declaring both `@match` and `@include` runs on the union,
  which is what its header says and what the badge predicts. No
  divergence to fix.
- `excludeGlobs` subtracts under either reading, so it needs no care.

Consequences:

- `<all_urls>` can't be narrowed by handing Chrome globs alongside it:
  `<all_urls>` OR anything is still every page. So it is kept for
  regex `@include`s, which no glob can stand for.
- A script with globs instead registers `NO_PAGE_MATCH` beside them,
  so Chrome injects only where its `@match`es and globs reach.
  - Under the documented AND, a glob-only script would inject
    nowhere. The probe above would fail first.
  - A second probe in the same spec pins the renderer crash the
    stand-in's `*` host avoids.
- Every script with globs carries the wrapper-side matcher: Chrome's
  glob reading isn't exactly ours (case, `?`), and the stand-in's path
  is a real one.

## The activation / error wrapper

The wrapper lives in plain JavaScript source files in `src/`. The
build (`scripts/build.mjs`) minifies each to a single line and emits
them as exported constants in `dist/generated-wrappers.js`. The type
declarations are hand-written in `src/generated-wrappers.d.ts` (tsc
type-checks against the `.d.ts`; the runtime `.js` is built directly
into `dist/`). The pieces:

- `src/userscript-prelude.js` → `WRAPPER_PRELUDE` — static, byte-
  identical across every script. Contains the IIFE, helpers
  (`reg.run`, `reg.sealed`, in the world's registry), the check-pending round-trip,
  the matcher recheck, the async-error listeners, and the
  `@run-at` gate. Per-script identity comes via a tiny config
  blob `{code}` entry that the injector emits ahead of this in the
  `js[]` array — see [injection-modes.md](injection-modes.md).
- `src/wrapper-bridge.js` → `WRAPPER_BRIDGE` — USER_SCRIPT-world
  relay registered separately when any MAIN-world script is active
  (see [MAIN-world traffic — the bridge](#main-world-traffic--the-bridge)).
- `src/wrapper-gm-runtime.js` → `WRAPPER_GM_RUNTIME` — shared
  per-world runtime for `GM_*` APIs, registered in USER_SCRIPT and/or
  MAIN world as the granting scripts need (see
  [GM_* in MAIN world](#gm_-in-main-world)). See
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
`needsGmValues`, `needsGmRuntime` (only when true), the optional
matcher block, and the optional startup logs. The prelude reads it
once and stashes a per-script entry on `reg.prelude.scripts[id]`, in
the world's registry (see [The channel key](#the-channel-key)).

The combined user-program entry is wrapped (in `wrapCombinedEntry`) to:

- Defer execution until the prelude's matcher + check-pending +
  `@run-at` gates resolve (via the registry's `run(id, fn)`).
- Splice the GM bindings (`const GM_info = ...`, `const GM_setValue
  = ...`, etc.) and the GM prelude (`storage.init`) into the
  function so they're locals visible to the body — and, because the
  requires are concatenated into the same function, to library
  top-level code too. One copy serves both; see
  [GM-APIs.md](GM-APIs.md#bindings-layout-in-the-wrapper).
- Run the user program (requires + body) in a scope nested inside the
  one holding those bindings — see
  [The user program scope](#the-user-program-scope).
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
  is undefined) it falls back to a `sourcemonkey-sync-<key>` DOM
  event the bridge picks up — see [MAIN-world traffic — the
  bridge](#main-world-traffic--the-bridge).

### The user program scope

The entry has two scopes, one inside the other:

```
(function(__smReg){__smReg.run(id,function(__smE){<__sm* vars><GM bindings><GM prelude>const __smU=()=>{
<requires, then the script's own source>
};return __smReg.prelude.callAs(__smU);})})(<registry>);
```

- **Outer** (the wrap function): our own declarations — the `__sm*`
  preamble, `const GM_info`, granted `GM_*`, `const unsafeWindow =
  window;`, and the names TM and VM give every script: `exports`,
  `module` and `define` as `undefined`, and pass-through `cloneInto` /
  `exportFunction` / `createObjectIn` (see
  [GM-APIs.md](GM-APIs.md)). The registry (`__smReg`) comes from the function around
  it, whose argument holds the channel key (see
  [The channel key](#the-channel-key)).
- **Inner** (an arrow function; a sandboxed script gets a `with` and a
  function instead, see [The sandbox window](#the-sandbox-window)): the
  user program. Its top-level
  declarations shadow ours, as they do under Tampermonkey (TM) and
  Violentmonkey (VM). Before this, both shared one scope, so:
  - `const window = unsafeWindow;` put our `const unsafeWindow =
    window;` in the temporal dead zone (TDZ) of the script's `window`,
    a ReferenceError that killed the script.
  - `const unsafeWindow = …`, `let GM_info`, a `var GM_setValue`
    polyfill or an own `function GM_addStyle` were duplicate-declaration
    SyntaxErrors.

Why an arrow function rather than a block:

- A block scopes only `let`/`const`/`class`; a `var` or a sloppy-mode
  function declaration would still clash in the outer scope.
- An arrow keeps the wrap function's `this`, so top-level `this` is
  unchanged, with no page-overridable `.call(this)`.
- It's called through the prelude's `callAs`, a strict function, so a
  page walking the stack (V8's stack-trace API) stops there instead of
  reaching the wrap function. Called on the closing line, so its call
  frame stays past the end of the script's own lines.
- Top-level `return` still works. Top-level `await` stays a
  SyntaxError.

The user program is the arrow body's first statement, so a leading
`"use strict"` is a real directive and the whole program runs in strict
mode, as in Tampermonkey and Violentmonkey:

- It's the first file's directive that counts, as if the files were
  concatenated: a first `@require` that starts with one makes the
  script strict, and the script's own after a `@require` does nothing.
  - Tampermonkey and Violentmonkey do the same: VM in
    `tests/examples/use-strict`, TM checked once by hand (it can't take
    that example's relative `@require`).
  - That includes a first `@require` that is empty or only comments:
    the `;` we put between files is then the first statement, so the
    script's own directive still does nothing. What TM and VM do there
    is untested.
- Before the nested scope it never applied, since our own statements
  came first. Scripts that relied on that (assigning undeclared
  variables under a top-level `'use strict'`) now throw, as they do in
  Tampermonkey and Violentmonkey.

The opener and closer sit on lines that already exist, so no line
moves: the source map and the Log tab's stack mapping are unaffected.

- A synchronous throw's stack gains one frame on the closer line, where
  the arrow is called. That line is ours, so the Log tab shows it as
  plain text rather than a link (see
  [script-log.md](script-log.md#what-is-left-unmapped-deliberately)).
The reload swap eval and the install-time parse check use the same
arrangement (see [parse-check.md](parse-check.md#what-is-checked)).

### The sandbox window

A MAIN-world script runs inside a sandbox `window`, as Tampermonkey and
Violentmonkey run theirs, whether it grants something or has no
`@grant` line at all. A `@grant none` script gets the page's `window`
itself, as under both (`runsSandboxed` in `src/script-world.ts`).

The user scope then has this shape instead of the arrow:

```
const __smP=__smReg.prelude,__smS=__smP.sandbox({GM_info:GM_info,…,unsafeWindow:window}),__smW=__smP.scopeOf(__smS),__smC=__smP.callAs;with(__smW){const __smU=function(){
<requires, then the script's own source>
};return __smC(__smU,__smS)}
```

- `__smS` is the sandbox, the script's `window`. `__smW` is a thin
  scope over it for `with`.
- `with` makes bare names look in the sandbox first, so a bare `$`
  finds a `@require`'s copy before the page's, and a bare `window`
  reads as the sandbox.
  - The scope claims the sandbox's own names, the browser's built-ins
    (so a bare `setTimeout` is `window.setTimeout`), `window` / `self` /
    `globalThis`, and `top` / `parent` / `frames` when they are this
    window. So the usual "skip frames" guard (`if (window.self !== top)
    return;`) is false in the top frame, as on the real window.
  - Any other bare name resolves as before: a page global, a page
    `let` / `class`, an element id. So a bare `pageGlobal` reaches the
    page, as in TM and VM, and a page function called bare still gets
    `undefined` as `this`, not the Proxy.
- A function called with the sandbox as `this` (through the prelude's
  captured `Reflect.apply`), so top-level `this` is the sandbox too.
  Top-level `arguments` is the function's own, empty list.
- Same lines as the arrow form, in both the registered entry and the
  reload swap eval, so the source map and stack mapping are unaffected.

#### What the sandbox does

It is a Proxy (`makeSandbox` in `src/userscript-prelude.js`):

- **It shows the browser's built-ins, not the page's globals**, as
  TM and VM do (measured in TM 5.5.0 and VM 2.49.0):
  - `window.pageGlobal`, `"pageGlobal" in window` and
    `Object.keys(window)` don't see anything the page added (its
    `var`s, functions, element ids). A bare `pageGlobal` or
    `unsafeWindow.pageGlobal` does.
  - Built-ins are as they were before page code ran: after the page
    replaces `window.fetch`, the sandbox's `fetch` is still the
    browser's.
  - The prelude records them at `document_start` (`BUILTINS`), about
    0.3 ms a page, in MAIN world only.
  - The window's capitalized names (constructors Chrome creates on
    first use) are only named then, and read at their first use. So a
    page's replacement made before then shows through, and one the
    page deleted is gone.
    - Read at once: the language's own globals (`JSON`, `Object`,
      `Promise`, …) and constructors pages often replace
      (`XMLHttpRequest`, `WebSocket`, …).
  - Built-in accessors (`document`, `location`, `name`, `onload`) are
    called on the real window, so they stay live.
  - Read live instead of recorded:
    - Child frames by index (`window[0]`, `frames[i]`).
    - The window's `[Replaceable]` properties (`opener`, `innerWidth`,
      `event`, …), whose write replaces the page's property, so
      `window.opener = null` reads back.
    - Names our GM runtime puts on the page's window (`onurlchange` and
      its `addEventListener` wrapper). Once one script grants
      `window.onurlchange`, every sandbox in that world reads these
      live, a page's later wrapper included.
    - `addEventListener` while the `load` replay wraps it.
  - A manual run's prelude can load after the page's code, and then
    the page's globals show through.
  - The recorded descriptors have no prototype, so a page's
    `Object.prototype.get` can't steer a read.
- **Plain writes stay in the sandbox**: `window.foo = x`,
  `defineProperty`, a library's `window.jQuery = …` or `this.Lib = …`.
  The page never sees them; a script that wants to export something
  writes to `unsafeWindow`.
  - They live on the Proxy's target, so the Proxy invariants hold,
    non-configurable properties included.
- **Setters go through**: a write to a built-in with a setter
  (`onload`, `location`, `name`, our `onurlchange`) reaches the page.
  A read-only one (`document`) refuses the write, as the real `window`
  does.
- **`window`, `self`, `globalThis`**, and `top` / `parent` / `frames`
  when they are this window, read as the sandbox. `unsafeWindow` is
  the page's.
- **Window methods come back bound** to the real window
  (`window.setTimeout`, `window.addEventListener`): called through the
  sandbox, `this` would be the Proxy and the method would throw.
  - The window's own methods are bound by name, whatever their value,
    since a page or another script often wraps `addEventListener` (our
    `onurlchange` support does). TM binds the same list. A script's own
    replacement of one is bound too.
  - Any other native function with no `prototype` is bound as well,
    which leaves constructors (`Image`, `Promise`) alone. Not one with
    static members of its own (`Proxy.revocable`), which a bound copy
    would lose, and not `eval`, so a bare `eval(…)` stays direct.
    `Object.prototype`'s methods (`hasOwnProperty`) aren't, so they see
    the sandbox.
  - One bound copy per method, so identity checks still hold, and
    `new` still works through it (`new window.Proxy(…)`).
  - The copy reads as native code exactly when the original does, so a
    script checking `toString` still tells the browser's
    `window.close` from a replacement.
  - Whether a function is native is worked out once per function.
- **The script's own bindings are on it**: `GM_info`, granted `GM_*`,
  `GM`, `unsafeWindow`, and a granted `close` / `focus` replacement
  (none for a frame's `close`, which stays the page's). So `this.unsafeWindow` and
  `self.GM_registerMenuCommand` feature tests pass, and a shim
  assigning to a granted name (`GM_xmlhttpRequest = …`) replaces it
  rather than hitting our `const`.
- **`__sm*` names bypass it** both ways: the eval hook's map and
  `__smGate` stay on the real window.

#### Limits

These follow from the sandbox not being the page's `window`, and TM's
sandbox has the same shape:

- `window === unsafeWindow` is false. So is a comparison with anything
  the page hands back as its window: `event.source === window` in a
  `message` listener, `document.defaultView === window`.
- Event handlers and timers get the page's window as `this`.
- A sloppy-mode assignment to an undeclared name (`foo = 1`) lands on
  the page's window, as it always did. Not for a built-in's name, which
  the scope claims: `fetch = wrapper` stays in the sandbox, and
  `onerror = f` reaches the page through its setter.
- `Object.freeze(window)` throws, as the page's window can't be frozen
  either.
- Every bare name the script reads goes through the scope's `has`,
  and a bare built-in through the sandbox too, so global lookups are
  slower. TM and VM pay the same. A data built-in's value (`JSON`, a
  bound `setTimeout`) is worked out once per sandbox.
- The load-listener replay recognizes the sandbox as `window` (see
  [`document-idle` and the `load` event](#document-idle-and-the-load-event)).

### sm-dev's eval hook

Scripts sm-dev runs get one more statement in the inner scope, so
`sm-dev eval` can run code inside it (`src/eval-hook.ts`):

```
;(globalThis[<key>] || <a new map>)[<script id>] = (code) => eval(code);
```

- A direct `eval` runs in the scope it's written in, so the arrow sees
  the script's `GM_*` bindings, its `@require`s' top-level declarations
  and its own, after the script has finished.
- Only the scripts in an sm-dev run's test collection get it
  (`scratch:///<run>/...` locations), under a key naming the run.
  - Registration and the reload swap both add it.
  - Never the person's own scripts. The hook reaches everything the
    script can, and a MAIN-world script's sits on the page's `window`.
- The arrow is named `sm-dev eval`, so code run through it shows that
  frame in stack traces rather than one named after the script id.
- The map is a non-enumerable global under a key naming the run, out
  of a page's casual view. A page that looks for it can still find it.
- It goes after the user program's directive prologue, so a leading
  `"use strict"` still applies, and on that line, so no line moves.
  - The rest of that line moves right by the hook's length, which only
    matters to a script written on one line: its stack columns are off.
- A script whose own source opens with an IIFE (immediately invoked
  function expression), the usual `(function () { ... })()` wrapper,
  gets a second copy just inside it (`leadingFunctionBody`).
  - It replaces the first in the map as the IIFE starts. The inner scope
    sees everything the outer one does, plus the IIFE's locals.
  - Looked for in the script's own source, after its `@require`s: a
    library's wrapper isn't the script's scope.
  - Arrows and `async`, `!function` and `void function` forms count.
    Anything else gets only the outer copy.
- Locals inside any other function stay out of reach.

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
  (SW replied `skip`, or no decision came). Logged only, with no
  badge change, except no decision, which shows on the badge as an
  error. `skip` comes from "Reload page with no userscripts" or its
  per-script forms (see
  [matching.md](matching.md#reload-with-no-userscripts)), an sm-dev
  claim, or [No decision](#no-decision).
- `sm:focus` — the document came to the front. Not per-script and not
  a report about one: one listener per world per document, and the SW
  answers it by checking this tab's local scripts for edits. See
  [updates.md](updates.md#focus-triggered-refresh).

For the report types (start / swapped / error) the SW:

- Logs the event to the SW console.
- Looks up the sender tab's state in `chrome.storage.session` and
  merges the report into the tab's `actual` map (script ID → `{state,
  name, message?}`).
- Re-renders the toolbar badge (color and tooltip) from the union of
  expected and actual entries, via the popup's view. See
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

**For a local script it is now the backstop rather than the first
line**, because the
[focus-triggered refresh](updates.md#focus-triggered-refresh) checks
local scripts when the user switches to the tab:

- That check usually lands first, so by reload time the new body is
  already registered and there is no race to win.
- What is left for the fast path is an edit that arrives while the tab
  is already in front — no switch to trigger on.

**For an http(s) script the fast path is still the only mechanism.**
The focus check deliberately skips those (a conditional GET to a third
party on every alt-tab), so a published update is picked up by the
reload's own refresh, racing the same 500 ms window as before.

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

### Skipping the check at document-start

The check-pending round trip is async. For a `document-start` script
that is the only gate, so an inline `<script>` early in `<head>` can
run before the body, which defeats a script that must patch the page
first (user-agent spoofing, API shims).

So the wrapper skips the round trip and runs `run` straight away
(`canSkipDecision` in `userscript-prelude.js`) when every one of
these holds:

- `@run-at document-start`. Later gates wait for a lifecycle event
  anyway, so the round trip costs them nothing.
- The top frame, on a navigation that isn't a reload (the
  Navigation Timing entry's `type`).
  - `run-new` and the "Reload page with no userscripts" `skip` only
    happen on a reload.
  - That `skip` covers subframes too, and a subframe can't see the
    top page's navigation type, so subframes always ask.
- In a browser sm-dev is connected to, its tab vouches for the
  script's run, since a claim can `skip` on any navigation. sm-dev marks
  the pages for that; see
  [sm-dev-design.md](sm-dev-design.md#making-wrappers-ask).
  - A scratch script needs the vouch anywhere, since it runs only in
    its run's tabs.
- No GM storage grant: the reply carries the values snapshot.
- No `.tld` rule: the reply carries the SW's exact match check.
- The GM runtime is already in, for a script that grants an API it
  provides. It can be registered after the wrapper (see
  [Ordering](#ordering)).

What it sends before the bridge is in (its start, errors, `GM_*`
calls) is held until the bridge is (see [Ordering](#ordering)).

Gaps:

- On a reload, `document-start` scripts still wait, so a page's
  first inline scripts can win there.
- So does a script that needs the GM runtime when it landed after the
  wrapper.

### sm:check-pending handler

When a wrapper sends `sm:check-pending` with its own `id`, `loadedAt`
(the value baked in at registration), and `url`, the SW:

Before any of this:

- A tab marked for "Reload page with no userscripts" gets `skip`, for
  every frame; one marked for a per-script form, only for the scripts
  it keeps out — see
  [matching.md](matching.md#reload-with-no-userscripts).
- A request with `tld: true` (a script with a `.tld` rule) is checked
  against the script's exact patterns, with the frame's URL, and gets
  `skip` with reason `no-match` if they don't cover it. See
  [matching.md](matching.md#tld-hosts).

Otherwise the SW:

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
   - `loadedAt` also moves when only a `@require` / `@resource`
     changed, and the swapped body is composed with the requires, so an
     edited library swaps in on the same reload as an edited script.

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
  `summarizeToolbar`: it describes a swap in flight rather than the tab's
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
reload fast path.** One `RefreshBatch` (`src/extension/script-store.ts`) is
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
- the **`file://` directory listing**, fetched once per directory. A
  page load's checks list no folder while their files read (the batch's
  `localLookup: 'known'`, see
  [local-file-overrides.md](local-file-overrides.md#page-load-checks)),
  so this is only for a read that failed;
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
    - Now that page-load checks read each file directly, only a check
      whose read failed uses a shared listing.
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
  shared read reads as shared rather than as a phase that vanished. A
  script file read directly is annotated `read directly`. See
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
  buttons, Refresh All and `sm-dev validate` all wait for the verdict.
  - sm-dev's `script refresh` waits too, but runs in the worker, so it
    can join a navigation's deferring check already running. It then
    reports the row before the verdict lands.
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
  `gmValues` field carrying the script's current snapshot, from the
  worker's value store (writes not yet on disk included), and `gmSeq`,
  the sequence number it's current to.
- **No fallback.** This is the **only** way the wrapper learns
  its initial storage state — there's no baked literal.
- **On missing snapshot.** Prelude logs a console error, sends
  `sm:error`, and `return`s out before the body runs. Triggers
  when the SW's snapshot read failed, or the bridge gate refused
  it. (No decision at all is [No decision](#no-decision).)
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
  or `.make` calls) to the body it hands
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

### No decision

When the wrapper can't get a decision, the script does **not** run.

- The decision is what keeps scripts out of an sm-dev run's tabs (and
  a run's own scripts out of every other tab), honours "Reload page
  with no userscripts", and checks a `.tld` rule exactly. Running
  without it would undo each of those.
- "No decision" covers:
  - no answer within `DECISION_TIMEOUT_MS` (10s);
  - the call failing, or an answer that isn't a decision;
  - the bridge reporting a failed call (`bridgeError`), which it sends
    rather than leaving the wrapper waiting;
  - `handleCheckPending` throwing, which answers this skip itself.
- The timeout: an answer normally takes milliseconds, and the slowest
  one the SW means to give (a reload swap) is bounded at 500ms. 10s
  leaves a cold or busy SW room to start, so failing closed doesn't
  drop scripts on a slow start.
- What it says:
  - a `console.info` line in the page: `<name>: It did not run.
    <why>.`;
  - an `sm:abandoned` report with `reason: "no-decision"` and the why
    as `detail`, when the SW is there to receive it. That's an error in
    the script's Log, and on the badge (red, with the why in the
    tooltip), and an sm-dev run prints it as a skip, with the why.
  - The SW's "never started" check waits past the timeout, so a script
    still waiting isn't explained as one the page blocked.
- A snapshot read that fails is not "no decision": the decision
  stands, and a storage script aborts as above.
- Outside a tab (`sender.tab` missing), the SW makes the same
  decision less the tab's own parts (a claim, a reload skip, a reload
  swap): a run's own script still skips, and a `.tld` rule is still
  checked exactly.
- A page put in the back/forward cache while its question is in flight
  gets the call rejected, so that script doesn't run there when the
  page comes back.

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
- A decision that lands after `load` would make an idle body miss its
  own load listener; see
  [`document-idle` and the `load` event](#document-idle-and-the-load-event).

`document-start` gets no free wait — `waitForRunAt` calls back
synchronously once `<html>` exists — so the decision is its only gate,
and the decision timeout remains the hard ceiling for every `@run-at`.

### Caveats

- **MAIN-world scripts** can't call `chrome.runtime.sendMessage`
  directly, so they round-trip `sm:check-pending` via
  `wrapper-bridge.js`: the request as a `sourcemonkey-sync-<key>`
  event, the answer as a `sourcemonkey-reply-<key>` event keyed on a
  per-request nonce. The channel key keeps the page from sending or
  hearing either (see [The channel key](#the-channel-key)). Where
  the page's CSP forbids `unsafe-eval`, the swap eval throws; the
  prelude detects the CSP marker in the error message and falls
  through to running the baked-in main body, matching pre-fast-path
  behavior for that site.
- **Latency on every navigation, not just reloads.** Every wrapper
  round-trips `sm:check-pending` regardless of `transitionType` — the
  SW just replies `run` faster when there's no fast-path entry. For
  USER_SCRIPT-world scripts that's ~1–5ms on the document-start
  critical path; for MAIN-world (which routes through
  `wrapper-bridge.js`) it's more, though the request leg itself is a
  synchronous event dispatch rather than a task hop.
- **World changes defer the swap.** Adding `@inject-into content` (or
  `@sandbox DOM`) moves a script MAIN → USER_SCRIPT, but the running
  wrapper is stuck in the world Chrome injected it into — a body that expects
  page context can't see the page's globals from the isolated world,
  and one that expects isolation gets a `window` the page can reach.
  A request relayed over `wrapper-bridge.js` is by definition from a
  MAIN wrapper, so that plus a USER_SCRIPT new row means "defer to
  the next reload", and vice versa.
- **A newly-needed GM runtime defers the swap — decided by the
  wrapper, at run time.** The shared GM runtime is registered
  only in worlds that have a script granting a runtime-backed API (see
  [`GM_*` in MAIN world](#gm_-in-main-world)), so a page whose scripts
  grant nothing carries none. A refresh that adds the first such grant
  would ship a body whose GM_* bindings resolve to nothing. The SW
  marks such a reply `needsRuntime`; the wrapper checks
  for the runtime (`reg.gm`) at the moment the body is about to run and falls
  back to the baked-in body if it's absent. At run time, not at
  wrapper start: the runtime is its own `document_start` registration
  and may sit after the wrapper in Chrome's order (an updated
  registration moves to the end), but by run time every
  `document_start` registration has executed.
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

- **Frames.** Scripts run in every frame whose URL they match, unless
  `@noframes`; frames with no URL of their own (`about:blank`,
  `srcdoc`) get none. See [frames.md](frames.md).
