# URL matching and the per-tab badge

How SourceMonkey decides which scripts apply to a URL, and how that
result becomes the toolbar badge + tooltip you see on a tab.

Related modules:

- [match-rules.md](match-rules.md) — what `@match`, `@include` and
  `@exclude` rules mean, and how other managers read them.
- [storage.md](storage.md) — the underlying `StoredScript` shape and
  where `matching` comes from.
- [script-viewer.md](script-viewer.md) — header parsing (`@match`,
  `@include`, `@exclude` originate here).

## How patterns are matched

What the rules mean, and how other managers read them:
[match-rules.md](match-rules.md). How SM gets there:

- **One matcher**, `src/url-match.ts`, for the badge, `sm-dev match`,
  and the worker's checks.
- **Chrome injects** from what `buildRegistrationSpec` (`injector.ts`)
  registers: `matches` for `@match`, `includeGlobs` / `excludeGlobs`
  for globs.
- **The wrapper's in-page matcher** (`userscript-prelude.js`) narrows
  that wherever Chrome can't say a rule exactly.
  - The worker builds its regexes at registration (`pageMatcher` in
    `url-match.ts`), so the page only tests them against its URL.
  - The prelude cases in `tests/unit/injector.test.mjs` and the
    `pageMatcher` cases in `tests/unit/url-match.test.mjs` check it
    agrees with `urlMatchesScript`.

### Lenient readings (`canonicalMatchPatterns`)

The readings in
[match-rules.md](match-rules.md#lenient-readings) are rewrites into
Chrome's spelling, done before anything else looks at a pattern.

- **One pattern in, one per scheme out.** Usually one, and the input
  verbatim when there's nothing to rewrite.
- **A scheme glob is enumerated, not approximated.**
  - `http*://` names http + https, which is exactly what `*` means, so
    it comes back as `*://`.
  - Every other expansion comes back as concrete schemes: `*s://` →
    `https://` alone, `*t*://` → `http://` + `https://` + `ftp://`.
  - So there is **no scheme re-check afterwards, and none is needed**.
    Nothing is ever rounded up to `*`. That matters because Chrome
    does the matching: a pattern registered wider than the author's
    would inject before any wrapper-side filter could run.
- **The host and path readings** (no path, a leading `*` on a host)
  are `readHostAndPath`.
- **The rewrite runs ahead of the matcher, the validator, and the
  registration**, so all three see one pattern. Chrome registers the
  rewritten form: an unrewritten pattern would be refused, and the
  script would stop running where its author said.
- **The wrapper's regexes are built from the rewritten form too**
  (`pageMatcher`), so the in-page matcher agrees with what the SW
  registered.
- **Not measured against a real Tampermonkey** in the suite: that
  needs the cross-manager browser profile, which is set up by hand
  (see [cross-manager-testing.md](cross-manager-testing.md)).

#### `*` beside a numeric port

The one place the rewrite has to say `*` the long way. Chrome's parser
refuses `*://localhost:3000/*` with `Invalid port`, but accepts:

- `http://localhost:3000/*` — a named scheme beside the same port;
- `*://localhost:*/*` — `*` beside a wildcard port.

So `*://host:3000/*` is registered as the pair `http://host:3000/*` +
`https://host:3000/*` — what `*` means anyway.

- Applies to patterns written that way, not just to the lenient
  rewrites: a port-pinned `*://` pattern used to be a
  [REJECTED](injection.md#rejected-registrations) registration.
- Probed against Chrome 148; the lenient-match cases in
  `tests/e2e/injection.spec.ts` pin it against a real browser.

### Patterns Chrome refuses

`matchPatternProblem` finds the patterns SM ignores (listed in
[match-rules.md](match-rules.md#patterns-sm-ignores)).

- **Why at parse time**: Chrome refuses a **registration as a whole**
  over one malformed pattern. The script's good patterns die with the
  bad one, and the complaint comes back in Chrome's coordinates
  (`matches[1]: Invalid host wildcard`), with no way back to the
  header line.
- **It judges the canonical forms**, so the lenient shapes are
  accepted, and a problem the rewrite doesn't cure is reported against
  the pattern the author actually wrote.
  - A pattern is a problem only when every canonical form is one.
- **What happens to one**:
  - `buildRegistrationSpec` leaves it out of the registration.
  - `extractStartupLogs` turns it into a Log warning on its header
    line.
  - `validateHeader` stores the row INVALID with its reason, when no
    `@match` or `@include` is left.
- **Deliberately narrower than Chrome's parser**: a false positive
  would ignore a pattern that works. A malformed port, say, still
  reaches Chrome and still comes back as
  [REJECTED](injection.md#rejected-registrations), which remains the
  backstop for everything this doesn't reproduce.
- **Ignoring them is safe** because the two agree: every pattern
  flagged here is one `matchPattern` could never have matched either,
  so no page loses a script it was getting.
  `tests/unit/url-match.test.mjs` pins it.

### Registering `@include` and `@exclude`

Chrome tests globs case-sensitively, and reads `?` as a one-character
wildcard. SM's globs ignore case and take `?` literally. So:

- **A glob `@include`** registers widened (`chromeIncludeGlob`):
  - The host is lowercased, which keeps it exact, since Chrome
    lowercases it in the URL.
  - Every other letter becomes `?`, which Chrome reads as any one
    character, so it takes the letter in either case:
    `*://WWW.Example.com/Page*` registers as
    `*://www.example.com/????*`.
  - The host is the text before the first `/`, after any leading
    `scheme://`, when it has a dot or follows `scheme://` with no `*`
    (`localhost`). In `*Foo/bar*`, `Foo` may well be in the path, so
    it becomes `???` too.
  - A `.tld` `@match`'s coarse glob goes through the same widening,
    so its host is lowercased as well.
- **A regex `@include`** has no Chrome equivalent, so its script
  registers for every page.
- **An `@exclude`** is always checked in the page, which turns on the
  wrapper's matcher. Chrome also gets each glob `@exclude` it can only
  read narrower than ours, to skip injecting: all but `.tld` ones and
  ones with a `?`.
- **The wrapper's matcher** then holds the script to its rules. More:
  [injection.md](injection.md#regex-pattern-forms).

### `.tld` hosts

What `.tld` means: [match-rules.md](match-rules.md#tld-hosts).

- **How it's tested**: each public suffix the URL's own host ends in
  is put in place of `.tld`, and the result tested as an ordinary
  pattern. So `.tld` can only ever stand for the host's real suffix.
  - In a `@match`, it's found in each canonical form, so it's judged
    on the pattern as read, the same text that is registered.
- **The list**: `src/public-suffixes.ts`, generated by
  `node scripts/update-public-suffixes.mjs` and committed, so the
  build stays offline. Rerun it now and then; the diff shows what
  changed.
- **Where it's decided**: the list (about 75 KB) stays out of pages.
  - Registration: Chrome's grammars can't say `.tld`, so a `.tld`
    `@match` or `@include` registers a coarse glob: `.tld` becomes `.*`
    (`*://www.google.*/*`), and a `@match`'s leading `*.` becomes `*`
    (`tldCoarseGlob`). See [injection.md](injection.md#regex-pattern-forms).
  - In the page, the wrapper's matcher reads `.tld` loosely, as any
    labels, and ignores a `.tld` `@exclude` (a loose one would exclude
    too much).
  - The exact reading comes from the service worker (sm-dev's host,
    under sm-dev): the wrapper's `sm:check-pending` carries `tld: true`,
    and the reply is `skip` with reason `no-match` where the exact
    reading says no. The wrapper treats that like its own matcher
    saying no, and reports nothing.
  - With no reply (the worker never answered), a `.tld` script skips
    rather than runs: the loose reading alone would also take hosts
    like `www.google.evil.com`.
- Pinned by `tests/unit/url-match.test.mjs`, the prelude cases in
  `tests/unit/injector.test.mjs`, and in a real browser by
  `tests/e2e/tld-hosts.spec.ts`.

### Combined rule (`urlMatchesScript`)

The rule in [match-rules.md](match-rules.md#combining-rules), as one
function. `explainUrlMatch` is the same rule, listing every hit for
`sm-dev match`.

- A script with no `@match` and no `@include` never matches, but
  `validateHeader` stores those INVALID, so they never reach the match
  index.

### Effective enabled

A script participates in matching only if **both** its own `enabled`
flag and its parent collection's `enabled` flag are true. The two toggles
compose: turning the collection off blanks the count for every script
under it, but each script's individual choice is preserved so flipping
the collection back on restores the prior state.

## In-memory match index

`src/extension/match-index.ts` keeps an in-memory `Map<scriptId, MatchedScript>`
of every injectable script so the background SW never hits
`chrome.storage.local` on the navigation hot path. Injectable means
`status: 'ok'`.

Lifecycle:

- **Startup**: `ensureLoaded()` reads all `script:*` and `collection:*`
  rows once, populates the cache, and records which collections are
  disabled.
- **Updates**: `installStorageListener()` registers a
  `chrome.storage.onChanged` listener that mutates the cache in place
  on every `set`/`remove` of a `script:*` or `collection:*` key. `ok`
  scripts are kept; `error` entries get evicted. The per-script
  `enabled` flag is checked in `findMatchesForUrl`, not at cache
  build. Collection changes
  flip an in-memory `disabledCollections` set, which lets a collection toggle
  re-evaluate every script under it in O(1).
- **Subscribers**: `onCacheChanged(fn)` lets the background SW re-badge
  every open tab when the script set itself changes (e.g. after a
  directory Refresh on the collections page or a per-collection / per-script
  enabled toggle).

Per-navigation cost is one `Map` iteration + the pattern checks for
each cached script. No I/O.

## Per-tab badge + tooltip

`src/extension/background.ts` reacts to navigation via `chrome.webNavigation`
(main frame only):

- **`webNavigation.onCommitted`** — fresh document load OR bfcache
  restore. The `documentId` distinguishes the two — Chrome reuses the
  ID across bfcache restores.
- **`webNavigation.onHistoryStateUpdated`** — SPA pushState /
  replaceState. Same `documentId` as the underlying page.
- **`chrome.tabs.onRemoved`** — drop the tab's row from session
  storage.
- **Cache-changed callback** — when the script set itself changes
  (Refresh, toggles), recompute expected for every open tab without
  bumping `documentId`, so running-script reports survive.

A fallback `chrome.tabs.onUpdated` listener kicks in only if
`chrome.webNavigation` isn't available (older Chromes / permission
revoked).

For each tab we:

- Skip URLs whose scheme isn't one we could conceivably inject into
  (anything besides `http`, `https`, `file`, `ftp`). The badge is
  cleared for those tabs.
- Log matches to the SW console (one line per matching navigation).
- Persist a `TabRecord` (`{currentDocId, docOrder, byDoc}`) to
  `chrome.storage.session` under `"tab:<tabId>"` — see *Per-tab
  document LRU* below for why this isn't a single state. Session
  storage survives SW restarts (MV3 workers idle out aggressively)
  but is dropped when Chrome shuts down.
- Render the badge from the union of `matches` (expected) and `actual`
  (sm:start / sm:error reports — see below).

### Badge view (expected ∪ actual)

- `computeBadge` (`src/extension/tab-status.ts`) gives each script in
  the union of expected and actual a status.
  - Scripts running in the page's iframes count too, one row each,
    worst run first (see [frames.md](frames.md#status-badge-and-popup)).
- The popup's view (`buildPopupView`) builds on those, adding the
  statuses only it tells apart. See [status-popup.md](status-popup.md#status-pills).
- `summarizeToolbar` (`src/extension/toolbar-summary.ts`) sums up the
  popup's rows into the badge and its tooltip, so the icon and the
  popup can't disagree.

#### Script statuses

From `computeBadge`:

- `OK` — expected and the wrapper sent `sm:start` with no error.
- `ERROR` — wrapper sent `sm:error` (regardless of expected).
- `REJECTED` — expected by the matcher, no `sm:start`, and Chrome
  refused the registration, so none is coming
  (see [injection.md](injection.md#rejected-registrations)).
  - A refinement of `MISSING`: both mean "expected here, never
    reported".
  - `MISSING` is provisional (the wrapper may still be in flight);
    this is settled, which is why it takes the error color.
- `NOT_LOADED` — expected, no `sm:start`, and none is coming because
  the document was loaded with "Reload page with no userscripts"
  (`scriptsSkipped`), or one of its per-script forms. Also on a page
  loaded while user scripts were disabled, while they still are.
  - Also a refinement of `MISSING`, settled by the user, so it
    outranks `REJECTED`. (Not the user-scripts-disabled case, which
    `REJECTED` outranks, as it does `UNTRACKED`.)
- `UNTRACKED` — expected, no `sm:start`, on a page that loaded before
  this copy of the extension started (see
  [Pages open before the extension started](#pages-open-before-the-extension-started)),
  or while user scripts were disabled (see
  [Pages loaded while user scripts were disabled](#pages-loaded-while-user-scripts-were-disabled)).
  - Also a refinement of `MISSING`, but not provisional: no report is
    coming. `REJECTED` outranks it, since a reload won't cure that.
- `MISSING` — expected by the matcher but no `sm:start` yet.
- `UNEXPECTED` — wrapper sent `sm:start` but the matcher didn't
  predict it (Chrome's matching disagrees with ours, or a race
  against a script-store change).
- `RELOAD` — running here, but its file on disk changed since.

Added by the popup's view (details in
[status-popup.md](status-popup.md#status-pills)):

- `PENDING` — enabled or installed since the page loaded, or matching
  only the URL it moved to. A reload would run it.
- `STILL_RUNNING` — disabled or removed since the page loaded, but
  still running.
- `WARNING` — running, with a warning. Replaces `OK` only.
- `INVALID` — its rules match, but it failed to load, so it can't
  run. A reload won't change that.

#### Badge

- **Count** — the popup's rows that have a status, so it agrees with
  the lines below.
  - Scripts enabled since the page loaded count (`PENDING`).
  - Ones disabled or removed since that never started don't.
  - In a tab an sm-dev run controls, the scripts its claim kept out
    don't (`countsOnBadge`).
- **Color** — red, purple, orange or grey, the first whose line
  applies, else green.
- **No badge** — when no script has a status here, or on a page
  scripts can't run on (any scheme besides `http`, `https`, `file`,
  `ftp`).

#### Tooltip

```
SourceMonkey
[Page under sm-dev control]
<status lines>
Click for details. Double-click for collections.
```

- The sm-dev line shows only in a tab an sm-dev run controls (see
  [sm-dev-design.md](sm-dev-design.md#the-toolbar-badge-in-a-claimed-tab)).
- Every status line that applies shows, in this order:

| Status line | Shown when | Badge color |
|---|---|---|
| `SourceMonkey can't run scripts on this page.` | The scheme isn't one scripts run on. Only line. | none |
| `No scripts match this page.` | No script has a status here. Only line. | none |
| `N scripts running.` | Scripts that reported here, errored ones included | green `#2e7d32`, if no line below has a color |
| `N scripts have errors.` | `ERROR` | red `#d32f2f` |
| `Chrome rejected N scripts.` | `REJECTED` | red |
| `N scripts failed to load.` | The popup's `INVALID`, for an enabled script | red |
| `Reload needed to update N scripts.` | `RELOAD`: changed on disk since it ran | purple `#d500f9` |
| `Reload needed to add N scripts.` | The popup's `PENDING`: enabled or installed since the page loaded, or matching only the URL it moved to | purple |
| `Reload needed to remove N scripts.` | The popup's `STILL_RUNNING`: disabled or removed since the page loaded | purple |
| `Page loaded before SourceMonkey started. Reload needed for N scripts.` | `UNTRACKED` | purple |
| `Page loaded while user scripts were disabled. Reload needed for N scripts.` | `UNTRACKED`, on a page marked `loadedWithoutUserscripts` | purple |
| `N expected scripts are not running.` | `MISSING` | orange `#f57c00` |
| `N unexpected scripts are running.` | `UNEXPECTED` | orange |
| `N scripts have warnings.` | Running with a warning (see [status-popup.md](status-popup.md#warnings)) | none |
| `N scripts skipped on this load.` | `NOT_LOADED` | grey `#757575`, if no script is running |
| `User scripts are not allowed yet.` (alone) | A page loaded while user scripts were disabled, while they still are | red |

- Lines use the singular for one (`1 script has errors.`).
- Warnings take no color: a header warning shows on every load, so
  it would keep the badge off green for good.
- A manual script ([manual-scripts.md](manual-scripts.md)) counts once
  it has run, like any other. Before that it has no line: not run is
  its normal state, and a page can match many.
- Grey says nothing ran on purpose. In a tab an sm-dev run controls,
  where its claim kept some scripts out and the rest ran, it stays
  green.
- Purple also flashes briefly while an update lands (see
  [injection.md](injection.md#purple-flash-while-a-swap-lands)); the
  tooltip doesn't change for that.

### Pages open before the extension started

- An install, an update or a dev reload of the extension clears the
  per-tab records (`chrome.storage.session`), and Chrome resets each
  tab's badge and tooltip.
- Pages already open loaded unseen. Whether their scripts run is
  unknown:
  - a copy from the old extension may still run, cut off from it (its
    GM_* calls fail);
  - or none may.
- So `onInstalled` (reason `install` or `update`) gives each open,
  non-discarded tab a record marked `loadedBefore`. Its matching
  scripts show as `UNTRACKED`: a purple badge, and a Reload pill and
  banner in the popup.
  - Its URL and document come from one `webNavigation.getFrame` call,
    so a page that committed since isn't marked.
  - A script added or enabled after that shows as `PENDING`, as usual.
    That's why a tab with nothing matching gets a record too.
  - Not on browser startup, where `onInstalled` doesn't fire: restored
    tabs load afterwards, so they're watched.
  - Not when the extension is re-enabled, which fires no `onInstalled`
    either. Such tabs keep no record, and no badge.
- A sync's refresh of the open tabs (`refreshAllOpenTabs`) leaves a tab
  with no record alone, rather than making one that would show every
  script as `MISSING`.

### Pages loaded while user scripts were disabled

- With "Allow User Scripts" off, Chrome injects nothing, though matching
  still works. A page that loads then has no scripts running.
- So the commit marks its record `loadedWithoutUserscripts`, when a
  `chrome.userScripts` call fails at that moment (`userScriptsUsable`).
  - Asked at the load: a later look can't tell what Chrome injected
    then.
- Not `MISSING`, which would be orange and log a "never started"
  warning for each script blaming the page. Instead, by whether user
  scripts are disabled now (asked only for such a page):
  - Still disabled: its matching scripts are `NOT_LOADED` ("Not run:
    user scripts are disabled"), and the badge is red. Its tooltip
    reads `User scripts are not allowed yet.` and nothing else: a
    reload wouldn't help yet.
  - Enabled since: `UNTRACKED`, as on a page that loaded before the
    extension started, purple, with its own wording.
- Chrome sends no event when the toggle changes, so such a page's badge
  is redrawn when it comes to the front (`tabs.onActivated`,
  `windows.onFocusChanged`): coming back from enabling them is the case
  it's for.

### Reload with no userscripts

The popup's page menu, and the icon's right-click menu, reload the tab
once with every script skipped.
Its per-script menus have two narrower forms:

- **With only this script**: every other script skips (`skipOnly`).
- **Without this script**: just that one skips (`skipWithout`).
- The armed marker carries which of the three (`ReloadMode` in
  `src/extension/popup-view.ts`); the rest of this section applies to
  all of them.

- Registrations are untouched — other tabs on the same site keep
  running their scripts, and the tab's next navigation runs them again.
- Needs `chrome.webNavigation`: without it the reload runs every
  script, since the skip is keyed on its commit.

- **Mechanism** — on a reload, every wrapper asks the SW
  `sm:check-pending` before running its body, and `skip` is an answer
  it already honours (see
  [injection.md](injection.md#sm-check-pending-handler)). A skip
  reload is a per-tab marker that handler consults first, ahead of
  the reload fast path (which isn't set up for a skip reload).
- **Lifecycle**, keyed on main-frame commits, in `src/extension/background.ts`:
  - click → the tab is *armed*, then `chrome.tabs.reload`.
  - reload commit → armed becomes *skipping* for that document. Every
    wrapper in the tab gets `skip` — subframes too, whose documentIds
    are their own, which is why the marker is per tab.
  - the commit after that, or the tab closing → cleared.
  - Only a `reload` commit within a few seconds consumes *armed*; any
    other commit disarms. A reload the page cancels (`beforeunload`)
    must not make the next link click skip.
- **Timing** — the commit listener settles the marker synchronously,
  before the queued tab work: a `document-start` wrapper's
  check-pending can arrive before that work runs.
- **In memory, not persisted.** The marker normally lives for the
  milliseconds between click and commit. A reload slow enough for the
  SW to idle out in between just runs scripts as usual; a SW restart
  mid-document only affects subframes injected afterwards.
- **Badge** — `updateTabMatches` stamps `scriptsSkipped` (or
  `skipOnly` / `skipWithout`) on the fresh document's `TabMatchState` (persisted, so the badge survives a SW
  restart); a bfcache return keeps it while the document is still in
  the per-tab LRU. Its scripts are `NOT_LOADED`, in grey.
- **Log** — each wrapper's `sm:abandoned` lands on its script's Log
  as `info` (not `warning`, the level for any other skip) with the
  reason `reload with no userscripts`, `reload with only another
  userscript`, or `reload without this userscript`.

### Actual reports from injected wrappers

Every wrapper sends `sm:start` on activation and `sm:error` on a
synchronous throw. The SW listens on
`chrome.runtime.onUserScriptMessage` (NOT the regular
`runtime.onMessage`) and merges each report into the tab's `actual`
map keyed by script ID. See [injection.md](injection.md#message-flow)
for the wrapper-side payloads.

### Scripts that never start

A MISSING row says a script matched but never reported. Once the page
has loaded, the script's Log says so too, with what we can tell about
why (`src/extension/missing-scripts.ts`):

- **When**: `webNavigation.onCompleted` for the top frame, plus a
  grace period (11s) past the wrapper's 10s decision timeout, for
  scripts still waiting on their check-pending reply. At most once per
  document (`missingChecked`).
  - Until then the document is settling (`settleBy`, set at a
    navigation commit), and the popup's reload banner leaves its
    MISSING rows out. It's a deadline, 20s after the commit, so a load
    event that never comes can't leave it on.
  - A script that got no decision reports so (an error, with why), and
    so isn't listed here: see
    [injection.md](injection.md#no-decision).
- **Which scripts**: those that matched when the document was first
  seen (`loadMatchIds`), with no report, and not already explained by
  REJECTED or NOT_LOADED.
  - Not ones that matched only a later pushState URL, or were installed
    after the document committed. Those are MISSING on the badge but
    were never going to be injected.
- **What the document's other reports add**: every wrapper report
  carries `opaqueOrigin` (`self.origin === 'null'`), and the SW knows
  its world from `__viaBridge`. Both are kept per document as
  `reportedWorlds` / `opaqueOrigin`.
- **The hint**, for a MAIN-world script:
  - Another MAIN-world script reported → the page isn't blocking that
    world.
  - Else an opaque origin on an http(s) page → the page is sandboxed.
    A CSP `sandbox` header without `allow-scripts` turns off script in
    the page's own world, so Chrome silently skips MAIN-world
    registrations there. SourceMonkey then runs them isolated (see
    [injection.md](injection.md#csp-sandbox-pages)), so this is for one
    that fallback didn't start. Suggests `@inject-into content`.
  - Else nothing to go on → names the possibility and what header to
    check. Left off on file:// pages, which have no headers.
- **For a USER_SCRIPT-world script**, it only notes whether other
  USER_SCRIPT-world scripts started.
- No probing for the hint: it doesn't refetch the page or inject test
  code to find out more (the sandboxed-page fallback runs its own
  check, `pageWorldRuns`, but only to decide whether to fall back). sm-dev, which sees the response headers, says
  it directly (see `docs/sm-dev-design.md`).
- The hints are pinned by `tests/unit/missing-scripts.test.mjs`, and
  the sandboxed-page fallback by `tests/e2e/sandbox-csp.spec.ts`.

### documentId is the lifecycle key

`chrome.userScripts` injects exactly once per document. Fragment
changes, SPA pushState, and bfcache restores all keep the same
document — no re-injection, no new `sm:start`. Resetting `actual` on
every URL change would falsely flag those scripts as MISSING. So we
key state by `documentId`:

- **Known `documentId`** (script-set refresh, SPA URL change in the
  current doc, **or bfcache restore returning to a doc we still
  remember**): keep `actual` untouched. Union the new URL's matches
  into the stored `matches` list — a script that matched any URL
  during this document's life is "expected to have injected by now,"
  and surfaces as MISSING if `sm:start` never came.
- **Unknown `documentId`** (full document load to a doc we've never
  tracked, or one that aged out of the LRU): reset `actual` to `{}`
  and start a fresh expected set from this URL's matches.
- **Bootstrap race** — if a `sm:*` arrives before
  `webNavigation.onCommitted` has set the tab state (cold SW start or
  pure ordering race), the SW synthesises state from `sender.url` and
  `sender.documentId`. A follow-up `onCommitted` for the same
  documentId will hit the same record and preserve `actual`.
- **Errors are sticky** for the same script ID on the same document —
  a later `sm:start` doesn't silently flip ERROR back to OK.

### Per-tab document LRU (bfcache restore)

`webNavigation` doesn't fire a distinct "restored from bfcache" event:
`onCommitted` fires with the original `documentId` reused (and
`transitionQualifiers` includes `'forward_back'`). The only reliable
restore signal is "this documentId is one we've already tracked for
this tab."

So per tab we keep a small LRU of `(documentId → TabMatchState)`,
capped at `MAX_DOCS_PER_TAB` (currently 5):

- On navigation we look up the incoming `documentId` in the LRU. Hit
  → restore path (preserve `actual`, accumulate matches). Miss →
  fresh doc.
- `setCurrentDoc()` promotes the doc to most-recent and marks it as
  what the badge displays.
- `writeDocState()` updates a doc's stored state WITHOUT changing the
  current one — used by the message handler so a late `sm:*` from a
  doc we already navigated away from updates its slot (so it survives
  another bfcache visit later) but doesn't steal the badge from the
  on-screen doc.
- Eviction drops the oldest non-current doc when the cap is exceeded.
  Five slots covers normal back/forward chains; deeper history loses
  state but Chrome's bfcache itself has comparable limits.

### Per-tab serialization

All mutations for a given tab — navigation events, sm:* reports,
removals, refresh-driven recomputes — go through a per-tab promise
queue (`enqueueTabWork`). Without it, two `sm:start` messages that
arrive in the same event-loop turn each do their own get/modify/set
against `chrome.storage.session` and the second write loses the first
update.

## Stale-tab notification

When a script's on-disk content changes — whether from a manual
Refresh, a Refresh All, or a background opportunistic check (see
[storage.md](storage.md#updater)) — every open tab whose current
document is running the OLD version flips to PURPLE/RELOAD.

For a **local** script the check that finds the change is usually the
[focus-triggered one](updates.md#focus-triggered-refresh), which runs
when the user switches to the tab. Persistent purple is then up
*before* they reload, and the reload that follows is clean rather than
a race. An http(s) script is not checked on focus, so its purple still
arrives on the navigation that noticed the update.

How it works:

- All refresh paths go through `script-updater.ts`, which writes via
  `script-store.ts` to `chrome.storage.local`. Fresh content bumps the
  row's `loadedAt`.
- `background.ts` installs a `chrome.storage.onChanged` listener on
  `script:*` keys; whenever `oldValue.loadedAt !== newValue.loadedAt`
  the script id goes on a "changed" list.
- The listener walks every persisted `tab:<tabId>` record's CURRENT
  doc. For each changed id with any actual report (`started` OR
  `error`), `markScriptStale` adds it to that doc's
  `staleScriptIds`, and the badge repaints.
- A stale ERROR row promotes to RELOAD/purple — the error came from
  the OLD content, and the fix on disk may already address it, so
  a reload is more actionable than continuing to show red.
- A new document load (new `documentId`) creates a fresh state, so
  reload naturally clears the stale flag. The wrapper for the new
  document runs the freshly-stored content.
- A reload that triggers the [fast-path](injection.md#reload-fast-path)
  may land the new body on THIS navigation via `sm:swapped`;
  `clearScriptStale` removes the id from `staleScriptIds` so the badge
  doesn't keep nagging.
- That same reload paints purple *briefly* while the swap lands, so a
  successful update is visible rather than silent — see
  [Purple flash while a swap lands](injection.md#purple-flash-while-a-swap-lands).
  Persistent purple keeps its meaning here: reload to update.

### Closing the report-after-change race

- **Symptom**: the storage write can land before the wrapper's
  `sm:start` does, leaving `actual` empty when the listener walks the
  tab — so nothing gets flagged.
- **Mitigation**: every wrapper carries the `StoredScript.loadedAt`
  it was registered with in `sm:start` / `sm:error` payloads.
- **Comparison**: `recordScriptReport` compares the wrapper's
  `loadedAt` against the current stored row's `loadedAt`. If the
  stored one is newer, the wrapper ran OUTDATED code and the script
  id is marked stale right there, ahead of the listener path.
- **Both orderings covered**: listener-then-report goes through the
  listener path; report-then-listener (the SW-startup or storage-fast
  case) goes through the wrapper-loadedAt comparison.

### Opportunistic checks only fire on real navigation

- **Refresh path** (`refreshAllOpenTabs`, driven by `onCacheChanged`)
  passes `trigger: 'refresh'` to `updateTabMatches` and skips the
  opportunistic file-system check.
- **Navigation path** (`webNavigation.onCommitted` /
  `onHistoryStateUpdated`, plus the `chrome.tabs.onUpdated` fallback)
  passes `trigger: 'navigation'` and runs the check.
- **Why**: without this, editing one script would fan out into a
  stat-and-fetch on every script on every other open tab on every
  script-set change.

Why match by `loadedAt` rather than `bodyText`:

- `loadedAt` bumps iff the load pipeline built from fresh fetched
  content. The size+mtime skip path preserves the prior row's
  `loadedAt`, so a no-op refresh produces no badge flap.
- A changed `@require` / `@resource` bumps it too, since what runs is
  the composed body: an edited library marks open tabs for a reload,
  as an edited script does.
- `bodyText` comparison would also fire for byte-identical re-saves
  triggered by the unchanged-skip-not-applying corner case (e.g. when
  a directory listing doesn't include mtime).

## What this doesn't do (yet)

- **Per-tab match override.** There is no UI yet to disable a matching
  script for one specific tab.
