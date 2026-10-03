# Updates

How an installed script gets newer, and how SourceMonkey reports a
newer copy it *won't* fetch.

## Refresh vs. probe

- **Refresh** — fetch the bytes we run, from the URL the user installed
  from. Re-stores the body, can change `status` / `refreshError`.
  Lives in `script-store.ts` + `script-updater.ts`.
- **Probe** — ask some other URL what `@version` it claims. Reads one
  header line, changes nothing but a display annotation. Lives in
  `src/version-probe.ts`.

Keeping them apart is the point of the design. A probe host that's down
must not disable a working script, and a URL the script names in its
own header must not silently become an update channel.

## Refresh: the collection is the update channel

Every collection kind already auto-updates from where it was installed:

- **`file://`** — the scan reports each file's size + mtime; a change
  refetches and re-stores.
- **`http(s)://`** — a conditional GET (`If-None-Match` /
  `If-Modified-Since`); a 304 skips the body, anything else re-stores.

Both run on manual Refresh and opportunistically when a matching page
loads (rate-limited; see `UPDATE_MIN_INTERVAL_MS` in
`script-updater.ts`). So a local edit and a published update both land
without the user doing anything.

## Focus-triggered refresh

Bringing a tab to the front also checks the **local** scripts running
on it. `installFocusRefresh` in `src/extension/background.ts`.

### Why

- The edit-and-reload loop is: edit the file somewhere else, come back
  to the browser, reload.
- Nothing noticed the edit until that reload, which then had to win the
  [reload fast path](injection.md#reload-fast-path)'s 500 ms race or
  ask for a second reload.
- Checking on focus moves the work into the seconds the user spends
  switching windows, so the RELOAD badge is already up and the new body
  already registered before they reach for the reload key.
- The fast path stays, as the backstop for an edit that lands while the
  tab is already in front.

### What signals a switch

Each covers a case the others don't, so all of them feed
`refreshLocalScriptsOnTab`:

- **`chrome.tabs.onActivated`** — another tab in this window came to
  the front. Silent when Chrome itself regains focus.
- **`chrome.windows.onFocusChanged`** — focus moved to a different
  Chrome window. Silent on a tab switch.
- **`sm:focus` from the page** — the injected prelude's own `focus` /
  `visibilitychange` listener, reported to the SW.

Why the page reports at all, when Chrome has events for this:

- Returning to Chrome from **another application** is the case the
  feature exists for — edit in an editor, alt-tab back.
- Measured on Linux/X11, that gesture raises **no** `chrome.*` event:
  not `onFocusChanged`, not `onActivated`.
- Whether it does is platform- and window-manager-dependent, so the
  page is the only signal that behaves the same everywhere.

Details of the page-side half (`installFocusSignal` in
`src/userscript-prelude.js`):

- One listener per execution world per document — the prelude IIFE is
  idempotent — armed only once some script has matched this URL. A page
  running scripts in both worlds therefore reports twice per gesture,
  each with its own floor. Scripts never register with `allFrames`, so
  subframes add nothing.
- A 5 s floor per document, below the SW's own interval so it never
  becomes the binding limit. It exists to stop focus churn from waking
  the worker, not to rate-limit checks.
- MAIN-world scripts reach the SW through `wrapper-bridge.js`, so
  `sm:focus` is on its allowlist. A page can therefore forge one; what
  that buys is a check the tab's own navigation already does, bounded
  by the same 10 s interval, returning nothing to the page. See the
  bridge's trust-model comment.

Several signals can describe one gesture:

- A per-tab guard in the SW drops one that arrives while another is
  still reading. It is held only across those reads, so two signals a
  few milliseconds apart both get through.
- What actually collapses their *work* is the updater's gate — it
  coalesces onto a check already in flight, and skips one inside the
  interval.
- Deliberately no time-window debounce on the SW side: it would also
  swallow a genuine second switch, and the interval that should decide
  whether to re-check belongs in the updater.

`dlog` lines name each signal as it arrives (enable debug logging in
Options), so "the event never came" and "it came and we filtered it"
stay distinguishable — the distinction that found the Linux gap.

### What gets checked

- The scripts the tab's **current document** matched — the same set the
  badge is computed from. An older document in the tab is off screen.
- **Local rows only**, keyed on each script's own `fileUrl`, not on its
  collection's location: a container collection holds scripts of both
  kinds. `localScriptIds` in `src/extension/match-index.ts`.
  - An http(s) script would mean a conditional GET to a third party on
    every alt-tab, for a script the user is unlikely to be editing.
- `@require` / `@resource` follow the ordinary opportunistic policy: a
  local stand-in is re-read, a remote dependency keeps its cached copy
  until an explicit Refresh. See
  [requires.md](requires.md#refresh-policy).

### What it costs

- The two `chrome.*` listeners are registered at the top level, as MV3
  requires, so **every tab switch and window focus change now starts
  the service worker if it was idle** — on every profile, including one
  with no local scripts at all. That is the price of hearing about the
  switch; there is no way to register conditionally.
- So the handler answers the cheap question first: `hasLocalScripts()`
  reads the in-memory match index, and a profile with only http
  collections returns before touching `chrome.storage.session`.
- The page-side signal costs nothing on a page we run nothing on — no
  script matched, no listener installed.

### Rate limiting

`UPDATE_MIN_INTERVAL_MS` (10 s, per script) is the only limit — the
same gate every opportunistic check passes through. So a burst of
window switching costs one check per script per 10 s, and a switch back
inside that window is a no-op.

### What it doesn't do

- **A backgrounded tab is not checked.** Nothing polls; the trigger is
  the user arriving at the page. A tab they never switch to learns
  about the edit on its next navigation.
- **A page with no SourceMonkey scripts reports nothing**, so the
  page-side signal costs nothing where there is nothing to check.
- **It doesn't reload anything.** The page keeps running the old body
  until the user reloads — see [TODO.md](../TODO.md) for the auto-reload
  idea this is the conservative half of.

## Probe: what `@updateURL` / `@downloadURL` claim

### Why we don't update from them

- `@downloadURL` is a header line *inside the script*.
- Honoring it as a fetch target lets a script move its own update
  channel to an origin the user never approved: install from a site you
  trust, and the second version comes from somewhere else.
- Tampermonkey accepts that trade. We don't need to.

**Report, never follow.** The URL the user installed from stays
authoritative; the only thing that crosses over from a probed copy is
its version number.

### What gets probed

The distinct `@updateURL` / `@downloadURL` values that differ from the
script's own `fileUrl`:

- Only absolute `http(s)` URLs. A relative one has no meaning for a
  fixed upstream home, and a `file://` one would turn a header line
  into a host-file read.
- Compared canonically, so `https://h:443/x` and `https://h/x` are the
  same URL.
- Deduped, so the common GreasyFork shape (`@downloadURL` = the
  `.user.js` we installed from, `@updateURL` = its sibling `.meta.js`)
  yields one target, not two.

Our own source is never probed — the refresh that just ran already
established what's there, and a probe would be a slower way to learn
it.

### When it runs

Straight after a refresh, against the rows it produced, for `ok` rows
only. How hard it tries is a `ProbePolicy`, passed explicitly:

- **`force`** — an actual Refresh / Refresh All / viewer-Update click.
  Ignores the interval; the user asked.
- **`if-stale`** (the default) — everything else, including the
  opportunistic navigation check *and the reload fast path*. Probes
  only when the stored answer has aged past `PROBE_MIN_INTERVAL_MS`
  (6 h).

The policy is deliberately not derived from the refresh's `manual` /
`opportunistic` mode. `manual` means "not rate-limited as a refresh",
and the reload fast path uses it for every matched script on every
explicit tab reload — keying off it would fire a third-party request,
and a userscript re-registration pass, per script per reload.

Staleness rules:

- A target the script *newly* declares makes the set stale regardless
  of age, so adding an `@updateURL` gets checked on the next pass.
- A stored row whose URL is *no longer* a target also makes the set
  stale, so a dropped header sheds its row instead of reporting
  OUTDATED against a URL the script doesn't name.
- A failed probe still records `checkedAt`, so an unreachable host
  isn't retried on every navigation.
- `PROBE_SCRIPTS_CONCURRENCY` caps how many scripts probe at once, so
  Refresh All over a large collection doesn't open one request per
  script (see [storage.md](storage.md#fan-out-is-bounded)).
  - Sized for the callers that **await** the pass — a Refresh holds its
    spinner until the probes land, so the cap is wall-clock the user
    sees, not just background load. It was tuned much lower for the
    fire-and-forget per-script caller until measurement showed the
    collection paths paying for it.
  - A per-script cap on probe URLs sits inside it
    (`PROBE_URLS_PER_SCRIPT_CONCURRENCY`) but never binds: a script has
    at most two targets. It is a guard against a future third target
    kind, not a working limit.

Awaited by the collection-level entry points, not by the per-script one:

- The per-script check's promise is what the
  [reload fast path](injection.md#reload-fast-path) races against a
  500 ms window. A third-party fetch inside it would blow that budget
  and drop the reload back to running the old body.
- Its storage write repaints any open viewer when it lands, so nothing
  is lost by not waiting.
- The Refresh / Refresh All buttons do await — the user is watching a
  spinner and expects the row to be current when it stops.

### What it records

One `VersionProbe` per target on `StoredScript.versionProbes`:
`{kinds, url, version?, error?, checkedAt}`.

- `error` says why the latest attempt produced nothing new: the fetch
  failed, the response had no metadata block, or it had one with no
  `@version`.
- `version` survives a later failure, so the two fields can coexist.
  Retracting a verdict because the host 500'd this afternoon would flap
  the OUTDATED badge off and on and re-log the transition each time it
  recovered. The viewer keeps showing the version and moves the failure
  into the row's tooltip.
- Every failure reads `could not fetch`: the shared byte-fetcher
  reports network errors, non-2xx, timeouts, and over-cap bodies
  identically, so the row says "we couldn't check", not why.

The probe response may be a bare `.meta.js` or a whole `.user.js` —
managers accept either at an `@updateURL`, and `parseHeader` reads the
metadata block wherever it sits.

Split across two modules so display code stays off the fetch stack:
`src/version-probe.ts` is pure (targets, verdict, staleness, types) and
is what `script-display.ts` / `collections.ts` / `script-details.ts`
import; `src/extension/version-probe-fetch.ts` does the fetching and is reached
only from `script-updater.ts`.

## Version comparison

`src/version-compare.ts`, pure and unit-tested:

- Dot-separated segments; numeric pairs compare as numbers (`1.10` >
  `1.9`), anything else by code-unit order.
- Missing trailing segments read as `0`, so `1.2` and `1.2.0` are the
  same version.
- An optional `-prerelease` tail sorts below its release (`1.0-rc` <
  `1.0`), and between prereleases the shorter prefix is lower.
- Always returns an ordering — there's no "incomparable" verdict,
  because every caller has to pick newer / older / same anyway.

`versionRelation(loaded, other)` is the display-facing wrapper. It
returns `unknown` when either side has no `@version`: with nothing to
compare, "same" would be a lie.

## What the user sees

### Collections page

The Status cell shows **OUTDATED** (amber) when a probe found a newer
version; hovering gives the version and the URL.

- Ranks below `REFRESH FAILED` — a collection we can't reach at all
  subsumes "some other copy is ahead".
- Ranks above the log-derived `ERROR` / `WARNING`, which have their own
  surface in the Log tab. See
  [storage.md](storage.md#displayed-status-ui-level).
- Running *ahead* of the published version is normal for a local edit,
  so it isn't a status — only a details row.
- A probe *failure* isn't a status either, which is why the details row
  is load-bearing rather than supplementary — see the viewer section
  below.

### Script viewer

Under the `Version` row, one row per probe:

- Label — `Version at update URL` or `Version at download URL`. One URL
  named by BOTH headers is labeled `update URL`, not spelled out as
  both: `@updateURL` is the header that means "check here for a new
  version", so it names what we did, and the combined form was the
  longest label in the panel for a distinction nobody can act on.
- **A probe only gets a row when it has something to say**, so any row
  present is one to act on. Exactly one case is dropped: its version
  matches ours **and** the latest check succeeded — the expected state
  of an up-to-date script.
- Three things each earn a row:
  - **The versions differ** (`newer` / `older`).
  - **Ours is a local edit of theirs** (`edited`): our `@version` is
    theirs plus a `-local` tail, the mark a local copy gets (see
    [local-copy.md](local-copy.md#the--local-suffix)). By the
    prerelease rule alone their release would rank *above* us and the
    copy would read OUTDATED against the version it was copied from.
  - **Exactly one side declares a `@version`.** We can't rank them, but
    "they publish 2.0 and we declare nothing" is still a difference
    worth seeing. The `Version` row above then reads `<none>`, so both
    halves of the comparison are on screen.
  - **The latest check failed**, whatever the version says — see below.
- **Any probe carrying an `error` keeps its row**, because this row is
  the failure's *only* surface: probes run downstream of the refresh and
  can't set a status or a `refreshError` (see `runVersionProbes`), and
  nothing logs them. Two shapes of that:
  - never resolved a version at all — a permanently broken
    `@updateURL`, which would otherwise read as up to date;
  - resolved one earlier and is failing now — the host went away after
    a good check, which is the more common way this breaks.
- Value and tooltip split by which of the two is the news:
  - versions differ → value `2.1 (Newer)` / `1.0 (Older)`.
  - a local edit → value `2.0 (Base of this local edit)`.
  - only they have a version → value is the bare number, no qualifier.
  - versions agree, check failed → value is the error, tooltip adds
    `last known version 2.0`.
  - no version at all → value is the error.
  - The tooltip is always the URL, plus `last check failed: …` whenever
    there's an error the value isn't already showing.
- The `(Newer)` case is highlighted; nothing else is — an upstream we
  can't rank is not "newer".

Preview mode shows no probe rows. A not-yet-installed script hasn't
been probed, and rendering a row would imply we had checked.

## Deliberately not built

- **Auto-update from a probed URL.** That's the "report, never follow"
  rule above.
- **Probing our own source.** The refresh already covers it.
- **Notifications.** The status is the surface; a script being one
  version behind isn't worth interrupting anyone.
